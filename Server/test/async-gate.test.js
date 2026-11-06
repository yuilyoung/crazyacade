import test from 'node:test';
import assert from 'node:assert/strict';
import { createAsyncGate } from '../src/async-gate.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('admission gate bounds active and pending work while preserving FIFO order', async () => {
  const gate = createAsyncGate({ capacity: 2, maxPending: 2 });
  const blockers = Array.from({ length: 4 }, deferred), started = [];
  const work = blockers.map((blocker, index) => gate.run(async () => {
    started.push(index);
    await blocker.promise;
    return index;
  }));
  await turn();
  assert.deepEqual(started, [0, 1]);
  assert.equal(gate.snapshot().active, 2);
  assert.equal(gate.snapshot().pending, 2);
  await assert.rejects(gate.run(() => assert.fail('overflow must not execute')), { code: 'gate_full' });
  assert.equal(gate.snapshot().rejected, 1);
  blockers[1].resolve(); await turn();
  assert.deepEqual(started, [0, 1, 2]);
  blockers[0].resolve(); await turn();
  assert.deepEqual(started, [0, 1, 2, 3]);
  blockers[2].resolve(); blockers[3].resolve();
  assert.deepEqual(await Promise.all(work), [0, 1, 2, 3]);
  assert.equal(gate.snapshot().active, 0);
  assert.equal(gate.snapshot().pending, 0);
});

test('queued cancellation rejects immediately and returns its pending slot', async () => {
  const gate = createAsyncGate({ capacity: 1, maxPending: 1 });
  const active = deferred(), abort = new AbortController();
  const running = gate.run(() => active.promise);
  const queued = gate.run(() => assert.fail('cancelled work ran'), { signal: abort.signal });
  const rejected = assert.rejects(queued, { name: 'AbortError', code: 'gate_aborted' });
  abort.abort(); await rejected;
  assert.equal(gate.snapshot().pending, 0);
  const replacement = gate.run(() => 'replacement');
  active.resolve(); await running;
  assert.equal(await replacement, 'replacement');
});

test('aborting active work does not release its permit before the task settles', async () => {
  const gate = createAsyncGate({ capacity: 1, maxPending: 1 });
  const active = deferred(), abort = new AbortController();
  let nextStarted = false;
  const running = gate.run(() => active.promise, { signal: abort.signal });
  await turn();
  const next = gate.run(() => { nextStarted = true; });
  abort.abort(); await turn();
  assert.equal(nextStarted, false);
  assert.equal(gate.snapshot().active, 1);
  active.resolve(); await Promise.all([running, next]);
  assert.equal(nextStarted, true);
});

test('synchronous throws and async rejections release admission permits', async () => {
  const gate = createAsyncGate({ capacity: 1, maxPending: 2 });
  const first = gate.run(() => { throw new Error('first'); });
  const second = gate.run(async () => { throw new Error('second'); });
  const third = gate.run(() => 'third');
  await Promise.all([assert.rejects(first, /first/), assert.rejects(second, /second/)]);
  assert.equal(await third, 'third');
  assert.equal(gate.snapshot().active, 0);
});

test('closing admission rejects pending and future work while accepted tasks finish', async () => {
  const gate = createAsyncGate({ capacity: 1, maxPending: 1 }), active = deferred();
  const running = gate.run(() => active.promise);
  const pending = gate.run(() => assert.fail('closed queue work ran'));
  const rejected = assert.rejects(pending, { code: 'gate_closed' });
  gate.close(); gate.close(); await rejected;
  await assert.rejects(gate.run(() => assert.fail('closed work ran')), { code: 'gate_closed' });
  assert.equal(gate.snapshot().active, 1);
  assert.equal(gate.snapshot().pending, 0);
  active.resolve('finished');
  assert.equal(await running, 'finished');
  assert.equal(gate.snapshot().active, 0);
});

test('an already aborted request never takes a permit or joins the queue', async () => {
  const gate = createAsyncGate({ capacity: 1, maxPending: 0 });
  await assert.rejects(gate.run(() => assert.fail('aborted work ran'), { signal: AbortSignal.abort() }), { code: 'gate_aborted' });
  assert.equal(await gate.run(() => 'accepted'), 'accepted');
  for (const options of [{ capacity: 0 }, { capacity: 1.1 }, { maxPending: -1 }, { maxPending: Infinity }]) {
    assert.throws(() => createAsyncGate(options), /integer/);
  }
});

test('a task rejecting without an Error remains a rejection and releases its permit', async () => {
  const gate = createAsyncGate({ capacity: 1, maxPending: 0 });
  const result = await Promise.allSettled([gate.run(() => Promise.reject(null))]);
  assert.deepEqual(result, [{ status: 'rejected', reason: null }]);
  assert.equal(await gate.run(() => 'next'), 'next');
});
