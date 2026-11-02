import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';

export async function waitFor(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw Error('Timed out waiting for relay server');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

export async function provider(t, { holdResults = false } = {}) {
  const requests = [], pending = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, body: body ? JSON.parse(body) : null });
    if (holdResults && req.url === '/rest/v1/rpc/record_match') { pending.push(res); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url === '/auth/v1/user'
      ? JSON.stringify({ id: req.headers.authorization.slice('Bearer '.length), user_metadata: {} }) : '[]');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { requests, release: () => { for (const res of pending.splice(0)) res.end('[]'); }, env: {
    SUPABASE_URL: `http://127.0.0.1:${server.address().port}`, SUPABASE_ANON_KEY: 'public-test', SUPABASE_SERVICE_ROLE_KEY: 'private-test'
  } };
}

export async function setup(t, environment = {}, { tickMs = 100, preload = '' } = {}) {
  const clock = `const original = globalThis.setInterval; globalThis.setInterval = (fn, ms, ...args) => original(fn, ms === 100 ? ${tickMs} : ms, ...args);`;
  const proc = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(clock + '\n' + preload)}`, 'src/index.js'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', ALLOW_DEV_GUESTS: 'true', SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '', ...environment },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '', errors = '';
  proc.stdout.on('data', chunk => { output += chunk; });
  proc.stderr.on('data', chunk => { errors += chunk; });
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
    const reply = await sendJoin(client, fields);
    assert.equal(reply.type, 'joined', JSON.stringify(reply));
    await waitFor(() => client.state);
    return client;
  }
  return { connect, sendJoin, join, port, errors: () => errors };
}

export const send = (client, type, fields = {}) => client.ws.send(JSON.stringify({ type, ...fields }));
export async function close(client) { client.ws.close(); await once(client.ws, 'close'); }
