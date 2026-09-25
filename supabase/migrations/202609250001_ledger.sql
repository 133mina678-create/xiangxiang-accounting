-- Capability-only API: no table access, no public workspace enumeration.
create schema if not exists ledger;
revoke all on schema ledger from public;

create table ledger.workspaces (
 id uuid primary key default gen_random_uuid(),
 secret_hash bytea not null unique,
 revision integer not null default 0,
 created_at timestamptz not null default now()
);
create table ledger.members (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references ledger.workspaces,
 name text not null, icon text not null, color text not null, position integer not null,
 unique(workspace_id,position), unique(workspace_id,id)
);
create table ledger.events (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references ledger.workspaces,
 name text not null check(length(name) between 1 and 80),start_date date not null,end_date date,
 note text not null default '' check(length(note)<=1000),archived boolean not null default false,
 check(end_date is null or end_date>=start_date),unique(workspace_id,id)
);
create table ledger.event_members (
 workspace_id uuid not null,event_id uuid not null,member_id uuid not null,
 primary key(event_id,member_id),
 foreign key(workspace_id,event_id) references ledger.events(workspace_id,id),
 foreign key(workspace_id,member_id) references ledger.members(workspace_id,id)
);
create table ledger.expenses (
 id uuid primary key default gen_random_uuid(),event_id uuid not null references ledger.events,
 date date not null,amount integer not null check(amount between 1 and 100000000),
 payer_id uuid not null,category text not null check(category in ('food','drink','transport','stay','fun','shopping','misc','other')),
 note text not null default '' check(length(note)<=500),mode text not null check(mode in ('equal','custom','weighted')),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),deleted_at timestamptz,
 unique(event_id,id),foreign key(event_id,payer_id) references ledger.event_members(event_id,member_id)
);
create table ledger.expense_splits (
 expense_id uuid not null,event_id uuid not null,member_id uuid not null,
 share_amount integer not null check(share_amount>=0),weight integer not null check(weight between 1 and 10000),
 primary key(expense_id,member_id),
 foreign key(event_id,expense_id) references ledger.expenses(event_id,id),
 foreign key(event_id,member_id) references ledger.event_members(event_id,member_id)
);
create table ledger.settlements (
 id uuid primary key default gen_random_uuid(),event_id uuid not null references ledger.events,
 from_id uuid not null,to_id uuid not null,amount integer not null check(amount>0),
 created_at timestamptz not null default now(),check(from_id<>to_id),
 foreign key(event_id,from_id) references ledger.event_members(event_id,member_id),
 foreign key(event_id,to_id) references ledger.event_members(event_id,member_id)
);
create table ledger.activity_logs (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references ledger.workspaces,
 event_id uuid references ledger.events,actor_id uuid not null,
 action text not null,detail text not null,created_at timestamptz not null default now(),
 foreign key(workspace_id,actor_id) references ledger.members(workspace_id,id)
);
create index on ledger.expenses(event_id,date);
create index on ledger.activity_logs(workspace_id,created_at desc);
create index on ledger.settlements(event_id);

-- Defense in depth. Expose only public RPCs, never the ledger schema in PostgREST.
alter table ledger.workspaces enable row level security;
alter table ledger.members enable row level security;
alter table ledger.events enable row level security;
alter table ledger.event_members enable row level security;
alter table ledger.expenses enable row level security;
alter table ledger.expense_splits enable row level security;
alter table ledger.settlements enable row level security;
alter table ledger.activity_logs enable row level security;
revoke all on all tables in schema ledger from public,anon,authenticated;

-- Deferred trigger also protects administrative SQL writes across a whole transaction.
create function ledger.check_split_total() returns trigger language plpgsql set search_path='' as $$
declare eid uuid; a integer;
begin
 if TG_TABLE_NAME='expenses' then eid:=coalesce(NEW.id,OLD.id); else eid:=coalesce(NEW.expense_id,OLD.expense_id); end if;
 select amount into a from ledger.expenses where id=eid;
 if a is not null and a<>(select coalesce(sum(share_amount),0) from ledger.expense_splits where expense_id=eid) then
  raise exception '分攤合計必須等於消費金額';
 end if;
 return null;
