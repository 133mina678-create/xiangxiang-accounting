-- A 48-hour, event-scoped review gate before formal settlement.
-- Existing locked/closed events are untouched. New formal settlements must
-- consume one open review round whose reviewed content still matches.

create table ledger.settlement_review_rounds (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references ledger.workspaces(id),
 event_id uuid not null references ledger.events(id) on delete cascade,
 round_number integer not null check(round_number>0),
 source_revision integer not null check(source_revision>=0),
 started_by uuid not null,
 started_at timestamptz not null,
 deadline_at timestamptz not null,
 status text not null default 'open' check(status in ('open','settled','canceled')),
 content_snapshot jsonb not null,
 settled_at timestamptz,
 canceled_at timestamptz,
 foreign key(workspace_id,started_by) references ledger.members(workspace_id,id),
 unique(event_id,round_number),
 unique(event_id,id),
 check(deadline_at=started_at+interval '48 hours'),
 check(
  (status='open' and settled_at is null and canceled_at is null)
  or (status='settled' and settled_at is not null and canceled_at is null)
  or (status='canceled' and canceled_at is not null and settled_at is null)
 )
);
create unique index settlement_review_one_open
 on ledger.settlement_review_rounds(event_id) where status='open';
create index settlement_review_event_history
 on ledger.settlement_review_rounds(event_id,started_at desc);

create table ledger.settlement_review_participants (
 workspace_id uuid not null,
 event_id uuid not null,
 round_id uuid not null,
 member_id uuid not null,
 confirmed_at timestamptz,
 primary key(round_id,member_id),
 foreign key(event_id,round_id)
  references ledger.settlement_review_rounds(event_id,id) on delete cascade,
 foreign key(event_id,member_id)
  references ledger.event_members(event_id,member_id),
 foreign key(workspace_id,event_id)
  references ledger.events(workspace_id,id),
 foreign key(workspace_id,member_id)
  references ledger.members(workspace_id,id)
);

create table ledger.settlement_review_disputes (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null,
 event_id uuid not null,
 round_id uuid not null,
 member_id uuid not null,
 expense_id uuid references ledger.expenses(id) on delete set null,
 reason text not null check(length(btrim(reason)) between 1 and 300),
 created_at timestamptz not null default clock_timestamp(),
 withdrawn_at timestamptz,
 foreign key(round_id,member_id)
  references ledger.settlement_review_participants(round_id,member_id) on delete cascade,
 foreign key(event_id,round_id)
  references ledger.settlement_review_rounds(event_id,id) on delete cascade
);
create unique index settlement_review_one_active_dispute
 on ledger.settlement_review_disputes(round_id,member_id)
 where withdrawn_at is null;

alter table ledger.settlement_review_rounds enable row level security;
alter table ledger.settlement_review_participants enable row level security;
alter table ledger.settlement_review_disputes enable row level security;
revoke all on ledger.settlement_review_rounds from public,anon,authenticated;
revoke all on ledger.settlement_review_participants from public,anon,authenticated;
revoke all on ledger.settlement_review_disputes from public,anon,authenticated;

alter table ledger.settlement_snapshots
 add column review_round_id uuid unique
 references ledger.settlement_review_rounds(id);

-- This is the exact immutable content members review. It reuses persisted
-- ExpenseSplit amounts, including discount details, and performs no new split.
create function ledger.settlement_review_payload(p_event uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'event',jsonb_build_object(
   'id',e.id,'name',e.name,'start_date',e.start_date,
   'end_date',e.end_date,'note',e.note
  ),
  'members',coalesce((
   select jsonb_agg(jsonb_build_object(
    'id',m.id,'name',m.name,'icon',m.icon,'color',m.color,
    'member_type',m.member_type
   ) order by m.position)
   from ledger.event_members em join ledger.members m on m.id=em.member_id
   where em.event_id=e.id
  ),'[]'::jsonb),
  'expenses',coalesce((
   select jsonb_agg(jsonb_build_object(
    'id',x.id,'name',x.name,'date',x.date,'amount',x.amount,
    'payer_id',x.payer_id,'category',x.category,'note',x.note,'mode',x.mode,
    'splits',coalesce((
     select jsonb_agg(jsonb_build_object(
      'member_id',s.member_id,'share_amount',s.share_amount,'weight',s.weight,
      'gross_amount',d.gross_amount,'discount_amount',d.discount_amount,
      'discount_method',d.discount_method
     ) order by m.position)
     from ledger.expense_splits s
     join ledger.members m on m.id=s.member_id
     left join ledger.expense_discount_details d
      on d.expense_id=s.expense_id and d.member_id=s.member_id
     where s.expense_id=x.id
    ),'[]'::jsonb)
   ) order by x.date,x.created_at,x.id)
   from ledger.expenses x where x.event_id=e.id and x.deleted_at is null
  ),'[]'::jsonb)
 ) from ledger.events e where e.id=p_event
