import { insideArena } from '../public/arena-geometry.js';
const DIRECTIONS = { up: [0, 1], down: [0, -1], left: [-1, 0], right: [1, 0] };

export function awardScore(player, points) {
  if (player) player.score = (Number.isFinite(player.score) ? player.score : 0) + points;
}
export function movementCooldown(player) { return player.speedLevel > 0 ? 1 : 2; }
export function rescuePlayer(room, rescuer, target) {
  if (!target.alive || target.bubbleTicks <= 0) return false;
  target.bubbleTicks = 0;
  target.bubbleSourceId = null;
  target.immuneUntil = (room.tick ?? 0) + 5;
  rescuer.rescues = (rescuer.rescues ?? 0) + 1;
  awardScore(rescuer, 50);
  room.onRescue?.({ rescuer, target });
  return true;
}
export function eliminatePlayer(room, target, attackerId = target.bubbleSourceId) {
  if (!target.alive) return false;
  target.alive = false;
  target.bubbleTicks = 0;
  const attacker = (room.roster ?? [...room.players.values()]).find(p => p.id === attackerId);
  if (attacker && attacker !== target && (room.mode !== 'team' || attacker.team !== target.team)) awardScore(attacker, 100);
  return true;
}

export function fireDart(room, player, explode) {
  if (room.itemMode === false || !player.alive || player.bubbleTicks > 0 || !(player.darts > 0)) return false;
  const [dx, dy] = DIRECTIONS[player.facing] ?? DIRECTIONS.up;
  player.darts--;
  const effect = { x: player.x, y: player.y, dx, dy, length: 0, ttl: 3 };
  (room.dartEffects ??= []).push(effect);
  for (let distance = 1; distance <= 7; distance++) {
    const x = player.x + dx * distance, y = player.y + dy * distance, cell = `${x},${y}`;
    if (!insideArena(room, x, y) || room.solid.has(cell) || room.soft.has(cell)) break;
    effect.length = distance;
    const orb = room.orbs.get(cell);
    if (orb) { explode(orb); break; }
    const target = [...room.players.values()].find(p => p !== player && p.alive && p.bubbleTicks > 0 && p.x === x && p.y === y);
    if (target) {
      if (room.mode === 'team' && target.team === player.team) rescuePlayer(room, player, target);
      else eliminatePlayer(room, target, player.id);
      break;
    }
  }
  return true;
}

export function finishScores(room) {
  if (room.scoresFinalized) return;
  room.scoresFinalized = true;
  const roster = room.roster ?? [...room.players.values()];
  for (const player of roster) {
    if (!room.result.draw && (room.result.winnerTeam ? player.team === room.result.winnerTeam : player.userId === room.result.winnerId)) awardScore(player, 200);
  }
  room.participants = roster.map(({ id, userId, name, team, score }) => ({ id, userId, name, team, score: score ?? 0 }));
  room.result.scoreboard = roster.map(({ id, name, team, score, rescues, deliveries, passes, interceptions }) => ({ id, name, team, score: score ?? 0, rescues: rescues ?? 0, deliveries: deliveries ?? 0, passes: passes ?? 0, interceptions: interceptions ?? 0 })).sort((a,b) => b.score - a.score || a.id.localeCompare(b.id));
}
