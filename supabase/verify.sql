-- Read-only checks. Run in SQL Editor; every passed column should be true.
-- Does not display workspace identifiers, book secrets or user data.
select '8 internal tables exist with RLS' as check_name,
 (select count(*)=8 and bool_and(c.relrowsecurity)
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
select 'internal tables are not in Realtime publications',
 not exists(select 1 from pg_publication_tables where schemaname='ledger');