$$;
revoke all on function ledger.settlement_review_payload(uuid)
 from public,anon,authenticated;

-- Defense in depth for every present and future RPC: while a review is open,
-- the reviewed accounting rows cannot change even through privileged SQL.
create function ledger.guard_open_settlement_review_data() returns trigger
language plpgsql security definer set search_path='' as $$
declare eid uuid;
begin
 if TG_TABLE_NAME='expenses' then
  eid:=case when TG_OP='DELETE' then OLD.event_id else NEW.event_id end;
 elsif TG_TABLE_NAME in ('expense_splits','event_members') then
  eid:=case when TG_OP='DELETE' then OLD.event_id else NEW.event_id end;
 elsif TG_TABLE_NAME='expense_discount_details' then
  select event_id into eid from ledger.expenses
   where id=case when TG_OP='DELETE' then OLD.expense_id else NEW.expense_id end;
 else
  raise exception 'invalid_review_guard_target';
 end if;
 if exists(select 1 from ledger.settlement_review_rounds
  where event_id=eid and status='open') then
  raise exception '個人明細確認進行中，請先取消本輪再修改帳目';
 end if;
 return case when TG_OP='DELETE' then OLD else NEW end;
end $$;
revoke all on function ledger.guard_open_settlement_review_data()
 from public,anon,authenticated;

create trigger expenses_review_lock
 before insert or update or delete on ledger.expenses
 for each row execute function ledger.guard_open_settlement_review_data();
create trigger expense_splits_review_lock
 before insert or update or delete on ledger.expense_splits
 for each row execute function ledger.guard_open_settlement_review_data();
create trigger event_members_review_lock
 before insert or update or delete on ledger.event_members
 for each row execute function ledger.guard_open_settlement_review_data();
create trigger expense_discounts_review_lock
 before insert or update or delete on ledger.expense_discount_details
 for each row execute function ledger.guard_open_settlement_review_data();

create function ledger.guard_open_settlement_review_event() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from ledger.settlement_review_rounds
  where event_id=OLD.id and status='open') and (
   NEW.name is distinct from OLD.name
   or NEW.start_date is distinct from OLD.start_date
   or NEW.end_date is distinct from OLD.end_date
   or NEW.note is distinct from OLD.note
   or NEW.status is distinct from OLD.status
   or NEW.archived is distinct from OLD.archived
   or NEW.remainder_rotation_index is distinct from OLD.remainder_rotation_index
   or NEW.deleted_at is distinct from OLD.deleted_at
   or NEW.purge_after is distinct from OLD.purge_after
  ) then
  raise exception '個人明細確認進行中，請先取消本輪再修改活動';
 end if;
 if OLD.status='active' and NEW.status='closed'
    and NEW.settlement_state<>'locked' then
  raise exception '請先完成個人明細確認並開始正式結算';
 end if;
 return NEW;
end $$;
revoke all on function ledger.guard_open_settlement_review_event()
 from public,anon,authenticated;
create trigger events_review_lock before update on ledger.events
 for each row execute function ledger.guard_open_settlement_review_event();

create function public.start_settlement_review(
 p_secret text,p_revision integer,p_actor uuid,p_event uuid
) returns uuid language plpgsql security definer set search_path='' as $$
declare w ledger.workspaces; ev ledger.events; r ledger.settlement_review_rounds;
 stamp timestamptz; payload jsonb; next_round integer;
