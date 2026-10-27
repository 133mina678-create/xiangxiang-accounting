-- Supplemental transfers settle an independent supplemental snapshot. They
-- must not be applied a second time to the original event balance.
create or replace function ledger.balance(p_event uuid,p_member uuid)
returns bigint language sql stable set search_path='' as $$
 select coalesce((
   select sum(amount)
   from ledger.expenses
   where event_id=p_event and payer_id=p_member and deleted_at is null
  ),0)
 - coalesce((
   select sum(s.share_amount)
   from ledger.expense_splits s
   join ledger.expenses e on e.id=s.expense_id
   where e.event_id=p_event and s.member_id=p_member and e.deleted_at is null
  ),0)
 + coalesce((
   select sum(s.amount)
   from ledger.settlements s
   left join ledger.settlement_snapshots ss on ss.id=s.snapshot_id
   where s.event_id=p_event and s.from_id=p_member
     and coalesce(ss.snapshot_kind,'main')='main'
  ),0)
 - coalesce((
   select sum(s.amount)
   from ledger.settlements s
   left join ledger.settlement_snapshots ss on ss.id=s.snapshot_id
   where s.event_id=p_event and s.to_id=p_member
     and coalesce(ss.snapshot_kind,'main')='main'
  ),0);
$$;

revoke all on function ledger.balance(uuid,uuid) from public,anon,authenticated;

notify pgrst, 'reload schema';
