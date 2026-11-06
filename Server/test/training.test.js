import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeTraining, startTrainingLesson, stepTraining, trainingState, dropTrainingPickup, trainingResult, noteTrainingDartRescue } from '../src/training.js';
import { createLayout } from '../src/catalog.js';
import { collectPickup, rescueAdjacent } from '../src/pickups.js';
import { fireDart, eliminatePlayer } from '../src/combat.js';

function resetPlayer(player) {
  Object.assign(player, { x: 11, y: 9, alive: true, bubbleTicks: 0, maxOrbs: 1,
    activeOrbs: 0, range: 3, speedLevel: 0, dash: false, pin: false, darts: 0,
    facing: 'up', score: 0, bombsPlaced: 0, itemsCollected: 0, rescues: 0,
    deliveries: 0, nextMoveTick: 0, input: null, placeRequested: false, dartRequested: false });
  for (const field of ['bubbleSourceId', 'lastHitTick', 'immuneUntil', 'respawnAt']) delete player[field];
}
function fixture(overrides = {}) {
  const room = { practice: true, training: true, mode: 'team', itemMode: true,
    ruleSet: 'classic', tick: 0, players: new Map(), items: new Map(), orbs: new Map(),
    waves: [], dartEffects: [], ...createLayout('garden', 'team'), ...overrides };
  for (let slot = 0; slot < 8; slot++) {
    const player = { id: `p${slot}`, slot, room, team: slot < 4 ? 'blue' : 'pink', isBot: slot > 0 };
    resetPlayer(player); room.players.set(player.id, player);
  }
  initializeTraining(room, resetPlayer);
  return room;
}
const human = room => room.players.get('p0');
const target = room => [...room.players.values()].find(p => p !== human(room) && p.bubbleTicks > 0);
function finishEscape(room) {
  startTrainingLesson(room);
  const player = human(room);
  player.bombsPlaced++; player.activeOrbs++;
  room.orbs.set('1,1', { x: 1, y: 1, ownerId: player.id, fuse: 19 });
  stepTraining(room, resetPlayer);
  room.orbs.clear(); player.activeOrbs = 0;
  player.x = 2; player.y = 3;
  room.tick += 23; stepTraining(room, resetPlayer);
}
function finishItem(room) {
  startTrainingLesson(room);
  const player = human(room);
  room.soft.delete('3,1');
  assert.equal(dropTrainingPickup(room, 3, 1), true);
  player.x = 3; player.y = 1;
  assert.equal(collectPickup(room, player), 'wave');
  stepTraining(room, resetPlayer);
}
function finishRescue(room) {
  startTrainingLesson(room);
  human(room).x = 2;
  rescueAdjacent(room, human(room));
  stepTraining(room, resetPlayer);
}

test('only explicit private training prepares isolated, reachable lessons', () => {
  for (const overrides of [{ training: false }, { training: true, practice: false }]) {
    const room = fixture(overrides);
    assert.equal(trainingState(room), null);
    assert.equal(human(room).x, 11);
    assert.equal(dropTrainingPickup(room, 3, 1), false);
    assert.equal(trainingResult(room), null);
  }
  const room = fixture();
  assert.deepEqual([human(room).x, human(room).y], [1, 1]);
  assert.equal(room.solid.has('2,2'), true, 'permanent pillars remain');
  assert.equal(room.soft.has('3,1'), true);
  for (const cell of ['1,2', '1,3', '2,3', '2,1']) assert.equal(room.soft.has(cell), false);
  assert.equal(trainingState(room).stage, 'escape');
  assert.equal(trainingState(room).completed, 0);
  assert.equal(trainingState(room).attempts, 0);
});

test('escape requires observing own bomb, surviving its waves and reaching the marked safe tile', () => {
  const room = fixture(), player = human(room);
  startTrainingLesson(room);
  player.x = 2; player.y = 3;
  stepTraining(room, resetPlayer);
  assert.equal(trainingState(room).stage, 'escape', 'walking alone cannot pass');
  player.bombsPlaced++;
  room.orbs.set('1,1', { x: 1, y: 1, ownerId: player.id, fuse: 19 });
  stepTraining(room, resetPlayer);
  assert.equal(trainingState(room).stage, 'escape', 'live bomb cannot pass');
  room.orbs.clear(); room.waves.push({ x: 1, y: 1, ttl: 2 });
  stepTraining(room, resetPlayer);
  assert.equal(trainingState(room).stage, 'escape', 'wait for blast to finish');
  room.waves = []; player.x = 1;
  stepTraining(room, resetPlayer);
  assert.equal(trainingState(room).stage, 'escape', 'must reach marked target');
  player.x = 2;
  stepTraining(room, resetPlayer);
  assert.equal(trainingState(room).stage, 'item');
  assert.equal(trainingState(room).completed, 1);
  assert.equal(player.bombsPlaced, 1, 'learning totals survive the transition');
});

