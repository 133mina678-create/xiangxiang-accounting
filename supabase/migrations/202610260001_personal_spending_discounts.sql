-- Add per-person discount details without rewriting any existing expense or split.
-- Existing rows remain unchanged and are interpreted as having no discount.
create table ledger.expense_discount_details (
 expense_id uuid not null,
 member_id uuid not null,
 gross_amount integer not null check(gross_amount between 0 and 100000000),
 discount_amount integer not null check(discount_amount between 0 and gross_amount),
 primary key(expense_id,member_id),
 foreign key(expense_id,member_id)
  references ledger.expense_splits(expense_id,member_id) on delete cascade,
 check(gross_amount-discount_amount>=0)
);

alter table ledger.expense_discount_details enable row level security;
revoke all on ledger.expense_discount_details from public,anon,authenticated;

-- A separate atomic RPC keeps the established split modes and settlement
-- algorithm unchanged. Only discount-aware saves use this function.
create function public.save_discount_expense(
 p_secret text,p_revision integer,p_actor uuid,p_data jsonb
) returns void language plpgsql security definer set search_path='' as $$
declare
 w ledger.workspaces; ev ledger.events; ex ledger.expenses;
 xid uuid; eid uuid; mid uuid; item jsonb; dt date;
 amt integer; gross integer; discount integer;
 split_total bigint:=0; discount_total bigint:=0;
 expense_name text; detail text;
begin
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then
  raise exception 'invalid_link';
 end if;
 select * into w from ledger.workspaces
  where secret_hash=sha256(convert_to(p_secret,'UTF8')) for update;
 if w.id is null then raise exception 'invalid_link'; end if;
 if p_revision is distinct from w.revision then raise exception 'conflict'; end if;
 if not exists(
  select 1 from ledger.members where workspace_id=w.id and id=p_actor
   and member_type='fixed'
 ) then raise exception '請選擇操作身份'; end if;

 eid:=(p_data->>'event_id')::uuid;
 select * into ev from ledger.events
  where id=eid and workspace_id=w.id and deleted_at is null;
 if ev.id is null then raise exception 'invalid_event'; end if;
 if ev.status='closed' then raise exception '此活動已結束，歷史帳目為唯讀'; end if;
 if ev.settlement_state='locked' then raise exception '正式結算已開始，帳目已鎖定'; end if;

 xid:=coalesce((p_data->>'id')::uuid,gen_random_uuid());
 select * into ex from ledger.expenses where id=xid;
 if ex.id is not null and (ex.event_id<>eid or ex.deleted_at is not null) then
  raise exception 'invalid_expense';
 end if;
 if coalesce(p_data->>'amount','') !~ '^[0-9]+$' then
  raise exception '金額必須是正整數';
 end if;
 amt:=(p_data->>'amount')::integer;
 if amt not between 1 and 100000000 then raise exception '金額超出範圍'; end if;
 expense_name:=trim(coalesce(p_data->>'name',''));
 if length(expense_name) not between 1 and 300 then raise exception '請輸入消費名稱'; end if;
 if length(coalesce(p_data->>'note',''))>300 then raise exception '備註不可超過 300 字'; end if;
 dt:=(p_data->>'date')::date;
 if dt<ev.start_date or (ev.end_date is not null and dt>ev.end_date) then
  raise exception '日期不在活動範圍';
 end if;
 if jsonb_typeof(p_data->'splits') is distinct from 'array'
    or jsonb_array_length(p_data->'splits') not between 1 and 50 then
  raise exception '請選擇分攤成員';
 end if;

 insert into ledger.expenses(
  id,event_id,name,date,amount,payer_id,category,note,mode
 ) values(
  xid,eid,expense_name,dt,amt,(p_data->>'payer_id')::uuid,
  p_data->>'category',coalesce(p_data->>'note',''),'custom'
 ) on conflict(id) do update set
  name=excluded.name,date=excluded.date,amount=excluded.amount,
  payer_id=excluded.payer_id,category=excluded.category,note=excluded.note,
  mode='custom',updated_at=now();

 delete from ledger.expense_splits where expense_id=xid;
 for item in select value from jsonb_array_elements(p_data->'splits') loop
  mid:=(item->>'member_id')::uuid;
  if coalesce(item->>'gross_amount','') !~ '^[0-9]+$'
     or coalesce(item->>'discount_amount','') !~ '^[0-9]+$' then
   raise exception '原價與折扣必須是整數';
  end if;
  gross:=(item->>'gross_amount')::integer;
  discount:=(item->>'discount_amount')::integer;
  if gross not between 0 and 100000000 or discount<0 or discount>gross then
   raise exception '個人折扣不可大於原價消費';
  end if;
  insert into ledger.expense_splits(
   expense_id,event_id,member_id,share_amount,weight
  ) values(xid,eid,mid,gross-discount,1);
  insert into ledger.expense_discount_details(
   expense_id,member_id,gross_amount,discount_amount
  ) values(xid,mid,gross,discount);
  split_total:=split_total+(gross-discount);
  discount_total:=discount_total+discount;
 end loop;
 if split_total<>amt then raise exception '每人折後金額合計必須等於結帳金額'; end if;
 if discount_total<=0 then raise exception '請至少輸入 1 元折扣'; end if;

 detail:=case when ex.id is null then '新增 ' else '修改 ' end
  ||expense_name||' NT$ '||amt;
 insert into ledger.activity_logs(workspace_id,event_id,actor_id,action,detail)
 values(w.id,eid,p_actor,'expense.save',detail);
 update ledger.workspaces set revision=revision+1 where id=w.id;
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
 'expenses',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('splits',(select jsonb_agg((to_jsonb(s)-'event_id'-'expense_id')||case when d.expense_id is null then '{}'::jsonb else jsonb_build_object('gross_amount',d.gross_amount,'discount_amount',d.discount_amount) end order by m.position) from ledger.expense_splits s join ledger.members m on m.id=s.member_id left join ledger.expense_discount_details d on d.expense_id=s.expense_id and d.member_id=s.member_id where s.expense_id=x.id)) order by date desc,created_at desc) from ledger.expenses x join ledger.events e on e.id=x.event_id where e.workspace_id=w.id and e.deleted_at is null),'[]'::jsonb),
 'payments',coalesce((select jsonb_agg(to_jsonb(s)-'proof_storage_path' order by s.created_at) from ledger.settlements s join ledger.events e on e.id=s.event_id where e.workspace_id=w.id and e.deleted_at is null),'[]'::jsonb),
 'logs',coalesce((select jsonb_agg(to_jsonb(l)-'workspace_id') from (select * from ledger.activity_logs where workspace_id=w.id and (event_id is null or exists(select 1 from ledger.events e where e.id=event_id and e.deleted_at is null)) order by created_at desc,id limit 100) l),'[]'::jsonb)
 ) into result from ledger.workspaces ws where ws.id=w.id;
 return result;
end $$;

notify pgrst, 'reload schema';
