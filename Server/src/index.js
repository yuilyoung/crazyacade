import crypto from "node:crypto";
import { arenaForMode, spawnPoints, resolveArena } from "../public/arena-geometry.js";
import path from "node:path";
import { createServer } from "node:http";
import { createRequestHandler } from "./http.js";
import { WebSocketServer } from "ws";
import { upsertProfile, verifyAccessToken } from "./supabase.js";
import { resolveAppearance, resolveMap, createLayout } from "./catalog.js";
import { movementCooldown, finishScores } from "./combat.js";
import { finalizeMatch } from "./rankings.js";
import { isConnected, clearInput, queueInput, stepMatch } from "./match-engine.js";
import { ruleFor } from "./rules.js";
import { isRankedMatch } from "./ranked-policy.js";
import { initializeMapFeatures, mapFeaturesState } from "./map-features.js";
import { dropRelayCarrier } from "./relay.js";
import { createResultOutbox } from "./result-outbox.js";
import { startTrainingLesson, syncTrainingClock, trainingTiming } from "./training.js";
import { createRuntime, loadRuntimeLimits } from './runtime.js';
import { createAsyncGate } from './async-gate.js';
import { createQueueSessions } from './queue-sessions.js';
import { initializeSeries, recordSeriesResult, advanceSeries, seriesState } from './series.js';

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? (process.env.ALLOW_DEV_GUESTS === "true" ? "127.0.0.1" : "0.0.0.0");
const rooms = new Map();
const demoMode = process.env.ALLOW_DEV_GUESTS === "true";
let stopping = false, shutdownStarted = false, drainTimer;
const limits = loadRuntimeLimits();
const runtime = createRuntime({ limits });
const authGate = createAsyncGate({ capacity: limits.authCapacity, maxPending: limits.authMaxPending });
const sessions = new Set(), userClaims = new Map();
const pendingResultWrites = new Set();
const resultOutbox = demoMode ? null : createResultOutbox({
  directory: path.resolve(process.env.RESULT_OUTBOX_DIR || 'data/results'),
  onStatus: updateResultSaving
});
const server = createServer(createRequestHandler({ runtimeDiagnostics: () => runtime.snapshot({ rooms: rooms.size, queuedPlayers: matchmaking.size, auth: authGate.snapshot() }), storageDiagnostics: () => resultOutbox?.diagnostics() ?? {
  status: 'disabled', pending: 0, retrying: 0, failed: 0, invalid: 0, active: 0, capacity: 1000
} }));
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024, autoPong: false });
const TICK_MS = 100, MATCH_TICKS = 1200;
const MAX_PRACTICE_ROOMS = 8, PRACTICE_RESULT_MS = 120000;
const MAX_SHARED_BOT_ROOMS = 16;
const RECONNECT_GRACE_MS = 30000;
const send = (socket, message) => runtime.send(socket, message);

/** A generation fences every async admission; cancelling never releases another owner's claim. */
function beginOperation(session, kind, requestId) {
  const operation = { kind, requestId, generation: ++session.generation, controller: new AbortController(), claim: null };
  session.operation = operation;
  return operation;
}
function operationCurrent(session, operation) {
  return !shutdownStarted && (!stopping || operation.kind === 'resume') && session.operation === operation && session.generation === operation.generation &&
    session.socket.readyState === session.socket.OPEN && (!operation.claim || (session.claim === operation.claim && operation.claim.session === session && userClaims.get(operation.claim.userId) === operation.claim));
}
function releaseClaim(session) {
  if (session.player || session.queued || session.operation || !session.claim) return;
  if (userClaims.get(session.claim.userId) === session.claim) userClaims.delete(session.claim.userId);
  session.claim = null;
}
function acquireClaim(session, userId) {
  const existing = userClaims.get(userId);
  if (existing && existing !== session.claim) return false;
  if (!existing) { session.claim = { userId, session }; userClaims.set(userId, session.claim); }
  return true;
}
function finishOperation(session, operation) {
  if (session.operation !== operation) return;
  session.operation = null;
  releaseClaim(session);
}
function cancelOperation(session) {
  const operation = session.operation;
  session.operation = null;
  session.generation++;
  operation?.controller.abort();
  releaseClaim(session);
}
let matchedMapIndex = 0;
const matchmaking = createQueueSessions({ capacity: limits.maxQueuedPlayers, demoMode, gate: authGate, send,
  begin: beginOperation, current: operationCurrent, finish: finishOperation, cancelOperation, acquireClaim, releaseClaim,
  canAssign: () => !stopping && rooms.size < limits.maxRooms, assign: assignMatchedRoom,
  removePlayer, broadcast, isDraining: () => stopping });
