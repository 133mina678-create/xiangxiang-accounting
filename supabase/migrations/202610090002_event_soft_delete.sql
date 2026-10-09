-- Reversible event deletion. Deleted summaries are separate from normal queries.
-- The client offers a recycle bin, while database guards make deleted
-- events immutable. Permanent purge is intentionally disabled in this release.

alter table ledger.events
 add column deleted_at timestamptz,
 add column purge_after timestamptz,
 add constraint events_soft_delete_shape_check check(
  (deleted_at is null and purge_after is null)
  or (deleted_at is not null and purge_after=deleted_at+interval '30 days')
 );

create index events_due_purge on ledger.events(purge_after)
 where deleted_at is not null;

alter table ledger.workspaces
 add column admin_failed_attempts integer not null default 0,
 add column admin_attempt_window timestamptz,
 add column admin_locked_until timestamptz,
 add constraint workspaces_admin_attempts_check check(admin_failed_attempts>=0);

-- Deleted events reject all child writes.
create function ledger.guard_deleted_event_data() returns trigger
language plpgsql security definer set search_path='' as $$
declare eid uuid; removed_at timestamptz;
begin
 if TG_TABLE_NAME='expenses' then
  eid:=case when TG_OP='DELETE' then OLD.event_id else NEW.event_id end;
 elsif TG_TABLE_NAME in ('expense_splits','event_members','settlements','settlement_snapshots') then
  eid:=case when TG_OP='DELETE' then OLD.event_id else NEW.event_id end;
 else
  raise exception 'invalid_guard_target';
 end if;
 select deleted_at into removed_at from ledger.events where id=eid;
 if removed_at is not null then
  raise exception '此活動已移至最近刪除，目前為唯讀';
 end if;
 return case when TG_OP='DELETE' then OLD else NEW end;
end $$;
revoke all on function ledger.guard_deleted_event_data() from public,anon,authenticated;

create trigger expenses_deleted_event_guard
 before insert or update or delete on ledger.expenses
 for each row execute function ledger.guard_deleted_event_data();
create trigger expense_splits_deleted_event_guard
 before insert or update or delete on ledger.expense_splits
 for each row execute function ledger.guard_deleted_event_data();
create trigger event_members_deleted_event_guard
 before insert or update or delete on ledger.event_members
 for each row execute function ledger.guard_deleted_event_data();
create trigger settlements_deleted_event_guard
 before insert or update or delete on ledger.settlements
 for each row execute function ledger.guard_deleted_event_data();
create trigger snapshots_deleted_event_guard
 before insert or update or delete on ledger.settlement_snapshots
 for each row execute function ledger.guard_deleted_event_data();

create function ledger.guard_deleted_event() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if TG_OP='DELETE' then
  raise exception '活動必須先移至最近刪除；永久清理尚未啟用';
 end if;
 if OLD.deleted_at is not null
    and current_setting('ledger.manage_event',true) is distinct from OLD.id::text then
  raise exception '此活動已移至最近刪除，目前為唯讀';
 end if;
 if OLD.deleted_at is null and NEW.deleted_at is not null
    and current_setting('ledger.manage_event',true) is distinct from OLD.id::text then
  raise exception '請使用安全的活動管理流程';
 end if;
 return NEW;
end $$;
revoke all on function ledger.guard_deleted_event() from public,anon,authenticated;
create trigger events_deleted_guard before update or delete on ledger.events
 for each row execute function ledger.guard_deleted_event();

-- Atomic rate limiting; the server supplies the result of credential verification.
create function public.authorize_event_admin(p_secret text,p_verified boolean) returns text
language plpgsql security definer set search_path='' as $$
declare w ledger.workspaces; n integer;
begin
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then return 'invalid_link'; end if;
 select * into w from ledger.workspaces where secret_hash=sha256(convert_to(p_secret,'UTF8')) for update;
 if w.id is null then return 'invalid_link'; end if;
 if w.admin_locked_until>now() then return 'admin_rate_limited'; end if;
 if p_verified is true then
  update ledger.workspaces set admin_failed_attempts=0,admin_attempt_window=null,admin_locked_until=null where id=w.id;
  return 'allowed';
 end if;
 n:=case when w.admin_attempt_window>now()-interval '15 minutes' then w.admin_failed_attempts+1 else 1 end;
 update ledger.workspaces set admin_failed_attempts=n,
  admin_attempt_window=case when n=1 then now() else admin_attempt_window end,
  admin_locked_until=case when n>=5 then now()+interval '15 minutes' end where id=w.id;
 return 'invalid_admin_secret';
end $$;

