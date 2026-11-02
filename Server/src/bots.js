const DIRECTIONS = [
  { move: 'up', dx: 0, dy: 1 }, { move: 'right', dx: 1, dy: 0 },
  { move: 'down', dx: 0, dy: -1 }, { move: 'left', dx: -1, dy: 0 }
];
const DECISION_TICKS = 3;
// Match the server's explosion order: a chained blast can remove a soft shield
// before its triggering blast continues along the same lane.
const BLAST_DIRECTIONS = [DIRECTIONS[0], DIRECTIONS[2], DIRECTIONS[1], DIRECTIONS[3]];
const key = (x, y) => `${x},${y}`;
const inside = (x, y) => x > 0 && x < 12 && y > 0 && y < 10;
const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

function blastCells(room, orb) {
  const cells = new Set([key(orb.x, orb.y)]);
  for (const { dx, dy } of DIRECTIONS) {
    for (let step = 1; step <= Math.min(7, orb.range ?? 3); step++) {
      const x = orb.x + dx * step, y = orb.y + dy * step, cell = key(x, y);
      if (!inside(x, y) || room.solid.has(cell)) break;
      cells.add(cell);
      if (room.soft.has(cell)) break;
    }
  }
  return cells;
}

function hazards(room, extraOrb) {
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
        if (!inside(x, y) || room.solid.has(cell)) break;
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

function walkable(room, x, y) {
  const cell = key(x, y);
  return inside(x, y) && !room.solid.has(cell) && !room.soft.has(cell) && !room.orbs.has(cell);
}

// The arena has 99 interior cells; each search visits a cell at most once.
function route(room, player, directions, canEnter, isGoal, maxSteps = 99) {
  const queue = [{ x: player.x, y: player.y, steps: 0 }];
  const visited = new Set([key(player.x, player.y)]);
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    if (current.steps >= maxSteps) continue;
    for (const direction of directions) {
      const x = current.x + direction.dx, y = current.y + direction.dy, cell = key(x, y);
      const next = { x, y, steps: current.steps + 1, move: current.move ?? direction.move };
      if (visited.has(cell) || !walkable(room, x, y) || !canEnter(cell, next.steps)) continue;
      visited.add(cell);
      if (isGoal(next, cell)) return next;
      queue.push(next);
    }
  }
  return null;
}

function escape(room, player, directions, danger) {
  const delay = Math.max(0, (player.nextMoveTick ?? 0) - room.tick);
  return route(room, player, directions,
    (cell, steps) => !danger.waves.has(cell) &&
      (danger.deadlines.get(cell) ?? Infinity) > delay + steps * DECISION_TICKS,
    (_position, cell) => !danger.deadlines.has(cell), 6);
}

function dartRescue(room, player, directions, safe) {
  if (room.itemMode === false || !(player.darts > 0) || room.mode !== 'team') return null;
  for (const direction of directions) {
    for (let step = 1; step <= 7; step++) {
      const x = player.x + direction.dx * step, y = player.y + direction.dy * step, cell = key(x, y);
      if (!inside(x, y) || room.solid.has(cell) || room.soft.has(cell) || room.orbs.has(cell)) break;
      const target = [...room.players.values()].find(other => other !== player && other.alive && other.bubbleTicks > 0 && other.x === x && other.y === y);
      if (!target) continue;
      if (target.team === player.team) {
        if (player.facing === direction.move) return { useDart: true };
        const nx = player.x + direction.dx, ny = player.y + direction.dy;
        if (walkable(room, nx, ny) && safe(key(nx, ny))) return { move: direction.move, useDart: true };
      }
      break;
    }
  }
  return null;
}

/** Decide ordinary inputs only. The caller applies cooldowns, combat, and items. */
export function decideBotInput(room, player) {
  if (!player.alive || player.bubbleTicks > 0) return {};
  // Rotate tie breaks slowly so bots explore without flickering direction every tick.
  const offset = ((player.slot ?? 0) + Math.floor(room.tick / 18)) % DIRECTIONS.length;
  const directions = [...DIRECTIONS.slice(offset), ...DIRECTIONS.slice(0, offset)];
  const danger = hazards(room);
  const safe = cell => !danger.waves.has(cell) && !danger.deadlines.has(cell);
  if (!safe(key(player.x, player.y))) {
    const exit = escape(room, player, directions, danger);
    return exit ? { move: exit.move } : {};
  }

  const dart = dartRescue(room, player, directions, safe);
  if (dart) return dart;
  const allies = [...room.players.values()].filter(other => other !== player && other.alive &&
    room.mode === 'team' && other.team === player.team && other.bubbleTicks > 0);
  const rescue = route(room, player, directions, safe,
    position => allies.some(ally => distance(position, ally) <= 1));
  if (rescue) return { move: rescue.move };

  if (room.itemMode !== false && room.items.size) {
    const pickup = route(room, player, directions, safe, (_position, cell) => room.items.has(cell));
    if (pickup) return { move: pickup.move };
  }

  const opponents = [...room.players.values()].filter(other => other !== player && other.alive &&
    (room.mode !== 'team' || other.team !== player.team));
  const projectedOrb = { x: player.x, y: player.y, range: player.range, fuse: 20 };
  const projectedBlast = blastCells(room, projectedOrb);
  const usefulBomb = [...projectedBlast].some(cell => room.soft.has(cell)) ||
    opponents.some(other => projectedBlast.has(key(other.x, other.y)));
  const bombTurn = (Math.floor(room.tick / DECISION_TICKS) + (player.slot ?? 0)) % 4 === 0;
  if (usefulBomb && bombTurn && player.activeOrbs < player.maxOrbs &&
      room.tick >= (player.nextMoveTick ?? 0) && !room.orbs.has(key(player.x, player.y)) &&
      !allies.some(ally => projectedBlast.has(key(ally.x, ally.y)))) {
    const exit = escape(room, player, directions, hazards(room, projectedOrb));
    if (exit) return { move: exit.move, placeOrb: true };
  }

  const opponent = route(room, player, directions, safe,
    position => opponents.some(other => distance(position, other) <= 1));
  if (opponent) return { move: opponent.move };
  const block = route(room, player, directions, safe,
    position => DIRECTIONS.some(({ dx, dy }) => room.soft.has(key(position.x + dx, position.y + dy))));
  if (block) return { move: block.move };
  // With no reachable target, continue through a safe open route.
  for (const direction of directions) {
    const x = player.x + direction.dx, y = player.y + direction.dy;
    if (walkable(room, x, y) && safe(key(x, y))) return { move: direction.move };
  }
  return {};
}
