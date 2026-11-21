import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindTouchControls } from '../public/input-controller.js';

test('secondary mouse buttons leave on-screen game controls idle', () => {
  for (const action of ['right', 'place_orb']) {
    const element = new EventTarget();
    element.dataset = { action };
    const captured = [], sent = [];
    element.setPointerCapture = id => captured.push(id);
    const controls = bindTouchControls([element], value => sent.push(value));

    function pointerDown(button) {
      const event = Object.assign(new Event('pointerdown', { cancelable: true }), {
        pointerId: 1, pointerType: 'mouse', button
      });
      element.dispatchEvent(event);
      return event;
    }

    for (const button of [1, 2]) {
      const event = pointerDown(button);
      assert.deepEqual(sent, []);
      assert.equal(controls.currentDirection(), null);
      assert.deepEqual(captured, []);
      assert.equal(event.defaultPrevented, false);
    }
    assert.equal(pointerDown(0).defaultPrevented, true);
    assert.deepEqual(sent, [action]);
    assert.deepEqual(captured, [1]);
    assert.equal(controls.currentDirection(), action === 'right' ? 'right' : null);
  }
});
