import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequestHandler } from '../src/http.js';

async function setup(t, env = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'arena-http-'));
  const publicRoot = path.join(directory, 'public');
  await mkdir(publicRoot);
  await writeFile(path.join(publicRoot, 'index.html'), '<!doctype html><h1>Pop Pop Arena</h1>');
  await writeFile(path.join(publicRoot, 'app.js'), 'console.log("arena");');
  await writeFile(path.join(publicRoot, 'style.css'), 'body { color: blue; }');
  await writeFile(path.join(publicRoot, '.env'), 'SECRET');
  await writeFile(path.join(directory, 'private.txt'), 'PRIVATE');
  await symlink(path.join(directory, 'private.txt'), path.join(publicRoot, 'escape.txt'));
  const server = createServer(createRequestHandler({ publicRoot, env }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  function get(requestPath, method = 'GET') {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.address().port, path: requestPath, method }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject); req.end();
    });
  }
  return get;
}

test('serves the browser entrypoint and assets with correct content types', async t => {
  const get = await setup(t);
  const page = await get('/');
  assert.equal(page.status, 200); assert.match(page.headers['content-type'], /text\/html/); assert.match(page.body, /Pop Pop Arena/);
  const script = await get('/app.js?v=1');
  assert.equal(script.status, 200); assert.match(script.headers['content-type'], /javascript/);
  assert.match((await get('/style.css')).headers['content-type'], /text\/css/);
  assert.equal((await get('/app.js', 'HEAD')).body, '');
  assert.equal((await get('/missing.js')).status, 404);
  assert.equal((await get('/', 'POST')).status, 405);
});

test('public configuration includes only public settings and development guest status', async t => {
  const get = await setup(t, { ALLOW_DEV_GUESTS: 'true', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'public-key', SUPABASE_SERVICE_ROLE_KEY: 'never-public' });
  const config = await get('/api/config');
  assert.deepEqual(JSON.parse(config.body), { allowDevGuests: true, supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'public-key' });
  assert.equal(config.body.includes('never-public'), false);
  assert.equal(config.headers['cache-control'], 'no-store');
  const health = await get('/health');
  assert.equal(health.status, 200); assert.deepEqual(JSON.parse(health.body), { status: 'ok' });
});

test('guest access is disabled unless explicitly enabled', async t => {
  const get = await setup(t);
  assert.deepEqual(JSON.parse((await get('/api/config')).body), { allowDevGuests: false, supabaseUrl: '', supabaseAnonKey: '' });
});

test('traversal, hidden paths and escaping symlinks never expose files outside public assets', async t => {
  const get = await setup(t);
  for (const path of ['/../private.txt', '/%2e%2e/private.txt', '/%2e%2e%2fprivate.txt', '/.env', '/escape.txt', '/src/supabase.js', '/%00', '/%ZZ']) {
    const response = await get(path);
    assert.ok(response.status >= 400 && response.status < 500, path);
    assert.doesNotMatch(response.body, /PRIVATE|SECRET/);
  }
});


test('one port hosts public configuration and WebSocket, and oversized input does not crash it', async t => {
  const proc = spawn(process.execPath, ['src/index.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', ALLOW_DEV_GUESTS: 'true', SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => proc.kill());
  const [output] = await once(proc.stdout, 'data');
  const port = /127\.0\.0\.1:(\d+)/.exec(output.toString())?.[1];
  assert.ok(port, 'server reports bound port after listening');
  const config = await fetch(`http://127.0.0.1:${port}/api/config`).then(r => r.json());
  assert.equal(config.allowDevGuests, true);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  t.after(() => ws.terminate()); await once(ws, 'open');
  const closed = once(ws, 'close');
  ws.send('a'.repeat(17 * 1024));
  const [code] = await closed;
  assert.equal(code, 1009);
  const health = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json());
  assert.equal(health.status, 'ok');
  assert.equal(proc.exitCode, null);
});
