-- Run once in Supabase SQL Editor AFTER migrations. Each execution creates a NEW book.
-- Returns a new high-entropy secret path. Save it privately; plaintext is not stored.
begin;
drop table if exists pg_temp.new_book_link;
create temporary table new_book_link(path text) on commit preserve rows;
do $$
declare secret text:=encode(sha256(convert_to(gen_random_uuid()::text||gen_random_uuid()::text,'UTF8')),'hex'); w uuid; ids uuid[]; ev uuid:=gen_random_uuid(); i integer; names text[]:=array['厚諾','星醬','無語','庫莫','千瑾','兔子草']; icons text[]:=array['🔥','⭐','💬','🦑','🥒','🐰']; colors text[]:=array['#b65032','#8d6d13','#526d7e','#806198','#287b70','#af607e']; bank_codes text[]:=array['822','009','808','006','700',null]; bank_names text[]:=array['中國信託','彰化銀行','玉山銀行','合作金庫','郵局',null]; bank_accounts text[]:=array['078540354361','61248603680100','0381979312472','251899012944','01410091872553',null];
begin
 insert into ledger.workspaces(secret_hash) values(sha256(convert_to(secret,'UTF8'))) returning id into w;
 for i in 1..6 loop
  ids[i]:=gen_random_uuid();
  insert into ledger.members(id,workspace_id,name,icon,color,position,bank_code,bank_name,bank_account) values(ids[i],w,names[i],icons[i],colors[i],i,bank_codes[i],bank_names[i],bank_accounts[i]);
 end loop;
 perform public.change_book(secret,0,ids[1],'event.save',jsonb_build_object('id',ev,'name','台北三天兩夜','start_date','2026-09-25','end_date','2026-09-27','note','一起吃好吃的，記得把帳算清楚。','members',to_jsonb(ids)));
 perform public.change_book(secret,1,ids[1],'expense.save',jsonb_build_object('event_id',ev,'date','2026-09-25','amount',1800,'payer_id',ids[1],'category','food','note','鼎王晚餐','mode','equal','splits',(select jsonb_agg(jsonb_build_object('member_id',id)) from unnest(ids) id)));
 perform public.change_book(secret,2,ids[4],'expense.save',jsonb_build_object('event_id',ev,'date','2026-09-25','amount',480,'payer_id',ids[4],'category','transport','note','Uber','mode','equal','splits',(select jsonb_agg(jsonb_build_object('member_id',id)) from unnest(array[ids[1],ids[2],ids[4],ids[6]]) id)));
 perform public.change_book(secret,3,ids[2],'expense.save',jsonb_build_object('event_id',ev,'date','2026-09-26','amount',4200,'payer_id',ids[2],'category','stay','note','Airbnb','mode','equal','splits',(select jsonb_agg(jsonb_build_object('member_id',id)) from unnest(ids) id)));
 perform public.change_book(secret,4,ids[6],'expense.save',jsonb_build_object('event_id',ev,'date','2026-09-26','amount',310,'payer_id',ids[6],'category','drink','note','飲料','mode','custom','splits',jsonb_build_array(jsonb_build_object('member_id',ids[2],'share_amount',100),jsonb_build_object('member_id',ids[3],'share_amount',100),jsonb_build_object('member_id',ids[6],'share_amount',110))));
 insert into new_book_link values('/book/'||secret);
end $$;
commit;
-- Keep the result as the LAST statement so SQL Editor shows the link.
select path as secret_book_path from new_book_link;
