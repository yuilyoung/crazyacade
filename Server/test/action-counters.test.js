import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectPickup, rescueAdjacent } from '../src/pickups.js';
import { fireDart, finishScores } from '../src/combat.js';

const player = (id, extra = {}) => ({ id, userId: id, name: id, x: 1, y: 1, alive: true, bubbleTicks: 0, team: 'blue', maxOrbs: 1, range: 3, score: 0, itemsCollected: 0, rescues: 0, ...extra });

test('only consumed pickups increase the collection counter, including capped upgrades', () => {
  const p = player('collector', { maxOrbs: 5 });
  const room = { items: new Map([['1,1', { x: 1, y: 1, type: 'orb' }]]) };
  p.bubbleTicks = 1;
  assert.equal(collectPickup(room, p), null);
  assert.equal(p.itemsCollected, 0);
  p.bubbleTicks = 0;
  room.itemMode = false;
  assert.equal(collectPickup(room, p), null);
  assert.equal(p.itemsCollected, 0);
  room.itemMode = true;
  assert.equal(collectPickup(room, p), 'orb');
  assert.equal(p.itemsCollected, 1);
  assert.equal(collectPickup(room, p), null);
  assert.equal(p.itemsCollected, 1);
});

test('one bubble rescue is credited once even when two allies attempt it', () => {
  const first = player('first');
  const second = player('second');
  const ally = player('ally', { x: 2, bubbleTicks: 10 });
  const enemy = player('enemy', { y: 2, team: 'pink', bubbleTicks: 10 });
  const room = { mode: 'team', tick: 5, players: new Map([first, second, ally, enemy].map(p => [p.id, p])) };
  rescueAdjacent(room, first);
  rescueAdjacent(room, first);
  rescueAdjacent(room, second);
  assert.equal(first.rescues, 1);
  assert.equal(second.rescues, 0);
  assert.equal(first.score, 50);
  assert.equal(ally.bubbleTicks, 0);
  assert.equal(enemy.bubbleTicks, 10);
  room.result = { draw: true };
  finishScores(room);
  assert.equal(room.result.scoreboard.find(p => p.id === first.id).rescues, 1);
  assert.equal(room.result.scoreboard.find(p => p.id === second.id).rescues, 0);
});

test('dart rescues use the same counter and finished scores retain disconnected rescuers', () => {
  const rescuer = player('rescuer', { darts: 2, facing: 'right' });
  const ally = player('ally', { x: 3, bubbleTicks: 10 });
  const room = { mode: 'team', tick: 5, players: new Map([[rescuer.id, rescuer], [ally.id, ally]]), solid: new Set(), soft: new Set(), orbs: new Map(), result: { winnerTeam: 'blue' } };
  room.roster = [...room.players.values()];
  assert.equal(fireDart(room, rescuer, () => {}), true);
  assert.equal(rescuer.rescues, 1);
  assert.equal(fireDart(room, rescuer, () => {}), true);
  assert.equal(rescuer.rescues, 1);
  room.players.delete(rescuer.id);
  finishScores(room);
  finishScores(room);
  assert.equal(room.result.scoreboard.find(p => p.id === rescuer.id).rescues, 1);
  assert.equal(rescuer.score, 250);
});
