-- Event-local deterministic round-robin cursor for equal-split integer remainders.
alter table ledger.events
 add column if not exists remainder_rotation_index integer not null default 0
 check(remainder_rotation_index between 0 and 5);

-- change_book already locks the workspace row, so split creation and cursor
-- advancement remain one serialized transaction across concurrent clients.
create or replace function public.change_book(p_secret text,p_revision integer,p_actor uuid,p_action text,p_data jsonb) returns void language plpgsql security definer set search_path='' as $$
declare w ledger.workspaces; ev ledger.events; eid uuid; xid uuid; ex ledger.expenses; item jsonb; amt integer; total bigint; mode text; note text; dt date; fromid uuid; toid uuid; mid uuid; cursor_index integer; extra integer;
begin
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception 'invalid_link'; end if;
 select * into w from ledger.workspaces where secret_hash=sha256(convert_to(p_secret,'UTF8')) for update;
 if w.id is null then raise exception 'invalid_link'; end if;
 if p_revision is distinct from w.revision then raise exception 'conflict'; end if;
 if not exists(select 1 from ledger.members where workspace_id=w.id and id=p_actor) then raise exception '請選擇操作身份'; end if;
 if p_action='event.save' then
  eid:=coalesce((p_data->>'id')::uuid,gen_random_uuid());
  select * into ev from ledger.events where id=eid and workspace_id=w.id;
  if exists(select 1 from ledger.events where id=eid) and ev.id is null then raise exception 'invalid_event'; end if;
  if jsonb_typeof(p_data->'members') is distinct from 'array' or jsonb_array_length(p_data->'members') not between 1 and 6 then raise exception '請選擇活動成員'; end if;
  if exists(select 1 from ledger.expenses where event_id=eid and (date<(p_data->>'start_date')::date or date>(nullif(p_data->>'end_date',''))::date)) then raise exception '活動日期必須包含所有消費日期'; end if;
  insert into ledger.events(id,workspace_id,name,start_date,end_date,note) values(eid,w.id,trim(p_data->>'name'),(p_data->>'start_date')::date,nullif(p_data->>'end_date','')::date,coalesce(p_data->>'note',''))
  on conflict(id) do update set name=excluded.name,start_date=excluded.start_date,end_date=excluded.end_date,note=excluded.note;
  -- FK prevents removing members referenced by expenses (including trash) or transfers.
  delete from ledger.event_members where event_id=eid and member_id not in(select value::uuid from jsonb_array_elements_text(p_data->'members'));
  for item in select value from jsonb_array_elements(p_data->'members') loop
   insert into ledger.event_members values(w.id,eid,(item#>>'{}')::uuid) on conflict do nothing;
  end loop;
  note:=p_data->>'name';
 else
  eid:=(p_data->>'event_id')::uuid;
  select * into ev from ledger.events where id=eid and workspace_id=w.id;
  if ev.id is null then raise exception 'invalid_event'; end if;
  if p_action='expense.save' then
   xid:=coalesce((p_data->>'id')::uuid,gen_random_uuid());
   select * into ex from ledger.expenses where id=xid;
   if ex.id is not null and (ex.event_id<>eid or ex.deleted_at is not null) then raise exception 'invalid_expense'; end if;
   if coalesce(p_data->>'amount','') !~ '^[0-9]+$' then raise exception '金額必須是正整數'; end if;
   amt:=(p_data->>'amount')::integer; mode:=p_data->>'mode';dt:=(p_data->>'date')::date;
   if dt<ev.start_date or (ev.end_date is not null and dt>ev.end_date) then raise exception '日期不在活動範圍'; end if;
   if jsonb_typeof(p_data->'splits') is distinct from 'array' or jsonb_array_length(p_data->'splits') not between 1 and 6 then raise exception '請選擇分攤成員'; end if;
   insert into ledger.expenses(id,event_id,date,amount,payer_id,category,note,mode) values(xid,eid,dt,amt,(p_data->>'payer_id')::uuid,p_data->>'category',coalesce(p_data->>'note',''),mode)
   on conflict(id) do update set date=excluded.date,amount=excluded.amount,payer_id=excluded.payer_id,category=excluded.category,note=excluded.note,mode=excluded.mode,updated_at=now();
   delete from ledger.expense_splits where expense_id=xid;
   for item in select value from jsonb_array_elements(p_data->'splits') loop
    mid:=(item->>'member_id')::uuid;
    if mode='custom' and coalesce(item->>'share_amount','') !~ '^[0-9]+$' then raise exception '自訂金額必須是整數'; end if;
    if mode='weighted' and coalesce(item->>'weight','') !~ '^[0-9]+$' then raise exception '份數必須是正整數'; end if;
    insert into ledger.expense_splits values(xid,eid,mid,case when mode='custom' then (item->>'share_amount')::integer else 0 end,case when mode='weighted' then (item->>'weight')::integer else 1 end);
   end loop;
   if mode='equal' then
    select count(*) into total from ledger.expense_splits where expense_id=xid;
    update ledger.expense_splits set share_amount=amt/total where expense_id=xid;
    cursor_index:=ev.remainder_rotation_index;
    for extra in 1..(amt%total) loop
     select ordered.member_id,(ordered.member_index+1)%ordered.member_total
       into mid,cursor_index
     from (
      select m.id member_id,row_number() over(order by m.position)-1 member_index,
             count(*) over() member_total
      from ledger.members m where m.workspace_id=w.id
     ) ordered
     join ledger.expense_splits s on s.expense_id=xid and s.member_id=ordered.member_id
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
    -- Weighted splits keep the existing largest-remainder apportionment.
    with raw as(select s.member_id,(amt::bigint*s.weight)/total base,(amt::bigint*s.weight)%total rem,m.position from ledger.expense_splits s join ledger.members m on m.id=s.member_id where expense_id=xid),
    ranked as(select *,row_number() over(order by rem desc,position) rank,amt-sum(base) over() extra from raw)
    update ledger.expense_splits s set share_amount=r.base+case when r.rank<=r.extra then 1 else 0 end from ranked r where s.expense_id=xid and s.member_id=r.member_id;
   end if;
   if (select sum(share_amount) from ledger.expense_splits where expense_id=xid)<>amt then raise exception '分攤合計必須等於消費金額'; end if;
   note:=case when ex.id is null then '新增 ' else '修改 ' end||coalesce(nullif(p_data->>'note',''),'消費')||' NT$ '||amt;
  elsif p_action in ('expense.delete','expense.restore') then
   xid:=(p_data->>'id')::uuid;
   select * into ex from ledger.expenses where id=xid and event_id=eid;
   if ex.id is null then raise exception 'invalid_expense'; end if;
   update ledger.expenses set deleted_at=case when p_action='expense.delete' then now() else null end,updated_at=now() where id=xid;
   note:=case when p_action='expense.delete' then '刪除 ' else '復原 ' end||coalesce(nullif(ex.note,''),'消費')||' NT$ '||ex.amount;
  elsif p_action='payment.add' then
   fromid:=(p_data->>'from_id')::uuid;toid:=(p_data->>'to_id')::uuid;
   if coalesce(p_data->>'amount','') !~ '^[0-9]+$' then raise exception '金額必須是正整數'; end if;
   amt:=(p_data->>'amount')::integer;
   if amt<=0 or amt>least(-ledger.balance(eid,fromid),ledger.balance(eid,toid)) then raise exception '轉帳建議已變動，請重新確認'; end if;
   insert into ledger.settlements(event_id,from_id,to_id,amount) values(eid,fromid,toid,amt);
   note:='標記轉帳已付款 NT$ '||amt;
  elsif p_action='payment.remove' then
   delete from ledger.settlements where id=(p_data->>'id')::uuid and event_id=eid;
   if not found then raise exception 'invalid_payment'; end if;
   note:='取消已付款標記';
  elsif p_action='event.archive' then
   update ledger.events set archived=(p_data->>'archived')::boolean where id=eid;
   note:=case when (p_data->>'archived')::boolean then '移至過去活動' else '重新開啟活動' end;
  else raise exception 'invalid_action';
  end if;
 end if;
 insert into ledger.activity_logs(workspace_id,event_id,actor_id,action,detail) values(w.id,eid,p_actor,p_action,note);
 update ledger.workspaces set revision=revision+1 where id=w.id;
end $$;
