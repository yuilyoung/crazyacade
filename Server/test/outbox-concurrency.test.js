import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createResultOutbox } from '../src/result-outbox.js';

const id = n => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const snapshot = (n = 1) => ({ matchId: id(n), id: 'friends', mode: 'duel', result: { winnerId: 'alice' }, participants: [{ userId: 'alice', score: 250 }, { userId: 'bob', score: 10 }] });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function directory(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'poppop-reservations-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }

// This would fail if capacity were checked only after awaiting the disk queue.
test('pending disk admissions reserve capacity and reject overflow immediately', async t => {
  const dir = await directory(t);
  let unblock, entered;
  const blocked = new Promise(resolve => { unblock = resolve; });
  const diskEntered = new Promise(resolve => { entered = resolve; });
  const fileSystem = { ...fs, rename: async (...args) => { entered(); await blocked; return fs.rename(...args); } };
  const box = createResultOutbox({ directory: dir, fileSystem, capacity: 1, persist: async () => assert.fail('paused result delivered') });
  t.after(async () => { unblock(); await box.close(); });
  await box.start(); box.pause();
  const first = box.enqueue(snapshot()); await diskEntered;
  const duplicate = box.enqueue(snapshot());
  assert.equal(duplicate, first, 'identical pending results share one admission operation');
  const outcomes = [];
  const extra = Array.from({ length: 100 }, (_, n) => box.enqueue(snapshot(n + 2)).then(() => outcomes.push('accepted'), e => outcomes.push(e.message)));
  try {
    await tick();
    assert.equal(outcomes.length, 100, 'overflow must reject without waiting for disk');
    assert.ok(outcomes.every(message => /capacity/.test(message)));
    assert.equal(box.diagnostics().pending, 1);
  } finally { unblock(); await Promise.all([first, duplicate, ...extra]); }
  assert.equal((await fs.readdir(dir)).filter(file => file.endsWith('.json')).length, 1);
});

test('same-ID conflicts reject while the original immutable admission is still flushing', async t => {
  const dir = await directory(t);
  let unblock, entered;
  const blocked = new Promise(resolve => { unblock = resolve; });
  const diskEntered = new Promise(resolve => { entered = resolve; });
  const fileSystem = { ...fs, rename: async (...args) => { entered(); await blocked; return fs.rename(...args); } };
  const box = createResultOutbox({ directory: dir, fileSystem });
  t.after(async () => { unblock(); await box.close(); });
  await box.start(); box.pause();
  const first = box.enqueue(snapshot()); await diskEntered;
  const other = snapshot(); other.participants[0].score = 999;
  let error;
  const conflict = box.enqueue(other).catch(e => { error = e; });
  try { await tick(); assert.match(error?.message ?? '', /conflict/i); }
  finally { unblock(); await Promise.all([first, conflict]); }
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, `${id(1)}.json`))).payload.p_participants[0].score, 250);
});

test('failed non-durable admission returns its capacity for another result', async t => {
  const dir = await directory(t); let fail = true;
  const fileSystem = { ...fs, rename: async (...args) => { if (fail) throw Error('disk failed'); return fs.rename(...args); } };
  const box = createResultOutbox({ directory: dir, fileSystem, capacity: 1 });
  t.after(() => box.close()); await box.start(); box.pause();
  await assert.rejects(box.enqueue(snapshot()), /disk failed/); fail = false;
  await box.enqueue(snapshot(2));
  assert.equal(box.diagnostics().pending, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, `${id(2)}.json`))).matchId, id(2));
});

test('only exact own temporary names bypass invalid capacity and remain preserved', async t => {
  const dir = await directory(t), temporary = `.${id(1)}.${id(2)}.tmp`;
  await fs.writeFile(path.join(dir, temporary), 'partial');
  const box = createResultOutbox({ directory: dir, capacity: 1 });
  t.after(() => box.close()); await box.start(); box.pause();
  assert.equal(box.diagnostics().invalid, 0);
  assert.equal(box.diagnostics().orphanedTemporary, 1);
  await box.enqueue(snapshot());
  assert.equal(await fs.readFile(path.join(dir, temporary), 'utf8'), 'partial');
  const other = await directory(t);
  await fs.writeFile(path.join(other, '.not-own.tmp'), 'unknown');
  const invalid = createResultOutbox({ directory: other, capacity: 1 });
  t.after(() => invalid.close()); await invalid.start();
  assert.equal(invalid.diagnostics().invalid, 1);
  await assert.rejects(invalid.enqueue(snapshot()), /capacity/i);
});

test('close drains accepted admissions and rejects new work before releasing ownership', async t => {
  const dir = await directory(t); let unblock, entered;
  const blocked = new Promise(resolve => { unblock = resolve; });
  const diskEntered = new Promise(resolve => { entered = resolve; });
  const fileSystem = { ...fs, rename: async (...args) => { entered(); await blocked; return fs.rename(...args); } };
  const box = createResultOutbox({ directory: dir, fileSystem });
  t.after(async () => { unblock(); await box.close(); }); await box.start();
  const accepted = box.enqueue(snapshot()); await diskEntered;
  let closed = false; const closing = box.close().then(() => { closed = true; });
  await assert.rejects(box.enqueue(snapshot(2)), /accepting/i);
  try { await tick(); assert.equal(closed, false); }
  finally { unblock(); await Promise.all([accepted, closing]); }
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, `${id(1)}.json`))).matchId, id(1));
});

test('status observers see each accepted result once in capacity accounting', async t => {
  const dir = await directory(t); let nested, observed;
  const box = createResultOutbox({ directory: dir, capacity: 2, onStatus: status => {
    if (status.matchId === id(1) && status.status === 'saving') {
      observed = box.diagnostics().pending;
      nested = box.enqueue(snapshot(2)); nested.catch(() => {});
    }
  } });
  t.after(() => box.close()); await box.start(); box.pause();
  await box.enqueue(snapshot());
  assert.equal(observed, 1);
  await nested;
  assert.equal(box.diagnostics().pending, 2);
});
