import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MAPS, TEAM_SPAWNS, TIDEGATES, createLayout } from '../public/map-catalog.js';
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

test('all original layouts retain byte-for-byte solid and soft insertion order', () => {
  const hashes = {
    'garden/team': 'a513bf624a594e7d1bfbb7a555d19f25e525e741d2960d3fd997b8d0525a6fb5',
    'garden/duel': '6511032c6fb273649f076cd3917255a777ee765918032f81712420d1963cc5f9',
    'lagoon/team': '5a1cfa3c08308d5978c969d8beaaba73796dbf0a4feb521f378d07816efe2614',
    'lagoon/duel': '6add9fa1d522c75499b1164ab50bcc7cf12d04cb378e3b4ec73019d6106fedd6',
    'candy/team': 'abe75c693a7a04ea678a5c48849ff4763aef9445d121078cc8ea5b01b791587c',
    'candy/duel': 'a51ed57ba6655540d821f0e556e18a99ae21df46cd584b5b8a18725102f1ed76'
  };
  for (const [selection, expected] of Object.entries(hashes)) {
    const layout = createLayout(...selection.split('/'));
    const actual = createHash('sha256').update(JSON.stringify({ solid: [...layout.solid], soft: [...layout.soft] })).digest('hex');
    assert.equal(actual, expected, selection);
  }
});

for (const id of ['harbor', 'festival']) for (const mode of ['team', 'duel']) {
  test(`${id}/${mode}: symmetric structures, safe spawns and connected center/bases`, () => {
    const { solid, soft } = createLayout(id, mode);
    assert.deepEqual(createLayout(id, mode), { solid, soft });
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
