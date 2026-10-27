-- Independent supplemental/correction bills. This migration is additive:
-- historical expenses, main snapshots and payment rows are never rewritten.

create table ledger.supplemental_bills (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references ledger.workspaces(id),
 event_id uuid not null references ledger.events(id) on delete cascade,
 bill_number integer not null check(bill_number>0),
 kind text not null check(kind in ('expense','correction')),
 source_expense_id uuid references ledger.expenses(id),
 status text not null default 'draft'
  check(status in ('draft','reviewing','settled','canceled')),
 current_version integer not null default 1 check(current_version>0),
 created_by uuid not null,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 settled_at timestamptz,
 canceled_at timestamptz,
 reopened_closed_event boolean not null default false,
 foreign key(workspace_id,created_by) references ledger.members(workspace_id,id),
 foreign key(event_id,source_expense_id)
  references ledger.expenses(event_id,id),
 unique(event_id,bill_number),
 unique(event_id,id),
 check((kind='expense' and source_expense_id is null)
    or (kind='correction' and source_expense_id is not null))
);
create unique index supplemental_one_open_correction
 on ledger.supplemental_bills(source_expense_id)
 where kind='correction' and status in ('draft','reviewing');

create table ledger.supplemental_bill_versions (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null,
 event_id uuid not null,
 bill_id uuid not null,
 version integer not null check(version>0),
 status text not null default 'draft'
  check(status in ('draft','reviewing','approved','replaced','canceled')),
 reason text not null check(length(btrim(reason)) between 1 and 300),
 base_snapshot jsonb,
 proposal jsonb not null,
 delta_snapshot jsonb not null,
 created_by uuid not null,
 created_at timestamptz not null default clock_timestamp(),
 started_at timestamptz,
 deadline_at timestamptz,
 approved_at timestamptz,
 foreign key(event_id,bill_id)
  references ledger.supplemental_bills(event_id,id) on delete cascade,
 foreign key(workspace_id,event_id) references ledger.events(workspace_id,id),
 foreign key(workspace_id,created_by) references ledger.members(workspace_id,id),
 unique(bill_id,version),
 unique(bill_id,id),
 check((started_at is null and deadline_at is null)
    or deadline_at=started_at+interval '48 hours')
);

create table ledger.supplemental_bill_participants (
 workspace_id uuid not null,
 event_id uuid not null,
 bill_id uuid not null,
 version_id uuid not null,
 member_id uuid not null,
 status text not null default 'pending'
  check(status in ('pending','confirmed','disputed','rejected')),
 confirmed_at timestamptz,
 primary key(version_id,member_id),
 foreign key(bill_id,version_id)
  references ledger.supplemental_bill_versions(bill_id,id) on delete cascade,
 foreign key(event_id,bill_id)
  references ledger.supplemental_bills(event_id,id) on delete cascade,
 foreign key(event_id,member_id) references ledger.event_members(event_id,member_id),
 foreign key(workspace_id,event_id) references ledger.events(workspace_id,id),
 foreign key(workspace_id,member_id) references ledger.members(workspace_id,id),
 check((status='confirmed' and confirmed_at is not null)
    or (status<>'confirmed' and confirmed_at is null))
);

create table ledger.supplemental_bill_disputes (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null,
 event_id uuid not null,
 bill_id uuid not null,
 version_id uuid not null,
 member_id uuid not null,
 kind text not null check(kind in ('dispute','reject')),
 reason text not null check(length(btrim(reason)) between 1 and 300),
 created_at timestamptz not null default clock_timestamp(),
 resolved_at timestamptz,
 resolution text check(resolution in ('withdrawn','accepted_revision')),
 foreign key(bill_id,version_id)
  references ledger.supplemental_bill_versions(bill_id,id),
 foreign key(event_id,bill_id)
  references ledger.supplemental_bills(event_id,id) on delete cascade,
 foreign key(workspace_id,member_id) references ledger.members(workspace_id,id)
);
create unique index supplemental_one_active_dispute
 on ledger.supplemental_bill_disputes(bill_id,member_id)
 where resolved_at is null;
create index supplemental_event_status
 on ledger.supplemental_bills(event_id,status,updated_at desc);

alter table ledger.supplemental_bills enable row level security;
alter table ledger.supplemental_bill_versions enable row level security;
alter table ledger.supplemental_bill_participants enable row level security;
alter table ledger.supplemental_bill_disputes enable row level security;
revoke all on ledger.supplemental_bills from public,anon,authenticated;
revoke all on ledger.supplemental_bill_versions from public,anon,authenticated;
revoke all on ledger.supplemental_bill_participants from public,anon,authenticated;
revoke all on ledger.supplemental_bill_disputes from public,anon,authenticated;

alter table ledger.settlement_review_disputes
 add column resolution text check(resolution in ('withdrawn','accepted_supplemental'));

alter table ledger.settlement_snapshots
 add column snapshot_kind text not null default 'main'
  check(snapshot_kind in ('main','supplemental')),
 add column supplemental_bill_id uuid unique
  references ledger.supplemental_bills(id),
 add constraint settlement_snapshot_source_check check(
  (snapshot_kind='main' and supplemental_bill_id is null)
  or (snapshot_kind='supplemental' and supplemental_bill_id is not null)
 );

alter table ledger.supplemental_bills
 add column settled_snapshot_id uuid unique
  references ledger.settlement_snapshots(id);

