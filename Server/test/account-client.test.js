import { test } from 'node:test';
import assert from 'node:assert/strict';

const module = await import('../public/account-client.js').catch(() => ({}));
const config = { supabaseUrl: 'https://project.supabase.co', supabaseAnonKey: 'public-key' };
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'member@example.com', is_anonymous: false };
const session = { access_token: 'access-one', refresh_token: 'refresh-one', expires_at: 4600, user };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function storage() { const entries = new Map(); return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) }; }
function client(options = {}) {
  assert.equal(typeof module.createAccountClient, 'function', 'member client must be implemented');
  const value = module.createAccountClient({ now: () => 1000000, ...options }); value.configure(config); return value;
}

test('password login persists the same member for page reload and authenticated account calls', async () => {
  const saved = storage();
  const first = client({ storage: saved, fetch: async (url, options) => {
    assert.equal(url, config.supabaseUrl + '/auth/v1/token?grant_type=password');
    assert.deepEqual(JSON.parse(options.body), { email: 'member@example.com', password: 'password123' });
    assert.equal(options.headers.apikey, 'public-key');
    return json(session);
  } });
  assert.equal((await first.signIn(' member@example.com ', 'password123')).user.id, user.id);
  const restored = client({ storage: saved, fetch: async (url, options) => {
    assert.equal(url, '/api/account'); assert.equal(options.headers.Authorization, 'Bearer access-one');
    return json({ profile: { nickname: 'Member' } });
  } });
  assert.equal(restored.getSession().user.id, user.id);
  assert.equal(await restored.getAccessToken(), 'access-one');
  assert.deepEqual(await restored.getAccount(), { profile: { nickname: 'Member' } });
});

test('signup handles the top-level GoTrue user response while waiting for email confirmation', async () => {
  const account = client({ fetch: async (url, options) => {
    assert.equal(url, config.supabaseUrl + '/auth/v1/signup');
    assert.deepEqual(JSON.parse(options.body), { email: user.email, password: 'password123', data: { nickname: 'Bubble' } });
    // GoTrue /signup returns User directly when confirmation is required.
    return json({ ...user, aud: 'authenticated', role: 'authenticated', confirmation_sent_at: '2026-11-09T00:00:00Z',
      app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { nickname: 'Bubble' }, identities: [] });
  } });
  assert.deepEqual(await account.signUp(user.email, 'password123', ' Bubble '), { session: null, confirmationRequired: true });
  assert.equal(account.getSession(), null);
  assert.equal(await account.getAccessToken(), null);
});

test('signup accepts an auto-confirmed session and restores the same member after reload', async () => {
  const saved = storage();
  const account = client({ storage: saved, fetch: async () => json(session) });
  assert.deepEqual(await account.signUp(user.email, 'password123', 'Bubble'), { session, confirmationRequired: false });
  assert.equal(await client({ storage: saved }).getAccessToken(), 'access-one');
});

test('signup accepts the legacy wrapped confirmation response without creating a session', async () => {
  const account = client({ fetch: async () => json({ user }) });
  assert.deepEqual(await account.signUp(user.email, 'password123', 'Bubble'), { session: null, confirmationRequired: true });
});

test('malformed and anonymous signup responses never appear to confirm a registered account', async () => {
  for (const data of [{}, { id: 123, email: user.email }, { id: user.id }, { user: { ...user, is_anonymous: true } },
    { ...user, is_anonymous: true }, { ...session, access_token: '' }]) {
    const account = client({ fetch: async () => json(data) });
    await assert.rejects(account.signUp(user.email, 'password123', 'Bubble'), error => error.code === 'signup_failed');
    assert.equal(account.getSession(), null);
  }
});

