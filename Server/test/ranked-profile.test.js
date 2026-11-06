import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as auth from '../src/supabase.js';
import * as rankings from '../src/rankings.js';
const env = { SUPABASE_URL: 'https://example.test', SUPABASE_SERVICE_ROLE_KEY: 'secret' };
test('ranked profile reads only the verified account and accepts a bounded integer rating', async () => {
  assert.equal(typeof auth.readRankedProfile, 'function');
  let request;
  const profile = await auth.readRankedProfile('verified-user', { env, fetchImpl: async (url, options) => {
    request = { url, options }; return { ok: true, json: async () => [{ id: 'verified-user', rating: 1390 }] };
  } });
  assert.deepEqual(profile, { rating: 1390 });
  assert.equal(new URL(request.url).searchParams.get('id'), 'eq.verified-user');
  assert.equal(new URL(request.url).searchParams.get('select'), 'id,rating');
  assert.equal(request.options.headers.Authorization, 'Bearer secret');
});
test('ranked profile fails closed on missing config, ambiguity, wrong identity or invalid ratings', async () => {
  assert.equal(typeof auth.readRankedProfile, 'function');
  await assert.rejects(auth.readRankedProfile('user', { env: {} }), /configured/);
  await assert.rejects(auth.readRankedProfile('user', { env: { SUPABASE_URL: env.SUPABASE_URL, SUPABASE_ANON_KEY: 'anon' } }), /configured/);
  for (const data of [[], [{ id: 'other', rating: 1000 }], [{ id: 'user', rating: '1000' }], [{ id: 'user', rating: -1 }], [{ id: 'user', rating: 2 ** 31 }], [{ id: 'user', rating: 1.1 }], [{ id: 'user', rating: 1000 }, { id: 'user', rating: 1000 }]]) {
    await assert.rejects(auth.readRankedProfile('user', { env, fetchImpl: async () => ({ ok: true, json: async () => data }) }), /profile/i);
  }
});
test('demo rating is obtained from server session history and never a supplied rating', async () => {
  assert.equal(typeof rankings.readDemoProfile, 'function');
  const userId = 'dev-profile-contract';
  assert.deepEqual(rankings.readDemoProfile(userId), { rating: 1000 });
  await rankings.finalizeMatch({ id: 'room', matchId: 'profile-contract', mode: 'duel', result: { winnerId: userId }, roster: [{ userId, score: 0 }, { userId: 'dev-profile-opponent', score: 0 }] }, { ALLOW_DEV_GUESTS: 'true' });
  assert.deepEqual(rankings.readDemoProfile(userId), { rating: 1016 });
});
