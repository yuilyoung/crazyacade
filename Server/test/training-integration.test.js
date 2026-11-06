import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, provider, waitFor, send, close } from './fixtures/relay-server.mjs';

const human = client => client.state.players.find(p => p.id === client.playerId);
async function startLesson(client) {
  assert.equal(client.state.training.status, 'ready');
  send(client, 'training_ready');
  await waitFor(() => client.state.training.status === 'active');
}
async function move(client, direction) {
  const deltas = { up: [0, 1], down: [0, -1], left: [-1, 0], right: [1, 0] };
  const [dx, dy] = deltas[direction], x = human(client).x + dx, y = human(client).y + dy;
  send(client, 'input', { action: direction });
  await waitFor(() => human(client).x === x && human(client).y === y);
}
async function escapeBomb(client) {
  const before = human(client).bombsPlaced;
  send(client, 'input', { action: 'place_orb' });
  await waitFor(() => human(client).bombsPlaced > before);
  await move(client, 'up'); await move(client, 'up'); await move(client, 'right');
}

test('training flags reject malformed and non-practice requests before authentication', async t => {
  const auth = await provider(t);
  const { connect, sendJoin } = await setup(t, { ...auth.env, ALLOW_DEV_GUESTS: 'false' });
  for (const training of [null, 0, 'true', {}, []]) {
    assert.equal((await sendJoin(await connect(), { practice: true, training })).code, 'invalid_training');
  }
  assert.equal((await sendJoin(await connect(), { training: true, accessToken: 'unused' })).code, 'invalid_training');
  const stranger = await connect();
  send(stranger, 'training_ready');
  assert.equal((await sendJoin(stranger, { mode: 'team', humanSlots: 2 })).code, 'unauthorized');
  assert.equal(auth.requests.length, 0);
});

test('training uses a private fixed garden, frozen targets and a three-minute clock', async t => {
  const auth = await provider(t);
  const { join, connect, sendJoin } = await setup(t, { ...auth.env, ALLOW_DEV_GUESTS: 'false' }, { tickMs: 5 });
  const client = await join({ practice: true, training: true, mode: 'duel', mapId: 'candy', itemMode: false, ruleSet: 'relay' });
  assert.equal(client.state.mode, 'team');
  assert.equal(client.state.mapId, 'garden');
  assert.equal(client.state.itemMode, true);
  assert.equal(client.state.ruleSet, 'classic');
  assert.equal(client.state.humanSlots, 1);
  assert.equal(client.state.ranked, false);
  assert.equal(client.state.players.filter(p => p.isBot).length, 7);
  assert.equal(client.state.remaining, 1800);
  assert.equal(client.state.remainingSeconds, 180);
  assert.equal(client.state.training.stage, 'escape');
  assert.equal(client.state.training.total, 4);
  assert.equal(client.state.training.status, 'ready');
  const positions = client.state.players.filter(p => p.isBot).map(p => [p.id, p.x, p.y]);
  const initialTick = client.state.tick;
  send(client, 'input', { action: 'training_complete' });
  send(client, 'training_complete', { completed: 4 });
  send(client, 'input', { action: 'place_orb' });
  send(client, 'input', { action: 'up' });
  await waitFor(() => client.state.tick >= initialTick + 30);
  assert.deepEqual(client.state.players.filter(p => p.isBot).map(p => [p.id, p.x, p.y]), positions);
  assert.equal(client.state.orbs.length, 0);
  assert.equal(client.state.training.completed, 0);
  assert.equal(client.state.training.status, 'ready');
  assert.deepEqual([human(client).x, human(client).y, human(client).bombsPlaced], [1, 1, 0]);
  await startLesson(client);
  const started = client.state.tick;
  await waitFor(() => client.state.tick >= started + 5);
  assert.deepEqual([human(client).x, human(client).y, human(client).bombsPlaced], [1, 1, 0]);
  assert.equal(auth.requests.length, 0);
  const intruder = await connect();
  assert.equal((await sendJoin(intruder, { roomId: client.state.roomId, mode: 'team', accessToken: 'intruder' })).code, 'room_unavailable');
});

