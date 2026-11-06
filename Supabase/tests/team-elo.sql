-- Run on disposable PostgreSQL after the preservation fixture and Elo migration.
begin;
create temp table elo_test_ids(id uuid);
insert into elo_test_ids select ('c0000000-0000-0000-0000-' || lpad(i::text,12,'0'))::uuid from generate_series(1,8) i;
insert into auth.users(id) select id from elo_test_ids;
insert into public.profiles(id,nickname) select id,'Elo' || row_number() over(order by id)::text from elo_test_ids;

create function pg_temp.play_elo(tag integer, mode text, side_a uuid[], side_b uuid[], winner text) returns void
language plpgsql as $$
declare participants jsonb; winner_id uuid;
begin
  select coalesce(jsonb_agg(jsonb_build_object('user_id',id,'team',case when mode='team' then side else null end,
    'outcome',case when winner='draw' then 'draw' when winner=side then 'win' else 'loss' end,'score',10)), '[]'::jsonb)
    into participants from (select id,'blue' side from unnest(side_a) id union all select id,'pink' side from unnest(side_b) id) sides;
  winner_id := case when mode='duel' and winner='blue' then side_a[1] when mode='duel' and winner='pink' then side_b[1] else null end;
  perform public.record_match(('e0000000-0000-0000-0000-' || lpad(tag::text,12,'0'))::uuid,'elo-room',mode,winner_id,
    case when winner='draw' then '{"draw":true}'::jsonb when mode='team' then jsonb_build_object('winnerTeam',winner)
    else jsonb_build_object('winnerId',winner_id) end,participants);
end $$;
create function pg_temp.assert_ratings(ids uuid[], expected integer[]) returns void language plpgsql as $$
declare actual integer[];
begin
  select array_agg(rating order by array_position(ids,id)) into actual from public.profiles where id=any(ids);
  if actual is distinct from expected then raise exception 'Elo ratings mismatch: expected %, actual %',expected,actual; end if;
end $$;

