import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { persistMatch, upsertProfile, verifyAccessToken } from "./supabase.js";

const port = Number(process.env.PORT ?? 8080);
const wss = new WebSocketServer({ port });
const rooms = new Map();
const WIDTH = 13, HEIGHT = 11, TICK_MS = 100, MATCH_TICKS = 1200;
const key = (x, y) => `${x},${y}`;
const send = (socket, message) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message)); };

function makeRoom(id) {
  const solid = new Set(), soft = new Set();
  for (let x = 0; x < WIDTH; x++) for (let y = 0; y < HEIGHT; y++) {
    const border = x === 0 || y === 0 || x === WIDTH - 1 || y === HEIGHT - 1;
    if (border || (x % 2 === 0 && y % 2 === 0)) solid.add(key(x, y));
    else if ((x + y * 3) % 4 === 0 && !(x <= 2 && y <= 2) && !(x >= 10 && y >= 8)) soft.add(key(x, y));
  }
  return { id, tick: 0, players: new Map(), solid, soft, orbs: new Map(), waves: [], phase: "waiting", result: null };
}
function roomFor(id) { if (!rooms.has(id)) rooms.set(id, makeRoom(id)); return rooms.get(id); }
function isWalkable(room, x, y) { const c = key(x, y); return x > 0 && x < WIDTH - 1 && y > 0 && y < HEIGHT - 1 && !room.solid.has(c) && !room.soft.has(c) && !room.orbs.has(c); }
function state(room) {
  return { type: "state", roomId: room.id, phase: room.phase, tick: room.tick, remaining: Math.max(0, MATCH_TICKS - room.tick), result: room.result,
    players: [...room.players.values()].map(({ id, name, x, y, alive, bubbleTicks }) => ({ id, name, x, y, alive, bubbleTicks })),
    soft: [...room.soft], orbs: [...room.orbs.values()].map(({ x, y, fuse }) => ({ x, y, fuse })), waves: room.waves.map(({ x, y, ttl }) => ({ x, y, ttl })) };
}
function broadcast(room) { const message = JSON.stringify(state(room)); for (const p of room.players.values()) if (p.socket.readyState === p.socket.OPEN) p.socket.send(message); }
function wave(room, x, y) { room.waves.push({ x, y, ttl: 4 }); for (const p of room.players.values()) if (p.alive && p.x === x && p.y === y) p.bubbleTicks = Math.max(p.bubbleTicks, 20); }
function explode(room, orb) {
  if (!room.orbs.delete(key(orb.x, orb.y))) return;
  const owner = room.players.get(orb.ownerId); if (owner) owner.activeOrbs = Math.max(0, owner.activeOrbs - 1);
  wave(room, orb.x, orb.y);
  for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) for (let step = 1; step <= orb.range; step++) {
    const x = orb.x + dx * step, y = orb.y + dy * step, cell = key(x, y);
    if (room.solid.has(cell)) break;
    if (room.soft.has(cell)) { room.soft.delete(cell); wave(room, x, y); break; }
    const chained = room.orbs.get(cell); if (chained) explode(room, chained);
    wave(room, x, y);
  }
}
function processInput(room, p) {
  const input = p.input; p.input = null;
  if (!input || !p.alive || p.bubbleTicks > 0) return;
  const delta = { up: [0, 1], down: [0, -1], left: [-1, 0], right: [1, 0] }[input];
  if (delta && isWalkable(room, p.x + delta[0], p.y + delta[1])) { p.x += delta[0]; p.y += delta[1]; return; }
  if (input === "place_orb" && p.activeOrbs < p.maxOrbs && !room.orbs.has(key(p.x, p.y))) {
    const orb = { x: p.x, y: p.y, fuse: 20, range: p.range, ownerId: p.id }; room.orbs.set(key(orb.x, orb.y), orb); p.activeOrbs++;
  }
}
function checkResult(room) {
  const survivors = [...room.players.values()].filter(p => p.alive);
  if (room.phase === "playing" && (survivors.length <= 1 || room.tick >= MATCH_TICKS)) { room.phase = "finished"; room.result = survivors.length === 1 ? { winnerId: survivors[0].userId } : { draw: true }; persistMatch(room); }
}

wss.on("connection", socket => {
  let player, joining = false;
  socket.on("message", async raw => {
    let m; try { m = JSON.parse(raw); } catch { send(socket, { type: "error", code: "invalid_json" }); return; }
    if (!m || typeof m !== "object" || Array.isArray(m)) { send(socket, { type: "error", code: "invalid_message" }); return; }
    if (m.type === "join") {
      if (player || joining) { send(socket, { type: "error", code: "already_joining" }); return; }
      joining = true;
      try {
        let user;
        try { user = await verifyAccessToken(m.accessToken); }
        catch (error) { console.error("Authentication request failed", error.message); send(socket, { type: "error", code: "authentication_unavailable" }); return; }
        if (!user && process.env.ALLOW_DEV_GUESTS !== "true") { send(socket, { type: "error", code: "unauthorized" }); return; }
        if (!user) user = { id: `dev-${crypto.randomUUID()}`, user_metadata: {} };
        try { await upsertProfile(user, m.name); } catch (error) { console.error("Profile update failed", error.message); }
        if (socket.readyState !== socket.OPEN) return;
        const room = roomFor(String(m.roomId ?? "quick"));
        if (room.players.size >= 2 || room.phase !== "waiting") { send(socket, { type: "error", code: "room_unavailable" }); return; }
        const first = room.players.size === 0;
        player = { id: crypto.randomUUID(), userId: user.id, socket, room, name: String(user.user_metadata?.nickname ?? m.name ?? "Popper").slice(0, 12), x: first ? 1 : 11, y: first ? 1 : 9, alive: true, bubbleTicks: 0, maxOrbs: 1, activeOrbs: 0, range: 3, input: null };
        room.players.set(player.id, player); if (room.players.size === 2) room.phase = "playing";
        send(socket, { type: "joined", playerId: player.id, roomId: room.id }); broadcast(room); return;
      } finally { joining = false; }
    }
    if (m.type === "input" && player && ["up", "down", "left", "right", "place_orb"].includes(m.action)) player.input = m.action;
  });
  socket.on("close", () => { if (!player) return; player.room.players.delete(player.id); if (player.room.phase === "playing") { player.room.phase = "finished"; player.room.result = { disconnected: player.id }; } broadcast(player.room); if (!player.room.players.size) rooms.delete(player.room.id); });
});

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.phase !== "playing") continue;
    room.tick++; for (const p of room.players.values()) processInput(room, p);
    for (const orb of [...room.orbs.values()]) if (--orb.fuse <= 0) explode(room, orb);
    room.waves = room.waves.filter(w => --w.ttl > 0);
    for (const p of room.players.values()) if (p.bubbleTicks > 0 && --p.bubbleTicks === 0) p.alive = false;
    checkResult(room); broadcast(room);
  }
}, TICK_MS);

console.log(`Pop Pop Arena authoritative server listening on :${port}`);
