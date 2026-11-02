import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.example';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-secret';
const { persistMatch } = await import('../src/supabase.js');

test('match persistence sends a single idempotent transaction with all verified participants', async t => {
  const calls = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true }; };
  const room = {
    id: 'shared', matchId: '2a802aa5-64c9-4ca1-99f6-20e08b9202b5', mode: 'team', result: { winnerTeam: 'blue' },
    participants: [{ userId: 'verified-a', team: 'blue' }, { userId: 'verified-b', team: 'pink' }, { userId: 'dev-local', team: 'blue' }]
  };
  await persistMatch(room);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://supabase.example/rest/v1/rpc/record_match');
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.p_match_id, room.matchId);
  assert.equal(payload.p_room_id, 'shared');
  assert.deepEqual(payload.p_result, { winnerTeam: 'blue' });
  assert.deepEqual(payload.p_participants, [{ user_id: 'verified-a', team: 'blue', outcome: 'win' }, { user_id: 'verified-b', team: 'pink', outcome: 'loss' }]);
});

test('persistence handles duel draw and does not silently accept a failed response', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let body;
  globalThis.fetch = async (_, options) => { body = JSON.parse(options.body); return { ok: false, status: 503 }; };
  await assert.rejects(persistMatch({ id: 'a', matchId: 'match-1', mode: 'duel', result: { draw: true }, participants: [{ userId: 'user-a' }] }), /503/);
  assert.deepEqual(body.p_participants, [{ user_id: 'user-a', team: null, outcome: 'draw' }]);
});

test('development guest winning a duel is not written as a profile foreign key', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let body;
  globalThis.fetch = async (_, options) => { body = JSON.parse(options.body); return { ok: true }; };
  await persistMatch({ id: 'duel', matchId: 'match-2', mode: 'duel', result: { winnerId: 'dev-guest' }, participants: [{ userId: 'verified-a' }, { userId: 'dev-guest' }] });
  assert.equal(body.p_winner_id, null);
  assert.deepEqual(body.p_participants, [{ user_id: 'verified-a', team: null, outcome: 'loss' }]);
});

test('profile upsert normalizes short names, and signals a database failure', async t => {
  const { upsertProfile } = await import('../src/supabase.js');
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let body;
  globalThis.fetch = async (_, options) => { body = JSON.parse(options.body); return { ok: false, status: 503 }; };
  await assert.rejects(upsertProfile({ id: 'abcde', user_metadata: { nickname: 'X' } }, ''), /503/);
  assert.ok([...body.nickname].length >= 2 && [...body.nickname].length <= 12);
});

test('a development guest is never inserted into Supabase profiles', async t => {
  const { upsertProfile } = await import('../src/supabase.js');
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true }; };
  await upsertProfile({ id: 'dev-123', user_metadata: {} }, 'Guest');
  assert.equal(called, false);
});

test('profile name respects Unicode character count without truncating code points', async t => {
  const { upsertProfile } = await import('../src/supabase.js');
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let body;
  globalThis.fetch = async (_, options) => { body = JSON.parse(options.body); return { ok: true }; };
  await upsertProfile({ id: 'abcde', user_metadata: {} }, '😀😀😀😀😀😀😀😀😀😀😀😀😀');
  assert.equal([...body.nickname].length, 12);
  assert.equal(body.nickname, '😀'.repeat(12));
});
