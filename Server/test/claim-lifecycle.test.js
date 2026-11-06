import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, send, waitFor, provider } from './fixtures/relay-server.mjs';
import { once } from 'node:events';

test('rematch removing a closing peer releases its account claim after the socket closes', { timeout: 8000 }, async t => {
  const auth = await provider(t);
  const preload = `const interval = globalThis.setInterval; let paused = false;
    process.on('message', value => { if (value === 'pause-ticks') { paused = true; process.send('paused'); } });
    globalThis.setInterval = (fn, ms, ...args) => interval(ms === 100 ? () => { if (!paused) fn(); } : fn, ms, ...args);`;
  const server = await setup(t, { ...auth.env, ALLOW_DEV_GUESTS: 'false' }, { tickMs: 1, ipc: true, preload });
  const first = await server.join({ roomId: 'race', accessToken: 'alice' });
  const second = await server.join({ roomId: 'race', accessToken: 'bob' });
  await waitFor(() => second.state?.phase === 'finished');
  const ack = once(server.proc, 'message'); server.proc.send('pause-ticks'); await ack;
  first.ws._socket.pause();
  for (let i = 0; i < 80; i++) send(first, 'ping');
  const runtime = async () => fetch(`http://127.0.0.1:${server.port}/health/runtime`).then(r => r.json());
  const deadline = Date.now() + 3000;
  while (!(await runtime()).rateLimitedSockets) {
    assert.ok(Date.now() < deadline, 'flooding socket did not enter the closing state');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  send(second, 'rematch', { matchId: second.state.matchId });
  await waitFor(() => second.state.phase === 'waiting');
  await new Promise(resolve => setTimeout(resolve, 350));
  first.ws._socket.resume();
  const replacement = await server.connect();
  const reply = await server.sendJoin(replacement, { roomId: 'new-room', accessToken: 'alice' });
  assert.equal(second.state.players.length, 1);
  assert.equal(reply.type, 'joined', 'removed account must be able to join again after socket closes');
});
