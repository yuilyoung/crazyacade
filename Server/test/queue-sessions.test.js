import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAsyncGate } from '../src/async-gate.js';
import { createQueueSessions } from '../src/queue-sessions.js';

test('concurrent queue admissions never cancel a player after the room adapter has assigned them', async () => {
  const sessions = Array.from({ length: 8 }, (_, index) => ({
    socket: { OPEN: 1, readyState: 1, messages: [] },
    demoUser: { id: `dev-concurrent-${index}`, user_metadata: {} },
    player: null, queued: null, operation: null, claim: null
  }));
  const gate = createAsyncGate({ capacity: 4, maxPending: 32 });
  const assignments = [];
  const send = (socket, message) => socket.messages.push(message);
  const service = createQueueSessions({
    capacity: 128, demoMode: true, gate, send,
    begin(session, kind, requestId) {
      return session.operation = { kind, requestId, controller: new AbortController() };
    },
    current: (session, operation) => session.operation === operation,
    finish(session, operation) { if (session.operation === operation) session.operation = null; },
    cancelOperation(session) { session.operation?.controller.abort(); session.operation = null; },
    acquireClaim(session, userId) { session.claim = { userId, session }; return true; },
    releaseClaim() {},
    canAssign: () => assignments.length === 0,
    assign(selection) {
      assignments.push(selection);
      for (const [index, entry] of selection.players.entries()) {
        entry.session.player = { id: `assigned-${index}` };
        send(entry.session.socket, { type: 'joined', requestId: entry.requestId, playerId: entry.session.player.id });
      }
      return true;
    },
    removePlayer() {}, broadcast() {}, isDraining: () => false
  });

  // A real bounded gate begins queued tasks before all earlier callers have
  // resumed from await. The final four admissions can be assigned before their
  // own join finally blocks run, even though their tickets have been removed.
  await Promise.all(sessions.map((session, index) => service.join(session, {
    type: 'queue_join', requestId: `concurrent-${index}`
  })));

  assert.equal(assignments.length, 1);
  assert.equal(service.size, 0);
  for (const session of sessions) {
    assert.ok(session.player);
    const messages = session.socket.messages;
    const assignedAt = messages.findIndex(message => message.type === 'joined');
    assert.ok(assignedAt >= 0);
    assert.deepEqual(messages.slice(assignedAt + 1).filter(message => message.type === 'queue_state' && message.status === 'cancelled'), [],
      `Assigned player ${session.player.id} must remain in their room`);
  }
  assert.equal(gate.snapshot().active, 0);
});
