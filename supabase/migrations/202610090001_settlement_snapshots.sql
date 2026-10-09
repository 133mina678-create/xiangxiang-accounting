-- Formal, append-only settlement snapshots. Existing events and transfers stay
-- untouched until somebody explicitly starts settlement for that event.

alter table ledger.events
 add column settlement_state text not null default 'draft',
 add column settlement_snapshot_id uuid,
 add column settlement_started_at timestamptz,
 add constraint events_settlement_state_check check(settlement_state in ('draft','locked')),
 add constraint events_settlement_shape_check check(
  (settlement_state='draft' and settlement_snapshot_id is null and settlement_started_at is null)
  or (settlement_state='locked' and settlement_snapshot_id is not null and settlement_started_at is not null)
 );

create table ledger.settlement_snapshots (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references ledger.workspaces(id),
 event_id uuid not null references ledger.events(id) on delete cascade,
 source_revision integer not null check(source_revision>=0),
 created_by uuid not null,
 status text not null default 'locked' check(status in ('locked','completed','canceled')),
 total_amount bigint not null check(total_amount>=0),
 expense_snapshot jsonb not null,
 balance_snapshot jsonb not null,
 transfer_snapshot jsonb not null,
 created_at timestamptz not null default now(),
 completed_at timestamptz,
 canceled_at timestamptz,
 foreign key(workspace_id,created_by) references ledger.members(workspace_id,id),
 unique(event_id,id)
);
create index settlement_snapshots_event on ledger.settlement_snapshots(event_id,created_at desc);
alter table ledger.settlement_snapshots enable row level security;
revoke all on ledger.settlement_snapshots from public,anon,authenticated;

alter table ledger.events
 add constraint events_settlement_snapshot_fkey
 foreign key(settlement_snapshot_id) references ledger.settlement_snapshots(id)
 on delete set null deferrable initially deferred;

alter table ledger.settlements
 add column snapshot_id uuid references ledger.settlement_snapshots(id);
create index settlements_snapshot on ledger.settlements(snapshot_id);

alter table ledger.settlements
 drop constraint settlements_status_check,
 add constraint settlements_status_check check(status in (
  'record_only','pending_payment','awaiting_confirmation','disputed','confirmed','auto_confirmed'
 )),
 drop constraint settlements_lifecycle_check,
 add constraint settlements_lifecycle_check check(
  (status in ('record_only','pending_payment') and proof_storage_path is null and paid_at is null and confirmed_at is null)
  or (status in ('awaiting_confirmation','disputed') and proof_storage_path is not null and paid_at is not null and confirmed_at is null)
  or (status in ('confirmed','auto_confirmed') and proof_storage_path is null and paid_at is not null and confirmed_at is not null)
 );

create function ledger.guard_formal_settlement() returns trigger
language plpgsql security definer set search_path='' as $$
declare snapshot_event uuid;
begin
 if TG_OP='INSERT' then
  if NEW.snapshot_id is null then raise exception '請先開始正式結算'; end if;
  select event_id into snapshot_event from ledger.settlement_snapshots where id=NEW.snapshot_id;
  if snapshot_event is distinct from NEW.event_id then raise exception 'invalid_snapshot'; end if;
  return NEW;
 elsif TG_OP='UPDATE' then
  if NEW.id is distinct from OLD.id or NEW.event_id is distinct from OLD.event_id
     or NEW.from_id is distinct from OLD.from_id or NEW.to_id is distinct from OLD.to_id
     or NEW.amount is distinct from OLD.amount
     or (NEW.snapshot_id is distinct from OLD.snapshot_id and not (
      OLD.snapshot_id is null
      and current_setting('ledger.attach_snapshot',true)=NEW.snapshot_id::text
     )) then
   raise exception '正式結算交易不可覆寫';
  end if;
  return NEW;
 end if;
 if OLD.snapshot_id is not null
    and current_setting('ledger.cancel_snapshot',true) is distinct from OLD.snapshot_id::text
    and current_setting('ledger.delete_event',true) is distinct from OLD.event_id::text then
  raise exception '正式結算交易不可刪除';
 end if;
 return OLD;
