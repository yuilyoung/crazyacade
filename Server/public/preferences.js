import { normalizeBindings, validateBindings } from './controls.js';
import { CHARACTERS, SKINS, ORB_SKINS, ITEM_STYLES } from './cosmetics.js';

const STORAGE_KEY = 'popPop:playPreferences';
const choice = (value, choices, fallback) => choices.includes(value) ? value : fallback;
const catalogChoice = (value, catalog, fallback) => catalog.some(item => item.id === value) ? value : fallback;
const normalize = value => ({
  bindings: normalizeBindings(value?.bindings),
  highContrast: value?.highContrast === true,
  leftHanded: value?.leftHanded === true,
  quality: choice(value?.quality, ['auto', 'low', 'high'], 'auto'),
  fontScale: choice(value?.fontScale, [100, 115, 130], 100),
  effects: choice(value?.effects, ['full', 'calm', 'minimal'], 'full'),
  captions: value?.captions !== false,
  passGuide: value?.passGuide !== false,
  itemStyle: catalogChoice(value?.itemStyle, ITEM_STYLES, 'classic'),
  focus: value?.focus === true,
  movementMode: choice(value?.movementMode, ['continuous', 'step'], 'continuous'),
  loadout: {
    characterId: catalogChoice(value?.loadout?.characterId, CHARACTERS, 'momo'),
    skinId: catalogChoice(value?.loadout?.skinId, SKINS, 'classic'),
    orbSkinId: catalogChoice(value?.loadout?.orbSkinId, ORB_SKINS, 'bubble')
  }
});
const copy = value => ({ ...value, bindings: { ...value.bindings }, loadout: { ...value.loadout } });

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
      return save(normalize({ ...value, ...patch, loadout: { ...value.loadout, ...patch.loadout } }));
    },
    reset() { return save(normalize(null)); }
  };
}
