import crypto from "node:crypto";
import path from "node:path";
import { createServer } from "node:http";
import { createRequestHandler } from "./http.js";
import { WebSocketServer } from "ws";
import { upsertProfile, verifyAccessToken } from "./supabase.js";
import { dropPickup, collectPickup, rescueAdjacent, hitPlayer } from "./pickups.js";
import { resolveAppearance, resolveMap, createLayout } from "./catalog.js";
import { awardScore, movementCooldown, fireDart, eliminatePlayer, finishScores } from "./combat.js";
import { finalizeMatch } from "./rankings.js";
import { decideBotInput } from "./bots.js";
import { initializeRelay, stepRelay, dropRelayCarrier, relayResult, relayState } from "./relay.js";
import { createResultOutbox } from "./result-outbox.js";

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? (process.env.ALLOW_DEV_GUESTS === "true" ? "127.0.0.1" : "0.0.0.0");
const rooms = new Map();
const demoMode = process.env.ALLOW_DEV_GUESTS === "true";
let stopping = false;
const pendingResultWrites = new Set();
const resultOutbox = demoMode ? null : createResultOutbox({
  directory: path.resolve(process.env.RESULT_OUTBOX_DIR || 'data/results'),
  onStatus: updateResultSaving
});
const server = createServer(createRequestHandler({ storageDiagnostics: () => resultOutbox?.diagnostics() ?? {
  status: 'disabled', pending: 0, retrying: 0, failed: 0, invalid: 0, active: 0, capacity: 1000
} }));
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
const WIDTH = 13, HEIGHT = 11, TICK_MS = 100, MATCH_TICKS = 1200;
const MAX_PRACTICE_ROOMS = 8, PRACTICE_RESULT_MS = 120000;
const RECONNECT_GRACE_MS = 30000;
const TEAM_SPAWNS = [[1, 1], [1, 3], [1, 7], [1, 9], [11, 1], [11, 3], [11, 7], [11, 9]];
const key = (x, y) => `${x},${y}`;
const send = (socket, message) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message)); };

