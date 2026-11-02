import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { setup, provider, waitFor, send, close } from './fixtures/relay-server.mjs';
import { initializeRelay, stepRelay } from '../src/relay.js';

const joined = client => client.messages.find(message => message.type === 'joined');
const credentials = client => ({ roomId: joined(client).roomId, playerId: joined(client).playerId, resumeToken: joined(client).resumeToken });
async function request(client, type, fields = {}) {
  const before = client.messages.length;
  send(client, type, fields);
  await waitFor(() => client.messages.slice(before).some(m => ['joined', 'error', 'pong'].includes(m.type)));
  return client.messages.slice(before).find(m => ['joined', 'error', 'pong'].includes(m.type));
}
const fastWallClock = `const now = Date.now.bind(Date); const origin = now(); Date.now = () => origin + (now() - origin) * 100;`;

async function gatedProvider(t) {
  const control = { hold: false, pending: [], requests: [] };
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    control.requests.push({ path: req.url, body: body ? JSON.parse(body) : null });
    const reply = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(req.url === '/auth/v1/user' ? JSON.stringify({ id: req.headers.authorization.slice(7), user_metadata: {} }) : '[]'); };
    if (control.hold && req.url === '/auth/v1/user') control.pending.push(reply); else reply();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { for (const reply of control.pending.splice(0)) reply(); server.closeAllConnections(); server.close(); });
  return { ...control, get hold() { return control.hold; }, set hold(value) { control.hold = value; }, release: () => { for (const reply of control.pending.splice(0)) reply(); }, env: {
    SUPABASE_URL: `http://127.0.0.1:${server.address().port}`, SUPABASE_ANON_KEY: 'public-test', SUPABASE_SERVICE_ROLE_KEY: 'private-test'
  } };
}

test('recovery is opt-in and keeps a private 32-byte token off public state', async t => {
  const { join, connect, sendJoin } = await setup(t);
  const bad = await connect();
  for (const reconnect of [null, 1, 'true', {}, []]) assert.equal((await sendJoin(bad, { reconnect })).code, 'invalid_join');
  const legacy = await join({ roomId: 'legacy' });
  assert.equal(joined(legacy).resumeToken, undefined);
  const first = await join({ roomId: 'private', reconnect: true });
  assert.equal(Buffer.from(joined(first).resumeToken, 'base64url').length, 32);
  assert.equal(joined(first).reconnectGraceMs, 30000);
  assert.equal(JSON.stringify(first.state).includes(joined(first).resumeToken), false);
  assert.equal(first.state.players[0].connected, true);
  assert.equal(first.state.players[0].reconnectRemainingMs, 0);
  assert.deepEqual(await request(first, 'ping'), { type: 'pong' });
});

test('waiting reserves its slot and starts only when its original participant resumes', async t => {
  const { join, connect, sendJoin } = await setup(t);
  const first = await join({ roomId: 'waiting', reconnect: true, characterId: 'nori', skinId: 'mint' });
  await close(first);
  const second = await join({ roomId: 'waiting' });
  assert.equal(second.state.phase, 'waiting');
  const offline = second.state.players.find(p => p.id === first.playerId);
  assert.equal(offline.connected, false);
  assert.ok(offline.reconnectRemainingMs > 0 && offline.reconnectRemainingMs <= 30000);
  const intruder = await connect();
  assert.equal((await sendJoin(intruder, { roomId: 'waiting' })).code, 'room_unavailable');
  assert.equal((await request(intruder, 'resume', { ...credentials(first), resumeToken: 'a'.repeat(43) })).code, 'resume_unavailable');
  const resumed = await connect();
  const reply = await request(resumed, 'resume', credentials(first));
  assert.equal(reply.resumed, true); assert.equal(reply.playerId, first.playerId);
  assert.equal(reply.resumeToken, joined(first).resumeToken);
  await waitFor(() => resumed.state?.phase === 'playing');
  assert.equal(resumed.state.players.find(p => p.id === first.playerId).skinId, 'mint');
  assert.equal(resumed.state.players.find(p => p.id === first.playerId).connected, true);
});

