-- Apply after 20261102_team_match_history.sql, before deploying score/rank server code.
-- Existing matches, profile ratings and participant history are preserved.
begin;
-- Only initialize newly introduced counters. Existing totals may include imported
-- or archived matches and must not be replaced by the remaining history on rerun.
do $$
declare
  new_wins boolean; new_losses boolean; new_draws boolean; new_score boolean;
begin
  select not exists(select 1 from pg_attribute where attrelid='public.profiles'::regclass and attname='wins' and not attisdropped),
         not exists(select 1 from pg_attribute where attrelid='public.profiles'::regclass and attname='losses' and not attisdropped),
         not exists(select 1 from pg_attribute where attrelid='public.profiles'::regclass and attname='draws' and not attisdropped),
         not exists(select 1 from pg_attribute where attrelid='public.profiles'::regclass and attname='score' and not attisdropped)
    into new_wins,new_losses,new_draws,new_score;
  alter table public.profiles
    add column if not exists wins integer not null default 0 check (wins >= 0),
    add column if not exists losses integer not null default 0 check (losses >= 0),
    add column if not exists draws integer not null default 0 check (draws >= 0),
    add column if not exists score bigint not null default 0 check (score >= 0);
  alter table public.match_participants
    add column if not exists score integer not null default 0 check (score between 0 and 1000000);
  if new_wins or new_losses or new_draws or new_score then
    update public.profiles p set
      wins = case when new_wins then s.wins else p.wins end,
      losses = case when new_losses then s.losses else p.losses end,
      draws = case when new_draws then s.draws else p.draws end,
      score = case when new_score then s.score else p.score end
    from (
      select user_id,
        count(*) filter (where outcome = 'win') as wins,
        count(*) filter (where outcome = 'loss') as losses,
        count(*) filter (where outcome = 'draw') as draws,
        sum(score) as score
      from public.match_participants group by user_id
    ) s where p.id = s.user_id;
  end if;
end;
$$;

-- RLS protects which profile can be edited; column privileges protect its rankings.
-- An authenticated client may change only its nickname, never rating or statistics.
revoke update on public.profiles from anon, authenticated;
revoke update (id, nickname, rating, created_at, updated_at, wins, losses, draws, score)
  on public.profiles from anon, authenticated;
grant update (nickname) on public.profiles to authenticated;

create or replace function public.record_match(
  p_match_id uuid, p_room_id text, p_mode text, p_winner_id uuid,
  p_result jsonb, p_participants jsonb
) returns void language plpgsql security invoker set search_path = public as $$
declare inserted_id uuid;
begin
  if p_mode not in ('team', 'duel') then raise exception 'Invalid match mode'; end if;
  if p_participants is null or jsonb_typeof(p_participants) <> 'array' or jsonb_array_length(p_participants) > 8 then
    raise exception 'Invalid participants';
  end if;
  insert into public.matches (id, room_id, mode, winner_id, result)
    values (p_match_id, p_room_id, p_mode, p_winner_id, p_result)
    on conflict (id) do nothing returning id into inserted_id;
  -- Duplicate/retried records cannot increment score or rating twice.
  if inserted_id is null then return; end if;

  with recorded as (
    insert into public.match_participants (match_id, user_id, team, outcome, score)
      select p_match_id, (p->>'user_id')::uuid, p->>'team', p->>'outcome', coalesce((p->>'score')::integer, 0)
      from jsonb_array_elements(p_participants) as p
      returning user_id, outcome, score
  )
  update public.profiles profile set
    rating = greatest(0, profile.rating + case recorded.outcome when 'win' then 25 when 'loss' then -15 else 5 end),
    wins = profile.wins + case when recorded.outcome = 'win' then 1 else 0 end,
    losses = profile.losses + case when recorded.outcome = 'loss' then 1 else 0 end,
    draws = profile.draws + case when recorded.outcome = 'draw' then 1 else 0 end,
    score = profile.score + recorded.score,
    updated_at = now()
  from recorded where profile.id = recorded.user_id;
end;
$$;
revoke all on function public.record_match(uuid, text, text, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.record_match(uuid, text, text, uuid, jsonb, jsonb) to service_role;
create index if not exists profiles_leaderboard_idx on public.profiles (rating desc, score desc, nickname);
commit;
