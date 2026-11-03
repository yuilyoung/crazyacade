import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createResultOutbox } from '../src/result-outbox.js';
import { buildMatchPayload, persistMatchPayload } from '../src/supabase.js';

const id = n => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const snapshot = (n = 1) => ({ matchId: id(n), id: 'friends', mode: 'duel', result: { winnerId: 'alice' }, participants: [{ userId: 'alice', score: 250 }, { userId: 'bob', score: 10 }] });
const waitFor = async predicate => { for (let n = 0; !predicate(); n++) { if (n > 500) throw Error('Outbox condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } };
async function directory(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'poppop-outbox-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
const retryError = () => Object.assign(new Error('provider unavailable'), { retryable: true });

test('RPC snapshot allowlists fields and cannot retain player tokens or mutate with a later round', () => {
  const room = snapshot(); room.accessToken = 'private-jwt'; room.result.resumeToken = 'private-resume';
  room.result.scoreboard = [{ id: 'player', name: 'Alice', score: 250, socket: { secret: 'private-socket' }, accessToken: 'private-jwt' }];
  room.participants[0].resumeToken = 'private-resume';
  const payload = buildMatchPayload(room);
  room.participants[0].score = 0; room.result.scoreboard[0].score = 0;
  assert.equal(payload.p_participants[0].score, 250);
  assert.equal(payload.p_result.scoreboard[0].score, 250);
  assert.doesNotMatch(JSON.stringify(payload), /private-|accessToken|resumeToken|socket/);
});

test('durable record exists with restrictive permissions before any HTTP delivery', async t => {
  const dir = await directory(t), statuses = [];
  let delivered = false;
  const box = createResultOutbox({ directory: dir, onStatus: value => statuses.push(value), persist: async payload => {
    const record = JSON.parse(await fs.readFile(path.join(dir, `${payload.p_match_id}.json`), 'utf8'));
    assert.equal(record.payload.p_participants[0].score, 250);
    assert.equal((await fs.stat(path.join(dir, `${payload.p_match_id}.json`))).mode & 0o777, 0o600);
    delivered = true;
  } });
  t.after(() => box.close()); await box.start(); await box.enqueue(snapshot());
  await waitFor(() => statuses.some(s => s.status === 'saved'));
  assert.ok(delivered); assert.deepEqual(await fs.readdir(dir), []);
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  assert.deepEqual(statuses.at(-1), { matchId: id(1), status: 'saved', attempts: 1 });
});

test('retry keeps the original immutable payload and eventually clears its durable record', async t => {
  const dir = await directory(t), statuses = [], payloads = [];
  const box = createResultOutbox({ directory: dir, retryDelays: [10], onStatus: s => statuses.push(s), persist: async payload => {
    payloads.push(structuredClone(payload)); if (payloads.length === 1) throw retryError();
  } });
  t.after(() => box.close()); await box.start(); const room = snapshot(); await box.enqueue(room); room.participants[0].score = 0;
  await waitFor(() => statuses.some(s => s.status === 'saved'));
  assert.ok(statuses.some(s => s.status === 'retrying'));
  assert.equal(payloads.length, 2); assert.deepEqual(payloads[0], payloads[1]); assert.equal(payloads[1].p_participants[0].score, 250);
  assert.equal(box.diagnostics().pending, 0); assert.deepEqual(await fs.readdir(dir), []);
});

test('enqueue captures values before its asynchronous disk lock and repeated saved enqueue reports saved without another delivery', async t => {
  const dir = await directory(t), statuses = [], sent = [];
  const box = createResultOutbox({ directory: dir, onStatus: s => statuses.push(s), persist: async p => { sent.push(p); } });
  t.after(() => box.close()); await box.start();
  const room = snapshot(), queued = box.enqueue(room); room.participants[0].score = 999;
  await queued; await waitFor(() => statuses.some(s => s.status === 'saved'));
  assert.equal(sent[0].p_participants[0].score, 250);
  statuses.length = 0; await box.enqueue(snapshot());
  assert.equal(sent.length, 1); assert.equal(statuses.at(-1).status, 'saved');
});

test('permanent failures remain on disk, become degraded, and retry once service configuration is fixed on restart', async t => {
  const dir = await directory(t); let calls = 0;
  const box = createResultOutbox({ directory: dir, retryDelays: [1], persist: async () => { calls++; throw Object.assign(new Error('unauthorized'), { retryable: false }); } });
  await box.start(); await box.enqueue(snapshot()); await waitFor(() => box.diagnostics().failed === 1);
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(calls, 1);
  assert.equal(box.diagnostics().status, 'degraded'); await box.close();
  const saved = [];
  const restarted = createResultOutbox({ directory: dir, persist: async payload => { saved.push(payload); } });
  t.after(() => restarted.close()); await restarted.start(); await waitFor(() => saved.length === 1 && restarted.diagnostics().active === 0);
  assert.equal(saved[0].p_match_id, id(1)); assert.deepEqual(await fs.readdir(dir), []);
});

test('duplicate enqueue creates one job while conflicting same-ID results are refused', async t => {
  const dir = await directory(t); let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const box = createResultOutbox({ directory: dir, persist: async () => { calls++; await gate; } });
  t.after(async () => { release(); await box.close(); }); await box.start();
  await Promise.all([box.enqueue(snapshot()), box.enqueue(snapshot())]);
  const conflict = snapshot(); conflict.participants[0].score = 999;
  await assert.rejects(box.enqueue(conflict), /conflict/i);
  await waitFor(() => calls === 1); assert.equal((await fs.readdir(dir)).filter(p => p.endsWith('.json')).length, 1);
});

test('capacity and byte limits reject unsaved overflow without deleting the existing record', async t => {
  const dir = await directory(t);
  const box = createResultOutbox({ directory: dir, capacity: 1, persist: async () => { throw Object.assign(new Error('blocked'), { retryable: false }); } });
  t.after(() => box.close()); await box.start(); await box.enqueue(snapshot()); await waitFor(() => box.diagnostics().failed === 1);
  await assert.rejects(box.enqueue(snapshot(2)), /capacity/i);
  assert.equal((await fs.readdir(dir)).length, 1);
  const small = createResultOutbox({ directory: path.join(dir, 'small'), maxBytes: 100, persist: async () => assert.fail('oversized record delivered') });
  t.after(() => small.close()); await small.start(); await assert.rejects(small.enqueue(snapshot()), /size/i);
});

test('corrupt and unsupported files are retained and counted while valid records still recover', async t => {
  const dir = await directory(t);
  await fs.writeFile(path.join(dir, `${id(8)}.json`), '{broken');
  await fs.writeFile(path.join(dir, `${id(9)}.json`), JSON.stringify({ version: 99 }));
  const box = createResultOutbox({ directory: dir, persist: async () => {} });
  t.after(() => box.close()); await box.start(); await box.enqueue(snapshot());
  await waitFor(() => box.diagnostics().pending === 0 && box.diagnostics().active === 0);
  assert.equal(box.diagnostics().invalid, 2); assert.equal(box.diagnostics().status, 'degraded');
  await assert.rejects(box.enqueue(snapshot(8)), /invalid.*file/i);
  assert.equal(await fs.readFile(path.join(dir, `${id(8)}.json`), 'utf8'), '{broken');
});

test('retained invalid files consume queue capacity and are never displaced by new results', async t => {
  const dir = await directory(t), file = path.join(dir, `${id(9)}.json`);
  await fs.writeFile(file, '{preserve');
  const box = createResultOutbox({ directory: dir, capacity: 1, persist: async () => assert.fail('full queue delivered new result') });
  t.after(() => box.close()); await box.start();
  await assert.rejects(box.enqueue(snapshot()), /capacity/i);
  assert.deepEqual(await fs.readdir(dir), [`${id(9)}.json`]);
  assert.equal(await fs.readFile(file, 'utf8'), '{preserve');
});

test('pause drains accepted disk writes but never starts their provider request', async t => {
  const dir = await directory(t); let release, entered = false, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const fileSystem = { ...fs, rename: async (...args) => { entered = true; await gate; return fs.rename(...args); } };
  const box = createResultOutbox({ directory: dir, fileSystem, persist: async () => { calls++; } });
  await box.start(); const queued = box.enqueue(snapshot()); await waitFor(() => entered);
  try { box.pause(); } finally { release(); }
  await queued; await box.close();
  assert.equal(calls, 0); assert.equal((await fs.readdir(dir)).length, 1);
});

test('pause during a scheduled attempt disk flush keeps the result pending without an HTTP send', async t => {
  const dir = await directory(t); let release, renames = 0, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const fileSystem = { ...fs, rename: async (...args) => { renames++; if (renames === 2) await gate; return fs.rename(...args); } };
  const box = createResultOutbox({ directory: dir, fileSystem, persist: async () => { calls++; } });
  await box.start(); await box.enqueue(snapshot()); await waitFor(() => renames === 2);
  try { box.pause(); } finally { release(); }
  await box.close(); assert.equal(calls, 0); assert.equal((await fs.readdir(dir)).length, 1);
});

test('disk write failure is reported as failed and never reaches the provider', async t => {
  const dir = await directory(t), statuses = [];
  const fileSystem = { ...fs, rename: async () => { throw Object.assign(new Error('disk failed'), { code: 'EIO' }); } };
  const box = createResultOutbox({ directory: dir, fileSystem, onStatus: s => statuses.push(s), persist: async () => assert.fail('non-durable result sent') });
  t.after(() => box.close()); await box.start(); await assert.rejects(box.enqueue(snapshot()), /disk failed/);
  assert.equal(statuses.at(-1).status, 'failed'); assert.equal(box.diagnostics().status, 'degraded');
});

test('no more than two distinct matches deliver concurrently and shutdown stops new jobs', async t => {
  const dir = await directory(t); let release, active = 0, peak = 0, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const box = createResultOutbox({ directory: dir, persist: async () => { calls++; active++; peak = Math.max(peak, active); await gate; active--; } });
  await box.start(); for (let n = 1; n <= 4; n++) await box.enqueue(snapshot(n));
  await waitFor(() => active === 2); const closing = box.close(); release(); await closing;
  assert.equal(peak, 2); assert.equal(calls, 2); assert.equal((await fs.readdir(dir)).length, 2);
});

test('HTTP transport bounds timeout and classifies failures without exposing response bodies', async t => {
  const server = createServer((req, res) => {
    if (req.url.startsWith('/slow/')) return;
    const status = Number(req.url.split('/')[1]); res.writeHead(status); res.end('provider-secret-body');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [status, retryable] of [[408, true], [429, true], [503, true], [400, false], [401, false]]) {
    await assert.rejects(persistMatchPayload(buildMatchPayload(snapshot()), { env: { SUPABASE_URL: `${base}/${status}`, SUPABASE_SERVICE_ROLE_KEY: 'private-key' } }), error => {
      assert.equal(error.retryable, retryable); assert.doesNotMatch(error.message, /provider-secret|private-key/); return true;
    });
  }
  await assert.rejects(persistMatchPayload(buildMatchPayload(snapshot()), { env: { SUPABASE_URL: `${base}/slow`, SUPABASE_SERVICE_ROLE_KEY: 'private-key' }, timeoutMs: 30 }), error => error.retryable === true);
  await assert.rejects(persistMatchPayload(buildMatchPayload(snapshot()), { env: {} }), error => error.retryable === false);
});
