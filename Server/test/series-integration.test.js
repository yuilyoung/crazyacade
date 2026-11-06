import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { setup, provider, waitFor, send, close } from './fixtures/relay-server.mjs';

const cosmetics = players => players.map(({ id, team, characterId, skinId, orbSkinId }) => ({ id, team, characterId, skinId, orbSkinId }));
async function barrier(client) {
  const before = client.messages.filter(message => message.type === 'pong').length;
  send(client, 'ping');
  await waitFor(() => client.messages.filter(message => message.type === 'pong').length > before);
}

test('invalid party options reject before authentication and existing rooms inherit their party choice', async t => {
  const auth = await provider(t);
  const { connect, sendJoin, join } = await setup(t, { ...auth.env, ALLOW_DEV_GUESTS: 'false', RUNTIME_DRAIN_MS: '20' });
  for (const seriesMode of [null, true, 3, [], {}, '', 'unknown']) {
    const result = await sendJoin(await connect(), { mode: 'team', seriesMode, accessToken: 'unused' });
    assert.equal(result.code, 'invalid_series_mode');
  }
  for (const fields of [{ mode: 'duel' }, { mode: 'team', practice: true, training: true }]) {
    assert.equal((await sendJoin(await connect(), { ...fields, seriesMode: 'party3' })).code, 'invalid_series_mode');
  }
  assert.equal(auth.requests.length, 0);
  const first = await join({ roomId: 'inherit-party', mode: 'team', seriesMode: 'party3', mapId: 'lagoon', accessToken: 'first' });
  const second = await join({ roomId: 'inherit-party', mode: 'team', accessToken: 'second' });
  assert.equal(second.state.seriesMode, 'party3');
  assert.equal(second.state.series.id, first.state.series.id);
  assert.deepEqual(second.state.series.mapCycle, ['lagoon', 'harbor', 'festival']);
  assert.equal(second.state.ranked, false);
  assert.equal((await sendJoin(await connect(), { roomId: 'inherit-party', mode: 'team', seriesMode: 'single', accessToken: 'third' })).code, 'series_mode_mismatch');
});

test('three real socket rounds require readiness, survive reconnect, preserve cosmetics and start a fresh party explicitly', async t => {
  const { join, connect } = await setup(t, { RUNTIME_DRAIN_MS: '20' }, { tickMs: 1 });
  const clients = [];
  for (let i = 0; i < 8; i++) clients.push(await join({ roomId: 'three-rounds', mode: 'team', seriesMode: 'party3',
    mapId: 'lagoon', characterId: 'bibi', skinId: 'mint', orbSkinId: 'duck', reconnect: true }));
  const first = clients[0];
  await waitFor(() => first.state.phase === 'playing');
  const originalPlayers = cosmetics(first.state.players), seriesId = first.state.series.id;
  const firstMatch = first.state.matchId;
  send(first, 'input', { action: 'not-an-action', rescues: 999, itemsCollected: 999, progress: { blue: 999 }, points: { blue: 999 } });
  await waitFor(() => first.state.phase === 'finished');
  assert.deepEqual(first.state.series.points, { blue: 1, pink: 1 });
  assert.deepEqual(first.state.series.mission.progress, { blue: 0, pink: 0 });
  assert.equal(first.state.series.contributions.length, 8);
  assert.equal(first.state.series.history[0].contributions.length, 8);
  assert.deepEqual(first.state.series.contributions.map(entry => entry.playerId), originalPlayers.map(entry => entry.id));
  assert.equal(first.state.resultSaving.status, 'unranked');
  send(first, 'rematch', { matchId: firstMatch, ready: true });
  await waitFor(() => first.state.rematch.readyPlayerIds.length === 1);
  const states = first.messages.filter(message => message.type === 'state').length;
  send(first, 'rematch', { matchId: firstMatch, ready: true });
  await barrier(first);
  assert.equal(first.messages.filter(message => message.type === 'state').length, states, 'duplicate readiness produces no extra broadcast');
  send(first, 'rematch', { matchId: firstMatch, ready: false });
  await waitFor(() => first.state.rematch.readyPlayerIds.length === 0);

  const departing = clients[7], reservation = departing.messages.find(message => message.type === 'joined');
  await close(departing);
  await waitFor(() => first.state.players.find(player => player.id === departing.playerId).connected === false);
  for (const client of clients.slice(0, 7)) send(client, 'rematch', { matchId: firstMatch });
  await waitFor(() => first.state.rematch.readyPlayerIds.length === 7);
  assert.equal(first.state.series.round, 1);
  assert.equal(first.state.phase, 'finished');
  const resumed = await connect();
  send(resumed, 'resume', { roomId: reservation.roomId, playerId: reservation.playerId, resumeToken: reservation.resumeToken });
  await waitFor(() => resumed.state);
  clients[7] = resumed;
  send(resumed, 'rematch', { matchId: firstMatch });
  await waitFor(() => first.state.series.round === 2);
  assert.equal(first.state.mapId, 'harbor');
  assert.equal(first.state.series.id, seriesId);
  assert.deepEqual(cosmetics(first.state.players), originalPlayers);
  assert.equal(first.state.series.history[0].matchId, firstMatch);

  await waitFor(() => first.state.phase === 'finished');
  const secondMatch = first.state.matchId;
  send(first, 'rematch', { matchId: firstMatch });
  await barrier(first);
  assert.equal(first.state.rematch.readyPlayerIds.length, 0, 'stale result cannot ready the new round');
  assert.equal(first.messages.some(message => message.type === 'error' && message.code === 'stale_match'), true);
  for (const client of clients) send(client, 'rematch', { matchId: secondMatch });
  await waitFor(() => first.state.series.round === 3);
  assert.equal(first.state.mapId, 'festival');
  assert.deepEqual(cosmetics(first.state.players), originalPlayers);
  await waitFor(() => first.state.phase === 'finished');
  assert.equal(first.state.series.complete, true);
  assert.deepEqual(first.state.series.points, { blue: 3, pink: 3 });
  assert.deepEqual(first.state.series.outcome, { draw: true });
  assert.equal(first.state.series.history.length, 3);
  assert.equal(first.state.series.contributions.length, 8);
  assert.ok(first.state.series.contributions.every(entry => entry.score === 0 && entry.rescues === 0));
  assert.doesNotMatch(JSON.stringify(first.state.series), /userId|accessToken|resumeToken|socket/);
  assert.equal(new Set(first.state.series.history.map(round => round.matchId)).size, 3);
  assert.deepEqual(first.state.series.history.map(round => round.mapId), ['lagoon', 'harbor', 'festival']);
  assert.deepEqual(first.state.series.history.map(round => round.mission.kind), ['rescues', 'items', 'rescues']);
  await barrier(first);
  assert.equal(first.state.series.id, seriesId, 'completion alone cannot start another party');
  const completedMatch = first.state.matchId;
  for (const client of clients) send(client, 'rematch', { matchId: completedMatch });
  await waitFor(() => first.state.series.id !== seriesId);
  assert.equal(first.state.series.round, 1);
  assert.equal(first.state.series.complete, false);
  assert.equal(first.state.series.history.length, 0);
  assert.deepEqual(first.state.series.contributions, []);
  assert.deepEqual(first.state.series.points, { blue: 0, pink: 0 });
  assert.equal(first.state.mapId, 'lagoon');
  assert.equal(first.state.round, 3);
  assert.deepEqual(cosmetics(first.state.players), originalPlayers);
});

