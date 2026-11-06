import { TIDEGATES } from '../public/map-catalog.js';

const SWITCH_TICKS = 100;
const WARNING_TICKS = 20;
const key = (x, y) => `${x},${y}`;

function occupied(room, cells) {
  for (const player of room.players.values()) if (player.alive && cells.includes(key(player.x, player.y))) return true;
  for (const orb of room.orbs.values()) if (cells.includes(key(orb.x, orb.y))) return true;
  return false;
}

/** Initialize after layout creation/reset. Training booleans and training objects disable gates. */
export function initializeMapFeatures(room) {
  // Reinitializing the feature must remove the previous dynamic walls as well.
  if (room.mapFeatures?.type === 'tidegates') {
    for (const gate of room.mapFeatures.gates) for (const cell of gate.cells) room.solid.delete(cell);
  }
  room.mapFeatures = room.mapId === 'harbor' && !room.training ? {
    type: 'tidegates', phase: 0, nextChangeTick: SWITCH_TICKS,
    gates: TIDEGATES.map(({ id, cells }) => ({ id, cells: [...cells], closed: false, closing: false, pending: false }))
  } : null;
  if (room.mapFeatures) stepMapFeatures(room);
}

/** Run before movement/AI. Open first, then close only fully unoccupied groups. */
export function stepMapFeatures(room) {
  const features = room.mapFeatures;
  if (!features || features.type !== 'tidegates') return;
  const tick = Math.max(0, room.tick ?? 0);
  const interval = Math.floor(tick / SWITCH_TICKS);
  features.phase = interval % 2;
  features.nextChangeTick = (interval + 1) * SWITCH_TICKS;
  // Opening never waits for another group's blocked closure.
  for (const [index, gate] of features.gates.entries()) if (index !== features.phase) {
    for (const cell of gate.cells) room.solid.delete(cell);
    gate.closed = false;
    gate.pending = false;
    gate.closing = features.nextChangeTick - tick <= WARNING_TICKS;
  }
  const gate = features.gates[features.phase];
  gate.pending = !gate.closed && occupied(room, gate.cells);
  gate.closing = gate.pending;
  if (!gate.pending) {
    for (const cell of gate.cells) {
      room.solid.add(cell);
      room.items.delete(cell);
      room.soft.delete(cell);
    }
    gate.closed = true;
  }
}

/** Public allowlisted snapshot: callers cannot mutate the simulation through it. */
export function mapFeaturesState(room) {
  const features = room.mapFeatures;
  return features?.type === 'tidegates' ? {
    type: 'tidegates', switchTicks: SWITCH_TICKS, cycleTicks: SWITCH_TICKS * 2,
    warningTicks: WARNING_TICKS, phase: features.phase, nextChangeTick: features.nextChangeTick,
    gates: features.gates.map(({ id, cells, closed, closing, pending }) => ({ id, cells: [...cells], closed, closing, pending }))
  } : null;
}
