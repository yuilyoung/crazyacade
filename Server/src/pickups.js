import { awardScore, rescuePlayer } from "./combat.js";
const TYPES = ['orb', 'wave', 'dash', 'pin', 'dart'];
const key = (x, y) => `${x},${y}`;

// Drops are decided only by the authoritative server when a soft block breaks.
export function dropPickup(room, x, y, random = Math.random) {
  if (room.itemMode === false || random() >= 0.55) return null;
  const item = { x, y, type: TYPES[Math.floor(random() * TYPES.length)] };
  room.items.set(key(x, y), item);
  return item;
}

export function collectPickup(room, player) {
  if (room.itemMode === false || !player.alive || player.bubbleTicks > 0) return null;
  const cell = key(player.x, player.y);
  const item = room.items.get(cell);
  if (!item) return null;
  room.items.delete(cell);
  switch (item.type) {
    case 'orb': player.maxOrbs = Math.min(player.maxOrbs + 1, 5); break;
    case 'wave': player.range = Math.min(player.range + 1, 7); break;
    case 'dash': player.dash = true; player.speedLevel = 1; break;
    case 'pin': player.pin = true; break;
    case 'dart': player.darts = Math.min((player.darts ?? 0) + 1, 3); break;
  }
  player.itemsCollected = (player.itemsCollected ?? 0) + 1;
  awardScore(player, 10);
  return item.type;
}

export function rescueAdjacent(room, rescuer) {
  if (room.mode !== 'team' || !rescuer.alive || rescuer.bubbleTicks > 0) return;
  for (const player of room.players.values()) {
    if (player !== rescuer && player.alive && player.team === rescuer.team && player.bubbleTicks > 0 &&
        Math.abs(player.x - rescuer.x) + Math.abs(player.y - rescuer.y) <= 1) rescuePlayer(room, rescuer, player);
  }
}

export function hitPlayer(player, tick, attackerId) {
  if (!player.alive || player.bubbleTicks > 0 || (tick !== undefined && (player.lastHitTick === tick || tick < (player.immuneUntil ?? 0)))) return;
  player.lastHitTick = tick;
  if (player.pin) { player.pin = false; return; }
  player.bubbleTicks = 20;
  player.bubbleSourceId = attackerId ?? null;
}
