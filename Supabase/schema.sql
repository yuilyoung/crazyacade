-- Base schema. For a complete installation, run the generated setup.sql instead.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null check (char_length(nickname) between 2 and 12),
  rating integer not null default 1000 check (rating >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  room_id text not null unique,
  winner_id uuid references public.profiles(id),
  result jsonb not null,
  played_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.matches enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='profiles' and policyname='profile read') then
    create policy "profile read" on public.profiles for select using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='profiles' and policyname='profile self update') then
    create policy "profile self update" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);
  end if;
  -- Reapplying this base file must not reopen history made private by the member migration.
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='matches' and policyname in ('match read','member match history')) then
    create policy "match read" on public.matches for select using (true);
  end if;
end;
$$;

-- match insert/update는 service_role을 가진 권위 서버만 수행한다. 클라이언트 정책은 만들지 않는다.
