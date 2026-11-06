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

test('display, movement and cosmetic settings survive reload without leaking mutable loadout', () => {
  const storage = memoryStorage(), preferences = createPreferences(storage);
  const patch = { quality: 'high', fontScale: 130, effects: 'minimal', captions: false, itemStyle: 'garden', focus: true, movementMode: 'step',
    loadout: { characterId: 'bibi', skinId: 'astronaut', orbSkinId: 'duck' } };
  preferences.update(patch);
  const restored = createPreferences(storage).value;
  for (const key of Object.keys(patch)) assert.deepEqual(restored[key], patch[key]);
  restored.loadout.orbSkinId = 'star';
  assert.equal(preferences.value.loadout.orbSkinId, 'duck');
  preferences.update({ loadout: { skinId: 'bee' } });
  assert.deepEqual(preferences.value.loadout, { characterId: 'bibi', skinId: 'bee', orbSkinId: 'duck' });
});

test('persisted settings use explicit allowlists and defaults with storage unavailable', () => {
  const storage = memoryStorage(JSON.stringify({ quality: 'ultra', fontScale: 999, effects: 'flash', captions: 0, itemStyle: 'html', focus: 'yes', movementMode: 'turbo',
    loadout: { characterId: 'unknown', skinId: 'unknown', orbSkinId: 'unknown', secret: 'discard' }, secret: 'discard' }));
  const defaults = createPreferences(memoryStorage()).value;
  assert.deepEqual(createPreferences(storage).value, defaults);
  assert.equal(defaults.quality, 'auto'); assert.equal(defaults.fontScale, 100);
  assert.equal(defaults.effects, 'full'); assert.equal(defaults.captions, true);
  assert.deepEqual(defaults.loadout, { characterId: 'momo', skinId: 'classic', orbSkinId: 'bubble' });
  const denied = createPreferences({ getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } });
  denied.update({ quality: 'low', effects: 'calm', loadout: { orbSkinId: 'star' } });
  assert.equal(denied.value.quality, 'low'); assert.equal(denied.value.effects, 'calm');
  assert.equal(denied.value.loadout.orbSkinId, 'star');
  assert.deepEqual(denied.reset(), defaults);
});

test('legacy six-key storage is upgraded without a collision with a customized G shortcut', () => {
  const bindings = { up: 'KeyG', down: 'KeyS', left: 'KeyA', right: 'KeyD', bomb: 'Space', dart: 'KeyF' };
  const preferences = createPreferences(memoryStorage(JSON.stringify({ bindings })));
  assert.equal(preferences.value.bindings.up, 'KeyG');
  assert.equal(new Set(Object.values(preferences.value.bindings)).size, 7);
});

test('pass guidance defaults on, persists explicit off, ignores nonboolean settings and survives denied storage',()=>{
 const storage=memoryStorage();const preferences=createPreferences(storage);assert.equal(preferences.value.passGuide,true);preferences.update({passGuide:false});assert.equal(createPreferences(storage).value.passGuide,false);
 assert.equal(createPreferences(memoryStorage('{"passGuide":"false"}')).value.passGuide,true);
 const denied=createPreferences({getItem(){throw Error('denied');},setItem(){throw Error('denied');}});denied.update({passGuide:false});assert.equal(denied.value.passGuide,false);assert.equal(denied.reset().passGuide,true);
});
