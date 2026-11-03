import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPreferences } from '../public/preferences.js';

function memoryStorage(initial) {
  const values = new Map(initial ? [['popPop:playPreferences', initial]] : []);
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('saved bindings and both accessibility options survive a new preference instance', () => {
  const storage = memoryStorage(), preferences = createPreferences(storage);
  preferences.update({ bindings: { ...preferences.value.bindings, up: 'KeyI' }, highContrast: true, leftHanded: true });
  const restored = createPreferences(storage).value;
  assert.equal(restored.bindings.up, 'KeyI');
  assert.equal(restored.highContrast, true);
  assert.equal(restored.leftHanded, true);
  restored.bindings.up = 'KeyG';
  assert.equal(preferences.value.bindings.up, 'KeyI');
});

test('denied reads and writes retain choices in memory and reset works', () => {
  const preferences = createPreferences({ getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } });
  preferences.update({ highContrast: true, leftHanded: true, bindings: { ...preferences.value.bindings, bomb: 'Digit1' } });
  assert.equal(preferences.value.bindings.bomb, 'Digit1');
  assert.equal(preferences.value.highContrast, true);
  const reset = preferences.reset();
  assert.equal(reset.bindings.bomb, 'Space');
  assert.equal(reset.highContrast, false);
  assert.equal(reset.leftHanded, false);
});

test('corrupt storage cannot activate options or retain duplicate shortcuts', () => {
  for (const serialized of ['{broken', 'null', '[]', '{"highContrast":"false","leftHanded":1,"bindings":{"up":"KeyI"}}',
    '{"bindings":{"up":"KeyW","down":"KeyS","left":"KeyA","right":"KeyD","bomb":"Space","dart":"Space"}}']) {
    const value = createPreferences(memoryStorage(serialized)).value;
    assert.equal(value.bindings.up, 'KeyW');
    assert.equal(value.bindings.dart, 'KeyF');
    assert.equal(value.highContrast, false);
    assert.equal(value.leftHanded, false);
  }
});

test('an invalid binding update leaves the previously working settings intact', () => {
  const preferences = createPreferences(memoryStorage());
  preferences.update({ highContrast: true });
  assert.throws(() => preferences.update({ bindings: { ...preferences.value.bindings, up: 'KeyF' } }), /키|key|binding/i);
  assert.equal(preferences.value.highContrast, true);
  assert.equal(preferences.value.bindings.up, 'KeyW');
});
