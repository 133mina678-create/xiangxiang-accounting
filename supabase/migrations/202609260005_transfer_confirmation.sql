-- Transfer confirmation lifecycle and private proof cleanup.
-- Pending suggestions remain calculated from balances. A settlement row is
-- created only after its payer uploads one proof, avoiding stale duplicate
-- pending rows when expenses change.

alter table ledger.settlements
 add column status text not null default 'confirmed',
 add column paid_at timestamptz,
 add column confirmed_at timestamptz,
 add column disputed_at timestamptz,
 add column confirmation_method text,
 add column proof_storage_path text,
 add column updated_at timestamptz not null default now();

update ledger.settlements
set status='confirmed', paid_at=created_at, confirmed_at=created_at,
    confirmation_method='legacy', updated_at=created_at;

-- Keeps the pre-migration payment.add RPC compatible for already-open clients.
-- New proof submissions always pass their lifecycle fields explicitly.
alter table ledger.settlements
 alter column paid_at set default now(),
 alter column confirmed_at set default now(),
 alter column confirmation_method set default 'legacy';

alter table ledger.settlements
 add constraint settlements_status_check check(status in (
   'pending_payment','awaiting_confirmation','disputed','confirmed','auto_confirmed'
 )),
 add constraint settlements_confirmation_method_check
   check(confirmation_method is null or confirmation_method in ('manual','auto','legacy')),
 add constraint settlements_proof_path_check
   check(proof_storage_path is null or length(proof_storage_path) between 40 and 1024),
 add constraint settlements_lifecycle_check check(
   (status='pending_payment' and proof_storage_path is null and paid_at is null and confirmed_at is null)
   or (status in ('awaiting_confirmation','disputed') and proof_storage_path is not null and paid_at is not null and confirmed_at is null)
   or (status in ('confirmed','auto_confirmed') and proof_storage_path is null and paid_at is not null and confirmed_at is not null)
 );

create unique index settlements_one_proof_path
 on ledger.settlements(proof_storage_path) where proof_storage_path is not null;
create index settlements_due_confirmation
 on ledger.settlements(paid_at) where status='awaiting_confirmation';

-- Hard event deletion is not exposed in the UI, but if it is added later the
-- database can remove the whole event safely. Settlement proof cleanup still
-- runs before its cascading row delete.
alter table ledger.expense_splits
 drop constraint expense_splits_event_id_expense_id_fkey,
 add constraint expense_splits_event_id_expense_id_fkey
   foreign key(event_id,expense_id) references ledger.expenses(event_id,id) on delete cascade,
 drop constraint expense_splits_event_id_member_id_fkey,
 add constraint expense_splits_event_id_member_id_fkey
   foreign key(event_id,member_id) references ledger.event_members(event_id,member_id) on delete cascade;
alter table ledger.expenses
 drop constraint expenses_event_id_fkey,
 add constraint expenses_event_id_fkey foreign key(event_id) references ledger.events(id) on delete cascade;
alter table ledger.settlements
 drop constraint settlements_event_id_fkey,
 add constraint settlements_event_id_fkey foreign key(event_id) references ledger.events(id) on delete cascade;
alter table ledger.event_members
 drop constraint event_members_workspace_id_event_id_fkey,
 add constraint event_members_workspace_id_event_id_fkey
   foreign key(workspace_id,event_id) references ledger.events(workspace_id,id) on delete cascade;
alter table ledger.activity_logs
 drop constraint activity_logs_event_id_fkey,
 add constraint activity_logs_event_id_fkey foreign key(event_id) references ledger.events(id) on delete cascade;

create table ledger.proof_cleanup_queue (
 id uuid primary key default gen_random_uuid(),
 object_path text not null unique,
 attempts integer not null default 0,
 next_attempt_at timestamptz not null default now(),
 last_error text,
 created_at timestamptz not null default now()
);
alter table ledger.proof_cleanup_queue enable row level security;
revoke all on ledger.proof_cleanup_queue from public,anon,authenticated;

