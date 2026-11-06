import { awardScore } from './combat.js';
import { arenaHazards } from './hazards.js';

const CENTER = { x: 6, y: 5 };
const BASES = { blue: { x: 1, y: 5 }, pink: { x: 11, y: 5 } };
const TEAM_SPAWNS = [[1, 1], [1, 3], [1, 7], [1, 9], [11, 1], [11, 3], [11, 7], [11, 9]];
const RESPAWN_TICKS = 50;
const key = (x, y) => `${x},${y}`;
const activeRelay = room => ['relay', 'harmony'].includes(room.ruleSet) ? room.relay : null;

export function initializeRelay(room) {
  room.relay = ['relay', 'harmony'].includes(room.ruleSet) ? {
    scores: { blue: 0, pink: 0 }, goal: room.ruleSet === 'harmony' ? 7 : 3, star: { ...CENTER }, carrierId: null,
    nextSpawnTick: null, dropTick: null, passRecipients: new Set(), rescueCharge: 0, nextPassTick: 0, passEffects: []
  } : null;
  room.onRescue = room.relay ? delta => noteRelayRescue(room, delta) : null;
  if (!room.relay) return;
  for (const { x, y } of [CENTER, BASES.blue, BASES.pink]) {
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) room.soft.delete(key(x + dx, y + dy));
  }
}

/** Call before deleting the player so the drop retains their last cell. */
export function dropRelayCarrier(room, playerId) {
  const relay = activeRelay(room);
  if (!relay || !playerId || relay.carrierId !== playerId) return;
  const player = room.players.get(playerId);
  relay.star = player ? { x: player.x, y: player.y } : { ...CENTER };
  relay.carrierId = null;
  relay.nextSpawnTick = null;
  relay.dropTick = room.tick;
  resetCharges(relay);
}

export function stepRelay(room) {
  const relay = activeRelay(room);
  if (!relay) return;
  const carrier = room.players.get(relay.carrierId);
  if (relay.carrierId && (!carrier?.alive || carrier.bubbleTicks > 0 || carrier.connected === false)) dropRelayCarrier(room, relay.carrierId);

  let danger;
  for (const player of room.players.values()) {
    if (player.alive) continue;
    player.respawnAt ??= room.tick + RESPAWN_TICKS;
    if (room.tick < player.respawnAt) continue;
    const spawn = TEAM_SPAWNS[player.slot];
    if (!spawn) continue;
    const [x, y] = spawn, cell = key(x, y);
    danger ??= arenaHazards(room);
    if (room.solid.has(cell) || room.soft.has(cell) || danger.waves.has(cell) || danger.deadlines.has(cell)) continue;
    Object.assign(player, { x, y, alive: true, bubbleTicks: 0, bubbleSourceId: null,
      immuneUntil: room.tick + 10, nextMoveTick: room.tick,
      input: null, placeRequested: false, dartRequested: false, passRequested: false });
    delete player.respawnAt;
  }

  if (relay.nextSpawnTick !== null && room.tick >= relay.nextSpawnTick) {
    relay.star = { ...CENTER };
    relay.nextSpawnTick = null;
  }
  if (relay.star && relay.dropTick !== room.tick) {
    const pickup = [...room.players.values()].find(player => player.connected !== false && player.alive && player.bubbleTicks === 0 &&
      player.x === relay.star.x && player.y === relay.star.y);
    if (pickup) { relay.carrierId = pickup.id; relay.star = null; }
  }
  const delivering = room.players.get(relay.carrierId);
  const base = delivering && BASES[delivering.team];
  if (base && delivering.x === base.x && delivering.y === base.y) {
    relay.scores[delivering.team] += 1 + (room.ruleSet === 'harmony' ? Math.min(2, relay.passRecipients.size) + relay.rescueCharge : 0);
    resetCharges(relay);
    delivering.deliveries = (delivering.deliveries ?? 0) + 1;
    awardScore(delivering, 150);
    relay.carrierId = null;
    relay.star = null;
    relay.nextSpawnTick = room.tick + RESPAWN_TICKS;
  }
}

