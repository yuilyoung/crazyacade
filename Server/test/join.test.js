import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';

async function setup(t) {
  const auth = createServer((req, res) => {
    if (req.url === '/auth/v1/user') {
      setTimeout(() => {
        if (['Bearer valid', 'Bearer private'].includes(req.headers.authorization)) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: crypto.randomUUID(), user_metadata: {} }));
        } else { res.writeHead(401); res.end(); }
      }, 80);
    } else { res.writeHead(201); res.end(); }
  });
  auth.listen(0, '127.0.0.1'); await once(auth, 'listening');
  const temp = createServer(); temp.listen(0, '127.0.0.1'); await once(temp, 'listening');
  const port = temp.address().port; await new Promise(resolve => temp.close(resolve));
  const proc = spawn(process.execPath, ['src/index.js'], { env: { ...process.env, PORT: String(port), SUPABASE_URL: `http://127.0.0.1:${auth.address().port}`, SUPABASE_ANON_KEY: 'public', SUPABASE_SERVICE_ROLE_KEY: 'private', ALLOW_DEV_GUESTS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { proc.kill(); auth.close(); });
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
