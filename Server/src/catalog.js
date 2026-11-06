import { CHARACTERS, SKINS, ORB_SKINS } from '../public/cosmetics.js';
export { resolveMap, createLayout } from '../public/map-catalog.js';

// Accept identifiers only; cosmetic metadata never contributes combat stats.
const characters = new Set(CHARACTERS.map(character => character.id));
const skins = new Set(SKINS.map(skin => skin.id));
const orbSkins = new Set(ORB_SKINS.map(skin => skin.id));

export function resolveAppearance(characterId = 'momo', skinId = 'classic', orbSkinId = 'bubble') {
  return characters.has(characterId) && skins.has(skinId) && orbSkins.has(orbSkinId)
    ? { characterId, skinId, orbSkinId } : null;
}