function assignMatchedRoom(selection, source) {
  if (stopping || rooms.size >= limits.maxRooms) return false;
  const maps = ['garden', 'harbor', 'festival', 'lagoon', 'candy'];
  const room = makeRoom(`matched-${crypto.randomUUID()}`, 'team', maps[matchedMapIndex++ % maps.length], true);
  room.matchmaking = { source, requiredPlayers: 8 };
  rooms.set(room.id, room);
  for (const team of ['blue', 'pink']) for (const entry of selection.teams[team]) {
    const session = entry.session;
    const player = addPlayer(room, entry.user, entry.appearance, entry.name, session.socket, false, team);
    session.player = player;
    Object.assign(player, { session, connected: true, authenticated: entry.authenticated, sessionGeneration: 0,
      reconnectDeadline: null, resumeToken: crypto.randomBytes(32).toString('base64url') });
    player.queueRequestId = entry.requestId;
  }
  room.originalPlayerIds = new Set(room.players.keys());
  startMatch(room);
  for (const player of room.players.values()) send(player.socket, privateJoined(player));
  broadcast(room);
  return true;
}

function makeRoom(id, mode, mapId, itemMode, practice = false, ruleSet = "classic", humanSlots = mode === "team" ? 8 : 2, training = false, trainingMode = "classic", seriesMode = "single") {
  const arena = arenaForMode(mode, training);
  const { solid, soft } = createLayout(mapId, mode, { arena });
  const withBots = !practice && mode === "team" && humanSlots < 8;
  const room = { id, mode, arena, mapId, itemMode, practice, ruleSet, humanSlots: practice ? 1 : humanSlots, withBots, training, trainingMode, ranked: isRankedMatch({ practice, withBots, training, ruleSet }), matchId: null, round: 0, readyPlayerIds: new Set(), dartEffects: [], tick: 0, players: new Map(), solid, soft, items: new Map(), orbs: new Map(), waves: [], phase: "waiting", result: null, resultSaving: null };
  initializeSeries(room, { seriesMode, initialMap: mapId });
  initializeMapFeatures(room);
  ruleFor(room).initialize(room);
  return room;
}
function roomFor(id, mode, mapId, itemMode, ruleSet, humanSlots, seriesMode) { if (!rooms.has(id)) rooms.set(id, makeRoom(id, mode, mapId, itemMode, false, ruleSet, humanSlots, false, "classic", seriesMode)); return rooms.get(id); }
function resetPlayer(player) {
  const spawns = spawnPoints(player.room);
  const [x, y] = spawns[player.room.mode === "team" ? player.slot : player.slot === 0 ? 0 : 7];
  Object.assign(player, { x, y, alive: true, bubbleTicks: 0, maxOrbs: 1, activeOrbs: 0, range: 3, dash: false, pin: false, speedLevel: 0, darts: 0, facing: "up", score: 0, bombsPlaced: 0, itemsCollected: 0, rescues: 0, deliveries: 0, passes: 0, interceptions: 0, passRequested: false, nextMoveTick: 0, input: null, placeRequested: false, dartRequested: false });
  delete player.bubbleSourceId;
  delete player.lastHitTick;
  delete player.immuneUntil;
  delete player.respawnAt;
}
function availableSlot(room, preference = "auto") {
  const occupied = new Set([...room.players.values()].map(p => p.slot));
  const order = room.mode === "team" ? [0, 4, 1, 5, 2, 6, 3, 7] : [0, 1];
  return order.find(slot => !occupied.has(slot) && (preference === "auto" || (slot < 4 ? "blue" : "pink") === preference));
}
function addPlayer(room, user, appearance, name, socket = null, isBot = false, preference = "auto") {
  let team, slot;
  slot = availableSlot(room, preference);
  if (room.mode === "team") {
    team = slot < 4 ? "blue" : "pink";
  }
  const player = { id: crypto.randomUUID(), userId: user.id, socket, room, team, slot, ...appearance, name: String(user.user_metadata?.nickname ?? name ?? "Popper").slice(0, 12), isBot };
  resetPlayer(player);
  room.players.set(player.id, player);
  return player;
}
function connectedPlayers(room) { return [...room.players.values()].filter(p => p.socket && p.socket.readyState === p.socket.OPEN); }
function privateJoined(player, resumed = false) {
  return { type: "joined", playerId: player.id, roomId: player.room.id,
    ...(player.resumeToken ? { resumeToken: player.resumeToken, reconnectGraceMs: RECONNECT_GRACE_MS } : {}),
    ...(!resumed && player.queueRequestId ? { requestId: player.queueRequestId } : {}),
    ...(resumed ? { resumed: true } : {}) };
}
function hasResumeToken(player, token) {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token) && Boolean(player?.resumeToken) &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(player.resumeToken));
}
function startMatch(room) {
  if (room.phase !== "waiting") return;
  const humans = [...room.players.values()].filter(p => !p.isBot);
  if (humans.length !== room.humanSlots || humans.some(p => !isConnected(p))) return;
  if (room.practice || room.withBots) {
    while (room.players.size < 8) {
      const index = room.players.size;
      addPlayer(room, { id: `bot-${crypto.randomUUID()}` }, resolveAppearance(['momo', 'nori', 'bibi', 'toto'][index % 4], ['classic', 'sunset', 'mint'][index % 3]), `Bot ${index}`, null, true);
    }
  }
  if (room.players.size !== (room.mode === "team" ? 8 : 2)) return;
  if (room.training === true) { ruleFor(room).initialize(room, { resetPlayer }); syncTrainingClock(room); }
  room.matchId = crypto.randomUUID();
  room.roster = [...room.players.values()];
  room.participants = [];
  room.phase = "playing";
}
function prepareRematch(room) {
  if (stopping || (room.practice && room.seriesMode !== "party3") || room.phase !== "finished") return;
  const connected = connectedPlayers(room);
  if ([...room.players.values()].some(p => p.resumeToken && !isConnected(p))) return;
  if (!connected.length || !connected.every(p => room.readyPlayerIds.has(p.id)) || connected.some(p => p.session?.operation?.kind === 'next_match')) return;
  if (room.matchmaking && (connected.length !== 8 || room.players.size !== 8 || connected.some(p => !room.originalPlayerIds.has(p.id)))) return;
  // A closing socket may not have reached its close callback yet.
  for (const p of room.players.values()) if (!connected.includes(p) && (!p.isBot || room.seriesMode !== 'party3')) {
    room.players.delete(p.id);
    p.socket = null;
    p.connected = false;
    if (p.session?.player === p) { p.session.player = null; releaseClaim(p.session); }
  }
  clearTimeout(room.expiryTimer);
  delete room.expiryTimer;
  advanceSeries(room);
  const { solid, soft } = createLayout(room.mapId, room.mode, { arena: room.arena });
  Object.assign(room, { solid, soft, mapFeatures: null, tick: 0, matchId: null, roster: [], participants: [], scoresFinalized: false, phase: "waiting", result: null, resultSaving: null, items: new Map(), orbs: new Map(), waves: [], dartEffects: [] });
  room.round++;
  room.readyPlayerIds.clear();
  for (const p of room.players.values()) resetPlayer(p);
  initializeMapFeatures(room);
  ruleFor(room).initialize(room);
  startMatch(room);
}
function removePracticeRoom(room) {
  clearTimeout(room.expiryTimer);
  for (const player of room.players.values()) {
    player.resumeToken = null; player.socket = null;
    if (player.session?.player === player) { player.session.player = null; releaseClaim(player.session); }
  }
  rooms.delete(room.id);
  room.players.clear();
  room.roster = [];
}
function state(room) {
  const connected = connectedPlayers(room);
  const ruleState = ruleFor(room).snapshot(room);
  const timing = trainingTiming(room), remaining = timing?.remainingTicks ?? Math.max(0, MATCH_TICKS - room.tick);
  if (ruleState.training) ruleState.training.readingIdleRemainingSeconds = timing.readingIdleRemainingSeconds;
  return { type: "state", seriesMode: room.seriesMode, series: seriesState(room), matchmaking: room.matchmaking ?? null, roomId: room.id, mode: room.mode, arena: { width: resolveArena(room).width, height: resolveArena(room).height }, mapId: room.mapId, itemMode: room.itemMode, practice: room.practice, ruleSet: room.ruleSet, humanSlots: room.humanSlots, withBots: room.withBots, training: ruleState.training, ranked: room.ranked, matchId: room.matchId, round: room.round, rematch: { readyPlayerIds: connected.filter(p => room.readyPlayerIds.has(p.id)).map(p => p.id), total: [...room.players.values()].filter(p => !p.isBot && (isConnected(p) || p.resumeToken)).length }, relay: ruleState.relay, dartEffects: room.dartEffects, phase: room.phase, tick: room.tick, remaining, remainingSeconds: Math.ceil(remaining / 10), result: room.result, resultSaving: room.phase === 'finished' ? room.resultSaving : null,
    players: [...room.players.values()].map(p => { const { id, name, team, characterId, skinId, orbSkinId, isBot, x, y, alive, bubbleTicks, maxOrbs, range, dash, pin, speedLevel, darts, facing, score, bombsPlaced, itemsCollected, rescues, deliveries, passes, interceptions, respawnAt } = p; return { id, name, team, characterId, skinId, orbSkinId, isBot, x, y, alive, bubbleTicks, maxOrbs, range, dash, pin, speedLevel, moveCooldownTicks: movementCooldown({speedLevel}), darts, facing, score, bombsPlaced, itemsCollected, rescues, deliveries, passes, interceptions, respawnTicks: Math.max(0, (respawnAt ?? room.tick) - room.tick), connected: isConnected(p), reconnectRemainingMs: Math.max(0, (p.reconnectDeadline ?? 0) - Date.now()) }; }),
    solid: [...room.solid], mapFeatures: mapFeaturesState(room), soft: [...room.soft], items: [...room.items.values()], orbs: [...room.orbs.values()].map(({ x, y, fuse, orbSkinId }) => ({ x, y, fuse, orbSkinId })), waves: room.waves.map(({ x, y, ttl }) => ({ x, y, ttl })) };
}
function broadcast(room) { const message = JSON.stringify(state(room)); for (const p of room.players.values()) if (p.socket && p.socket.readyState === p.socket.OPEN) runtime.send(p.socket, message, { replaceable: true }); }
function updateResultSaving(update) {
  if (shutdownStarted) return;
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
  recordSeriesResult(room);
  // Rematches retain the player objects; persistence must own completed values.
  const snapshot = { id: room.id, seriesMode: room.seriesMode, mode: room.mode, practice: room.practice, withBots: room.withBots, training: Boolean(room.training), ruleSet: room.ruleSet, matchId: room.matchId, result: structuredClone(room.result), participants: room.participants.map(p => ({ ...p })) };
  if (!isRankedMatch(room)) {
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
  const result = ruleFor(room).result(room, MATCH_TICKS);
  if (result) { room.result = result; finishMatch(room); }
}

function removePlayer(player) {
  const room = player.room;
  if (player.session?.player === player) { player.session.player = null; releaseClaim(player.session); }
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
  if (room.withBots && ![...room.players.values()].some(p => !p.isBot)) { removePracticeRoom(room); return; }
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
  if (!runtime.admitSocket(socket)) return;
  const session = { socket, player: null, operation: null, queued: null, generation: 0, claim: null,
    demoUser: { id: `dev-${crypto.randomUUID()}`, user_metadata: {} } };
  sessions.add(session);
  socket.isAlive = true;
  socket.on('ping', data => { if (runtime.allowMessage(socket)) runtime.pong(socket, data); });
  socket.on('pong', () => { if (runtime.allowMessage(socket)) socket.isAlive = true; });
  socket.on("error", error => console.warn("WebSocket error", error.code ?? "unknown"));
  socket.on("message", async raw => {
    if (shutdownStarted || !runtime.allowMessage(socket)) return;
    let m; try { m = JSON.parse(raw); } catch { send(socket, { type: "error", code: "invalid_json" }); return; }
    if (!m || typeof m !== "object" || Array.isArray(m)) { send(socket, { type: "error", code: "invalid_message" }); return; }
    let player = session.player;
    if (player && player.socket !== socket) return;
    if (m.type === "ping") { send(socket, { type: "pong" }); return; }
    if (m.type === 'queue_cancel') {
      if (typeof m.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(m.requestId) || Object.keys(m).some(key => !['type', 'requestId'].includes(key))) {
        send(socket, { type: 'error', code: 'invalid_queue' }); return;
      }
      matchmaking.cancel(session, m.requestId); return;
    }
    if (m.type === 'leave' && !player) { matchmaking.cancel(session, undefined, { silent: true }); cancelOperation(session); socket.close(1000, 'Left queue'); return; }
    if (stopping && ['join', 'queue_join', 'next_match', 'rematch'].includes(m.type)) { send(socket, { type: 'error', code: 'server_draining', ...(m.requestId ? { requestId: m.requestId } : {}) }); return; }
    if (m.type === 'queue_join' || m.type === 'next_match') { await matchmaking.join(session, m, m.type === 'next_match'); return; }
    if (m.type === "resume") {
      if (player || session.operation || session.queued) { send(socket, { type: "error", code: "already_joining" }); return; }
      const target = typeof m.roomId === "string" && m.roomId.length <= 64 && typeof m.playerId === "string"
        ? rooms.get(m.roomId)?.players.get(m.playerId) : null;
      if (!hasResumeToken(target, m.resumeToken) || !recoveryAvailable(target)) { send(socket, { type: "error", code: "resume_unavailable" }); return; }
      const generation = target.sessionGeneration;
      const operation = beginOperation(session, 'resume');
      try {
        if (target.authenticated) {
          let user;
          try { user = await authGate.run(() => verifyAccessToken(m.accessToken, { signal: operation.controller.signal }), { signal: operation.controller.signal }); }
          catch { send(socket, { type: "error", code: "authentication_unavailable" }); return; }
          if (!user || user.id !== target.userId) { send(socket, { type: "error", code: "unauthorized" }); return; }
        }
        if (!operationCurrent(session, operation)) return;
        if (!recoveryAvailable(target) || target.sessionGeneration !== generation || !hasResumeToken(target, m.resumeToken)) {
          send(socket, { type: "error", code: "resume_unavailable" }); return;
        }
        const old = target.socket;
        player = target;
        const previousSession = player.session;
        session.player = player;
        if (previousSession) {
          previousSession.player = null;
          session.claim = previousSession.claim;
          previousSession.claim = null;
          if (session.claim) session.claim.session = session;
        }
        player.session = session;
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
      } finally { finishOperation(session, operation); }
      return;
    }
    if (m.type === "join") {
      if (player || session.operation || session.queued) { send(socket, { type: "error", code: "already_joining" }); return; }
      // Validate untrusted values before coercion, profile writes, or remote authentication.
      if ((m.roomId !== undefined && (typeof m.roomId !== "string" || m.roomId.length > 64)) ||
          (m.name !== undefined && (typeof m.name !== "string" || [...m.name].length > 12)) ||
          (m.itemMode !== undefined && typeof m.itemMode !== "boolean") ||
          (m.reconnect !== undefined && typeof m.reconnect !== "boolean") ||
          (m.practice !== undefined && typeof m.practice !== "boolean")) {
        send(socket, { type: "error", code: "invalid_join" }); return;
      }
      if (m.ruleSet !== undefined && m.ruleSet !== "classic" && m.ruleSet !== "relay" && m.ruleSet !== "harmony") { send(socket, { type: "error", code: "invalid_rule_set" }); return; }
      const practice = m.practice === true;
      if ((m.training !== undefined && typeof m.training !== "boolean") || (m.training === true && !practice)) { send(socket, { type: "error", code: "invalid_training" }); return; }
      const training = practice && m.training === true;
      if (m.trainingMode !== undefined && (!training || !['classic', 'harmony'].includes(m.trainingMode))) { send(socket, { type: "error", code: "invalid_training_mode" }); return; }
      const trainingMode = m.trainingMode ?? 'classic';
      const requestedMode = m.mode ?? "duel";
      if (requestedMode !== "duel" && requestedMode !== "team") { send(socket, { type: "error", code: "invalid_mode" }); return; }
      const mode = practice ? "team" : requestedMode;
      const existingRoom = practice ? null : rooms.get(m.roomId ?? "quick");
      if (existingRoom?.matchmaking) { send(socket, { type: 'error', code: 'room_unavailable' }); return; }
      const seriesMode = m.seriesMode === undefined ? (existingRoom?.seriesMode ?? 'single') : m.seriesMode;
      if (!['single', 'party3'].includes(seriesMode) || (seriesMode === 'party3' && (mode !== 'team' || training))) { send(socket, { type: 'error', code: 'invalid_series_mode' }); return; }
      if (existingRoom && m.seriesMode !== undefined && seriesMode !== existingRoom.seriesMode) { send(socket, { type: 'error', code: 'series_mode_mismatch' }); return; }
      if (m.humanSlots !== undefined && (!Number.isInteger(m.humanSlots) || ![2, 4, 6, 8].includes(m.humanSlots) || practice || (mode !== "team" && m.humanSlots !== 2))) { send(socket, { type: "error", code: "invalid_human_slots" }); return; }
      if (existingRoom && m.humanSlots !== undefined && m.humanSlots !== existingRoom.humanSlots) { send(socket, { type: "error", code: "human_slots_mismatch" }); return; }
      const humanSlots = practice ? 1 : (m.humanSlots ?? existingRoom?.humanSlots ?? (mode === "team" ? 8 : 2));
      if (m.teamPreference !== undefined && (!['auto', 'blue', 'pink'].includes(m.teamPreference) || practice || mode !== "team" || humanSlots === 8)) { send(socket, { type: "error", code: "invalid_team_preference" }); return; }
      if (existingRoom && m.ruleSet !== undefined && m.ruleSet !== existingRoom.ruleSet) { send(socket, { type: "error", code: "rule_set_mismatch" }); return; }
      const requestedRules = training ? trainingMode : (m.ruleSet ?? existingRoom?.ruleSet ?? "classic");
      if (["relay", "harmony"].includes(requestedRules) && mode !== "team") { send(socket, { type: "error", code: "invalid_rule_mode" }); return; }
      const appearance = resolveAppearance(m.characterId, m.skinId, m.orbSkinId);
      const requestedMap = m.mapId === undefined ? undefined : resolveMap(m.mapId);
      if (!appearance || (m.mapId !== undefined && !requestedMap)) { send(socket, { type: "error", code: "invalid_selection" }); return; }
      const operation = beginOperation(session, 'join');
      try {
        let user, authenticated = false;
        if (practice) user = { id: `practice-${crypto.randomUUID()}`, user_metadata: {} };
        else {
          let stage = 'authentication_unavailable';
          try {
            await authGate.run(async () => {
              user = await verifyAccessToken(m.accessToken, { signal: operation.controller.signal });
              if (!operationCurrent(session, operation)) return;
              authenticated = Boolean(user);
              if (!user && !demoMode) { send(socket, { type: 'error', code: 'unauthorized' }); return; }
              if (!user) user = session.demoUser;
              if (!acquireClaim(session, user.id)) { user = null; send(socket, { type: 'error', code: 'already_in_room' }); return; }
              operation.claim = session.claim;
              stage = 'profile_unavailable';
              await upsertProfile(user, m.name, { signal: operation.controller.signal });
            }, { signal: operation.controller.signal });
          } catch {
            if (operationCurrent(session, operation)) send(socket, { type: 'error', code: stage });
            return;
          }
        }
        if (!operationCurrent(session, operation) || !user) return;
        let room;
        if (practice) {
          // The peer can finish its close handshake before our close callback.
          // Reclaim that room now so an immediate replay can use its capacity.
          for (const existing of rooms.values()) {
            if (!existing.practice) continue;
            const owner = [...existing.players.values()].find(p => !p.isBot);
            if (!owner || (!isConnected(owner) && !recoveryAvailable(owner))) removePracticeRoom(existing);
          }
          if (rooms.size >= limits.maxRooms) { send(socket, { type: "error", code: "room_unavailable" }); return; }
          if ([...rooms.values()].filter(room => room.practice).length >= MAX_PRACTICE_ROOMS) { send(socket, { type: "error", code: "practice_unavailable" }); return; }
          room = makeRoom(`practice-${crypto.randomUUID()}`, mode, training ? (trainingMode === "harmony" ? "festival" : "garden") : (requestedMap ?? "garden"), training ? true : (m.itemMode ?? true), true, requestedRules, 1, training, trainingMode, seriesMode);
          rooms.set(room.id, room);
        } else {
          if (rooms.get(m.roomId ?? "quick")?.practice || rooms.get(m.roomId ?? "quick")?.matchmaking) { send(socket, { type: "error", code: "room_unavailable" }); return; }
          // Closing peers can precede their close callbacks. Reclaim abandoned
          // mixed rooms without removing a human's reconnect reservation.
          for (const existing of rooms.values()) if (existing.withBots) {
            for (const owner of existing.players.values()) if (!owner.isBot && !isConnected(owner) && !recoveryAvailable(owner)) removePlayer(owner);
          }
          if (!rooms.has(m.roomId ?? "quick") && mode === "team" && humanSlots < 8 && [...rooms.values()].filter(room => room.withBots).length >= MAX_SHARED_BOT_ROOMS) { send(socket, { type: "error", code: "bot_rooms_unavailable" }); return; }
          if (!rooms.has(m.roomId ?? "quick") && rooms.size >= limits.maxRooms) { send(socket, { type: "error", code: "room_unavailable" }); return; }
          room = roomFor(m.roomId ?? "quick", mode, requestedMap ?? "garden", m.itemMode ?? true, m.ruleSet ?? "classic", humanSlots, seriesMode);
        }
        // Authentication can yield while another connection creates the room.
        if (room.matchmaking) { send(socket, { type: 'error', code: 'room_unavailable' }); return; }
        if (m.seriesMode !== undefined && room.seriesMode !== seriesMode) { send(socket, { type: 'error', code: 'series_mode_mismatch' }); return; }
        if (m.humanSlots !== undefined && m.humanSlots !== room.humanSlots) { send(socket, { type: "error", code: "human_slots_mismatch" }); return; }
        if (m.teamPreference !== undefined && !room.withBots) { send(socket, { type: "error", code: "invalid_team_preference" }); return; }
        if (!training && m.ruleSet !== undefined && m.ruleSet !== room.ruleSet) { send(socket, { type: "error", code: "rule_set_mismatch" }); return; }
        if (["relay", "harmony"].includes(room.ruleSet) && mode !== "team") { send(socket, { type: "error", code: "invalid_rule_mode" }); return; }
        if (!training && m.itemMode !== undefined && m.itemMode !== room.itemMode) { send(socket, { type: "error", code: "item_mode_mismatch" }); return; }
        if (!training && requestedMap && requestedMap !== room.mapId) { send(socket, { type: "error", code: "map_mismatch" }); return; }
        if (room.mode !== mode || [...room.players.values()].filter(p => !p.isBot).length >= room.humanSlots || room.phase !== "waiting") { send(socket, { type: "error", code: "room_unavailable" }); return; }
        if ([...room.players.values()].some(p => p.userId === user.id)) { send(socket, { type: "error", code: "already_in_room" }); return; }
        if (availableSlot(room, m.teamPreference) === undefined) { send(socket, { type: "error", code: "team_full" }); return; }
        player = addPlayer(room, user, appearance, m.name, socket, false, m.teamPreference);
        session.player = player;
        Object.assign(player, { session, connected: true, authenticated, sessionGeneration: 0, reconnectDeadline: null,
          resumeToken: m.reconnect === true ? crypto.randomBytes(32).toString("base64url") : null });
        startMatch(room);
        send(socket, privateJoined(player)); broadcast(room); return;
      } catch {
        // An unexpected provider response or runtime failure must not reject the
        // async event handler and terminate every active match. Do not log tokens.
        console.error("Join processing failed");
        send(socket, { type: "error", code: "internal_error" });
        socket.close(1011, "Join failed");
      } finally { finishOperation(session, operation); }
    }
    if (m.type === "leave" && player) { matchmaking.cancel(session, undefined, { silent: true }); cancelOperation(session); removePlayer(player); socket.close(1000, "Left room"); return; }
    if (m.type === "training_ready" && player?.room.practice && player.room.phase === "playing" && player.room.training?.playerId === player.id) {
      if (startTrainingLesson(player.room)) broadcast(player.room);
      return;
    }
    if (m.type === "input" && player && player.room.phase === "playing") {
      if (player.room.training && player.room.training.status !== 'active') return;
      queueInput(player, m.action);
    }
    if (m.type === "rematch" && player && (!player.room.practice || player.room.seriesMode === 'party3') && player.room.phase === "finished") {
      const room = player.room;
      if ((m.ready !== undefined && typeof m.ready !== 'boolean') ||
          (m.matchId !== undefined && m.matchId !== room.matchId) || (room.matchmaking && m.matchId !== room.matchId)) {
        send(socket, { type: 'error', code: 'stale_match' }); return;
      }
      if (session.operation?.kind === 'next_match') { send(socket, { type: 'error', code: 'already_joining' }); return; }
      const ready = m.ready ?? true;
      if (room.readyPlayerIds.has(player.id) === ready) return;
      if (ready) room.readyPlayerIds.add(player.id); else room.readyPlayerIds.delete(player.id);
      prepareRematch(room);
      broadcast(room);
    }
  });
  socket.on("close", () => {
    matchmaking.cancel(session, undefined, { silent: true });
    cancelOperation(session);
    if (!shutdownStarted && session.player?.socket === socket) detachPlayer(session.player);
    runtime.releaseSocket(socket);
    sessions.delete(session);
    releaseClaim(session);
  });
});

