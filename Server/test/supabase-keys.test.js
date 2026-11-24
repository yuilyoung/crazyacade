import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountService } from '../src/account-service.js';
import { createAuthProvider, persistMatchPayload, readLeaderboard, readRankedProfile } from '../src/supabase.js';

test('opaque app keys authenticate member, profile, ranking and match requests with the appropriate headers', async t => {
  const publicKey = 'sb_publishable_fixture', serverKey = 'sb_secret_fixture';
  const env = { SUPABASE_URL: 'https://fixture.example', SUPABASE_ANON_KEY: publicKey, SUPABASE_SERVICE_ROLE_KEY: serverKey };
  const userId = '11111111-1111-4111-8111-111111111111';
  const user = { id: userId, email: 'member@example.test' };
  const timestamp = '2026-01-01T00:00:00Z';
  const profile = { id: userId, nickname: 'Member', rating: 1000, wins: 0, draws: 0, losses: 0, score: 0, created_at: timestamp, updated_at: timestamp };
  const requests = [];
  const fetchImpl = async (url, options) => {
    const { pathname, searchParams } = new URL(url);
    requests.push({ pathname, method: options.method ?? 'GET', headers: options.headers });
    if (pathname === '/auth/v1/user') return Response.json(user);
    if (pathname === '/rest/v1/rpc/record_match' || options.method === 'POST') return new Response(null, { status: 204 });
    if (pathname === '/rest/v1/profiles') {
      return Response.json(searchParams.get('select') === 'id,rating' ? [{ id: userId, rating: profile.rating }] : [profile]);
    }
    throw Error('Unexpected fixture path');
  };
  t.mock.method(globalThis, 'fetch', fetchImpl);
  const auth = createAuthProvider({ env, fetchImpl });
  await auth.upsertProfile(user, 'Member');
  await createAccountService({ env, fetchImpl }).updateProfile('member-jwt', { nickname: 'Member' });
  await readRankedProfile(userId, { env, fetchImpl });
  await persistMatchPayload({}, { env, fetchImpl });
  await readLeaderboard(env);

  const authentication = requests.find(request => request.pathname === '/auth/v1/user');
  assert.equal(authentication.headers.apikey, serverKey);
  assert.equal(authentication.headers.Authorization, 'Bearer member-jwt');
  const board = requests.at(-1);
  assert.equal(board.headers.apikey, publicKey);
  assert.equal(board.headers.Authorization, undefined);
  const storage = requests.slice(0, -1).filter(request => request.pathname.startsWith('/rest/v1/'));
  assert.deepEqual(storage.map(request => [request.method, request.pathname]), [
    ['POST', '/rest/v1/profiles'], ['GET', '/rest/v1/profiles'], ['PATCH', '/rest/v1/profiles'],
    ['GET', '/rest/v1/profiles'], ['POST', '/rest/v1/rpc/record_match']
  ]);
  for (const request of storage) {
    assert.equal(request.headers.apikey, serverKey);
    assert.equal(request.headers.Authorization, undefined);
  }
});
