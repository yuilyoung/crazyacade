import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRuntime, loadRuntimeLimits } from '../src/runtime.js';

function socket() {
  const value = new EventEmitter();
  Object.assign(value, { OPEN: 1, readyState: 1, bufferedAmount: 0, sent: [],
    send(message, done) { this.sent.push(message); done?.(); },
    close(code) { this.closeCode = code; this.readyState = 2; },
    terminate() { this.readyState = 3; this.emit('close'); }
  });
  return value;
}

test('socket capacity and draining reject admission without growing live resource state', t => {
  const runtime = createRuntime({ limits: { maxConnections: 1 } }); t.after(() => runtime.close());
  const first = socket(), extra = socket();
  assert.equal(runtime.admitSocket(first), true);
  assert.equal(runtime.admitSocket(first), true);
  assert.equal(runtime.admitSocket(extra), false);
  assert.equal(extra.closeCode, 1013);
  assert.equal(runtime.snapshot().connections, 1);
  first.terminate();
  assert.equal(runtime.snapshot().connections, 0);
  runtime.setDraining();
  assert.equal(runtime.admitSocket(socket()), false);
  assert.equal(runtime.snapshot().connectionsRejected, 2);
  assert.equal(runtime.snapshot().draining, true);
});

test('token buckets isolate sockets, replenish by elapsed time, and cap idle burst credit', t => {
  let now = 0;
  const runtime = createRuntime({ clock: () => now, limits: { messageRate: 2, messageBurst: 3 } });
  t.after(() => runtime.close());
  const a = socket(), b = socket(); runtime.admitSocket(a); runtime.admitSocket(b);
  assert.deepEqual(Array.from({ length: 4 }, () => runtime.allowMessage(a)), [true, true, true, false]);
  assert.equal(runtime.allowMessage(b), true);
  now = 500;
  assert.equal(runtime.allowMessage(a), true);
  assert.equal(runtime.allowMessage(a), false);
  now = 100000;
  assert.deepEqual(Array.from({ length: 4 }, () => runtime.allowMessage(a)), [true, true, true, false]);
  assert.equal(runtime.snapshot().messagesRejected, 3);
});

test('repeated receive abuse closes only the offending socket with policy code 1008', t => {
  const runtime = createRuntime({ clock: () => 0 }); t.after(() => runtime.close());
  const bad = socket(), good = socket(); runtime.admitSocket(bad); runtime.admitSocket(good);
  for (let count = 0; count < 60; count++) assert.equal(runtime.allowMessage(bad), true);
  for (let count = 0; count < 8; count++) assert.equal(runtime.allowMessage(bad), false);
  assert.equal(bad.closeCode, 1008);
  assert.equal(runtime.allowMessage(good), true);
  assert.equal(runtime.snapshot().rateLimitedSockets, 1);
});

test('sustained receive abuse cannot reset violations by interleaving freshly replenished tokens', t => {
  let now = 0;
  const runtime = createRuntime({ clock: () => now }); t.after(() => runtime.close());
  const bad = socket(); runtime.admitSocket(bad);
  for (let count = 0; count < 60; count++) runtime.allowMessage(bad);
  for (let batch = 0; batch < 4; batch++) {
    now += 34;
    for (let count = 0; count < 8; count++) runtime.allowMessage(bad);
  }
  assert.equal(bad.closeCode, 1008);
  assert.equal(runtime.snapshot().rateLimitedSockets, 1);
});

test('replaceable states are skipped under pressure and the next current state is sent after recovery', t => {
  const runtime = createRuntime(); t.after(() => runtime.close());
  const ws = socket(); runtime.admitSocket(ws);
  ws.bufferedAmount = 65536;
  assert.equal(runtime.send(ws, { type: 'state', tick: 1 }, { replaceable: true }), false);
  assert.equal(ws.sent.length, 0);
  assert.equal(runtime.send(ws, { type: 'pong' }), true);
  ws.bufferedAmount = 0;
  assert.equal(runtime.send(ws, { type: 'state', tick: 2 }, { replaceable: true }), true);
  assert.deepEqual(JSON.parse(ws.sent.at(-1)), { type: 'state', tick: 2 });
  assert.equal(runtime.snapshot().stateSkipped, 1);
});

test('control messages and oversized frames cannot add to a hard-limited send backlog', t => {
  const runtime = createRuntime({ limits: { sendSoftBytes: 32, sendHardBytes: 64 } });
  t.after(() => runtime.close());
  const queued = socket(), oversize = socket(); runtime.admitSocket(queued); runtime.admitSocket(oversize);
  queued.bufferedAmount = 60;
  assert.equal(runtime.send(queued, '12345'), false);
  assert.equal(queued.closeCode, 1013);
  assert.equal(queued.sent.length, 0);
  assert.equal(runtime.send(oversize, 'x'.repeat(65)), false);
  assert.equal(oversize.closeCode, 1013);
  assert.equal(runtime.snapshot().slowSockets, 2);
});

