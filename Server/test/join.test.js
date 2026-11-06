import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createResultDirectory, stopResultServer } from './fixtures/result-directory.mjs';

async function setup(t) {
  const outboxDirectory = await createResultDirectory();
  const auth = createServer((req, res) => {
    if (req.url === '/auth/v1/user') {
      setTimeout(() => {
        if (['Bearer valid', 'Bearer private', 'Bearer same'].includes(req.headers.authorization)) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: req.headers.authorization === 'Bearer same' ? 'same-user' : crypto.randomUUID(), user_metadata: {} }));
        } else { res.writeHead(401); res.end(); }
      }, 80);
    } else { res.writeHead(201); res.end(); }
  });
  auth.listen(0, '127.0.0.1'); await once(auth, 'listening');
  const temp = createServer(); temp.listen(0, '127.0.0.1'); await once(temp, 'listening');
  const port = temp.address().port; await new Promise(resolve => temp.close(resolve));
  const proc = spawn(process.execPath, ['src/index.js'], { env: { ...process.env, RUNTIME_DRAIN_MS: '20', PORT: String(port), RESULT_OUTBOX_DIR: outboxDirectory, SUPABASE_URL: `http://127.0.0.1:${auth.address().port}`, SUPABASE_ANON_KEY: 'public', SUPABASE_SERVICE_ROLE_KEY: 'private', ALLOW_DEV_GUESTS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { auth.closeAllConnections(); auth.close(); await stopResultServer(proc, outboxDirectory); });
  await Promise.race([once(proc.stdout, 'data'), once(proc, 'exit').then(() => { throw Error('server exited'); })]);
  async function client() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`); await once(ws, 'open');
    const messages = []; ws.on('message', data => messages.push(JSON.parse(data)));
    t.after(() => ws.terminate()); return { ws, messages };
  }
  async function waitFor(predicate) { const deadline = Date.now() + 2000; while (!predicate()) { if (Date.now() > deadline) throw Error('timed out waiting for response'); await new Promise(r => setTimeout(r, 10)); } }
  return { client, waitFor, proc };
}

test('concurrent authenticated joins cannot overfill a room', async t => {
  const { client, waitFor } = await setup(t);
  const clients = await Promise.all([client(), client(), client()]);
  for (const { ws } of clients) ws.send(JSON.stringify({ type: 'join', roomId: 'race', accessToken: 'valid' }));
  await waitFor(() => clients.every(c => c.messages.some(m => m.type === 'joined' || m.type === 'error')));
  assert.equal(clients.filter(c => c.messages.some(m => m.type === 'joined')).length, 2);
  assert.equal(clients.filter(c => c.messages.some(m => m.code === 'room_unavailable')).length, 1);
});

test('a socket cannot join repeatedly while authentication is pending', async t => {
  const { client, waitFor } = await setup(t); const c = await client();
  const msg = JSON.stringify({ type: 'join', roomId: 'twice', accessToken: 'valid' }); c.ws.send(msg); c.ws.send(msg);
  await waitFor(() => c.messages.some(m => m.type === 'joined'));
  await new Promise(r => setTimeout(r, 150));
  assert.equal(c.messages.filter(m => m.type === 'joined').length, 1);
  assert.ok(c.messages.every(m => m.type !== 'state' || m.players.length <= 1));
});

test('invalid JSON values and rejected authentication do not crash the server', async t => {
  const { client, waitFor, proc } = await setup(t); const c = await client();
  c.ws.send('null');
  await waitFor(() => c.messages.some(m => m.type === 'error'));
  c.ws.send(JSON.stringify({ type: 'join', accessToken: 'bad' }));
  await waitFor(() => c.messages.some(m => m.code === 'unauthorized'));
  assert.equal(proc.exitCode, null);
});

 test('a missing access token cannot authenticate as the server service role', async t => {
  const { client, waitFor } = await setup(t); const c = await client();
  c.ws.send(JSON.stringify({ type: 'join', roomId: 'missing-token' }));
  await waitFor(() => c.messages.some(m => m.type === 'joined' || m.type === 'error'));
  assert.equal(c.messages.some(m => m.type === 'joined'), false);
  assert.ok(c.messages.some(m => m.code === 'unauthorized'));
});

test('team room admits eight players into balanced teams and rejects a ninth', async t => {
  const { client, waitFor } = await setup(t);
  const clients = await Promise.all(Array.from({ length: 9 }, () => client()));
  for (const { ws } of clients) ws.send(JSON.stringify({ type: 'join', roomId: 'team', mode: 'team', accessToken: 'valid' }));
  await waitFor(() => clients.every(c => c.messages.some(m => m.type === 'joined' || m.type === 'error')));
  const joined = clients.filter(c => c.messages.some(m => m.type === 'joined'));
  assert.equal(joined.length, 8);
  assert.equal(clients.filter(c => c.messages.some(m => m.code === 'room_unavailable')).length, 1);
  await waitFor(() => joined[0].messages.some(m => m.type === 'state' && m.phase === 'playing'));
  const state = joined[0].messages.find(m => m.type === 'state' && m.phase === 'playing');
  assert.equal(state.mode, 'team');
  assert.equal(state.players.filter(p => p.team === 'blue').length, 4);
  assert.equal(state.players.filter(p => p.team === 'pink').length, 4);
  assert.equal(new Set(state.players.map(p => `${p.x},${p.y}`)).size, 8);
  assert.ok(state.players.every(p => !state.soft.includes(`${p.x},${p.y}`)));
});

test('team disconnect eliminates only that player and last surviving team wins', async t => {
  const { client, waitFor } = await setup(t);
  const clients = await Promise.all(Array.from({ length: 8 }, () => client()));
  for (const { ws } of clients) ws.send(JSON.stringify({ type: 'join', roomId: 'team-disconnect', mode: 'team', accessToken: 'valid' }));
  await waitFor(() => clients.every(c => c.messages.some(m => m.type === 'joined')));
  await waitFor(() => clients[0].messages.some(m => m.type === 'state' && m.phase === 'playing'));
  const state = clients[0].messages.find(m => m.type === 'state' && m.phase === 'playing');
  const byId = new Map(clients.map(c => [c.messages.find(m => m.type === 'joined').playerId, c]));
  const blue = state.players.filter(p => p.team === 'blue').map(p => byId.get(p.id));
  const pink = byId.get(state.players.find(p => p.team === 'pink').id);
  blue[0].ws.close();
  await waitFor(() => pink.messages.some(m => m.type === 'state' && m.phase === 'playing' && m.players.length === 7));
  for (const c of blue.slice(1)) c.ws.close();
  await waitFor(() => pink.messages.some(m => m.type === 'state' && m.phase === 'finished'));
  assert.equal(pink.messages.findLast(m => m.type === 'state').result.winnerTeam, 'pink');
});


test('team waiting room rejects duplicate identity and permits replacement after leave', async t => {
  const { client, waitFor } = await setup(t);
  const first = await client(); const duplicate = await client(); const replacement = await client();
  first.ws.send(JSON.stringify({ type: 'join', roomId: 'replacement', mode: 'team', accessToken: 'same' }));
  await waitFor(() => first.messages.some(m => m.type === 'joined'));
  duplicate.ws.send(JSON.stringify({ type: 'join', roomId: 'replacement', mode: 'team', accessToken: 'same' }));
  await waitFor(() => duplicate.messages.some(m => m.code === 'already_in_room'));
  first.ws.close();
  await once(first.ws, 'close');
  replacement.ws.send(JSON.stringify({ type: 'join', roomId: 'replacement', mode: 'team', accessToken: 'same' }));
  await waitFor(() => replacement.messages.some(m => m.type === 'joined' || m.type === 'error'));
  assert.ok(replacement.messages.some(m => m.type === 'joined'));
});

test('a room cannot be joined using a different mode', async t => {
  const { client, waitFor } = await setup(t);
  const first = await client(); const other = await client();
  first.ws.send(JSON.stringify({ type: 'join', roomId: 'mode', mode: 'team', accessToken: 'valid' }));
  await waitFor(() => first.messages.some(m => m.type === 'joined'));
  other.ws.send(JSON.stringify({ type: 'join', roomId: 'mode', mode: 'duel', accessToken: 'valid' }));
  await waitFor(() => other.messages.some(m => m.type === 'error'));
  assert.equal(other.messages.find(m => m.type === 'error').code, 'room_unavailable');
});

test('team players can rescue a teammate bubbled by an orb', async t => {
  const { client, waitFor } = await setup(t);
  const clients = [];
  for (let i = 0; i < 8; i++) {
    const c = await client(); clients.push(c);
    c.ws.send(JSON.stringify({ type: 'join', roomId: 'rescue', mode: 'team', accessToken: 'valid' }));
    await waitFor(() => c.messages.some(m => m.type === 'joined'));
  }
  const [rescuer, , ally] = clients;
  const id = c => c.messages.find(m => m.type === 'joined').playerId;
  const latest = () => rescuer.messages.findLast(m => m.type === 'state');
  const pos = c => latest()?.players.find(p => p.id === id(c));
  const input = (c, action) => c.ws.send(JSON.stringify({ type: 'input', action }));
  await waitFor(() => latest()?.phase === 'playing');
  input(rescuer, 'place_orb'); await waitFor(() => latest()?.orbs.length === 1);
  input(rescuer, 'right'); await waitFor(() => pos(rescuer)?.x === 2);
  input(rescuer, 'right'); await waitFor(() => pos(rescuer)?.x === 3);
  input(rescuer, 'up'); await waitFor(() => pos(rescuer)?.y === 2);
  input(ally, 'down'); await waitFor(() => pos(ally)?.y === 2);
  const deadline = Date.now() + 3500;
  while (!(pos(ally)?.bubbleTicks > 0)) {
    if (Date.now() > deadline) throw Error('ally did not get bubbled');
    await new Promise(r => setTimeout(r, 10));
  }
  await waitFor(() => latest().waves.length === 0);
  input(rescuer, 'down'); await waitFor(() => pos(rescuer)?.y === 1);
  input(rescuer, 'left'); await waitFor(() => pos(rescuer)?.x === 2);
  input(rescuer, 'left'); await waitFor(() => pos(rescuer)?.x === 1);
  assert.equal(pos(ally).bubbleTicks, 0);
  assert.equal(pos(ally).alive, true);
});
