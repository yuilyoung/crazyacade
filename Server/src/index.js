import crypto from "node:crypto";
import { createServer } from "node:http";
import { createRequestHandler } from "./http.js";
import { WebSocketServer } from "ws";
import { upsertProfile, verifyAccessToken } from "./supabase.js";
import { dropPickup, collectPickup, rescueAdjacent, hitPlayer } from "./pickups.js";
import { resolveAppearance, resolveMap, createLayout } from "./catalog.js";
import { awardScore, movementCooldown, fireDart, eliminatePlayer, finishScores } from "./combat.js";
import { finalizeMatch } from "./rankings.js";
import { decideBotInput } from "./bots.js";

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? (process.env.ALLOW_DEV_GUESTS === "true" ? "127.0.0.1" : "0.0.0.0");
const server = createServer(createRequestHandler());
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
const rooms = new Map();
const WIDTH = 13, HEIGHT = 11, TICK_MS = 100, MATCH_TICKS = 1200;
const MAX_PRACTICE_ROOMS = 8, PRACTICE_RESULT_MS = 120000;
const TEAM_SPAWNS = [[1, 1], [1, 3], [1, 7], [1, 9], [11, 1], [11, 3], [11, 7], [11, 9]];
const key = (x, y) => `${x},${y}`;
const send = (socket, message) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message)); };

