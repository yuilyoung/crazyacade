import { insideArena } from '../public/arena-geometry.js';
// Neutral arena prediction shared by rules and AI. Does not mutate room.
const DIRECTIONS = [{dx:0,dy:1},{dx:1,dy:0},{dx:0,dy:-1},{dx:-1,dy:0}];
// Match the server's explosion order: a chained blast can remove a soft shield
// before its triggering blast continues along the same lane.
const BLAST_DIRECTIONS = [DIRECTIONS[0], DIRECTIONS[2], DIRECTIONS[1], DIRECTIONS[3]];
const key = (x, y) => `${x},${y}`;

// Shared prediction also keeps Relay respawns out of pending blast lanes.
export function arenaHazards(room, extraOrb) {
  const orbs = [...room.orbs.values(), ...(extraOrb ? [extraOrb] : [])];
  const pending = new Map(orbs.map(orb => [key(orb.x, orb.y), orb]));
  const soft = new Set(room.soft);
  const deadlines = new Map();
  const mark = (cell, fuse) => deadlines.set(cell, Math.min(deadlines.get(cell) ?? Infinity, fuse));
  function explode(orb, fuse) {
    const origin = key(orb.x, orb.y);
    if (!pending.delete(origin)) return;
    mark(origin, fuse);
    for (const { dx, dy } of BLAST_DIRECTIONS) {
      for (let step = 1; step <= Math.min(7, orb.range ?? 3); step++) {
        const x = orb.x + dx * step, y = orb.y + dy * step, cell = key(x, y);
        if (!insideArena(room, x, y) || room.solid.has(cell)) break;
        if (soft.delete(cell)) { mark(cell, fuse); break; }
        const chained = pending.get(cell);
        if (chained) explode(chained, fuse);
        mark(cell, fuse);
      }
    }
  }
  // Predict existing bombs on copies only; each bomb explodes once. Besides
  // chain fuses, this handles later bombs firing through previously broken blocks.
  for (const orb of orbs.sort((a, b) => (a.fuse ?? 20) - (b.fuse ?? 20))) explode(orb, orb.fuse ?? 20);
  return { deadlines, waves: new Set(room.waves.filter(wave => wave.ttl > 0).map(wave => key(wave.x, wave.y))) };
}
