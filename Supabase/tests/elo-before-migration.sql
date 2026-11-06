-- Disposable-database fixture: prove the new migration leaves existing ratings/history intact.
insert into auth.users(id) values ('d0000000-0000-0000-0000-000000000001');
insert into public.profiles(id,nickname,rating,wins,losses,draws,score)
  values ('d0000000-0000-0000-0000-000000000001','KeptRating',1432,3,5,2,900);
insert into public.matches(id,room_id,mode,result)
  values ('d0000000-0000-0000-0000-000000000002','kept-history','duel','{"draw":true}');
insert into public.match_participants(match_id,user_id,outcome,score)
  values ('d0000000-0000-0000-0000-000000000002','d0000000-0000-0000-0000-000000000001','draw',50);