alter table ledger.settlements
 add column paused_by_bill_id uuid references ledger.supplemental_bills(id),
 add column superseded_by_snapshot_id uuid references ledger.settlement_snapshots(id),
 drop constraint settlements_status_check,
 add constraint settlements_status_check check(status in (
  'record_only','pending_payment','paused','superseded',
  'awaiting_confirmation','disputed','confirmed','auto_confirmed'
 )),
 drop constraint settlements_lifecycle_check,
 add constraint settlements_lifecycle_check check(
  (status in ('record_only','pending_payment','paused','superseded')
    and proof_storage_path is null and paid_at is null and confirmed_at is null)
  or (status in ('awaiting_confirmation','disputed')
    and proof_storage_path is not null and paid_at is not null and confirmed_at is null)
  or (status in ('confirmed','auto_confirmed')
    and proof_storage_path is null and paid_at is not null and confirmed_at is not null)
 ),
 add constraint settlements_pause_shape_check check(
  (status='paused' and paused_by_bill_id is not null)
  or (status<>'paused' and paused_by_bill_id is null)
 ),
 add constraint settlements_supersede_shape_check check(
  (status='superseded' and superseded_by_snapshot_id is not null)
  or (status<>'superseded' and superseded_by_snapshot_id is null)
 );

create function ledger.supplemental_expense_payload(p_expense uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'name',x.name,'date',x.date,'amount',x.amount,'payer_id',x.payer_id,
  'category',x.category,'note',x.note,'mode',x.mode,
  'splits',coalesce((select jsonb_agg(
   (to_jsonb(s)-'event_id'-'expense_id')||case when d.expense_id is null
    then '{}'::jsonb else jsonb_build_object(
     'gross_amount',d.gross_amount,'discount_amount',d.discount_amount,
     'discount_method',d.discount_method) end order by m.position)
   from ledger.expense_splits s join ledger.members m on m.id=s.member_id
   left join ledger.expense_discount_details d
    on d.expense_id=s.expense_id and d.member_id=s.member_id
   where s.expense_id=x.id),'[]'::jsonb)
 ) from ledger.expenses x where x.id=p_expense and x.deleted_at is null
$$;
revoke all on function ledger.supplemental_expense_payload(uuid)
 from public,anon,authenticated;

