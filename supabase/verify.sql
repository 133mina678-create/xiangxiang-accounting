-- Read-only checks. Run in SQL Editor; every passed column should be true.
-- Does not display workspace identifiers, book secrets or user data.
select '9 internal tables exist with RLS' as check_name,
 (select count(*)=9 and bool_and(c.relrowsecurity)
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='ledger' and c.relkind='r') as passed
union all
select 'anon cannot access internal schema',
 not coalesce(has_schema_privilege('anon',to_regnamespace('ledger'),'USAGE'),true)
union all
select 'authenticated cannot access internal schema',
 not coalesce(has_schema_privilege('authenticated',to_regnamespace('ledger'),'USAGE'),true)
union all
select 'anon can call secret-protected read RPC',
 coalesce(has_function_privilege('anon',to_regprocedure('public.read_book(text)'),'EXECUTE'),false)
union all
select 'anon can call secret-protected write RPC',
 coalesce(has_function_privilege('anon',to_regprocedure('public.change_book(text,integer,uuid,text,jsonb)'),'EXECUTE'),false)
union all
select 'both RPCs have fixed search_path and definer security',
 (select count(*)=2 and bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
  from pg_proc p where p.oid in (to_regprocedure('public.read_book(text)'),to_regprocedure('public.change_book(text,integer,uuid,text,jsonb)')))
union all
select 'deferred split trigger is private and definer-secured',
 (select p.prosecdef
    and p.proconfig @> array['search_path=""']
    and not has_function_privilege('anon',p.oid,'EXECUTE')
    and not has_function_privilege('authenticated',p.oid,'EXECUTE')
  from pg_proc p where p.oid=to_regprocedure('ledger.check_split_total()'))
union all
select 'internal tables are not in Realtime publications',
 not exists(select 1 from pg_publication_tables where schemaname='ledger')
union all
select 'transfer proof RPCs are server-only',
 (select count(*)=8 and bool_and(
    has_function_privilege('service_role',p.oid,'EXECUTE')
    and not has_function_privilege('anon',p.oid,'EXECUTE')
    and not has_function_privilege('authenticated',p.oid,'EXECUTE')
  ) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in (
    'submit_transfer_proof','transition_transfer','get_transfer_proof_path',
    'process_due_transfers','claim_proof_cleanup','complete_proof_cleanup',
    'defer_proof_cleanup','queue_proof_cleanup'
  ))
union all
select 'proof bucket is private and image-only',
 (select not public and file_size_limit=2097152
   and allowed_mime_types @> array['image/jpeg','image/png','image/webp']
   and not (allowed_mime_types @> array['application/pdf'])
  from storage.buckets where id='transfer-proofs')
union all
select 'proof cleanup trigger is installed and private',
 exists(select 1 from pg_trigger where tgname='settlement_proof_cleanup' and not tgisinternal)
 and not has_function_privilege('anon',to_regprocedure('ledger.queue_old_transfer_proof()'),'EXECUTE')
 and not has_function_privilege('authenticated',to_regprocedure('ledger.queue_old_transfer_proof()'),'EXECUTE');