-- The browser cannot call this RPC. A Next.js route verifies the independent
-- server secret and then invokes this function with the service role.
create function public.manage_event_lifecycle(
 p_secret text,p_event uuid,p_action text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare w ledger.workspaces; ev ledger.events; stamp timestamptz;
begin
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception 'invalid_link'; end if;
 select * into w from ledger.workspaces
  where secret_hash=sha256(convert_to(p_secret,'UTF8')) for update;
 if w.id is null then raise exception 'invalid_link'; end if;
 select * into ev from ledger.events where id=p_event and workspace_id=w.id for update;
 if ev.id is null then raise exception 'invalid_event'; end if;

 if p_action='delete' then
  if ev.deleted_at is not null then
   return jsonb_build_object('status','deleted','deleted_at',ev.deleted_at,'purge_after',ev.purge_after);
  end if;
  if exists(select 1 from ledger.settlements where event_id=ev.id
    and status in ('pending_payment','awaiting_confirmation','disputed'))
   or exists(select 1 from ledger.settlements where event_id=ev.id and proof_storage_path is not null)
   or exists(select 1 from ledger.proof_cleanup_queue
    where object_path like '%/'||ev.id::text||'/%') then
   raise exception '此活動仍有尚未完成的款項，請先完成結算後再刪除。';
  end if;
  stamp:=now();
  perform set_config('ledger.manage_event',ev.id::text,true);
  update ledger.events set deleted_at=stamp,purge_after=stamp+interval '30 days' where id=ev.id;
  update ledger.workspaces set revision=revision+1 where id=w.id;
  return jsonb_build_object('status','deleted','deleted_at',stamp,
   'purge_after',stamp+interval '30 days');
 elsif p_action='restore' then
  if ev.deleted_at is null then return jsonb_build_object('status','active'); end if;
  perform set_config('ledger.manage_event',ev.id::text,true);
  update ledger.events set deleted_at=null,purge_after=null where id=ev.id;
  update ledger.workspaces set revision=revision+1 where id=w.id;
  return jsonb_build_object('status','restored');
 end if;
 raise exception 'invalid_action';
end $$;

revoke all on function public.manage_event_lifecycle(text,uuid,text) from public,anon,authenticated;
grant execute on function public.manage_event_lifecycle(text,uuid,text) to service_role;

revoke all on function public.authorize_event_admin(text,boolean) from public,anon,authenticated;
grant execute on function public.authorize_event_admin(text,boolean) to service_role;
create or replace function public.read_book(p_secret text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w ledger.workspaces; result jsonb;
begin
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception 'invalid_link'; end if;
 select * into w from ledger.workspaces where secret_hash=sha256(convert_to(p_secret,'UTF8'));
 if w.id is null then raise exception 'invalid_link'; end if;
 select jsonb_build_object('revision',ws.revision,
 'members',coalesce((select jsonb_agg(to_jsonb(m)-'workspace_id' order by position) from ledger.members m where workspace_id=w.id),'[]'::jsonb),
 'events',coalesce((select jsonb_agg((to_jsonb(e)-'workspace_id')||jsonb_build_object('members',(select jsonb_agg(em.member_id order by m.position) from ledger.event_members em join ledger.members m on m.id=em.member_id where em.event_id=e.id)) order by start_date desc) from ledger.events e where workspace_id=w.id and e.deleted_at is null),'[]'::jsonb),
 'deleted_events',coalesce((select jsonb_agg((to_jsonb(e)-'workspace_id')||jsonb_build_object('members','[]'::jsonb,'expense_count',(select count(*) from ledger.expenses x where x.event_id=e.id and x.deleted_at is null)) order by deleted_at desc) from ledger.events e where workspace_id=w.id and e.deleted_at is not null),'[]'::jsonb),
 'expenses',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('splits',(select jsonb_agg(to_jsonb(s)-'event_id'-'expense_id' order by m.position) from ledger.expense_splits s join ledger.members m on m.id=s.member_id where s.expense_id=x.id)) order by date desc,created_at desc) from ledger.expenses x join ledger.events e on e.id=x.event_id where e.workspace_id=w.id and e.deleted_at is null),'[]'::jsonb),
 'payments',coalesce((select jsonb_agg(to_jsonb(s)-'proof_storage_path' order by s.created_at) from ledger.settlements s join ledger.events e on e.id=s.event_id where e.workspace_id=w.id and e.deleted_at is null),'[]'::jsonb),
 'logs',coalesce((select jsonb_agg(to_jsonb(l)-'workspace_id') from (select * from ledger.activity_logs where workspace_id=w.id and (event_id is null or exists(select 1 from ledger.events e where e.id=event_id and e.deleted_at is null)) order by created_at desc,id limit 100) l),'[]'::jsonb)
 ) into result from ledger.workspaces ws where ws.id=w.id;
 return result;
end $$;


notify pgrst, 'reload schema';
