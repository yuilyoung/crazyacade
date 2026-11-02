import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { finalizeMatch, getLeaderboard, ratingTier } from '../src/rankings.js';
import { createRequestHandler } from '../src/http.js';

const demo = { ALLOW_DEV_GUESTS: 'true' };

test('rank tiers use the same documented rating thresholds', () => {
  assert.equal(ratingTier(1099), 'Bronze');
  assert.equal(ratingTier(1100), 'Silver');
  assert.equal(ratingTier(1250), 'Gold');
  assert.equal(ratingTier(1450), 'Diamond');
});

test('finalized demo matches award score and rating once and expose no identifiers', async () => {
  const room = { id: 'rank-room', matchId: 'ranking-test-1', mode: 'team', result: { winnerTeam: 'blue' }, roster: [
    { id: 'private-player-a', userId: 'dev-rank-a', name: 'Winner', team: 'blue', score: 250 },
    { id: 'private-player-b', userId: 'dev-rank-b', name: 'Loser', team: 'pink', score: 10 }
  ] };
  await finalizeMatch(room, demo);
  await finalizeMatch(room, demo);
  const board = await getLeaderboard(demo);
  assert.equal(board.source, 'demo');
  const winner = board.entries.find(p => p.name === 'Winner');
  assert.deepEqual(winner, { rank: 1, name: 'Winner', rating: 1025, tier: 'Bronze', wins: 1, losses: 0, draws: 0, score: 250 });
  assert.equal(board.entries.find(p => p.name === 'Loser').rating, 985);
  assert.doesNotMatch(JSON.stringify(board), /dev-rank|private-player/);
});

test('a draw is recorded separately and disconnected starters remain in the result', async () => {
  await finalizeMatch({ id: 'draw', matchId: 'ranking-draw', mode: 'team', result: { draw: true },
    players: new Map(), roster: [{ userId: 'dev-left', name: 'LeftPlayer', team: 'blue', score: 50 }] }, demo);
  const player = (await getLeaderboard(demo)).entries.find(p => p.name === 'LeftPlayer');
  assert.equal(player.draws, 1); assert.equal(player.rating, 1005); assert.equal(player.score, 50);
});

test('production rankings request only public columns and never silently fall back to demo', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let request;
  globalThis.fetch = async (url, options) => { request = { url, options }; return { ok: true, json: async () => [{ nickname: 'GoldPlayer', rating: 1300, wins: 12, losses: 2, draws: 1, score: 3600, id: 'private-id' }] }; };
  const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'public', SUPABASE_SERVICE_ROLE_KEY: 'secret' };
  const board = await getLeaderboard(env);
  assert.equal(board.source, 'supabase');
  assert.equal(board.entries[0].tier, 'Gold');
  assert.equal(board.entries[0].name, 'GoldPlayer');
  assert.doesNotMatch(JSON.stringify(board), /private-id|secret/);
  assert.match(request.url, /select=nickname,rating,wins,losses,draws,score/);
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(getLeaderboard(env), /503/);
  await assert.rejects(getLeaderboard({}), /not configured/);
});

test('leaderboard HTTP route returns safe demo data and reports unavailable production storage', async t => {
  const server = createServer(createRequestHandler({ env: demo }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/leaderboard`);
  assert.equal(res.status, 200); assert.equal((await res.json()).source, 'demo');
  const prod = createServer(createRequestHandler({ env: {} }));
  prod.listen(0, '127.0.0.1'); await once(prod, 'listening');
  t.after(() => new Promise(resolve => prod.close(resolve)));
  const error = await fetch(`http://127.0.0.1:${prod.address().port}/api/leaderboard`);
  assert.equal(error.status, 503); assert.deepEqual(await error.json(), { error: 'leaderboard_unavailable' });
});

test('demo history evicts an entire oldest batch when eight newcomers exceed its bound', async () => {
  const ranking = await import('../src/rankings.js?bounded-history');
  await ranking.finalizeMatch({ id: 'old', matchId: 'old', result: { winnerTeam: 'blue' },
    roster: Array.from({ length: 8 }, (_, i) => ({ userId: `old-${i}`, name: `Old${i}`, team: 'blue', score: 500 })) }, demo);
  // 1,000 newer entries must evict all eight old winners. Their higher rating
  // makes a failure observable through the real public top-50 API.
  for (let batch = 0; batch < 125; batch++) {
    await ranking.finalizeMatch({ id: 'new', matchId: `batch-${batch}`, result: { draw: true },
      roster: Array.from({ length: 8 }, (_, i) => ({ userId: `new-${batch}-${i}`, name: `New${batch}-${i}`, team: 'blue', score: 0 })) }, demo);
  }
  const board = await ranking.getLeaderboard(demo);
  assert.equal(board.entries.some(p => p.name.startsWith('Old')), false);
});
