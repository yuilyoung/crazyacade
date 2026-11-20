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

function touchButton(action) {
  const listeners = new Map();
  return {
    dataset: { action }, setPointerCapture() {},
    addEventListener(type, listener) { listeners.set(type, listener); },
    fire(type, pointerId, detail = 1) {
      listeners.get(type)({ pointerId, detail, preventDefault() {} });
    }
  };
}

function touchFixture() {
  const left = touchButton('left'), right = touchButton('right');
  const orb = touchButton('place_orb'), sent = [];
  const touch = inputModule.bindTouchControls([left, right, orb], action => sent.push(action));
  return { left, right, orb, sent, touch };
}

test('releasing the latest touch resumes the older held direction', () => {
  const { left, right, sent, touch } = touchFixture();
  left.fire('pointerdown', 1); right.fire('pointerdown', 2);
  assert.equal(touch.currentDirection(), 'right');
  right.fire('pointerup', 2);
  assert.equal(touch.currentDirection(), 'left');
  right.fire('lostpointercapture', 2);
  assert.equal(touch.currentDirection(), 'left');
  left.fire('pointercancel', 1);
  assert.equal(touch.currentDirection(), null);
  assert.deepEqual(sent, ['left', 'right']);
});

test('releasing one of two touches on the same direction preserves the other', () => {
  const { right, touch } = touchFixture();
  right.fire('pointerdown', 1); right.fire('pointerdown', 2);
  right.fire('pointerup', 1);
  assert.equal(touch.currentDirection(), 'right');
  touch.reset();
  assert.equal(touch.currentDirection(), null);
});

test('placing an orb is one-shot and leaves the held direction intact', () => {
  const { right, orb, touch, sent } = touchFixture();
  right.fire('pointerdown', 1); orb.fire('pointerdown', 2);
  orb.fire('pointerup', 2); orb.fire('click', 2);
  assert.equal(touch.currentDirection(), 'right');
  orb.fire('click', 0, 0);
  assert.deepEqual(sent, ['right', 'place_orb', 'place_orb']);
});
