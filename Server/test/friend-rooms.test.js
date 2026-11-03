import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { finalizeMatch, getLeaderboard } from '../src/rankings.js';
import { setup, provider, waitFor, send, close } from './fixtures/relay-server.mjs';

test('human quotas and team choices reject malformed input before authentication', async t => {
  const auth = await provider(t);
  const { connect, sendJoin } = await setup(t, { ...auth.env, ALLOW_DEV_GUESTS: 'false' });
  for (const humanSlots of [null, true, '2', 0, 1, 3, 9, [], {}]) {
    assert.equal((await sendJoin(await connect(), { mode: 'team', humanSlots, accessToken: 'unused' })).code, 'invalid_human_slots');
  }
  assert.equal((await sendJoin(await connect(), { mode: 'duel', humanSlots: 4 })).code, 'invalid_human_slots');
  for (const teamPreference of [null, 'red', true, {}, []]) {
    assert.equal((await sendJoin(await connect(), { mode: 'team', humanSlots: 2, teamPreference })).code, 'invalid_team_preference');
  }
  assert.equal((await sendJoin(await connect(), { mode: 'team', teamPreference: 'blue' })).code, 'invalid_team_preference');
  assert.equal(auth.requests.length, 0);
});

test('2, 4 and 6 human rooms inherit settings, start full 4v4, and reject extra participants', async t => {
  const { join, connect, sendJoin } = await setup(t);
  for (const humanSlots of [2, 4, 6]) {
    const roomId = `friends-${humanSlots}`;
    const first = await join({ roomId, mode: 'team', humanSlots, teamPreference: 'blue', mapId: 'candy', itemMode: false });
    assert.equal(first.state.phase, 'waiting');
    assert.equal(first.state.humanSlots, humanSlots);
    assert.equal(first.state.withBots, true);
    assert.equal(first.state.ranked, false);
    assert.equal(first.state.players.length, 1);
    assert.equal((await sendJoin(await connect(), { roomId, mode: 'team', humanSlots: 8 })).code, 'human_slots_mismatch');
    for (let index = 1; index < humanSlots; index++) await join({ roomId, mode: 'team' });
    await waitFor(() => first.state.phase === 'playing');
    assert.equal(first.state.players.length, 8);
    assert.equal(first.state.players.filter(p => p.isBot).length, 8 - humanSlots);
    assert.equal(first.state.players.filter(p => p.team === 'blue').length, 4);
    assert.equal(first.state.players.filter(p => p.team === 'pink').length, 4);
    assert.equal(first.state.mapId, 'candy');
    assert.equal(first.state.itemMode, false);
    assert.equal(first.state.rematch.total, humanSlots);
    assert.equal((await sendJoin(await connect(), { roomId, mode: 'team' })).code, 'room_unavailable');
  }
  const ranked = await join({ roomId: 'ordinary', mode: 'team' });
  assert.equal(ranked.state.humanSlots, 8);
  assert.equal(ranked.state.withBots, false);
  assert.equal(ranked.state.ranked, true);
});

test('friends can share a team, while reserved humans still occupy team and room slots', async t => {
  const { join, connect, sendJoin } = await setup(t);
  const roomId = 'same-team';
  const clients = [];
  for (let index = 0; index < 4; index++) clients.push(await join({ roomId, mode: 'team', humanSlots: 6, teamPreference: 'blue', reconnect: true }));
  assert.ok(clients[3].state.players.every(p => p.team === 'blue'));
  const reservation = clients[0].messages.find(m => m.type === 'joined');
  await close(clients[0]);
  assert.equal((await sendJoin(await connect(), { roomId, mode: 'team', teamPreference: 'blue' })).code, 'team_full');
  await join({ roomId, mode: 'team', teamPreference: 'pink' });
  const last = await join({ roomId, mode: 'team', teamPreference: 'auto' });
  assert.equal(last.state.phase, 'waiting');
  assert.equal(last.state.players.length, 6);
  assert.equal((await sendJoin(await connect(), { roomId, mode: 'team' })).code, 'room_unavailable');
  const resumed = await connect();
  send(resumed, 'resume', { roomId, playerId: reservation.playerId, resumeToken: reservation.resumeToken });
  await waitFor(() => resumed.state?.phase === 'playing');
  assert.equal(resumed.state.players.length, 8);
  assert.equal(resumed.state.players.find(p => p.id === reservation.playerId).team, 'blue');
});

