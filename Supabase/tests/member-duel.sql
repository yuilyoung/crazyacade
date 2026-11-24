-- Exercise the API roles used by the game from first join through saved results.
begin;
insert into auth.users(id) values
  ('b3000000-0000-4000-8000-000000000001'), ('b3000000-0000-4000-8000-000000000002');

set local role service_role;
insert into public.profiles(id,nickname) values
  ('b3000000-0000-4000-8000-000000000001','DuelWinner'),
  ('b3000000-0000-4000-8000-000000000002','DuelRunnerUp')
  on conflict (id) do nothing;
update public.profiles set loadout='{"characterId":"momo","skinId":"cat","orbSkinId":"star"}'
  where id='b3000000-0000-4000-8000-000000000001';
select public.record_match('b4000000-0000-4000-8000-000000000001','member-duel','duel',
  'b3000000-0000-4000-8000-000000000001','{"winnerId":"b3000000-0000-4000-8000-000000000001"}',
  '[{"user_id":"b3000000-0000-4000-8000-000000000001","outcome":"win","score":200},
    {"user_id":"b3000000-0000-4000-8000-000000000002","outcome":"loss","score":10}]');
do $$ begin
  if (select loadout->>'skinId' from public.profiles where id='b3000000-0000-4000-8000-000000000001') is distinct from 'cat'
    or (select loadout from public.profiles where id='b3000000-0000-4000-8000-000000000002') is not null
  then raise exception 'member outfits were not stored separately'; end if;
  if has_column_privilege('anon','public.profiles','loadout','select,update')
    or has_column_privilege('authenticated','public.profiles','loadout','select,update')
  then raise exception 'private loadouts exposed via the public Data API'; end if;
  if (select count(*) from public.match_participants p join public.matches m on m.id=p.match_id
      join public.profiles member on member.id=p.user_id
      where m.room_id='member-duel' and ((member.nickname='DuelWinner' and p.outcome='win')
        or (member.nickname='DuelRunnerUp' and p.outcome='loss'))) <> 2
  then raise exception 'missing member duel history'; end if;
end $$;
reset role;

set local role anon;
do $$ begin
  if not exists(select from public.profiles where nickname='DuelWinner' and rating=1016 and score=200 and wins=1 and losses=0 and draws=0)
    or not exists(select from public.profiles where nickname='DuelRunnerUp' and rating=984 and score=10 and wins=0 and losses=1 and draws=0)
  then raise exception 'member duel not reflected in public leaderboard'; end if;
  if has_column_privilege(current_user,'public.profiles','id','select')
    or has_column_privilege(current_user,'public.profiles','updated_at','select')
  then raise exception 'anonymous leaderboard role can read non-leaderboard fields'; end if;
end $$;
rollback;
