import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as inputModule from '../public/input-controller.js';
import * as controls from '../public/controls.js';

test('releasing W preserves an independently held ArrowUp alias', () => {
  const input = inputModule.createInputController();
  input.press({ code: 'KeyW' }); input.press({ code: 'ArrowUp' });
  input.release({ code: 'KeyW', target: { tagName: 'INPUT' } });
  assert.equal(input.currentDirection(), 'up');
  input.release('ArrowUp');
  assert.equal(input.currentDirection(), null);
});

test('direction falls back in physical press order and OS repeats do not reorder it', () => {
  const input = inputModule.createInputController();
  input.press({ code: 'KeyW' }); input.press({ code: 'KeyD' });
  input.press({ code: 'KeyW', repeat: true });
  assert.equal(input.currentDirection(), 'right');
  input.release('KeyD'); assert.equal(input.currentDirection(), 'up');
  input.reset(); assert.equal(input.currentDirection(), null);
});

test('continuous ticks and one-cell presses are independent of render and OS repeats', () => {
  const sent = [], input = inputModule.createInputController({ onAction: action => sent.push(action) });
  input.press({ code: 'KeyW' }); input.press({ code: 'KeyW', repeat: true });
  assert.deepEqual(sent, ['up']);
  assert.equal(input.tick(), 'up'); assert.equal(input.tick(), 'up');
  input.configure({ movementMode: 'step' });
  assert.equal(input.currentDirection(), null);
  input.press({ code: 'KeyW' }); input.press({ code: 'KeyW', repeat: true });
  assert.equal(input.tick(), null);
  assert.deepEqual(sent, ['up', 'up']);
  input.release('KeyW'); input.press({ code: 'KeyW' });
  assert.deepEqual(sent, ['up', 'up', 'up']);
});

test('IJKL preset, pass, protected targets and modifiers use the same physical mapping', () => {
  const sent = [], input = inputModule.createInputController({ bindings: controls.PRESETS.ijkl, onAction: a => sent.push(a) });
  assert.equal(input.press({ code: 'KeyI' }), 'up');
  input.release('KeyI');
  assert.equal(input.press({ code: 'KeyG' }), 'pass');
  assert.equal(input.press({ code: 'KeyW' }), null);
  assert.equal(input.press({ code: 'KeyI', target: { tagName: 'INPUT' } }), null);
  assert.equal(input.press({ code: 'KeyL', ctrlKey: true }), null);
  assert.deepEqual(sent, ['up', 'pass']);
  assert.equal(input.currentDirection(), null);
});
