-- Constraint triggers run when the outer transaction commits. At that point the
-- public RPC's SECURITY DEFINER context has already ended, so the trigger must
-- carry its own narrowly scoped definer context. The helper remains private:
-- anon/authenticated still have no ledger schema or table access.
alter function ledger.check_split_total() security definer;
alter function ledger.check_split_total() set search_path = '';

revoke all on function ledger.check_split_total() from public, anon, authenticated;