end $$;
create constraint trigger expense_balanced after insert or update on ledger.expenses deferrable initially deferred for each row execute function ledger.check_split_total();
create constraint trigger splits_balanced after insert or update or delete on ledger.expense_splits deferrable initially deferred for each row execute function ledger.check_split_total();

create function public.read_book(p_secret text) returns jsonb language plpgsql security definer set search_path='' as $$
declare w ledger.workspaces; result jsonb;
begin
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception 'invalid_link'; end if;
 select * into w from ledger.workspaces where secret_hash=sha256(convert_to(p_secret,'UTF8'));
 if w.id is null then raise exception 'invalid_link'; end if;
 -- One SELECT gives an MVCC-consistent snapshot including the revision.
 select jsonb_build_object('revision',ws.revision,
 'members',coalesce((select jsonb_agg(to_jsonb(m)-'workspace_id' order by position) from ledger.members m where workspace_id=w.id),'[]'::jsonb),
 'events',coalesce((select jsonb_agg((to_jsonb(e)-'workspace_id')||jsonb_build_object('members',(select jsonb_agg(em.member_id order by m.position) from ledger.event_members em join ledger.members m on m.id=em.member_id where em.event_id=e.id)) order by start_date desc) from ledger.events e where workspace_id=w.id),'[]'::jsonb),
 'expenses',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('splits',(select jsonb_agg(to_jsonb(s)-'event_id'-'expense_id' order by m.position) from ledger.expense_splits s join ledger.members m on m.id=s.member_id where s.expense_id=x.id)) order by date desc,created_at desc) from ledger.expenses x join ledger.events e on e.id=x.event_id where e.workspace_id=w.id),'[]'::jsonb),
 'payments',coalesce((select jsonb_agg(to_jsonb(s) order by s.created_at) from ledger.settlements s join ledger.events e on e.id=s.event_id where e.workspace_id=w.id),'[]'::jsonb),
 'logs',coalesce((select jsonb_agg(to_jsonb(l)-'workspace_id') from (select * from ledger.activity_logs where workspace_id=w.id order by created_at desc,id limit 100) l),'[]'::jsonb)
 ) into result from ledger.workspaces ws where ws.id=w.id;
 return result;
end $$;

create function ledger.balance(p_event uuid,p_member uuid) returns bigint language sql set search_path='' as $$
 select coalesce((select sum(amount) from ledger.expenses where event_id=p_event and payer_id=p_member and deleted_at is null),0)
 - coalesce((select sum(s.share_amount) from ledger.expense_splits s join ledger.expenses e on e.id=s.expense_id where e.event_id=p_event and s.member_id=p_member and e.deleted_at is null),0)
 + coalesce((select sum(amount) from ledger.settlements where event_id=p_event and from_id=p_member),0)
 - coalesce((select sum(amount) from ledger.settlements where event_id=p_event and to_id=p_member),0);
$$;

create function public.change_book(p_secret text,p_revision integer,p_actor uuid,p_action text,p_data jsonb) returns void language plpgsql security definer set search_path='' as $$
declare w ledger.workspaces; ev ledger.events; eid uuid; xid uuid; ex ledger.expenses; item jsonb; amt integer; total bigint; mode text; note text; dt date; fromid uuid; toid uuid; mid uuid;
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
   if mode<>'custom' then
    select sum(weight) into total from ledger.expense_splits where expense_id=xid;
    -- Numeric-free exact integer largest-remainder apportionment.
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

revoke all on all functions in schema ledger from public,anon,authenticated;
revoke all on function public.read_book(text) from public;
revoke all on function public.change_book(text,integer,uuid,text,jsonb) from public;
grant execute on function public.read_book(text) to anon,authenticated;
grant execute on function public.change_book(text,integer,uuid,text,jsonb) to anon,authenticated;
