import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { createRequestHandler } from '../src/http.js';
import { createRuntime } from '../src/runtime.js';

async function setup(t, runtimeDiagnostics) {
  const server = createServer(createRequestHandler({ runtimeDiagnostics, env: {} }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return (pathname, method = 'GET') => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path: pathname, method }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject); req.end();
  });
}

test('readiness becomes unavailable during drain while liveness remains healthy', async t => {
  const runtime = createRuntime(); t.after(() => runtime.close());
  const get = await setup(t, () => runtime.snapshot());
  const ready = await get('/health/ready');
  assert.equal(ready.status, 200); assert.deepEqual(JSON.parse(ready.body), { status: 'ready' });
  runtime.setDraining();
  const draining = await get('/health/ready');
  assert.equal(draining.status, 503); assert.deepEqual(JSON.parse(draining.body), { status: 'draining' });
  assert.equal((await get('/health')).status, 200);
  assert.equal(JSON.parse((await get('/health/runtime')).body).draining, true);
});

test('runtime diagnostics expose numeric allowlisted measurements without identifiers or provider details', async t => {
  const get = await setup(t, () => ({
    connections: 3, rooms: 2, queuedPlayers: 8, authActive: 4, authPending: 7, authRejected: 2,
    tickDurationMs: 2.5, tickLagMs: 4, rssBytes: 12345, uptimeSeconds: 1.25,
    messagesRejected: -1, sendErrors: Infinity, stateSkipped: 'TOKEN',
    accessToken: 'SECRET', roomId: 'ROOM', userId: 'USER', ip: '127.0.0.1',
    directory: '/private/outbox', providerBody: 'sensitive detail', arbitraryCount: 111
  }));
  const response = await get('/health/runtime');
  assert.equal(response.status, 200);
  const metrics = JSON.parse(response.body);
  assert.equal(metrics.connections, 3); assert.equal(metrics.rooms, 2); assert.equal(metrics.queuedPlayers, 8);
  assert.equal(metrics.authActive, 4); assert.equal(metrics.authPending, 7); assert.equal(metrics.authRejected, 2);
  assert.equal(metrics.tickDurationMs, 2.5); assert.equal(metrics.rssBytes, 12345); assert.equal(metrics.uptimeSeconds, 1.25);
  assert.equal(metrics.messagesRejected, 0); assert.equal(metrics.sendErrors, 0); assert.equal(metrics.stateSkipped, 0);
  assert.equal(metrics.arbitraryCount, undefined);
  assert.doesNotMatch(response.body, /SECRET|ROOM|USER|TOKEN|127\.0\.0\.1|private|sensitive/);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  for (const [key, value] of Object.entries(metrics)) if (key !== 'draining') assert.equal(typeof value, 'number');
});

test('diagnostics errors fail readiness closed with a fixed response and no exception contents', async t => {
  const get = await setup(t, () => { throw new Error('SECRET /private/outbox'); });
  for (const pathname of ['/health/runtime', '/health/ready']) {
    const response = await get(pathname);
    assert.equal(response.status, 503);
    assert.doesNotMatch(response.body, /SECRET|private/);
  }
  assert.equal((await get('/health')).status, 200);
});

test('runtime endpoints support HEAD and reject mutation methods before accessing diagnostics', async t => {
  let calls = 0;
  const get = await setup(t, () => { calls++; return {}; });
  for (const pathname of ['/health/runtime', '/health/ready']) {
    const head = await get(pathname, 'HEAD');
    assert.equal(head.status, 200); assert.equal(head.body, '');
    const before = calls;
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await get(pathname, method);
      assert.equal(response.status, 405); assert.equal(response.headers.allow, 'GET, HEAD');
    }
    assert.equal(calls, before);
  }
});
