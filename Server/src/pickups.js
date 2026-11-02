const TYPES = ['orb', 'wave', 'dash', 'pin'];
const key = (x, y) => `${x},${y}`;

// Drops are decided only by the authoritative server when a soft block breaks.
export function dropPickup(room, x, y, random = Math.random) {
  if (random() >= 0.55) return null;
  const item = { x, y, type: TYPES[Math.floor(random() * TYPES.length)] };
  room.items.set(key(x, y), item);
  return item;
}

export function collectPickup(room, player) {
  const cell = key(player.x, player.y);
  const item = room.items.get(cell);
  if (!item) return null;
  room.items.delete(cell);
  switch (item.type) {
    case 'orb': player.maxOrbs = Math.min(player.maxOrbs + 1, 5); break;
    case 'wave': player.range = Math.min(player.range + 1, 7); break;
    case 'dash': player.dash = true; break;
    case 'pin': player.pin = true; break;
  }
  return item.type;
}

export function rescueAdjacent(room, rescuer) {
  if (room.mode !== 'team' || !rescuer.alive || rescuer.bubbleTicks > 0) return;
  for (const player of room.players.values()) {
    if (player !== rescuer && player.alive && player.team === rescuer.team && player.bubbleTicks > 0 &&
        Math.abs(player.x - rescuer.x) + Math.abs(player.y - rescuer.y) <= 1) player.bubbleTicks = 0;
  }
}

export function hitPlayer(player, tick) {
  if (!player.alive || player.bubbleTicks > 0 || (tick !== undefined && player.lastHitTick === tick)) return;
  player.lastHitTick = tick;
  if (player.pin) { player.pin = false; return; }
  player.bubbleTicks = 20;
}
