import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MAPS, TEAM_SPAWNS, TIDEGATES, createLayout } from '../public/map-catalog.js';
import { LEGACY_ARENA, TEAM_ARENA, arenaCenter, insideArena, spawnPoints, tideGateGroups } from '../public/arena-geometry.js';
import { createLayout as serverLayout } from '../src/catalog.js';

const key = (x, y) => `${x},${y}`;
const neighbors = (x, y) => [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
function reachable(solid, soft = new Set()) {
  const found = new Set(['6,5']), queue = [[6, 5]];
  for (const [x, y] of queue) for (const [nx, ny] of neighbors(x, y)) {
    const cell = key(nx, ny);
    if (nx < 1 || nx > 11 || ny < 1 || ny > 9 || found.has(cell) || solid.has(cell) || soft.has(cell)) continue;
    found.add(cell); queue.push([nx, ny]);
  }
  return found;
}

test('shared map catalog is immutable and matches server layout source', () => {
  assert.deepEqual(MAPS.map(map => map.id), ['garden', 'lagoon', 'candy', 'harbor', 'festival']);
  assert.equal(Object.isFrozen(MAPS), true);
  for (const map of MAPS) {
    assert.equal(Object.isFrozen(map), true);
    assert.ok(map.name && map.description && map.theme);
    for (const mode of ['team', 'duel']) assert.deepEqual(createLayout(map.id, mode), serverLayout(map.id, mode));
  }
});

test('all legacy layouts retain byte-for-byte solid and soft insertion order', () => {
  const hashes = {
    'garden/team': 'a513bf624a594e7d1bfbb7a555d19f25e525e741d2960d3fd997b8d0525a6fb5',
    'garden/duel': '6511032c6fb273649f076cd3917255a777ee765918032f81712420d1963cc5f9',
    'lagoon/team': '5a1cfa3c08308d5978c969d8beaaba73796dbf0a4feb521f378d07816efe2614',
    'lagoon/duel': '6add9fa1d522c75499b1164ab50bcc7cf12d04cb378e3b4ec73019d6106fedd6',
    'candy/team': 'abe75c693a7a04ea678a5c48849ff4763aef9445d121078cc8ea5b01b791587c',
    'candy/duel': 'a51ed57ba6655540d821f0e556e18a99ae21df46cd584b5b8a18725102f1ed76',
    'harbor/team': 'd66e3c2ab602404517c12ca68b820dafea3ee4df2e5715fada48c95a7b228937',
    'harbor/duel': 'd66e3c2ab602404517c12ca68b820dafea3ee4df2e5715fada48c95a7b228937',
    'festival/team': '49ecc3a55437bfca204778ca65285f76b01a41f1195d3f288aebaa9d81727bea',
    'festival/duel': '49ecc3a55437bfca204778ca65285f76b01a41f1195d3f288aebaa9d81727bea'
  };
  for (const [selection, expected] of Object.entries(hashes)) {
    const layout = createLayout(...selection.split('/'), { arena: LEGACY_ARENA });
    const actual = createHash('sha256').update(JSON.stringify({ solid: [...layout.solid], soft: [...layout.soft] })).digest('hex');
    assert.equal(actual, expected, selection);
  }
});

for (const id of ['harbor', 'festival']) for (const mode of ['team', 'duel']) {
  test(`${id}/${mode}: legacy symmetric structures, safe spawns and connected center/bases`, () => {
    const { solid, soft } = createLayout(id, mode, { arena: LEGACY_ARENA });
    assert.deepEqual(createLayout(id, mode, { arena: LEGACY_ARENA }), { solid, soft });
    for (const cells of [solid, soft]) for (const cell of cells) {
      const [x, y] = cell.split(',').map(Number);
      assert.equal(cells.has(key(12 - x, y)), true, `asymmetry: ${cell}`);
    }
    for (const [x, y] of TEAM_SPAWNS) for (const [sx, sy] of [[x, y], ...neighbors(x, y)]) {
      if (sx < 1 || sx > 11 || sy < 1 || sy > 9) continue;
      assert.equal(solid.has(key(sx, sy)) || soft.has(key(sx, sy)), false, `unsafe spawn ${sx},${sy}`);
    }
    assert.ok([...soft].every(cell => !solid.has(cell)));
    const open = reachable(solid, soft);
    for (const [x, y] of [...TEAM_SPAWNS, [1, 5], [11, 5]]) assert.equal(open.has(key(x, y)), true);
    const all = reachable(solid);
    for (let x = 1; x < 12; x++) for (let y = 1; y < 10; y++) if (!solid.has(key(x, y))) assert.ok(all.has(key(x, y)));
    if (id === 'harbor') for (const group of TIDEGATES) {
      const closed = new Set([...solid, ...group.cells]);
      const paths = reachable(closed, soft);
      for (const [x, y] of TEAM_SPAWNS) assert.equal(paths.has(key(x, y)), true, `closed gate disconnects ${x},${y}`);
    }
  });
}

test('new maps change permanent wall topology, not only crate colors or placement', () => {
  const walls = ['garden', 'harbor', 'festival'].map(id => [...createLayout(id, 'team').solid].sort().join('|'));
  assert.equal(new Set(walls).size, 3);
});

function freeGraph(arena, solid, soft = new Set()) {
  const graph = new Map();
  for (let x = 1; x < arena.width - 1; x++) for (let y = 1; y < arena.height - 1; y++) {
    const cell = key(x, y);
    if (!solid.has(cell) && !soft.has(cell)) graph.set(cell, []);
  }
  for (const [cell, adjacent] of graph) {
    const [x, y] = cell.split(',').map(Number);
    for (const [nx, ny] of neighbors(x, y)) if (insideArena(arena, nx, ny) && graph.has(key(nx, ny))) adjacent.push(key(nx, ny));
  }
  return graph;
}

function graphDistances(graph, start, { removed, allow = () => true, limit = Infinity } = {}) {
  if (start === removed || !graph.has(start) || !allow(start)) return new Map();
  const found = new Map([[start, 0]]), queue = [start];
  for (const cell of queue) {
    const distance = found.get(cell);
    if (distance >= limit) continue;
    for (const next of graph.get(cell)) if (next !== removed && !found.has(next) && allow(next)) {
      found.set(next, distance + 1); queue.push(next);
    }
  }
  return found;
}

function assertMirrored(cells, arena, label) {
  for (const cell of cells) {
    const [x, y] = cell.split(',').map(Number);
    assert.ok(cells.has(key(arena.width - 1 - x, y)), `${label}: x reflection ${cell}`);
    assert.ok(cells.has(key(x, arena.height - 1 - y)), `${label}: y reflection ${cell}`);
  }
}

function assertRobustGraph(graph, label) {
  const first = graph.keys().next().value;
  assert.equal(graphDistances(graph, first).size, graph.size, `${label}: disconnected free cells`);
  for (const [cell, adjacent] of graph) {
    assert.ok(adjacent.length >= 2, `${label}: dead end ${cell}`);
    const start = cell === first ? adjacent[0] : first;
    assert.equal(graphDistances(graph, start, { removed: cell }).size, graph.size - 1, `${label}: articulation ${cell}`);
  }
}

const crateSeeds = {
  garden: [[4, 5], [5, 2], [5, 4], [5, 5]],
  lagoon: [[4, 5], [5, 4], [5, 5], [6, 5]],
  candy: [[5, 2], [5, 4], [5, 5], [6, 5]],
  harbor: [[5, 2], [5, 4], [5, 5], [6, 2]],
  festival: [[4, 2], [5, 2], [6, 4]]
};
const expectedWalls = id => {
  const cells = new Set();
  for (let x = 0; x < 15; x++) for (let y = 0; y < 13; y++) {
    if (x === 0 || x === 14 || y === 0 || y === 12) cells.add(key(x, y));
  }
  const products = id === 'harbor' ? [[[4, 10], [2, 4, 8, 10]], [[6, 8], [4, 8]]]
    : id === 'festival' ? [[[4, 10], [4, 5, 7, 8]], [[6, 8], [2, 10]]]
    : [[[4, 6, 8, 10], [2, 4, 8, 10]], [[3, 11], [4, 8]]];
  for (const [xs, ys] of products) for (const x of xs) for (const y of ys) cells.add(key(x, y));
  return cells;
};

test('layout geometry defaults by mode, supports explicit overrides and keeps an exact two-set result', () => {
  assert.deepEqual(TIDEGATES, tideGateGroups(LEGACY_ARENA));
  assert.deepEqual(TEAM_SPAWNS, spawnPoints(LEGACY_ARENA));
  for (const { id } of MAPS) {
    assert.deepEqual(createLayout(id, 'team'), createLayout(id, 'team', { arena: TEAM_ARENA }));
    assert.deepEqual(createLayout(id, 'duel'), createLayout(id, 'duel', { arena: LEGACY_ARENA }));
    for (const arena of [LEGACY_ARENA, TEAM_ARENA]) for (const mode of ['team', 'duel']) {
      const layout = createLayout(id, mode, { arena });
      assert.deepEqual(Object.keys(layout), ['solid', 'soft']);
      assert.ok(layout.solid instanceof Set && layout.soft instanceof Set);
      const again = createLayout(id, mode, { arena });
      assert.notEqual(layout.solid, again.solid);
      assert.notEqual(layout.soft, again.soft);
      for (const cells of [layout.solid, layout.soft]) {
        const xy = [...cells].map(cell => cell.split(',').map(Number));
        assert.deepEqual(xy, [...xy].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
      }
    }
    for (const arena of [null, {}, { width: 15 }, { width: '15', height: 13 }, { width: 15, height: 11 }]) {
      assert.deepEqual(createLayout(id, 'team', { arena }), createLayout(id, 'team', { arena: LEGACY_ARENA }));
    }
  }
  assert.equal(createLayout('garden', 'team').solid.has('14,12'), true);
  assert.equal(createLayout('garden', 'duel').solid.has('14,12'), false);
  for (const map of [undefined, null, '', 'unknown', {}, 0]) assert.throws(() => createLayout(map, 'team'), RangeError);
  for (const mode of [undefined, null, '', 'unknown', {}, 0]) assert.throws(() => createLayout('garden', mode), RangeError);
});

for (const { id } of MAPS) {
  test(`${id}: expanded layout has exact permanent walls and mirrored crate seeds`, () => {
    const { solid, soft } = createLayout(id, 'team');
    assert.deepEqual(solid, expectedWalls(id));
    const expectedSoft = new Set(crateSeeds[id].flatMap(([x, y]) => [key(x, y), key(14 - x, y), key(x, 12 - y), key(14 - x, 12 - y)]));
    assert.deepEqual(soft, expectedSoft);
    assert.ok([...soft].every(cell => !solid.has(cell)));
  });
  const phases = id === 'harbor' ? [null, ...tideGateGroups(TEAM_ARENA)] : [null];
  for (const phase of phases) test(`${id}/${phase?.id || 'open'}: expanded graph supports fair starts and robust routes`, () => {
    const arena = TEAM_ARENA, { solid, soft } = createLayout(id, 'team');
    const walls = new Set([...solid, ...(phase?.cells || [])]);
    for (const cell of tideGateGroups(arena).flatMap(group => group.cells)) {
      if (id === 'harbor') assert.ok(!solid.has(cell) && !soft.has(cell), `gate overlaps terrain: ${cell}`);
    }
    assertMirrored(walls, arena, 'walls');
    assertMirrored(soft, arena, 'crates');
    assertMirrored(new Set(spawnPoints(arena).map(([x, y]) => key(x, y))), arena, 'spawns');
    const graph = freeGraph(arena, walls, soft);
    const expectedFree = id === 'festival' ? 119 : id === 'harbor' ? phase ? 113 : 115 : 107;
    assert.equal(graph.size, expectedFree);
    assertRobustGraph(graph, 'initial');
    assertRobustGraph(freeGraph(arena, walls), 'cleared');
    const center = arenaCenter(arena), centerKey = key(center.x, center.y);
    for (const [x, y] of spawnPoints(arena)) {
      const spawn = key(x, y), distances = graphDistances(graph, spawn);
      assert.equal(distances.size, graph.size, `spawn ${spawn} cannot meet opponents`);
      assert.ok(distances.has(centerKey), `spawn ${spawn} cannot reach center`);
      assert.ok(graph.get(spawn).length >= 2, `spawn ${spawn} has fewer than two exits`);
      assert.ok(graphDistances(graph, spawn, { limit: 3 }).size >= 10, `spawn ${spawn} lacks local space`);
      assert.ok([...graphDistances(graph, spawn, { limit: 2 })].some(([cell, distance]) => {
        const [cx, cy] = cell.split(',').map(Number);
        return distance === 2 && cx !== x && cy !== y;
      }), `spawn ${spawn} cannot escape its range-3 cross in two moves`);
      const ownHalf = cell => x < center.x ? Number(cell.split(',')[0]) < center.x : Number(cell.split(',')[0]) > center.x;
      assert.ok(graphDistances(graph, spawn, { allow: ownHalf }).size >= 48, `spawn ${spawn} has too little connected home space`);
    }
  });
}