function makeRoom(id, mode, mapId, itemMode, practice = false, ruleSet = "classic") {
  const { solid, soft } = createLayout(mapId, mode);
  const room = { id, mode, mapId, itemMode, practice, ruleSet, ranked: !practice && ruleSet === "classic", matchId: null, round: 0, readyPlayerIds: new Set(), dartEffects: [], tick: 0, players: new Map(), solid, soft, items: new Map(), orbs: new Map(), waves: [], phase: "waiting", result: null, resultSaving: null };
  initializeRelay(room);
  return room;
}
function roomFor(id, mode, mapId, itemMode, ruleSet) { if (!rooms.has(id)) rooms.set(id, makeRoom(id, mode, mapId, itemMode, false, ruleSet)); return rooms.get(id); }
function resetPlayer(player) {
  const [x, y] = player.room.mode === "team" ? TEAM_SPAWNS[player.slot] : (player.slot === 0 ? [1, 1] : [11, 9]);
  Object.assign(player, { x, y, alive: true, bubbleTicks: 0, maxOrbs: 1, activeOrbs: 0, range: 3, dash: false, pin: false, speedLevel: 0, darts: 0, facing: "up", score: 0, bombsPlaced: 0, itemsCollected: 0, rescues: 0, deliveries: 0, nextMoveTick: 0, input: null, placeRequested: false, dartRequested: false });
  delete player.bubbleSourceId;
  delete player.lastHitTick;
  delete player.immuneUntil;
  delete player.respawnAt;
}
function addPlayer(room, user, appearance, name, socket = null, isBot = false) {
  let team, slot;
  const occupied = new Set([...room.players.values()].map(p => p.slot));
  if (room.mode === "team") {
    slot = [0, 4, 1, 5, 2, 6, 3, 7].find(index => !occupied.has(index));
    team = slot < 4 ? "blue" : "pink";
  } else slot = [0, 1].find(index => !occupied.has(index));
  const player = { id: crypto.randomUUID(), userId: user.id, socket, room, team, slot, ...appearance, name: String(user.user_metadata?.nickname ?? name ?? "Popper").slice(0, 12), isBot };
  resetPlayer(player);
  room.players.set(player.id, player);
  return player;
}
function connectedPlayers(room) { return [...room.players.values()].filter(p => p.socket && p.socket.readyState === p.socket.OPEN); }
function isConnected(player) { return player.isBot || Boolean(player.socket && player.socket.readyState === player.socket.OPEN); }
function clearInput(player) { player.input = null; player.placeRequested = false; player.dartRequested = false; }
function privateJoined(player, resumed = false) {
  return { type: "joined", playerId: player.id, roomId: player.room.id,
    ...(player.resumeToken ? { resumeToken: player.resumeToken, reconnectGraceMs: RECONNECT_GRACE_MS } : {}),
    ...(resumed ? { resumed: true } : {}) };
}
function hasResumeToken(player, token) {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token) && Boolean(player?.resumeToken) &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(player.resumeToken));
}
function startMatch(room) {
  if (room.phase !== "waiting" || room.players.size !== (room.mode === "team" ? 8 : 2) || [...room.players.values()].some(p => !isConnected(p))) return;
  room.matchId = crypto.randomUUID();
  room.roster = [...room.players.values()];
  room.participants = [];
  room.phase = "playing";
}
function prepareRematch(room) {
  if (room.practice || room.phase !== "finished") return;
  const connected = connectedPlayers(room);
  if ([...room.players.values()].some(p => p.resumeToken && !isConnected(p))) return;
  if (!connected.length || !connected.every(p => room.readyPlayerIds.has(p.id))) return;
  // A closing socket may not have reached its close callback yet.
  for (const p of room.players.values()) if (!connected.includes(p)) room.players.delete(p.id);
  clearTimeout(room.expiryTimer);
  delete room.expiryTimer;
  const { solid, soft } = createLayout(room.mapId, room.mode);
  Object.assign(room, { solid, soft, tick: 0, matchId: null, roster: [], participants: [], scoresFinalized: false, phase: "waiting", result: null, resultSaving: null, items: new Map(), orbs: new Map(), waves: [], dartEffects: [] });
  room.round++;
  room.readyPlayerIds.clear();
  for (const p of room.players.values()) resetPlayer(p);
  initializeRelay(room);
  startMatch(room);
}
function removePracticeRoom(room) {
  clearTimeout(room.expiryTimer);
  for (const player of room.players.values()) { player.resumeToken = null; player.socket = null; }
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
  const connected = connectedPlayers(room);
  return { type: "state", roomId: room.id, mode: room.mode, mapId: room.mapId, itemMode: room.itemMode, practice: room.practice, ruleSet: room.ruleSet, ranked: room.ranked, matchId: room.matchId, round: room.round, rematch: { readyPlayerIds: connected.filter(p => room.readyPlayerIds.has(p.id)).map(p => p.id), total: [...room.players.values()].filter(p => !p.isBot && (isConnected(p) || p.resumeToken)).length }, relay: relayState(room), dartEffects: room.dartEffects, phase: room.phase, tick: room.tick, remaining: Math.max(0, MATCH_TICKS - room.tick), result: room.result, resultSaving: room.phase === 'finished' ? room.resultSaving : null,
    players: [...room.players.values()].map(p => { const { id, name, team, characterId, skinId, isBot, x, y, alive, bubbleTicks, maxOrbs, range, dash, pin, speedLevel, darts, facing, score, bombsPlaced, itemsCollected, rescues, deliveries, respawnAt } = p; return { id, name, team, characterId, skinId, isBot, x, y, alive, bubbleTicks, maxOrbs, range, dash, pin, speedLevel, moveCooldownTicks: movementCooldown({speedLevel}), darts, facing, score, bombsPlaced, itemsCollected, rescues, deliveries, respawnTicks: Math.max(0, (respawnAt ?? room.tick) - room.tick), connected: isConnected(p), reconnectRemainingMs: Math.max(0, (p.reconnectDeadline ?? 0) - Date.now()) }; }),
    soft: [...room.soft], items: [...room.items.values()], orbs: [...room.orbs.values()].map(({ x, y, fuse }) => ({ x, y, fuse })), waves: room.waves.map(({ x, y, ttl }) => ({ x, y, ttl })) };
}
function broadcast(room) { const message = JSON.stringify(state(room)); for (const p of room.players.values()) if (p.socket && p.socket.readyState === p.socket.OPEN) p.socket.send(message); }
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
    if (room.solid.has(cell)) break;
    if (room.soft.has(cell)) { room.soft.delete(cell); awardScore(owner, 5); wave(room, x, y, orb.ownerId); dropPickup(room, x, y); break; }
    const chained = room.orbs.get(cell); if (chained) explode(room, chained);
    wave(room, x, y, orb.ownerId);
  }
}
function processInput(room, p) {
  if (!isConnected(p)) { clearInput(p); return; }
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
    if (hazard) hit(room, p, hazard.ownerId);
    if (p.bubbleTicks > 0) return;
    collectPickup(room, p);
    rescueAdjacent(room, p);
  }
}
function updateResultSaving(update) {
  if (stopping) return;
  for (const room of rooms.values()) {
    if (room.phase !== 'finished' || room.matchId !== update.matchId) continue;
    room.resultSaving = { matchId: update.matchId, status: update.status, attempts: update.attempts };
    broadcast(room);
  }
}
function finishMatch(room) {
  if (room.phase !== 'playing') return;
  room.phase = "finished";
  finishScores(room);
  // Rematches retain the player objects; persistence must own completed values.
  const snapshot = { id: room.id, mode: room.mode, practice: room.practice, ruleSet: room.ruleSet, matchId: room.matchId, result: structuredClone(room.result), participants: room.participants.map(p => ({ ...p })) };
  if (room.practice || room.ruleSet === 'relay') {
    room.resultSaving = { matchId: room.matchId, status: 'unranked', attempts: 0 };
  } else {
    room.resultSaving = { matchId: room.matchId, status: 'saving', attempts: 0 };
    const task = (demoMode ? finalizeMatch(snapshot).then(() => updateResultSaving({ matchId: snapshot.matchId, status: 'demo', attempts: 0 })) : resultOutbox.enqueue(snapshot))
      .catch(() => {
        // Provider bodies, credentials and filesystem paths are never logged.
        console.error('Match result could not be queued or finalized');
        updateResultSaving({ matchId: snapshot.matchId, status: 'failed', attempts: 0 });
      });
    pendingResultWrites.add(task);
    void task.finally(() => pendingResultWrites.delete(task));
  }
  if (room.practice) {
    room.expiryTimer = setTimeout(() => {
      const sockets = [...room.players.values()].map(p => p.socket).filter(Boolean);
      removePracticeRoom(room);
      for (const socket of sockets) socket.close(1000, "Practice finished");
    }, PRACTICE_RESULT_MS);
  }
}
function checkResult(room) {
  if (room.phase !== "playing") return;
  if (room.ruleSet === "relay") {
    const result = relayResult(room, MATCH_TICKS);
    if (result) { room.result = result; finishMatch(room); }
    return;
  }
  const survivors = [...room.players.values()].filter(p => p.alive);
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

function removePlayer(player) {
  const room = player.room;
  player.resumeToken = null;
  player.socket = null;
  player.connected = false;
  player.reconnectDeadline = null;
  clearInput(player);
  if (rooms.get(room.id) !== room || !room.players.has(player.id)) return;
  if (room.practice) { removePracticeRoom(room); return; }
  dropRelayCarrier(room, player.id);
  room.players.delete(player.id);
  room.readyPlayerIds.delete(player.id);
  if (room.phase === "playing") {
    if (room.mode === "team") checkResult(room);
    else {
      const survivor = [...room.players.values()].find(p => p.alive);
      room.result = survivor ? { winnerId: survivor.userId, disconnected: player.id } : { draw: true, disconnected: player.id };
      finishMatch(room);
    }
  }
  prepareRematch(room);
  broadcast(room);
  if (!room.players.size) rooms.delete(room.id);
}
function detachPlayer(player) {
  if (rooms.get(player.room.id) !== player.room || !player.room.players.has(player.id)) return;
  if (!player.resumeToken) { removePlayer(player); return; }
  player.socket = null;
  player.connected = false;
  player.reconnectDeadline ??= Date.now() + RECONNECT_GRACE_MS;
  clearInput(player);
  player.room.readyPlayerIds.delete(player.id);
  dropRelayCarrier(player.room, player.id);
  broadcast(player.room);
}
function recoveryAvailable(player) {
  if (!player || !player.resumeToken || rooms.get(player.room.id) !== player.room || player.room.players.get(player.id) !== player) return false;
  if (player.socket && !isConnected(player)) detachPlayer(player);
  if (player.reconnectDeadline !== null && player.reconnectDeadline <= Date.now()) { removePlayer(player); return false; }
  return true;
}

wss.on("connection", socket => {
  if (stopping) { socket.close(1012, 'Server restarting'); return; }
  let player, joining = false;
  socket.isAlive = true;
  socket.on("pong", () => { socket.isAlive = true; });
  socket.on("error", error => console.warn("WebSocket error", error.code ?? "unknown"));
  socket.on("message", async raw => {
    if (stopping) return;
    let m; try { m = JSON.parse(raw); } catch { send(socket, { type: "error", code: "invalid_json" }); return; }
    if (!m || typeof m !== "object" || Array.isArray(m)) { send(socket, { type: "error", code: "invalid_message" }); return; }
    if (player && player.socket !== socket) return;
    if (m.type === "ping") { send(socket, { type: "pong" }); return; }
    if (m.type === "resume") {
      if (player || joining) { send(socket, { type: "error", code: "already_joining" }); return; }
      const target = typeof m.roomId === "string" && m.roomId.length <= 64 && typeof m.playerId === "string"
        ? rooms.get(m.roomId)?.players.get(m.playerId) : null;
      if (!hasResumeToken(target, m.resumeToken) || !recoveryAvailable(target)) { send(socket, { type: "error", code: "resume_unavailable" }); return; }
      const generation = target.sessionGeneration;
      joining = true;
      try {
        if (target.authenticated) {
          let user;
          try { user = await verifyAccessToken(m.accessToken); }
          catch { send(socket, { type: "error", code: "authentication_unavailable" }); return; }
          if (!user || user.id !== target.userId) { send(socket, { type: "error", code: "unauthorized" }); return; }
        }
        if (socket.readyState !== socket.OPEN) return;
        if (!recoveryAvailable(target) || target.sessionGeneration !== generation || !hasResumeToken(target, m.resumeToken)) {
          send(socket, { type: "error", code: "resume_unavailable" }); return;
        }
        const old = target.socket;
        player = target;
        player.socket = socket;
        player.connected = true;
        player.reconnectDeadline = null;
        player.sessionGeneration++;
        player.room.readyPlayerIds.delete(player.id);
        clearInput(player);
        if (old && old !== socket) old.close(4001, "Session replaced");
        startMatch(player.room);
        send(socket, privateJoined(player, true));
        broadcast(player.room);
      } catch {
        send(socket, { type: "error", code: "internal_error" });
        socket.close(1011, "Resume failed");
      } finally { joining = false; }
      return;
    }
    if (m.type === "join") {
      if (player || joining) { send(socket, { type: "error", code: "already_joining" }); return; }
      // Validate untrusted values before coercion, profile writes, or remote authentication.
      if ((m.roomId !== undefined && (typeof m.roomId !== "string" || m.roomId.length > 64)) ||
          (m.name !== undefined && (typeof m.name !== "string" || [...m.name].length > 12)) ||
          (m.itemMode !== undefined && typeof m.itemMode !== "boolean") ||
          (m.reconnect !== undefined && typeof m.reconnect !== "boolean") ||
          (m.practice !== undefined && typeof m.practice !== "boolean")) {
        send(socket, { type: "error", code: "invalid_join" }); return;
      }
      if (m.ruleSet !== undefined && m.ruleSet !== "classic" && m.ruleSet !== "relay") { send(socket, { type: "error", code: "invalid_rule_set" }); return; }
      const practice = m.practice === true;
      const requestedMode = m.mode ?? "duel";
      if (requestedMode !== "duel" && requestedMode !== "team") { send(socket, { type: "error", code: "invalid_mode" }); return; }
      const mode = practice ? "team" : requestedMode;
      const existingRoom = practice ? null : rooms.get(m.roomId ?? "quick");
      if (existingRoom && m.ruleSet !== undefined && m.ruleSet !== existingRoom.ruleSet) { send(socket, { type: "error", code: "rule_set_mismatch" }); return; }
      const requestedRules = m.ruleSet ?? existingRoom?.ruleSet ?? "classic";
      if (requestedRules === "relay" && mode !== "team") { send(socket, { type: "error", code: "invalid_rule_mode" }); return; }
      const appearance = resolveAppearance(m.characterId, m.skinId);
      const requestedMap = m.mapId === undefined ? undefined : resolveMap(m.mapId);
      if (!appearance || (m.mapId !== undefined && !requestedMap)) { send(socket, { type: "error", code: "invalid_selection" }); return; }
      joining = true;
      try {
        let user, authenticated = false;
        if (practice) user = { id: `practice-${crypto.randomUUID()}`, user_metadata: {} };
        else {
          try { user = await verifyAccessToken(m.accessToken); }
          catch (error) { console.error("Authentication request failed"); send(socket, { type: "error", code: "authentication_unavailable" }); return; }
          authenticated = Boolean(user);
          if (!user && process.env.ALLOW_DEV_GUESTS !== "true") { send(socket, { type: "error", code: "unauthorized" }); return; }
          if (!user) user = { id: `dev-${crypto.randomUUID()}`, user_metadata: {} };
          try { await upsertProfile(user, m.name); } catch (error) { console.error("Profile update failed"); send(socket, { type: "error", code: "profile_unavailable" }); return; }
        }
        if (socket.readyState !== socket.OPEN) return;
        let room;
        if (practice) {
          // The peer can finish its close handshake before our close callback.
          // Reclaim that room now so an immediate replay can use its capacity.
          for (const existing of rooms.values()) {
            if (!existing.practice) continue;
            const owner = [...existing.players.values()].find(p => !p.isBot);
            if (!owner || (!isConnected(owner) && !recoveryAvailable(owner))) removePracticeRoom(existing);
          }
          if ([...rooms.values()].filter(room => room.practice).length >= MAX_PRACTICE_ROOMS) { send(socket, { type: "error", code: "practice_unavailable" }); return; }
          room = makeRoom(`practice-${crypto.randomUUID()}`, mode, requestedMap ?? "garden", m.itemMode ?? true, true, requestedRules);
          rooms.set(room.id, room);
        } else {
          if (rooms.get(m.roomId ?? "quick")?.practice) { send(socket, { type: "error", code: "room_unavailable" }); return; }
          room = roomFor(m.roomId ?? "quick", mode, requestedMap ?? "garden", m.itemMode ?? true, m.ruleSet ?? "classic");
        }
        // Authentication can yield while another connection creates the room.
        if (m.ruleSet !== undefined && m.ruleSet !== room.ruleSet) { send(socket, { type: "error", code: "rule_set_mismatch" }); return; }
        if (room.ruleSet === "relay" && mode !== "team") { send(socket, { type: "error", code: "invalid_rule_mode" }); return; }
        if (m.itemMode !== undefined && m.itemMode !== room.itemMode) { send(socket, { type: "error", code: "item_mode_mismatch" }); return; }
        if (requestedMap && requestedMap !== room.mapId) { send(socket, { type: "error", code: "map_mismatch" }); return; }
        const capacity = mode === "team" ? 8 : 2;
        if (room.mode !== mode || room.players.size >= capacity || room.phase !== "waiting") { send(socket, { type: "error", code: "room_unavailable" }); return; }
        if ([...room.players.values()].some(p => p.userId === user.id)) { send(socket, { type: "error", code: "already_in_room" }); return; }
        player = addPlayer(room, user, appearance, m.name, socket);
        Object.assign(player, { connected: true, authenticated, sessionGeneration: 0, reconnectDeadline: null,
          resumeToken: m.reconnect === true ? crypto.randomBytes(32).toString("base64url") : null });
        if (practice) {
          for (let index = 1; index < capacity; index++) addPlayer(room, { id: `bot-${crypto.randomUUID()}` }, resolveAppearance(['momo', 'nori', 'bibi', 'toto'][index % 4], ['classic', 'sunset', 'mint'][index % 3]), `Bot ${index}`, null, true);
        }
        startMatch(room);
        send(socket, privateJoined(player)); broadcast(room); return;
      } catch {
        // An unexpected provider response or runtime failure must not reject the
        // async event handler and terminate every active match. Do not log tokens.
        console.error("Join processing failed");
        send(socket, { type: "error", code: "internal_error" });
        socket.close(1011, "Join failed");
      } finally { joining = false; }
    }
    if (m.type === "leave" && player) { removePlayer(player); socket.close(1000, "Left room"); return; }
    if (m.type === "input" && player && player.room.phase === "playing") {
      queueInput(player, m.action);
    }
    if (m.type === "rematch" && player && !player.room.practice && player.room.phase === "finished") {
      const room = player.room;
      room.readyPlayerIds.add(player.id);
      prepareRematch(room);
      broadcast(room);
    }
  });
  socket.on("close", () => {
    if (!stopping && player?.socket === socket) detachPlayer(player);
  });
});

const heartbeatTimer = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) { socket.terminate(); continue; }
    socket.isAlive = false;
    if (socket.readyState === socket.OPEN) socket.ping();
  }
}, 5000);