test('real bombs, deterministic pickups, touch rescue and a ranged dart complete training', async t => {
  const { join } = await setup(t, {}, { tickMs: 10 });
  const client = await join({ practice: true, training: true });
  await startLesson(client);
  await escapeBomb(client);
  await waitFor(() => client.state.training.stage === 'item');
  assert.equal(human(client).bombsPlaced, 1);
  await startLesson(client);
  await escapeBomb(client);
  await waitFor(() => !client.state.orbs.length && !client.state.waves.length);
  assert.deepEqual(client.state.items.map(item => [item.x, item.y, item.type]), [[3, 1, 'wave']]);
  await move(client, 'left'); await move(client, 'down'); await move(client, 'down');
  await move(client, 'right');
  // Collecting the second cell resets the player for the next drill.
  send(client, 'input', { action: 'right' });
  await waitFor(() => client.state.training.stage === 'rescue');
  assert.equal(human(client).itemsCollected, 1);
  assert.equal(client.state.training.completed, 2);
  const rescueStart = client.state.tick;
  send(client, 'input', { action: 'right' });
  await waitFor(() => client.state.tick >= rescueStart + 30);
  assert.equal(client.state.training.status, 'ready');
  assert.equal(human(client).x, 1);
  assert.equal(client.state.players.find(p => p.isBot && p.x === 3 && p.y === 1).bubbleTicks, 100);
  await startLesson(client);
  await waitFor(() => client.state.players.find(p => p.isBot && p.x === 3 && p.y === 1).bubbleTicks <= 95);
  const bubbleBeforeDuplicate = client.state.players.find(p => p.isBot && p.x === 3 && p.y === 1).bubbleTicks;
  send(client, 'training_ready');
  const duplicateTick = client.state.tick;
  await waitFor(() => client.state.tick > duplicateTick);
  assert.ok(client.state.players.find(p => p.isBot && p.x === 3 && p.y === 1).bubbleTicks < bubbleBeforeDuplicate);
  send(client, 'input', { action: 'right' });
  await waitFor(() => client.state.training.stage === 'dart');
  assert.equal(human(client).rescues, 1);
  assert.equal(human(client).darts, 1);
  send(client, 'input', { action: 'use_dart' });
  const dartReadyTick = client.state.tick;
  await waitFor(() => client.state.tick >= dartReadyTick + 5);
  assert.equal(human(client).darts, 1);
  assert.equal(human(client).rescues, 1);
  await startLesson(client);
  send(client, 'input', { action: 'use_dart' });
  await waitFor(() => client.state.phase === 'finished');
  assert.equal(client.state.training.stage, 'complete');
  assert.equal(client.state.training.completed, 4);
  assert.equal(client.state.result.reason, 'training_complete');
  assert.equal(client.state.resultSaving.status, 'unranked');
  assert.equal(human(client).rescues, 2);
  assert.equal(human(client).darts, 0);
  assert.equal(human(client).bombsPlaced, 2);
});

test('failed drills retry without ordinary elimination finishing the training match', async t => {
  const { join } = await setup(t, {}, { tickMs: 5 });
  const client = await join({ practice: true, training: true });
  await startLesson(client);
  send(client, 'input', { action: 'place_orb' });
  await waitFor(() => client.messages.some(m => m.type === 'state' && m.training?.status === 'retrying'));
  await waitFor(() => client.state.training.status === 'ready' && client.state.training.attempts === 1);
  assert.equal(client.state.phase, 'playing');
  assert.equal(client.state.training.stage, 'escape');
  assert.equal(human(client).alive, true);
  assert.equal(human(client).bubbleTicks, 0);
  assert.equal(client.state.orbs.length, 0);
  assert.equal(client.state.waves.length, 0);
  await startLesson(client);
});

test('training preserves reading time then expires after 1800 active ticks, while ordinary practice stays unchanged', async t => {
  const { join } = await setup(t, {}, { tickMs: 1 });
  const training = await join({ practice: true, training: true });
  const practice = await join({ practice: true });
  assert.equal(practice.state.training, null);
  assert.equal(practice.state.remaining + practice.state.tick, 1200);
  send(practice, 'training_ready', { playerId: training.playerId, roomId: training.state.roomId });
  await waitFor(() => training.state.tick > 1800);
  assert.equal(training.state.phase, 'playing');
  assert.equal(training.state.training.status, 'ready');
  assert.equal(practice.state.training, null);
  assert.equal(training.state.remaining, 1800);
  assert.equal(training.state.remainingSeconds, 180);
  await startLesson(training);
  await waitFor(() => training.state.phase === 'finished');
  assert.ok(training.state.tick > 3600);
  assert.equal(training.state.remainingSeconds, 0);
  assert.equal(training.state.remaining, 0);
  assert.equal(training.state.result.reason, 'training_timeout');
  assert.equal(training.state.resultSaving.status, 'unranked');
});

test('training shares practice capacity and releasing the owner permits immediate replay', async t => {
  const { join, connect, sendJoin } = await setup(t);
  const training = await join({ practice: true, training: true });
  for (let index = 1; index < 8; index++) await join({ practice: true });
  assert.equal((await sendJoin(await connect(), { practice: true, training: true })).code, 'practice_unavailable');
  await close(training);
  const replay = await join({ practice: true, training: true });
  assert.notEqual(replay.state.roomId, training.state.roomId);
  assert.equal(replay.state.training.completed, 0);
});
