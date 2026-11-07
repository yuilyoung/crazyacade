-- Apply after 20261106_team_elo.sql. Authentication remains in Supabase auth.users;
-- profiles already holds the member's nickname and server-awarded statistics.
begin;

create or replace function public.touch_profile_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists profile_updated_at on public.profiles;
create trigger profile_updated_at before update of nickname on public.profiles
  for each row execute function public.touch_profile_updated_at();
revoke all on function public.touch_profile_updated_at() from public, anon, authenticated;

-- Metadata only. A future verified payment-provider webhook may populate this
-- table using the server role. There is no checkout or client payment write API.
create table if not exists public.payment_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  description text not null check (char_length(description) between 1 and 160),
  amount_minor bigint not null check (amount_minor between 0 and 9007199254740991),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null check (status in ('pending','paid','failed','cancelled','refunded')),
  provider text check (provider is null or char_length(provider) between 1 and 64),
  provider_payment_id text check (provider_payment_id is null or char_length(provider_payment_id) between 1 and 200),
  created_at timestamptz not null default now(),
  unique (provider, provider_payment_id)
);
create index if not exists payment_records_user_history_idx on public.payment_records (user_id, created_at desc, id desc);
create index if not exists match_participants_user_idx on public.match_participants (user_id, match_id);

alter table public.payment_records enable row level security;
drop policy if exists "member payment history" on public.payment_records;
create policy "member payment history" on public.payment_records
  for select to authenticated using (auth.uid() = user_id and not coalesce((auth.jwt()->>'is_anonymous')::boolean,false));
revoke all on public.payment_records from public, anon, authenticated;
grant select (id,user_id,description,amount_minor,currency,status,created_at) on public.payment_records to authenticated;
grant all on public.payment_records to service_role;

-- Personal history remains private even when read directly through Supabase REST.
-- The public leaderboard continues to read the public profile statistics.
drop policy if exists "match participant read" on public.match_participants;
drop policy if exists "member participation history" on public.match_participants;
create policy "member participation history" on public.match_participants
  for select to authenticated using (auth.uid() = user_id and not coalesce((auth.jwt()->>'is_anonymous')::boolean,false));
drop policy if exists "match read" on public.matches;
drop policy if exists "member match history" on public.matches;
create policy "member match history" on public.matches
  for select to authenticated using (
    not coalesce((auth.jwt()->>'is_anonymous')::boolean,false)
    and exists (select 1 from public.match_participants p where p.match_id = matches.id and p.user_id = auth.uid())
  );
revoke all on public.matches, public.match_participants from public, anon, authenticated;
grant select on public.matches, public.match_participants to authenticated;
grant all on public.matches, public.match_participants to service_role;

commit;
