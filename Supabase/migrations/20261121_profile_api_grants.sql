-- Apply after 20261107_member_accounts.sql. Existing profile data and RLS stay in place.
begin;

-- Give fresh installs and projects with legacy default grants the same public API.
revoke all on table public.profiles from public, anon, authenticated;
grant select (nickname,rating,wins,losses,draws,score) on public.profiles to anon, authenticated;
grant select (id), update (nickname) on public.profiles to authenticated;

-- The game creates missing profiles, reads member records and applies match results.
grant select (id,nickname,rating,wins,losses,draws,score,created_at,updated_at),
      insert (id,nickname), update (nickname,rating,wins,losses,draws,score,updated_at)
  on public.profiles to service_role;

commit;
