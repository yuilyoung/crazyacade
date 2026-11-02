import { awardScore } from './combat.js';
import { arenaHazards } from './bots.js';

const CENTER = { x: 6, y: 5 };
const BASES = { blue: { x: 1, y: 5 }, pink: { x: 11, y: 5 } };
const TEAM_SPAWNS = [[1, 1], [1, 3], [1, 7], [1, 9], [11, 1], [11, 3], [11, 7], [11, 9]];
const RESPAWN_TICKS = 50;
const key = (x, y) => `${x},${y}`;
const activeRelay = room => room.ruleSet === 'relay' ? room.relay : null;

export function initializeRelay(room) {
  room.relay = room.ruleSet === 'relay' ? {
    scores: { blue: 0, pink: 0 }, goal: 3, star: { ...CENTER }, carrierId: null,
    nextSpawnTick: null, dropTick: null
  } : null;
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
}

export function stepRelay(room) {
  const relay = activeRelay(room);
  if (!relay) return;
  const carrier = room.players.get(relay.carrierId);
  if (relay.carrierId && (!carrier?.alive || carrier.bubbleTicks > 0)) dropRelayCarrier(room, relay.carrierId);

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
      input: null, placeRequested: false, dartRequested: false });
    delete player.respawnAt;
  }

  if (relay.nextSpawnTick !== null && room.tick >= relay.nextSpawnTick) {
    relay.star = { ...CENTER };
    relay.nextSpawnTick = null;
  }
  if (relay.star && relay.dropTick !== room.tick) {
    const pickup = [...room.players.values()].find(player => player.alive && player.bubbleTicks === 0 &&
      player.x === relay.star.x && player.y === relay.star.y);
    if (pickup) { relay.carrierId = pickup.id; relay.star = null; }
  }
  const delivering = room.players.get(relay.carrierId);
  const base = delivering && BASES[delivering.team];
  if (base && delivering.x === base.x && delivering.y === base.y) {
    relay.scores[delivering.team]++;
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
    reason, relayScores: { ...relay.scores } });
  const teams = new Set([...room.players.values()].map(player => player.team));
  if (!teams.has('blue') || !teams.has('pink')) return result('forfeit', teams.has('blue') ? 'blue' : teams.has('pink') ? 'pink' : null);
  for (const team of ['blue', 'pink']) if (relay.scores[team] >= relay.goal) return result('relay_goal', team);
  if (room.tick < matchTicks) return null;
  return result('relay_time', relay.scores.blue === relay.scores.pink ? null : relay.scores.blue > relay.scores.pink ? 'blue' : 'pink');
}

export function relayState(room) {
  const relay = activeRelay(room);
  return relay ? { scores: { ...relay.scores }, goal: relay.goal,
    star: relay.star ? { ...relay.star } : null, carrierId: relay.carrierId,
    respawnTicks: relay.nextSpawnTick === null ? 0 : Math.max(0, relay.nextSpawnTick - room.tick),
    bases: { blue: { ...BASES.blue }, pink: { ...BASES.pink } } } : null;
}
