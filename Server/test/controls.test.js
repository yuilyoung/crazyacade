import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BINDINGS, actionForEvent, keyLabel, normalizeBindings, validateBindings } from '../public/controls.js';

test('physical codes work with Korean IME and never fall back to a localized key', () => {
  assert.equal(actionForEvent({ code: 'KeyW', key: 'ㅈ' }), 'up');
  assert.equal(actionForEvent({ code: 'Space', key: ' ' }), 'bomb');
  assert.equal(actionForEvent({ code: 'KeyF', key: 'ㄹ' }), 'dart');
  assert.equal(actionForEvent({ code: 'Unidentified', key: 'w' }), null);
});

test('remapping removes old primary keys while keeping arrow aliases', () => {
  const bindings = { ...DEFAULT_BINDINGS, up: 'KeyI', bomb: 'Digit1' };
  assert.equal(actionForEvent({ code: 'KeyI' }, bindings), 'up');
  assert.equal(actionForEvent({ code: 'ArrowUp' }, bindings), 'up');
  assert.equal(actionForEvent({ code: 'KeyW' }, bindings), null);
  assert.equal(actionForEvent({ code: 'Digit1' }, bindings), 'bomb');
  assert.equal(keyLabel(bindings.bomb), '1');
  assert.equal(keyLabel(bindings.up), 'I');
});

test('modifiers and form or editable targets never trigger gameplay', () => {
  for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) {
    assert.equal(actionForEvent({ code: 'KeyW', [modifier]: true }), null);
  }
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']) {
    assert.equal(actionForEvent({ code: 'Space', target: { tagName } }), null);
  }
  assert.equal(actionForEvent({ code: 'KeyW', target: { isContentEditable: true } }), null);
  assert.equal(actionForEvent({ code: 'KeyW', target: { closest: () => ({ isContentEditable: true }) } }), null);
  assert.equal(actionForEvent({ code: 'KeyW', shiftKey: true }), 'up');
});

test('invalid and duplicate bindings fail validation without mutating defaults', () => {
  for (const patch of [{ up: 'ArrowUp' }, { dart: 'Space' }, { right: 'F5' }, { bomb: null }]) {
    const invalid = { ...DEFAULT_BINDINGS, ...patch };
    assert.equal(validateBindings(invalid).valid, false);
    assert.ok(validateBindings(invalid).error);
    const normalized = normalizeBindings(invalid);
    assert.equal(normalized.up, 'KeyW');
    normalized.up = 'KeyI';
    assert.equal(DEFAULT_BINDINGS.up, 'KeyW');
  }
  assert.equal(validateBindings({ up: 'KeyI' }).valid, false);
  assert.equal(validateBindings({ ...DEFAULT_BINDINGS, dart: 'Digit2' }).valid, true);
});

test('legacy six-key mappings preserve every key and add an unused pass shortcut', () => {
  const legacy = { up: 'KeyG', down: 'KeyH', left: 'KeyJ', right: 'KeyK', bomb: 'Space', dart: 'KeyF' };
  const upgraded = normalizeBindings(legacy);
  for (const action of Object.keys(legacy)) assert.equal(upgraded[action], legacy[action]);
  assert.equal(new Set(Object.values(upgraded)).size, 7);
  assert.equal(validateBindings(upgraded).valid, true);
  assert.equal(actionForEvent({ code: upgraded.pass }, upgraded), 'pass');
  assert.equal(DEFAULT_BINDINGS.pass, 'KeyG');
});

test('focused links and nested link content do not send gameplay actions', () => {
  assert.equal(actionForEvent({ code: 'Space', target: { tagName: 'A' } }), null);
  const link = { tagName: 'A' };
  const nested = { tagName: 'SPAN', closest: selector => selector.split(',').map(part => part.trim()).includes('a') ? link : null };
  assert.equal(actionForEvent({ code: 'KeyF', target: nested }), null);
});