end $$;
revoke all on function ledger.guard_formal_settlement() from public,anon,authenticated;
create trigger settlements_formal_guard
 before insert or update or delete on ledger.settlements
 for each row execute function ledger.guard_formal_settlement();

create function ledger.prepare_event_delete() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 perform set_config('ledger.delete_event',OLD.id::text,true);
 return OLD;
end $$;
revoke all on function ledger.prepare_event_delete() from public,anon,authenticated;
create trigger events_prepare_delete before delete on ledger.events
 for each row execute function ledger.prepare_event_delete();

create function ledger.refresh_snapshot_status(p_snapshot uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if p_snapshot is null then return; end if;
 update ledger.settlement_snapshots ss
 set status='completed',completed_at=coalesce(completed_at,now())
 where ss.id=p_snapshot and ss.status='locked'
  and not exists(
   select 1 from ledger.settlements s where s.snapshot_id=ss.id
    and s.status in ('pending_payment','awaiting_confirmation','disputed')
  );
end $$;
revoke all on function ledger.refresh_snapshot_status(uuid) from public,anon,authenticated;

-- Defense in depth: even a future RPC cannot mutate expenses, splits or event
-- membership after a formal snapshot has locked the event.
create function ledger.guard_locked_event_data() returns trigger
language plpgsql security definer set search_path='' as $$
declare eid uuid; state text;
begin
 if TG_TABLE_NAME='expenses' then
  eid:=case when TG_OP='DELETE' then OLD.event_id else NEW.event_id end;
 elsif TG_TABLE_NAME in ('expense_splits','event_members') then
  eid:=case when TG_OP='DELETE' then OLD.event_id else NEW.event_id end;
 else
  raise exception 'invalid_guard_target';
 end if;
 select settlement_state into state from ledger.events where id=eid;
 if state='locked' then
  raise exception '正式結算已開始，帳目已鎖定';
 end if;
 return case when TG_OP='DELETE' then OLD else NEW end;
end $$;
revoke all on function ledger.guard_locked_event_data() from public,anon,authenticated;

create trigger expenses_settlement_lock
 before insert or update or delete on ledger.expenses
 for each row execute function ledger.guard_locked_event_data();
create trigger expense_splits_settlement_lock
 before insert or update or delete on ledger.expense_splits
 for each row execute function ledger.guard_locked_event_data();
create trigger event_members_settlement_lock
 before insert or update or delete on ledger.event_members
 for each row execute function ledger.guard_locked_event_data();

create function ledger.guard_locked_event_details() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if OLD.settlement_state='locked' and (
  NEW.name is distinct from OLD.name
  or NEW.start_date is distinct from OLD.start_date
  or NEW.end_date is distinct from OLD.end_date
  or NEW.note is distinct from OLD.note
 ) then
  raise exception '正式結算已開始，活動資料已鎖定';
 end if;
 if NEW.status='closed' and OLD.status='active'
    and OLD.settlement_state<>'locked'
    and exists(select 1 from ledger.expenses where event_id=OLD.id and deleted_at is null) then
  raise exception '請先開始正式結算，再結束活動';
 end if;
 return NEW;
end $$;
revoke all on function ledger.guard_locked_event_details() from public,anon,authenticated;
create trigger events_settlement_lock
 before update on ledger.events
 for each row execute function ledger.guard_locked_event_details();

create function public.start_settlement(
 p_secret text,p_revision integer,p_actor uuid,p_event uuid,p_plan jsonb
) returns uuid language plpgsql security definer set search_path='' as $$
declare w ledger.workspaces; ev ledger.events; item jsonb; snap uuid;
 fromid uuid; toid uuid; settlementid uuid; amt integer; transfer_count integer;
 expense_data jsonb; balance_data jsonb; prior_data jsonb; total_amount bigint;
begin
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception 'invalid_link'; end if;
 select * into w from ledger.workspaces
  where secret_hash=sha256(convert_to(p_secret,'UTF8')) for update;
 if w.id is null then raise exception 'invalid_link'; end if;
 if p_revision is distinct from w.revision then raise exception 'conflict'; end if;
 if not exists(
  select 1 from ledger.members where workspace_id=w.id and id=p_actor and member_type='fixed'
 ) then raise exception '請選擇操作身份'; end if;
 select * into ev from ledger.events where id=p_event and workspace_id=w.id for update;
 if ev.id is null then raise exception 'invalid_event'; end if;
 if ev.status<>'active' then raise exception '此活動已結束，歷史帳目為唯讀'; end if;
 if ev.settlement_state<>'draft' then raise exception '正式結算已開始'; end if;
 if jsonb_typeof(p_plan) is distinct from 'array' or jsonb_array_length(p_plan)>100 then
  raise exception '結算資料格式錯誤';
 end if;

 for item in select value from jsonb_array_elements(p_plan) loop
  if coalesce(item->>'id','') !~ '^[a-f0-9-]{36}$'
     or coalesce(item->>'from_id','') !~ '^[a-f0-9-]{36}$'
     or coalesce(item->>'to_id','') !~ '^[a-f0-9-]{36}$'
     or coalesce(item->>'amount','') !~ '^[0-9]+$' then
   raise exception '結算資料格式錯誤';
  end if;
  settlementid:=(item->>'id')::uuid;
  fromid:=(item->>'from_id')::uuid;
  toid:=(item->>'to_id')::uuid;
  amt:=(item->>'amount')::integer;
  if fromid=toid or amt not between 1 and 100000000 then raise exception '結算金額錯誤'; end if;
  if not exists(select 1 from ledger.event_members where event_id=ev.id and member_id=fromid)
     or not exists(select 1 from ledger.event_members where event_id=ev.id and member_id=toid) then
   raise exception '結算成員錯誤';
  end if;
  if ledger.balance(ev.id,fromid)>=0 or ledger.balance(ev.id,toid)<=0 then
   raise exception '結算方向錯誤';
  end if;
 end loop;

 select count(*) into transfer_count from jsonb_array_elements(p_plan);
 if transfer_count<>(select count(distinct value->>'id') from jsonb_array_elements(p_plan))
    or transfer_count<>(select count(distinct (value->>'from_id')||':'||(value->>'to_id')) from jsonb_array_elements(p_plan)) then
  raise exception '結算交易不可重複';
 end if;
 if exists(
  select 1 from ledger.event_members em where em.event_id=ev.id and
   ledger.balance(ev.id,em.member_id)
   +coalesce((select sum((p.value->>'amount')::bigint) from jsonb_array_elements(p_plan) p where p.value->>'from_id'=em.member_id::text),0)
   -coalesce((select sum((p.value->>'amount')::bigint) from jsonb_array_elements(p_plan) p where p.value->>'to_id'=em.member_id::text),0)<>0
 ) then raise exception '結算金額不平衡'; end if;

 select coalesce(sum(amount),0) into total_amount
  from ledger.expenses where event_id=ev.id and deleted_at is null;
 select coalesce(jsonb_agg(
  (to_jsonb(x)-'deleted_at')||jsonb_build_object('splits',coalesce((
   select jsonb_agg(to_jsonb(s)-'event_id'-'expense_id' order by m.position)
   from ledger.expense_splits s join ledger.members m on m.id=s.member_id
   where s.expense_id=x.id
  ),'[]'::jsonb)) order by x.date,x.created_at,x.id
 ),'[]'::jsonb) into expense_data
 from ledger.expenses x where x.event_id=ev.id and x.deleted_at is null;
 select coalesce(jsonb_agg(jsonb_build_object(
  'member_id',em.member_id,
  'paid',coalesce((select sum(x.amount) from ledger.expenses x where x.event_id=ev.id and x.payer_id=em.member_id and x.deleted_at is null),0),
  'share',coalesce((select sum(s.share_amount) from ledger.expense_splits s join ledger.expenses x on x.id=s.expense_id where x.event_id=ev.id and x.deleted_at is null and s.member_id=em.member_id),0),
  'remaining',ledger.balance(ev.id,em.member_id)
 ) order by m.position),'[]'::jsonb) into balance_data
 from ledger.event_members em join ledger.members m on m.id=em.member_id where em.event_id=ev.id;
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',s.id,'from_id',s.from_id,'to_id',s.to_id,'amount',s.amount,'status',s.status
 ) order by s.created_at,s.id),'[]'::jsonb) into prior_data
 from ledger.settlements s where s.event_id=ev.id;

 insert into ledger.settlement_snapshots(
  workspace_id,event_id,source_revision,created_by,total_amount,
  expense_snapshot,balance_snapshot,transfer_snapshot
 ) values(
  w.id,ev.id,w.revision,p_actor,total_amount,expense_data,balance_data,
  jsonb_build_object('existing',prior_data,'new',p_plan)
 ) returning id into snap;

 perform set_config('ledger.attach_snapshot',snap::text,true);
 update ledger.settlements set snapshot_id=snap
  where event_id=ev.id and snapshot_id is null;
 for item in select value from jsonb_array_elements(p_plan) loop
  settlementid:=(item->>'id')::uuid;
  fromid:=(item->>'from_id')::uuid;
  toid:=(item->>'to_id')::uuid;
  amt:=(item->>'amount')::integer;
  insert into ledger.settlements(
   id,event_id,from_id,to_id,amount,status,paid_at,confirmed_at,disputed_at,
   confirmation_method,proof_storage_path,updated_at,snapshot_id
  ) values(
   settlementid,ev.id,fromid,toid,amt,
   case when exists(select 1 from ledger.members where id in(fromid,toid) and member_type='guest')
    then 'record_only' else 'pending_payment' end,
   null,null,null,null,null,now(),snap
  );
 end loop;
 update ledger.events set settlement_state='locked',settlement_snapshot_id=snap,
  settlement_started_at=now() where id=ev.id;
 perform ledger.refresh_snapshot_status(snap);
 insert into ledger.activity_logs(workspace_id,event_id,actor_id,action,detail)
 values(w.id,ev.id,p_actor,'settlement.start','開始正式結算，共 '||transfer_count||' 筆');
 update ledger.workspaces set revision=revision+1 where id=w.id;
 return snap;
