import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropPickup, collectPickup, rescueAdjacent, hitPlayer } from '../src/pickups.js';

const player = (extra = {}) => ({ x: 1, y: 1, alive: true, bubbleTicks: 0, team: 'blue', maxOrbs: 1, range: 3, dash: false, pin: false, ...extra });

test('drops bounded item types and respects drop chance', () => {
  const room = { items: new Map() };
  assert.equal(dropPickup(room, 1, 2, () => 0.9), null);
  for (const [n, type] of ['orb', 'wave', 'dash', 'pin', 'dart'].entries()) {
    const values = [0.1, (n + 0.1) / 5];
    assert.equal(dropPickup(room, 1, n + 3, () => values.shift()).type, type);
  }
});

test('collecting an item consumes it and applies bounded upgrades', () => {
  const room = { items: new Map() }; const p = player({ maxOrbs: 5, range: 7 });
  for (const type of ['orb', 'wave', 'dash', 'pin', 'dart']) {
    room.items.set('1,1', { x: 1, y: 1, type });
    assert.equal(collectPickup(room, p), type); assert.equal(room.items.size, 0);
  }
  assert.equal(p.maxOrbs, 5); assert.equal(p.range, 7); assert.equal(p.dash, true); assert.equal(p.pin, true);
});

test('only active teammates rescue adjacent bubbled players in team mode', () => {
  const ally = player({ x: 2, bubbleTicks: 10 });
  const opponent = player({ x: 1, y: 2, bubbleTicks: 10, team: 'pink' });
  const rescuer = player(); const room = { mode: 'team', players: new Map([[1, rescuer], [2, ally], [3, opponent]]) };
  rescueAdjacent(room, rescuer);
  assert.equal(ally.bubbleTicks, 0); assert.equal(opponent.bubbleTicks, 10);
  ally.bubbleTicks = 10; rescuer.bubbleTicks = 1; rescueAdjacent(room, rescuer); assert.equal(ally.bubbleTicks, 10);
  rescuer.bubbleTicks = 0; room.mode = 'duel'; rescueAdjacent(room, rescuer); assert.equal(ally.bubbleTicks, 10);
});

test('a pin blocks one wave hit then the next hit traps the player', () => {
  const p = player({ pin: true }); hitPlayer(p); assert.equal(p.pin, false); assert.equal(p.bubbleTicks, 0);
  hitPlayer(p); assert.equal(p.bubbleTicks, 20);
});

test('overlapping waves in the same tick do not consume a pin and trap at once', () => {
  const p = player({ pin: true });
  hitPlayer(p, 10); hitPlayer(p, 10);
  assert.equal(p.pin, false); assert.equal(p.bubbleTicks, 0);
  hitPlayer(p, 11); assert.equal(p.bubbleTicks, 20);
});
