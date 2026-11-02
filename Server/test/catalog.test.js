import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAppearance, resolveMap, createLayout } from '../src/catalog.js';

test('appearance accepts known cosmetics, defaults omitted values and rejects invalid input', () => {
  assert.deepEqual(resolveAppearance(), { characterId: 'momo', skinId: 'classic' });
  assert.deepEqual(resolveAppearance('nori', 'mint'), { characterId: 'nori', skinId: 'mint' });
  for (const [character, skin] of [['unknown', 'classic'], ['momo', 'unknown'], [null, 'classic'], [{}, 'classic']])
    assert.equal(resolveAppearance(character, skin), null);
});

test('map accepts documented identifiers and rejects invalid input', () => {
  assert.equal(resolveMap(), 'garden');
  assert.equal(resolveMap('lagoon'), 'lagoon');
  assert.equal(resolveMap('candy'), 'candy');
  assert.equal(resolveMap('unknown'), null);
  assert.equal(resolveMap(null), null);
});

test('map layouts are deterministic, distinct, and leave all eight spawns and exits clear', () => {
  const maps = ['garden', 'lagoon', 'candy'];
  const layouts = maps.map(id => createLayout(id, 'team'));
  for (let i = 0; i < maps.length; i++) {
    assert.deepEqual(createLayout(maps[i], 'team'), layouts[i]);
    for (const x of [1, 11]) for (const y of [1, 3, 7, 9]) {
      assert.equal(layouts[i].solid.has(`${x},${y}`), false);
      assert.equal(layouts[i].soft.has(`${x},${y}`), false);
      const neighbor = x === 1 ? 2 : 10;
      assert.equal(layouts[i].solid.has(`${neighbor},${y}`), false);
      assert.equal(layouts[i].soft.has(`${neighbor},${y}`), false);
    }
    assert.ok([...layouts[i].soft].every(cell => !layouts[i].solid.has(cell)));
  }
  assert.equal(new Set(layouts.map(layout => [...layout.soft].join('|'))).size, 3);
});

test('unknown map or mode cannot silently create a layout', () => {
  assert.throws(() => createLayout('unknown', 'team'), RangeError);
  assert.throws(() => createLayout('garden', 'unknown'), RangeError);
});
