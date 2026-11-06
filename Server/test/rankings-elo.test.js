import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeMatch, readDemoProfile, getLeaderboard } from '../src/rankings.js';
const env = { ALLOW_DEV_GUESTS: 'true' };
const duel = (matchId, a, b, winnerId) => ({ id: 'elo-demo', matchId, mode: 'duel', result: winnerId ? { winnerId } : { draw: true },
  roster: [a, b].map(userId => ({ userId, name: userId.slice(-12), score: 10 })) });

test('demo Elo reads both latest stored ratings and retries never apply a result twice', async () => {
  const a = 'dev-elo-alice', b = 'dev-elo-bob';
  await finalizeMatch(duel('elo-first', a, b, a), env);
  assert.deepEqual([readDemoProfile(a).rating, readDemoProfile(b).rating], [1016, 984]);
  await finalizeMatch(duel('elo-first', a, b, b), env);
  assert.deepEqual([readDemoProfile(a).rating, readDemoProfile(b).rating], [1016, 984]);
  await finalizeMatch(duel('elo-second', a, b, b), env);
  assert.deepEqual([readDemoProfile(a).rating, readDemoProfile(b).rating], [999, 1001]);
});

test('demo team Elo snapshots means before updating any teammate', async () => {
  const a = 'dev-team-a', b = 'dev-team-b', x = 'dev-team-x', y = 'dev-team-y';
  await finalizeMatch(duel('seed-team-elo', a, b, a), env);
  await finalizeMatch({ id: 'team-means', matchId: 'team-means', mode: 'team', result: { winnerTeam: 'blue' }, roster: [
    { userId: a, team: 'blue' }, { userId: b, team: 'pink' }, { userId: x, team: 'blue' }, { userId: y, team: 'pink' }
  ] }, env);
  assert.deepEqual([a, b, x, y].map(userId => readDemoProfile(userId).rating), [1031, 969, 1015, 985]);
});

test('equal draws do not inflate ratings and unequal draws move them toward each other', async () => {
  const a = 'dev-draw-a', b = 'dev-draw-b';
  await finalizeMatch(duel('elo-draw-equal', a, b), env);
  assert.deepEqual([readDemoProfile(a).rating, readDemoProfile(b).rating], [1000, 1000]);
  await finalizeMatch(duel('elo-draw-seed', a, b, a), env);
  await finalizeMatch(duel('elo-draw-unequal', a, b), env);
  assert.deepEqual([readDemoProfile(a).rating, readDemoProfile(b).rating], [1015, 985]);
});

test('legacy partial results preserve history without inventing an opposing rating', async () => {
  const userId = 'dev-partial';
  await finalizeMatch({ id: 'partial', matchId: 'elo-partial', mode: 'team', result: { winnerTeam: 'blue' },
    roster: [{ userId, name: 'Partial', team: 'blue', score: 70 }] }, env);
  assert.equal(readDemoProfile(userId).rating, 1000);
  const profile = (await getLeaderboard(env)).entries.find(entry => entry.name === 'Partial');
  assert.equal(profile.wins, 1); assert.equal(profile.score, 70);
});

test('malformed demo rosters cannot partially update profiles or consume a match identity', async () => {
  const a = 'dev-invalid-a', b = 'dev-invalid-b';
  const invalid = duel('elo-invalid', a, b, a);
  invalid.roster[1].userId = a;
  await assert.rejects(finalizeMatch(invalid, env), /participant|duplicate|identity/i);
  assert.equal(readDemoProfile(a).rating, 1000);
  await finalizeMatch(duel('elo-invalid', a, b, a), env);
  assert.equal(readDemoProfile(a).rating, 1016);
});
