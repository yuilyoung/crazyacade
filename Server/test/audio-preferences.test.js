import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExperience } from '../public/experience.js';

test('audio levels survive a new page without enabling either channel', t => {
  const keys = ['window', 'document', 'localStorage', 'AudioContext'];
  const originals = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  t.after(() => keys.forEach((key, i) => {
    if (originals[i]) Object.defineProperty(globalThis, key, originals[i]);
    else delete globalThis[key];
  }));
  const saved = new Map();
  let contexts = 0;
  let denyStorage = false;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      if (denyStorage) throw Error('Storage blocked');
      return {
        getItem: key => saved.get(key) ?? null,
        setItem: (key, value) => saved.set(key, value),
      };
    },
  });

  function visit() {
    const elements = new Map();
    const $ = id => {
      if (!elements.has(id)) {
        const attributes = new Map(), listeners = new Map();
        elements.set(id, {
          dataset: {}, value: '',
          setAttribute: (key, value) => attributes.set(key, value),
          getAttribute: key => attributes.get(key),
          addEventListener: (type, fn) => listeners.set(type, fn),
          fill(value) { this.value = value; listeners.get('input')(); },
        });
      }
      return elements.get(id);
    };
    globalThis.AudioContext = class { constructor() { contexts++; } };
    globalThis.window = { addEventListener() {} };
    globalThis.document = { body: { dataset: {} }, addEventListener() {}, hidden: false, querySelector: $ };
    createExperience($);
    return $;
  }

  const $ = visit();
  assert.equal($('music-volume').value, '35');
  assert.equal($('effects-volume').value, '60');
  $('music-volume').fill('0');
  $('effects-volume').fill('45');
  const reopened = visit();
  assert.equal(reopened('music-volume').value, '0', 'zero is a saved setting');
  assert.equal(reopened('effects-volume').value, '45');
  assert.equal(reopened('effects-volume').getAttribute('aria-valuetext'), '45%');
  for (const id of ['music-toggle', 'sound-toggle']) {
    assert.equal(reopened(id).getAttribute('aria-pressed'), 'false');
  }

  const musicKey = 'popPop:music-volume';
  for (const invalid of ['', 'NaN', '101', '-1']) {
    saved.set(musicKey, invalid);
    const page = visit();
    assert.equal(page('music-volume').value, '35');
    assert.equal(page('effects-volume').value, '45', 'a bad music setting must not reset effects');
  }

  denyStorage = true;
  const blocked = visit();
  assert.equal(blocked('music-volume').value, '35');
  blocked('music-volume').fill('18');
  assert.equal(blocked('music-volume').value, '18', 'sliders still work in memory');
  assert.equal(contexts, 0);
});