export function relayResult(room, matchTicks = 1200) {
  const relay = activeRelay(room);
  if (!relay) return null;
  const result = (reason, winnerTeam) => ({ ...(winnerTeam ? { winnerTeam } : { draw: true }),
    reason: room.ruleSet === 'harmony' ? reason.replace('relay_', 'harmony_') : reason, relayScores: { ...relay.scores } });
  const teams = new Set([...room.players.values()].map(player => player.team));
  if (!teams.has('blue') || !teams.has('pink')) return result('forfeit', teams.has('blue') ? 'blue' : teams.has('pink') ? 'pink' : null);
  for (const team of ['blue', 'pink']) if (relay.scores[team] >= relay.goal) return result('relay_goal', team);
  if (room.tick < matchTicks) return null;
  return result('relay_time', relay.scores.blue === relay.scores.pink ? null : relay.scores.blue > relay.scores.pink ? 'blue' : 'pink');
}

export function relayState(room) {
  const relay = activeRelay(room);
  return relay ? { scores: { ...relay.scores }, goal: relay.goal,
    charges: { passes: Math.min(2, relay.passRecipients.size), rescue: relay.rescueCharge, total: Math.min(2, relay.passRecipients.size) + relay.rescueCharge },
    passCooldownTicks: Math.max(0, relay.nextPassTick - room.tick), passEffects: relay.passEffects.map(effect => ({ ...effect })),
    star: relay.star ? { ...relay.star } : null, carrierId: relay.carrierId,
    respawnTicks: relay.nextSpawnTick === null ? 0 : Math.max(0, relay.nextSpawnTick - room.tick),
    bases: { blue: { ...BASES.blue }, pink: { ...BASES.pink } } } : null;
}

function resetCharges(relay) { relay.passRecipients.clear(); relay.rescueCharge = 0; }
const PASS_DIRECTIONS = { up: [0, 1], down: [0, -1], left: [-1, 0], right: [1, 0] };
const eligible = player => player?.alive && player.bubbleTicks === 0 && player.connected !== false;

/** Shared ray query: bots may choose a facing, but only passRelayStar transfers ownership. */
export function relayPassTarget(room, player, facing = player.facing) {
  if (!activeRelay(room) || !eligible(player)) return null;
  const [dx, dy] = PASS_DIRECTIONS[facing] ?? PASS_DIRECTIONS.up;
  for (let distance = 1; distance <= 7; distance++) {
    const x = player.x + dx * distance, y = player.y + dy * distance, cell = key(x, y);
    if (x <= 0 || x >= 12 || y <= 0 || y >= 10 || room.solid.has(cell) || room.soft.has(cell) || room.orbs.has(cell)) break;
    const target = [...room.players.values()].find(other => other !== player && eligible(other) && other.x === x && other.y === y);
    if (target) return target;
  }
  return null;
}
export function passRelayStar(room, player) {
  const relay = activeRelay(room);
  if (!relay || relay.carrierId !== player.id || room.players.get(player.id) !== player || !eligible(player) || room.tick < relay.nextPassTick) return false;
  const target = relayPassTarget(room, player);
  if (!target) return false;
  const interception = target.team !== player.team;
  if (interception) { resetCharges(relay); target.interceptions = (target.interceptions ?? 0) + 1; }
  else { player.passes = (player.passes ?? 0) + 1; if (room.ruleSet === 'harmony') relay.passRecipients.add(target.id); }
  relay.carrierId = target.id;
  relay.nextPassTick = room.tick + 10;
  const [dx, dy] = PASS_DIRECTIONS[player.facing] ?? PASS_DIRECTIONS.up;
  relay.passEffects.push({ fromId: player.id, toId: target.id, team: target.team, interception,
    x: player.x, y: player.y, dx, dy, length: Math.abs(target.x - player.x) + Math.abs(target.y - player.y), ttl: 5 });
  return true;
}
/** Called by combat only after a real rescue; client input cannot submit charge deltas. */
export function noteRelayRescue(room, { rescuer, target } = {}) {
  const relay = activeRelay(room), carrier = relay && room.players.get(relay.carrierId);
  if (room.ruleSet !== 'harmony' || !eligible(carrier) || !rescuer || !target || rescuer.team !== target.team || carrier.team !== rescuer.team) return;
  relay.rescueCharge = 1;
}