end $$;

create function public.cancel_settlement(
 p_secret text,p_revision integer,p_actor uuid,p_event uuid
) returns void language plpgsql security definer set search_path='' as $$
declare w ledger.workspaces; ev ledger.events; snap uuid;
begin
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception 'invalid_link'; end if;
 select * into w from ledger.workspaces
  where secret_hash=sha256(convert_to(p_secret,'UTF8')) for update;
 if w.id is null then raise exception 'invalid_link'; end if;
 if p_revision is distinct from w.revision then raise exception 'conflict'; end if;
 if not exists(
  select 1 from ledger.members where workspace_id=w.id and id=p_actor and member_type='fixed'
 ) then raise exception '請選擇操作身份'; end if;
 select * into ev from ledger.events where id=p_event and workspace_id=w.id for update;
 if ev.id is null then raise exception 'invalid_event'; end if;
 if ev.status<>'active' or ev.settlement_state<>'locked' then raise exception '目前沒有可取消的正式結算'; end if;
 snap:=ev.settlement_snapshot_id;
 if exists(
  select 1 from ledger.settlements where snapshot_id=snap
   and status not in ('pending_payment','record_only')
 ) then raise exception '已有付款提交或完成，不能取消正式結算'; end if;
 perform set_config('ledger.cancel_snapshot',snap::text,true);
 delete from ledger.settlements where snapshot_id=snap;
 update ledger.settlement_snapshots set status='canceled',canceled_at=now()
  where id=snap and status in ('locked','completed');
 update ledger.events set settlement_state='draft',settlement_snapshot_id=null,
  settlement_started_at=null where id=ev.id;
 insert into ledger.activity_logs(workspace_id,event_id,actor_id,action,detail)
 values(w.id,ev.id,p_actor,'settlement.cancel','取消正式結算，返回編輯');
 update ledger.workspaces set revision=revision+1 where id=w.id;
