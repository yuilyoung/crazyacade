-- Run after all migrations against a disposable database using a superuser.
begin;
insert into auth.users(id) values ('b0000000-0000-4000-8000-000000000001'), ('b0000000-0000-4000-8000-000000000002');
insert into public.profiles(id,nickname,rating,wins,score,updated_at) values
  ('b0000000-0000-4000-8000-000000000001','MemberA',1234,7,800,'2020-01-01'),
  ('b0000000-0000-4000-8000-000000000002','MemberB',1000,0,0,'2020-01-01');
insert into public.payment_records(id,user_id,description,amount_minor,currency,status,provider,provider_payment_id) values
  ('b1000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','Cosmetic pack',500,'USD','paid','fixture','provider-a'),
  ('b1000000-0000-4000-8000-000000000002','b0000000-0000-4000-8000-000000000002','Other pack',1000,'KRW','refunded','fixture','provider-b');
insert into public.matches(id,room_id,mode,result) values
  ('b2000000-0000-4000-8000-000000000001','member-private-a','duel','{}'),
  ('b2000000-0000-4000-8000-000000000002','member-private-b','duel','{}');
insert into public.match_participants(match_id,user_id,outcome,score) values
  ('b2000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','draw',10),
  ('b2000000-0000-4000-8000-000000000002','b0000000-0000-4000-8000-000000000002','draw',20);
do $$ begin
  if has_table_privilege('anon','public.payment_records','select') then raise exception 'anonymous payment access'; end if;
  if has_column_privilege('authenticated','public.payment_records','provider_payment_id','select') then raise exception 'provider reference exposed'; end if;
  if has_table_privilege('authenticated','public.payment_records','insert') or has_table_privilege('authenticated','public.payment_records','update') or has_table_privilege('authenticated','public.payment_records','delete') then raise exception 'client can change payments'; end if;
  if not has_table_privilege('service_role','public.payment_records','insert') then raise exception 'server cannot record payment metadata'; end if;
  if has_column_privilege('authenticated','public.profiles','score','update') then raise exception 'client can award score'; end if;
end $$;
-- A local stub works with the lightweight auth schema in test-rankings-db.py.
-- This transaction rolls back the replacement on a real Supabase test database.
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
select set_config('request.jwt.claim.sub','b0000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"is_anonymous":false}',true);
set local role authenticated;
do $$ begin
  if (select count(id) from public.payment_records) <> 1 then raise exception 'member can see another account payment'; end if;
  if (select amount_minor from public.payment_records) <> 500 then raise exception 'wrong member payment'; end if;
  if (select count(*) from public.matches) <> 1 then raise exception 'member can see another account match'; end if;
  if (select count(*) from public.match_participants) <> 1 then raise exception 'member can see another account participation'; end if;
end $$;
update public.profiles set nickname='EditedName' where id='b0000000-0000-4000-8000-000000000001';
select set_config('request.jwt.claims','{"is_anonymous":true}',true);
do $$ begin
  if (select count(id) from public.payment_records) <> 0 then raise exception 'anonymous auth user can read member payments'; end if;
  if (select count(*) from public.matches) <> 0 then raise exception 'anonymous auth user can read member matches'; end if;
  if (select count(*) from public.match_participants) <> 0 then raise exception 'anonymous auth user can read member participation'; end if;
end $$;
reset role;
do $$ begin
  if not exists (select 1 from public.profiles where id='b0000000-0000-4000-8000-000000000001' and nickname='EditedName' and rating=1234 and wins=7 and score=800 and updated_at>'2020-01-01') then raise exception 'nickname edit lost stats or update timestamp'; end if;
end $$;
rollback;