do $$
declare ids uuid[]; before_retry jsonb; malformed jsonb; failure_seen boolean;
begin
  select array_agg(id order by id) into ids from elo_test_ids;
  if not exists(select 1 from public.profiles where nickname='KeptRating' and rating=1432 and wins=3 and losses=5 and draws=2 and score=900)
    or not exists(select 1 from public.matches where room_id='kept-history')
    or not exists(select 1 from public.match_participants where match_id='d0000000-0000-0000-0000-000000000002' and score=50)
  then raise exception 'migration reset existing ratings or history'; end if;

  -- Equal opponents: +16/-16; draws preserve equal ratings.
  perform pg_temp.play_elo(1,'team',ids[1:1],ids[2:2],'blue');
  perform pg_temp.assert_ratings(ids[1:2],array[1016,984]);
  select jsonb_agg(to_jsonb(p) order by id) into before_retry from public.profiles p where id=any(ids);
  -- Existing result identity still wins over altered/subset retry data.
  perform pg_temp.play_elo(1,'team',ids[1:1],array[]::uuid[],'pink');
  if before_retry is distinct from (select jsonb_agg(to_jsonb(p) order by id) from public.profiles p where id=any(ids))
    or (select count(*) from public.match_participants where match_id='e0000000-0000-0000-0000-000000000001') <> 2
  then raise exception 'retry applied Elo or participant history twice'; end if;
  update public.profiles set rating=1000 where id=any(ids);
  perform pg_temp.play_elo(2,'duel',ids[1:1],ids[2:2],'draw');
  perform pg_temp.assert_ratings(ids[1:2],array[1000,1000]);
  if not exists(select 1 from public.profiles where id=ids[1] and wins=1 and draws=1 and score=20)
  then raise exception 'draw counters or scores changed contract'; end if;

  -- Both team means, not per-player opponent estimates or sequential updates.
  update public.profiles set rating=case when id=ids[1] then 900 when id=ids[2] then 1300 else 1500 end where id=any(ids[1:4]);
  perform pg_temp.play_elo(3,'team',ids[1:2],ids[3:4],'blue');
  perform pg_temp.assert_ratings(ids[1:4],array[929,1329,1471,1471]);
  update public.profiles set rating=case when id=ids[1] then 1200 else 800 end where id=any(ids[1:2]);
  perform pg_temp.play_elo(4,'duel',ids[1:1],ids[2:2],'blue');
  perform pg_temp.assert_ratings(ids[1:2],array[1203,797]);
  update public.profiles set rating=case when id=ids[1] then 800 else 1200 end where id=any(ids[1:2]);
  perform pg_temp.play_elo(5,'duel',ids[1:1],ids[2:2],'draw');
  perform pg_temp.assert_ratings(ids[1:2],array[813,1187]);

  -- Fractional means remain fractional until the final signed rounding.
  update public.profiles set rating=case when id=ids[4] then 1001 when id=any(ids[1:3]) then 1000 else 1011 end where id=any(ids);
  perform pg_temp.play_elo(6,'team',ids[1:4],ids[5:8],'draw');
  perform pg_temp.assert_ratings(ids,array[1000,1000,1000,1001,1011,1011,1011,1011]);

  -- Zero/int32 bounds use wide intermediate arithmetic; extreme gaps are clamped.
  update public.profiles set rating=0 where id=any(ids[1:2]);
  perform pg_temp.play_elo(7,'duel',ids[1:1],ids[2:2],'pink');
  perform pg_temp.assert_ratings(ids[1:2],array[0,16]);
  update public.profiles set rating=2147483647 where id=any(ids[1:2]);
  perform pg_temp.play_elo(8,'duel',ids[1:1],ids[2:2],'blue');
  perform pg_temp.assert_ratings(ids[1:2],array[2147483647,2147483631]);
  update public.profiles set rating=case when id=ids[1] then 0 else 2147483647 end where id=any(ids[1:2]);
  perform pg_temp.play_elo(9,'duel',ids[1:1],ids[2:2],'blue');
  perform pg_temp.assert_ratings(ids[1:2],array[32,2147483615]);

  -- Partial legacy history remains accepted, but has no opponent-strength estimate.
  update public.profiles set rating=1234 where id=ids[1];
  perform pg_temp.play_elo(10,'duel',ids[1:1],array[]::uuid[],'draw');
  perform pg_temp.play_elo(11,'team',ids[1:1],array[]::uuid[],'blue');
  perform pg_temp.assert_ratings(ids[1:1],array[1234]);
  perform pg_temp.play_elo(12,'team',array[]::uuid[],array[]::uuid[],'draw');

  -- Accepted matches use the latest stored values, independent of payload order.
  update public.profiles set rating=1000 where id=any(ids[1:2]);
  perform pg_temp.play_elo(13,'duel',ids[1:1],ids[2:2],'blue');
  perform pg_temp.play_elo(14,'duel',ids[2:2],ids[1:1],'blue');
  perform pg_temp.assert_ratings(ids[1:2],array[999,1001]);

  -- Failures roll back match, history and every profile update.
  select jsonb_agg(to_jsonb(p) order by id) into before_retry from public.profiles p where id=any(ids);
  foreach malformed in array array[
    jsonb_build_array(jsonb_build_object('user_id',ids[1],'team','blue','outcome','win'),jsonb_build_object('user_id',ids[1],'team','pink','outcome','loss')),
    jsonb_build_array(jsonb_build_object('user_id',ids[1],'team','green','outcome','win')),
    jsonb_build_array(jsonb_build_object('user_id',ids[1],'team','blue','outcome','unknown')),
    jsonb_build_array(jsonb_build_object('user_id',ids[1],'team','blue','outcome','win','score',-1)),
    jsonb_build_array(jsonb_build_object('user_id',ids[1],'team','blue','outcome','win','score',1000001)),
    jsonb_build_array(jsonb_build_object('user_id',ids[1],'team','blue','outcome','win'),jsonb_build_object('user_id',ids[2],'team','pink','outcome','win')),
    jsonb_build_array(jsonb_build_object('user_id',ids[1],'team','blue','outcome','win'),jsonb_build_object('user_id',ids[2],'team','blue','outcome','loss')),
    jsonb_build_array(jsonb_build_object('user_id',ids[1],'team','blue','outcome','win'),jsonb_build_object('user_id','c0000000-0000-0000-0000-000000000099','team','pink','outcome','loss'))
  ] loop
    failure_seen:=false;
    begin
      perform public.record_match('e0000000-0000-0000-0000-000000000099','invalid','team',null,'{}',malformed);
    exception when others then failure_seen:=true; end;
    if not failure_seen or exists(select 1 from public.matches where id='e0000000-0000-0000-0000-000000000099') then raise exception 'invalid match was accepted or partially committed'; end if;
  end loop;
  if before_retry is distinct from (select jsonb_agg(to_jsonb(p) order by id) from public.profiles p where id=any(ids)) then raise exception 'invalid result changed profiles'; end if;
  failure_seen:=false;
  begin
    perform pg_temp.play_elo(98,'duel',ids[1:2],ids[3:3],'blue');
  exception when others then failure_seen:=true; end;
  if not failure_seen then raise exception 'three-player duel accepted'; end if;
  if has_function_privilege('authenticated','public.record_match(uuid,text,text,uuid,jsonb,jsonb)','execute')
    or has_function_privilege('anon','public.record_match(uuid,text,text,uuid,jsonb,jsonb)','execute')
    or has_column_privilege('authenticated','public.profiles','rating','update')
  then raise exception 'rating privileges widened'; end if;
end $$;
rollback;
