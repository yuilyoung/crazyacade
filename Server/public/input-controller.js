import { actionForEvent, normalizeBindings } from './controls.js';

const DIRECTIONS = new Set(['up', 'down', 'left', 'right']);

// Physical codes remain independent even when several keys map to one direction.
// The caller polls tick() on its own timer; animation frames never schedule input.
export function createInputController({ bindings, movementMode = 'continuous', onAction = () => {} } = {}) {
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
    release(eventOrCode) { held.delete(typeof eventOrCode === 'string' ? eventOrCode : eventOrCode?.code); },
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

export function bindTouchControls(buttons, sendAction) {
  // A newer press takes priority without erasing any direction still held.
  const held = new Map();
  for (const button of buttons) {
    const { action } = button.dataset;
    button.addEventListener('pointerdown', event => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      if (DIRECTIONS.has(action)) held.set(event.pointerId, action);
      sendAction(action);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      button.addEventListener(type, event => {
        if (held.get(event.pointerId) === action) held.delete(event.pointerId);
      });
    }
    // Keep keyboard and assistive-technology activation one-shot.
    button.addEventListener('click', event => { if (event.detail === 0) sendAction(action); });
  }
  return {
    currentDirection() {
      let latest = null;
      for (const action of held.values()) latest = action;
      return latest;
    },
    reset() { held.clear(); }
  };
}
