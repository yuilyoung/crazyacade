import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueueSessions } from '../src/queue-sessions.js';

test('a reconnect can reclaim its closing queue ticket while other slots are free', async () => {
  const claims = new Map();
  const queue = createQueueSessions({
    capacity: 3, demoMode: true, gate: { run: task => task() },
    send: (socket, message) => socket.messages.push(message),
    begin: (session, kind, requestId) => session.operation = { kind, requestId, controller: new AbortController() },
    current: (session, operation) => session.operation === operation,
    finish: session => { session.operation = null; },
    acquireClaim(session, id) {
      if (claims.has(id) && claims.get(id) !== session) return false;
      claims.set(id, session);
      session.claim = { id };
      return true;
    },
    releaseClaim(session) {
      if (session.operation || session.queued || session.player) return;
      if (claims.get(session.demoUser.id) === session) claims.delete(session.demoUser.id);
      session.claim = null;
    },
    isDraining: () => false, canAssign: () => false
  });
  const client = id => ({ demoUser: { id }, socket: { OPEN: 1, readyState: 1, messages: [] } });
  const old = client('dev-one'), other = client('dev-two'), reconnect = client('dev-one');
  const join = (session, requestId) => queue.join(session, { type: 'queue_join', requestId });
  await join(old, 'first');
  await join(other, 'neighbor');
  const otherTicket = other.queued;
  await join(reconnect, 'duplicate');
  assert.ok(reconnect.socket.messages.some(m => m.requestId === 'duplicate' && m.code === 'already_in_room'));
  assert.equal(claims.get('dev-one'), old);

  old.socket.readyState = 2;
  await join(reconnect, 'retry');
  assert.equal(reconnect.socket.messages.at(-1).status, 'searching');
  assert.equal(claims.get('dev-one'), reconnect);
  assert.equal(old.queued, null);
  assert.equal(other.queued, otherTicket);
  assert.equal(queue.size, 2);
});