create function ledger.validate_supplemental_proposal(p_event uuid,p jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare ev ledger.events; amt bigint; row jsonb; total bigint:=0; seen integer;
begin
 select * into ev from ledger.events where id=p_event;
 if ev.id is null then raise exception 'invalid_event'; end if;
 if length(btrim(coalesce(p->>'name',''))) not between 1 and 80
    or length(coalesce(p->>'note',''))>300 then
  raise exception '請確認消費名稱與備註長度';
 end if;
 if coalesce(p->>'amount','') !~ '^[0-9]+$' then raise exception '金額必須是正整數'; end if;
 amt:=(p->>'amount')::bigint;
 if amt not between 1 and 100000000 then raise exception '結算金額錯誤'; end if;
 if (p->>'date')::date<ev.start_date
    or (ev.end_date is not null and (p->>'date')::date>ev.end_date) then
  raise exception '日期不在活動範圍';
 end if;
 if coalesce(p->>'mode','') not in ('equal','custom','weighted') then
  raise exception '不支援的分攤方式';
 end if;
 if not exists(select 1 from ledger.event_members
  where event_id=p_event and member_id=(p->>'payer_id')::uuid) then
  raise exception '付款人不在本活動';
 end if;
 if jsonb_typeof(p->'splits') is distinct from 'array'
    or jsonb_array_length(p->'splits') not between 1 and 50 then
  raise exception '請選擇分攤成員';
 end if;
 select count(distinct value->>'member_id') into seen
  from jsonb_array_elements(p->'splits');
 if seen<>jsonb_array_length(p->'splits') then raise exception '分攤成員不可重複'; end if;
 for row in select value from jsonb_array_elements(p->'splits') loop
  if coalesce(row->>'share_amount','') !~ '^[0-9]+$'
     or coalesce(row->>'weight','') !~ '^[0-9]+$' then
   raise exception '分攤金額與份數必須是整數';
  end if;
  if not exists(select 1 from ledger.event_members
   where event_id=p_event and member_id=(row->>'member_id')::uuid) then
   raise exception '分攤成員不在本活動';
  end if;
  if row ? 'gross_amount' then
   if coalesce(row->>'gross_amount','') !~ '^[0-9]+$'
      or coalesce(row->>'discount_amount','') !~ '^[0-9]+$'
      or (row->>'gross_amount')::bigint-(row->>'discount_amount')::bigint
         <>(row->>'share_amount')::bigint then
    raise exception '折扣明細不平衡';
   end if;
  end if;
  total:=total+(row->>'share_amount')::bigint;
 end loop;
 if total<>amt then raise exception '分攤合計必須等於消費金額'; end if;
end $$;
revoke all on function ledger.validate_supplemental_proposal(uuid,jsonb)
 from public,anon,authenticated;

create function ledger.supplemental_delta(
 p_kind text,p_event uuid,p_source uuid,p_proposal jsonb
) returns jsonb language sql stable security definer set search_path='' as $$
 with old_data as (
  select case when p_kind='correction'
   then ledger.supplemental_expense_payload(p_source) else null end p
 ), ids as (
  select (p_proposal->>'payer_id')::uuid id
  union select (p->>'payer_id')::uuid from old_data where p is not null
  union select (x->>'member_id')::uuid from jsonb_array_elements(p_proposal->'splits') x
  union select (x->>'member_id')::uuid from old_data,
   lateral jsonb_array_elements(coalesce(p->'splits','[]'::jsonb)) x
 ), calculated as (
  select ids.id member_id,
   (case when p_proposal->>'payer_id'=ids.id::text
     then (p_proposal->>'amount')::integer else 0 end)
   -(case when old_data.p->>'payer_id'=ids.id::text
     then (old_data.p->>'amount')::integer else 0 end) paid_delta,
   coalesce((select (x->>'share_amount')::integer
    from jsonb_array_elements(p_proposal->'splits') x
    where x->>'member_id'=ids.id::text),0)
   -coalesce((select (x->>'share_amount')::integer
    from jsonb_array_elements(coalesce(old_data.p->'splits','[]'::jsonb)) x
    where x->>'member_id'=ids.id::text),0) share_delta,
   (select x from jsonb_array_elements(p_proposal->'splits') x
    where x->>'member_id'=ids.id::text) new_split,
   (select x from jsonb_array_elements(coalesce(old_data.p->'splits','[]'::jsonb)) x
    where x->>'member_id'=ids.id::text) old_split,
   old_data.p
  from ids cross join old_data
 ), affected as (
  select * from calculated where p_kind='expense' or paid_delta<>0 or share_delta<>0
   or new_split is distinct from old_split
   or (p->>'payer_id'=member_id::text) is distinct from
      (p_proposal->>'payer_id'=member_id::text)
 )
 select coalesce(jsonb_agg(jsonb_build_object(
  'member_id',member_id,'paid_delta',paid_delta,'share_delta',share_delta
 ) order by m.position),'[]'::jsonb)
 from affected join ledger.members m on m.id=affected.member_id
$$;
revoke all on function ledger.supplemental_delta(text,uuid,uuid,jsonb)
 from public,anon,authenticated;

-- Open main review normally freezes source rows. Approved corrections are the
-- only controlled bypass and remain inside the same locked transaction.
create or replace function ledger.guard_open_settlement_review_data() returns trigger
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
 else raise exception 'invalid_review_guard_target'; end if;
 if current_setting('ledger.supplemental_apply',true) is distinct from eid::text
    and exists(select 1 from ledger.settlement_review_rounds
     where event_id=eid and status='open') then
  raise exception '個人明細確認進行中，請先取消本輪再修改帳目';
 end if;
 return case when TG_OP='DELETE' then OLD else NEW end;
end $$;

create function public.save_supplemental_bill(
 p_secret text,p_revision integer,p_actor uuid,p_data jsonb,p_submit boolean
) returns uuid language plpgsql security definer set search_path='' as $$
declare w ledger.workspaces; ev ledger.events; b ledger.supplemental_bills;
 v ledger.supplemental_bill_versions; bid uuid; source uuid; proposal jsonb;
 base jsonb; delta jsonb; n integer; stamp timestamptz; reopen boolean;
begin
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception 'invalid_link'; end if;
 select * into w from ledger.workspaces
  where secret_hash=sha256(convert_to(p_secret,'UTF8')) for update;
 if w.id is null then raise exception 'invalid_link'; end if;
 if p_revision is distinct from w.revision then raise exception 'conflict'; end if;
 if not exists(select 1 from ledger.members where workspace_id=w.id
  and id=p_actor and member_type='fixed') then raise exception '請選擇操作身份'; end if;
 select * into ev from ledger.events where id=(p_data->>'event_id')::uuid
  and workspace_id=w.id and deleted_at is null for update;
 if ev.id is null then raise exception 'invalid_event'; end if;
 reopen:=coalesce((p_data->>'reopen_closed')::boolean,false);
 if ev.status='closed' and not reopen then
  raise exception '請明確選擇「新增補充帳並重新開啟活動」';
 end if;
 if ev.status='closed' and reopen then
  update ledger.events set status='active',closed_at=null,archived=false where id=ev.id;
 end if;
 bid:=coalesce(nullif(p_data->>'id','')::uuid,gen_random_uuid());
 select * into b from ledger.supplemental_bills where id=bid for update;
 if b.id is not null and (b.workspace_id<>w.id or b.event_id<>ev.id
    or b.status not in ('draft','reviewing')) then raise exception 'invalid_supplemental_bill'; end if;
 if coalesce(p_data->>'kind','') not in ('expense','correction') then raise exception 'invalid_bill_kind'; end if;
 source:=nullif(p_data->>'source_expense_id','')::uuid;
 if p_data->>'kind'='correction' then
  if source is null or not exists(select 1 from ledger.expenses
   where id=source and event_id=ev.id and deleted_at is null) then raise exception 'invalid_expense'; end if;
  if ev.settlement_state='draft' and not exists(select 1 from ledger.settlement_review_rounds
   where event_id=ev.id and status='open') then
   raise exception '主帳尚未核對時請直接修改原消費；發起核對後才使用修正帳單';
  end if;
 else source:=null; end if;
 proposal:=p_data->'proposal';
 perform ledger.validate_supplemental_proposal(ev.id,proposal);
 base:=case when source is null then null else ledger.supplemental_expense_payload(source) end;
 if source is not null and base is null then raise exception '原消費版本已失效'; end if;
 delta:=ledger.supplemental_delta(p_data->>'kind',ev.id,source,proposal);
 if jsonb_array_length(delta)=0 then raise exception '修正內容沒有任何變更'; end if;

 if b.id is null then
  select coalesce(max(bill_number),0)+1 into n from ledger.supplemental_bills where event_id=ev.id;
  insert into ledger.supplemental_bills(
   id,workspace_id,event_id,bill_number,kind,source_expense_id,created_by,reopened_closed_event
  ) values(bid,w.id,ev.id,n,p_data->>'kind',source,p_actor,ev.status='closed') returning * into b;
 else
  if b.kind<>p_data->>'kind' or b.source_expense_id is distinct from source then
   raise exception '帳單類型與原消費不可變更';
  end if;
 end if;

 if b.status='draft' then
  select * into v from ledger.supplemental_bill_versions
   where bill_id=b.id and version=b.current_version for update;
  if v.id is null then
   insert into ledger.supplemental_bill_versions(
    workspace_id,event_id,bill_id,version,reason,base_snapshot,proposal,
    delta_snapshot,created_by
   ) values(w.id,ev.id,b.id,b.current_version,btrim(p_data->>'reason'),base,
    proposal,delta,p_actor) returning * into v;
  else
   update ledger.supplemental_bill_versions set reason=btrim(p_data->>'reason'),
    base_snapshot=base,proposal=proposal,delta_snapshot=delta,created_by=p_actor,
    created_at=clock_timestamp() where id=v.id returning * into v;
  end if;
 else
  update ledger.supplemental_bill_versions set status='replaced'
   where bill_id=b.id and version=b.current_version and status='reviewing';
  n:=b.current_version+1;
  insert into ledger.supplemental_bill_versions(
   workspace_id,event_id,bill_id,version,reason,base_snapshot,proposal,
   delta_snapshot,created_by
  ) values(w.id,ev.id,b.id,n,btrim(p_data->>'reason'),base,proposal,delta,p_actor)
  returning * into v;
  update ledger.supplemental_bills set current_version=n where id=b.id;
 end if;

 if p_submit then
  stamp:=clock_timestamp();
  update ledger.supplemental_bill_versions set status='reviewing',started_at=stamp,
   deadline_at=stamp+interval '48 hours' where id=v.id;
  insert into ledger.supplemental_bill_participants(
   workspace_id,event_id,bill_id,version_id,member_id,status,confirmed_at
  ) select w.id,ev.id,b.id,v.id,(d->>'member_id')::uuid,
    case when (d->>'member_id')::uuid=p_actor
      and coalesce((p_data->>'actor_confirm')::boolean,false) then 'confirmed' else 'pending' end,
    case when (d->>'member_id')::uuid=p_actor
      and coalesce((p_data->>'actor_confirm')::boolean,false) then stamp end
   from jsonb_array_elements(delta) d join ledger.members m
    on m.id=(d->>'member_id')::uuid and m.member_type='fixed';
  update ledger.supplemental_bills set status='reviewing',updated_at=stamp where id=b.id;
  if b.kind='correction' and ev.settlement_state='locked' then
   if exists(select 1 from ledger.settlements where snapshot_id=ev.settlement_snapshot_id
     and status in ('awaiting_confirmation','disputed')) then
    raise exception '原結算已有付款證明或異議，請先完成或撤回原付款流程';
   end if;
   update ledger.settlements set status='paused',paused_by_bill_id=b.id,updated_at=stamp
    where snapshot_id=ev.settlement_snapshot_id and status='pending_payment';
  end if;
  insert into ledger.activity_logs(workspace_id,event_id,actor_id,action,detail)
   values(w.id,ev.id,p_actor,'supplement.submit',
    '送出補充帳單 # '||b.bill_number||' 第 '||v.version||' 版');
 else
  update ledger.supplemental_bills set status='draft',updated_at=clock_timestamp() where id=b.id;
 end if;
 update ledger.workspaces set revision=revision+1 where id=w.id;
 return b.id;
end $$;

create function public.transition_supplemental_bill(
 p_secret text,p_actor uuid,p_event uuid,p_bill uuid,p_version uuid,
 p_action text,p_reason text default null
) returns void language plpgsql security definer set search_path='' as $$
declare w ledger.workspaces; b ledger.supplemental_bills;
 v ledger.supplemental_bill_versions; p ledger.supplemental_bill_participants;
 active_dispute uuid; changed integer:=0; stamp timestamptz;
begin
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception 'invalid_link'; end if;
 select * into w from ledger.workspaces
  where secret_hash=sha256(convert_to(p_secret,'UTF8')) for update;
 if w.id is null then raise exception 'invalid_link'; end if;
 if not exists(select 1 from ledger.events where id=p_event and workspace_id=w.id
  and status='active' and deleted_at is null for update) then
  raise exception '此活動目前為唯讀';
 end if;
 select * into b from ledger.supplemental_bills where id=p_bill and event_id=p_event
  and workspace_id=w.id for update;
 select * into v from ledger.supplemental_bill_versions where id=p_version
  and bill_id=b.id and version=b.current_version for update;
 if b.id is null or b.status<>'reviewing' or v.id is null or v.status<>'reviewing' then
  raise exception '補充帳單版本已失效，請重新同步';
 end if;
 select * into p from ledger.supplemental_bill_participants
  where version_id=v.id and member_id=p_actor for update;
 if p.member_id is null then raise exception '你不是本版必要確認成員'; end if;
 select id into active_dispute from ledger.supplemental_bill_disputes
  where bill_id=b.id and member_id=p_actor and resolved_at is null for update;
 stamp:=clock_timestamp();
 if p_action='confirm' then
  update ledger.supplemental_bill_disputes set resolved_at=stamp,
   resolution='accepted_revision' where id=active_dispute;
  update ledger.supplemental_bill_participants set status='confirmed',confirmed_at=stamp
   where version_id=v.id and member_id=p_actor and status<>'confirmed';
  get diagnostics changed=row_count;
 elsif p_action in ('dispute','reject') then
  if length(btrim(coalesce(p_reason,''))) not between 1 and 300 then
   raise exception '請填寫 1～300 字的原因';
  end if;
  if active_dispute is null then
   insert into ledger.supplemental_bill_disputes(
    workspace_id,event_id,bill_id,version_id,member_id,kind,reason
   ) values(w.id,p_event,b.id,v.id,p_actor,
    case when p_action='reject' then 'reject' else 'dispute' end,btrim(p_reason));
  end if;
  update ledger.supplemental_bill_participants set status=
   case when p_action='reject' then 'rejected' else 'disputed' end,confirmed_at=null
   where version_id=v.id and member_id=p_actor;
  changed:=1;
 elsif p_action='withdraw' then
  if active_dispute is null then return; end if;
  update ledger.supplemental_bill_disputes set resolved_at=stamp,resolution='withdrawn'
   where id=active_dispute;
  update ledger.supplemental_bill_participants set status='pending',confirmed_at=null
   where version_id=v.id and member_id=p_actor;
  changed:=1;
 else raise exception 'invalid_action'; end if;
 if changed>0 then
  insert into ledger.activity_logs(workspace_id,event_id,actor_id,action,detail)
   values(w.id,p_event,p_actor,'supplement.'||p_action,
    '補充帳單 # '||b.bill_number||' 第 '||v.version||' 版');
  update ledger.workspaces set revision=revision+1 where id=w.id;
 end if;
end $$;

create function public.cancel_supplemental_bill(
 p_secret text,p_revision integer,p_actor uuid,p_event uuid,p_bill uuid
) returns void language plpgsql security definer set search_path='' as $$
declare w ledger.workspaces; b ledger.supplemental_bills;
begin
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception 'invalid_link'; end if;
 select * into w from ledger.workspaces
  where secret_hash=sha256(convert_to(p_secret,'UTF8')) for update;
 if w.id is null then raise exception 'invalid_link'; end if;
 if p_revision is distinct from w.revision then raise exception 'conflict'; end if;
 if not exists(select 1 from ledger.members where workspace_id=w.id and id=p_actor
  and member_type='fixed') then raise exception '請選擇操作身份'; end if;
 if not exists(select 1 from ledger.events where id=p_event and workspace_id=w.id
  and status='active' and deleted_at is null for update) then
  raise exception '此活動目前為唯讀';
 end if;
 select * into b from ledger.supplemental_bills where id=p_bill and event_id=p_event
  and workspace_id=w.id for update;
 if b.id is null or b.status not in ('draft','reviewing') then
  raise exception '此補充帳單目前不能取消';
 end if;
 update ledger.settlements set status='pending_payment',paused_by_bill_id=null,
  updated_at=clock_timestamp() where paused_by_bill_id=b.id and status='paused';
 update ledger.supplemental_bill_versions set status='canceled'
  where bill_id=b.id and version=b.current_version;
 update ledger.supplemental_bills set status='canceled',canceled_at=clock_timestamp(),
  updated_at=clock_timestamp() where id=b.id;
 insert into ledger.activity_logs(workspace_id,event_id,actor_id,action,detail)
  values(w.id,p_event,p_actor,'supplement.cancel','取消補充帳單 # '||b.bill_number);
 update ledger.workspaces set revision=revision+1 where id=w.id;
end $$;

create or replace function ledger.guard_formal_settlement() returns trigger
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
     or NEW.amount is distinct from OLD.amount or NEW.snapshot_id is distinct from OLD.snapshot_id then
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

create or replace function ledger.refresh_snapshot_status(p_snapshot uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if p_snapshot is null then return; end if;
 update ledger.settlement_snapshots ss set status='completed',
  completed_at=coalesce(completed_at,clock_timestamp())
 where ss.id=p_snapshot and ss.status='locked' and not exists(
  select 1 from ledger.settlements s where s.snapshot_id=ss.id
   and s.status in ('pending_payment','paused','awaiting_confirmation','disputed')
 );
end $$;

create function public.settle_supplemental_bill(
 p_secret text,p_revision integer,p_actor uuid,p_event uuid,p_bill uuid,p_version uuid
) returns uuid language plpgsql security definer set search_path='' as $$
declare w ledger.workspaces; ev ledger.events; b ledger.supplemental_bills;
 v ledger.supplemental_bill_versions; stamp timestamptz; snap uuid; x uuid;
 row jsonb; ids uuid[]; vals bigint[]; i integer; j integer; amt bigint;
begin
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception 'invalid_link'; end if;
 select * into w from ledger.workspaces
  where secret_hash=sha256(convert_to(p_secret,'UTF8')) for update;
 if w.id is null then raise exception 'invalid_link'; end if;
 if p_revision is distinct from w.revision then raise exception 'conflict'; end if;
 if not exists(select 1 from ledger.members where workspace_id=w.id and id=p_actor
  and member_type='fixed') then raise exception '請選擇操作身份'; end if;
 select * into ev from ledger.events where id=p_event and workspace_id=w.id
  and deleted_at is null for update;
 if ev.id is null or ev.status<>'active' then raise exception '此活動目前為唯讀'; end if;
 select * into b from ledger.supplemental_bills where id=p_bill and event_id=ev.id
  and workspace_id=w.id for update;
 select * into v from ledger.supplemental_bill_versions where id=p_version
  and bill_id=b.id and version=b.current_version for update;
 if b.id is null or b.status<>'reviewing' or v.id is null or v.status<>'reviewing' then
  raise exception '補充帳單版本已失效，請重新同步';
 end if;
 if exists(select 1 from ledger.supplemental_bill_disputes
  where bill_id=b.id and resolved_at is null) then raise exception '目前仍有尚未處理的異議或拒絕'; end if;
 stamp:=clock_timestamp();
 if exists(select 1 from ledger.supplemental_bill_participants
   where version_id=v.id and status<>'confirmed') and stamp<v.deadline_at then
  raise exception '尚未全員確認，且 48 小時期限尚未到達';
 end if;
 if b.kind='correction' and ledger.supplemental_expense_payload(b.source_expense_id)
    is distinct from v.base_snapshot then raise exception '原消費版本已改變，請建立新版修正'; end if;

 if b.kind='correction' and ev.settlement_state='draft' then
  if not exists(select 1 from ledger.settlement_review_rounds
   where event_id=ev.id and status='open') then raise exception '主帳確認輪次已失效'; end if;
  perform set_config('ledger.supplemental_apply',ev.id::text,true);
  update ledger.expenses set name=v.proposal->>'name',date=(v.proposal->>'date')::date,
   amount=(v.proposal->>'amount')::integer,payer_id=(v.proposal->>'payer_id')::uuid,
   category=v.proposal->>'category',note=coalesce(v.proposal->>'note',''),
   mode=v.proposal->>'mode',updated_at=stamp where id=b.source_expense_id;
  delete from ledger.expense_discount_details where expense_id=b.source_expense_id;
  delete from ledger.expense_splits where expense_id=b.source_expense_id;
  for row in select value from jsonb_array_elements(v.proposal->'splits') loop
   insert into ledger.expense_splits(expense_id,event_id,member_id,share_amount,weight)
    values(b.source_expense_id,ev.id,(row->>'member_id')::uuid,
     (row->>'share_amount')::integer,(row->>'weight')::integer);
   if row ? 'gross_amount' then
    insert into ledger.expense_discount_details(
     expense_id,member_id,gross_amount,discount_amount,discount_method
    ) values(b.source_expense_id,(row->>'member_id')::uuid,
     (row->>'gross_amount')::integer,(row->>'discount_amount')::integer,
     coalesce(row->>'discount_method','manual'));
   end if;
  end loop;
  update ledger.settlement_review_rounds set
   content_snapshot=ledger.settlement_review_payload(ev.id)
   where event_id=ev.id and status='open';
  update ledger.settlement_review_participants mr set confirmed_at=sp.confirmed_at
   from ledger.settlement_review_rounds r,ledger.supplemental_bill_participants sp
   where r.event_id=ev.id and r.status='open' and mr.round_id=r.id
    and sp.version_id=v.id and sp.member_id=mr.member_id;
  update ledger.settlement_review_disputes d set withdrawn_at=stamp,
   resolution='accepted_supplemental'
   from ledger.settlement_review_rounds r,ledger.supplemental_bill_participants sp
   where r.event_id=ev.id and r.status='open' and d.round_id=r.id
    and d.withdrawn_at is null and sp.version_id=v.id and sp.member_id=d.member_id
    and sp.status='confirmed';
  snap:=null;
 else
  if b.kind='correction' and exists(select 1 from ledger.settlements
    where snapshot_id=ev.settlement_snapshot_id
     and status in ('awaiting_confirmation','disputed')) then
   raise exception '原結算已有付款證明或異議，請先完成或撤回原付款流程';
  end if;
  insert into ledger.settlement_snapshots(
   workspace_id,event_id,source_revision,created_by,total_amount,
   expense_snapshot,balance_snapshot,transfer_snapshot,snapshot_kind,supplemental_bill_id
  ) values(w.id,ev.id,w.revision,p_actor,
   (select coalesce(sum(abs((d->>'share_delta')::bigint)),0)
    from jsonb_array_elements(v.delta_snapshot) d),
   jsonb_build_object('base',v.base_snapshot,'proposal',v.proposal),
   v.delta_snapshot,jsonb_build_object('new','[]'::jsonb),
   'supplemental',b.id) returning id into snap;

  with affected as (
   select (d->>'member_id')::uuid member_id,
    (d->>'paid_delta')::bigint-(d->>'share_delta')::bigint net
   from jsonb_array_elements(v.delta_snapshot) d
   union all
   select from_id,-amount::bigint from ledger.settlements
    where paused_by_bill_id=b.id and status='paused'
   union all
   select to_id,amount::bigint from ledger.settlements
    where paused_by_bill_id=b.id and status='paused'
  ), balances as (
   select m.id,coalesce(sum(a.net),0) net,m.position
   from affected a join ledger.members m on m.id=a.member_id
   group by m.id,m.position having sum(a.net)<>0
  ) select array_agg(id order by position),array_agg(net order by position)
   into ids,vals from balances;
  if coalesce((select sum(value) from unnest(vals) value),0)<>0 then
   raise exception '補充帳單差額不平衡';
  end if;
  if ids is not null then
   for i in 1..array_length(ids,1) loop
    if vals[i]<0 then
     for j in 1..array_length(ids,1) loop
      if vals[i]<0 and vals[j]>0 then
       amt:=least(-vals[i],vals[j]);
       insert into ledger.settlements(
        event_id,from_id,to_id,amount,status,snapshot_id,
        paid_at,confirmed_at,disputed_at,confirmation_method,proof_storage_path
       ) values(ev.id,ids[i],ids[j],amt,
        case when exists(select 1 from ledger.members
          where id in(ids[i],ids[j]) and member_type='guest')
         then 'record_only' else 'pending_payment' end,snap,
        null,null,null,null,null);
       vals[i]:=vals[i]+amt; vals[j]:=vals[j]-amt;
      end if;
     end loop;
    end if;
   end loop;
  end if;
  update ledger.settlements set status='superseded',paused_by_bill_id=null,
   superseded_by_snapshot_id=snap,updated_at=stamp
   where paused_by_bill_id=b.id and status='paused';
  update ledger.settlement_snapshots set transfer_snapshot=jsonb_build_object(
   'new',coalesce((select jsonb_agg(jsonb_build_object(
    'id',s.id,'from_id',s.from_id,'to_id',s.to_id,'amount',s.amount,'status',s.status)
    order by s.created_at,s.id) from ledger.settlements s where s.snapshot_id=snap),'[]'::jsonb)
  ) where id=snap;
  perform ledger.refresh_snapshot_status(snap);
 end if;
 update ledger.supplemental_bill_versions set status='approved',approved_at=stamp where id=v.id;
 update ledger.supplemental_bills set status='settled',settled_at=stamp,
  settled_snapshot_id=snap,updated_at=stamp where id=b.id;
 insert into ledger.activity_logs(workspace_id,event_id,actor_id,action,detail)
  values(w.id,ev.id,p_actor,'supplement.settle','完成補充帳單 # '||b.bill_number);
 update ledger.workspaces set revision=revision+1 where id=w.id;
 return snap;
end $$;

-- An old client still calls the same main settlement RPC. A known correction
-- under review must stop it before the immutable main snapshot is created.
create or replace function public.start_settlement(
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
 if not exists(select 1 from ledger.members where workspace_id=w.id
  and id=p_actor and member_type='fixed') then raise exception '請選擇操作身份'; end if;
 select * into ev from ledger.events where id=p_event and workspace_id=w.id
  and deleted_at is null for update;
 if ev.id is null then raise exception 'invalid_event'; end if;
 if exists(select 1 from ledger.supplemental_bills where event_id=ev.id
  and kind='correction' and status='reviewing') then
  raise exception '原帳仍有待確認的修正帳單，完成處理後才能開始主結算';
 end if;
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
 update ledger.settlement_review_rounds set status='settled',settled_at=stamp where id=r.id;
 snap:=public.start_settlement_v1(p_secret,p_revision,p_actor,p_event,p_plan);
 update ledger.settlement_snapshots set review_round_id=r.id,
  source_revision=r.source_revision where id=snap;
 return snap;
end $$;

-- Supplemental transfers use exactly the existing proof/72-hour lifecycle.
create or replace function public.submit_transfer_proof(
 p_secret text,p_revision integer,p_actor uuid,p_event uuid,p_from uuid,p_to uuid,
 p_amount integer,p_settlement uuid,p_proof_path text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare w ledger.workspaces; s ledger.settlements; ev ledger.events;
 snap ledger.settlement_snapshots; to_name text;
begin
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception 'invalid_link'; end if;
 select * into w from ledger.workspaces where secret_hash=sha256(convert_to(p_secret,'UTF8')) for update;
 if w.id is null then raise exception 'invalid_link'; end if;
 if p_revision is distinct from w.revision then raise exception 'conflict'; end if;
 if not exists(select 1 from ledger.members where workspace_id=w.id and id=p_actor
  and member_type='fixed') then raise exception '請選擇操作身份'; end if;
 select * into ev from ledger.events where id=p_event and workspace_id=w.id;
 if ev.id is null or ev.status<>'active' then raise exception '此活動已結束，歷史帳目為唯讀'; end if;
 if exists(select 1 from ledger.members where id in(p_from,p_to) and member_type='guest') then
  raise exception '臨時成員轉帳請使用人工確認'; end if;
 if p_actor<>p_from then raise exception '只有付款人可以上傳轉帳證明'; end if;
 if p_proof_path is null
    or split_part(p_proof_path,'/',1)<>encode(sha256(convert_to(p_secret,'UTF8')),'hex')
    or split_part(p_proof_path,'/',2)<>p_event::text
    or split_part(p_proof_path,'/',3)<>p_settlement::text then raise exception 'invalid_proof'; end if;
 select * into s from ledger.settlements where id=p_settlement for update;
 if s.id is null or s.event_id<>p_event or s.from_id<>p_from or s.to_id<>p_to
    or s.amount<>p_amount then raise exception 'invalid_transfer'; end if;
 select * into snap from ledger.settlement_snapshots where id=s.snapshot_id;
 if s.status='pending_payment' then
  if (snap.snapshot_kind='main' and s.snapshot_id is distinct from ev.settlement_snapshot_id)
     or (snap.snapshot_kind='supplemental' and not exists(
      select 1 from ledger.supplemental_bills where id=snap.supplemental_bill_id
       and status='settled')) then raise exception '此筆付款來源尚未正式結算'; end if;
 elsif s.status<>'disputed' then raise exception '此筆轉帳已提交或暫停，請重新同步'; end if;
 update ledger.settlements set status='awaiting_confirmation',paid_at=clock_timestamp(),
  proof_storage_path=p_proof_path,disputed_at=null,confirmed_at=null,
  confirmation_method=null,updated_at=clock_timestamp() where id=s.id;
 select name into to_name from ledger.members where id=p_to and workspace_id=w.id;
 insert into ledger.activity_logs(workspace_id,event_id,actor_id,action,detail)
  values(w.id,p_event,p_actor,'transfer.proof','已標記轉帳 NT$ '||p_amount||' 給'||to_name);
 update ledger.workspaces set revision=revision+1 where id=w.id;
 return jsonb_build_object('id',p_settlement,'status','awaiting_confirmation');
end $$;

create or replace function public.process_due_transfers() returns integer
language plpgsql security definer set search_path='' as $$
declare affected integer;
begin
 with due as (
  update ledger.settlements s set status='auto_confirmed',confirmed_at=clock_timestamp(),
   confirmation_method='auto',proof_storage_path=null,updated_at=clock_timestamp()
  where s.status='awaiting_confirmation' and s.paid_at<=clock_timestamp()-interval '72 hours'
  returning s.event_id,s.to_id,s.amount,s.snapshot_id
 ), logged as (
  insert into ledger.activity_logs(workspace_id,event_id,actor_id,action,detail)
  select e.workspace_id,d.event_id,d.to_id,'transfer.auto_confirm',
   '此筆 NT$ '||d.amount||' 已於 72 小時後自動確認'
  from due d join ledger.events e on e.id=d.event_id returning workspace_id
 ), bumped as (
  update ledger.workspaces w set revision=revision+1
  where w.id in(select distinct workspace_id from logged) returning 1
 ) select count(*) into affected from due;
 update ledger.settlement_snapshots ss set status='completed',
  completed_at=coalesce(completed_at,clock_timestamp())
  where ss.status='locked' and not exists(select 1 from ledger.settlements s
   where s.snapshot_id=ss.id and s.status in
    ('pending_payment','paused','awaiting_confirmation','disputed'));
 return affected;
end $$;

-- Closing/deleting cannot hide active supplemental work.
create function ledger.guard_supplemental_event_close() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if OLD.status='active' and NEW.status='closed' and (
  exists(select 1 from ledger.supplemental_bills where event_id=OLD.id and status='reviewing')
  or exists(select 1 from ledger.settlements where event_id=OLD.id
   and status in ('pending_payment','paused','awaiting_confirmation','disputed'))
 ) then raise exception '補充帳單仍有待確認、待付款或異議，暫時不能結束活動'; end if;
 return NEW;
end $$;
create trigger events_supplemental_close before update on ledger.events
 for each row execute function ledger.guard_supplemental_event_close();
revoke all on function ledger.guard_supplemental_event_close()
 from public,anon,authenticated;

alter function public.manage_event_lifecycle(text,uuid,text)
 rename to manage_event_lifecycle_v1;
revoke all on function public.manage_event_lifecycle_v1(text,uuid,text)
 from public,anon,authenticated;
grant execute on function public.manage_event_lifecycle_v1(text,uuid,text) to service_role;
create function public.manage_event_lifecycle(p_secret text,p_event uuid,p_action text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if p_action='delete' and (
  exists(select 1 from ledger.supplemental_bills b join ledger.events e on e.id=b.event_id
   join ledger.workspaces w on w.id=e.workspace_id where b.event_id=p_event
    and w.secret_hash=sha256(convert_to(p_secret,'UTF8')) and b.status='reviewing')
  or exists(select 1 from ledger.settlements s join ledger.events e on e.id=s.event_id
   join ledger.workspaces w on w.id=e.workspace_id where s.event_id=p_event
    and w.secret_hash=sha256(convert_to(p_secret,'UTF8')) and s.status='paused')
 ) then raise exception '補充帳單仍有待處理事項，不能刪除活動'; end if;
 return public.manage_event_lifecycle_v1(p_secret,p_event,p_action);
end $$;

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
 'payments',coalesce((select jsonb_agg((to_jsonb(s)-'proof_storage_path')||jsonb_build_object('source_kind',ss.snapshot_kind,'supplemental_bill_id',ss.supplemental_bill_id) order by s.created_at) from ledger.settlements s join ledger.events e on e.id=s.event_id left join ledger.settlement_snapshots ss on ss.id=s.snapshot_id where e.workspace_id=w.id and e.deleted_at is null),'[]'::jsonb),
 'reviews',coalesce((select jsonb_agg((to_jsonb(r)-'workspace_id'-'content_snapshot')||jsonb_build_object('deadline_reached',clock_timestamp()>=r.deadline_at,'can_start',r.status='open' and not exists(select 1 from ledger.settlement_review_disputes ad where ad.round_id=r.id and ad.withdrawn_at is null) and not exists(select 1 from ledger.supplemental_bills sb where sb.event_id=r.event_id and sb.kind='correction' and sb.status='reviewing') and (clock_timestamp()>=r.deadline_at or not exists(select 1 from ledger.settlement_review_participants up where up.round_id=r.id and up.confirmed_at is null)),'participants',coalesce((select jsonb_agg(to_jsonb(p)-'workspace_id'-'event_id'-'round_id' order by m.position) from ledger.settlement_review_participants p join ledger.members m on m.id=p.member_id where p.round_id=r.id),'[]'::jsonb),'disputes',coalesce((select jsonb_agg(to_jsonb(d)-'workspace_id'-'event_id'-'round_id' order by d.created_at,d.id) from ledger.settlement_review_disputes d where d.round_id=r.id),'[]'::jsonb)) order by r.started_at,r.id) from ledger.settlement_review_rounds r join ledger.events e on e.id=r.event_id where r.workspace_id=w.id and e.deleted_at is null),'[]'::jsonb),
 'supplemental_bills',coalesce((select jsonb_agg((to_jsonb(b)-'workspace_id')||jsonb_build_object('version',(select (to_jsonb(v)-'workspace_id'-'event_id'-'bill_id')||jsonb_build_object('deadline_reached',v.deadline_at is not null and clock_timestamp()>=v.deadline_at,'can_settle',v.status='reviewing' and not exists(select 1 from ledger.supplemental_bill_disputes d where d.bill_id=b.id and d.resolved_at is null) and (clock_timestamp()>=v.deadline_at or not exists(select 1 from ledger.supplemental_bill_participants p where p.version_id=v.id and p.status<>'confirmed')),'participants',coalesce((select jsonb_agg(to_jsonb(p)-'workspace_id'-'event_id'-'bill_id'-'version_id' order by m.position) from ledger.supplemental_bill_participants p join ledger.members m on m.id=p.member_id where p.version_id=v.id),'[]'::jsonb),'disputes',coalesce((select jsonb_agg(to_jsonb(d)-'workspace_id'-'event_id'-'bill_id' order by d.created_at,d.id) from ledger.supplemental_bill_disputes d where d.bill_id=b.id),'[]'::jsonb)) from ledger.supplemental_bill_versions v where v.bill_id=b.id and v.version=b.current_version)) order by b.created_at,b.id) from ledger.supplemental_bills b join ledger.events e on e.id=b.event_id where b.workspace_id=w.id and e.deleted_at is null),'[]'::jsonb),
 'logs',coalesce((select jsonb_agg(to_jsonb(l)-'workspace_id') from (select * from ledger.activity_logs where workspace_id=w.id and (event_id is null or exists(select 1 from ledger.events e where e.id=event_id and e.deleted_at is null)) order by created_at desc,id limit 100) l),'[]'::jsonb)
 ) into result from ledger.workspaces ws where ws.id=w.id;
 return result;
end $$;

revoke all on function public.save_supplemental_bill(text,integer,uuid,jsonb,boolean)
 from public;
revoke all on function public.transition_supplemental_bill(text,uuid,uuid,uuid,uuid,text,text)
 from public;
revoke all on function public.cancel_supplemental_bill(text,integer,uuid,uuid,uuid)
 from public;
revoke all on function public.settle_supplemental_bill(text,integer,uuid,uuid,uuid,uuid)
 from public;
grant execute on function public.save_supplemental_bill(text,integer,uuid,jsonb,boolean)
 to anon,authenticated;
grant execute on function public.transition_supplemental_bill(text,uuid,uuid,uuid,uuid,text,text)
 to anon,authenticated;
grant execute on function public.cancel_supplemental_bill(text,integer,uuid,uuid,uuid)
 to anon,authenticated;
grant execute on function public.settle_supplemental_bill(text,integer,uuid,uuid,uuid,uuid)
 to anon,authenticated;
revoke all on function public.manage_event_lifecycle(text,uuid,text)
 from public,anon,authenticated;
grant execute on function public.manage_event_lifecycle(text,uuid,text) to service_role;
revoke all on function public.submit_transfer_proof(text,integer,uuid,uuid,uuid,uuid,integer,uuid,text)
 from public,anon,authenticated;
grant execute on function public.submit_transfer_proof(text,integer,uuid,uuid,uuid,uuid,integer,uuid,text)
 to service_role;
revoke all on function public.process_due_transfers() from public,anon,authenticated;
grant execute on function public.process_due_transfers() to service_role;

notify pgrst, 'reload schema';
