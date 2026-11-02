import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';

async function waitFor(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw Error('Timed out waiting for practice server');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function provider(t) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url, method: req.method });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url === '/auth/v1/user' ? JSON.stringify({ id: 'verified-human', user_metadata: {} }) : '[]');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { requests, env: { SUPABASE_URL: `http://127.0.0.1:${server.address().port}`, SUPABASE_ANON_KEY: 'public-test', SUPABASE_SERVICE_ROLE_KEY: 'private-test' } };
}

async function setup(t, environment = {}, { fastClock = false, preload = '' } = {}) {
  // Only the child test process accelerates timers; production keeps its real clock.
  const clockPreload = `
    const interval = globalThis.setInterval;
    globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 100 ? 1 : ms, ...args);
    const timeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => {
      if (ms >= 60000) { process.send({ type: 'expiry', milliseconds: ms }); return timeout(fn, 30, ...args); }
      return timeout(fn, ms, ...args);
    };`;
  const preloads = [fastClock ? clockPreload : '', preload].filter(Boolean).join('\n');
  const args = preloads ? ['--import', `data:text/javascript,${encodeURIComponent(preloads)}`, 'src/index.js'] : ['src/index.js'];
  const proc = spawn(process.execPath, args, {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', ALLOW_DEV_GUESTS: 'false', SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '', ...environment },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  let output = '', errors = '';
  const events = [];
  proc.stdout.on('data', chunk => { output += chunk; });
  proc.stderr.on('data', chunk => { errors += chunk; });
  proc.on('message', message => events.push(message));
  t.after(() => proc.kill());
  await waitFor(() => /listening on 127\.0\.0\.1:(\d+)/.test(output) || proc.exitCode !== null);
  assert.equal(proc.exitCode, null, errors);
  const port = Number(output.match(/listening on 127\.0\.0\.1:(\d+)/)[1]);
  async function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const client = { ws, messages: [], playerId: null, state: null };
    ws.on('message', raw => {
      const message = JSON.parse(raw);
      client.messages.push(message);
      if (message.type === 'joined') client.playerId = message.playerId;
      if (message.type === 'state') client.state = message;
    });
    await once(ws, 'open');
    t.after(() => ws.terminate());
    return client;
  }
  async function sendJoin(client, fields) {
    const before = client.messages.length;
    client.ws.send(JSON.stringify({ type: 'join', ...fields }));
    await waitFor(() => client.messages.slice(before).some(m => m.type === 'joined' || m.type === 'error'));
    return client.messages.slice(before).find(m => m.type === 'joined' || m.type === 'error');
  }
  async function join(fields = {}) {
    const client = await connect();
    const reply = await sendJoin(client, { practice: true, ...fields });
    assert.equal(reply.type, 'joined', JSON.stringify(reply));
    await waitFor(() => client.state);
    return client;
  }
  return { connect, sendJoin, join, events, proc, errors: () => errors };
}

test('production with guests disabled starts one human and seven balanced bots without Supabase', async t => {
  const { join } = await setup(t);
  const client = await join({ mode: 'duel', name: 'Learner', mapId: 'lagoon', characterId: 'nori', skinId: 'mint', itemMode: false });
  const state = client.state;
  assert.equal(state.practice, true);
  assert.equal(state.mode, 'team');
  assert.equal(state.phase, 'playing');
  assert.equal(state.mapId, 'lagoon');
  assert.equal(state.itemMode, false);
  assert.equal(state.players.length, 8);
  assert.equal(state.players.filter(p => p.isBot).length, 7);
  assert.equal(state.players.filter(p => p.team === 'blue').length, 4);
  assert.equal(state.players.filter(p => p.team === 'pink').length, 4);
  assert.equal(new Set(state.players.map(p => `${p.x},${p.y}`)).size, 8);
  const human = state.players.find(p => p.id === client.playerId);
  assert.equal(human.name, 'Learner');
  assert.equal(human.isBot, false);
  assert.equal(human.characterId, 'nori');
  assert.equal(human.skinId, 'mint');
  assert.ok(state.players.every(p => p.bombsPlaced === 0 && p.itemsCollected === 0 && p.rescues === 0));
});

test('practice bypasses provider calls while omitted and false practice retain production authentication', async t => {
  const backend = await provider(t);
  const { join, connect, sendJoin } = await setup(t, backend.env);
  await join({ accessToken: 'valid-but-not-used' });
  assert.deepEqual(backend.requests, []);
  for (const fields of [{}, { practice: false }]) {
    const reply = await sendJoin(await connect(), fields);
    assert.equal(reply.code, 'unauthorized');
  }
  const human = await connect();
  assert.equal((await sendJoin(human, { practice: false, mode: null, accessToken: 'valid', roomId: 'people' })).type, 'joined');
  await waitFor(() => human.state);
  assert.equal(human.state.practice, false);
  assert.equal(human.state.players.length, 1);
  assert.equal(human.state.players[0].isBot, false);
  assert.deepEqual(backend.requests.map(r => r.path), ['/auth/v1/user', '/rest/v1/profiles?on_conflict=id']);
});

test('malformed practice flags are rejected before auth and leave the socket usable', async t => {
  const backend = await provider(t);
  const { connect, sendJoin } = await setup(t, backend.env);
  const client = await connect();
  for (const practice of [null, 1, 'true', {}, []]) {
    assert.equal((await sendJoin(client, { practice, accessToken: 'valid' })).code, 'invalid_join');
  }
  assert.deepEqual(backend.requests, []);
  for (const fields of [{ characterId: 'missing' }, { mapId: 'missing' }, { itemMode: 'false' }, { mode: 'missing' }]) {
    const reply = await sendJoin(client, { practice: true, ...fields });
    assert.equal(reply.type, 'error');
  }
  assert.equal((await sendJoin(client, { practice: true })).type, 'joined');
  assert.deepEqual(backend.requests, []);
});

test('practice rooms are unique and cannot be joined by a normal authenticated player', async t => {
  const backend = await provider(t);
  const { join, connect, sendJoin } = await setup(t, backend.env);
  const first = await join({ roomId: 'requested-room' });
  const second = await join({ roomId: first.state.roomId });
  assert.notEqual(first.state.roomId, 'requested-room');
  assert.notEqual(second.state.roomId, first.state.roomId);
  const outsider = await connect();
  assert.equal((await sendJoin(outsider, { roomId: first.state.roomId, mode: 'team', accessToken: 'valid' })).code, 'room_unavailable');
  assert.equal(first.state.players.length, 8);
});

test('eight concurrent practice rooms fill capacity and owner disconnect immediately releases it', async t => {
  const { connect, sendJoin, join } = await setup(t);
  const owners = await Promise.all(Array.from({ length: 8 }, () => join({ roomId: 'shared-request' })));
  assert.equal(new Set(owners.map(c => c.state.roomId)).size, 8);
  const extra = await connect();
  assert.equal((await sendJoin(extra, { practice: true })).code, 'practice_unavailable');
  owners[0].ws.close(); await once(owners[0].ws, 'close');
  const reply = await sendJoin(extra, { practice: true });
  assert.equal(reply.type, 'joined', JSON.stringify(reply));
});


test('replay reclaims a closing owner before its delayed close event without exceeding eight rooms', async t => {
  // Hold only ws's final notification: the real close frame/response and socket
  // shutdown still occur. This fixes the event ordering without timing sleeps.
  const deferClose = `
    const { default: WebSocket } = await import(${JSON.stringify(new URL('../node_modules/ws/wrapper.mjs', import.meta.url).href)});
    const emitClose = WebSocket.prototype.emitClose;
    const pending = [];
    WebSocket.prototype.emitClose = function(...args) {
      if (!this._isServer) return emitClose.apply(this, args);
      pending.push(() => emitClose.apply(this, args));
      process.send({ type: 'pending-close', state: this.readyState });
    };
    process.on('message', message => {
      if (message.type !== 'release-close') return;
      for (const close of pending.splice(0)) close();
      process.send({ type: 'close-released' });
    });`;
  const { connect, sendJoin, join, proc, events } = await setup(t, {}, { preload: deferClose });
  const owners = await Promise.all(Array.from({ length: 8 }, () => join()));
  const replay = await connect();
  const overflow = await connect();
  assert.equal((await sendJoin(replay, { practice: true })).code, 'practice_unavailable');
  owners[0].ws.close(); await once(owners[0].ws, 'close');
  await waitFor(() => events.some(event => event.type === 'pending-close'));
  assert.equal(events.find(event => event.type === 'pending-close').state, WebSocket.CLOSING);
  const reply = await sendJoin(replay, { practice: true });
  assert.equal(reply.type, 'joined', JSON.stringify(reply));
  assert.equal((await sendJoin(overflow, { practice: true })).code, 'practice_unavailable');
  proc.send({ type: 'release-close' });
  await waitFor(() => events.some(event => event.type === 'close-released'));
  // Delayed cleanup of the former owner must not remove the replacement.
  assert.equal((await sendJoin(overflow, { practice: true })).code, 'practice_unavailable');
  replay.ws.send(JSON.stringify({ type: 'input', action: 'right' }));
  await waitFor(() => replay.state?.players.find(player => player.id === replay.playerId)?.x === 2);
});

test('bots act through real combat on every map and item mode without server exceptions', async t => {
  const { join, proc, errors } = await setup(t);
  const clients = [];
  for (const mapId of ['garden', 'lagoon', 'candy']) {
    for (const itemMode of [false, true]) clients.push(await join({ mapId, itemMode }));
  }
  const starts = clients.map(c => new Map(c.state.players.map(p => [p.id, `${p.x},${p.y}`])));
  await waitFor(() => clients.every((c, i) => c.state.players.some(p => p.isBot && `${p.x},${p.y}` !== starts[i].get(p.id)) && c.state.players.some(p => p.isBot && p.bombsPlaced > 0)), 8000);
  for (const client of clients.filter(c => !c.state.itemMode)) {
    assert.equal(client.state.items.length, 0);
    assert.ok(client.state.players.every(p => p.itemsCollected === 0 && p.darts === 0));
  }
  assert.equal(proc.exitCode, null);
  assert.equal(errors(), '');
});

test('accepted orb placements count once while duplicate and capacity-blocked requests do not', async t => {
  const { join } = await setup(t, { ALLOW_DEV_GUESTS: 'true' });
  const first = await join({ practice: false, mode: 'duel', roomId: 'counter' });
  await join({ practice: false, mode: 'duel', roomId: 'counter' });
  await waitFor(() => first.state.phase === 'playing');
  const human = () => first.state.players.find(p => p.id === first.playerId);
  const input = action => first.ws.send(JSON.stringify({ type: 'input', action }));
  input('place_orb'); input('place_orb');
  await waitFor(() => first.state.orbs.length === 1);
  assert.equal(human().bombsPlaced, 1);
  input('place_orb'); input('right');
  await waitFor(() => human().x === 2);
  input('place_orb');
  const tick = first.state.tick;
  await waitFor(() => first.state.tick > tick);
  assert.equal(human().bombsPlaced, 1);
  assert.equal(first.state.orbs.length, 1);
});

test('finished practice expires its owner socket after 120 seconds and releases capacity', async t => {
  const backend = await provider(t);
  const { join, connect, sendJoin, events, errors } = await setup(t, backend.env, { fastClock: true });
  const owner = await join({ accessToken: 'valid-but-unused' });
  await waitFor(() => owner.messages.some(m => m.type === 'state' && m.phase === 'finished'), 5000);
  const result = owner.messages.find(m => m.type === 'state' && m.phase === 'finished').result;
  assert.equal(result.scoreboard.length, 8);
  assert.ok(result.scoreboard.every(row => Number.isInteger(row.rescues)));
  await waitFor(() => owner.ws.readyState === WebSocket.CLOSED);
  assert.deepEqual(events, [{ type: 'expiry', milliseconds: 120000 }]);
  assert.deepEqual(backend.requests, []);
  // After expiry, all eight slots can be allocated again.
  const next = await Promise.all(Array.from({ length: 8 }, () => connect()));
  const replies = await Promise.all(next.map(c => sendJoin(c, { practice: true })));
  assert.ok(replies.every(r => r.type === 'joined'));
  assert.equal(errors(), '');
});

test('finalization ignores practice for both demo and production ranking storage', async t => {
  const backend = await provider(t);
  const saved = Object.fromEntries(Object.keys(backend.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, backend.env);
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const { finalizeMatch, getLeaderboard } = await import('../src/rankings.js');
  const room = { practice: true, id: 'private', matchId: 'private-match', result: { winnerTeam: 'blue' }, roster: [{ userId: 'verified-human', name: 'PracticeOnly', team: 'blue', score: 500 }] };
  await finalizeMatch(room, { ALLOW_DEV_GUESTS: 'true' });
  assert.equal((await getLeaderboard({ ALLOW_DEV_GUESTS: 'true' })).entries.length, 0);
  await finalizeMatch(room, { ALLOW_DEV_GUESTS: 'false' });
  assert.deepEqual(backend.requests, []);
  await assert.doesNotReject(finalizeMatch({ practice: true }, { ALLOW_DEV_GUESTS: 'false' }));
});
