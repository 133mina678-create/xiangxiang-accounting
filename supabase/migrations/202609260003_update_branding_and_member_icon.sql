-- Keep existing books aligned with the current product copy and member identity.
-- Exact-value predicates make the migration safe to rerun and avoid touching
-- user-authored content that happens to mention the same member.
update ledger.members
set icon = '🥒'
where name = '千瑾'
  and icon = '💎';

update ledger.events
set note = '一起吃好吃的，記得把帳算清楚。'
where note = '一起吃好吃的，剩下的交給' || chr(39321) || chr(39321) || '。';
