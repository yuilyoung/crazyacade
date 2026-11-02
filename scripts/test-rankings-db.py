"""Check Supabase migrations against disposable PostgreSQL (Linux + Docker)."""
import os
from pathlib import Path
import subprocess
import time
import uuid

root = Path(__file__).resolve().parents[1]
container = 'poppop-sql-' + uuid.uuid4().hex[:10]
env = os.environ.copy()
for key in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'):
    env.pop(key, None)
docker = ['docker', '--host=unix:///var/run/docker.sock']
image = 'postgres:17-alpine'
bootstrap = '''
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT null::uuid $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
'''
try:
    subprocess.run(docker + ['run', '-d', '--rm', '--network', 'none', '--name', container,
                            '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image], env=env, check=True, stdout=subprocess.DEVNULL)
    for _ in range(80):
        if subprocess.run(docker + ['exec', container, 'pg_isready', '-U', 'postgres'], env=env,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            break
        time.sleep(.25)
    else:
        raise RuntimeError('PostgreSQL did not become ready')
    psql = docker + ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1']
    subprocess.run(psql, input=bootstrap, text=True, env=env, check=True, stdout=subprocess.DEVNULL)
    for source in ['Supabase/schema.sql', 'Supabase/migrations/20261102_team_match_history.sql',
                   'Supabase/migrations/20261102_rankings.sql', 'Supabase/tests/rankings.sql']:
        subprocess.run(psql, input=(root/source).read_text(), text=True, env=env, check=True, stdout=subprocess.DEVNULL)
        print('PASS:', source, flush=True)
finally:
    subprocess.run(docker + ['rm', '-f', container], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
