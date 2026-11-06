import { LEGACY_ARENA } from '../public/arena-geometry.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLayout, TIDEGATES } from '../public/map-catalog.js';
import { initializeMapFeatures, stepMapFeatures, mapFeaturesState } from '../src/map-features.js';
import { arenaHazards } from '../src/hazards.js';
import { fireDart } from '../src/combat.js';
import { decideBotInput } from '../src/bots.js';

function makeRoom(overrides = {}) {
  const room = { ...createLayout('harbor', 'team', { arena: LEGACY_ARENA }), mapId: 'harbor', tick: 0, training: false,
    players: new Map(), orbs: new Map(), items: new Map(), ...overrides };
  initializeMapFeatures(room);
  return room;
}
const step = (room, tick) => { room.tick = tick; stepMapFeatures(room); return mapFeaturesState(room); };

test('only harbor has tidegates and training never gains them', () => {
  for (const mapId of ['garden', 'lagoon', 'candy', 'festival']) assert.equal(mapFeaturesState(makeRoom({ mapId })), null);
  assert.equal(mapFeaturesState(makeRoom({ training: true })), null);
  assert.equal(mapFeaturesState(makeRoom({ training: { status: 'active' } })), null);
});

test('gates alternate deterministically every ten seconds and warn two seconds early', () => {
  const room = makeRoom();
  assert.equal(mapFeaturesState(room).switchTicks, 100);
  assert.equal(mapFeaturesState(room).cycleTicks, 200);
  assert.equal(mapFeaturesState(room).warningTicks, 20);
  assert.deepEqual(mapFeaturesState(room).gates.map(g => g.closed), [true, false]);
  assert.equal(step(room, 79).gates[1].closing, false);
  assert.equal(step(room, 80).gates[1].closing, true);
  assert.equal(step(room, 99).gates[1].closed, false);
  assert.deepEqual(step(room, 100).gates.map(g => g.closed), [false, true]);
  assert.equal(step(room, 180).gates[0].closing, true);
  assert.deepEqual(step(room, 200).gates.map(g => g.closed), [true, false]);
  assert.deepEqual(step(room, 1300).gates.map(g => g.closed), [false, true]);
  assert.equal(mapFeaturesState(room).nextChangeTick, 1400);
  for (const gate of mapFeaturesState(room).gates) for (const cell of gate.cells) assert.equal(room.solid.has(cell), gate.closed);
});

for (const occupant of ['human', 'bot', 'bubble', 'orb']) test(`closing waits for ${occupant} without moving or damaging it`, () => {
  const room = makeRoom(), cell = TIDEGATES[1].cells[0];
  const [x, y] = cell.split(',').map(Number);
  const entity = { x, y, alive: true, bubbleTicks: occupant === 'bubble' ? 20 : 0, isBot: occupant === 'bot' };
  const store = occupant === 'orb' ? room.orbs : room.players;
  store.set(cell, entity);
  room.items.set(cell, { x, y, type: 'range' });
  const before = structuredClone(entity);
  const state = step(room, 100);
  assert.equal(state.gates[0].closed, false, 'opening must not wait');
  assert.equal(state.gates[1].closed, false);
  assert.equal(state.gates[1].pending, true);
  assert.equal(state.gates[1].closing, true);
  for (const gateCell of TIDEGATES[1].cells) assert.equal(room.solid.has(gateCell), false);
  assert.deepEqual(entity, before);
  assert.equal(room.items.has(cell), true);
  store.delete(cell);
  assert.equal(step(room, 101).gates[1].closed, true);
  assert.equal(room.items.has(cell), false);
});

test('an occupied initial gate waits, dead players do not obstruct, and stale pending closes cancel', () => {
  const cell = TIDEGATES[0].cells[0], [x, y] = cell.split(',').map(Number);
  const player = { x, y, alive: true };
  const room = makeRoom({ players: new Map([['p', player]]) });
  assert.equal(mapFeaturesState(room).gates[0].pending, true);
  assert.equal(room.solid.has(cell), false);
  player.alive = false;
  assert.equal(step(room, 1).gates[0].closed, true);
  const second = TIDEGATES[1].cells[0].split(',').map(Number);
  Object.assign(player, { x: second[0], y: second[1], alive: true });
  assert.equal(step(room, 100).gates[1].pending, true);
  assert.equal(step(room, 200).gates[1].pending, false);
  assert.equal(mapFeaturesState(room).gates[1].closed, false);
});

test('snapshots cannot mutate gate internals and rematch initialization resets cycle', () => {
  const room = makeRoom(), snapshot = step(room, 100);
  snapshot.gates[0].cells.push('1,1'); snapshot.gates[1].closed = false;
  assert.equal(mapFeaturesState(room).gates[0].cells.includes('1,1'), false);
  assert.equal(mapFeaturesState(room).gates[1].closed, true);
  room.tick = 0;
  initializeMapFeatures(room);
  assert.deepEqual(mapFeaturesState(room).gates.map(g => g.closed), [true, false]);
  assert.equal(mapFeaturesState(room).nextChangeTick, 100);
  assert.deepEqual(room.solid, makeRoom().solid);
});

test('gate solid state is shared by hazard prediction, darts and bot movement', () => {
  const room = makeRoom({ mode: 'team', waves: [], itemMode: true });
  const bot = { id: 'bot', slot: 0, team: 'blue', x: 3, y: 5, alive: true,
    bubbleTicks: 0, range: 3, maxOrbs: 1, activeOrbs: 0, darts: 1, facing: 'right', nextMoveTick: 0 };
  const target = { id: 'ally', team: 'blue', x: 5, y: 5, alive: true, bubbleTicks: 20 };
  room.players.set(bot.id, bot); room.players.set(target.id, target);
  room.orbs.set('2,5', { x: 2, y: 5, range: 5, fuse: 20 });
  assert.equal(arenaHazards(room).deadlines.has('5,5'), false);
  assert.equal(fireDart(room, bot, () => {}), true);
  assert.equal(target.bubbleTicks, 20, 'closed gate blocks rescue dart');
  assert.notEqual(decideBotInput(room, bot).move, 'right', 'bot never enters closed gate');
  step(room, 100);
  assert.equal(arenaHazards(room).deadlines.has('5,5'), true);
  bot.darts = 1;
  assert.equal(fireDart(room, bot, () => {}), true);
  assert.equal(target.bubbleTicks, 0, 'open gate allows the same rescue dart');
});