function makeRoom(id, mode, mapId, itemMode, practice = false) {
  const { solid, soft } = createLayout(mapId, mode);
  return { id, mode, mapId, itemMode, practice, dartEffects: [], tick: 0, players: new Map(), solid, soft, items: new Map(), orbs: new Map(), waves: [], phase: "waiting", result: null };
}
function roomFor(id, mode, mapId, itemMode) { if (!rooms.has(id)) rooms.set(id, makeRoom(id, mode, mapId, itemMode)); return rooms.get(id); }
function addPlayer(room, user, appearance, name, socket = null, isBot = false) {
  let team, x, y, slot;
  if (room.mode === "team") {
    const occupied = new Set([...room.players.values()].map(p => p.slot));
    slot = [0, 4, 1, 5, 2, 6, 3, 7].find(index => !occupied.has(index));
    team = slot < 4 ? "blue" : "pink";
    [x, y] = TEAM_SPAWNS[slot];
  } else { x = room.players.size === 0 ? 1 : 11; y = room.players.size === 0 ? 1 : 9; }
  const player = { id: crypto.randomUUID(), userId: user.id, socket, room, team, slot, ...appearance, name: String(user.user_metadata?.nickname ?? name ?? "Popper").slice(0, 12), isBot, x, y, alive: true, bubbleTicks: 0, maxOrbs: 1, activeOrbs: 0, range: 3, dash: false, pin: false, speedLevel: 0, darts: 0, facing: "up", score: 0, bombsPlaced: 0, itemsCollected: 0, rescues: 0, nextMoveTick: 0, input: null, placeRequested: false, dartRequested: false };
  room.players.set(player.id, player);
  return player;
}
function removePracticeRoom(room) {
  clearTimeout(room.expiryTimer);
  rooms.delete(room.id);
  room.players.clear();
  room.roster = [];
}
function queueInput(player, action) {
  if (action === "place_orb") player.placeRequested = true;
  else if (action === "use_dart") player.dartRequested = true;
  else if (["up", "down", "left", "right"].includes(action)) player.input = action;
}
function isWalkable(room, x, y) { const c = key(x, y); return x > 0 && x < WIDTH - 1 && y > 0 && y < HEIGHT - 1 && !room.solid.has(c) && !room.soft.has(c) && !room.orbs.has(c); }
function state(room) {
  return { type: "state", roomId: room.id, mode: room.mode, mapId: room.mapId, itemMode: room.itemMode, practice: room.practice, dartEffects: room.dartEffects, phase: room.phase, tick: room.tick, remaining: Math.max(0, MATCH_TICKS - room.tick), result: room.result,
    players: [...room.players.values()].map(({ id, name, team, characterId, skinId, isBot, x, y, alive, bubbleTicks, maxOrbs, range, dash, pin, speedLevel, darts, facing, score, bombsPlaced, itemsCollected, rescues }) => ({ id, name, team, characterId, skinId, isBot, x, y, alive, bubbleTicks, maxOrbs, range, dash, pin, speedLevel, moveCooldownTicks: movementCooldown({speedLevel}), darts, facing, score, bombsPlaced, itemsCollected, rescues })),
    soft: [...room.soft], items: [...room.items.values()], orbs: [...room.orbs.values()].map(({ x, y, fuse }) => ({ x, y, fuse })), waves: room.waves.map(({ x, y, ttl }) => ({ x, y, ttl })) };
}
function broadcast(room) { const message = JSON.stringify(state(room)); for (const p of room.players.values()) if (p.socket && p.socket.readyState === p.socket.OPEN) p.socket.send(message); }
function wave(room, x, y, ownerId) { room.waves.push({ x, y, ttl: 4, ownerId }); room.items.delete(key(x, y)); for (const p of room.players.values()) if (p.x === x && p.y === y) hitPlayer(p, room.tick, ownerId); }
function explode(room, orb) {
  if (!room.orbs.delete(key(orb.x, orb.y))) return;
  const owner = room.players.get(orb.ownerId); if (owner) owner.activeOrbs = Math.max(0, owner.activeOrbs - 1);
  wave(room, orb.x, orb.y, orb.ownerId);
  for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) for (let step = 1; step <= orb.range; step++) {
    const x = orb.x + dx * step, y = orb.y + dy * step, cell = key(x, y);
    if (room.solid.has(cell)) break;
    if (room.soft.has(cell)) { room.soft.delete(cell); awardScore(owner, 5); wave(room, x, y, orb.ownerId); dropPickup(room, x, y); break; }
    const chained = room.orbs.get(cell); if (chained) explode(room, chained);
    wave(room, x, y, orb.ownerId);
  }
}
function processInput(room, p) {
  const input = p.input, placeRequested = p.placeRequested, dartRequested = p.dartRequested;
  p.placeRequested = false; p.dartRequested = false;
  if (!p.alive || p.bubbleTicks > 0) { p.input = null; return; }
  const delta = { up: [0, 1], down: [0, -1], left: [-1, 0], right: [1, 0] }[input];
  if (delta) p.facing = input;
  if (placeRequested && p.activeOrbs < p.maxOrbs && !room.orbs.has(key(p.x, p.y))) {
    const orb = { x: p.x, y: p.y, fuse: 20, range: p.range, ownerId: p.id };
    room.orbs.set(key(orb.x, orb.y), orb); p.activeOrbs++; p.bombsPlaced++;
  }
  if (dartRequested) fireDart(room, p, orb => explode(room, orb));
  if (delta && room.tick >= p.nextMoveTick && p.bubbleTicks === 0) {
    p.input = null;
    if (!isWalkable(room, p.x + delta[0], p.y + delta[1])) return;
    p.x += delta[0]; p.y += delta[1];
    p.nextMoveTick = room.tick + movementCooldown(p);
    const hazard = room.waves.find(w => w.x === p.x && w.y === p.y);
    if (hazard) hitPlayer(p, room.tick, hazard.ownerId);
    if (p.bubbleTicks > 0) return;
    collectPickup(room, p);
    rescueAdjacent(room, p);
  }
}
function finishMatch(room) {
  room.phase = "finished";
  finishScores(room);
  void finalizeMatch(room).catch(error => console.error('Match persistence failed', error.message));
  if (room.practice) {
    room.expiryTimer = setTimeout(() => {
      const sockets = [...room.players.values()].map(p => p.socket).filter(Boolean);
      removePracticeRoom(room);
      for (const socket of sockets) socket.close(1000, "Practice finished");
    }, PRACTICE_RESULT_MS);
  }
}
function checkResult(room) {
  const survivors = [...room.players.values()].filter(p => p.alive);
  if (room.phase !== "playing") return;
  if (room.mode === "team") {
    const blue = survivors.filter(p => p.team === "blue").length;
    const pink = survivors.filter(p => p.team === "pink").length;
    if (blue > 0 && pink > 0 && room.tick < MATCH_TICKS) return;
    room.result = blue === pink ? { draw: true } : { winnerTeam: blue > pink ? "blue" : "pink" };
  } else {
    if (survivors.length > 1 && room.tick < MATCH_TICKS) return;
    room.result = survivors.length === 1 ? { winnerId: survivors[0].userId } : { draw: true };
  }
  finishMatch(room);
}

