-- Additive hardening: preserves all existing books, members and expenses.
revoke all on schema ledger from public, anon, authenticated;
revoke all on all tables in schema ledger from public, anon, authenticated;
revoke all on all sequences in schema ledger from public, anon, authenticated;
revoke all on all functions in schema ledger from public, anon, authenticated;

-- Applies to future objects created by the migration owner in this schema.
alter default privileges in schema ledger revoke all on tables from public, anon, authenticated;
alter default privileges in schema ledger revoke all on sequences from public, anon, authenticated;
alter default privileges in schema ledger revoke execute on functions from public, anon, authenticated;

-- The only public entry points validate the secret link on every invocation.
grant usage on schema public to anon, authenticated;
revoke all on function public.read_book(text) from public;
revoke all on function public.change_book(text,integer,uuid,text,jsonb) from public;
grant execute on function public.read_book(text) to anon, authenticated;
grant execute on function public.change_book(text,integer,uuid,text,jsonb) to anon, authenticated;
notify pgrst, 'reload schema';
