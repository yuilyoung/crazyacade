import test from 'node:test';
import assert from 'node:assert/strict';

// These catalogs cross the server/browser boundary. A new value must be a
// deliberate product choice, and descriptive metadata must never grant stats.
test('cosmetic catalogs expose the complete free selection without gameplay modifiers', async () => {
  const { CHARACTERS, SKINS, ORB_SKINS, ITEM_STYLES } = await import('../public/cosmetics.js');
  const expected = [
    [CHARACTERS, ['momo', 'nori', 'bibi', 'toto']],
    [SKINS, ['classic', 'sunset', 'mint', 'astronaut', 'bee', 'raincoat']],
    [ORB_SKINS, ['bubble', 'star', 'duck']],
    [ITEM_STYLES, ['classic', 'candy', 'garden']],
  ];
  for (const [catalog, ids] of expected) {
    assert.deepEqual(catalog.map(entry => entry.id), ids);
    assert.equal(new Set(catalog.map(entry => entry.id)).size, catalog.length);
    assert.ok(Object.isFrozen(catalog));
    for (const entry of catalog) {
      assert.deepEqual(Object.keys(entry).sort(), ['description', 'id', 'label']);
      assert.ok(entry.label.length > 0 && entry.description.length > 0);
      assert.ok(Object.isFrozen(entry));
      assert.throws(() => { entry.speed = 99; }, TypeError);
    }
  }
});
