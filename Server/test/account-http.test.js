import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequestHandler } from '../src/http.js';

const userId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const env = { SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_ANON_KEY: 'public-key', SUPABASE_SERVICE_ROLE_KEY: 'server-secret' };
const profile = { id: userId, nickname: 'Bubble', rating: 1230, wins: 7, losses: 2, draws: 1, score: 720, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-07T00:00:00Z' };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
async function setup(t, fetchImpl, options = {}) {
  const server = createServer(createRequestHandler({ env, fetchImpl, ...options }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return (path = '/api/account', init = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { ...init, headers: { Authorization: 'Bearer member-token', ...init.headers } });
}
function provider(overrides = {}) {
  return async (url, options) => {
    const parsed = new URL(url), endpoint = parsed.pathname;
    if (endpoint === '/auth/v1/user') {
      assert.equal(options.headers.Authorization, 'Bearer member-token');
      return overrides.auth?.(options) ?? json({ id: userId, email: 'member@example.com', is_anonymous: false });
    }
    assert.equal(options.headers.apikey, 'server-secret');
    assert.ok(options.signal, 'provider requests have deadlines');
    if (endpoint === '/rest/v1/profiles' && options.method === 'PATCH') return overrides.patch?.(parsed, options) ?? json([profile]);
    if (endpoint === '/rest/v1/profiles' && parsed.searchParams.has('or')) return json([], 200, { 'Content-Range': '0-0/4' });
    if (endpoint === '/rest/v1/profiles') {
      assert.equal(parsed.searchParams.get('id'), `eq.${userId}`);
      return overrides.profile?.(parsed, options) ?? json([profile]);
    }
    if (endpoint === '/rest/v1/match_participants') {
      assert.equal(parsed.searchParams.get('user_id'), `eq.${userId}`);
      assert.equal(parsed.searchParams.get('limit'), '20');
      return overrides.matches?.(parsed, options) ?? json([{ user_id: userId, match_id: 'match-one', outcome: 'win', score: 80, team: 'blue', matches: { id: 'match-one', mode: 'team', played_at: '2026-11-07T00:00:00Z' } }]);
    }
    if (endpoint === '/rest/v1/payment_records') {
      assert.equal(parsed.searchParams.get('user_id'), `eq.${userId}`);
      return overrides.payments?.(parsed, options) ?? json([]);
    }
    throw new Error('Unexpected upstream route: ' + endpoint);
  };
}

test('account API authenticates the bearer token and isolates profile, matches and payments from supplied ids', async t => {
  const request = await setup(t, provider());
  const response = await request(`/api/account?userId=${otherId}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.user.id, userId); assert.equal(body.profile.nickname, 'Bubble');
  assert.deepEqual(body.stats, { games: 10, winRate: 70, rank: 5 });
  assert.deepEqual(body.recentMatches, [{ id: 'match-one', mode: 'team', playedAt: '2026-11-07T00:00:00Z', outcome: 'win', score: 80, team: 'blue' }]);
  assert.equal(body.historyStatus, 'available'); assert.deepEqual(body.payments, []); assert.equal(body.paymentStatus, 'history_only');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(JSON.stringify(body).includes('server-secret'), false);
});

test('missing tokens, rejected tokens and anonymous users cannot read member records', async t => {
  for (const auth of [() => json({}, 401), () => json({ id: userId, is_anonymous: true }), () => json({ id: 'bad,filter', email: 'a@b.com' })]) {
    const request = await setup(t, provider({ auth }));
    assert.equal((await request()).status, 401);
  }
  const request = await setup(t, async () => { throw new Error('must not call provider'); });
  assert.equal((await request('/api/account', { headers: { Authorization: '' } })).status, 401);
});

test('profile update cannot edit another user or award score and only sends validated nickname', async t => {
  const request = await setup(t, provider({ patch: (parsed, options) => {
    assert.equal(parsed.searchParams.get('id'), `eq.${userId}`);
    assert.deepEqual(JSON.parse(options.body), { nickname: '새닉네임' });
    return json([{ ...profile, nickname: '새닉네임' }]);
  } }));
  const response = await request('/api/account/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: otherId, nickname: ' 새닉네임 ', rating: 9999, score: 9999 }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).profile.nickname, '새닉네임');
});

test('profile updates reject invalid JSON, oversized bodies and invalid nicknames', async t => {
  const request = await setup(t, provider());
  for (const [body, status] of [['{', 400], [JSON.stringify({ nickname: 'x' }), 400], [JSON.stringify({ nickname: 'x'.repeat(5000) }), 413]]) {
    assert.equal((await request('/api/account/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body })).status, status);
  }
  assert.equal((await request('/api/account/profile', { method: 'POST' })).status, 405);
});

test('unavailable history stays distinct from an empty payment list and provider details never escape', async t => {
  const request = await setup(t, provider({ matches: () => json({ error: 'SECRET' }, 500), payments: () => json({ error: 'SECRET' }, 404) }));
  const response = await request(); assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.recentMatches, null); assert.equal(body.historyStatus, 'unavailable');
  assert.equal(body.payments, null); assert.equal(body.paymentStatus, 'unavailable'); assert.equal(JSON.stringify(body).includes('SECRET'), false);
});

test('foreign rows and failed profile providers cannot expose account information', async t => {
  for (const read of [() => json([{ ...profile, id: otherId }]), () => json({ error: 'SECRET' }, 500)]) {
    const request = await setup(t, provider({ profile: read }));
    const response = await request(); assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'account_unavailable' });
  }
  const request = await setup(t, provider(), { env: {} });
  const response = await request(); assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'account_not_configured' });
});

test('the first member account read initializes a profile without awarding stats or replacing existing rows', async t => {
  let initialized = false;
  const upstream = provider({
    auth: () => json({ id: userId, email: 'member@example.com', user_metadata: { nickname: 'SignupName' } }),
    profile: () => json(initialized ? [{ ...profile, nickname: 'SignupName', rating: 1000, wins: 0, losses: 0, draws: 0, score: 0 }] : []),
    matches: () => json([])
  });
  const request = await setup(t, async (url, options) => {
    if (new URL(url).pathname === '/rest/v1/profiles' && options.method === 'POST') {
      assert.equal(options.headers.Prefer, 'resolution=ignore-duplicates');
      assert.deepEqual(JSON.parse(options.body), { id: userId, nickname: 'SignupName' });
      initialized = true; return new Response(null, { status: 201 });
    }
    return upstream(url, options);
  });
  const response = await request(); assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.profile.nickname, 'SignupName'); assert.equal(body.stats.games, 0);
  assert.equal(body.profile.score, 0); assert.deepEqual(body.recentMatches, []); assert.equal(body.historyStatus, 'available');
});

test('payment history returns only display metadata and rejects accidentally returned foreign rows', async t => {
  const payment = { id: 'payment-one', user_id: userId, description: 'Starter pack', amount_minor: 450, currency: 'USD', status: 'paid', created_at: '2026-11-07T00:00:00Z', provider_payment_id: 'private-provider-reference' };
  const request = await setup(t, provider({ payments: () => json([payment]) }));
  const body = await (await request()).json();
  assert.deepEqual(body.payments, [{ id: 'payment-one', description: 'Starter pack', amountMinor: 450, currency: 'USD', status: 'paid', createdAt: '2026-11-07T00:00:00Z' }]);
  assert.equal(JSON.stringify(body).includes('private-provider-reference'), false);
  const foreign = await setup(t, provider({ payments: () => json([{ ...payment, user_id: otherId }]), matches: () => json([{ user_id: otherId }]) }));
  const hidden = await (await foreign()).json();
  assert.equal(hidden.payments, null); assert.equal(hidden.paymentStatus, 'unavailable');
  assert.equal(hidden.recentMatches, null); assert.equal(hidden.historyStatus, 'unavailable');
});
