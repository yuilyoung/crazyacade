import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readdir } from 'node:fs/promises';
import { setup, provider, send, waitFor, close } from './fixtures/relay-server.mjs';

test('SIGTERM drains active matches, cancels queues and persists the completed result', async t => {
  const auth = await provider(t), server = await setup(t, { ...auth.env, ALLOW_DEV_GUESTS: 'false', RUNTIME_DRAIN_MS: '5000' }, { tickMs: 1 });
  const first = await server.join({ roomId: 'drain', accessToken: 'one' }), second = await server.join({ roomId: 'drain', accessToken: 'two' });
  const idle = await server.connect();
  const exited = once(server.proc, 'exit');
  const initialTick = second.state.tick;
  server.proc.kill('SIGTERM');
  await waitFor(() => first.messages.some(m => m.type === 'state' && m.tick > initialTick));
  const readiness = await fetch(`http://127.0.0.1:${server.port}/health/ready`);
  assert.equal(readiness.status, 503);
  send(idle, 'join', { roomId: 'new', accessToken: 'three' });
  await waitFor(() => idle.messages.some(m => m.code === 'server_draining'));
  send(first, 'rematch');
  await waitFor(() => first.messages.some(m => m.code === 'server_draining'));
  const [code, signal] = await exited;
  assert.equal(code, 0); assert.equal(signal, null);
  const records = await readdir(server.outboxDirectory);
  assert.ok(auth.requests.some(request => request.path === '/rest/v1/rpc/record_match') || records.some(name => name.endsWith('.json')));
});

test('forced drain cutoff does not synthesize wins from sockets terminated during shutdown', async t => {
  const auth = await provider(t), server = await setup(t, { ...auth.env, ALLOW_DEV_GUESTS: 'false', RUNTIME_DRAIN_MS: '30' });
  await server.join({ roomId: 'cut', accessToken: 'one' });
  const second = await server.join({ roomId: 'cut', accessToken: 'two' });
  assert.equal(second.state.phase, 'playing');
  const exited = once(server.proc, 'exit'); server.proc.kill('SIGTERM');
  assert.equal((await exited)[0], 0);
  assert.equal(auth.requests.some(request => request.path === '/rest/v1/rpc/record_match'), false);
  assert.equal((await readdir(server.outboxDirectory)).some(name => name.endsWith('.json')), false);
});

test('drain keeps an existing player recovery available while new sessions are rejected', async t => {
  const auth = await provider(t), server = await setup(t, { ...auth.env, ALLOW_DEV_GUESTS: 'false', RUNTIME_DRAIN_MS: '2000' });
  const first = await server.join({ roomId: 'recover-drain', accessToken: 'one', reconnect: true });
  await server.join({ roomId: 'recover-drain', accessToken: 'two' });
  const replacement = await server.connect(), credentials = first.messages.find(m => m.type === 'joined');
  await close(first);
  server.proc.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 30));
  send(replacement, 'resume', { roomId: credentials.roomId, playerId: credentials.playerId, resumeToken: credentials.resumeToken, accessToken: 'one' });
  await waitFor(() => replacement.messages.some(m => m.type === 'joined' || m.type === 'error'));
  assert.equal(replacement.messages.find(m => m.type === 'joined' || m.type === 'error').type, 'joined');
});

test('SIGTERM explicitly cancels a searching demo queue and exits without active games', async t => {
  const server = await setup(t), client = await server.connect();
  send(client, 'queue_join', { requestId: 'drain-queue' });
  await waitFor(() => client.messages.some(m => m.status === 'searching'));
  const exited = once(server.proc, 'exit'); server.proc.kill('SIGTERM');
  assert.equal((await exited)[0], 0);
  assert.ok(client.messages.some(m => m.type === 'queue_state' && m.requestId === 'drain-queue' && m.status === 'cancelled'));
});