test('active takeover closes the former socket and preserves the match and combat state', async t => {
  const { join, connect } = await setup(t);
  const first = await join({ roomId: 'takeover', reconnect: true });
  const other = await join({ roomId: 'takeover' });
  send(first, 'input', { action: 'right' });
  await waitFor(() => other.state.players.find(p => p.id === first.playerId).x === 2);
  const matchId = other.state.matchId;
  const oldClosed = once(first.ws, 'close');
  const replacement = await connect();
  assert.equal((await request(replacement, 'resume', credentials(first))).resumed, true);
  assert.equal((await oldClosed)[0], 4001);
  await waitFor(() => replacement.state?.phase === 'playing');
  assert.equal(replacement.state.matchId, matchId);
  assert.equal(replacement.state.players.find(p => p.id === first.playerId).x, 2);
  send(replacement, 'input', { action: 'place_orb' });
  await waitFor(() => other.state.players.find(p => p.id === first.playerId).bombsPlaced === 1);
  assert.equal(other.state.players.length, 2);
});

test('verified resume requires the same Supabase user and never rewrites profiles', async t => {
  const auth = await provider(t);
  const { join, connect } = await setup(t, { ...auth.env, ALLOW_DEV_GUESTS: 'false' });
  const first = await join({ roomId: 'auth-resume', accessToken: 'alice', reconnect: true });
  await close(first);
  const attacker = await connect();
  assert.equal((await request(attacker, 'resume', { ...credentials(first), accessToken: 'bob' })).code, 'unauthorized');
  const resumed = await connect();
  assert.equal((await request(resumed, 'resume', { ...credentials(first), accessToken: 'alice' })).resumed, true);
  assert.equal(auth.requests.filter(r => r.path.startsWith('/rest/v1/profiles')).length, 1);
  assert.equal(auth.requests.filter(r => r.path === '/auth/v1/user').length, 3);
});

test('grace expiry finishes the original duel exactly once and invalidates the token', async t => {
  const auth = await provider(t);
  const { join, connect } = await setup(t, { ...auth.env, ALLOW_DEV_GUESTS: 'false' }, { preload: fastWallClock });
  const first = await join({ roomId: 'expire', accessToken: 'alice', reconnect: true });
  const second = await join({ roomId: 'expire', accessToken: 'bob' });
  const matchId = second.state.matchId;
  await close(first);
  await waitFor(() => second.state.players.some(p => p.id === first.playerId && p.connected === false));
  assert.equal(second.state.phase, 'playing');
  await waitFor(() => second.state.phase === 'finished');
  assert.equal(second.state.result.winnerId, 'bob');
  assert.equal(second.state.matchId, matchId);
  assert.equal(second.state.result.scoreboard.length, 2);
  const retry = await connect();
  assert.equal((await request(retry, 'resume', { ...credentials(first), accessToken: 'alice' })).code, 'resume_unavailable');
  await waitFor(() => auth.requests.some(r => r.path === '/rest/v1/rpc/record_match'));
  assert.equal(auth.requests.filter(r => r.path === '/rest/v1/rpc/record_match').length, 1);
});

test('explicit leave releases an opted-in player immediately and revokes recovery', async t => {
  const { join, connect } = await setup(t);
  const first = await join({ roomId: 'leave', reconnect: true });
  const second = await join({ roomId: 'leave' });
  send(first, 'leave');
  await waitFor(() => second.state.phase === 'finished');
  assert.equal(second.state.players.length, 1);
  const retry = await connect();
  assert.equal((await request(retry, 'resume', credentials(first))).code, 'resume_unavailable');
});

test('practice recovery retains its private room, bots and capacity until expiry', async t => {
  const { join, connect } = await setup(t, {}, { preload: fastWallClock });
  const first = await join({ practice: true, reconnect: true, ruleSet: 'relay' });
  const ids = first.state.players.map(p => p.id);
  await close(first);
  const resumed = await connect();
  assert.equal((await request(resumed, 'resume', credentials(first))).resumed, true);
  await waitFor(() => resumed.state);
  assert.deepEqual(resumed.state.players.map(p => p.id), ids);
  await close(resumed);
  await new Promise(resolve => setTimeout(resolve, 500));
  const expired = await connect();
  assert.equal((await request(expired, 'resume', credentials(first))).code, 'resume_unavailable');
});

