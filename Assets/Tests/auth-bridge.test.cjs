const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function makeBridge(storage, fetch) {
  let resolve;
  const result = new Promise(r => { resolve = r; });
  const context = { LibraryManager: { library: {} }, mergeInto: Object.assign, UTF8ToString: x => x,
    window: { sessionStorage: storage }, fetch, Date,
    SendMessage: (_object, _callback, message) => resolve(JSON.parse(message)) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../Plugins/WebGL/PopPopSupabase.jslib'), 'utf8'), context);
  context.LibraryManager.library.PPP_AnonymousLogin('https://example.supabase.co', 'anon', 'auth', 'OnAuth');
  return result;
}
function memoryStorage() {
  const m = new Map();
  return { getItem: k => m.get(k) ?? null, setItem: (k,v) => m.set(k,v) };
}

test('login reuses the existing anonymous session across scene reloads', async () => {
  const storage = memoryStorage(); let calls = 0;
  const fetch = async () => { calls++; return { ok: true, json: async () => ({ access_token: 'first', refresh_token: 'refresh', expires_in: 3600 }) }; };
  assert.equal((await makeBridge(storage, fetch)).access_token, 'first');
  assert.equal((await makeBridge(storage, fetch)).access_token, 'first');
  assert.equal(calls, 1);
});

test('expired anonymous session is refreshed without creating a new account', async () => {
  const storage = memoryStorage(); let calls = 0;
  const fetch = async (url, options) => {
    calls++;
    if (calls === 1) return { ok: true, json: async () => ({ access_token: 'expired', refresh_token: 'old-refresh', expires_at: 1 }) };
    assert.ok(url.endsWith('/auth/v1/token?grant_type=refresh_token'));
    assert.equal(JSON.parse(options.body).refresh_token, 'old-refresh');
    return { ok: true, json: async () => ({ access_token: 'renewed', refresh_token: 'new-refresh', expires_in: 3600 }) };
  };
  await makeBridge(storage, fetch);
  assert.equal((await makeBridge(storage, fetch)).access_token, 'renewed');
  assert.equal((await makeBridge(storage, fetch)).access_token, 'renewed');
  assert.equal(calls, 2);
});

test('failed refresh reports an error without silently replacing the identity', async () => {
  const storage = memoryStorage(); let calls = 0;
  const fetch = async () => {
    calls++;
    if (calls === 1) return { ok: true, json: async () => ({ access_token: 'expired', refresh_token: 'old-refresh', expires_at: 1 }) };
    return { ok: false, json: async () => ({ error: 'invalid_refresh_token' }) };
  };
  await makeBridge(storage, fetch);
  assert.equal((await makeBridge(storage, fetch)).error, 'auth_request_failed');
  assert.equal(calls, 2);
});
