-- Apply after 20261121_profile_api_grants.sql. NULL means no outfit has been saved.
begin;

alter table public.profiles add column if not exists loadout jsonb;
-- Profiles have public leaderboard rows. Only the authenticated game server reads
-- or updates the outfit column after filtering by the verified member's id.
revoke all (loadout) on public.profiles from public, anon, authenticated;
grant select (loadout), update (loadout) on public.profiles to service_role;

commit;