test('mixed friend rooms retain authentication and never enqueue production or demo results', async t => {
  const auth = await provider(t);
  const server = await setup(t, { ...auth.env, ALLOW_DEV_GUESTS: 'false' }, { tickMs: 1 });
  const denied = await server.sendJoin(await server.connect(), { mode: 'team', humanSlots: 2 });
  assert.equal(denied.code, 'unauthorized');
  const first = await server.join({ roomId: 'verified-friends', mode: 'team', humanSlots: 2, accessToken: 'first' });
  await server.join({ roomId: 'verified-friends', mode: 'team', accessToken: 'second' });
  await waitFor(() => first.state.phase === 'finished');
  assert.equal(first.state.resultSaving.status, 'unranked');
  assert.equal(auth.requests.filter(r => r.path === '/auth/v1/user').length, 2);
  assert.equal(auth.requests.filter(r => r.path === '/rest/v1/rpc/record_match').length, 0);
  assert.equal((await readdir(server.outboxDirectory)).filter(f => f.endsWith('.json')).length, 0);
  const snapshot = { withBots: true, matchId: 'friends-demo', roster: [{ userId: 'friend-demo', name: 'FriendOnly', team: 'blue', score: 200 }], result: { winnerTeam: 'blue' } };
  await finalizeMatch(snapshot, { ALLOW_DEV_GUESTS: 'true' });
  assert.equal((await getLeaderboard({ ALLOW_DEV_GUESTS: 'true' })).entries.some(p => p.name === 'FriendOnly'), false);
});

test('only humans vote for a mixed rematch and missing humans wait for replacements', async t => {
  const { join } = await setup(t, {}, { tickMs: 1 });
  const first = await join({ roomId: 'rematch-friends', mode: 'team', humanSlots: 2 });
  const second = await join({ roomId: 'rematch-friends', mode: 'team' });
  await waitFor(() => first.state.phase === 'finished');
  const previousMatch = first.state.matchId;
  const previousBots = first.state.players.filter(p => p.isBot).map(p => p.id);
  send(first, 'rematch');
  await waitFor(() => first.state.rematch.readyPlayerIds.length === 1);
  assert.equal(first.state.phase, 'finished');
  send(second, 'rematch');
  await waitFor(() => first.state.round === 1);
  assert.equal(first.state.players.length, 8);
  assert.notEqual(first.state.matchId, previousMatch);
  assert.ok(first.state.players.filter(p => p.isBot).every(p => !previousBots.includes(p.id)));
  await waitFor(() => first.state.phase === 'finished');
  await close(second);
  send(first, 'rematch');
  await waitFor(() => first.state.round === 2);
  assert.equal(first.state.phase, 'waiting');
  assert.equal(first.state.players.length, 1);
  await join({ roomId: 'rematch-friends', mode: 'team' });
  await waitFor(() => first.state.phase === 'playing');
  assert.equal(first.state.players.length, 8);
});

test('last-human departure deletes bot rooms and the shared bot-room limit recovers capacity', async t => {
  const { join, connect, sendJoin } = await setup(t);
  const clients = [];
  for (let index = 0; index < 16; index++) clients.push(await join({ roomId: `bounded-${index}`, mode: 'team', humanSlots: 2 }));
  assert.equal((await sendJoin(await connect(), { roomId: 'over-limit', mode: 'team', humanSlots: 2 })).code, 'bot_rooms_unavailable');
  const peer = await join({ roomId: 'bounded-0', mode: 'team' });
  await close(clients[0]);
  await close(peer);
  const reclaimed = await join({ roomId: 'bounded-0', mode: 'team', humanSlots: 4 });
  assert.equal(reclaimed.state.humanSlots, 4);
  assert.equal(reclaimed.state.phase, 'waiting');
  assert.equal(reclaimed.state.players.length, 1);
});

test('the last human reservation survives reconnect, then expires without orphaned bots', async t => {
  const clock = 'const now = Date.now.bind(Date); const origin = now(); Date.now = () => origin + (now() - origin) * 100;';
  const { join, connect, sendJoin } = await setup(t, {}, { tickMs: 5, preload: clock });
  const first = await join({ roomId: 'last-reservation', mode: 'team', humanSlots: 2, reconnect: true });
  const second = await join({ roomId: 'last-reservation', mode: 'team' });
  const token = first.messages.find(m => m.type === 'joined');
  const credentials = { roomId: token.roomId, playerId: token.playerId, resumeToken: token.resumeToken };
  await close(second);
  await close(first);
  const resumed = await connect();
  send(resumed, 'resume', credentials);
  await waitFor(() => resumed.state);
  assert.equal(resumed.state.matchId, first.state.matchId);
  assert.equal(resumed.state.players.filter(p => p.isBot).length, 6);
  await close(resumed);
  await new Promise(resolve => setTimeout(resolve, 400));
  const expired = await connect();
  send(expired, 'resume', credentials);
  await waitFor(() => expired.messages.some(m => m.type === 'error'));
  assert.equal(expired.messages.find(m => m.type === 'error').code, 'resume_unavailable');
  const fresh = await connect();
  assert.equal((await sendJoin(fresh, { roomId: token.roomId, mode: 'team', humanSlots: 4 })).type, 'joined');
  await waitFor(() => fresh.state);
  assert.equal(fresh.state.humanSlots, 4);
  assert.equal(fresh.state.players.length, 1);
});