const gameTimer = setInterval(() => {
  for (const room of rooms.values()) {
    for (const player of room.players.values()) {
      if (!player.isBot && player.socket && !isConnected(player)) detachPlayer(player);
      if (player.reconnectDeadline !== null && player.reconnectDeadline <= Date.now()) removePlayer(player);
    }
    if (rooms.get(room.id) !== room) continue;
    if (room.phase !== "playing") {
      const now = Date.now();
      if ([...room.players.values()].some(p => p.reconnectDeadline > now) &&
          now - (room.lastRecoveryBroadcastAt ?? 0) >= 1000) {
        room.lastRecoveryBroadcastAt = now;
        broadcast(room);
      }
      continue;
    }
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
    stepRelay(room);
    checkResult(room); broadcast(room);
  }
}, TICK_MS);

async function stop() {
  if (stopping) return;
  stopping = true;
  resultOutbox?.pause();
  clearInterval(heartbeatTimer); clearInterval(gameTimer);
  for (const room of rooms.values()) clearTimeout(room.expiryTimer);
  for (const socket of wss.clients) socket.terminate();
  wss.close();
  server.close();
  server.closeAllConnections();
  await Promise.allSettled([...pendingResultWrites]);
  await resultOutbox?.close();
  if (process.connected) process.disconnect();
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  void stop().catch(() => { console.error('Result storage shutdown failed'); process.exitCode = 1; });
});
try {
  await resultOutbox?.start();
  if (!stopping) server.listen(port, host, () => console.log(`Pop Pop Arena authoritative server listening on ${host}:${server.address().port}`));
} catch {
  console.error('Result storage initialization failed');
  await stop();
  process.exitCode = 1;
}
