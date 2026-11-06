-- Historical fixed-point migration regression: run before 20261106_team_elo.sql.
-- Current rating behavior is verified afterward by team-elo.sql.
-- The test rolls back data. auth.users(id), auth.uid() and Supabase roles must exist.
begin;
insert into auth.users(id) values ('a0000000-0000-0000-0000-000000000001'), ('a0000000-0000-0000-0000-000000000002');
insert into public.profiles(id,nickname) values ('a0000000-0000-0000-0000-000000000001','RankA'), ('a0000000-0000-0000-0000-000000000002','RankB');
select public.record_match('b0000000-0000-0000-0000-000000000001', 'same-room', 'team', null,
  '{"winnerTeam":"blue"}', '[{"user_id":"a0000000-0000-0000-0000-000000000001","team":"blue","outcome":"win","score":250},{"user_id":"a0000000-0000-0000-0000-000000000002","team":"pink","outcome":"loss","score":30}]');
-- An identical match ID must be idempotent, including aggregate updates.
select public.record_match('b0000000-0000-0000-0000-000000000001', 'same-room', 'team', null,
  '{"winnerTeam":"blue"}', '[{"user_id":"a0000000-0000-0000-0000-000000000001","team":"blue","outcome":"win","score":250}]');
do $$ begin
  if not exists(select 1 from public.profiles where nickname='RankA' and rating=1025 and wins=1 and losses=0 and score=250) then raise exception 'win/idempotence failed'; end if;
  if not exists(select 1 from public.profiles where nickname='RankB' and rating=985 and losses=1 and score=30) then raise exception 'loss failed'; end if;
  if (select count(*) from public.match_participants where match_id='b0000000-0000-0000-0000-000000000001') <> 2 then raise exception 'participants missing'; end if;
  if has_function_privilege('authenticated','public.record_match(uuid,text,text,uuid,jsonb,jsonb)','execute') then raise exception 'client can award results'; end if;
  if has_column_privilege('authenticated','public.profiles','rating','update') then raise exception 'client can edit rating'; end if;
  if has_column_privilege('authenticated','public.profiles','score','update') then raise exception 'client can edit score'; end if;
  if not has_column_privilege('authenticated','public.profiles','nickname','update') then raise exception 'nickname update unexpectedly denied'; end if;
end $$;
-- Reusing a room ID is a different match and a draw increments only draw counter.
select public.record_match('b0000000-0000-0000-0000-000000000002', 'same-room', 'duel', null,
  '{"draw":true}', '[{"user_id":"a0000000-0000-0000-0000-000000000001","outcome":"draw","score":50}]');
do $$ begin
  if not exists(select 1 from public.profiles where nickname='RankA' and rating=1030 and wins=1 and draws=1 and score=300) then raise exception 'draw/room reuse failed'; end if;
  begin
    perform public.record_match('b0000000-0000-0000-0000-000000000003','invalid','team',null,'{}',
      '[{"user_id":"a0000000-0000-0000-0000-000000000001","team":"blue","outcome":"win","score":100},{"user_id":"a0000000-0000-0000-0000-000000000099","team":"pink","outcome":"loss","score":20}]');
    raise exception 'missing profile unexpectedly accepted';
  exception when foreign_key_violation then null; end;
  if exists(select 1 from public.matches where id='b0000000-0000-0000-0000-000000000003') then raise exception 'failed match was partially committed'; end if;
  if (select score from public.profiles where nickname='RankA') <> 300 then raise exception 'failed transaction changed score'; end if;
end $$;
rollback;
