-- Apply after 20261102_rankings.sql. Existing ratings, statistics and history are unchanged.
-- Elo uses the latest persisted ratings immediately before this result is applied;
-- delayed result delivery can therefore affect the ordering of later updates.
begin;
create or replace function public.record_match(
  p_match_id uuid, p_room_id text, p_mode text, p_winner_id uuid,
  p_result jsonb, p_participants jsonb
) returns void language plpgsql security invoker set search_path = public as $$
declare
  inserted_id uuid; first_duelist uuid;
  participant_count integer; locked_count integer;
  outcome_a text; outcome_b text; outcomes_a integer; outcomes_b integer;
  mean_a numeric; mean_b numeric; expected_a numeric; actual_a numeric;
  delta_a integer := 0;
begin
  if p_mode is null or p_mode not in ('team','duel') then raise exception 'Invalid match mode'; end if;
  if p_participants is null or jsonb_typeof(p_participants) <> 'array' or jsonb_array_length(p_participants) > 8 then
    raise exception 'Invalid participants';
  end if;
  -- Preserve the existing retry contract, including a historical subset payload.
  if exists(select 1 from public.matches where id=p_match_id) then return; end if;
  participant_count := jsonb_array_length(p_participants);
  if p_mode='duel' and participant_count>2 then raise exception 'Invalid duel participants'; end if;
  if exists(select 1 from jsonb_array_elements(p_participants) item where jsonb_typeof(item)<>'object') then
    raise exception 'Invalid participants';
  end if;
  if exists(select 1 from jsonb_to_recordset(p_participants) as p(user_id uuid, team text, outcome text, score integer)
    where user_id is null or outcome is null or outcome not in ('win','loss','draw')
      or coalesce(score,0) not between 0 and 1000000
      or (p_mode='team' and (team is null or team not in ('blue','pink')))
      or (p_mode='duel' and team is not null))
    or participant_count<>(select count(distinct user_id) from jsonb_to_recordset(p_participants) as p(user_id uuid))
  then raise exception 'Invalid participants or outcomes' using errcode='23514'; end if;
  if p_winner_id is not null and not exists(
    select 1 from jsonb_to_recordset(p_participants) as p(user_id uuid) where user_id=p_winner_id)
  then raise exception 'Winner must be a participant' using errcode='23514'; end if;

  if p_mode='duel' then
    select user_id into first_duelist from jsonb_to_recordset(p_participants) as p(user_id uuid) order by user_id limit 1;
  end if;
  select min(outcome) filter(where side_a), min(outcome) filter(where not side_a),
         count(distinct outcome) filter(where side_a), count(distinct outcome) filter(where not side_a)
    into outcome_a,outcome_b,outcomes_a,outcomes_b
    from (select outcome,case when p_mode='team' then team='blue' else user_id=first_duelist end as side_a
      from jsonb_to_recordset(p_participants) as p(user_id uuid,team text,outcome text)) sides;
  if outcomes_a>1 or outcomes_b>1 or (outcome_a is not null and outcome_b is not null and not (
    (outcome_a='win' and outcome_b='loss') or (outcome_a='loss' and outcome_b='win') or (outcome_a='draw' and outcome_b='draw')))
  then raise exception 'Inconsistent opposing outcomes' using errcode='23514'; end if;

  -- Lock the entire roster in UUID order BEFORE matches.winner_id or participant
  -- foreign-key inserts acquire key-share locks. This avoids lock-upgrade cycles
  -- between overlapping matches and serializes their pre-application snapshots.
  perform profile.id from public.profiles profile
    join jsonb_to_recordset(p_participants) as p(user_id uuid) on p.user_id=profile.id
    order by profile.id for update of profile;
  get diagnostics locked_count = row_count;
  if locked_count<>participant_count then raise exception 'Missing participant profile' using errcode='23503'; end if;

  insert into public.matches(id,room_id,mode,winner_id,result)
    values(p_match_id,p_room_id,p_mode,p_winner_id,p_result)
    on conflict(id) do nothing returning id into inserted_id;
  -- Another transaction may have committed this identity while we waited for rows.
  if inserted_id is null then return; end if;

  select avg(rating) filter(where side_a), avg(rating) filter(where not side_a)
    into mean_a,mean_b
    from (select profile.rating::numeric rating,
      case when p_mode='team' then p.team='blue' else p.user_id=first_duelist end as side_a
      from public.profiles profile join jsonb_to_recordset(p_participants) as p(user_id uuid,team text)
        on p.user_id=profile.id) sides;
  -- Partial legacy histories still count statistics but cannot invent an opponent.
  if mean_a is not null and mean_b is not null then
    expected_a := 1 / (1 + power(10::numeric,least(800::numeric,greatest(-800::numeric,mean_b-mean_a))/400));
    actual_a := case outcome_a when 'win' then 1 when 'draw' then 0.5 else 0 end;
    -- PostgreSQL numeric round ties away from zero, matching signed JS magnitude rounding.
    -- Derive the other side by exact negation, never by a second rounding calculation.
    delta_a := round(32 * (actual_a-expected_a))::integer;
  end if;
  with recorded as (
    insert into public.match_participants(match_id,user_id,team,outcome,score)
      select p_match_id,user_id,team,outcome,coalesce(score,0)
      from jsonb_to_recordset(p_participants) as p(user_id uuid,team text,outcome text,score integer)
      returning user_id,team,outcome,score
  )
  update public.profiles profile set
    -- Bounds can break zero-sum at the edges; bigint prevents int32 addition overflow.
    rating = least(2147483647::bigint,greatest(0::bigint,profile.rating::bigint +
      case when (p_mode='team' and recorded.team='blue') or (p_mode='duel' and recorded.user_id=first_duelist)
        then delta_a else -delta_a end))::integer,
    wins=profile.wins+case when recorded.outcome='win' then 1 else 0 end,
    losses=profile.losses+case when recorded.outcome='loss' then 1 else 0 end,
    draws=profile.draws+case when recorded.outcome='draw' then 1 else 0 end,
    score=profile.score+recorded.score,
    updated_at=now()
  from recorded where profile.id=recorded.user_id;
end;
$$;
revoke all on function public.record_match(uuid,text,text,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.record_match(uuid,text,text,uuid,jsonb,jsonb) to service_role;
commit;
