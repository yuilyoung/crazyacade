import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as geometry from '../public/arena-geometry.js';

test('arena descriptors recognize only supported complete numeric pairs, directly or nested', () => {
  const { LEGACY_ARENA, TEAM_ARENA, resolveArena } = geometry;
  assert.deepEqual(LEGACY_ARENA, { width: 13, height: 11 });
  assert.deepEqual(TEAM_ARENA, { width: 15, height: 13 });
  for (const arena of [LEGACY_ARENA, TEAM_ARENA]) {
    assert.equal(Object.isFrozen(arena), true);
    assert.equal(resolveArena({ ...arena }), arena);
    assert.equal(resolveArena({ arena: { ...arena }, mode: 'duel' }), arena);
  }
  for (const malformed of [undefined, null, false, true, 15, '15x13', [], {}, { mode: 'team' },
    { width: 15 }, { height: 13 }, { width: 13, height: 13 }, { width: 15, height: 11 },
    { width: '15', height: 13 }, { width: 15, height: '13' }, { width: NaN, height: 13 },
    { width: Infinity, height: 13 }, { arena: null }, { arena: {} }, { arena: { width: 15 } },
    { width: 15, height: 13, arena: { width: 99, height: 99 } }]) {
    assert.equal(resolveArena(malformed), LEGACY_ARENA, JSON.stringify(malformed));
  }
  const source = { width: 15, height: 13 };
  resolveArena(source);
  assert.equal(Object.isFrozen(source), false, 'caller-owned descriptors remain mutable');
});

test('mode selection enlarges team only when training is falsy', () => {
  const { LEGACY_ARENA, TEAM_ARENA, arenaForMode } = geometry;
  for (const training of [undefined, false, null, 0, '']) assert.equal(arenaForMode('team', training), TEAM_ARENA);
  for (const training of [true, {}, { lesson: 0 }, 1]) assert.equal(arenaForMode('team', training), LEGACY_ARENA);
  for (const mode of [undefined, null, 'duel', 'classic', 'unknown']) assert.equal(arenaForMode(mode), LEGACY_ARENA);
});

test('spawns, center and bases follow resolved geometry without exposing mutable shared arrays', () => {
  const { LEGACY_ARENA, TEAM_ARENA, spawnPoints, arenaCenter, arenaBases } = geometry;
  for (const [arena, xs, ys, center] of [
    [LEGACY_ARENA, [1, 11], [1, 3, 7, 9], { x: 6, y: 5 }],
    [TEAM_ARENA, [1, 13], [1, 4, 8, 11], { x: 7, y: 6 }]
  ]) {
    const spawns = spawnPoints({ arena });
    assert.deepEqual(spawns, xs.flatMap(x => ys.map(y => [x, y])));
    assert.equal(Object.isFrozen(spawns), true);
    assert.ok(spawns.every(Object.isFrozen));
    assert.throws(() => { spawns[0][0] = 99; }, TypeError);
    assert.deepEqual(arenaCenter({ arena }), center);
    assert.deepEqual(arenaBases({ arena }), { blue: { x: 1, y: center.y }, pink: { x: arena.width - 2, y: center.y } });
  }
  assert.deepEqual(spawnPoints({ mode: 'team' }), spawnPoints(LEGACY_ARENA));
});

test('insideArena excludes every border and outside cell for both supported geometries', () => {
  const { LEGACY_ARENA, TEAM_ARENA, insideArena } = geometry;
  for (const arena of [LEGACY_ARENA, TEAM_ARENA]) {
    for (let x = -1; x <= arena.width; x++) for (let y = -1; y <= arena.height; y++) {
      assert.equal(insideArena({ arena }, x, y), x > 0 && x < arena.width - 1 && y > 0 && y < arena.height - 1);
    }
    for (const invalid of [undefined, null, NaN, Infinity, '1']) {
      assert.equal(insideArena(arena, invalid, 1), false);
      assert.equal(insideArena(arena, 1, invalid), false);
    }
  }
  assert.equal(insideArena(undefined, 12, 10), false);
});

test('tide gate groups retain order and immutable string cell coordinates', () => {
  const { LEGACY_ARENA, TEAM_ARENA, tideGateGroups } = geometry;
  const legacy = [{ id: 'a', cells: ['4,5', '8,5'] }, { id: 'b', cells: ['6,3', '6,7'] }];
  const team = [{ id: 'a', cells: ['5,6', '9,6'] }, { id: 'b', cells: ['7,4', '7,8'] }];
  for (const [arena, expected] of [[LEGACY_ARENA, legacy], [TEAM_ARENA, team], [null, legacy]]) {
    const groups = tideGateGroups({ arena });
    assert.deepEqual(groups, expected);
    assert.equal(Object.isFrozen(groups), true);
    for (const group of groups) {
      assert.equal(Object.isFrozen(group), true);
      assert.equal(Object.isFrozen(group.cells), true);
      assert.throws(() => group.cells.push('1,1'), TypeError);
    }
  }
});
