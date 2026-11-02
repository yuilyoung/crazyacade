import { test } from 'node:test';
import assert from 'node:assert/strict';

// Regression: a successful final-tick action used to disappear from the checklist.
// Presentation runs with unavailable audio/storage; combat snapshots stay authoritative.
test('tutorial counts accepted final-tick actions and a fresh basic match resets progress', async t => {
  const originals = new Map(['window', 'document', 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const attributes = new Map();
      elements.set(id, { dataset: {}, textContent: '', hidden: false,
        setAttribute(key, value) { attributes.set(key, value); }, getAttribute(key) { return attributes.get(key); }, addEventListener() {} });
    }
    return elements.get(id);
  }
  globalThis.document = { body: { dataset: {} }, hidden: false, addEventListener() {}, querySelector: element };
  globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: true, addEventListener() {} }) };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage blocked'); } });
  const { createExperience } = await import('../public/experience.js');
  const experience = createExperience(element);
  assert.equal(experience.reducedMotion, true);
  assert.equal(element('sound-toggle').disabled, true);
  assert.equal(element('music-toggle').disabled, true);
  experience.reset(true);
  const me = { id: 'human', x: 1, y: 1, bombsPlaced: 0, itemsCollected: 0, rescues: 0 };
  experience.update({ phase: 'playing', itemMode: true, players: [me], waves: [] }, me);
  for (const step of ['move', 'bomb', 'item']) assert.equal(element(`[data-step="${step}"]`).dataset.complete, 'false');
  const final = { ...me, x: 2, bombsPlaced: 1, itemsCollected: 1 };
  experience.update({ phase: 'finished', itemMode: true, players: [final], waves: [], result: { draw: true } }, final);
  for (const step of ['move', 'bomb', 'item']) assert.equal(element(`[data-step="${step}"]`).dataset.complete, 'true', `${step} accepted on the final tick`);
  experience.reset(false);
  assert.equal(element('[data-step="item"]').dataset.optional, 'true');
  for (const step of ['move', 'bomb', 'item']) assert.equal(element(`[data-step="${step}"]`).dataset.complete, 'false', 'fresh match must reset progress');
});
