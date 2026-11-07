import { resolveArena } from './arena-geometry.js';
const TICK_MS = 100;
const MAX_MOVE_MS = 250;
const MAX_MOVE_POINTS = 8;
const RECEIVE_GAP_MS = 300;
const MAX_PLAYERS = 8;
const MAX_EFFECTS = 128;
const DURATIONS = { place: 160, explode: 450, break: 380, pickup: 600, hit: 200, rescue: 650, death: 420, spawn: 500, dart: 200, pass: 250 };
const PLAYER_FIELDS = 'id name team characterId skinId orbSkinId isBot x y alive bubbleTicks maxOrbs range dash pin speedLevel moveCooldownTicks darts facing score bombsPlaced itemsCollected rescues deliveries passes interceptions respawnTicks connected reconnectRemainingMs'.split(' ');
const key = value => `${value.x},${value.y}`;
const emptyFrame = () => ({ players: new Map(), orbs: new Map(), waves: new Map(), effects: [] });

function copyPlayer(player) {
  const copy = {};
  for (const field of PLAYER_FIELDS) if (Object.hasOwn(player, field)) copy[field] = player[field];
  return copy;
}

function tiles(values = [], limit) {
  const result = new Map();
  for (const tile of values) {
    if (!Number.isFinite(tile.x) || !Number.isFinite(tile.y)) continue;
    result.set(key(tile), { x: tile.x, y: tile.y, ttl: tile.ttl, type: tile.type });
    if (result.size === limit) break;
  }
  return result;
}

function paths(values = []) {
  const result = new Map();
  for (const path of values) {
    const copy = { x: path.x, y: path.y, dx: path.dx, dy: path.dy, length: path.length, interception: path.interception, ttl: path.ttl };
    const id = JSON.stringify([path.fromId, path.toId, copy.x, copy.y, copy.dx, copy.dy, copy.length, copy.interception]);
    // Identical simultaneous paths need only one decorative projectile.
    const previous = result.get(id);
    if (!previous || copy.ttl > previous.ttl) result.set(id, copy);
    if (result.size === MAX_EFFECTS) break;
  }
  return result;
}

function capture(snapshot) {
  const arena = resolveArena(snapshot), tileLimit = arena.width * arena.height;
  const players = new Map();
  for (const player of snapshot.players || []) {
    players.set(player.id, copyPlayer(player));
    if (players.size === MAX_PLAYERS) break;
  }
  const training = snapshot.training;
  return {
    players, orbs: tiles(snapshot.orbs,tileLimit), waves: tiles(snapshot.waves,tileLimit), items: tiles(snapshot.items,tileLimit),
    soft: new Set((snapshot.soft || []).slice(0, tileLimit)),
    darts: paths(snapshot.dartEffects), passes: paths(snapshot.relay?.passEffects),
    tick: snapshot.tick, phase: snapshot.phase,
    boundary: JSON.stringify([snapshot.roomId, snapshot.matchId, snapshot.round, snapshot.mapId, snapshot.mode, snapshot.ruleSet, arena.width, arena.height,
      training?.mode, training?.stage, training?.attempts, training?.completed, training?.status])
  };
}

const distance = (from, to) => Math.abs(to.x - from.x) + Math.abs(to.y - from.y);

// Traverse only already confirmed cardinal segments, including a turn's corner.
function sampleMove(move, now) {
  const progress = Math.max(0, Math.min(1, (now - move.startMs) / move.durationMs));
  const travelled = move.distance * progress;
  let remaining = travelled;
  for (let index = 1; index < move.points.length; index++) {
    const from = move.points[index - 1], to = move.points[index], length = distance(from, to);
    if (remaining < length) {
      const fraction = remaining / length;
      return {
        x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction,
        nextIndex: index, moving: true, travelled,
        facing: to.x > from.x ? 'right' : to.x < from.x ? 'left' : to.y > from.y ? 'up' : 'down'
      };
    }
    remaining -= length;
  }
  return { ...move.points.at(-1), nextIndex: move.points.length, moving: false, travelled };
}

