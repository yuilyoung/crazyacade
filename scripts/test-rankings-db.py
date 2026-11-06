"""Check Supabase migrations against disposable PostgreSQL (Linux + Docker)."""
import os
import json
import selectors
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

def concurrent_elo_checks(psql):
    """Use real blocked transactions to verify latest ratings and concurrent retry identity."""
    ids = ['f0000000-0000-0000-0000-00000000000' + str(index) for index in range(1, 4)]
    quoted_ids = ','.join("'" + value + "'" for value in ids)
    locked_ids = ','.join("'" + value + "'" for value in ids[:2])

    def query(sql):
        return subprocess.run(psql + ['-At'], input=sql, text=True, env=env,
                              capture_output=True, check=True, timeout=15).stdout.strip()

    def literal(value):
        return "'" + value.replace("'", "''") + "'"

    def record(match_id, participants, winner):
        payload = [{'user_id': value, 'team': None, 'outcome': 'win' if value == winner else 'loss', 'score': 10}
                   for value in participants]
        return ("select public.record_match(" + ','.join([literal(match_id), "'concurrent-elo'", "'duel'",
                literal(winner), literal(json.dumps({'winnerId': winner})), literal(json.dumps(payload))]) + ");")

    def overlap(first_sql, second_sql):
        first = second = None
        label = 'elo-overlap-' + uuid.uuid4().hex[:10]
        try:
            first = subprocess.Popen(psql + ['-At'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, bufsize=0, env=env)
            # Stop before applying the first result. The parent releases this transaction
            # only after PostgreSQL itself reports that the second RPC is waiting on a lock.
            first.stdin.write((f"begin; select id from public.profiles where id in ({locked_ids}) "
                               "order by id for update; select 'elo-lock-held';\n").encode())
            first.stdin.flush()
            output = b''
            with selectors.DefaultSelector() as selector:
                selector.register(first.stdout, selectors.EVENT_READ)
                deadline = time.monotonic() + 10
                while b'elo-lock-held' not in output:
                    if time.monotonic() >= deadline:
                        raise AssertionError('First Elo transaction did not acquire its rows')
                    if selector.select(.1):
                        chunk = os.read(first.stdout.fileno(), 4096)
                        if not chunk:
                            raise AssertionError('First Elo transaction exited before acquiring rows')
                        output += chunk
            second = subprocess.Popen(psql + ['-At'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, bufsize=0, env=env)
            second.stdin.write((f"set application_name={literal(label)};\n" + second_sql + '\n').encode())
            second.stdin.close(); second.stdin = None
            deadline = time.monotonic() + 10
            while query("select count(*) from pg_stat_activity where application_name=" + literal(label) + " and wait_event_type='Lock';") != '1':
                if second.poll() is not None:
                    raise AssertionError('Second Elo RPC did not wait for the overlapping profile lock')
                if time.monotonic() >= deadline:
                    raise AssertionError('Second Elo RPC never entered a PostgreSQL lock wait')
                time.sleep(.02)
            first.stdin.write((first_sql + '\ncommit;\n').encode())
            first.stdin.close(); first.stdin = None
            for process in (first, second):
                _, errors = process.communicate(timeout=15)
                if process.returncode:
                    raise AssertionError('Concurrent Elo transaction failed: ' + errors.decode())
        finally:
            for process in (first, second):
                if process and process.poll() is None:
                    process.kill(); process.communicate(timeout=5)

    query(f"insert into auth.users(id) values " + ','.join('(' + literal(value) + ')' for value in ids) + ';')
    query("insert into public.profiles(id,nickname) values " + ','.join(
        '(' + literal(value) + ',' + literal('Concurrent' + str(index)) + ')' for index, value in enumerate(ids)) + ';')
    a, b, c = ids
    overlap(record('f1000000-0000-0000-0000-000000000001', [a, b], a),
            record('f1000000-0000-0000-0000-000000000002', [c, a], c))
    ratings = json.loads(query(f"select json_agg(rating order by id) from public.profiles where id in ({quoted_ids});"))
    assert ratings == [999, 984, 1017], ('Overlapping result used stale ratings', ratings)
    print('PASS: concurrent overlapping Elo RPC waits on PostgreSQL row locks and reads latest ratings [999,984,1017]', flush=True)
    query(f"update public.profiles set rating=1000,wins=0,losses=0,draws=0,score=0 where id in ({quoted_ids});")
    match_id = 'f1000000-0000-0000-0000-000000000003'
    overlap(record(match_id, [a, b], a), record(match_id, [b, a], a))
    result = json.loads(query(f"select json_agg(json_build_array(rating,wins,losses,score) order by id) from public.profiles where id in ({quoted_ids});"))
    assert result == [[1016, 1, 0, 10], [984, 0, 1, 10], [1000, 0, 0, 0]], result
    assert query('select count(*) from public.match_participants where match_id=' + literal(match_id) + ';') == '2'
    print('PASS: concurrent same-ID reversed-roster retry applies Elo, counters and history exactly once', flush=True)

try:
    subprocess.run(docker + ['run', '-d', '--rm', '--network', 'none', '--name', container,
                            '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image], env=env, check=True, stdout=subprocess.DEVNULL)
    for _ in range(80):
        # The image's initialization server accepts Unix sockets, then restarts.
        # TCP readiness waits for the final server rather than racing that restart.
        if subprocess.run(docker + ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], env=env,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            break
        time.sleep(.25)
    else:
        raise RuntimeError('PostgreSQL did not become ready')
    psql = docker + ['exec', '-i', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1']
    subprocess.run(psql, input=bootstrap, text=True, env=env, check=True, stdout=subprocess.DEVNULL)
    for source in ['Supabase/schema.sql', 'Supabase/migrations/20261102_team_match_history.sql',
                   'Supabase/migrations/20261102_rankings.sql', 'Supabase/tests/rankings.sql',
                   'Supabase/tests/elo-before-migration.sql', 'Supabase/migrations/20261106_team_elo.sql',
                   'Supabase/tests/team-elo.sql']:
        subprocess.run(psql, input=(root/source).read_text(), text=True, env=env, check=True, stdout=subprocess.DEVNULL)
        print('PASS:', source, flush=True)
    concurrent_elo_checks(psql)
finally:
    subprocess.run(docker + ['rm', '-f', container], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
