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

test('signup and confirmation resend return to the game with only its invitation and play intent', async () => {
  const location = { href: 'https://user:secret@arena.example/game/?room=old&unrelated=private#secret' };
  const requests = [];
  const account = client({ location, getConfirmationRedirect: () =>
    'https://arena.example/game/?room=bubble%2Bparty&map=lagoon&humans=4&play=friend&password=private#refresh_token=private',
    fetch: async (url, options) => {
      requests.push({ url: new URL(url), body: JSON.parse(options.body) });
      return json(requests.length === 1 ? user : {});
    } });
  await account.signUp(user.email, 'password123', 'Bubble');
  await account.resendConfirmation(' ' + user.email + ' ');
  assert.deepEqual(requests.map(item => item.url.pathname), ['/auth/v1/signup', '/auth/v1/resend']);
  for (const { url } of requests) {
    assert.deepEqual([...url.searchParams], [['redirect_to', 'https://arena.example/game/?room=bubble%2Bparty&map=lagoon&humans=4&play=friend']]);
  }
  assert.deepEqual(requests[1].body, { type: 'signup', email: user.email });
  assert.equal(account.getSession(), null);
  await assert.rejects(account.resendConfirmation('invalid'), { code: 'invalid_email' });
  assert.equal(requests.length, 2);
});

test('off-origin confirmation destinations fall back to the current game page', async () => {
  let redirect;
  const account = client({ location: { href: 'https://arena.example/play/?room=local&play=bogus&secret=private' },
    getConfirmationRedirect: () => 'https://another.example/?room=wrong',
    fetch: async url => { redirect = new URL(url).searchParams.get('redirect_to'); return json(user); } });
  await account.signUp(user.email, 'password123', 'Bubble');
  assert.equal(redirect, 'https://arena.example/play/?room=local');
});

test('signup and resend preserve a quick duel without leaking a room or personal team', async () => {
  const redirects = [];
  const account = client({ location: { href: 'https://arena.example/play' },
    getConfirmationRedirect: () => 'https://arena.example/play?play=quick&mode=duel&map=harbor&items=0&room=old&team=pink',
    fetch: async url => { redirects.push(new URL(url).searchParams.get('redirect_to')); return json(user); } });
  await account.signUp(user.email, 'password123', 'Bubble');
  await account.resendConfirmation(user.email);
  const expected = 'https://arena.example/play?play=quick&mode=duel&map=harbor&items=0';
  assert.deepEqual(redirects, [expected, expected]);
});

test('confirmation mail retains a private valid team choice only for a pending friend and AI team room', async () => {
  for (const [query, expected] of [
    ['play=friend&mode=team&humans=2&team=pink', 'pink'], ['play=friend&mode=team&humans=6&team=blue', 'blue'],
    ['play=friend&mode=team&humans=4&team=other', null], ['play=ranked&mode=team&humans=2&team=pink', null],
    ['play=friend&mode=duel&humans=2&team=pink', null], ['play=friend&mode=team&humans=8&team=pink', null],
    ['mode=team&humans=2&team=pink', null]
  ]) {
    let redirect;
    const account = client({ location: { href: 'https://arena.example/play/?' + query },
      fetch: async url => { redirect = new URL(new URL(url).searchParams.get('redirect_to')); return json(user); } });
    await account.signUp(user.email, 'password123', 'Bubble');
    assert.equal(redirect.searchParams.get('team'), expected, query);
  }
});

test('waiting for confirmation or requesting a new link preserves the existing signed-in account', async () => {
  const saved = storage();
  const account = client({ storage: saved, fetch: async url =>
    json(url.includes('grant_type=password') ? session : url.includes('/resend') ? {} : { ...user, email: 'new@example.test' }) });
  await account.signIn(user.email, 'password123');
  await account.signUp('new@example.test', 'password123', 'Other');
  assert.equal(account.getSession()?.user.email, user.email);
  await account.resendConfirmation('new@example.test');
  assert.deepEqual(client({ storage: saved }).getSession(), session);
});

