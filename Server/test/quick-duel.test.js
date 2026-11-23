import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { close, provider, send, setup, waitFor } from './fixtures/relay-server.mjs';

const quick = { quickDuel: true, mode: 'duel', reconnect: true };

test('four concurrent verified quick duel members play in two separate rooms', async t => {
  const auth = await provider(t);
  const { connect, sendJoin } = await setup(t, { ...auth.env, ALLOW_DEV_GUESTS: 'false' });
  const players = await Promise.all(Array.from({ length: 4 }, () => connect()));
  const replies = await Promise.all(players.map((client, index) =>
    sendJoin(client, { ...quick, accessToken: `member-${index}` })));
  assert.ok(replies.every(reply => reply.type === 'joined' && reply.quickDuel === true));
  assert.equal(new Set(replies.map(reply => reply.roomId)).size, 2);
  await waitFor(() => players.every(client => client.state?.phase === 'playing'));
  assert.equal(new Set(players.map(client => client.state.matchId)).size, 2);
  for (const client of players) {
    const roomIds = replies.filter(reply => reply.roomId === client.state.roomId).map(reply => reply.playerId);
    assert.equal(roomIds.length, 2);
    assert.deepEqual(new Set(client.state.players.map(player => player.id)), new Set(roomIds));
    assert.equal(client.state.quickDuel, true);
  }
  const duplicate = await connect();
  assert.equal((await sendJoin(duplicate, { ...quick, accessToken: 'member-0' })).code, 'already_in_room');
});

test('quick duels only pair compatible searches and never take named friend rooms', async t => {
  const { join, connect, sendJoin } = await setup(t);
  const named = await join({ roomId: 'quick', mode: 'duel' });
  const first = await join(quick);
  const otherMap = await join({ ...quick, mapId: 'lagoon' });
  const noItems = await join({ ...quick, itemMode: false });
  const rooms = [named, first, otherMap, noItems].map(player => player.state.roomId);
  assert.equal(new Set(rooms).size, 4);
  assert.equal((await sendJoin(await connect(), { roomId: first.state.roomId })).code, 'room_unavailable');
  const second = await join({ ...quick, mapId: 'garden', itemMode: true });
  assert.equal(second.state.roomId, first.state.roomId);
  assert.equal(second.state.phase, 'playing');
  assert.ok([named, otherMap, noItems].every(player => player.state.phase === 'waiting'));
  const friend = await join({ roomId: 'quick' });
  assert.equal(friend.state.roomId, named.state.roomId);
  assert.equal(friend.state.phase, 'playing');
});

test('reserved waiters are skipped until they resume and active quick duels recover their original match', async t => {
  const { join, connect } = await setup(t);
  const original = await join(quick);
  const { roomId, playerId, resumeToken } = original.messages.find(message => message.type === 'joined');
  await close(original);
  const fresh = await join(quick);
  assert.notEqual(fresh.state.roomId, roomId);
  const resume = { roomId, playerId, resumeToken };
  const restored = await connect();
  send(restored, 'resume', resume);
  await waitFor(() => restored.state?.phase === 'waiting');
  assert.equal(restored.playerId, playerId);
  const opponent = await join(quick);
  assert.equal(opponent.state.roomId, roomId);
  const matchId = opponent.state.matchId;
  await close(restored);
  await waitFor(() => opponent.state.players.some(p => p.id === playerId && !p.connected));
  const returned = await connect();
  send(returned, 'resume', resume);
  await waitFor(() => returned.state?.phase === 'playing');
  assert.equal(returned.state.matchId, matchId);
  assert.equal(returned.playerId, playerId);
  assert.equal(returned.messages.find(m => m.type === 'joined').quickDuel, true);
  assert.equal(fresh.state.phase, 'waiting');
});

test('quick duels can fill a room at capacity, and leaving a waiting room frees its slot', async t => {
  const { join, connect, sendJoin } = await setup(t, { RUNTIME_MAX_ROOMS: '1' });
  const first = await join(quick);
  const next = await connect();
  assert.equal((await sendJoin(next, { ...quick, itemMode: false })).code, 'room_unavailable');
  const left = once(first.ws, 'close');
  send(first, 'leave');
  await left;
  const nextReply = await sendJoin(next, { ...quick, itemMode: false });
  assert.equal(nextReply.type, 'joined');
  assert.notEqual(nextReply.roomId, first.state.roomId);
  assert.equal((await join({ ...quick, itemMode: false })).state.roomId, nextReply.roomId);
  assert.equal((await sendJoin(await connect(), { ...quick, itemMode: false })).code, 'room_unavailable');
});

test('incompatible quick join requests fail before provider work', async t => {
  const auth = await provider(t);
  const { connect, sendJoin } = await setup(t, { ...auth.env, ALLOW_DEV_GUESTS: 'false' });
  const client = await connect();
  for (const bad of [{ quickDuel: 'yes' }, { roomId: '' }, { roomId: 'friends' }, { mode: 'team' }, { practice: true }]) {
    const reply = await sendJoin(client, { ...quick, accessToken: 'member', ...bad });
    assert.equal(reply.code, 'invalid_join');
  }
  assert.equal(auth.requests.length, 0);
});
