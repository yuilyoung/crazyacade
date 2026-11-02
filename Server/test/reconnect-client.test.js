import test from 'node:test';
import assert from 'node:assert/strict';

let helpers;
try { helpers = await import('../public/reconnect.js'); } catch { /* Missing feature is asserted below. */ }

function memoryStorage() {
  const entries = new Map();
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
}
const participant = { roomId: 'friends', playerId: 'p1', resumeToken: 'private-capability', practice: false, reconnectGraceMs: 30000 };

test('reload can restore only validated participant credentials without unrelated fields', () => {
  assert.equal(typeof helpers?.createResumeStore, 'function');
  const storage = memoryStorage(), first = helpers.createResumeStore(storage, 'tab-session');
  first.save({ ...participant, accessToken: 'must-not-copy', serviceRole: 'must-not-copy' });
  const restored = helpers.createResumeStore(storage, 'tab-session').load();
  assert.deepEqual(restored, participant);
  assert.ok(!storage.getItem('tab-session').includes('must-not-copy'));
  first.clear(); assert.equal(first.load(), null);
});

test('malformed persisted credentials are discarded instead of being sent to server', () => {
  assert.equal(typeof helpers?.createResumeStore, 'function');
  const storage = memoryStorage();
  for (const value of ['not-json', 'null', '{}', JSON.stringify({ ...participant, resumeToken: '' }), JSON.stringify({ ...participant, roomId: {} })]) {
    storage.setItem('tab-session', value); assert.equal(helpers.createResumeStore(storage, 'tab-session').load(), null);
  }
});

test('denied session storage preserves same-page recovery and explicit leave still clears it', () => {
  assert.equal(typeof helpers?.createResumeStore, 'function');
  const storage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const store = helpers.createResumeStore(storage, 'tab-session');
  store.save(participant); assert.deepEqual(store.load(), participant);
  store.clear(); assert.equal(store.load(), null);
});

test('recovery backoff is bounded and failures do not restart the absolute deadline', () => {
  assert.equal(typeof helpers?.createRecoveryWindow, 'function');
  let now = 1000;
  const window = helpers.createRecoveryWindow(() => now);
  window.start(30000);
  assert.deepEqual([window.nextDelay(), window.nextDelay(), window.nextDelay(), window.nextDelay(), window.nextDelay()], [500, 1000, 2000, 4000, 4000]);
  now += 29000; window.start(30000);
  assert.equal(window.remaining(), 1000);
  assert.equal(window.nextDelay(), 1000);
  now += 1000; assert.equal(window.nextDelay(), null);
  window.stop(); window.start(30000);
  assert.equal(window.remaining(), 30000); assert.equal(window.nextDelay(), 500);
});

test('authenticated same-page recovery reuses and refreshes the same user when sessionStorage is denied', async () => {
  assert.equal(typeof helpers?.createBrowserAuthenticator, 'function');
  let now = 1000000;
  const requests = [], config = { supabaseUrl: 'https://auth.example', supabaseAnonKey: 'public-anon' };
  const storage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const authenticate = helpers.createBrowserAuthenticator({ storage, now: () => now, fetch: async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ access_token: `access-${requests.length}`, refresh_token: 'same-refresh', expires_in: 3600, user: { id: 'same-user' } }) };
  } });
  const first = await authenticate(config), resumed = await authenticate(config);
  assert.equal(first.user.id, 'same-user'); assert.equal(resumed.access_token, first.access_token);
  assert.equal(requests.length, 1, 'a reconnect must not create another anonymous user');
  now += 3600000;
  const refreshed = await authenticate(config);
  assert.equal(refreshed.user.id, first.user.id); assert.equal(refreshed.access_token, 'access-2');
  assert.equal(requests[1].url, 'https://auth.example/auth/v1/token?grant_type=refresh_token');
  assert.deepEqual(requests[1].body, { refresh_token: 'same-refresh' });
});
