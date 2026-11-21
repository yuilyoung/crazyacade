import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueueSessions } from '../src/queue-sessions.js';

test('a closing queued socket frees capacity for the next admission before the next tick', async () => {
  const service = createQueueSessions({
    capacity: 1, demoMode: true, gate: { run: task => task() },
    send: (socket, message) => socket.messages.push(message),
    begin: (session, kind, requestId) => session.operation = { kind, requestId, controller: new AbortController() },
    current: (session, operation) => session.operation === operation,
    finish: session => { session.operation = null; },
    acquireClaim: (session, id) => session.claim = { id },
    releaseClaim: session => { session.claim = null; },
    isDraining: () => false, canAssign: () => false
  });
  const session = id => ({ demoUser: { id }, socket: { OPEN: 1, readyState: 1, messages: [] } });
  const first = session('dev-first'), replacement = session('dev-replacement');
  const join = (client, requestId) => service.join(client, { type: 'queue_join', requestId });

  await join(first, 'initial');
  await join(replacement, 'full');
  assert.equal(replacement.socket.messages.at(-1).code, 'queue_full');

  first.socket.readyState = 2; // WebSocket.CLOSING, before its close event arrives.
  await join(replacement, 'retry');
  assert.equal(replacement.socket.messages.at(-1).status, 'searching');
  assert.equal(replacement.socket.messages.at(-1).requestId, 'retry');
  assert.equal(first.queued, null);
  assert.equal(first.claim, null);
  assert.equal(service.size, 1);
});
