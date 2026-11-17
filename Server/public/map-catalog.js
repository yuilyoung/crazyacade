/** Shared, DOM-free map definitions for the authoritative server and previews. */
import { LEGACY_ARENA, TEAM_ARENA, arenaForMode, resolveArena, spawnPoints, tideGateGroups } from './arena-geometry.js';
export const WIDTH = LEGACY_ARENA.width;
export const HEIGHT = LEGACY_ARENA.height;
export const TEAM_SPAWNS = spawnPoints(LEGACY_ARENA);
export const MAPS = Object.freeze([
  { id: 'garden', name: '팝 가든', description: '익숙한 격자 정원에서 길을 열어 보세요.', theme: 'garden', feature: null },
  { id: 'lagoon', name: '반짝 라군', description: '물빛 격자 사이에 놓인 상자를 돌파하세요.', theme: 'lagoon', feature: null },
  { id: 'candy', name: '캔디 타운', description: '달콤한 상자 길에서 팀과 만나요.', theme: 'candy', feature: null },
  { id: 'harbor', name: '썰물 부두', description: '긴 교전로와 10초마다 교대하는 수문. 닫히기 2초 전 예고됩니다.', theme: 'harbor', feature: 'tidegates' },
  { id: 'festival', name: '풍선 광장', description: '순환 우회로를 돌아 중앙 광장으로 합류하세요.', theme: 'festival', feature: null }
].map(Object.freeze));
const themes = Object.freeze({
  garden: Object.freeze({floor:'#d9edc4',alternate:'#d1e7b9',wall:'#6eaaa0',wallTop:'#9acabc',box:'#e4b077',boxTop:'#f4d09c',landmark:'꽃 화단',strategy:'화단 사이 격자 우회로 · 균형 잡힌 교전'}),
  lagoon: Object.freeze({floor:'#ceeaf2',alternate:'#c0e2ec',wall:'#6298b5',wallTop:'#8fc3d6',box:'#d5b689',boxTop:'#f2d5a7',landmark:'산호 기둥',strategy:'산호 사이 넓은 측면 통로 · 측면에서 합류'}),
  candy: Object.freeze({floor:'#f1d5e4',alternate:'#edc9db',wall:'#a38aba',wallTop:'#c3afd9',box:'#e3a7b7',boxTop:'#ffd1dc',landmark:'롤리팝 벽',strategy:'과자 벽과 열린 위아래 길 · 빠른 방향 전환'}),
  harbor: Object.freeze({floor:'#cbe7ef',alternate:'#b6d9e4',wall:'#476f8b',wallTop:'#7d9fb0',box:'#b79064',boxTop:'#e2bb87',landmark:'접안 기둥·수문',strategy:'10초 교대 수문 · 2초 전 예고를 확인'}),
  festival: Object.freeze({floor:'#f7dfbf',alternate:'#f4d2a4',wall:'#b278a3',wallTop:'#e6b5cf',box:'#df9a69',boxTop:'#ffd89a',landmark:'풍선 기둥',strategy:'중앙 광장과 순환 우회로 · 양쪽에서 협공'})
});
export function mapTheme(mapId) { return themes[mapId] || themes.garden; }
export const MAP_IDS = Object.freeze(MAPS.map(map => map.id));
export const TIDEGATES = tideGateGroups(LEGACY_ARENA);
const mapIds = new Set(MAP_IDS);
const key = (x, y) => `${x},${y}`;

export function resolveMap(mapId = 'garden') {
  return mapIds.has(mapId) ? mapId : null;
}

