import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequestHandler } from '../src/http.js';
import { createServiceDiagnostics } from '../src/service-diagnostics.js';

const env = { SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_ANON_KEY: 'public-key', SUPABASE_SERVICE_ROLE_KEY: 'server-secret' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const rpcSpec = { paths: { '/rpc/record_match': { post: { parameters: [{ in: 'body', schema: { required: ['p_match_id','p_room_id','p_mode','p_winner_id','p_result','p_participants'] } }] } } } };
function provider(overrides = {}) {
  return async (url, options) => {
    const parsed = new URL(url);
    assert.equal(options.redirect, 'error', 'credentials must never follow redirects');
    assert.ok(options.signal, 'provider requests must have deadlines');
    assert.ok(['GET', 'HEAD'].includes(options.method), 'diagnostics never write');
    if (parsed.pathname === '/auth/v1/settings') {
      assert.equal(options.headers.apikey, 'public-key');
      return overrides.auth?.() ?? json({ external: { email: true, anonymous_users: false }, disable_signup: false, mailer_autoconfirm: false });
    }
    assert.equal(options.headers.apikey, 'server-secret');
    assert.equal(options.headers.Authorization, 'Bearer server-secret');
    if (parsed.pathname === '/rest/v1/') return overrides.rpc?.() ?? json(rpcSpec);
    assert.ok(['/rest/v1/profiles','/rest/v1/matches','/rest/v1/match_participants','/rest/v1/payment_records'].includes(parsed.pathname));
    assert.equal(options.method, 'HEAD');
    assert.equal(parsed.searchParams.get('limit'), '0', 'no member rows are fetched');
    assert.ok(parsed.searchParams.get('select'), 'validate required columns, not just table existence');
    return overrides.table?.(parsed.pathname) ?? new Response(null, { status: 200 });
  };
}
async function setup(t, options = {}) {
  const server = createServer(createRequestHandler({ env, fetchImpl: provider(), ...options }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return (path = '/health/services', init) => fetch(`http://127.0.0.1:${server.address().port}${path}`, init);
}

test('services distinguishes missing configuration from process readiness', async t => {
  const request = await setup(t, { env: {}, fetchImpl: () => { throw Error('must not fetch'); } });
  const response = await request();
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.equal(result.checks.configuration, 'missing');
  assert.equal(result.status, 'unavailable');
  assert.equal((await request('/health/ready')).status, 200);
});

test('ready service check uses read-only schema and signup probes without exposing keys or records', async t => {
  const request = await setup(t);
  const response = await request();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ready', checks: { configuration: 'ok', authentication: 'ok', database: 'ok', resultStorage: 'ok' } });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await (await request('/health/services', { method: 'HEAD' })).text(), '');
  assert.equal((await request('/health/services', { method: 'POST' })).status, 405);
});

test('service check reports disabled email and signup separately', async t => {
  for (const [settings, expected] of [
    [{ external: { email: false }, disable_signup: false }, 'email_disabled'],
    [{ external: { email: true }, disable_signup: true }, 'signup_disabled'],
    [{ external: {} }, 'invalid_response']
  ]) {
    const request = await setup(t, { fetchImpl: provider({ auth: () => json(settings) }) });
    const response = await request();
    assert.equal(response.status, 503);
    assert.equal((await response.json()).checks.authentication, expected);
  }
});

test('missing tables and result RPC cannot report ready', async t => {
  for (const overrides of [
    { table: name => new Response(null, { status: name.endsWith('payment_records') ? 404 : 200 }) },
    { rpc: () => json({ paths: {} }) },
    { rpc: () => json({ paths: { '/rpc/record_match': { get: {} } } }) }
  ]) {
    const request = await setup(t, { fetchImpl: provider(overrides) });
    const response = await request();
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.ok(result.checks.database === 'schema_missing' || result.checks.resultStorage === 'schema_missing');
  }
});

test('provider failures expose only fixed codes', async t => {
  for (const [status, expected] of [[401, 'unauthorized'], [403, 'unauthorized'], [429, 'unavailable'], [500, 'unavailable']]) {
    const request = await setup(t, { fetchImpl: () => json({ error: 'server-secret PRIVATE EMAIL' }, status) });
    const response = await request();
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.doesNotMatch(body, /server-secret|PRIVATE|EMAIL|public-key/);
    assert.equal(JSON.parse(body).checks.authentication, expected);
  }
});

test('concurrent and repeated service requests share a cached probe', async t => {
  let calls = 0;
  const delegate = provider();
  const request = await setup(t, { fetchImpl: async (...args) => { calls++; return delegate(...args); } });
  const responses = await Promise.all(Array.from({ length: 8 }, () => request()));
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(calls, 6);
  assert.equal((await request()).status, 200);
  assert.equal(calls, 6);
});

test('a service key pasted into the public-key field is never exposed by config', async t => {
  const jwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.signature`;
  for (const key of ['sb_secret_sensitive', jwt, 'server-secret']) {
    const request = await setup(t, { env: { ...env, SUPABASE_ANON_KEY: key } });
    const config = await (await request('/api/config')).json();
    assert.equal(config.supabaseAnonKey, '');
    assert.equal((await (await request()).json()).checks.configuration, 'invalid');
  }
});

test('unrelated multiline environment settings do not disable member services', async () => {
  const check = createServiceDiagnostics({ env: { ...env, UNRELATED_CERT: 'line1\nline2' }, fetchImpl: provider() });
  assert.equal((await check()).status, 'ready');
});

test('malformed RPC metadata returns a status instead of rejecting the HTTP handler', async () => {
  const check = createServiceDiagnostics({ env, fetchImpl: provider({ rpc: () => json({ paths: { '/rpc/record_match': { post: { parameters: {} } } } }) }) });
  assert.equal((await check()).checks.resultStorage, 'schema_missing');
});

test('a stalled response body is cancelled at the diagnostic deadline', async () => {
  let cancelled = false;
  const check = createServiceDiagnostics({ env, timeoutMs: 20, fetchImpl: provider({ auth: () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) }) });
  assert.equal((await check()).checks.authentication, 'timeout');
  assert.equal(cancelled, true);
});

test('large and invalid provider bodies are bounded and sanitized', async () => {
  for (const body of ['PRIVATE invalid json', JSON.stringify({ secret: 'x'.repeat(1024 * 1024) })]) {
    const check = createServiceDiagnostics({ env, fetchImpl: provider({ auth: () => new Response(body) }) });
    const result = await check();
    assert.equal(result.checks.authentication, 'invalid_response');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|secret/);
  }
});

test('cache expiry retries a recovered provider without requiring a server restart', async () => {
  let clock = 100, calls = 0, down = true;
  const delegate = provider();
  const check = createServiceDiagnostics({ env, now: () => clock, cacheMs: 30, fetchImpl: (...args) => { calls++; return down ? json({}, 503) : delegate(...args); } });
  assert.equal((await check()).status, 'unavailable');
  down = false; clock = 129;
  assert.equal((await check()).status, 'unavailable');
  assert.equal(calls, 6);
  clock = 130;
  assert.equal((await check()).status, 'ready');
  assert.equal(calls, 12);
});

test('invalid destination and development guests fail before any external request', async () => {
  for (const changes of [{ SUPABASE_URL: 'https://user:password@fixture.supabase.co' }, { SUPABASE_URL: 'https://fixture.supabase.co/extra' }, { SUPABASE_URL: 'http://fixture.supabase.co' }, { ALLOW_DEV_GUESTS: 'true' }]) {
    let requested = false;
    const check = createServiceDiagnostics({ env: { ...env, ...changes }, fetchImpl: () => { requested = true; throw Error(); } });
    assert.equal((await check()).status, 'unavailable');
    assert.equal(requested, false);
  }
});