create function ledger.queue_old_transfer_proof() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if OLD.proof_storage_path is not null and
    (TG_OP='DELETE' or NEW.proof_storage_path is distinct from OLD.proof_storage_path) then
  insert into ledger.proof_cleanup_queue(object_path)
  values(OLD.proof_storage_path) on conflict(object_path) do nothing;
 end if;
 if TG_OP='DELETE' then return OLD; end if;
 return NEW;
end $$;
create trigger settlement_proof_cleanup
 before update of proof_storage_path or delete on ledger.settlements
 for each row execute function ledger.queue_old_transfer_proof();
revoke all on function ledger.queue_old_transfer_proof() from public,anon,authenticated;

-- Supabase Storage exists in production. The conditional keeps local PGlite
-- migration tests portable while using the exact same SQL file.
do $$
begin
 if to_regclass('storage.buckets') is not null then
  insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('transfer-proofs','transfer-proofs',false,2097152,
    array['image/jpeg','image/png','image/webp'])
  on conflict(id) do update set
    public=false,
    file_size_limit=excluded.file_size_limit,
    allowed_mime_types=excluded.allowed_mime_types;
 end if;
end $$;

-- Never return a proof path in the shared book snapshot.
create or replace function public.read_book(p_secret text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w ledger.workspaces; result jsonb;
begin
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception 'invalid_link'; end if;
 select * into w from ledger.workspaces where secret_hash=sha256(convert_to(p_secret,'UTF8'));
 if w.id is null then raise exception 'invalid_link'; end if;
 select jsonb_build_object('revision',ws.revision,
 'members',coalesce((select jsonb_agg(to_jsonb(m)-'workspace_id' order by position) from ledger.members m where workspace_id=w.id),'[]'::jsonb),
 'events',coalesce((select jsonb_agg((to_jsonb(e)-'workspace_id')||jsonb_build_object('members',(select jsonb_agg(em.member_id order by m.position) from ledger.event_members em join ledger.members m on m.id=em.member_id where em.event_id=e.id)) order by start_date desc) from ledger.events e where workspace_id=w.id),'[]'::jsonb),
 'expenses',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('splits',(select jsonb_agg(to_jsonb(s)-'event_id'-'expense_id' order by m.position) from ledger.expense_splits s join ledger.members m on m.id=s.member_id where s.expense_id=x.id)) order by date desc,created_at desc) from ledger.expenses x join ledger.events e on e.id=x.event_id where e.workspace_id=w.id),'[]'::jsonb),
 'payments',coalesce((select jsonb_agg(to_jsonb(s)-'proof_storage_path' order by s.created_at) from ledger.settlements s join ledger.events e on e.id=s.event_id where e.workspace_id=w.id),'[]'::jsonb),
 'logs',coalesce((select jsonb_agg(to_jsonb(l)-'workspace_id') from (select * from ledger.activity_logs where workspace_id=w.id order by created_at desc,id limit 100) l),'[]'::jsonb)
 ) into result from ledger.workspaces ws where ws.id=w.id;
 return result;
end $$;

create function public.submit_transfer_proof(
 p_secret text,p_revision integer,p_actor uuid,p_event uuid,p_from uuid,p_to uuid,
 p_amount integer,p_settlement uuid,p_proof_path text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare w ledger.workspaces; s ledger.settlements; from_name text; to_name text;
begin
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception 'invalid_link'; end if;
 select * into w from ledger.workspaces where secret_hash=sha256(convert_to(p_secret,'UTF8')) for update;
 if w.id is null then raise exception 'invalid_link'; end if;
 if p_revision is distinct from w.revision then raise exception 'conflict'; end if;
 if not exists(select 1 from ledger.members where workspace_id=w.id and id=p_actor) then raise exception '請選擇操作身份'; end if;
 if not exists(select 1 from ledger.events where id=p_event and workspace_id=w.id) then raise exception 'invalid_event'; end if;
 if p_actor<>p_from then raise exception '只有付款人可以上傳轉帳證明'; end if;
 if p_from=p_to or p_amount<=0 then raise exception 'invalid_transfer'; end if;
 if p_proof_path is null or p_proof_path !~ '^[a-f0-9]{64}/[a-f0-9-]{36}/[a-f0-9-]{36}/[a-f0-9-]{36}\.(jpg|png|webp)$'
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
   case when s.id is null then '已標記轉帳 ' else '已重新上傳轉帳證明 ' end||
   'NT$ '||p_amount||' 給'||to_name);
 update ledger.workspaces set revision=revision+1 where id=w.id;
 return jsonb_build_object('id',p_settlement,'status','awaiting_confirmation');
