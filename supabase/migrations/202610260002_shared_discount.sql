-- Remember whether the saved per-person discounts were entered manually or
-- allocated from one shared discount. Existing discount rows remain manual.
alter table ledger.expense_discount_details
 add column discount_method text not null default 'manual'
 check(discount_method in ('manual','shared'));

create function ledger.apply_discount_method() returns trigger
language plpgsql security definer set search_path='' as $$
declare requested text;
begin
 requested:=nullif(current_setting('ledger.discount_method',true),'');
 if requested is not null then NEW.discount_method:=requested; end if;
 return NEW;
end $$;
revoke all on function ledger.apply_discount_method() from public,anon,authenticated;
create trigger expense_discount_method
 before insert on ledger.expense_discount_details
 for each row execute function ledger.apply_discount_method();

alter function public.save_discount_expense(text,integer,uuid,jsonb)
 rename to save_discount_expense_v1;
revoke all on function public.save_discount_expense_v1(text,integer,uuid,jsonb)
 from public,anon,authenticated;

create function public.save_discount_expense(
 p_secret text,p_revision integer,p_actor uuid,p_data jsonb
) returns void language plpgsql security definer set search_path='' as $$
declare requested text;
begin
 requested:=coalesce(p_data->>'discount_method','manual');
 if requested not in ('manual','shared') then raise exception 'invalid_discount_method'; end if;
 perform set_config('ledger.discount_method',requested,true);
 perform public.save_discount_expense_v1(p_secret,p_revision,p_actor,p_data);
end $$;
revoke all on function public.save_discount_expense(text,integer,uuid,jsonb)
 from public;
grant execute on function public.save_discount_expense(text,integer,uuid,jsonb)
 to anon,authenticated;

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
 'expenses',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('splits',(select jsonb_agg((to_jsonb(s)-'event_id'-'expense_id')||case when d.expense_id is null then '{}'::jsonb else jsonb_build_object('gross_amount',d.gross_amount,'discount_amount',d.discount_amount,'discount_method',d.discount_method) end order by m.position) from ledger.expense_splits s join ledger.members m on m.id=s.member_id left join ledger.expense_discount_details d on d.expense_id=s.expense_id and d.member_id=s.member_id where s.expense_id=x.id)) order by date desc,created_at desc) from ledger.expenses x join ledger.events e on e.id=x.event_id where e.workspace_id=w.id and e.deleted_at is null),'[]'::jsonb),
 'payments',coalesce((select jsonb_agg(to_jsonb(s)-'proof_storage_path' order by s.created_at) from ledger.settlements s join ledger.events e on e.id=s.event_id where e.workspace_id=w.id and e.deleted_at is null),'[]'::jsonb),
 'logs',coalesce((select jsonb_agg(to_jsonb(l)-'workspace_id') from (select * from ledger.activity_logs where workspace_id=w.id and (event_id is null or exists(select 1 from ledger.events e where e.id=event_id and e.deleted_at is null)) order by created_at desc,id limit 100) l),'[]'::jsonb)
 ) into result from ledger.workspaces ws where ws.id=w.id;
 return result;
end $$;

notify pgrst, 'reload schema';
