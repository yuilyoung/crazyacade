-- Apply once in the Supabase SQL Editor before deploying the updated game server.
-- Keep old match rows intact; room IDs identify lobbies, not unique matches.
begin;
alter table public.matches drop constraint if exists matches_room_id_key;
alter table public.matches add column if not exists mode text not null default 'duel';
create table if not exists public.match_participants (
  match_id uuid not null references public.matches(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  team text check (team is null or team in ('blue', 'pink')),
  outcome text not null check (outcome in ('win', 'loss', 'draw')),
  primary key (match_id, user_id)
);
alter table public.match_participants enable row level security;
drop policy if exists "match participant read" on public.match_participants;
create policy "match participant read" on public.match_participants for select using (true);

-- One RPC call records the match and all players in one database transaction.
-- Reusing a match ID is safe if a caller retries after a lost response.
create or replace function public.record_match(
  p_match_id uuid, p_room_id text, p_mode text, p_winner_id uuid,
  p_result jsonb, p_participants jsonb
) returns void language plpgsql security invoker set search_path = public as $$
begin
  insert into public.matches (id, room_id, mode, winner_id, result)
    values (p_match_id, p_room_id, p_mode, p_winner_id, p_result)
    on conflict (id) do nothing;
  insert into public.match_participants (match_id, user_id, team, outcome)
    select p_match_id, (p->>'user_id')::uuid, p->>'team', p->>'outcome'
    from jsonb_array_elements(p_participants) as p
    on conflict (match_id, user_id) do nothing;
end;
$$;
revoke all on function public.record_match(uuid, text, text, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.record_match(uuid, text, text, uuid, jsonb, jsonb) to service_role;
commit;