end $$;

create function public.transition_transfer(
 p_secret text,p_revision integer,p_actor uuid,p_settlement uuid,p_action text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare w ledger.workspaces; s ledger.settlements; recipient_name text;
begin
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception 'invalid_link'; end if;
 select * into w from ledger.workspaces where secret_hash=sha256(convert_to(p_secret,'UTF8')) for update;
 if w.id is null then raise exception 'invalid_link'; end if;
 if p_revision is distinct from w.revision then raise exception 'conflict'; end if;
 select st.* into s from ledger.settlements st join ledger.events e on e.id=st.event_id
  where st.id=p_settlement and e.workspace_id=w.id for update of st;
 if s.id is null then raise exception 'invalid_transfer'; end if;
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
 else raise exception 'invalid_action';
 end if;
 update ledger.workspaces set revision=revision+1 where id=w.id;
 return jsonb_build_object('id',s.id,'status',case when p_action='confirm' then 'confirmed' else 'disputed' end);
end $$;

create function public.get_transfer_proof_path(
 p_secret text,p_actor uuid,p_settlement uuid
) returns text language plpgsql security definer set search_path='' as $$
declare w ledger.workspaces; s ledger.settlements;
begin
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception 'invalid_link'; end if;
 select * into w from ledger.workspaces where secret_hash=sha256(convert_to(p_secret,'UTF8'));
 if w.id is null then raise exception 'invalid_link'; end if;
 select st.* into s from ledger.settlements st join ledger.events e on e.id=st.event_id
  where st.id=p_settlement and e.workspace_id=w.id;
 if s.id is null or p_actor not in (s.from_id,s.to_id)
    or s.status not in ('awaiting_confirmation','disputed')
    or s.proof_storage_path is null then raise exception 'proof_unavailable'; end if;
 return s.proof_storage_path;
end $$;

create function public.process_due_transfers() returns integer
language plpgsql security definer set search_path='' as $$
declare affected integer;
begin
 with due as (
  update ledger.settlements s set status='auto_confirmed',confirmed_at=now(),
    confirmation_method='auto',proof_storage_path=null,updated_at=now()
  where s.status='awaiting_confirmation' and s.paid_at<=now()-interval '72 hours'
  returning s.event_id,s.to_id,s.amount
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
 return affected;
end $$;

create function public.claim_proof_cleanup(p_limit integer default 100)
returns table(id uuid,object_path text) language sql security definer set search_path='' as $$
 with picked as (
  select q.id from ledger.proof_cleanup_queue q
  where q.next_attempt_at<=now() order by q.created_at
  for update skip locked limit least(greatest(p_limit,1),100)
 ), claimed as (
  update ledger.proof_cleanup_queue q set attempts=attempts+1,
    next_attempt_at=now()+interval '10 minutes'
  where q.id in(select picked.id from picked)
  returning q.id,q.object_path
 ) select claimed.id,claimed.object_path from claimed;
$$;

create function public.complete_proof_cleanup(p_ids uuid[]) returns void
language sql security definer set search_path='' as $$
 delete from ledger.proof_cleanup_queue where id=any(p_ids);
$$;
create function public.defer_proof_cleanup(p_ids uuid[]) returns void
language sql security definer set search_path='' as $$
 update ledger.proof_cleanup_queue set last_error='storage_delete_failed',
  next_attempt_at=now()+least(attempts,24)*interval '1 hour' where id=any(p_ids);
$$;
create function public.queue_proof_cleanup(p_object_path text) returns void
language plpgsql security definer set search_path='' as $$
begin
 if p_object_path is null or length(p_object_path) not between 40 and 1024 then
  raise exception 'invalid_proof';
 end if;
 insert into ledger.proof_cleanup_queue(object_path)
 values(p_object_path) on conflict(object_path) do nothing;
end $$;

-- Supabase Cron is used because the existing Vercel Hobby project cannot run
-- hourly schedules. These extensions are available on hosted Supabase; the
-- conditional keeps the same migration runnable in the local SQL test engine.
do $$
begin
 if exists(select 1 from pg_available_extensions where name='pg_net') then
  create schema if not exists extensions;
  execute 'create extension if not exists pg_net with schema extensions';
 end if;
 if exists(select 1 from pg_available_extensions where name='pg_cron') then
  execute 'create extension if not exists pg_cron with schema pg_catalog';
 end if;
end $$;

create function public.configure_transfer_confirmation_cron(
 p_app_url text,p_cron_secret text
) returns void language plpgsql security definer set search_path='' as $$
declare app_id uuid; secret_id uuid; old_job bigint;
begin
 if p_app_url !~ '^https://[a-zA-Z0-9.-]+$' then raise exception 'invalid_app_url'; end if;
 if p_cron_secret is null or length(p_cron_secret)<32 then raise exception 'invalid_cron_secret'; end if;
 select id into app_id from vault.secrets where name='xiangxiang_transfer_app_url';
 if app_id is null then
  perform vault.create_secret(p_app_url,'xiangxiang_transfer_app_url','Transfer confirmation endpoint');
 else
  perform vault.update_secret(app_id,p_app_url,'xiangxiang_transfer_app_url','Transfer confirmation endpoint');
 end if;
 select id into secret_id from vault.secrets where name='xiangxiang_transfer_cron_secret';
 if secret_id is null then
  perform vault.create_secret(p_cron_secret,'xiangxiang_transfer_cron_secret','Transfer confirmation bearer secret');
 else
  perform vault.update_secret(secret_id,p_cron_secret,'xiangxiang_transfer_cron_secret','Transfer confirmation bearer secret');
 end if;
 select jobid into old_job from cron.job where jobname='xiangxiang-transfer-confirmation';
 if old_job is not null then perform cron.unschedule(old_job); end if;
 perform cron.schedule(
  'xiangxiang-transfer-confirmation','0 * * * *',
  $job$
   select net.http_get(
    url := (select decrypted_secret from vault.decrypted_secrets where name='xiangxiang_transfer_app_url') || '/api/cron/confirm-transfers',
    headers := jsonb_build_object(
      'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='xiangxiang_transfer_cron_secret')
    ),
    timeout_milliseconds := 30000
   );
  $job$
 );
end $$;

revoke all on function public.submit_transfer_proof(text,integer,uuid,uuid,uuid,uuid,integer,uuid,text) from public,anon,authenticated;
revoke all on function public.transition_transfer(text,integer,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.get_transfer_proof_path(text,uuid,uuid) from public,anon,authenticated;
revoke all on function public.process_due_transfers() from public,anon,authenticated;
revoke all on function public.claim_proof_cleanup(integer) from public,anon,authenticated;
revoke all on function public.complete_proof_cleanup(uuid[]) from public,anon,authenticated;
revoke all on function public.defer_proof_cleanup(uuid[]) from public,anon,authenticated;
revoke all on function public.queue_proof_cleanup(text) from public,anon,authenticated;
revoke all on function public.configure_transfer_confirmation_cron(text,text) from public,anon,authenticated;
grant execute on function public.submit_transfer_proof(text,integer,uuid,uuid,uuid,uuid,integer,uuid,text) to service_role;
grant execute on function public.transition_transfer(text,integer,uuid,uuid,text) to service_role;
grant execute on function public.get_transfer_proof_path(text,uuid,uuid) to service_role;
grant execute on function public.process_due_transfers() to service_role;
grant execute on function public.claim_proof_cleanup(integer) to service_role;
grant execute on function public.complete_proof_cleanup(uuid[]) to service_role;
grant execute on function public.defer_proof_cleanup(uuid[]) to service_role;
grant execute on function public.queue_proof_cleanup(text) to service_role;
grant execute on function public.configure_transfer_confirmation_cron(text,text) to service_role;
grant execute on function public.read_book(text) to anon,authenticated;

notify pgrst, 'reload schema';