test('offline relay participants cannot acquire or deliver the dropped star', () => {
  const room = { ruleSet: 'relay', mode: 'team', tick: 0, players: new Map(), solid: new Set(), soft: new Set(), orbs: new Map(), waves: [] };
  initializeRelay(room);
  const player = { id: 'offline', slot: 0, team: 'blue', x: 6, y: 5, alive: true, bubbleTicks: 0, connected: false };
  room.players.set(player.id, player);
  stepRelay(room);
  assert.equal(room.relay.carrierId, null);
  room.relay.carrierId = player.id; room.relay.star = null; player.x = 1;
  stepRelay(room);
  assert.equal(room.relay.carrierId, null);
  assert.equal(room.relay.scores.blue, 0);
});

test('malformed non-ASCII tokens are rejected without terminating the server', async t => {
  const { join, connect } = await setup(t);
  const first = await join({ roomId: 'malformed', reconnect: true });
  const retry = await connect();
  for (const resumeToken of ['é'.repeat(43), 'a'.repeat(42), null, {}, 'a'.repeat(44)]) {
    assert.equal((await request(retry, 'resume', { ...credentials(first), resumeToken })).code, 'resume_unavailable');
  }
  assert.deepEqual(await request(first, 'ping'), { type: 'pong' });
});

test('a delayed authenticated resume cannot steal a session already resumed elsewhere', async t => {
  const auth = await gatedProvider(t);
  const { join, connect } = await setup(t, { ...auth.env, ALLOW_DEV_GUESTS: 'false' });
  const first = await join({ roomId: 'race', reconnect: true, accessToken: 'alice' });
  auth.hold = true;
  const delayed = await connect();
  const pending = request(delayed, 'resume', { ...credentials(first), accessToken: 'alice' });
  await waitFor(() => auth.pending.length === 1);
  auth.hold = false;
  const winner = await connect();
  assert.equal((await request(winner, 'resume', { ...credentials(first), accessToken: 'alice' })).resumed, true);
  auth.release();
  assert.equal((await pending).code, 'resume_unavailable');
  assert.deepEqual(await request(winner, 'ping'), { type: 'pong' });
  assert.equal(auth.requests.filter(r => r.path.startsWith('/rest/v1/profiles')).length, 1);
});

test('expiry during authentication cannot restore a released reservation', async t => {
  const auth = await gatedProvider(t);
  const { join, connect } = await setup(t, { ...auth.env, ALLOW_DEV_GUESTS: 'false' }, { preload: fastWallClock });
  const first = await join({ roomId: 'expire-auth', reconnect: true, accessToken: 'alice' });
  await close(first);
  auth.hold = true;
  const retry = await connect();
  const pending = request(retry, 'resume', { ...credentials(first), accessToken: 'alice' });
  await waitFor(() => auth.pending.length === 1);
  await new Promise(resolve => setTimeout(resolve, 500));
  auth.release();
  assert.equal((await pending).code, 'resume_unavailable');
  auth.hold = false;
  const replacement = await join({ roomId: 'expire-auth', accessToken: 'alice' });
  assert.notEqual(replacement.playerId, first.playerId);
});

test('a resume candidate that closes during authentication does not replace its active owner', async t => {
  const auth = await gatedProvider(t);
  const { join, connect } = await setup(t, { ...auth.env, ALLOW_DEV_GUESTS: 'false' });
  const first = await join({ roomId: 'closed-auth', reconnect: true, accessToken: 'alice' });
  auth.hold = true;
  const retry = await connect();
  send(retry, 'resume', { ...credentials(first), accessToken: 'alice' });
  await waitFor(() => auth.pending.length === 1);
  await close(retry);
  auth.release();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(await request(first, 'ping'), { type: 'pong' });
  assert.equal(first.ws.readyState, WebSocket.OPEN);
});

