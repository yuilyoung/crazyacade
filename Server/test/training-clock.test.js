import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as training from '../src/training.js';
import { ruleFor } from '../src/rules.js';
import { stepMatch, queueInput } from '../src/match-engine.js';
import { createLayout } from '../src/catalog.js';

function resetPlayer(player) {
  Object.assign(player, { x: 1, y: 1, alive: true, bubbleTicks: 0, range: 3, maxOrbs: 1, activeOrbs: 0,
    facing: 'right', score: 0, bombsPlaced: 0, itemsCollected: 0, rescues: 0, deliveries: 0,
    passes: 0, interceptions: 0, darts: 0, nextMoveTick: 0, input: null, placeRequested: false,
    dartRequested: false, passRequested: false });
}
function fixture(mode) {
  const mapId = mode === 'harmony' ? 'festival' : 'garden';
  const room = { practice: true, training: true, trainingMode: mode, ruleSet: mode, mode: 'team', mapId,
    itemMode: true, tick: 0, players: new Map(), items: new Map(), orbs: new Map(), waves: [], dartEffects: [],
    ...createLayout(mapId, 'team') };
  for (let slot = 0; slot < 8; slot++) {
    const player = { id: `p${slot}`, slot, room, team: slot < 4 ? 'blue' : 'pink', isBot: slot > 0,
      socket: slot === 0 ? { OPEN: 1, readyState: 1 } : null };
    resetPlayer(player); room.players.set(player.id, player);
  }
  ruleFor(room).initialize(room, { resetPlayer });
  return room;
}
for (const mode of ['classic', 'harmony']) {
  test(`${mode} explanation frames preserve all 1800 active ticks while the engine clock advances`, () => {
    const room = fixture(mode);
    for (let i = 0; i < 2000; i++) stepMatch(room, { resetPlayer });
    assert.equal(room.tick, 2000);
    assert.equal(training.trainingResult(room), null);
    assert.equal(training.trainingTiming(room).remainingTicks, 1800);
    assert.equal(training.trainingTiming(room).remainingSeconds, 180);
    assert.equal(room.training.status, 'ready');
  });
  test(`${mode} active and retrying frames spend the budget exactly once until tick1800`, () => {
    const room = fixture(mode);
    training.startTrainingLesson(room);
    stepMatch(room, { resetPlayer });
    room.players.get('p0').alive = false;
    for (let i = 0; i < 11; i++) stepMatch(room, { resetPlayer });
    assert.equal(room.training.status, 'ready');
    assert.equal(training.trainingTiming(room).remainingTicks, 1788);
    for (let i = 0; i < 60; i++) stepMatch(room, { resetPlayer });
    assert.equal(training.trainingTiming(room).remainingTicks, 1788);
    training.startTrainingLesson(room);
    for (let i = 0; i < 1787; i++) stepMatch(room, { resetPlayer });
    assert.equal(training.trainingResult(room), null);
    assert.equal(training.trainingTiming(room).remainingTicks, 1);
    stepMatch(room, { resetPlayer });
    assert.deepEqual(training.trainingResult(room), { draw: true, reason: 'training_timeout' });
    assert.equal(training.trainingTiming(room).remainingTicks, 0);
    assert.equal(room.tick, 1860);
  });
  test(`${mode} the ten-minute explanation deadline survives input and rejects a late start`, () => {
    const room = fixture(mode), now = 1000000;
    assert.equal(typeof training.syncTrainingClock, 'function');
    training.syncTrainingClock(room, now);
    for (let i = 0; i < 10; i++) {
      queueInput(room.players.get('p0'), 'right');
      stepMatch(room, { resetPlayer, now: now + 599000 });
    }
    assert.equal(training.trainingTiming(room, now + 599000).readingIdleRemainingSeconds, 1);
    assert.equal(training.startTrainingLesson(room, now + 600000), false);
    assert.equal(room.training.status, 'ready');
    assert.equal(training.trainingTiming(room, now + 600000).idleExpired, true);
    assert.equal(training.trainingTiming(room, now + 600000).remainingTicks, 1800);
  });
  test(`${mode} accepted start and actual retry transition give the next explanation a fresh deadline`, () => {
    const room = fixture(mode), now = 1000000;
    assert.equal(typeof training.syncTrainingClock, 'function');
    training.syncTrainingClock(room, now);
    assert.equal(training.startTrainingLesson(room, now + 599000), true);
    assert.equal(training.startTrainingLesson(room, now + 900000), false);
    assert.equal(training.trainingTiming(room, now + 900000).readingIdleRemainingSeconds, null);
    room.players.get('p0').alive = false;
    for (let i = 0; i < 11; i++) stepMatch(room, { resetPlayer, now: now + 900000 + i * 100 });
    assert.equal(room.training.status, 'ready');
    assert.equal(training.trainingTiming(room, now + 901000).readingIdleRemainingSeconds, 600);
    assert.equal(training.trainingTiming(room, now + 901000).remainingTicks, 1789);
  });
}

test('ordinary classic matches still expire at 1200 engine ticks and acquire no training clock', () => {
  const room = fixture('classic'); room.training = null; room.practice = false;
  for (let i = 0; i < 1199; i++) stepMatch(room, { resetPlayer });
  assert.equal(ruleFor(room).result(room, 1200), null);
  stepMatch(room, { resetPlayer });
  assert.ok(ruleFor(room).result(room, 1200));
  assert.equal(room.trainingClock, undefined);
});
