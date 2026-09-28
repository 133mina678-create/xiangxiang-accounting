-- Optional expense notes already exist. This migration adds immutable event
-- closure and event-scoped guest identities without rebuilding any table.

alter table ledger.events
 add column status text not null default 'active',
 add column closed_at timestamptz;

alter table ledger.events
 drop constraint if exists events_remainder_rotation_index_check,
 add constraint events_remainder_rotation_index_check
   check(remainder_rotation_index >= 0),
 add constraint events_status_check check(status in ('active','closed')),
 add constraint events_closed_at_check check(
   (status='active' and closed_at is null)
   or (status='closed' and closed_at is not null)
 );

alter table ledger.members
 add column member_type text not null default 'fixed',
 add column guest_event_id uuid,
 add column guest_note text;

alter table ledger.members
 add constraint members_guest_event_id_fkey
   foreign key(workspace_id,guest_event_id)
   references ledger.events(workspace_id,id) on delete cascade,
 add constraint members_type_check check(member_type in ('fixed','guest')),
 add constraint members_guest_fields_check check(
   (member_type='fixed' and guest_event_id is null and guest_note is null)
   or (
     member_type='guest' and guest_event_id is not null
     and length(trim(name)) between 1 and 40
     and (guest_note is null or length(guest_note)<=200)
     and bank_code is null and bank_name is null and bank_account is null
   )
 );

-- A guest UUID can only be attached to its own event.
create function ledger.check_event_member_scope() returns trigger
language plpgsql set search_path='' as $$
declare kind text; guest_event uuid;
begin
 select member_type,guest_event_id into kind,guest_event
 from ledger.members where workspace_id=NEW.workspace_id and id=NEW.member_id;
 if kind is null then raise exception 'invalid_member'; end if;
 if kind='guest' and guest_event is distinct from NEW.event_id then
  raise exception '臨時成員只能加入建立他的活動';
 end if;
 return NEW;
end $$;
create trigger event_member_scope
 before insert or update on ledger.event_members
 for each row execute function ledger.check_event_member_scope();
revoke all on function ledger.check_event_member_scope() from public,anon,authenticated;

-- Old archived events become closed only when their balances and confirmation
-- lifecycle are already complete. Unfinished old events remain editable.
update ledger.events e set status='closed',closed_at=now()
where e.archived
 and not exists(
  select 1 from ledger.settlements s where s.event_id=e.id
   and s.status in ('pending_payment','awaiting_confirmation','disputed')
 )
 and not (
  exists(
   select 1 from ledger.event_members em join ledger.members m on m.id=em.member_id
   where em.event_id=e.id and m.member_type='fixed' and ledger.balance(e.id,em.member_id)>0
  ) and exists(
   select 1 from ledger.event_members em join ledger.members m on m.id=em.member_id
   where em.event_id=e.id and m.member_type='fixed' and ledger.balance(e.id,em.member_id)<0
  )
 );
update ledger.events set archived=false where archived and status='active';

-- The secret-link RPC remains the only browser write surface. Its workspace
-- row lock serializes guest creation, split rotation and revision updates.
create or replace function public.change_book(
 p_secret text,p_revision integer,p_actor uuid,p_action text,p_data jsonb
) returns void language plpgsql security definer set search_path='' as $$
declare w ledger.workspaces; ev ledger.events; eid uuid; xid uuid;
 ex ledger.expenses; item jsonb; amt integer; total bigint; mode text;
 note text; dt date; fromid uuid; toid uuid; mid uuid;
 cursor_index integer; extra integer; guest_name text; guest_note_value text;