test('only the designated broken crate produces a wave item and only collection passes the lesson', () => {
  const room = fixture(); finishEscape(room);
  startTrainingLesson(room);
  assert.equal(dropTrainingPickup(room, 5, 1), true, 'random drops are suppressed');
  assert.equal(room.items.size, 0);
  room.soft.delete('3,1'); dropTrainingPickup(room, 3, 1);
  assert.deepEqual(room.items.get('3,1'), { x: 3, y: 1, type: 'wave' });
  stepTraining(room, resetPlayer);
  assert.equal(trainingState(room).stage, 'item', 'breaking crate is insufficient');
  human(room).x = 3; human(room).y = 1;
  collectPickup(room, human(room)); stepTraining(room, resetPlayer);
  assert.equal(trainingState(room).stage, 'rescue');
  assert.equal(trainingState(room).completed, 2);
  assert.equal(human(room).itemsCollected, 1);
});

test('real adjacent rescue advances and real ranged dart rescue completes all four lessons', () => {
  const room = fixture(); finishEscape(room); finishItem(room);
  startTrainingLesson(room);
  assert.equal(target(room).bubbleTicks, 100);
  finishRescue(room);
  assert.equal(trainingState(room).stage, 'dart');
  assert.equal(human(room).rescues, 1);
  assert.equal(human(room).darts, 1);
  assert.equal(human(room).facing, 'right');
  assert.deepEqual([target(room).x, target(room).y], [5, 1]);
  startTrainingLesson(room);
  const player = human(room), before = player.rescues;
  assert.equal(fireDart(room, player, () => assert.fail('no bombs in dart lesson')), true);
  if (player.rescues > before) noteTrainingDartRescue(room, player);
  stepTraining(room, resetPlayer);
  assert.equal(trainingState(room).stage, 'complete');
  assert.equal(trainingState(room).status, 'complete');
  assert.equal(trainingState(room).completed, 4);
  assert.equal(player.rescues, 2);
  assert.deepEqual(trainingResult(room), { winnerTeam: 'blue', reason: 'training_complete' });
});

test('death retries the same lesson after one second without losing learning progress or carrying inputs', () => {
  const room = fixture(); finishEscape(room); finishItem(room);
  startTrainingLesson(room);
  const player = human(room);
  player.bombsPlaced = 4; player.input = 'right'; player.placeRequested = true;
  player.dartRequested = true; player.alive = false;
  room.orbs.set('1,1', { ownerId: player.id }); room.waves.push({ x: 3, y: 1, ttl: 2 });
  room.tick = 100; stepTraining(room, resetPlayer);
  assert.equal(trainingState(room).status, 'retrying');
  assert.equal(trainingState(room).attempts, 1);
  room.tick = 109; stepTraining(room, resetPlayer);
  assert.equal(player.alive, false);
  room.tick = 110; stepTraining(room, resetPlayer);
  assert.equal(player.alive, true);
  assert.equal(trainingState(room).stage, 'rescue');
  assert.equal(trainingState(room).completed, 2);
  assert.equal(trainingState(room).status, 'ready');
  assert.equal(player.bombsPlaced, 4);
  assert.equal(player.itemsCollected, 1);
  assert.equal(player.input, null); assert.equal(player.placeRequested, false); assert.equal(player.dartRequested, false);
  assert.equal(room.orbs.size, 0); assert.equal(room.waves.length, 0);
  assert.equal(target(room).bubbleTicks, 100);
});

test('expired rescue targets trigger retry instead of crediting a death as rescue', () => {
  const room = fixture(); finishEscape(room); finishItem(room);
  startTrainingLesson(room);
  eliminatePlayer(room, target(room));
  stepTraining(room, resetPlayer);
  assert.equal(trainingState(room).stage, 'rescue');
  assert.equal(trainingState(room).status, 'retrying');
  assert.equal(trainingState(room).completed, 2);
});

test('adjacent rescue cannot pass the dart lesson and gets a fresh target after retry', () => {
  const room = fixture(); finishEscape(room); finishItem(room); finishRescue(room);
  startTrainingLesson(room);
  human(room).x = 4; rescueAdjacent(room, human(room));
  stepTraining(room, resetPlayer);
  assert.equal(trainingState(room).status, 'retrying');
  assert.equal(trainingState(room).completed, 3);
  room.tick += 10; stepTraining(room, resetPlayer);
  assert.equal(trainingState(room).stage, 'dart');
  assert.equal(human(room).darts, 1);
  assert.equal(target(room).bubbleTicks, 100);
});

test('dart rescue must be ranged and the verified human action; unmatched notifications cannot pass', () => {
  const room = fixture(); finishEscape(room); finishItem(room); finishRescue(room);
  startTrainingLesson(room);
  noteTrainingDartRescue(room, human(room));
  stepTraining(room, resetPlayer);
  assert.equal(trainingState(room).status, 'active');
  human(room).x = 4;
  fireDart(room, human(room), () => {});
  noteTrainingDartRescue(room, human(room));
  stepTraining(room, resetPlayer);
  assert.equal(trainingState(room).status, 'retrying', 'one-cell rescue does not teach range');
  assert.equal(trainingResult(room), null);
});