function createLegacyLayout(mapId, mode) {
  const solid = new Set(), soft = new Set();
  const original = ['garden', 'lagoon', 'candy'].includes(mapId);
  for (let x = 0; x < WIDTH; x++) for (let y = 0; y < HEIGHT; y++) {
    const cell = key(x, y);
    const edge = x === 0 || y === 0 || x === WIDTH - 1 || y === HEIGHT - 1;
    const harborWall = [3, 9].includes(x) && [2, 4, 6, 8].includes(y)
      || [5, 7].includes(x) && [4, 6].includes(y);
    const festivalWall = [3, 9].includes(x) && [3, 4, 6, 7].includes(y)
      || [5, 7].includes(x) && [2, 8].includes(y);
    if (edge || (original ? x % 2 === 0 && y % 2 === 0 : mapId === 'harbor' ? harborWall : festivalWall)) {
      solid.add(cell);
      continue;
    }
    if (original) {
      // Preserve all six original map/mode layouts, including Set iteration order.
      const spawnSafe = (x <= 2 && y <= 2) || (x >= 10 && y >= 8)
        || (mode === 'team' && TEAM_SPAWNS.some(([sx, sy]) => Math.abs(x - sx) + Math.abs(y - sy) <= 1));
      const pattern = mapId === 'garden' ? (x + y * 3) % 4 === 0
        : mapId === 'lagoon' ? (x * 3 + y) % 5 === 0
        : (x * 2 + y * 3) % 5 === 1;
      if (!spawnSafe && pattern) soft.add(cell);
    } else {
      // Both new arenas keep every team spawn safe even in duel previews.
      const spawnSafe = TEAM_SPAWNS.some(([sx, sy]) => Math.abs(x - sx) + Math.abs(y - sy) <= 1);
      const openRoute = x === 1 || x === 11 || x === 6 || y === 1 || y === 9 || y === 5;
      const mirroredX = Math.min(x, WIDTH - 1 - x);
      const pattern = mapId === 'harbor' ? (mirroredX + y * 2) % 4 === 0 : (mirroredX + y) % 3 === 1;
      if (!spawnSafe && !openRoute && pattern) soft.add(cell);
    }
  }
  return { solid, soft };
}

const teamCrateSeeds = {
  garden: [[4, 5], [5, 2], [5, 4], [5, 5]],
  lagoon: [[4, 5], [5, 4], [5, 5], [6, 5]],
  candy: [[5, 2], [5, 4], [5, 5], [6, 5]],
  harbor: [[5, 2], [5, 4], [5, 5], [6, 2]],
  festival: [[4, 2], [5, 2], [6, 4]]
};

export function createLayout(mapId, mode, { arena = arenaForMode(mode) } = {}) {
  if (!mapIds.has(mapId) || (mode !== 'team' && mode !== 'duel')) throw new RangeError('unknown map or mode');
  if (resolveArena(arena) !== TEAM_ARENA) return createLegacyLayout(mapId, mode);
  const { width, height } = TEAM_ARENA;
  const solid = new Set(), soft = new Set();
  const crates = new Set(teamCrateSeeds[mapId].flatMap(([x, y]) => [
    key(x, y), key(width - 1 - x, y), key(x, height - 1 - y), key(width - 1 - x, height - 1 - y)
  ]));
  // One scan fixes insertion order independently of the seed/reflection order.
  for (let x = 0; x < width; x++) for (let y = 0; y < height; y++) {
    const cell = key(x, y);
    const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
    const wall = mapId === 'harbor'
      ? [4, 10].includes(x) && [2, 4, 8, 10].includes(y) || [6, 8].includes(x) && [4, 8].includes(y)
      : mapId === 'festival'
        ? [4, 10].includes(x) && [4, 5, 7, 8].includes(y) || [6, 8].includes(x) && [2, 10].includes(y)
        : [4, 6, 8, 10].includes(x) && [2, 4, 8, 10].includes(y) || [3, 11].includes(x) && [4, 8].includes(y);
    const sideOpening = mapId === 'lagoon' && [3,11].includes(x) && [4,8].includes(y)
      || mapId === 'candy' && [6,8].includes(x) && [2,10].includes(y);
    if (edge || wall && !sideOpening) solid.add(cell);
    else if (crates.has(cell)) soft.add(cell);
  }
  return { solid, soft };
}
