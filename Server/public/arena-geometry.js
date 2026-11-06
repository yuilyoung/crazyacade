/** Shared, DOM-free board geometry. Missing or invalid descriptors stay legacy. */
export const LEGACY_ARENA = Object.freeze({ width: 13, height: 11 });
export const TEAM_ARENA = Object.freeze({ width: 15, height: 13 });

export function resolveArena(value) {
  const arena = value && typeof value === 'object' && 'arena' in value ? value.arena : value;
  return arena && typeof arena === 'object' && arena.width === TEAM_ARENA.width && arena.height === TEAM_ARENA.height
    ? TEAM_ARENA : LEGACY_ARENA;
}

export function arenaForMode(mode, training = false) {
  return mode === 'team' && !training ? TEAM_ARENA : LEGACY_ARENA;
}

const frozenSpawns = (right, rows) => Object.freeze([1, right].flatMap(x => rows.map(y => Object.freeze([x, y]))));
const legacySpawns = frozenSpawns(11, [1, 3, 7, 9]);
const teamSpawns = frozenSpawns(13, [1, 4, 8, 11]);
export function spawnPoints(value) {
  return resolveArena(value) === TEAM_ARENA ? teamSpawns : legacySpawns;
}

export function arenaCenter(value) {
  const { width, height } = resolveArena(value);
  return { x: (width - 1) / 2, y: (height - 1) / 2 };
}

export function arenaBases(value) {
  const { width } = resolveArena(value), { y } = arenaCenter(value);
  return { blue: { x: 1, y }, pink: { x: width - 2, y } };
}

export function insideArena(value, x, y) {
  const { width, height } = resolveArena(value);
  return Number.isFinite(x) && Number.isFinite(y) && x > 0 && x < width - 1 && y > 0 && y < height - 1;
}

const frozenGates = (a, b) => Object.freeze([
  Object.freeze({ id: 'a', cells: Object.freeze(a) }),
  Object.freeze({ id: 'b', cells: Object.freeze(b) })
]);
const legacyGates = frozenGates(['4,5', '8,5'], ['6,3', '6,7']);
const teamGates = frozenGates(['5,6', '9,6'], ['7,4', '7,8']);
export function tideGateGroups(value) {
  return resolveArena(value) === TEAM_ARENA ? teamGates : legacyGates;
}
