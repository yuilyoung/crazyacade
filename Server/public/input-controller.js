import { actionForEvent, normalizeBindings } from './controls.js';

const DIRECTIONS = new Set(['up', 'down', 'left', 'right']);

// Physical codes remain independent even when several keys map to one direction.
// The caller polls tick() on its own timer; animation frames never schedule input.
export function createInputController({ bindings, movementMode = 'continuous', onAction = () => {}, onDirectionRelease = () => {} } = {}) {
  let mapping = normalizeBindings(bindings), mode = movementMode === 'step' ? 'step' : 'continuous';
  const held = new Map();
  function currentDirection() {
    return [...held.values()].reverse().find(action => DIRECTIONS.has(action)) ?? null;
  }
  function reset() { held.clear(); }
  return {
    press(event) {
      const action = actionForEvent(event, mapping);
      if (!action || event.repeat || held.has(event.code)) return null;
      held.set(event.code, action);
      onAction(action);
      return action;
    },
    // Release must work even when focus moved into a form after the press.
    release(eventOrCode) {
      const previous = currentDirection();
      if (!held.delete(typeof eventOrCode === 'string' ? eventOrCode : eventOrCode?.code)) return;
      if (previous && mode === 'continuous') {
        const next = currentDirection();
        if (next !== previous) onDirectionRelease(previous, next);
      }
    },
    currentDirection,
    tick() { return mode === 'continuous' ? currentDirection() : null; },
    reset,
    configure(options = {}) {
      if (Object.hasOwn(options, 'bindings')) mapping = normalizeBindings(options.bindings);
      if (Object.hasOwn(options, 'movementMode')) mode = options.movementMode === 'step' ? 'step' : 'continuous';
      reset();
    }
  };
}

export function bindTouchControls(buttons, sendAction, onDirectionChange = () => {}) {
  const held = new Map();
  const directions = new Set(Array.from(buttons).filter(button => DIRECTIONS.has(button.dataset.action)));
  function currentDirection() {
    let latest = null;
    for (const { direction } of held.values()) if (direction) latest = direction;
    return latest;
  }
  function notify(previous, reason) {
    const next = currentDirection();
    if (previous !== next) onDirectionChange(previous, next, reason);
  }
  function steer(pointerId, button, direction) {
    const previous = currentDirection();
    // A finger that changes direction takes priority over older holds.
    held.delete(pointerId);
    held.set(pointerId, { button, direction });
    if (direction) sendAction(direction);
    notify(previous, direction ? 'press' : 'release');
  }
  for (const button of buttons) {
    const { action } = button.dataset;
    button.addEventListener('pointerdown', event => {
      if (event.button > 0) return;
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      if (directions.has(button)) steer(event.pointerId, button, action);
      else sendAction(action);
    });
    const release = event => {
      if (held.get(event.pointerId)?.button !== button) return;
      const previous = currentDirection();
      held.delete(event.pointerId);
      notify(previous, 'release');
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, release);
    button.addEventListener('pointermove', event => {
      // Releasing one mouse button during a chord emits pointermove, not pointerup.
      if (event.pointerType === 'mouse' && event.button === 0 && !(event.buttons & 1)) release(event);
      const contact = held.get(event.pointerId);
      if (contact?.button !== button || !['touch', 'pen'].includes(event.pointerType)) return;
      // Pointer capture keeps this listener on the starting button as the finger travels.
      const target = button.ownerDocument.elementFromPoint(event.clientX, event.clientY)?.closest('button[data-action]');
      const direction = directions.has(target) && !target.disabled ? target.dataset.action : null;
      if (contact.direction !== direction) steer(event.pointerId, button, direction);
    });
    // Keep keyboard and assistive-technology activation one-shot.
    button.addEventListener('keydown', event => {
      if (event.key === 'Enter' && event.repeat) event.preventDefault();
    });
    button.addEventListener('click', event => { if (event.detail === 0) sendAction(action); });
  }
  return {
    currentDirection,
    reset() {
      const previous = currentDirection();
      held.clear();
      notify(previous, 'reset');
    }
  };
}
