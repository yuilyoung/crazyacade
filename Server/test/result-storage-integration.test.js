import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setup, waitFor, send, close } from './fixtures/relay-server.mjs';

const resultFiles = async directory => (await readdir(directory)).filter(file => file !== '.writer.lock');

async function storageProvider(t, behavior = (_body, _attempt, response) => { response.writeHead(200); response.end(''); }) {
  const calls = [], pending = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/auth/v1/user') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: request.headers.authorization.slice(7), user_metadata: {} }));
      return;
    }
    let text = '';
    for await (const chunk of request) text += chunk;
    if (request.url === '/rest/v1/rpc/record_match') {
      const body = JSON.parse(text); calls.push(body); pending.push(response);
      await behavior(body, calls.length, response); return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('[]');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { calls, pending, env: { ALLOW_DEV_GUESTS: 'false', SUPABASE_URL: `http://127.0.0.1:${server.address().port}`, SUPABASE_ANON_KEY: 'fixture-anon', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-never-public' } };
}

async function finishDuel(server, roomId = 'record') {
  const first = await server.join({ roomId, accessToken: '11111111-1111-4111-8111-111111111111', reconnect: true });
  const second = await server.join({ roomId, accessToken: '22222222-2222-4222-8222-222222222222' });
  await waitFor(() => second.state.phase === 'playing');
  send(first, 'input', { action: 'place_orb' });
  await waitFor(() => second.state.phase === 'finished');
  return { first, second };
}

const health = async server => {
  const response = await fetch(`http://127.0.0.1:${server.port}/health/storage`);
  return { status: response.status, body: await response.json() };
};

async function waitForDisk(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for durable result state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('completed demo and unranked matches report their actual storage mode', async t => {
  const demo = await setup(t, {}, { tickMs: 2 });
  const { second } = await finishDuel(demo);
  await waitFor(() => second.state.resultSaving?.status === 'demo');
  assert.deepEqual(second.state.resultSaving, { matchId: second.state.matchId, status: 'demo', attempts: 0 });
  assert.deepEqual(await readdir(demo.outboxDirectory), []);
  assert.deepEqual(await health(demo), { status: 200, body: { status: 'disabled', pending: 0, retrying: 0, failed: 0, invalid: 0, active: 0, capacity: 1000 } });
  const practice = await setup(t, { ALLOW_DEV_GUESTS: 'false' }, { tickMs: 1 });
  const solo = await practice.join({ practice: true, ruleSet: 'relay' });
  await waitFor(() => solo.state.phase === 'finished');
  assert.deepEqual(solo.state.resultSaving, { matchId: solo.state.matchId, status: 'unranked', attempts: 0 });
  assert.deepEqual(await resultFiles(practice.outboxDirectory), []);
});

test('ranked completion is durable before HTTP and transitions retrying to saved with identical payload', async t => {
  let directory, fileExisted = false;
  const provider = await storageProvider(t, async (body, attempt, response) => {
    fileExisted = (await resultFiles(directory)).includes(`${body.p_match_id}.json`);
    response.writeHead(attempt === 1 ? 503 : 200); response.end('provider-private-body');
  });
  const server = await setup(t, provider.env, { tickMs: 2 }); directory = server.outboxDirectory;
  const { second } = await finishDuel(server);
  await waitFor(() => second.messages.some(m => m.resultSaving?.status === 'retrying'));
  assert.equal(fileExisted, true);
  const retry = await health(server);
  assert.equal(retry.status, 503); assert.equal(retry.body.retrying, 1);
  await waitFor(() => second.state.resultSaving?.status === 'saved');
  assert.equal(second.state.resultSaving.matchId, second.state.matchId);
  assert.equal(second.state.resultSaving.attempts, 2);
  assert.deepEqual(provider.calls[0], provider.calls[1]);
  assert.deepEqual(await resultFiles(directory), []);
  const current = await health(server);
  assert.equal(current.status, 200); assert.equal(current.body.pending, 0);
  assert.deepEqual(Object.keys(current.body).sort(), ['status', 'pending', 'retrying', 'failed', 'invalid', 'active', 'capacity'].sort());
  assert.doesNotMatch(JSON.stringify(second.messages) + JSON.stringify(current.body) + server.errors(), /fixture-service-never-public|provider-private-body/);
});

test('permanent provider rejection remains on disk and reconnect returns failed without rewriting the match', async t => {
  const provider = await storageProvider(t, (_body, _attempt, response) => { response.writeHead(403); response.end('private-denial'); });
  const server = await setup(t, provider.env, { tickMs: 2 });
  const { first, second } = await finishDuel(server);
  await waitFor(() => second.state.resultSaving?.status === 'failed');
  assert.equal(provider.calls.length, 1);
  const original = first.messages.find(m => m.type === 'joined');
  await close(first);
  const resumed = await server.connect();
  send(resumed, 'resume', { roomId: original.roomId, playerId: original.playerId, resumeToken: original.resumeToken, accessToken: '11111111-1111-4111-8111-111111111111' });
  await waitFor(() => resumed.state);
  assert.deepEqual(resumed.state.resultSaving, second.state.resultSaving);
  assert.equal((await resultFiles(server.outboxDirectory)).length, 1);
  const stored = await readFile(path.join(server.outboxDirectory, `${second.state.matchId}.json`), 'utf8');
  assert.doesNotMatch(stored, new RegExp(original.resumeToken + '|fixture-service-never-public|private-denial'));
  assert.equal((await health(server)).body.failed, 1);
  assert.deepEqual(await fetch(`http://127.0.0.1:${server.port}/health`).then(r => r.json()), { status: 'ok' });
});

test('a delayed old result cannot mark a new round saved', async t => {
  let release;
  const provider = await storageProvider(t, (_body, _attempt, response) => { release = () => { response.writeHead(200); response.end(''); }; });
  const server = await setup(t, provider.env, { tickMs: 5 });
  const { first, second } = await finishDuel(server);
  await waitFor(() => release);
  const oldMatchId = second.state.matchId;
  send(first, 'rematch'); send(second, 'rematch');
  await waitFor(() => second.state.round === 1);
  assert.equal(second.state.resultSaving, null);
  assert.notEqual(second.state.matchId, oldMatchId);
  release();
  await waitFor(() => provider.pending[0].writableEnded);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(second.state.resultSaving, null);
  assert.equal(second.state.phase, 'playing');
});

test('a process killed after durable enqueue restarts and replays the same completed result', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'arena-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let accept = false;
  const provider = await storageProvider(t, (_body, _attempt, response) => { response.writeHead(accept ? 200 : 503); response.end(''); });
  const environment = { ...provider.env, RESULT_OUTBOX_DIR: directory };
  const first = await setup(t, environment, { tickMs: 2 });
  const { second } = await finishDuel(first);
  await waitFor(() => second.state.resultSaving?.status === 'retrying');
  const payload = structuredClone(provider.calls[0]);
  const exited = once(first.proc, 'exit'); first.proc.kill('SIGKILL'); await exited;
  assert.equal((await resultFiles(directory)).length, 1);
  accept = true;
  const restarted = await setup(t, environment);
  await waitFor(() => provider.calls.length === 2);
  await waitFor(() => provider.pending[1].writableEnded);
  await waitForDisk(async () => (await resultFiles(directory)).length === 0);
  assert.deepEqual(provider.calls[1], payload);
  assert.deepEqual(await resultFiles(directory), []);
  assert.equal((await health(restarted)).status, 200);
});

test('corrupt retained records degrade storage health without leaking their contents', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'arena-corrupt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, '11111111-1111-4111-8111-111111111111.json'), '{"resumeToken":"private-corrupt-data"');
  const server = await setup(t, { ALLOW_DEV_GUESTS: 'false', RESULT_OUTBOX_DIR: directory });
  const response = await health(server);
  assert.equal(response.status, 503); assert.equal(response.body.invalid, 1);
  assert.doesNotMatch(JSON.stringify(response.body) + server.errors(), /private-corrupt-data|11111111|arena-corrupt/);
  assert.equal((await resultFiles(directory)).length, 1);
});

test('missing write credentials never claim a completed ranked result was saved', async t => {
  const provider = await storageProvider(t);
  const server = await setup(t, { ...provider.env, SUPABASE_SERVICE_ROLE_KEY: '' }, { tickMs: 2 });
  const { second } = await finishDuel(server);
  await waitFor(() => second.state.resultSaving?.status === 'failed');
  assert.equal(provider.calls.length, 0);
  assert.equal((await resultFiles(server.outboxDirectory)).length, 1);
  assert.equal((await health(server)).status, 503);
});

test('a failed enqueue is visible while the game server continues and does not call the provider', async t => {
  const provider = await storageProvider(t);
  const server = await setup(t, provider.env, { tickMs: 2 });
  await rm(server.outboxDirectory, { recursive: true });
  await writeFile(server.outboxDirectory, 'not-a-directory');
  const { second } = await finishDuel(server);
  await waitFor(() => second.state.resultSaving?.status === 'failed');
  assert.equal(provider.calls.length, 0);
  assert.equal(server.proc.exitCode, null);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/health`)).status, 200);
  assert.doesNotMatch(server.errors(), /arena-result-test|fixture-service-never-public|not-a-directory/);
});

test('graceful server shutdown does not turn active players into artificial forfeits', async t => {
  const provider = await storageProvider(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'arena-shutdown-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = await setup(t, { ...provider.env, RESULT_OUTBOX_DIR: directory });
  await server.join({ roomId: 'active', accessToken: '11111111-1111-4111-8111-111111111111' });
  const second = await server.join({ roomId: 'active', accessToken: '22222222-2222-4222-8222-222222222222' });
  assert.equal(second.state.phase, 'playing');
  const exited = once(server.proc, 'exit'); server.proc.kill('SIGTERM'); await exited;
  assert.equal(provider.calls.length, 0);
  assert.deepEqual(await resultFiles(directory), []);
});

test('graceful shutdown also releases an active parent IPC channel after draining storage', async t => {
  const server = await setup(t, { ALLOW_DEV_GUESTS: 'false' }, { ipc: true, preload: "process.on('message', () => {});" });
  let force;
  try {
    const exited = once(server.proc, 'exit');
    server.proc.kill('SIGTERM');
    force = setTimeout(() => server.proc.kill('SIGKILL'), 600);
    const [code, signal] = await exited;
    assert.equal(signal, null, 'server must finish its graceful shutdown without force killing');
    assert.equal(code, 0);
  } finally { clearTimeout(force); }
});

test('shutdown drains an accepted disk write without starting a new provider request', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'arena-drain-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const provider = await storageProvider(t);
  const preload = `
    const fs = (await import('node:fs')).default;
    const originalRename = fs.promises.rename;
    let held = false;
    fs.promises.rename = async (...args) => {
      if (!held && String(args[1]).endsWith('.json')) {
        held = true; process.send({ type: 'writing-result' });
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      return originalRename(...args);
    };
    (await import('node:module')).syncBuiltinESMExports();`;
  const server = await setup(t, { ...provider.env, RESULT_OUTBOX_DIR: directory }, { tickMs: 2, ipc: true, preload });
  const events = [];
  server.proc.on('message', event => events.push(event));
  const { second } = await finishDuel(server);
  await waitFor(() => events.some(event => event.type === 'writing-result'));
  const exited = once(server.proc, 'exit'); server.proc.kill('SIGTERM'); await exited;
  assert.equal(provider.calls.length, 0);
  const record = JSON.parse(await readFile(path.join(directory, `${second.state.matchId}.json`), 'utf8'));
  assert.equal(record.attempts, 0);
  assert.equal(record.matchId, second.state.matchId);
});
