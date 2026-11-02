import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';

async function setup(t, environment = {}) {
  const portServer = createServer();
  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const proc = spawn(process.execPath, ['src/index.js'], {
    env: { ...process.env, PORT: String(port), ALLOW_DEV_GUESTS: 'true', SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '', ...environment },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => proc.kill());
  await Promise.race([once(proc.stdout, 'data'), once(proc, 'exit').then(() => { throw Error('server exited'); })]);
  const waitFor = async predicate => {
    const deadline = Date.now() + 2500;
    while (!predicate()) {
      if (Date.now() >= deadline) throw Error('Timed out waiting for game state');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  async function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(ws, 'open');
    const client = { ws, playerId: null, state: null, messages: [] };
    ws.on('message', data => {
      const message = JSON.parse(data);
      client.messages.push(message);
      if (message.type === 'joined') client.playerId = message.playerId;
      if (message.type === 'state') client.state = message;
    });
    t.after(() => ws.terminate());
    return client;
  }
  async function join() {
    const client = await connect();
    client.ws.send(JSON.stringify({ type: 'join', mode: 'duel', roomId: 'gameplay' }));
    await waitFor(() => client.playerId && client.state);
    return client;
  }
  const input = (client, action) => client.ws.send(JSON.stringify({ type: 'input', action }));
  return { join, connect, input, waitFor, proc };
}

test('bomb placement and movement in the same tick both execute, with bomb at the old cell', async t => {
  const { join, input, waitFor } = await setup(t);
  const first = await join();
  await join();
  await waitFor(() => first.state?.tick >= 1);
  const tick = first.state.tick;
  input(first, 'place_orb');
  input(first, 'right');
  await waitFor(() => first.state.tick > tick);
  const player = first.state.players.find(p => p.id === first.playerId);
  assert.equal(player.x, 2);
  assert.equal(player.y, 1);
  assert.ok(first.state.orbs.some(orb => orb.x === 1 && orb.y === 1), 'movement must not overwrite a bomb press');
});

test('inputs submitted while waiting are not replayed when the match starts', async t => {
  const { join, input, waitFor } = await setup(t);
  const first = await join();
  assert.equal(first.state.phase, 'waiting');
  input(first, 'place_orb');
  await join();
  await waitFor(() => first.state?.tick >= 1);
  assert.equal(first.state.orbs.length, 0, 'lobby inputs must not place a bomb at match start');
});


test('malformed join fields are rejected before authentication without terminating the server', async t => {
  let authCalls = 0;
  const auth = createServer((_req, res) => {
    authCalls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'verified-user', user_metadata: {} }));
  });
  auth.listen(0, '127.0.0.1'); await once(auth, 'listening');
  t.after(() => auth.close());
  const { connect, waitFor, proc } = await setup(t, {
    SUPABASE_URL: `http://127.0.0.1:${auth.address().port}`, SUPABASE_ANON_KEY: 'public', ALLOW_DEV_GUESTS: 'false'
  });
  const client = await connect();
  for (const fields of [
    { roomId: { toString: 0 } }, { roomId: [] }, { roomId: null }, { roomId: 42 },
    { roomId: 'x'.repeat(65) }, { name: { toString: 0 } }, { name: null }, { name: 'x'.repeat(13) }
  ]) {
    const before = client.messages.length;
    client.ws.send(JSON.stringify({ type: 'join', accessToken: 'valid', ...fields }));
    await waitFor(() => client.messages.length > before || proc.exitCode !== null);
    assert.equal(proc.exitCode, null, 'malformed joins must not terminate the process');
    assert.equal(client.messages.at(-1)?.code, 'invalid_join');
  }
  assert.equal(authCalls, 0, 'known malformed input must not trigger external authentication');
  client.ws.send(JSON.stringify({ type: 'join', accessToken: 'valid', roomId: 'recovered', name: 'Popper' }));
  await waitFor(() => client.playerId);
  assert.equal(authCalls, 1);
});

test('an unexpected authenticated payload failure is contained and a new connection still works', async t => {
  let authCalls = 0;
  const auth = createServer((_req, res) => {
    authCalls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'verified-user', user_metadata: authCalls === 1 ? { nickname: { toString: 0 } } : {} }));
  });
  auth.listen(0, '127.0.0.1'); await once(auth, 'listening');
  t.after(() => auth.close());
  const { connect, waitFor, proc } = await setup(t, {
    SUPABASE_URL: `http://127.0.0.1:${auth.address().port}`, SUPABASE_ANON_KEY: 'public', ALLOW_DEV_GUESTS: 'false'
  });
  const client = await connect();
  client.ws.send(JSON.stringify({ type: 'join', accessToken: 'valid', roomId: 'unexpected' }));
  await waitFor(() => client.messages.some(message => message.type === 'error') || proc.exitCode !== null);
  assert.equal(proc.exitCode, null);
  assert.equal(client.messages.at(-1)?.code, 'internal_error');
  const healthy = await connect();
  healthy.ws.send(JSON.stringify({ type: 'join', accessToken: 'valid', roomId: 'healthy' }));
  await waitFor(() => healthy.playerId);
});
