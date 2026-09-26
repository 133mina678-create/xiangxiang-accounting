-- Add the bank details supplied for 兔子草. Account values remain text so the
-- leading zero is preserved. This does not change RLS or expose table access.
update ledger.members
set bank_code = '700',
    bank_name = '郵局',
    bank_account = '00514060075399'
where name = '兔子草';
