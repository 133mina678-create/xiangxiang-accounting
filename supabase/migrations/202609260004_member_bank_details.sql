-- Optional bank details for transfer recipients. Accounts are text so leading
-- zeroes are preserved. Existing RLS and private-schema grants remain intact.
alter table ledger.members
  add column if not exists bank_code text,
  add column if not exists bank_name text,
  add column if not exists bank_account text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'ledger.members'::regclass
      and conname = 'members_bank_details_complete'
  ) then
    alter table ledger.members
      add constraint members_bank_details_complete check (
        (bank_code is null and bank_name is null and bank_account is null)
        or (
          bank_code ~ '^[0-9]{3}$'
          and length(bank_name) between 1 and 50
          and bank_account ~ '^[0-9]+$'
          and length(bank_account) between 8 and 30
        )
      );
  end if;
end $$;

update ledger.members
set bank_code = case name
      when '庫莫' then '006'
      when '厚諾' then '822'
      when '星醬' then '009'
      when '千瑾' then '700'
      when '無語' then '808'
    end,
    bank_name = case name
      when '庫莫' then '合作金庫'
      when '厚諾' then '中國信託'
      when '星醬' then '彰化銀行'
      when '千瑾' then '郵局'
      when '無語' then '玉山銀行'
    end,
    bank_account = case name
      when '庫莫' then '251899012944'
      when '厚諾' then '078540354361'
      when '星醬' then '61248603680100'
      when '千瑾' then '01410091872553'
      when '無語' then '0381979312472'
    end
where name in ('庫莫', '厚諾', '星醬', '千瑾', '無語');