end $$;

-- A proof can only advance an existing formal pending transfer. Legacy disputed
-- rows remain re-uploadable so production history is never stranded.
create or replace function public.submit_transfer_proof(
 p_secret text,p_revision integer,p_actor uuid,p_event uuid,p_from uuid,p_to uuid,
 p_amount integer,p_settlement uuid,p_proof_path text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare w ledger.workspaces; s ledger.settlements; ev ledger.events; to_name text;
begin
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception 'invalid_link'; end if;
 select * into w from ledger.workspaces
  where secret_hash=sha256(convert_to(p_secret,'UTF8')) for update;
 if w.id is null then raise exception 'invalid_link'; end if;
 if p_revision is distinct from w.revision then raise exception 'conflict'; end if;
 if not exists(select 1 from ledger.members where workspace_id=w.id and id=p_actor and member_type='fixed') then
  raise exception '請選擇操作身份';
 end if;
 select * into ev from ledger.events where id=p_event and workspace_id=w.id;
 if ev.id is null or ev.status<>'active' then raise exception '此活動已結束，歷史帳目為唯讀'; end if;
 if exists(select 1 from ledger.members where id in(p_from,p_to) and member_type='guest') then
  raise exception '臨時成員轉帳請使用人工確認';
 end if;
 if p_actor<>p_from then raise exception '只有付款人可以上傳轉帳證明'; end if;
 if p_from=p_to or p_amount<=0 then raise exception 'invalid_transfer'; end if;
 if p_proof_path is null
    or p_proof_path !~ '^[a-f0-9]{64}/[a-f0-9-]{36}/[a-f0-9-]{36}/[a-f0-9-]{36}\.(jpg|png|webp)$'
    or split_part(p_proof_path,'/',1)<>encode(sha256(convert_to(p_secret,'UTF8')),'hex')
    or split_part(p_proof_path,'/',2)<>p_event::text
    or split_part(p_proof_path,'/',3)<>p_settlement::text then
  raise exception 'invalid_proof';
 end if;
 select * into s from ledger.settlements where id=p_settlement for update;
 if s.id is null or s.event_id<>p_event or s.from_id<>p_from or s.to_id<>p_to or s.amount<>p_amount then
  raise exception 'invalid_transfer';
 end if;
 if s.status='pending_payment' then
  if ev.settlement_state<>'locked' or s.snapshot_id is distinct from ev.settlement_snapshot_id then
   raise exception '請先開始正式結算';
  end if;
 elsif s.status<>'disputed' then
  raise exception '此筆轉帳已提交，請等待收款人處理';
 end if;
 update ledger.settlements set status='awaiting_confirmation',paid_at=now(),
  proof_storage_path=p_proof_path,disputed_at=null,confirmed_at=null,
  confirmation_method=null,updated_at=now() where id=s.id;
 select name into to_name from ledger.members where id=p_to and workspace_id=w.id;
 insert into ledger.activity_logs(workspace_id,event_id,actor_id,action,detail)
 values(w.id,p_event,p_actor,'transfer.proof',
  case when s.status='disputed' then '已重新上傳轉帳證明 ' else '已標記轉帳 ' end
  ||'NT$ '||p_amount||' 給'||to_name);
 update ledger.workspaces set revision=revision+1 where id=w.id;
 return jsonb_build_object('id',p_settlement,'status','awaiting_confirmation');
end $$;

create or replace function public.transition_transfer(
 p_secret text,p_revision integer,p_actor uuid,p_settlement uuid,p_action text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare w ledger.workspaces; s ledger.settlements; event_status text; next_status text;
begin
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception 'invalid_link'; end if;
 select * into w from ledger.workspaces
  where secret_hash=sha256(convert_to(p_secret,'UTF8')) for update;
 if w.id is null then raise exception 'invalid_link'; end if;
 if p_revision is distinct from w.revision then raise exception 'conflict'; end if;
 select st.* into s from ledger.settlements st join ledger.events e on e.id=st.event_id
  where st.id=p_settlement and e.workspace_id=w.id for update of st;
 if s.id is null then raise exception 'invalid_transfer'; end if;
 select status into event_status from ledger.events where id=s.event_id;
 if event_status<>'active' then raise exception '此活動已結束，歷史帳目為唯讀'; end if;
 if exists(select 1 from ledger.members where id in(s.from_id,s.to_id) and member_type='guest') then
  raise exception '臨時成員轉帳請使用人工確認';
 end if;
 if p_action='confirm' then
  if p_actor<>s.to_id then raise exception '只有收款人可以確認款項'; end if;
  if s.status not in ('awaiting_confirmation','disputed') then raise exception '此筆轉帳狀態已變更'; end if;
  update ledger.settlements set status='confirmed',confirmed_at=now(),
   confirmation_method='manual',proof_storage_path=null,updated_at=now() where id=s.id;
  insert into ledger.activity_logs(workspace_id,event_id,actor_id,action,detail)
  values(w.id,s.event_id,p_actor,'transfer.confirm','已確認收到 NT$ '||s.amount);
  next_status:='confirmed';
 elsif p_action='dispute' then
  if p_actor<>s.to_id then raise exception '只有收款人可以提出異議'; end if;
  if s.status<>'awaiting_confirmation' then raise exception '此筆轉帳狀態已變更'; end if;
  update ledger.settlements set status='disputed',disputed_at=now(),updated_at=now() where id=s.id;
  insert into ledger.activity_logs(workspace_id,event_id,actor_id,action,detail)
  values(w.id,s.event_id,p_actor,'transfer.dispute','表示尚未收到 NT$ '||s.amount);
  next_status:='disputed';
 elsif p_action='withdraw' then
  if p_actor<>s.from_id then raise exception '只有付款人可以撤回付款申請'; end if;
  if s.status<>'awaiting_confirmation' then raise exception '只有等待確認的付款可以撤回'; end if;
  update ledger.settlements set status='pending_payment',paid_at=null,confirmed_at=null,
   disputed_at=null,confirmation_method=null,proof_storage_path=null,updated_at=now() where id=s.id;
  insert into ledger.activity_logs(workspace_id,event_id,actor_id,action,detail)
  values(w.id,s.event_id,p_actor,'transfer.withdraw','撤回 NT$ '||s.amount||' 付款申請');
  next_status:='pending_payment';
 else
  raise exception 'invalid_action';
 end if;
 perform ledger.refresh_snapshot_status(s.snapshot_id);
 update ledger.workspaces set revision=revision+1 where id=w.id;
 return jsonb_build_object('id',s.id,'status',next_status);
end $$;

create or replace function public.process_due_transfers() returns integer
language plpgsql security definer set search_path='' as $$
declare affected integer;
begin
 with due as (
  update ledger.settlements s set status='auto_confirmed',confirmed_at=now(),
    confirmation_method='auto',proof_storage_path=null,updated_at=now()
  where s.status='awaiting_confirmation' and s.paid_at<=now()-interval '72 hours'
  returning s.event_id,s.to_id,s.amount,s.snapshot_id
 ), logged as (
  insert into ledger.activity_logs(workspace_id,event_id,actor_id,action,detail)
  select e.workspace_id,d.event_id,d.to_id,'transfer.auto_confirm',
    '此筆 NT$ '||d.amount||' 已於 72 小時後自動確認'
  from due d join ledger.events e on e.id=d.event_id
  returning workspace_id
 ), bumped as (
  update ledger.workspaces w set revision=revision+1
  where w.id in(select distinct workspace_id from logged) returning 1
 ) select count(*) into affected from due;
 update ledger.settlement_snapshots ss set status='completed',completed_at=coalesce(completed_at,now())
  where ss.status='locked' and not exists(
   select 1 from ledger.settlements s where s.snapshot_id=ss.id
    and s.status in ('pending_payment','awaiting_confirmation','disputed')
  );
 return affected;
end $$;

revoke all on function public.start_settlement(text,integer,uuid,uuid,jsonb) from public;
revoke all on function public.cancel_settlement(text,integer,uuid,uuid) from public;
grant execute on function public.start_settlement(text,integer,uuid,uuid,jsonb) to anon,authenticated;
grant execute on function public.cancel_settlement(text,integer,uuid,uuid) to anon,authenticated;
revoke all on function public.submit_transfer_proof(text,integer,uuid,uuid,uuid,uuid,integer,uuid,text) from public,anon,authenticated;
revoke all on function public.transition_transfer(text,integer,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.process_due_transfers() from public,anon,authenticated;
grant execute on function public.submit_transfer_proof(text,integer,uuid,uuid,uuid,uuid,integer,uuid,text) to service_role;
grant execute on function public.transition_transfer(text,integer,uuid,uuid,text) to service_role;
grant execute on function public.process_due_transfers() to service_role;

notify pgrst, 'reload schema';
