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

test('a captured finger steers across the pad, rests outside it and resumes on re-entry', () => {
  let target = null;
  const ownerDocument = { elementFromPoint: () => target };
  const makeButton = action => Object.assign(new EventTarget(), {
    dataset: { action }, ownerDocument, setPointerCapture() {}
  });
  const right = makeButton('right'), up = makeButton('up'), orb = makeButton('place_orb');
  const actions = [], changes = [];
  const controls = bindTouchControls([right, up, orb], action => actions.push(action), (...change) => changes.push(change));
  const fire = (type, pointerId) => right.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), {
    pointerId, pointerType: 'touch', button: 0, clientX: 45, clientY: 85
  }));
  const moveTo = button => {
    target = button && { closest: () => button };
    fire('pointermove', 1);
  };

  fire('pointerdown', 1);
  moveTo(up); moveTo(up);
  assert.equal(controls.currentDirection(), 'up');
  moveTo(orb); moveTo(null);
  assert.equal(controls.currentDirection(), null);
  moveTo(right);
  fire('lostpointercapture', 1);
  moveTo(up);
  assert.equal(controls.currentDirection(), null);
  assert.deepEqual(actions, ['right', 'up', 'right']);
  assert.deepEqual(changes, [
    [null, 'right', 'press'], ['right', 'up', 'press'], ['up', null, 'release'],
    [null, 'right', 'press'], ['right', null, 'release']
  ]);
});

test('cancel and reset clear the displayed hold while preserving other fingers', () => {
  const changes = [];
  const makeButton = action => Object.assign(new EventTarget(), { dataset: { action }, setPointerCapture() {} });
  const left = makeButton('left'), up = makeButton('up');
  const controls = bindTouchControls([left, up], () => {}, (...change) => changes.push(change));
  const fire = (button, type, pointerId) => button.dispatchEvent(Object.assign(new Event(type), { pointerId, button: 0 }));
  fire(left, 'pointerdown', 1); fire(up, 'pointerdown', 2); fire(up, 'pointercancel', 2);
  controls.reset();
  fire(left, 'lostpointercapture', 1);
  assert.deepEqual(changes, [
    [null, 'left', 'press'], ['left', 'up', 'press'],
    ['up', 'left', 'release'], ['left', null, 'reset']
  ]);
});
