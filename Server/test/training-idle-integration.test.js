import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setup, waitFor, send, close } from './fixtures/relay-server.mjs';

// Only this child fixture advances wall time and shortens the established result-retention timer.
// Production exposes no time override and retains ten minutes of reading plus two result minutes.
const preload = `
  const originalNow = Date.now.bind(Date); let offset = 0;
  Date.now = () => originalNow() + offset;
  process.on('message', message => {
    if (message.type === 'advance-test-clock') { offset += message.ms; process.send({ type: 'clock-advanced' }); }
  });
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms === 120000) { process.send({ type: 'result-retention', milliseconds: ms }); return originalTimeout(fn, 100, ...args); }
    return originalTimeout(fn, ms, ...args);
  };`;
async function advanceClock(proc, ms) {
  const response = once(proc, 'message');
  proc.send({ type: 'advance-test-clock', ms });
  assert.equal((await response)[0].type, 'clock-advanced');
}
for (const trainingMode of ['classic', 'harmony']) test(`${trainingMode} idle expiry survives input and resume, reports its reason and releases room capacity`, async t => {
  const server = await setup(t, { RUNTIME_MAX_ROOMS: '1' }, { ipc: true, preload });
  const messages = []; server.proc.on('message', message => messages.push(message));
  const first = await server.join({ practice: true, training: true, trainingMode, reconnect: true });
  const credentials = first.messages.find(message => message.type === 'joined');
  assert.equal(first.state.remaining, 1800);
  assert.equal(first.state.remainingSeconds, 180);
  assert.equal(first.state.training.readingIdleRemainingSeconds, 600);
  await advanceClock(server.proc, 590000);
  await waitFor(() => first.state.training.readingIdleRemainingSeconds <= 10);
  for (let i = 0; i < 8; i++) send(first, 'input', { action: i % 2 ? 'right' : 'place_orb' });
  const oldTick = first.state.tick;
  await waitFor(() => first.state.tick > oldTick);
  assert.equal(first.state.phase, 'playing'); assert.equal(first.state.remaining, 1800);
  assert.ok(first.state.training.readingIdleRemainingSeconds <= 10);
  await close(first);
  const resumed = await server.connect();
  send(resumed, 'resume', { roomId: credentials.roomId, playerId: credentials.playerId, resumeToken: credentials.resumeToken });
  await waitFor(() => resumed.state);
  assert.equal(resumed.state.remainingSeconds, 180);
  assert.ok(resumed.state.training.readingIdleRemainingSeconds <= 10, 'reconnect must not renew the explanation deadline');
  const closed = once(resumed.ws, 'close');
  await advanceClock(server.proc, 10000);
  await waitFor(() => resumed.state.phase === 'finished');
  assert.equal(resumed.state.result.reason, 'training_idle_timeout');
  assert.equal(resumed.state.resultSaving.status, 'unranked');
  assert.equal(resumed.state.training.readingIdleRemainingSeconds, 0);
  assert.equal(resumed.state.remainingSeconds, 180, 'idle expiry spends no exercise time');
  assert.equal((await closed)[0], 1000);
  assert.ok(messages.some(message => message.type === 'result-retention' && message.milliseconds === 120000));
  const diagnostics = await fetch(`http://127.0.0.1:${server.port}/health/runtime`).then(response => response.json());
  assert.equal(diagnostics.rooms, 0);
  const replacement = await server.join({ practice: true, training: true, trainingMode });
  assert.equal(replacement.state.remainingSeconds, 180);
  assert.notEqual(replacement.state.roomId, credentials.roomId);
});