begin
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception 'invalid_link'; end if;
 select * into w from ledger.workspaces
  where secret_hash=sha256(convert_to(p_secret,'UTF8')) for update;
 if w.id is null then raise exception 'invalid_link'; end if;
 if p_revision is distinct from w.revision then raise exception 'conflict'; end if;
 if not exists(
  select 1 from ledger.members where workspace_id=w.id and id=p_actor
   and member_type='fixed'
 ) then raise exception '請選擇操作身份'; end if;

 if p_action='event.save' then
  eid:=coalesce((p_data->>'id')::uuid,gen_random_uuid());
  select * into ev from ledger.events where id=eid and workspace_id=w.id;
  if exists(select 1 from ledger.events where id=eid) and ev.id is null then
   raise exception 'invalid_event';
  end if;
  if ev.status='closed' then raise exception '此活動已結束，歷史帳目為唯讀'; end if;
  if jsonb_typeof(p_data->'members') is distinct from 'array'
     or jsonb_array_length(p_data->'members') not between 1 and 50 then
   raise exception '請選擇活動成員';
  end if;
  if p_data ? 'guests' and (
    jsonb_typeof(p_data->'guests') is distinct from 'array'
    or jsonb_array_length(p_data->'guests')>20
  ) then raise exception '臨時成員資料格式錯誤'; end if;
  if exists(
   select 1 from ledger.expenses where event_id=eid
    and (date<(p_data->>'start_date')::date
      or date>(nullif(p_data->>'end_date',''))::date)
  ) then raise exception '活動日期必須包含所有消費日期'; end if;

  insert into ledger.events(id,workspace_id,name,start_date,end_date,note)
  values(eid,w.id,trim(p_data->>'name'),(p_data->>'start_date')::date,
    nullif(p_data->>'end_date','')::date,coalesce(p_data->>'note',''))
  on conflict(id) do update set name=excluded.name,start_date=excluded.start_date,
    end_date=excluded.end_date,note=excluded.note;

  for item in select value from jsonb_array_elements(coalesce(p_data->'guests','[]'::jsonb)) loop
   mid:=(item->>'id')::uuid;
   guest_name:=trim(coalesce(item->>'name',''));
   guest_note_value:=nullif(trim(coalesce(item->>'note','')),'');
   if length(guest_name) not between 1 and 40
      or length(coalesce(guest_note_value,''))>200 then
    raise exception '請確認臨時成員名稱與備註長度';
   end if;
   if not exists(
    select 1 from jsonb_array_elements_text(p_data->'members') selected
    where selected.value=mid::text
   ) then raise exception '臨時成員必須加入目前活動'; end if;
   if exists(
    select 1 from ledger.members m where m.id=mid
     and (m.workspace_id<>w.id or m.member_type<>'guest' or m.guest_event_id<>eid)
   ) then raise exception 'invalid_member'; end if;
   insert into ledger.members(
    id,workspace_id,name,icon,color,position,bank_code,bank_name,bank_account,
    member_type,guest_event_id,guest_note
   ) values(
    mid,w.id,guest_name,'👤','#718096',
    (select coalesce(max(position),0)+1 from ledger.members where workspace_id=w.id),
    null,null,null,'guest',eid,guest_note_value
   ) on conflict(id) do update set name=excluded.name,guest_note=excluded.guest_note;
  end loop;

  if (
   select count(distinct m.id) from ledger.members m
   where m.workspace_id=w.id
    and (m.member_type='fixed' or m.guest_event_id=eid)
    and m.id in(select value::uuid from jsonb_array_elements_text(p_data->'members'))
  )<>jsonb_array_length(p_data->'members') then raise exception 'invalid_member'; end if;

  for mid in
   select em.member_id from ledger.event_members em where em.event_id=eid
    and not exists(
     select 1 from jsonb_array_elements_text(p_data->'members') selected
     where selected.value=em.member_id::text
    )
  loop
   if exists(select 1 from ledger.expenses where event_id=eid and payer_id=mid)
      or exists(select 1 from ledger.expense_splits where event_id=eid and member_id=mid)
      or exists(select 1 from ledger.settlements where event_id=eid and (from_id=mid or to_id=mid)) then
    raise exception '此成員已有帳目紀錄，無法直接移除。';
   end if;
   delete from ledger.event_members where event_id=eid and member_id=mid;
   delete from ledger.members where id=mid and workspace_id=w.id
    and member_type='guest' and guest_event_id=eid;
  end loop;
  for item in select value from jsonb_array_elements(p_data->'members') loop
   insert into ledger.event_members values(w.id,eid,(item#>>'{}')::uuid)
   on conflict do nothing;
  end loop;
  note:=p_data->>'name';
 else
  eid:=(p_data->>'event_id')::uuid;
  select * into ev from ledger.events where id=eid and workspace_id=w.id;
  if ev.id is null then raise exception 'invalid_event'; end if;
  if ev.status='closed' then raise exception '此活動已結束，歷史帳目為唯讀'; end if;

  if p_action='expense.save' then
   xid:=coalesce((p_data->>'id')::uuid,gen_random_uuid());
   select * into ex from ledger.expenses where id=xid;
   if ex.id is not null and (ex.event_id<>eid or ex.deleted_at is not null) then
    raise exception 'invalid_expense';
   end if;
   if coalesce(p_data->>'amount','') !~ '^[0-9]+$' then raise exception '金額必須是正整數'; end if;
   if length(coalesce(p_data->>'note',''))>300 then raise exception '備註不可超過 300 字'; end if;
   amt:=(p_data->>'amount')::integer;
   mode:=p_data->>'mode';
   dt:=(p_data->>'date')::date;
   if dt<ev.start_date or (ev.end_date is not null and dt>ev.end_date) then
    raise exception '日期不在活動範圍';
   end if;
   if jsonb_typeof(p_data->'splits') is distinct from 'array'
      or jsonb_array_length(p_data->'splits') not between 1 and 50 then
    raise exception '請選擇分攤成員';
   end if;
   insert into ledger.expenses(id,event_id,date,amount,payer_id,category,note,mode)
   values(xid,eid,dt,amt,(p_data->>'payer_id')::uuid,p_data->>'category',
     coalesce(p_data->>'note',''),mode)
   on conflict(id) do update set date=excluded.date,amount=excluded.amount,
     payer_id=excluded.payer_id,category=excluded.category,note=excluded.note,
     mode=excluded.mode,updated_at=now();
   delete from ledger.expense_splits where expense_id=xid;
   for item in select value from jsonb_array_elements(p_data->'splits') loop
    mid:=(item->>'member_id')::uuid;
    if mode='custom' and coalesce(item->>'share_amount','') !~ '^[0-9]+$' then
     raise exception '自訂金額必須是整數';
    end if;
    if mode='weighted' and coalesce(item->>'weight','') !~ '^[0-9]+$' then
     raise exception '份數必須是正整數';
    end if;
    insert into ledger.expense_splits values(
     xid,eid,mid,
     case when mode='custom' then (item->>'share_amount')::integer else 0 end,
     case when mode='weighted' then (item->>'weight')::integer else 1 end
    );
   end loop;
   if mode='equal' then
    select count(*) into total from ledger.expense_splits where expense_id=xid;
    update ledger.expense_splits set share_amount=amt/total where expense_id=xid;
    cursor_index:=ev.remainder_rotation_index % (
     select count(*) from ledger.event_members where event_id=eid
    );
    for extra in 1..(amt%total) loop
     select ordered.member_id,(ordered.member_index+1)%ordered.member_total
      into mid,cursor_index
     from (
      select m.id member_id,row_number() over(order by m.position)-1 member_index,
       count(*) over() member_total
      from ledger.event_members em join ledger.members m on m.id=em.member_id
      where em.event_id=eid
     ) ordered
     join ledger.expense_splits s
      on s.expense_id=xid and s.member_id=ordered.member_id
     order by (ordered.member_index-cursor_index+ordered.member_total)%ordered.member_total
     limit 1;
     update ledger.expense_splits set share_amount=share_amount+1
      where expense_id=xid and member_id=mid;
    end loop;
    if amt%total>0 then
     update ledger.events set remainder_rotation_index=cursor_index where id=eid;
    end if;
   elsif mode='weighted' then
    select sum(weight) into total from ledger.expense_splits where expense_id=xid;
    with raw as(
     select s.member_id,(amt::bigint*s.weight)/total base,
      (amt::bigint*s.weight)%total rem,m.position
     from ledger.expense_splits s join ledger.members m on m.id=s.member_id
     where expense_id=xid
    ), ranked as(
     select *,row_number() over(order by rem desc,position) rank,
      amt-sum(base) over() extra from raw
    )
    update ledger.expense_splits s
     set share_amount=r.base+case when r.rank<=r.extra then 1 else 0 end
     from ranked r where s.expense_id=xid and s.member_id=r.member_id;
   end if;
   if (select sum(share_amount) from ledger.expense_splits where expense_id=xid)<>amt then
    raise exception '分攤合計必須等於消費金額';
   end if;
   note:=case when ex.id is null then '新增 ' else '修改 ' end
    ||coalesce(nullif(p_data->>'note',''),'消費')||' NT$ '||amt;
  elsif p_action in ('expense.delete','expense.restore') then
   xid:=(p_data->>'id')::uuid;
   select * into ex from ledger.expenses where id=xid and event_id=eid;
   if ex.id is null then raise exception 'invalid_expense'; end if;
   update ledger.expenses
    set deleted_at=case when p_action='expense.delete' then now() else null end,
        updated_at=now() where id=xid;
   note:=case when p_action='expense.delete' then '刪除 ' else '復原 ' end
    ||coalesce(nullif(ex.note,''),'消費')||' NT$ '||ex.amount;
  elsif p_action='payment.add' then
   fromid:=(p_data->>'from_id')::uuid;
   toid:=(p_data->>'to_id')::uuid;
   if exists(select 1 from ledger.members where id in(fromid,toid) and member_type='guest') then
    raise exception '臨時成員轉帳請使用人工確認';
   end if;
   if coalesce(p_data->>'amount','') !~ '^[0-9]+$' then raise exception '金額必須是正整數'; end if;
   amt:=(p_data->>'amount')::integer;
   if amt<=0 or amt>least(-ledger.balance(eid,fromid),ledger.balance(eid,toid)) then
    raise exception '轉帳建議已變動，請重新確認';
   end if;
   insert into ledger.settlements(event_id,from_id,to_id,amount)
   values(eid,fromid,toid,amt);
   note:='標記轉帳已付款 NT$ '||amt;
  elsif p_action='payment.remove' then
   delete from ledger.settlements where id=(p_data->>'id')::uuid and event_id=eid;
   if not found then raise exception 'invalid_payment'; end if;
   note:='取消已付款標記';
  elsif p_action in ('event.close','event.archive') then
   if p_action='event.archive' and coalesce((p_data->>'archived')::boolean,false)=false then
    raise exception '已結束活動不可重新開啟';
   end if;
   if exists(
    select 1 from ledger.settlements where event_id=eid
     and status in ('pending_payment','awaiting_confirmation','disputed')
   ) or (
    exists(
     select 1 from ledger.event_members em join ledger.members m on m.id=em.member_id
      where em.event_id=eid and m.member_type='fixed'
       and ledger.balance(eid,em.member_id)>0
    ) and exists(
     select 1 from ledger.event_members em join ledger.members m on m.id=em.member_id
      where em.event_id=eid and m.member_type='fixed'
       and ledger.balance(eid,em.member_id)<0
    )
   ) then
    raise exception '目前仍有尚未完成的款項，請完成所有結算後再結束活動。';
   end if;
   update ledger.events set status='closed',closed_at=now(),archived=true where id=eid;
   note:='結束活動並封存帳目';
  else
   raise exception 'invalid_action';
  end if;
 end if;
 insert into ledger.activity_logs(workspace_id,event_id,actor_id,action,detail)
 values(w.id,eid,p_actor,p_action,note);
 update ledger.workspaces set revision=revision+1 where id=w.id;
end $$;

-- Proof lifecycle remains fixed-member only. Guest transfers are informational
-- and never pretend to have an identity or create confirmation records.
create or replace function public.submit_transfer_proof(
 p_secret text,p_revision integer,p_actor uuid,p_event uuid,p_from uuid,p_to uuid,
 p_amount integer,p_settlement uuid,p_proof_path text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare w ledger.workspaces; s ledger.settlements; from_name text; to_name text;
begin
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception 'invalid_link'; end if;
 select * into w from ledger.workspaces
  where secret_hash=sha256(convert_to(p_secret,'UTF8')) for update;
 if w.id is null then raise exception 'invalid_link'; end if;
 if p_revision is distinct from w.revision then raise exception 'conflict'; end if;
 if not exists(select 1 from ledger.members where workspace_id=w.id and id=p_actor and member_type='fixed') then
  raise exception '請選擇操作身份';
 end if;
 if not exists(select 1 from ledger.events where id=p_event and workspace_id=w.id and status='active') then
  raise exception '此活動已結束，歷史帳目為唯讀';
 end if;
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
 if s.id is null then
  if p_amount>least(-ledger.balance(p_event,p_from),ledger.balance(p_event,p_to)) then
   raise exception '轉帳建議已變動，請重新確認';
  end if;
  insert into ledger.settlements(
   id,event_id,from_id,to_id,amount,status,paid_at,proof_storage_path,
   confirmed_at,disputed_at,confirmation_method,updated_at
  ) values(
   p_settlement,p_event,p_from,p_to,p_amount,'awaiting_confirmation',now(),p_proof_path,
   null,null,null,now()
  );
 else
  if s.event_id<>p_event or s.from_id<>p_from or s.to_id<>p_to or s.amount<>p_amount then
   raise exception 'invalid_transfer';
  end if;
  if s.status<>'disputed' then raise exception '只有有異議的轉帳可以重新上傳'; end if;
  update ledger.settlements set status='awaiting_confirmation',paid_at=now(),
   proof_storage_path=p_proof_path,disputed_at=null,confirmed_at=null,
   confirmation_method=null,updated_at=now() where id=s.id;
 end if;
 select name into from_name from ledger.members where id=p_from and workspace_id=w.id;
 select name into to_name from ledger.members where id=p_to and workspace_id=w.id;
 insert into ledger.activity_logs(workspace_id,event_id,actor_id,action,detail)
 values(w.id,p_event,p_actor,'transfer.proof',
  case when s.id is null then '已標記轉帳 ' else '已重新上傳轉帳證明 ' end
  ||'NT$ '||p_amount||' 給'||to_name);
 update ledger.workspaces set revision=revision+1 where id=w.id;
 return jsonb_build_object('id',p_settlement,'status','awaiting_confirmation');
end $$;

create or replace function public.transition_transfer(
 p_secret text,p_revision integer,p_actor uuid,p_settlement uuid,p_action text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare w ledger.workspaces; s ledger.settlements; recipient_name text; event_status text;
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
 if p_actor<>s.to_id then raise exception '只有收款人可以確認款項'; end if;
 select name into recipient_name from ledger.members where id=s.to_id and workspace_id=w.id;
 if p_action='confirm' then
  if s.status not in ('awaiting_confirmation','disputed') then raise exception '此筆轉帳狀態已變更'; end if;
  update ledger.settlements set status='confirmed',confirmed_at=now(),
   confirmation_method='manual',proof_storage_path=null,updated_at=now() where id=s.id;
  insert into ledger.activity_logs(workspace_id,event_id,actor_id,action,detail)
  values(w.id,s.event_id,p_actor,'transfer.confirm','已確認收到 NT$ '||s.amount);
 elsif p_action='dispute' then
  if s.status<>'awaiting_confirmation' then raise exception '此筆轉帳狀態已變更'; end if;
  update ledger.settlements set status='disputed',disputed_at=now(),updated_at=now() where id=s.id;
  insert into ledger.activity_logs(workspace_id,event_id,actor_id,action,detail)
  values(w.id,s.event_id,p_actor,'transfer.dispute','表示尚未收到 NT$ '||s.amount);
 else
  raise exception 'invalid_action';
 end if;
 update ledger.workspaces set revision=revision+1 where id=w.id;
 return jsonb_build_object('id',s.id,'status',case when p_action='confirm' then 'confirmed' else 'disputed' end);
end $$;

notify pgrst, 'reload schema';
