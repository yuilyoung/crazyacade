"""Check Supabase migrations against disposable PostgreSQL (Linux + Docker)."""
import os
import json
import selectors
from pathlib import Path
import subprocess
import sys
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
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
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

def repeated_migration_checks(psql):
    """Rerunning setup must neither reopen private history nor reset imported totals."""
    def query(sql):
        return subprocess.run(psql + ['-At'], input=sql, text=True, env=env,
                              capture_output=True, check=True, timeout=15).stdout.strip()

    def snapshot():
        return query("select jsonb_agg(to_jsonb(p) order by id) from public.profiles p;")

    before = snapshot()
    failures = []
    repeated = subprocess.run(psql, input=(root/'Supabase/schema.sql').read_text(), text=True,
                              env=env, capture_output=True, timeout=15)
    if repeated.returncode:
        failures.append('base schema cannot be applied twice: ' + repeated.stderr.strip().splitlines()[-1])
    elif query("select count(*) from pg_policies where schemaname='public' and tablename='matches' and policyname='match read';") != '0':
        failures.append('base schema reopened private match history')
    subprocess.run(psql, input=(root/'Supabase/migrations/20261102_rankings.sql').read_text(),
                   text=True, env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if snapshot() != before:
        failures.append('repeated rankings migration reset existing/imported profile statistics')
    assert not failures, '\n'.join(failures)
    # Restore the final RPC after testing the historical migration in isolation.
    subprocess.run(psql, input=(root/'Supabase/migrations/20261106_team_elo.sql').read_text(),
                   text=True, env=env, check=True, stdout=subprocess.DEVNULL)
    print('PASS: base schema repeat keeps private history; rankings repeat preserves imported statistics', flush=True)


def bundled_setup_checks(psql):
    """Exercise exactly the SQL a user pastes, including upgrade/retry and rollback."""
    subprocess.run([sys.executable, str(root/'scripts/build-supabase-setup.py'), '--check'], check=True)
    setup = (root/'Supabase/setup.sql').read_text()
    database_bootstrap = '\n'.join(line for line in bootstrap.splitlines() if not line.startswith('CREATE ROLE '))

    def run(sql, connection=psql, *, check=True):
        result = subprocess.run(connection + ['-At'], input=sql, text=True, env=env,
                                capture_output=True, timeout=30)
        if check and result.returncode:
            raise AssertionError(result.stderr)
        return result

    def new_database(name):
        run('create database ' + name + ';')
        connection = psql + ['-d', name]
        run(database_bootstrap, connection)
        return connection

    def records(connection):
        return run("""select jsonb_build_object(
          'profiles',(select jsonb_agg(to_jsonb(p) order by id) from public.profiles p),
          'matches',(select jsonb_agg(to_jsonb(m) order by id) from public.matches m),
          'participants',(select jsonb_agg(to_jsonb(p) order by match_id,user_id) from public.match_participants p),
          'payments',(select jsonb_agg(to_jsonb(p) order by id) from public.payment_records p));""", connection).stdout.strip()

    run("""insert into public.payment_records(user_id,description,amount_minor,currency,status,provider,provider_payment_id)
      values('d0000000-0000-0000-0000-000000000001','Preserved metadata',1500,'KRW','paid','fixture','preserved-1');""")
    before = records(psql)
    for _ in range(2):
        run(setup)
        assert records(psql) == before, 'bundled setup changed existing profiles, histories or payments'
    run((root/'Supabase/tests/member-accounts.sql').read_text())
    run((root/'Supabase/tests/team-elo.sql').read_text())
    print('PASS: complete setup twice preserves every current record and retains member RLS/final Elo', flush=True)

    fresh = new_database('setup_fresh')
    run(setup, fresh)
    assert run("select count(*) from pg_tables where schemaname='public' and tablename in ('profiles','matches','match_participants','payment_records') and rowsecurity;", fresh).stdout.strip() == '4'
    run((root/'Supabase/tests/elo-before-migration.sql').read_text(), fresh)
    fresh_before = records(fresh)
    run(setup, fresh)
    assert records(fresh) == fresh_before, 'fresh-installed database lost records on repeat setup'
    run((root/'Supabase/tests/member-accounts.sql').read_text(), fresh)
    run((root/'Supabase/tests/team-elo.sql').read_text(), fresh)
    print('PASS: fresh bundled installation creates all protected tables, member history and Elo RPC', flush=True)

    partial = new_database('setup_partial')
    run((root/'Supabase/schema.sql').read_text(), partial)
    run((root/'Supabase/migrations/20261102_team_match_history.sql').read_text(), partial)
    run("""
      alter table public.profiles add column wins integer not null default 0;
      alter table public.match_participants add column score integer not null default 0;
      insert into auth.users(id) values('a1000000-0000-0000-0000-000000000001');
      insert into public.profiles(id,nickname,rating,wins)
        values('a1000000-0000-0000-0000-000000000001','Imported',1530,77);
      insert into public.matches(id,room_id,mode,result) values
        ('a2000000-0000-0000-0000-000000000001','old-room','duel','{}'),
        ('a2000000-0000-0000-0000-000000000002','old-room','duel','{}'),
        ('a2000000-0000-0000-0000-000000000003','old-room','duel','{}');
      insert into public.match_participants(match_id,user_id,outcome,score) values
        ('a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001','win',100),
        ('a2000000-0000-0000-0000-000000000002','a1000000-0000-0000-0000-000000000001','loss',20),
        ('a2000000-0000-0000-0000-000000000003','a1000000-0000-0000-0000-000000000001','draw',30);
      """, partial)
    run(setup, partial)
    actual = json.loads(run("select json_build_array(nickname,rating,wins,losses,draws,score) from public.profiles;", partial).stdout)
    assert actual == ['Imported', 1530, 77, 1, 1, 150], ('partial setup did not preserve old counters/backfill new ones', actual)
    partial_before = records(partial)
    run(setup, partial)
    assert records(partial) == partial_before, 'partial upgrade changed records when repeated'
    run((root/'Supabase/tests/member-accounts.sql').read_text(), partial)
    print('PASS: partial upgrade preserves imported wins/rating and backfills only new losses/draws/score', flush=True)

    # Insert an error immediately before the bundle commits. A failed install must
    # leave no half-installed tables on fresh DBs and no changed records on upgrades.
    failed_setup = setup.replace("notify pgrst, 'reload schema';", "do $$ begin raise exception 'setup rollback probe'; end $$;")
    rollback = new_database('setup_rollback')
    failed = run(failed_setup, rollback, check=False)
    assert failed.returncode and 'setup rollback probe' in failed.stderr, 'rollback probe did not reach its intended failure'
    assert run("select count(*) from pg_tables where schemaname='public';", rollback).stdout.strip() == '0', 'failed setup left committed tables'
    assert run("select to_regprocedure('public.record_match(uuid,text,text,uuid,jsonb,jsonb)') is null;", rollback).stdout.strip() == 't', 'failed setup left a committed RPC'
    failed = run(failed_setup, check=False)
    assert failed.returncode and 'setup rollback probe' in failed.stderr
    assert records(psql) == before, 'failed upgrade changed existing records'
    run((root/'Supabase/tests/member-accounts.sql').read_text())
    run((root/'Supabase/tests/team-elo.sql').read_text())
    print('PASS: injected final error rolls back fresh setup and existing-data upgrade completely', flush=True)

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
                   'Supabase/tests/team-elo.sql', 'Supabase/migrations/20261107_member_accounts.sql',
                   'Supabase/tests/member-accounts.sql']:
        subprocess.run(psql, input=(root/source).read_text(), text=True, env=env, check=True, stdout=subprocess.DEVNULL)
        print('PASS:', source, flush=True)
    concurrent_elo_checks(psql)
    repeated_migration_checks(psql)
    bundled_setup_checks(psql)
finally:
    subprocess.run(docker + ['rm', '-f', container], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