/** Presentation-only history. No timers, simulation state, DOM, or Canvas access. */
export function createMotionTimeline() {
  let previous = null, source = null, receivedAt = null, lastNow = null;
  let lastConnection = 'connected', lastHidden = false, sequence = 0;
  let lastLevel = 'full', lastReducedMotion = false;
  let tickMs = TICK_MS, cadenceTick = null, cadenceAt = null;
  let effects = [], moves = new Map(), orbStarts = new Map(), waveStarts = new Map();

  function reset() {
    previous = null; source = null; receivedAt = null; lastNow = null;
    lastConnection = 'connected'; lastHidden = false;
    lastLevel = 'full'; lastReducedMotion = false;
    tickMs = TICK_MS; cadenceTick = null; cadenceAt = null;
    effects = []; moves = new Map(); orbStarts = new Map(); waveStarts = new Map();
  }

  function add(kind, position, now, extra = {}) {
    effects.push({ id: `motion-${++sequence}`, kind, x: position.x, y: position.y, startMs: now, durationMs: DURATIONS[kind], ...extra });
    if (effects.length > MAX_EFFECTS) effects.splice(0, effects.length - MAX_EFFECTS);
  }

  function baseline(current, now) {
    effects = []; moves.clear();
    tickMs = TICK_MS; cadenceTick = current.tick; cadenceAt = now;
    orbStarts = new Map([...current.orbs.keys()].map(cell => [cell, now - DURATIONS.place]));
    waveStarts = new Map([...current.waves.keys()].map(cell => [cell, now - DURATIONS.explode]));
  }

  function observeCadence(current, now) {
    if (!(current.tick > cadenceTick)) return;
    const observed = (now - cadenceAt) / (current.tick - cadenceTick);
    // Ignore bunched packets and isolated stalls; neither changes server speed.
    if (observed >= 75 && observed <= 150) tickMs += (observed - tickMs) * .2;
    cadenceTick = current.tick; cadenceAt = now;
  }

  function beginMove(id, prior, player, now) {
    const active = moves.get(id), sample = active && sampleMove(active, now);
    const points = sample?.moving
      ? [{ x: sample.x, y: sample.y }, ...active.points.slice(sample.nextIndex)]
      : [{ x: prior.x, y: prior.y }];
    points.push({ x: player.x, y: player.y });
    // A burst must not retain an unbounded trail of old server positions.
    if (points.length > MAX_MOVE_POINTS) { moves.delete(id); return; }
    const cooldown = [1, 2].includes(player.moveCooldownTicks)
      ? player.moveCooldownTicks : player.speedLevel > 0 ? 1 : 2;
    moves.set(id, {
      points, startMs: now, durationMs: Math.min(MAX_MOVE_MS, tickMs * cooldown),
      distance: points.slice(1).reduce((total, point, index) => total + distance(points[index], point), 0),
      walkOffset: sample?.moving ? (active.walkOffset + sample.travelled) % 1 : 0
    });
  }

  function syncTiles(current, now, gameplay) {
    const nextOrbs = new Map(), nextWaves = new Map();
    for (const [cell, orb] of current.orbs) {
      nextOrbs.set(cell, orbStarts.get(cell) ?? now);
      if (gameplay && !previous.orbs.has(cell)) add('place', orb, now);
    }
    for (const [cell, wave] of current.waves) {
      const restarted = wave.ttl > previous.waves.get(cell)?.ttl;
      nextWaves.set(cell, restarted ? now : waveStarts.get(cell) ?? now);
    }
    if (gameplay) {
      for (const [cell, orb] of previous.orbs) if (!current.orbs.has(cell) && current.waves.has(cell)) add('explode', orb, now);
      for (const cell of previous.soft) if (!current.soft.has(cell) && current.waves.has(cell)) add('break', current.waves.get(cell), now);
    }
    orbStarts = nextOrbs; waveStarts = nextWaves;
  }

  function syncPlayers(current, now, gameplay, full) {
    for (const id of moves.keys()) if (!current.players.has(id)) moves.delete(id);
    // A roster departure is not a death and must not retain a ghost or marker.
    effects = effects.filter(effect => !effect.playerId || current.players.has(effect.playerId));
    for (const [id, player] of current.players) {
      const prior = previous.players.get(id);
      if (!prior) continue;
      const changed = player.x !== prior.x || player.y !== prior.y;
      const respawn = !prior.alive && player.alive;
      const connectionChanged = (prior.connected === false) !== (player.connected === false);
      if (changed || respawn || !player.alive || connectionChanged) {
        const adjacent = Math.abs(player.x - prior.x) + Math.abs(player.y - prior.y) === 1;
        if (changed && adjacent && prior.alive && player.alive && !connectionChanged && player.connected !== false && gameplay && full) beginMove(id, prior, player, now);
        else moves.delete(id);
      }
      if (!gameplay) continue;
      const extra = { playerId: id };
      if (prior.alive && !player.alive) add('death', player, now, extra);
      if (respawn) add('spawn', player, now, extra);
      if (prior.alive && player.alive) {
        if ((player.bubbleTicks > 0 && !(prior.bubbleTicks > 0)) || (prior.pin && !player.pin)) add('hit', player, now, extra);
        if (prior.bubbleTicks > 0 && !(player.bubbleTicks > 0) && current.phase === 'playing') add('rescue', player, now, extra);
        const collected = (player.itemsCollected ?? 0) - (prior.itemsCollected ?? 0);
        if (collected > 0) {
          const item = previous.items.get(key(player));
          const itemType = collected === 1 && item && !current.items.has(key(player)) && ['orb', 'wave', 'dash', 'pin', 'dart'].includes(item.type) ? item.type : undefined;
          add('pickup', player, now, { ...extra, ...(itemType ? { itemType } : {}) });
        }
      }
    }
  }

  function syncPaths(current, now) {
    for (const [kind, values, prior] of [['dart', current.darts, previous.darts], ['pass', current.passes, previous.passes]]) {
      for (const [id, path] of values) if (!prior.has(id) || path.ttl > prior.get(id).ttl) {
        const { dx, dy, length, interception } = path;
        add(kind, path, now, { dx, dy, length, ...(interception === undefined ? {} : { interception }) });
      }
    }
  }

  function project(now, full) {
    effects = effects.filter(effect => now - effect.startMs < effect.durationMs);
    const frame = emptyFrame();
    for (const effect of effects) {
      const { startMs, ...copy } = effect;
      const ageMs = Math.max(0, now - startMs);
      frame.effects.push({ ...copy, ageMs, progress: ageMs / effect.durationMs });
    }
    const statuses = new Map();
    for (const effect of frame.effects) if (effect.playerId) {
      if (!statuses.has(effect.playerId)) statuses.set(effect.playerId, {});
      statuses.get(effect.playerId)[effect.kind] = effect.progress;
    }
    for (const [id, player] of previous.players) {
      const move = moves.get(id), sample = full && move ? sampleMove(move, now) : null;
      const moving = Boolean(sample?.moving);
      if (!moving) moves.delete(id);
      const status = statuses.get(id) || {};
      const death = status.death ?? null;
      frame.players.set(id, {
        player: copyPlayer(player),
        x: moving ? sample.x : player.x,
        y: moving ? sample.y : player.y,
        facing: moving ? sample.facing : player.facing || 'up', moving,
        walkPhase: moving ? (move.walkOffset + sample.travelled) * Math.PI * 2 : 0, walkWeight: moving ? 1 : 0,
        bubble: Boolean(player.bubbleTicks > 0), hit: status.hit ?? null, rescue: status.rescue ?? null,
        spawn: status.spawn ?? null, death,
        alpha: player.alive ? 1 : death === null ? 0 : .6 * (1 - death)
      });
    }
    for (const [cell, start] of orbStarts) frame.orbs.set(cell, { ageMs: Math.max(0, now - start) });
    for (const [cell, start] of waveStarts) frame.waves.set(cell, { ageMs: Math.max(0, now - start) });
    return frame;
  }

  function update(snapshot, { now = 0, connection = 'connected', reducedMotion = false, effects: level = 'full', hidden = false } = {}) {
    if (!snapshot) { reset(); return emptyFrame(); }
    const fresh = snapshot !== source;
    const current = fresh || !previous ? capture(snapshot) : previous;
    const phaseReset = previous && current.phase !== previous.phase && !(previous.phase === 'playing' && current.phase === 'finished');
    const boundary = !previous || current.boundary !== previous.boundary || phaseReset ||
      now < lastNow || current.tick < previous.tick || now - receivedAt > RECEIVE_GAP_MS ||
      hidden || lastHidden || connection !== 'connected' || connection !== lastConnection ||
      level !== lastLevel || Boolean(reducedMotion) !== lastReducedMotion;
    const full = level === 'full' && !reducedMotion;
    if (boundary) baseline(current, now);
    else if (fresh) {
      observeCadence(current, now);
      const gameplay = previous.phase === 'playing' && ['playing', 'finished'].includes(current.phase);
      syncTiles(current, now, gameplay);
      syncPlayers(current, now, gameplay, full);
      if (gameplay) syncPaths(current, now);
    }
    if (fresh) receivedAt = now;
    previous = current; source = snapshot; lastNow = now; lastConnection = connection; lastHidden = hidden;
    lastLevel = level; lastReducedMotion = Boolean(reducedMotion);
    if (!full) moves.clear();
    if (level === 'minimal') effects = [];
    return project(now, full);
  }

  return { update, reset };
}
