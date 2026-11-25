import { test } from 'node:test';
import assert from 'node:assert/strict';
import { close, send, setup, waitFor } from './fixtures/relay-server.mjs';
import { projectArena } from '../public/arena-viewmodel.js';

const stats = ({ maxOrbs, range, speedLevel, moveCooldownTicks, darts, rescueNeedles, itemsCollected, score }) =>
  ({ maxOrbs, range, speedLevel, moveCooldownTicks, darts, rescueNeedles, itemsCollected, score });
const basic = { maxOrbs: 1, range: 3, speedLevel: 0, moveCooldownTicks: 2, darts: 0, rescueNeedles: 0, itemsCollected: 0, score: 0 };

test('one starting upgrade applies only to the human in each AI item match', async t => {
  const { join } = await setup(t);
  for (const [selection, expected] of [
    [{}, basic],
    [{ practiceItemId: 'orb' }, { ...basic, maxOrbs: 2 }],
    [{ practiceItemId: 'wave' }, { ...basic, range: 4 }],
    [{ practiceItemId: 'dash' }, { ...basic, speedLevel: 1, moveCooldownTicks: 1 }],
    [{ practiceItemId: 'dart' }, { ...basic, darts: 1 }],
    [{ practiceItemId: 'needle' }, { ...basic, rescueNeedles: 1 }],
  ]) {
    const client = await join({ practice: true, ...selection });
    const state = client.messages.find(m => m.type === 'state');
    assert.equal(state.ranked, false);
    assert.deepEqual(stats(state.players.find(p => p.id === client.playerId)), expected);
    for (const bot of state.players.filter(p => p.isBot)) assert.deepEqual(stats(bot), basic);
  }
});

test('invalid items and ineligible rooms reject the selection without claiming a place', async t => {
  const { connect, sendJoin } = await setup(t);
  const client = await connect();
  for (const fields of [
    { practiceItemId: 'orb' },
    { mode: 'team', humanSlots: 2, practiceItemId: 'wave' },
    { practice: true, itemMode: false, practiceItemId: 'orb' },
    { practice: true, training: true, practiceItemId: 'dash' },
    { practiceItemId: 'needle' },
    ...[null, {}, ['orb'], 'pin', 'none'].map(practiceItemId => ({ practice: true, practiceItemId })),
  ]) {
    const reply = await sendJoin(client, fields);
    assert.equal(reply.code, 'invalid_selection', JSON.stringify(fields));
  }
  send(client, 'queue_join', { requestId: 'ranked-test', practiceItemId: 'wave' });
  await waitFor(() => client.messages.some(m => m.requestId === 'ranked-test'));
  assert.equal(client.messages.find(m => m.requestId === 'ranked-test').code, 'invalid_queue');
  assert.equal((await sendJoin(client, { practice: true })).type, 'joined');
});

test('the range upgrade affects placed orbs and does not stack on resume', async t => {
  const { join, connect } = await setup(t);
  const first = await join({ practice: true, practiceItemId: 'wave', reconnect: true });
  const { roomId, playerId, resumeToken } = first.messages.find(m => m.type === 'joined');
  await close(first);
  const resumed = await connect();
  send(resumed, 'resume', { roomId, playerId, resumeToken });
  await waitFor(() => resumed.state);
  send(resumed, 'input', { action: 'place_orb' });
  await waitFor(() => resumed.state.players.find(p => p.id === playerId)?.bombsPlaced === 1);
  const player = resumed.state.players.find(p => p.id === playerId);
  assert.equal(player.range, 4);
  assert.equal(resumed.state.orbs.find(o => o.x === player.x && o.y === player.y)?.range, 4);
});

test('subsequent AI party rounds reapply the equipped starter once', async t => {
  const { join } = await setup(t, {}, { tickMs: 1 });
  const owner = await join({ practice: true, seriesMode: 'party3', practiceItemId: 'orb' });
  await waitFor(() => owner.state.phase === 'finished');
  send(owner, 'rematch', { matchId: owner.state.matchId, ready: true });
  const nextRound = () => owner.messages.find(m => m.type === 'state' && m.series?.round === 2 && m.phase === 'playing');
  await waitFor(nextRound);
  const human = nextRound().players.find(p => p.id === owner.playerId);
  assert.deepEqual(stats(human), { ...basic, maxOrbs: 2 });
});

test('a fired starter dart remains spent after reconnecting', async t => {
  const { join, connect } = await setup(t);
  function dartSlot(client) {
    const view = projectArena(client.state, { playerId: client.playerId, connection: 'connected' });
    const { value, canUse } = view.inventory.find(item => item.id === 'dart');
    return { value, canUse };
  }
  const first = await join({ practice: true, practiceItemId: 'dart', reconnect: true });
  const { roomId, playerId, resumeToken } = first.messages.find(m => m.type === 'joined');
  assert.equal(first.state.players.find(p => p.id === playerId).darts, 1);
  assert.deepEqual(dartSlot(first), { value: 1, canUse: true });
  send(first, 'input', { action: 'use_dart' });
  await waitFor(() => first.state.players.find(p => p.id === playerId).darts === 0);
  await close(first);
  const resumed = await connect();
  send(resumed, 'resume', { roomId, playerId, resumeToken });
  await waitFor(() => resumed.state);
  assert.equal(resumed.state.players.find(p => p.id === playerId).darts, 0);
  assert.deepEqual(dartSlot(resumed), { value: 0, canUse: false });
});
