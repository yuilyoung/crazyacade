import { dropPickup, collectPickup, rescueAdjacent, hitPlayer } from './pickups.js';
import { awardScore, movementCooldown, fireDart, eliminatePlayer } from './combat.js';
import { decideBotInput } from './bots.js';
import { dropRelayCarrier, passRelayStar } from './relay.js';
import { dropTrainingPickup, noteTrainingDartRescue, stepTrainingClock, syncTrainingClock } from './training.js';
import { ruleFor } from './rules.js';
import { stepMapFeatures } from './map-features.js';
import { insideArena } from '../public/arena-geometry.js';
const key = (x, y) => `${x},${y}`;
export function isConnected(player) { return player.isBot || Boolean(player.socket && player.socket.readyState === player.socket.OPEN); }
export function clearInput(player) { player.input = null; player.placeRequested = false; player.dartRequested = false; player.passRequested = false; }
export function queueInput(player, action) {
  if (action === "place_orb") player.placeRequested = true;
  else if (action === "use_dart") player.dartRequested = true;
  else if (action === "pass_star") player.passRequested = true;
  else if (["up", "down", "left", "right"].includes(action)) player.input = action;
}
function isWalkable(room, x, y) { const c = key(x, y); return insideArena(room, x, y) && !room.solid.has(c) && !room.soft.has(c) && !room.orbs.has(c); }
function hit(room, player, ownerId) {
  hitPlayer(player, room.tick, ownerId);
  if (!player.alive || player.bubbleTicks > 0) dropRelayCarrier(room, player.id);
}
function wave(room, x, y, ownerId) { room.waves.push({ x, y, ttl: 4, ownerId }); room.items.delete(key(x, y)); for (const p of room.players.values()) if (p.x === x && p.y === y) hit(room, p, ownerId); }
function explode(room, orb) {
  if (!room.orbs.delete(key(orb.x, orb.y))) return;
  const owner = room.players.get(orb.ownerId); if (owner) owner.activeOrbs = Math.max(0, owner.activeOrbs - 1);
  wave(room, orb.x, orb.y, orb.ownerId);
  for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) for (let step = 1; step <= orb.range; step++) {
    const x = orb.x + dx * step, y = orb.y + dy * step, cell = key(x, y);
    if (!insideArena(room, x, y) || room.solid.has(cell)) break;
    if (room.soft.has(cell)) { room.soft.delete(cell); awardScore(owner, 5); wave(room, x, y, orb.ownerId); if (!dropTrainingPickup(room, x, y)) dropPickup(room, x, y); break; }
    const chained = room.orbs.get(cell); if (chained) explode(room, chained);
    wave(room, x, y, orb.ownerId);
  }
}
function processInput(room, p) {
  if (!isConnected(p)) { clearInput(p); return; }
  const input = p.input, placeRequested = p.placeRequested, dartRequested = p.dartRequested, passRequested = p.passRequested;
  p.placeRequested = false; p.dartRequested = false; p.passRequested = false;
  if (!p.alive || p.bubbleTicks > 0) { p.input = null; return; }
  const delta = { up: [0, 1], down: [0, -1], left: [-1, 0], right: [1, 0] }[input];
  if (delta) p.facing = input;
  if (placeRequested && p.activeOrbs < p.maxOrbs && !room.orbs.has(key(p.x, p.y))) {
    const orb = { x: p.x, y: p.y, fuse: 20, range: p.range, ownerId: p.id, orbSkinId: p.orbSkinId ?? "bubble" };
    room.orbs.set(key(orb.x, orb.y), orb); p.activeOrbs++; p.bombsPlaced++;
  }
  if (passRequested) passRelayStar(room, p);
  if (dartRequested) {
    const rescues = p.rescues;
    fireDart(room, p, orb => explode(room, orb));
    if (p.rescues > rescues) noteTrainingDartRescue(room, p);
  }
  if (delta && room.tick >= p.nextMoveTick && p.bubbleTicks === 0) {
    p.input = null;
    if (!isWalkable(room, p.x + delta[0], p.y + delta[1])) return;
    p.x += delta[0]; p.y += delta[1];
    p.nextMoveTick = room.tick + movementCooldown(p);
    const hazard = room.waves.find(w => w.x === p.x && w.y === p.y);
    if (hazard) hit(room, p, hazard.ownerId);
    if (p.bubbleTicks > 0) return;
    collectPickup(room, p);
    rescueAdjacent(room, p);
  }
}

/** Advance authoritative gameplay only. The caller owns sockets, room lifecycle and persistence.
 * Room data is still shared with the transport; this is an execution boundary, not full encapsulation.
 */
export function stepMatch(room, { resetPlayer, now = Date.now() } = {}) {
  room.tick++;
  stepTrainingClock(room, now);
  if (room.training?.status === 'ready') return;
  if (room.training?.mode === 'harmony' && room.training.status === 'retrying') {
    ruleFor(room).step(room, { resetPlayer }); syncTrainingClock(room, now); return;
  }
  stepMapFeatures(room);
  for (const p of room.players.values()) {
    if (p.isBot && !room.training && room.tick % 3 === 0) {
      const decision = decideBotInput(room, p);
      if (decision.face) p.facing = decision.face;
      queueInput(p, decision.move);
      if (decision.placeOrb) queueInput(p, 'place_orb');
      if (decision.useDart) queueInput(p, 'use_dart');
      if (decision.passStar) queueInput(p, 'pass_star');
    }
    processInput(room, p);
  }
  for (const orb of [...room.orbs.values()]) if (--orb.fuse <= 0) explode(room, orb);
  room.waves = room.waves.filter(w => --w.ttl > 0);
  room.dartEffects = room.dartEffects.filter(effect => --effect.ttl > 0);
  if (room.relay) room.relay.passEffects = room.relay.passEffects.filter(effect => --effect.ttl > 0);
  for (const p of room.players.values()) if (p.bubbleTicks > 0 && --p.bubbleTicks === 0) eliminatePlayer(room, p);
  ruleFor(room).step(room, { resetPlayer });
  syncTrainingClock(room, now);
}