const heartbeatTimer = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) { socket.terminate(); continue; }
    socket.isAlive = false;
    if (socket.readyState === socket.OPEN) runtime.ping(socket);
  }
}, 5000);

let previousTickAt = performance.now();
const gameTimer = setInterval(() => {
  const startedAt = performance.now();
  const lagMs = Math.max(0, startedAt - previousTickAt - TICK_MS);
  previousTickAt = startedAt;
  matchmaking.tick();
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
    stepMatch(room, { resetPlayer });
    checkResult(room); broadcast(room);
  }
  runtime.recordTick({ durationMs: performance.now() - startedAt, lagMs });
  if (stopping && ![...rooms.values()].some(room => room.phase === "playing")) void shutdown();
}, TICK_MS);

async function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  clearTimeout(drainTimer);
  resultOutbox?.pause();
  clearInterval(heartbeatTimer); clearInterval(gameTimer);
  authGate.close();
  for (const session of sessions) cancelOperation(session);
  for (const room of rooms.values()) clearTimeout(room.expiryTimer);
  // Forced cuts do not detach players or synthesize an unfinished match result.
  for (const socket of wss.clients) socket.terminate();
  runtime.close();
  wss.close();
  server.close();
  server.closeAllConnections();
  await Promise.allSettled([...pendingResultWrites]);
  await resultOutbox?.close();
  if (process.connected) process.disconnect();
}
async function stop() {
  if (stopping) return shutdown();
  stopping = true;
  runtime.setDraining();
  matchmaking.drain(sessions);
  for (const session of sessions) cancelOperation(session);
  if (![...rooms.values()].some(room => room.phase === 'playing')) return shutdown();
  drainTimer = setTimeout(() => { void shutdown().catch(shutdownFailure); }, limits.drainMs);
}
function shutdownFailure() { console.error('Result storage shutdown failed'); process.exitCode = 1; }
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void stop().catch(shutdownFailure); });

try {
  await resultOutbox?.start();
  if (!stopping) server.listen(port, host, () => console.log(`Pop Pop Arena authoritative server listening on ${host}:${server.address().port}`));
} catch {
  console.error('Result storage initialization failed');
  await stop();
  process.exitCode = 1;
}
