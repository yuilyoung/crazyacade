import { normalizeBindings, validateBindings } from './controls.js';

const STORAGE_KEY = 'popPop:playPreferences';
const normalize = value => ({ bindings: normalizeBindings(value?.bindings), highContrast: value?.highContrast === true, leftHanded: value?.leftHanded === true });
const copy = value => ({ ...value, bindings: { ...value.bindings } });

// Storage is optional: restricted/embedded browsers keep the same controls for this visit.
export function createPreferences(storage) {
  let value = normalize(null);
  try {
    if (storage === undefined) storage = globalThis.localStorage;
    value = normalize(JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null'));
  } catch { /* Keep defaults if storage is corrupt or unavailable. */ }
  function save(next) {
    value = next;
    try { storage?.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* In-memory choices remain usable. */ }
    return copy(value);
  }
  return {
    get value() { return copy(value); },
    update(patch = {}) {
      if (Object.hasOwn(patch, 'bindings')) {
        const validation = validateBindings(patch.bindings);
        if (!validation.valid) throw new Error(validation.error);
      }
      return save(normalize({ ...value, ...patch }));
    },
    reset() { return save(normalize(null)); }
  };
}
