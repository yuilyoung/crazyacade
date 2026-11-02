// Only cosmetic identifiers are accepted from clients; no selection changes stats.
const characters = new Set(['momo', 'nori', 'bibi', 'toto']);
const skins = new Set(['classic', 'sunset', 'mint']);
const maps = new Set(['garden', 'lagoon', 'candy']);
const teamSpawns = [[1, 1], [1, 3], [1, 7], [1, 9], [11, 1], [11, 3], [11, 7], [11, 9]];

export function resolveAppearance(characterId = 'momo', skinId = 'classic') {
  return characters.has(characterId) && skins.has(skinId) ? { characterId, skinId } : null;
}

export function resolveMap(mapId = 'garden') {
  return maps.has(mapId) ? mapId : null;
}

export function createLayout(mapId, mode) {
  if (!maps.has(mapId) || (mode !== 'team' && mode !== 'duel')) throw new RangeError('unknown map or mode');
  const solid = new Set();
  const soft = new Set();
  for (let x = 0; x < 13; x++) for (let y = 0; y < 11; y++) {
    const cell = `${x},${y}`;
    if (x === 0 || y === 0 || x === 12 || y === 10 || (x % 2 === 0 && y % 2 === 0)) {
      solid.add(cell);
      continue;
    }
    const spawnSafe = (x <= 2 && y <= 2) || (x >= 10 && y >= 8)
      || (mode === 'team' && teamSpawns.some(([sx, sy]) => Math.abs(x - sx) + Math.abs(y - sy) <= 1));
    const pattern = mapId === 'garden' ? (x + y * 3) % 4 === 0
      : mapId === 'lagoon' ? (x * 3 + y) % 5 === 0
      : (x * 2 + y * 3) % 5 === 1;
    if (!spawnSafe && pattern) soft.add(cell);
  }
  return { solid, soft };
}