test('a pending signup preserves a simultaneous refresh of the signed-in member', async () => {
  const saved = storage();
  let clock = 1000000, finishRefresh;
  const account = client({ storage: saved, now: () => clock, fetch: async url => {
    if (url.includes('grant_type=password')) return json(session);
    if (url.includes('grant_type=refresh_token')) return new Promise(resolve => { finishRefresh = resolve; });
    return json({ ...user, email: 'new@example.test' });
  } });
  await account.signIn(user.email, 'password123');
  clock = 4600000;
  const refreshing = account.getAccessToken();
  await account.signUp('new@example.test', 'password123', 'Other');
  finishRefresh(json({ ...session, access_token: 'new-access', refresh_token: 'rotated', expires_at: 8200 }));
  assert.equal(await refreshing, 'new-access');
  assert.equal(client({ storage: saved }).getSession()?.refresh_token, 'rotated');
});

test('an expired old session cannot cancel a new password sign-in while it is completing', async () => {
  let clock = 1000000, finishRefresh, finishSignIn;
  const account = client({ now: () => clock, fetch: async url => {
    if (clock === 1000000) return json(session);
    if (url.includes('grant_type=refresh_token')) return new Promise(resolve => { finishRefresh = resolve; });
    return new Promise(resolve => { finishSignIn = resolve; });
  } });
  await account.signIn(user.email, 'password123');
  clock = 4600000;
  const refreshing = account.getAccessToken();
  const login = account.signIn(user.email, 'password123');
  finishRefresh(json({ error_code: 'refresh_token_not_found' }, 400));
  await assert.rejects(refreshing, { code: 'session_expired' });
  finishSignIn(json({ ...session, access_token: 'new-password-session', expires_at: 8200 }));
  assert.equal((await login)?.access_token, 'new-password-session');
});

test('unconfirmed login, email cooldown and rejected resend give actionable errors without provider details', async () => {
  const cases = [
    ['signIn', { code: 'email_not_confirmed', msg: 'private detail' }, 400, 'email_not_confirmed'],
    ['signIn', { error_code: 'email_not_confirmed', msg: 'private detail' }, 400, 'email_not_confirmed'],
    ['signIn', { error: 'invalid_grant', error_description: 'Email not confirmed' }, 400, 'email_not_confirmed'],
    ['resendConfirmation', { msg: 'private detail' }, 429, 'email_rate_limit'],
    ['resendConfirmation', { msg: 'private detail' }, 422, 'resend_failed']
  ];
  for (const [method, body, status, code] of cases) {
    const account = client({ fetch: async () => json(body, status) });
    await assert.rejects(account[method](user.email, 'password123'), err => err.code === code && !err.message.includes('private'));
  }
});

test('GoTrue confirmation callbacks remove auth data from browser history and preserve the game invitation', () => {
  const base = 'https://arena.example/game/?room=A%2BB&items=0&play=friend';
  const cases = [
    ['#access_token=private&refresh_token=private2&type=signup&token_type=bearer&expires_in=3600', 'opened', base],
    ['&error=access_denied&error_code=otp_expired&error_description=private#error=access_denied&error_code=otp_expired', 'expired', base],
    ['#error=access_denied&error_description=private', 'invalid', base],
    ['&code=private#lobby', 'invalid', base + '#lobby'],
    ['#access_token=private', 'invalid', base],
    ['#refresh_token=private&type=signup&error=access_denied', 'invalid', base],
    ['#lobby', null, null]
  ];
  for (const [suffix, expected, clean] of cases) {
    let replaced = null;
    const state = { existing: 'state' };
    const history = { state, replaceState(value, title, next) {
      assert.deepEqual(value, state);
      replaced = new URL(next, base).href;
    } };
    assert.equal(module.consumeEmailConfirmation(base + suffix, history), expected);
    assert.equal(replaced, clean);
  }
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

test('member appearance reads and explicit saves send only the three cosmetic IDs to the game server', async () => {
  const outfit = { characterId: 'toto', skinId: 'tuxedo', orbSkinId: 'duck' };
  const requests = [];
  const account = client({ fetch: async (url, options) => {
    if (url.includes('grant_type=password')) return json(session);
    assert.equal(url, '/api/account/loadout');
    assert.equal(options.headers.Authorization, 'Bearer access-one');
    requests.push({method: options.method, body: options.body && JSON.parse(options.body)});
    return json({loadout: options.method === 'GET' ? null : outfit});
  } });
  await assert.rejects(account.getLoadout(), {code: 'unauthorized'});
  await account.signIn(user.email, 'password123');
  assert.deepEqual(await account.getLoadout(), {loadout: null});
  assert.deepEqual(await account.saveLoadout({...outfit, userId: 'another', practiceItemId: 'wave'}), {loadout: outfit});
  assert.deepEqual(requests, [{method: 'GET', body: undefined}, {method: 'PUT', body: outfit}]);
});