begin
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception 'invalid_link'; end if;
 select * into w from ledger.workspaces
  where secret_hash=sha256(convert_to(p_secret,'UTF8')) for update;
 if w.id is null then raise exception 'invalid_link'; end if;
 if not exists(select 1 from ledger.members
  where workspace_id=w.id and id=p_actor and member_type='fixed') then
  raise exception '請選擇操作身份';
 end if;
 select * into ev from ledger.events
  where id=p_event and workspace_id=w.id and deleted_at is null for update;
 if ev.id is null then raise exception 'invalid_event'; end if;
 if ev.status<>'active' then raise exception '此活動已結束，歷史帳目為唯讀'; end if;
 if ev.settlement_state<>'draft' then raise exception '正式結算已開始'; end if;
 select * into r from ledger.settlement_review_rounds
  where event_id=ev.id and status='open' for update;
 if r.id is not null then
  if r.content_snapshot is distinct from ledger.settlement_review_payload(ev.id) then
   raise exception '核對內容版本不一致，請取消後重新發起';
  end if;
  return r.id;
 end if;
 if p_revision is distinct from w.revision then raise exception 'conflict'; end if;
 payload:=ledger.settlement_review_payload(ev.id);
 stamp:=clock_timestamp();
 select coalesce(max(round_number),0)+1 into next_round
  from ledger.settlement_review_rounds where event_id=ev.id;
 insert into ledger.settlement_review_rounds(
  workspace_id,event_id,round_number,source_revision,started_by,
  started_at,deadline_at,content_snapshot
 ) values(w.id,ev.id,next_round,w.revision,p_actor,stamp,
  stamp+interval '48 hours',payload) returning * into r;
 insert into ledger.settlement_review_participants(
  workspace_id,event_id,round_id,member_id
 ) select w.id,ev.id,r.id,em.member_id
  from ledger.event_members em join ledger.members m on m.id=em.member_id
  where em.event_id=ev.id and m.member_type='fixed';
 insert into ledger.activity_logs(workspace_id,event_id,actor_id,action,detail)
 values(w.id,ev.id,p_actor,'review.start','發起第 '||next_round||' 輪個人明細確認');
 update ledger.workspaces set revision=revision+1 where id=w.id;
 return r.id;
end $$;