test('a failed bomb lesson forgets prior bomb evidence so walking after retry cannot pass', () => {
  const room = fixture(), player = human(room);
  startTrainingLesson(room);
  player.bombsPlaced++;
  room.orbs.set('1,1', { ownerId: player.id });
  stepTraining(room, resetPlayer);
  player.alive = false; stepTraining(room, resetPlayer);
  room.tick += 10; stepTraining(room, resetPlayer);
  startTrainingLesson(room);
  player.x = 2; player.y = 3; stepTraining(room, resetPlayer);
  assert.equal(trainingState(room).stage, 'escape');
});

test('training remains limited to three minutes across all retries', () => {
  const room = fixture(); room.tick = 10000; room.training.status = 'retrying';
  room.trainingClock = { activeTicks: 1799, readySince: null };
  assert.equal(trainingResult(room), null);
  room.trainingClock.activeTicks = 1800;
  assert.deepEqual(trainingResult(room), { draw: true, reason: 'training_timeout' });
});

test('public state is detached and contains no participant references or internal proof', () => {
  const room = fixture(); const state = trainingState(room);
  state.target.x = 9; state.completed = 4; state.stage = 'complete';
  assert.equal(trainingState(room).target.x, 2);
  assert.equal(trainingState(room).completed, 0);
  assert.equal(trainingResult(room), null);
  assert.deepEqual(Object.keys(state).sort(), ['attempts', 'completed', 'instruction', 'mode', 'stage', 'status', 'step', 'target', 'title', 'total']);
});

test('destroying the lesson pickup retries the item lesson instead of leaving an impossible objective', () => {
  const room = fixture(); finishEscape(room);
  startTrainingLesson(room);
  room.soft.delete('3,1'); dropTrainingPickup(room, 3, 1);
  room.items.delete('3,1');
  room.waves.push({ x: 3, y: 1, ttl: 2 });
  stepTraining(room, resetPlayer);
  assert.equal(trainingState(room).status, 'active', 'let the real blast finish');
  room.waves = []; stepTraining(room, resetPlayer);
  assert.equal(trainingState(room).status, 'retrying');
  room.tick += 10; stepTraining(room, resetPlayer);
  assert.equal(trainingState(room).stage, 'item');
  assert.equal(trainingState(room).completed, 1);
  assert.equal(room.soft.has('3,1'), true);
});


test('every lesson waits for a deliberate start and retries return to a fresh reading pause', () => {
  const room = fixture();
  assert.equal(trainingState(room).status, 'ready');
  const instruction = trainingState(room).instruction;
  room.tick = 200; stepTraining(room, resetPlayer);
  assert.equal(trainingState(room).status, 'ready');
  assert.equal(trainingState(room).attempts, 0);
  assert.equal(trainingState(room).instruction, instruction);
  assert.equal(startTrainingLesson(room), true);
  assert.equal(trainingState(room).status, 'active');
  human(room).alive = false; stepTraining(room, resetPlayer);
  assert.equal(startTrainingLesson(room), false, 'cannot skip the failure delay');
  room.tick += 10; stepTraining(room, resetPlayer);
  assert.equal(trainingState(room).status, 'ready');
  finishEscape(room);
  assert.equal(trainingState(room).stage, 'item');
  assert.equal(trainingState(room).status, 'ready');
  finishItem(room);
  assert.equal(trainingState(room).stage, 'rescue');
  assert.equal(trainingState(room).status, 'ready');
  assert.equal(target(room).bubbleTicks, 100);
  room.tick += 150; stepTraining(room, resetPlayer);
  assert.equal(trainingState(room).completed, 2);
  assert.equal(trainingState(room).status, 'ready');
});

test('duplicate lesson starts cannot reset a live attempt, grant darts or erase progress', () => {
  const room = fixture(); finishEscape(room); finishItem(room); finishRescue(room);
  assert.equal(startTrainingLesson(room), true);
  const player = human(room), ally = target(room);
  player.x = 2; player.darts = 0; player.score = 125; ally.bubbleTicks = 25;
  assert.equal(startTrainingLesson(room), false);
  assert.equal(player.x, 2);
  assert.equal(player.darts, 0);
  assert.equal(player.score, 125);
  assert.equal(ally.bubbleTicks, 25);
  assert.equal(trainingState(room).completed, 3);
  assert.equal(startTrainingLesson(fixture({ training: false })), false);
});

test('reading a lesson preserves the separate three minute active training limit', () => {
  const room = fixture();
  assert.equal(trainingState(room).status, 'ready');
  room.tick = 1800; stepTraining(room, resetPlayer);
  assert.equal(trainingResult(room), null);
  assert.equal(trainingState(room).status, 'ready');
});
