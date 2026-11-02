import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideBotInput } from '../src/bots.js';
import { createLayout } from '../src/catalog.js';

const deltas = { up: [0, 1], down: [0, -1], left: [-1, 0], right: [1, 0] };
const cell = (x, y) => `${x},${y}`;
function fixture(overrides = {}) {
  const player = { id: 'bot', slot: 0, team: 'blue', x: 1, y: 1, alive: true,
    bubbleTicks: 0, range: 3, maxOrbs: 1, activeOrbs: 0, darts: 0, facing: 'right', nextMoveTick: 0 };
  const room = { tick: 0, mode: 'team', itemMode: true, players: new Map([[player.id, player]]),
    solid: new Set(), soft: new Set(), orbs: new Map(), waves: [], items: new Map(), ...overrides };
  return { room, player };
}
function addPlayer(room, properties) {
  const target = { id: 'target', alive: true, bubbleTicks: 0, team: 'pink', ...properties };
  room.players.set(target.id, target);
  return target;
}
function nextCell(player, action) {
  const [dx, dy] = deltas[action.move] ?? [0, 0];
  return cell(player.x + dx, player.y + dy);
}

test('takes the open route around a wall toward a pickup', () => {
  const { room, player } = fixture({ solid: new Set(['2,1']), items: new Map([['3,1', { x: 3, y: 1, type: 'orb' }]]) });
  assert.equal(decideBotInput(room, player).move, 'up');
});

test('leaves the future cross lane of a live orb', () => {
  const { room, player } = fixture({ orbs: new Map([['3,1', { x: 3, y: 1, range: 3, fuse: 15 }]]) });
  assert.equal(decideBotInput(room, player).move, 'up');
  assert.equal(decideBotInput(room, player).placeOrb, undefined);
});

test('avoids active waves even when a pickup is on the wave', () => {
  const { room, player } = fixture({ waves: [{ x: 1, y: 2, ttl: 4 }], items: new Map([['1,2', { x: 1, y: 2, type: 'pin' }]]) });
  assert.equal(decideBotInput(room, player).move, 'right');
});

test('does not enter a future bomb lane to collect an item', () => {
  const { room, player } = fixture({ orbs: new Map([['3,1', { x: 3, y: 1, range: 3, fuse: 15 }]]), items: new Map([['1,1', { x: 1, y: 1, type: 'dart' }]]) });
  player.y = 2;
  assert.notEqual(decideBotInput(room, player).move, 'down');
  assert.notEqual(nextCell(player, decideBotInput(room, player)), '3,2');
});

test('accounts for a chained orb removing a soft shield before the outer blast continues', () => {
  const { room, player } = fixture({ soft: new Set(['1,3']),
    orbs: new Map([
      ['1,1', { x: 1, y: 1, range: 5, fuse: 1 }],
      ['1,2', { x: 1, y: 2, range: 5, fuse: 15 }]
    ]), items: new Map([['1,5', { x: 1, y: 5, type: 'pin' }]]) });
  player.y = 4;
  assert.equal(decideBotInput(room, player).move, 'right');
});

for (const barrier of ['solid', 'soft']) {
  test(`${barrier} blocks shield the cells behind them from a future blast`, () => {
    const { room, player } = fixture({ [barrier]: new Set(['1,2']), orbs: new Map([['1,1', { x: 1, y: 1, range: 5, fuse: 4 }]]), items: new Map([['2,3', { x: 2, y: 3, type: 'pin' }]]) });
    player.y = 3;
    assert.equal(decideBotInput(room, player).move, 'right');
  });
}

test('places a useful bomb only with an escape route and starts that escape immediately', () => {
  const { room, player } = fixture({ soft: new Set(['4,3']) });
  player.x = 3; player.y = 3;
  const action = decideBotInput(room, player);
  assert.equal(action.placeOrb, true);
  assert.ok(action.move);
  room.orbs.set('3,3', { x: 3, y: 3, range: 3, fuse: 20, ownerId: player.id });
  let escaped = false;
  for (let step = 0; step < 6; step++) {
    const decision = step === 0 ? action : decideBotInput(room, player);
    if (decision.move) {
      const [dx, dy] = deltas[decision.move];
      player.x += dx; player.y += dy;
    }
    if (player.x !== 3 && player.y !== 3) { escaped = true; break; }
    room.tick += 3;
    room.orbs.get('3,3').fuse -= 3;
  }
  assert.equal(escaped, true, 'bot must reach a cell outside its own blast before detonation');
});

test('refuses a bomb in a dead end even when a soft block is in range', () => {
  const { room, player } = fixture({ solid: new Set(['1,2', '2,2']), soft: new Set(['3,1']) });
  assert.equal(decideBotInput(room, player).placeOrb, undefined);
});

test('returns no actions when completely trapped, dead, or bubbled', () => {
  const { room, player } = fixture({ solid: new Set(['1,2', '2,1']) });
  assert.deepEqual(decideBotInput(room, player), {});
  room.solid.clear(); player.alive = false;
  assert.deepEqual(decideBotInput(room, player), {});
  player.alive = true; player.bubbleTicks = 9;
  assert.deepEqual(decideBotInput(room, player), {});
});

test('prioritizes a reachable bubbled ally over a nearby pickup', () => {
  const { room, player } = fixture({ items: new Map([['1,2', { x: 1, y: 2, type: 'orb' }]]) });
  addPlayer(room, { x: 4, y: 1, team: 'blue', bubbleTicks: 15 });
  assert.equal(decideBotInput(room, player).move, 'right');
  assert.equal(decideBotInput(room, player).placeOrb, undefined);
});

test('uses a clear dart shot to rescue a bubbled ally', () => {
  const { room, player } = fixture(); player.darts = 1;
  addPlayer(room, { x: 5, y: 1, team: 'blue', bubbleTicks: 15 });
  assert.equal(decideBotInput(room, player).useDart, true);
});

test('item mode off disables dart use and ignores stale pickups', () => {
  const { room, player } = fixture({ itemMode: false, items: new Map([['1,2', { x: 1, y: 2, type: 'orb' }]]) });
  player.darts = 2;
  addPlayer(room, { x: 6, y: 1, team: 'pink', bubbleTicks: 12 });
  const action = decideBotInput(room, player);
  assert.equal(action.useDart, undefined);
  assert.equal(action.move, 'right');
});

test('does not mutate room collections or player combat state', () => {
  const { room, player } = fixture({ soft: new Set(['4,3']) }); player.x = 3; player.y = 3;
  const before = structuredClone(room);
  assert.deepEqual(decideBotInput(room, player), decideBotInput(room, player));
  assert.deepEqual(room, before);
});

test('all catalog maps and item modes produce legal one-cell decisions', () => {
  for (const map of ['garden', 'lagoon', 'candy']) for (const itemMode of [false, true]) {
    const { room, player } = fixture({ ...createLayout(map, 'team'), itemMode });
    addPlayer(room, { x: 11, y: 1 });
    let moves = 0;
    for (let tick = 0; tick < 60; tick += 3) {
      room.tick = tick;
      const action = decideBotInput(room, player);
      if (!action.move) continue;
      const destination = nextCell(player, action);
      const [x, y] = destination.split(',').map(Number);
      assert.ok(x > 0 && x < 12 && y > 0 && y < 10);
      assert.equal(room.solid.has(destination) || room.soft.has(destination) || room.orbs.has(destination), false);
      player.x = x; player.y = y; moves++;
    }
    assert.ok(moves > 0, `${map} itemMode=${itemMode} must permit movement`);
  }
});