test('personal AI parties continue all three rounds on one socket with the same bots', async t => {
  const { join } = await setup(t, { RUNTIME_DRAIN_MS: '20' }, { tickMs: 1 });
  const owner = await join({ practice: true, mode: 'team', seriesMode: 'party3', mapId: 'festival',
    itemMode: false, characterId: 'bibi', skinId: 'mint', orbSkinId: 'duck' });
  const originalPlayers = cosmetics(owner.state.players), partyId = owner.state.series.id;
  assert.equal(owner.state.rematch.total, 1);
  for (let round = 1; round <= 3; round++) {
    await waitFor(() => owner.state.phase === 'finished' && owner.state.series.round === round);
    assert.equal(owner.state.series.history.length, round);
    assert.equal(owner.state.resultSaving.status, 'unranked');
    assert.deepEqual(cosmetics(owner.state.players), originalPlayers);
    assert.equal(owner.state.series.mission.kind, 'rescues');
    if (round < 3) {
      send(owner, 'rematch', { matchId: owner.state.matchId, ready: true });
      await waitFor(() => owner.state.series.round === round + 1);
      assert.equal(owner.state.series.id, partyId);
    }
  }
  assert.equal(owner.state.series.complete, true);
  send(owner, 'rematch', { matchId: owner.state.matchId });
  await waitFor(() => owner.state.series.id !== partyId);
  assert.equal(owner.state.series.round, 1);
  assert.equal(owner.ws.readyState, owner.ws.OPEN);
  assert.deepEqual(cosmetics(owner.state.players), originalPlayers);
});

test('authenticated all-human party results never write ranked results or outbox files', async t => {
  const auth = await provider(t);
  const server = await setup(t, { ...auth.env, ALLOW_DEV_GUESTS: 'false', RUNTIME_DRAIN_MS: '20' }, { tickMs: 1 });
  const clients = [];
  for (let i = 0; i < 8; i++) clients.push(await server.join({ roomId: 'production-party', mode: 'team', seriesMode: 'party3', accessToken: `party-${i}` }));
  await waitFor(() => clients[0].state.phase === 'finished');
  assert.equal(clients[0].state.resultSaving.status, 'unranked');
  assert.equal(auth.requests.filter(request => request.path === '/auth/v1/user').length, 8);
  assert.equal(auth.requests.filter(request => request.path === '/rest/v1/rpc/record_match').length, 0);
  assert.equal((await readdir(server.outboxDirectory)).some(file => file.endsWith('.json')), false);
});