create function public.transition_settlement_review(
 p_secret text,p_actor uuid,p_event uuid,p_round uuid,p_action text,
 p_reason text default null,p_expense uuid default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare w ledger.workspaces; ev ledger.events; r ledger.settlement_review_rounds;
 participant ledger.settlement_review_participants; active_dispute uuid;
 changed integer:=0; message text;
begin
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception 'invalid_link'; end if;
 select * into w from ledger.workspaces
  where secret_hash=sha256(convert_to(p_secret,'UTF8')) for update;
 if w.id is null then raise exception 'invalid_link'; end if;
 select * into ev from ledger.events
  where id=p_event and workspace_id=w.id and deleted_at is null for update;
 if ev.id is null then raise exception 'invalid_event'; end if;
 if ev.status<>'active' or ev.settlement_state<>'draft' then
  raise exception '此活動目前不能變更明細確認';
 end if;
 select * into r from ledger.settlement_review_rounds
  where id=p_round and event_id=ev.id and workspace_id=w.id for update;
 if r.id is null or r.status<>'open' then raise exception '核對輪次已失效，請重新同步'; end if;
 if r.content_snapshot is distinct from ledger.settlement_review_payload(ev.id) then
  raise exception '核對內容版本不一致，請取消後重新發起';
 end if;
 select * into participant from ledger.settlement_review_participants
  where round_id=r.id and member_id=p_actor for update;
 if participant.member_id is null then raise exception '你不是本輪必要確認成員'; end if;
 select id into active_dispute from ledger.settlement_review_disputes
  where round_id=r.id and member_id=p_actor and withdrawn_at is null for update;

 if p_action='confirm' then
  if active_dispute is not null then raise exception '請先撤回明細異議再確認'; end if;
  update ledger.settlement_review_participants set confirmed_at=clock_timestamp()
   where round_id=r.id and member_id=p_actor and confirmed_at is null;
  get diagnostics changed=row_count;
  message:='確認本輪個人消費明細';
 elsif p_action='dispute' then
  if length(btrim(coalesce(p_reason,''))) not between 1 and 300 then
   raise exception '請填寫 1～300 字的問題原因';
  end if;
  if p_expense is not null and not exists(select 1 from ledger.expenses
   where id=p_expense and event_id=ev.id and deleted_at is null) then
   raise exception 'invalid_expense';
  end if;
  update ledger.settlement_review_participants set confirmed_at=null
   where round_id=r.id and member_id=p_actor and confirmed_at is not null;
  if active_dispute is null then
   insert into ledger.settlement_review_disputes(
    workspace_id,event_id,round_id,member_id,expense_id,reason
   ) values(w.id,ev.id,r.id,p_actor,p_expense,btrim(p_reason));
   changed:=1;
  end if;
  message:='回報本輪個人消費明細有問題';
 elsif p_action='withdraw_dispute' then
  if active_dispute is not null then
   update ledger.settlement_review_disputes set withdrawn_at=clock_timestamp()
    where id=active_dispute;
   changed:=1;
  end if;
  message:='撤回本輪個人消費明細異議';
 else
  raise exception 'invalid_action';
 end if;
 if changed>0 then
  insert into ledger.activity_logs(workspace_id,event_id,actor_id,action,detail)
  values(w.id,ev.id,p_actor,'review.'||p_action,message);
  update ledger.workspaces set revision=revision+1 where id=w.id;
 end if;
 return jsonb_build_object('round_id',r.id,'action',p_action);
end $$;

create function public.cancel_settlement_review(
 p_secret text,p_revision integer,p_actor uuid,p_event uuid,p_round uuid
) returns void language plpgsql security definer set search_path='' as $$
declare w ledger.workspaces; ev ledger.events; r ledger.settlement_review_rounds;
begin
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception 'invalid_link'; end if;
 select * into w from ledger.workspaces
  where secret_hash=sha256(convert_to(p_secret,'UTF8')) for update;
 if w.id is null then raise exception 'invalid_link'; end if;
 if p_revision is distinct from w.revision then raise exception 'conflict'; end if;
 if not exists(select 1 from ledger.members
  where workspace_id=w.id and id=p_actor and member_type='fixed') then
  raise exception '請選擇操作身份';
 end if;
 select * into ev from ledger.events
  where id=p_event and workspace_id=w.id and deleted_at is null for update;
 if ev.id is null then raise exception 'invalid_event'; end if;
 if ev.status<>'active' or ev.settlement_state<>'draft' then
  raise exception '此活動目前不能取消明細確認';
 end if;
 select * into r from ledger.settlement_review_rounds
  where id=p_round and event_id=ev.id and workspace_id=w.id for update;
 if r.id is null or r.status<>'open' then raise exception '核對輪次已失效，請重新同步'; end if;
 update ledger.settlement_review_rounds set status='canceled',
  canceled_at=clock_timestamp() where id=r.id;
 insert into ledger.activity_logs(workspace_id,event_id,actor_id,action,detail)
 values(w.id,ev.id,p_actor,'review.cancel','取消第 '||r.round_number||' 輪個人明細確認');
 update ledger.workspaces set revision=revision+1 where id=w.id;
end $$;

-- Preserve the existing public signature so an old client cannot bypass the
-- new gate. The previous implementation remains private and is called only
-- after the review checks have passed in this same transaction.
alter function public.start_settlement(text,integer,uuid,uuid,jsonb)
 rename to start_settlement_v1;
revoke all on function public.start_settlement_v1(text,integer,uuid,uuid,jsonb)
 from public,anon,authenticated;

create function public.start_settlement(
 p_secret text,p_revision integer,p_actor uuid,p_event uuid,p_plan jsonb
) returns uuid language plpgsql security definer set search_path='' as $$
declare w ledger.workspaces; ev ledger.events; r ledger.settlement_review_rounds;
 snap uuid; unconfirmed integer; disputed integer; stamp timestamptz;
begin
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception 'invalid_link'; end if;
 select * into w from ledger.workspaces
  where secret_hash=sha256(convert_to(p_secret,'UTF8')) for update;
 if w.id is null then raise exception 'invalid_link'; end if;
 if p_revision is distinct from w.revision then raise exception 'conflict'; end if;
 if not exists(select 1 from ledger.members
  where workspace_id=w.id and id=p_actor and member_type='fixed') then
  raise exception '請選擇操作身份';
 end if;
 select * into ev from ledger.events
  where id=p_event and workspace_id=w.id and deleted_at is null for update;
 if ev.id is null then raise exception 'invalid_event'; end if;
 select * into r from ledger.settlement_review_rounds
  where event_id=ev.id and status='open' for update;
 if r.id is null then raise exception '請先發起並完成個人消費明細確認'; end if;
 if r.content_snapshot is distinct from ledger.settlement_review_payload(ev.id) then
  raise exception '核對內容版本不一致，請取消後重新發起';
 end if;
 select count(*) into disputed from ledger.settlement_review_disputes
  where round_id=r.id and withdrawn_at is null;
 if disputed>0 then raise exception '目前仍有尚未處理的明細異議'; end if;
 select count(*) into unconfirmed from ledger.settlement_review_participants
  where round_id=r.id and confirmed_at is null;
 stamp:=clock_timestamp();
 if unconfirmed>0 and stamp<r.deadline_at then
  raise exception '尚未全員確認，且 48 小時核對期限尚未到達';
 end if;
 update ledger.settlement_review_rounds set status='settled',settled_at=stamp
  where id=r.id;
 snap:=public.start_settlement_v1(p_secret,p_revision,p_actor,p_event,p_plan);
 update ledger.settlement_snapshots set review_round_id=r.id,
  source_revision=r.source_revision where id=snap;
 return snap;
end $$;

revoke all on function public.start_settlement_review(text,integer,uuid,uuid)
 from public;
revoke all on function public.transition_settlement_review(text,uuid,uuid,uuid,text,text,uuid)
 from public;
revoke all on function public.cancel_settlement_review(text,integer,uuid,uuid,uuid)
 from public;
revoke all on function public.start_settlement(text,integer,uuid,uuid,jsonb)
 from public;
grant execute on function public.start_settlement_review(text,integer,uuid,uuid)
 to anon,authenticated;
grant execute on function public.transition_settlement_review(text,uuid,uuid,uuid,text,text,uuid)
 to anon,authenticated;
grant execute on function public.cancel_settlement_review(text,integer,uuid,uuid,uuid)
 to anon,authenticated;
grant execute on function public.start_settlement(text,integer,uuid,uuid,jsonb)
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
 'reviews',coalesce((select jsonb_agg((to_jsonb(r)-'workspace_id'-'content_snapshot')||jsonb_build_object(
  'deadline_reached',clock_timestamp()>=r.deadline_at,
  'can_start',r.status='open'
   and not exists(select 1 from ledger.settlement_review_disputes ad where ad.round_id=r.id and ad.withdrawn_at is null)
   and (clock_timestamp()>=r.deadline_at or not exists(select 1 from ledger.settlement_review_participants up where up.round_id=r.id and up.confirmed_at is null)),
  'participants',coalesce((select jsonb_agg(to_jsonb(p)-'workspace_id'-'event_id'-'round_id' order by m.position) from ledger.settlement_review_participants p join ledger.members m on m.id=p.member_id where p.round_id=r.id),'[]'::jsonb),
  'disputes',coalesce((select jsonb_agg(to_jsonb(d)-'workspace_id'-'event_id'-'round_id' order by d.created_at,d.id) from ledger.settlement_review_disputes d where d.round_id=r.id),'[]'::jsonb)
 ) order by r.started_at,r.id) from ledger.settlement_review_rounds r join ledger.events e on e.id=r.event_id where r.workspace_id=w.id and e.deleted_at is null),'[]'::jsonb),
 'logs',coalesce((select jsonb_agg(to_jsonb(l)-'workspace_id') from (select * from ledger.activity_logs where workspace_id=w.id and (event_id is null or exists(select 1 from ledger.events e where e.id=event_id and e.deleted_at is null)) order by created_at desc,id limit 100) l),'[]'::jsonb)
 ) into result from ledger.workspaces ws where ws.id=w.id;
 return result;
end $$;

notify pgrst, 'reload schema';