test('a three-second backlog closes the slow connection without waiting in send', t => {
  let now = 0;
  const runtime = createRuntime({ clock: () => now }); t.after(() => runtime.close());
  const ws = socket(); runtime.admitSocket(ws); ws.bufferedAmount = 65536;
  assert.equal(runtime.send(ws, 'state', { replaceable: true }), false);
  now = 2999;
  assert.equal(runtime.send(ws, 'state', { replaceable: true }), false);
  assert.equal(ws.closeCode, undefined);
  now = 3000;
  assert.equal(runtime.send(ws, 'state', { replaceable: true }), false);
  assert.equal(ws.closeCode, 1013);
});

test('backlog duration restarts after a sampled recovery', t => {
  let now = 0;
  const runtime = createRuntime({ clock: () => now }); t.after(() => runtime.close());
  const ws = socket(); runtime.admitSocket(ws); ws.bufferedAmount = 65536;
  runtime.send(ws, 'state', { replaceable: true });
  now = 2000; ws.bufferedAmount = 0; runtime.send(ws, 'current', { replaceable: true });
  now = 2500; ws.bufferedAmount = 65536; runtime.send(ws, 'state', { replaceable: true });
  now = 3000; runtime.send(ws, 'state', { replaceable: true });
  assert.equal(ws.closeCode, undefined);
  now = 5500; runtime.send(ws, 'state', { replaceable: true });
  assert.equal(ws.closeCode, 1013);
});

test('backlog deadline is enforced even without further application messages', async t => {
  const runtime = createRuntime({ limits: { sendMaxDelayMs: 15 } }); t.after(() => runtime.close());
  const ws = socket(); runtime.admitSocket(ws); ws.bufferedAmount = 65536;
  runtime.send(ws, 'state', { replaceable: true });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(ws.closeCode, 1013);
});

test('send exceptions close the connection and closed or released sockets cannot send', t => {
  const runtime = createRuntime(); t.after(() => runtime.close());
  const ws = socket(); runtime.admitSocket(ws);
  ws.send = () => { throw new Error('private provider detail'); };
  assert.equal(runtime.send(ws, 'message'), false);
  assert.equal(runtime.snapshot().sendErrors, 1);
  runtime.releaseSocket(ws); runtime.releaseSocket(ws);
  assert.equal(runtime.send(ws, 'message'), false);
  assert.equal(runtime.allowMessage(ws), false);
  assert.equal(runtime.snapshot().connections, 0);
});

test('public runtime metrics sanitize counts and report measured tick duration, lag, RSS and uptime', t => {
  let now = 1000;
  const runtime = createRuntime({ clock: () => now }); t.after(() => runtime.close());
  runtime.recordTick({ durationMs: 4.5, lagMs: 12 });
  runtime.recordTick({ durationMs: 2, lagMs: 3 });
  now = 3500;
  const summary = runtime.snapshot({ rooms: 2, queuedPlayers: 8, auth: { active: 2, pending: 4 }, token: 'secret' });
  assert.equal(summary.rooms, 2); assert.equal(summary.queuedPlayers, 8);
  assert.equal(summary.authActive, 2); assert.equal(summary.authPending, 4);
  assert.equal(summary.ticks, 2); assert.equal(summary.tickDurationMs, 2); assert.equal(summary.tickMaxDurationMs, 4.5);
  assert.equal(summary.tickLagMs, 3); assert.equal(summary.tickMaxLagMs, 12);
  assert.equal(summary.uptimeSeconds, 2.5); assert.ok(summary.rssBytes > 0);
  assert.equal(summary.token, undefined);
  assert.equal(runtime.snapshot({ rooms: Infinity, queuedPlayers: -1 }).rooms, 0);
  assert.equal(runtime.snapshot({ queuedPlayers: -1 }).queuedPlayers, 0);
});

test('environment limits accept lower integers but reject malformed and unsafe values', () => {
  const limits = loadRuntimeLimits({ RUNTIME_MAX_CONNECTIONS: '2', RUNTIME_AUTH_CAPACITY: '1', RUNTIME_DRAIN_MS: '10' });
  assert.equal(limits.maxConnections, 2); assert.equal(limits.authCapacity, 1); assert.equal(limits.drainMs, 10);
  for (const invalid of ['', '0', '-1', '1.5', 'garbage', 'Infinity', '500000']) {
    assert.throws(() => loadRuntimeLimits({ RUNTIME_MAX_CONNECTIONS: invalid }), /RUNTIME_MAX_CONNECTIONS/);
  }
  assert.throws(() => createRuntime({ limits: { sendSoftBytes: 10, sendHardBytes: 5 } }), /send/);
  assert.equal(loadRuntimeLimits({ RUNTIME_AUTH_MAX_PENDING: '0' }).authMaxPending, 0);
});

test('closing the runtime releases sockets and timers, and prevents re-admission', () => {
  const runtime = createRuntime(), ws = socket(); runtime.admitSocket(ws);
  ws.bufferedAmount = 65536; runtime.send(ws, 'state', { replaceable: true });
  runtime.close(); runtime.close();
  assert.equal(ws.readyState, 3);
  assert.equal(runtime.snapshot().connections, 0);
  assert.equal(runtime.admitSocket(socket()), false);
});
