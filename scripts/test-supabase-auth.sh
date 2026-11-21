#!/usr/bin/env bash
# Run after npm ci in Server. Requires a local Linux Docker daemon with Compose v2.
set -euo pipefail

cd "$(dirname "$0")/.."
export AUTH_SMOKE_SECRET
AUTH_SMOKE_SECRET=$(openssl rand -hex 32)
project="poppop-auth-$(openssl rand -hex 6)"
compose=(docker --host=unix:///var/run/docker.sock compose --project-name "$project" --file scripts/fixtures/supabase-auth/compose.yml)
trap '"${compose[@]}" down --volumes --timeout 2 >/dev/null' EXIT
"${compose[@]}" up --detach --wait --wait-timeout 60 database mail
psql=("${compose[@]}" exec -T database psql -U postgres -v ON_ERROR_STOP=1 -q)
"${psql[@]}" <<'SQL'
CREATE SCHEMA auth;
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT;
GRANT anon, authenticated, service_role TO authenticator;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
SQL
"${compose[@]}" up --detach --wait --wait-timeout 60 auth
"${psql[@]}" < Supabase/setup.sql
"${compose[@]}" up --detach --wait --wait-timeout 60 rest checks
tar -cf - Server/src Server/public Server/package.json Server/node_modules/ws scripts/fixtures/supabase-auth/verify.mjs |
  "${compose[@]}" exec -T checks tar -xf -
"${compose[@]}" exec -T checks node --test scripts/fixtures/supabase-auth/verify.mjs
