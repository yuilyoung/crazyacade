import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindTouchControls } from '../public/input-controller.js';

function fixture(action) {
  const button = Object.assign(new EventTarget(), { dataset: { action }, setPointerCapture() {} });
  const actions = [];
  const controls = bindTouchControls([button], value => actions.push(value));
  const fire = (type, properties) => button.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), properties));
  return { actions, controls, fire };
}

test('releasing the primary mouse button ends movement while a secondary button stays down', () => {
  const { actions, controls, fire } = fixture('right');
  const mouse = { pointerType: 'mouse', pointerId: 1 };
  fire('pointerdown', { ...mouse, button: 0, buttons: 1 });
  fire('pointermove', { ...mouse, button: 2, buttons: 3 });
  assert.equal(controls.currentDirection(), 'right');
  fire('pointermove', { ...mouse, button: 0, buttons: 2 });
  assert.equal(controls.currentDirection(), null);
  assert.deepEqual(actions, ['right']);
});

test('holding Enter activates a focused game button once per physical press', () => {
  const { actions, fire } = fixture('place_orb');
  // A native button dispatches detail=0 click as the default action of Enter keydown.
  for (const repeat of [false, true, true, false]) {
    if (fire('keydown', { key: 'Enter', repeat })) fire('click', { detail: 0 });
  }
  assert.deepEqual(actions, ['place_orb', 'place_orb']);
  assert.equal(fire('keydown', { key: ' ', repeat: true }), true);
  fire('click', { detail: 0 });
  assert.equal(actions.length, 3);
});