wss.on("connection", socket => {
  let player, joining = false;
  socket.on("error", error => console.warn("WebSocket error", error.code ?? "unknown"));
  socket.on("message", async raw => {
    let m; try { m = JSON.parse(raw); } catch { send(socket, { type: "error", code: "invalid_json" }); return; }
    if (!m || typeof m !== "object" || Array.isArray(m)) { send(socket, { type: "error", code: "invalid_message" }); return; }
    if (m.type === "join") {
      if (player || joining) { send(socket, { type: "error", code: "already_joining" }); return; }
      // Validate untrusted values before coercion, profile writes, or remote authentication.
      if ((m.roomId !== undefined && (typeof m.roomId !== "string" || m.roomId.length > 64)) ||
          (m.name !== undefined && (typeof m.name !== "string" || [...m.name].length > 12)) ||
          (m.itemMode !== undefined && typeof m.itemMode !== "boolean") ||
          (m.practice !== undefined && typeof m.practice !== "boolean")) {
        send(socket, { type: "error", code: "invalid_join" }); return;
      }
      joining = true;
      try {
        const practice = m.practice === true;
        let user;
        if (practice) user = { id: `practice-${crypto.randomUUID()}`, user_metadata: {} };
        else {
          try { user = await verifyAccessToken(m.accessToken); }
          catch (error) { console.error("Authentication request failed"); send(socket, { type: "error", code: "authentication_unavailable" }); return; }
          if (!user && process.env.ALLOW_DEV_GUESTS !== "true") { send(socket, { type: "error", code: "unauthorized" }); return; }
          if (!user) user = { id: `dev-${crypto.randomUUID()}`, user_metadata: {} };
          try { await upsertProfile(user, m.name); } catch (error) { console.error("Profile update failed"); send(socket, { type: "error", code: "profile_unavailable" }); return; }
        }
        if (socket.readyState !== socket.OPEN) return;
        const requestedMode = m.mode ?? "duel";
        if (requestedMode !== "duel" && requestedMode !== "team") { send(socket, { type: "error", code: "invalid_mode" }); return; }
        const mode = practice ? "team" : requestedMode;
        const appearance = resolveAppearance(m.characterId, m.skinId);
        const requestedMap = m.mapId === undefined ? undefined : resolveMap(m.mapId);
        if (!appearance || (m.mapId !== undefined && !requestedMap)) { send(socket, { type: "error", code: "invalid_selection" }); return; }
        let room;
        if (practice) {
          // The peer can finish its close handshake before our close callback.
          // Reclaim that room now so an immediate replay can use its capacity.
          for (const existing of rooms.values()) {
            if (!existing.practice) continue;
            const owner = [...existing.players.values()].find(p => !p.isBot);
            if (!owner?.socket || owner.socket.readyState !== owner.socket.OPEN) removePracticeRoom(existing);
          }
          if ([...rooms.values()].filter(room => room.practice).length >= MAX_PRACTICE_ROOMS) { send(socket, { type: "error", code: "practice_unavailable" }); return; }
          room = makeRoom(`practice-${crypto.randomUUID()}`, mode, requestedMap ?? "garden", m.itemMode ?? true, true);
          rooms.set(room.id, room);
        } else {
          if (rooms.get(m.roomId ?? "quick")?.practice) { send(socket, { type: "error", code: "room_unavailable" }); return; }
          room = roomFor(m.roomId ?? "quick", mode, requestedMap ?? "garden", m.itemMode ?? true);
        }
        if (m.itemMode !== undefined && m.itemMode !== room.itemMode) { send(socket, { type: "error", code: "item_mode_mismatch" }); return; }
        if (requestedMap && requestedMap !== room.mapId) { send(socket, { type: "error", code: "map_mismatch" }); return; }
        const capacity = mode === "team" ? 8 : 2;
        if (room.mode !== mode || room.players.size >= capacity || room.phase !== "waiting") { send(socket, { type: "error", code: "room_unavailable" }); return; }
        if ([...room.players.values()].some(p => p.userId === user.id)) { send(socket, { type: "error", code: "already_in_room" }); return; }
        player = addPlayer(room, user, appearance, m.name, socket);
        if (practice) {
          for (let index = 1; index < capacity; index++) addPlayer(room, { id: `bot-${crypto.randomUUID()}` }, resolveAppearance(['momo', 'nori', 'bibi', 'toto'][index % 4], ['classic', 'sunset', 'mint'][index % 3]), `Bot ${index}`, null, true);
        }
        if (room.players.size === capacity) {
          room.matchId = crypto.randomUUID();
          room.roster = [...room.players.values()];
          room.participants = practice ? [] : [...room.players.values()].filter(p => !p.userId.startsWith('dev-')).map(({ userId, team }) => ({ userId, team }));
          room.phase = "playing";
        }
        send(socket, { type: "joined", playerId: player.id, roomId: room.id }); broadcast(room); return;
      } catch {
        // An unexpected provider response or runtime failure must not reject the
        // async event handler and terminate every active match. Do not log tokens.
        console.error("Join processing failed");
        send(socket, { type: "error", code: "internal_error" });
        socket.close(1011, "Join failed");
      } finally { joining = false; }
    }
    if (m.type === "input" && player && player.room.phase === "playing") {
      queueInput(player, m.action);
    }
  });
  socket.on("close", () => {
    if (!player) return;
    const room = player.room;
    if (room.practice) { removePracticeRoom(room); return; }
    room.players.delete(player.id);
    if (room.phase === "playing") {
      if (room.mode === "team") checkResult(room);
      else {
        const survivor = [...room.players.values()].find(p => p.alive);
        room.result = survivor ? { winnerId: survivor.userId, disconnected: player.id } : { draw: true, disconnected: player.id };
        finishMatch(room);
      }
    }
    broadcast(room);
    if (!room.players.size) rooms.delete(room.id);
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.phase !== "playing") continue;
    room.tick++;
    for (const p of room.players.values()) {
      if (p.isBot && room.tick % 3 === 0) {
        const decision = decideBotInput(room, p);
        queueInput(p, decision.move);
        if (decision.placeOrb) queueInput(p, "place_orb");
        if (decision.useDart) queueInput(p, "use_dart");
      }
      processInput(room, p);
    }
    for (const orb of [...room.orbs.values()]) if (--orb.fuse <= 0) explode(room, orb);
    room.waves = room.waves.filter(w => --w.ttl > 0);
    room.dartEffects = room.dartEffects.filter(effect => --effect.ttl > 0);
    for (const p of room.players.values()) if (p.bubbleTicks > 0 && --p.bubbleTicks === 0) eliminatePlayer(room, p);
    checkResult(room); broadcast(room);
  }
}, TICK_MS);

server.listen(port, host, () => console.log(`Pop Pop Arena authoritative server listening on ${host}:${server.address().port}`));
