import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueueSessions } from '../src/queue-sessions.js';

function client(id) {
  return { demoUser: { id }, socket: { OPEN: 1, readyState: 1, messages: [] } };
}

function setup({ clock, run = task => task() }) {
  const released = [];
  const service = createQueueSessions({
    capacity: 2, demoMode: true, clock, gate: { run },
    send: (socket, message) => socket.messages.push(message),
    begin: (session, kind, requestId) => session.operation = { kind, requestId, controller: new AbortController() },
    current: (session, operation) => session.operation === operation,
    finish: session => { session.operation = null; },
    acquireClaim: (session, id) => session.claim = { id },
    releaseClaim: session => { released.push(session.claim); session.claim = null; },
    isDraining: () => false, canAssign: () => false
  });
  const join = (session, requestId) => service.join(session, { type: 'queue_join', requestId });
  return { service, join, released };
}

for (const delayed of [false, true]) {
  test(`expired tickets free capacity ${delayed ? 'after waiting for admission' : 'at the initial capacity check'}`, async () => {
    let now = 0, holdNext = false;
    const pause = Promise.withResolvers();
    const { service, join } = setup({
      clock: () => now,
      async run(task) {
        if (holdNext) { holdNext = false; await pause.promise; }
        return task();
      }
    });
    const first = client('dev-first'), second = client('dev-second'), third = client('dev-third');
    await join(first, 'first');
    let pending;
    if (delayed) { holdNext = true; pending = join(third, 'replacement'); }
    now = 1000;
    await join(second, 'second');
    const liveTicket = second.queued;

    now = 179999;
    const early = client('dev-early');
    await join(early, 'early');
    assert.equal(early.socket.messages.at(-1).code, 'queue_full');
    assert.equal(first.socket.messages.at(-1).status, 'searching');

    now = 180000;
    if (delayed) { pause.resolve(); await pending; }
    else await join(third, 'replacement');
    assert.equal(third.socket.messages.at(-1).status, 'searching');
    assert.equal(service.size, 2);
    assert.equal(first.claim, null);
    assert.equal(first.queued, null);
    service.tick();
    const expired = first.socket.messages.filter(message => message.status === 'expired');
    assert.equal(expired.length, 1);
    assert.equal(expired[0].requestId, 'first');
    assert.equal(expired[0].elapsedMs, 180000);
    assert.equal(second.queued, liveTicket);
    assert.equal(second.socket.messages.at(-1).elapsedMs, 179000);
  });
}

test('same socket starts a fresh search at its ticket expiry before the next tick', async () => {
  let now = 0;
  const { join, released, service } = setup({ clock: () => now });
  const session = client('dev-returning');
  await join(session, 'first');
  const firstClaim = session.claim, firstTicket = session.queued;
  now = 179999;
  await join(session, 'early');
  assert.equal(session.socket.messages.at(-1).code, 'already_joining');
  assert.equal(session.queued, firstTicket);
  assert.deepEqual(released, []);

  now = 180000;
  const boundary = session.socket.messages.length;
  await join(session, 'again');
  assert.deepEqual(session.socket.messages.slice(boundary).map(m => [m.requestId, m.status]), [
    ['first', 'expired'], ['again', 'authenticating'], ['again', 'searching']
  ]);
  assert.equal(session.queued.queuedAt, now);
  assert.notEqual(session.claim, firstClaim);
  assert.equal(released.length, 1);
  assert.equal(released[0], firstClaim);
  service.tick();
  assert.equal(session.socket.messages.filter(m => m.status === 'expired').length, 1);
  assert.equal(service.size, 1);
});
