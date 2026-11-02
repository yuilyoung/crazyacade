import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeRelay, stepRelay, dropRelayCarrier, relayResult, relayState } from '../src/relay.js';
import { createLayout } from '../src/catalog.js';

function fixture(overrides = {}) {
  const room = { ruleSet: 'relay', mode: 'team', tick: 0, players: new Map(),
    solid: new Set(), soft: new Set(), orbs: new Map(), waves: [], ...overrides };
  initializeRelay(room);
  return room;
}
function addPlayer(room, overrides = {}) {
  const player = { id: `player-${room.players.size}`, slot: room.players.size, team: 'blue',
    alive: true, bubbleTicks: 0, x: 6, y: 5, score: 0, deliveries: 0,
    input: null, placeRequested: false, dartRequested: false, ...overrides };
  room.players.set(player.id, player);
  return player;
}
function carry(room, player) {
  player.x = 6; player.y = 5;
  stepRelay(room);
  assert.equal(room.relay.carrierId, player.id);
}

test('every map clears soft cells at the star and bases without removing permanent walls or distant blocks', () => {
  for (const map of ['garden', 'lagoon', 'candy']) {
    const layout = createLayout(map, 'team');
    for (const cell of ['6,5', '5,5', '7,5', '6,4', '6,6', '1,5', '1,4', '1,6', '2,5', '11,5', '11,4', '11,6', '10,5', '9,9']) layout.soft.add(cell);
    const solidBefore = new Set(layout.solid);
    const room = fixture(layout);
    assert.equal(room.soft.has('6,5'), false);
    for (const cell of ['5,5', '7,5', '1,5', '1,4', '1,6', '2,5', '11,5', '11,4', '11,6', '10,5']) assert.equal(room.soft.has(cell), false, `${map}: ${cell}`);
    assert.equal(room.soft.has('9,9'), true);
    assert.deepEqual(room.solid, solidBefore);
    assert.deepEqual(relayState(room), { scores: { blue: 0, pink: 0 }, goal: 3,
      star: { x: 6, y: 5 }, carrierId: null, respawnTicks: 0,
      bases: { blue: { x: 1, y: 5 }, pink: { x: 11, y: 5 } } });
  }
});

test('exactly one healthy participant can carry the central star', () => {
  const room = fixture();
  const dead = addPlayer(room, { alive: false });
  const bubbled = addPlayer(room, { bubbleTicks: 8 });
  const first = addPlayer(room);
  const second = addPlayer(room, { team: 'pink' });
  stepRelay(room);
  assert.equal(room.relay.carrierId, first.id);
  assert.equal(room.relay.star, null);
  first.x = 4;
  stepRelay(room);
  assert.equal(room.relay.carrierId, first.id);
  assert.equal(second.deliveries, 0);
  assert.equal(dead.alive, false);
  assert.equal(bubbled.bubbleTicks, 8);
});

test('delivery awards only the carrier and locks the star for exactly five seconds', () => {
  const room = fixture();
  const carrier = addPlayer(room);
  carry(room, carrier);
  carrier.x = 11;
  stepRelay(room);
  assert.equal(room.relay.scores.blue, 0, 'opponent base cannot score');
  room.tick = 10; carrier.x = 1;
  stepRelay(room);
  assert.equal(room.relay.scores.blue, 1);
  assert.equal(carrier.deliveries, 1);
  assert.equal(carrier.score, 150);
  assert.equal(room.relay.star, null);
  assert.equal(room.relay.carrierId, null);
  assert.equal(relayState(room).respawnTicks, 50);
  stepRelay(room);
  assert.equal(room.relay.scores.blue, 1);
  room.tick = 59; stepRelay(room);
  assert.equal(room.relay.star, null);
  assert.equal(relayState(room).respawnTicks, 1);
  room.tick = 60; stepRelay(room);
  assert.deepEqual(room.relay.star, { x: 6, y: 5 });
  assert.equal(relayState(room).respawnTicks, 0);
});

for (const cause of ['bubble', 'death', 'disconnect']) {
  test(`${cause} drops the star at the carrier cell and prevents pickup until the next tick`, () => {
    const room = fixture();
    const carrier = addPlayer(room);
    carry(room, carrier);
    room.tick = 9; carrier.x = 4; carrier.y = 3;
    const next = addPlayer(room, { x: 4, y: 3, team: 'pink' });
    if (cause === 'bubble') carrier.bubbleTicks = 20;
    if (cause === 'death') carrier.alive = false;
    if (cause === 'disconnect') { dropRelayCarrier(room, carrier.id); room.players.delete(carrier.id); }
    stepRelay(room);
    assert.deepEqual(room.relay.star, { x: 4, y: 3 });
    assert.equal(room.relay.carrierId, null);
    stepRelay(room);
    assert.equal(room.relay.carrierId, null);
    room.tick++; stepRelay(room);
    assert.equal(room.relay.carrierId, next.id);
  });
}

test('a non-carrier disconnect leaves the active delivery unchanged', () => {
  const room = fixture();
  const carrier = addPlayer(room); carry(room, carrier);
  const other = addPlayer(room);
  dropRelayCarrier(room, other.id);
  assert.equal(room.relay.carrierId, carrier.id);
  assert.equal(room.relay.star, null);
});

