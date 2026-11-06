import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepMatch, queueInput } from '../src/match-engine.js';
import { fireDart } from '../src/combat.js';
import { arenaHazards } from '../src/hazards.js';
import { decideBotInput } from '../src/bots.js';
import { initializeRelay, stepRelay, relayState, passRelayStar, dropRelayCarrier } from '../src/relay.js';
import { initializeMapFeatures, stepMapFeatures } from '../src/map-features.js';

const arena = { width: 15, height: 13 };
function room(overrides = {}) {
  return { arena, mode: 'team', ruleSet: 'classic', tick: 0, itemMode: true, players: new Map(), solid: new Set(), soft: new Set(), items: new Map(), orbs: new Map(), waves: [], dartEffects: [], ...overrides };
}
function player(r, overrides = {}) {
  const p = { id: `p${r.players.size}`, team: 'blue', slot: 0, x: 12, y: 11, alive: true, bubbleTicks: 0,
    socket: { OPEN: 1, readyState: 1 }, connected: true, range: 3, activeOrbs: 0, maxOrbs: 1, bombsPlaced: 0,
    nextMoveTick: 0, facing: 'right', darts: 1, score: 0, ...overrides };
  r.players.set(p.id, p); return p;
}
test('expanded movement reaches x13 and y11 while authoritative bounds remain strict', () => {
  const r = room(), p = player(r);
  queueInput(p, 'right'); stepMatch(r); assert.deepEqual([p.x, p.y], [13, 11]);
  r.tick = 3; queueInput(p, 'right'); stepMatch(r); assert.equal(p.x, 13);
  r.tick = 6; p.y = 10; queueInput(p, 'up'); stepMatch(r); assert.equal(p.y, 11);
  r.tick = 9; queueInput(p, 'up'); stepMatch(r); assert.equal(p.y, 11);
  const legacy = room({ arena: undefined }), q = player(legacy, { x: 11, y: 9 });
  queueInput(q, 'right'); stepMatch(legacy); assert.equal(q.x, 11);
});
test('expanded darts rescue at far edges and stop outside the selected arena', () => {
  for (const [start, target, facing] of [[[10, 11], [13, 11], 'right'], [[13, 8], [13, 11], 'up']]) {
    const r = room(), p = player(r, { x: start[0], y: start[1], facing });
    const ally = player(r, { x: target[0], y: target[1], bubbleTicks: 10 });
    assert.equal(fireDart(r, p, () => {}), true); assert.equal(ally.bubbleTicks, 0);
    assert.equal(r.dartEffects[0].length, 3);
  }
});
test('expanded explosion and neutral hazard prediction reach edges but never leave the interior', () => {
  const r = room(), p = player(r, { x: 1, y: 1 });
  r.orbs.set('12,11', { x: 12, y: 11, fuse: 1, range: 7, ownerId: p.id });
  const predicted = arenaHazards(r).deadlines;
  assert.equal(predicted.has('13,11'), true); assert.equal(predicted.has('12,10'), true);
  assert.equal(predicted.has('14,11'), false); assert.equal(predicted.has('12,12'), false);
  stepMatch(r); assert.equal(r.waves.some(w => w.x === 13 && w.y === 11), true);
  assert.ok(r.waves.every(w => w.x > 0 && w.x < 14 && w.y > 0 && w.y < 12));
});
test('expanded bots route to far-edge pickups, rescue with darts and deliver to the expanded base', () => {
  const r = room(), p = player(r, { darts: 0 });
  r.items.set('13,11', { x: 13, y: 11, type: 'wave' });
  assert.equal(decideBotInput(r, p).move, 'right');
  p.darts = 1; player(r, { x: 13, y: 11, bubbleTicks: 10 });
  assert.equal(decideBotInput(r, p).useDart, true);
  r.players.delete('p1'); r.items.clear(); r.ruleSet = 'relay'; initializeRelay(r);
  Object.assign(p, { x: 13, y: 7, team: 'pink' }); r.relay.carrierId = p.id; r.relay.star = null;
  assert.equal(decideBotInput(r, p).move, 'down');
});
test('expanded relay uses center, bases, far-edge passes, return timing and every slot spawn', () => {
  const r = room({ ruleSet: 'harmony' }); initializeRelay(r);
  assert.deepEqual(relayState(r).star, { x: 7, y: 6 });
  assert.deepEqual(relayState(r).bases, { blue: { x: 1, y: 6 }, pink: { x: 13, y: 6 } });
  const p = player(r, { x: 7, y: 6 }); stepRelay(r); assert.equal(r.relay.carrierId, p.id);
  Object.assign(p, { x: 10, y: 11 }); const ally = player(r, { x: 13, y: 11 });
  assert.equal(passRelayStar(r, p), true); assert.equal(r.relay.carrierId, ally.id);
  Object.assign(ally, { x: 1, y: 6 }); stepRelay(r); assert.equal(r.relay.scores.blue, 2);
  r.tick = 49; stepRelay(r); assert.equal(r.relay.star, null);
  r.tick = 50; stepRelay(r); assert.deepEqual(r.relay.star, { x: 7, y: 6 });
  r.relay.carrierId = 'missing'; dropRelayCarrier(r, 'missing'); assert.deepEqual(r.relay.star, { x: 7, y: 6 });
  const spawns = [[1,1],[1,4],[1,8],[1,11],[13,1],[13,4],[13,8],[13,11]];
  for (const [slot, position] of spawns.entries()) {
    const dead = player(r, { slot, alive: false, respawnAt: r.tick }); stepRelay(r);
    assert.deepEqual([dead.x, dead.y], position); assert.equal(dead.alive, true);
  }
});
test('expanded relay defers a far-edge respawn threatened by a pending blast', () => {
  const r = room({ ruleSet: 'relay' }); initializeRelay(r);
  const p = player(r, { slot: 7, alive: false, respawnAt: 0 });
  r.orbs.set('13,8', { x: 13, y: 8, range: 3, fuse: 10 }); stepRelay(r); assert.equal(p.alive, false);
  r.orbs.clear(); stepRelay(r); assert.equal(p.alive, true); assert.deepEqual([p.x, p.y], [13,11]);
});
test('expanded gates use room geometry and preserve occupancy deferral', () => {
  const r = room({ mapId: 'harbor' }); initializeMapFeatures(r);
  assert.deepEqual(r.mapFeatures.gates.map(g => g.cells), [['5,6','9,6'],['7,4','7,8']]);
  const p = player(r, { x: 7, y: 4 }); r.tick = 100; stepMapFeatures(r);
  assert.equal(r.mapFeatures.gates[1].pending, true); assert.equal(r.solid.has('5,6'), false);
  p.x = 6; stepMapFeatures(r); assert.equal(r.solid.has('7,4'), true);
});