test('finished recovery preserves results, blocks rematch until return and clears the old ready vote', async t => {
  const auth = await provider(t);
  const { join, connect } = await setup(t, { ...auth.env, ALLOW_DEV_GUESTS: 'false' }, { tickMs: 1 });
  const first = await join({ roomId: 'finished', reconnect: true, accessToken: 'alice' });
  const second = await join({ roomId: 'finished', accessToken: 'bob' });
  await waitFor(() => second.state.phase === 'finished');
  const matchId = second.state.matchId, result = structuredClone(second.state.result);
  send(first, 'rematch');
  await waitFor(() => second.state.rematch.readyPlayerIds.includes(first.playerId));
  await close(first);
  send(second, 'rematch');
  await waitFor(() => second.state.players.some(p => p.id === first.playerId && !p.connected) &&
    second.state.rematch.readyPlayerIds.includes(second.playerId));
  assert.equal(second.state.phase, 'finished');
  assert.deepEqual(second.state.rematch, { readyPlayerIds: [second.playerId], total: 2 });
  const resumed = await connect();
  assert.equal((await request(resumed, 'resume', { ...credentials(first), accessToken: 'alice' })).resumed, true);
  await waitFor(() => resumed.state);
  assert.deepEqual(resumed.state.result, result);
  assert.equal(resumed.state.matchId, matchId);
  assert.equal(resumed.state.rematch.readyPlayerIds.includes(first.playerId), false);
  send(resumed, 'rematch');
  await waitFor(() => resumed.state.round === 1);
  assert.equal(resumed.state.phase, 'playing');
  assert.notEqual(resumed.state.matchId, matchId);
  await waitFor(() => auth.requests.some(r => r.path === '/rest/v1/rpc/record_match'));
  assert.equal(auth.requests.filter(r => r.path === '/rest/v1/rpc/record_match').length, 1);
  assert.equal(JSON.stringify(auth.requests).includes(joined(first).resumeToken), false);
});

test('finished reservation expiry reevaluates the remaining ready votes', async t => {
  const { join } = await setup(t, {}, { tickMs: 1, preload: fastWallClock });
  const first = await join({ roomId: 'finished-expiry', reconnect: true });
  const second = await join({ roomId: 'finished-expiry' });
  await waitFor(() => second.state.phase === 'finished');
  await close(first); send(second, 'rematch');
  await waitFor(() => second.state.players.some(p => p.id === first.playerId && !p.connected));
  assert.equal(second.state.phase, 'finished');
  await waitFor(() => second.state.phase === 'waiting');
  assert.deepEqual(second.state.players.map(p => p.id), [second.playerId]);
  assert.equal(second.state.round, 1);
});

test('practice capacity preserves offline reservations and explicit leave frees one immediately', async t => {
  const { join, connect, sendJoin } = await setup(t);
  const owners = [];
  for (let i = 0; i < 8; i++) owners.push(await join({ practice: true, reconnect: true }));
  await close(owners[0]);
  const extra = await connect();
  assert.equal((await sendJoin(extra, { practice: true })).code, 'practice_unavailable');
  send(owners[1], 'leave'); await once(owners[1].ws, 'close');
  assert.equal((await sendJoin(extra, { practice: true })).type, 'joined');
  const retry = await connect();
  assert.equal((await request(retry, 'resume', credentials(owners[0]))).resumed, true);
});

test('native heartbeat detects a silent peer and starts its recoverable grace', async t => {
  const preload = `const interval = globalThis.setInterval; globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 5000 ? 80 : ms, ...args);`;
  const { join, port } = await setup(t, {}, { preload });
  const observer = await join({ roomId: 'heartbeat', mode: 'team' });
  const silent = new WebSocket(`ws://127.0.0.1:${port}`, { autoPong: false });
  t.after(() => silent.terminate());
  await once(silent, 'open');
  const messages = []; silent.on('message', raw => messages.push(JSON.parse(raw)));
  silent.send(JSON.stringify({ type: 'join', roomId: 'heartbeat', mode: 'team', reconnect: true }));
  await waitFor(() => messages.some(m => m.type === 'joined'));
  const id = messages.find(m => m.type === 'joined').playerId;
  await waitFor(() => observer.state.players.some(p => p.id === id && p.connected === false));
  assert.equal(silent.readyState, WebSocket.CLOSED);
  assert.ok(observer.state.players.find(p => p.id === id).reconnectRemainingMs > 0);
  assert.equal(observer.ws.readyState, WebSocket.OPEN);
});

test('waiting peers receive a decreasing reservation countdown before expiry or resume', async t => {
  const { join } = await setup(t);
  const first = await join({ roomId: 'waiting-countdown', mode: 'team', reconnect: true });
  const observer = await join({ roomId: 'waiting-countdown', mode: 'team' });
  await close(first);
  const offline = () => observer.state.players.find(p => p.id === first.playerId);
  await waitFor(() => offline()?.connected === false);
  const remaining = offline().reconnectRemainingMs;
  assert.equal(observer.state.phase, 'waiting');
  await waitFor(() => offline().reconnectRemainingMs < remaining - 500, 1600);
  assert.equal(observer.state.phase, 'waiting');
  assert.ok(offline().reconnectRemainingMs > 0);
});