test('eliminated players return after fifty ticks to their original slot with retained upgrades and cleared inputs', () => {
  const spawns = [[1, 1], [1, 3], [1, 7], [1, 9], [11, 1], [11, 3], [11, 7], [11, 9]];
  for (const [slot, [x, y]] of spawns.entries()) {
    const room = fixture({ tick: 17 });
    const player = addPlayer(room, { slot, team: slot < 4 ? 'blue' : 'pink', alive: false,
      x: 4, y: 5, bubbleTicks: 0, bubbleSourceId: 'enemy', maxOrbs: 4, activeOrbs: 2,
      range: 6, speedLevel: 1, dash: true, pin: true, darts: 3, score: 475, deliveries: 2,
      input: 'left', placeRequested: true, dartRequested: true });
    stepRelay(room);
    assert.equal(player.respawnAt, 67);
    room.tick = 66; stepRelay(room);
    assert.equal(player.alive, false);
    room.tick = 67; stepRelay(room);
    assert.equal(player.alive, true);
    assert.deepEqual([player.x, player.y], [x, y]);
    assert.equal(player.respawnAt, undefined);
    assert.equal(player.immuneUntil, 77);
    assert.equal(player.bubbleSourceId, null);
    assert.equal(player.input, null);
    assert.equal(player.placeRequested, false);
    assert.equal(player.dartRequested, false);
    assert.deepEqual([player.maxOrbs, player.activeOrbs, player.range, player.speedLevel, player.dash, player.pin, player.darts, player.score, player.deliveries], [4, 2, 6, 1, true, true, 3, 475, 2]);
  }
});

test('respawn waits for live bombs and waves threatening the original spawn', () => {
  const room = fixture();
  const player = addPlayer(room, { alive: false, slot: 0 });
  stepRelay(room);
  room.tick = 50;
  room.orbs.set('3,1', { x: 3, y: 1, range: 3, fuse: 10 });
  stepRelay(room);
  assert.equal(player.alive, false, 'future blast lane must be clear');
  room.orbs.clear(); room.waves.push({ x: 1, y: 1, ttl: 2 });
  room.tick = 51; stepRelay(room);
  assert.equal(player.alive, false);
  room.waves[0].ttl = 0;
  room.tick = 52; stepRelay(room);
  assert.equal(player.alive, true);
  assert.equal(player.immuneUntil, 62);
});

test('a permanent wall shields a safe respawn from an unrelated bomb', () => {
  const room = fixture({ solid: new Set(['2,1']) });
  const player = addPlayer(room, { alive: false, slot: 0 });
  stepRelay(room); room.tick = 50;
  room.orbs.set('3,1', { x: 3, y: 1, range: 3, fuse: 10 });
  stepRelay(room);
  assert.equal(player.alive, true);
});

test('relay ends at three deliveries, or on the time limit using only team delivery totals', () => {
  const room = fixture();
  const blue = addPlayer(room, { alive: false, score: 1000 });
  addPlayer(room, { team: 'pink', alive: false });
  assert.equal(relayResult(room), null, 'elimination alone must not end Relay');
  room.relay.scores.blue = 2; room.tick = 1199;
  assert.equal(relayResult(room), null);
  room.tick = 1200;
  assert.deepEqual(relayResult(room), { winnerTeam: 'blue', reason: 'relay_time', relayScores: { blue: 2, pink: 0 } });
  room.relay.scores.pink = 2;
  assert.deepEqual(relayResult(room), { draw: true, reason: 'relay_time', relayScores: { blue: 2, pink: 2 } });
  room.tick = 2; room.relay.scores.pink = 3;
  const result = relayResult(room);
  assert.deepEqual(result, { winnerTeam: 'pink', reason: 'relay_goal', relayScores: { blue: 2, pink: 3 } });
  room.relay.scores.pink = 0;
  assert.equal(result.relayScores.pink, 3, 'finished result is a snapshot');
  assert.equal(blue.score, 1000);
});

test('all connected players leaving one team forfeits; missing both teams draws', () => {
  const room = fixture();
  addPlayer(room, { team: 'pink', alive: false });
  assert.deepEqual(relayResult(room), { winnerTeam: 'pink', reason: 'forfeit', relayScores: { blue: 0, pink: 0 } });
  room.players.clear();
  assert.deepEqual(relayResult(room), { draw: true, reason: 'forfeit', relayScores: { blue: 0, pink: 0 } });
});

test('classic rules ignore Relay operations and public objective objects cannot mutate game state', () => {
  const room = fixture({ ruleSet: 'classic', soft: new Set(['6,5']) });
  const player = addPlayer(room, { alive: false });
  stepRelay(room); dropRelayCarrier(room, player.id);
  assert.equal(relayState(room), null);
  assert.equal(relayResult(room), null);
  assert.equal(room.soft.has('6,5'), true);
  assert.equal(player.respawnAt, undefined);
  const relayRoom = fixture();
  const state = relayState(relayRoom);
  state.scores.blue = 99; state.star.x = 2; state.bases.blue.x = 5;
  assert.equal(relayRoom.relay.scores.blue, 0);
  assert.equal(relayState(relayRoom).star.x, 6);
  assert.equal(relayState(relayRoom).bases.blue.x, 1);
});