test('concurrent expired-token requests refresh once and preserve the registered identity', async () => {
  let clock = 1000000, refreshes = 0;
  const saved = storage();
  const account = client({ now: () => clock, storage: saved, fetch: async (url, options) => {
    if (url.includes('grant_type=password')) return json(session);
    refreshes++; assert.ok(url.endsWith('token?grant_type=refresh_token'));
    assert.deepEqual(JSON.parse(options.body), { refresh_token: 'refresh-one' });
    return json({ ...session, access_token: 'access-two', refresh_token: 'refresh-two', expires_at: 8200 });
  } });
  await account.signIn(user.email, 'password123'); clock = 4600000;
  assert.deepEqual(await Promise.all([account.getAccessToken(), account.getAccessToken()]), ['access-two', 'access-two']);
  assert.equal(refreshes, 1); assert.equal(account.getSession().user.id, user.id);
  assert.equal(client({ storage: saved }).getSession().refresh_token, 'refresh-two');
});

test('refresh rejection clears expired credentials and never creates an anonymous account', async () => {
  let clock = 1000000;
  const saved = storage();
  const account = client({ now: () => clock, storage: saved, fetch: async url => {
    if (url.includes('grant_type=password')) return json(session);
    assert.ok(url.endsWith('token?grant_type=refresh_token'));
    return json({ message: 'private provider detail' }, 400);
  } });
  await account.signIn(user.email, 'password123'); clock = 4600000;
  await assert.rejects(account.getAccessToken(), error => error.code === 'session_expired' && !error.message.includes('private'));
  assert.equal(account.getSession(), null); assert.equal(client({ storage: saved }).getSession(), null);
});

test('temporary refresh outages keep recoverable credentials and return a safe error', async () => {
  let clock = 1000000;
  const account = client({ now: () => clock, fetch: async url => url.includes('grant_type=password') ? json(session) : json({ error: 'SECRET' }, 503) });
  await account.signIn(user.email, 'password123'); clock = 4600000;
  await assert.rejects(account.getAccessToken(), error => error.code === 'auth_unavailable' && !error.message.includes('SECRET'));
  assert.equal(account.getSession().user.id, user.id);
});

test('signout clears local sessions even if logout is unavailable and a pending refresh cannot resurrect it', async () => {
  let clock = 1000000, finishRefresh;
  const saved = storage();
  const account = client({ now: () => clock, storage: saved, fetch: async url => {
    if (url.includes('grant_type=password')) return json(session);
    if (url.includes('grant_type=refresh_token')) return new Promise(resolve => { finishRefresh = resolve; });
    throw new Error('offline');
  } });
  await account.signIn(user.email, 'password123'); clock = 4600000;
  const refreshing = account.getAccessToken(); await Promise.resolve();
  await account.signOut(); finishRefresh(json({ ...session, expires_at: 8200 }));
  assert.equal(await refreshing, null); assert.equal(account.getSession(), null); assert.equal(client({ storage: saved }).getSession(), null);
});

test('anonymous identities, invalid inputs and unconfigured auth cannot create a member session', async () => {
  const account = client({ fetch: async () => json({ ...session, user: { ...user, is_anonymous: true } }) });
  await assert.rejects(account.signIn(user.email, 'password123'), error => error.code === 'auth_failed');
  assert.equal(account.getSession(), null);
  await assert.rejects(account.signUp(user.email, 'short', 'Bubble'), error => error.code === 'invalid_password');
  await assert.rejects(account.signUp(user.email, 'password123', 'x'), error => error.code === 'invalid_nickname');
  account.configure({}); assert.equal(await account.getAccessToken(), null);
  await assert.rejects(account.signIn(user.email, 'password123'), error => error.code === 'auth_not_configured');
});

test('profile updates send only a nickname and preserve safe API failures', async () => {
  const account = client({ fetch: async (url, options) => {
    if (url.includes('grant_type=password')) return json(session);
    assert.equal(url, '/api/account/profile'); assert.equal(options.method, 'PATCH');
    assert.deepEqual(JSON.parse(options.body), { nickname: 'Bubbles' });
    return json({ error: 'account_unavailable', detail: 'SECRET' }, 503);
  } });
  await account.signIn(user.email, 'password123');
  await assert.rejects(account.updateProfile({ nickname: 'Bubbles', userId: 'other', score: 999 }), error => error.code === 'account_unavailable' && !error.message.includes('SECRET'));
});
