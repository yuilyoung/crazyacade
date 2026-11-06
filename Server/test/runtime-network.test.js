import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { createRuntime } from '../src/runtime.js';

async function waitFor(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Socket condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function setup(t, options) {
  const runtime = createRuntime(options), peers = [], clients = [];
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong: false });
  wss.on('connection', peer => {
    peers.push(peer);
    if (!runtime.admitSocket(peer)) return;
    peer.on('message', message => {
      if (runtime.allowMessage(peer)) runtime.send(peer, message.toString());
    });
    peer.on('ping', data => { if (runtime.allowMessage(peer)) runtime.pong(peer, data); });
    peer.on('pong', () => runtime.allowMessage(peer));
  });
  await once(wss, 'listening');
  t.after(async () => {
    for (const client of clients) client.terminate();
    runtime.close();
    for (const peer of wss.clients) peer.terminate();
    await new Promise(resolve => wss.close(resolve));
  });
  async function connect() {
    const client = new WebSocket(`ws://127.0.0.1:${wss.address().port}`);
    clients.push(client);
    const messages = [];
    client.on('message', raw => messages.push(raw.toString()));
    await once(client, 'open');
    return { client, messages, peer: peers.at(-1) };
  }
  return { runtime, connect };
}

test('real socket flood is receive-capped and closed while another peer still receives replies', { timeout: 5000 }, async t => {
  const { runtime, connect } = await setup(t, { clock: () => 0 });
  const bad = await connect(), good = await connect();
  const badClosed = once(bad.client, 'close');
  for (let index = 0; index < 100; index++) bad.client.send(`flood-${index}`);
  assert.equal((await badClosed)[0], 1008);
  assert.equal(bad.messages.length, 60);
  good.client.send('healthy');
  await waitFor(() => good.messages.includes('healthy'));
  assert.equal(runtime.snapshot().rateLimitedSockets, 1);
  assert.equal(runtime.snapshot().connections, 1);
});

test('native ping and unsolicited pong floods share receive limits while healthy peers progress', { timeout: 5000 }, async t => {
  const { runtime, connect } = await setup(t, { clock: () => 0 });
  const good = await connect();
  for (const method of ['ping', 'pong']) {
    const bad = await connect();
    const closed = once(bad.client, 'close');
    for (let count = 0; count < 100; count++) bad.client[method]('control');
    assert.equal((await closed)[0], 1008);
    good.client.send(method);
    await waitFor(() => good.messages.includes(method));
  }
  assert.equal(runtime.snapshot().rateLimitedSockets, 2);
  assert.equal(runtime.snapshot().connections, 1);
});

test('outgoing control frames enforce payload bounds and leave inbound allowance untouched', { timeout: 5000 }, async t => {
  const { runtime, connect } = await setup(t, { clock: () => 0 });
  const healthy = await connect();
  const receivedPing = once(healthy.client, 'ping');
  assert.equal(runtime.ping(healthy.peer, 'heartbeat'), true);
  assert.equal(runtime.snapshot().messagesAccepted, 0);
  assert.equal((await receivedPing)[0].toString(), 'heartbeat');
  const receivedPong = once(healthy.client, 'pong');
  assert.equal(runtime.pong(healthy.peer, Buffer.alloc(125, 'x')), true);
  assert.equal((await receivedPong)[0].length, 125);
  assert.equal(runtime.ping(healthy.peer, Buffer.alloc(126)), false);
  assert.equal(runtime.pong(healthy.peer, Buffer.alloc(126)), false);
  assert.equal(runtime.ping(healthy.peer, 'é'.repeat(63)), false);
  assert.equal(healthy.client.readyState, WebSocket.OPEN);
  runtime.releaseSocket(healthy.peer);
  assert.equal(runtime.ping(healthy.peer), false);
  assert.equal(runtime.pong(healthy.peer), false);
});

test('native control replies cannot grow a paused reader backlog beyond the hard bound', { timeout: 5000 }, async t => {
  const { runtime, connect } = await setup(t);
  const slow = await connect(), good = await connect(); slow.client._socket.pause();
  let rejected = false;
  for (let count = 0; count < 100000; count++) {
    if (!runtime.pong(slow.peer, Buffer.alloc(125))) { rejected = true; break; }
  }
  assert.equal(rejected, true);
  assert.equal(runtime.snapshot().slowSockets, 1);
  assert.ok(slow.peer.bufferedAmount <= 262144 + 128);
  assert.equal(runtime.ping(slow.peer), false);
  good.client.send('still healthy');
  await waitFor(() => good.messages.includes('still healthy'));
  await waitFor(() => slow.peer.readyState === WebSocket.CLOSED);
  assert.equal(runtime.snapshot().connections, 1);
  slow.client._socket.resume();
});

test('real socket capacity rejects an extra peer and immediately allows replacement after release', { timeout: 5000 }, async t => {
  const { runtime, connect } = await setup(t, { limits: { maxConnections: 1 } });
  const first = await connect(), extra = await connect();
  assert.equal((await once(extra.client, 'close'))[0], 1013);
  assert.equal(runtime.snapshot().connections, 1);
  first.client.close(); await once(first.client, 'close');
  const replacement = await connect(); replacement.client.send('new peer');
  await waitFor(() => replacement.messages.includes('new peer'));
  assert.equal(runtime.snapshot().connections, 1);
});

test('a paused real reader triggers state skipping and deadline eviction without blocking a healthy peer', { timeout: 8000 }, async t => {
  const { runtime, connect } = await setup(t, { limits: { sendMaxDelayMs: 100 } });
  const slow = await connect(), good = await connect();
  slow.client._socket.pause();
  const state = JSON.stringify({ type: 'state', padding: 'x'.repeat(16384) });
  let skipped = false;
  for (let index = 0; index < 4096; index++) {
    if (!runtime.send(slow.peer, state, { replaceable: true })) { skipped = true; break; }
  }
  assert.equal(skipped, true, 'the actual kernel/socket backlog reaches the soft bound');
  assert.ok(slow.peer.bufferedAmount >= 65536);
  assert.ok(slow.peer.bufferedAmount < 262144);
  const buffered = slow.peer.bufferedAmount;
  assert.equal(runtime.send(slow.peer, state, { replaceable: true }), false);
  assert.equal(slow.peer.bufferedAmount, buffered);
  good.client.send('healthy during pressure');
  await waitFor(() => good.messages.includes('healthy during pressure'));
  await waitFor(() => slow.peer.readyState === WebSocket.CLOSED);
  assert.equal(runtime.snapshot().slowSockets, 1);
  assert.equal(runtime.snapshot().connections, 1);
  assert.ok(runtime.snapshot().stateSkipped >= 2);
  slow.client._socket.resume();
});

test('control replies to a paused real reader are hard-bounded instead of accumulating indefinitely', { timeout: 5000 }, async t => {
  const { runtime, connect } = await setup(t);
  const slow = await connect(); slow.client._socket.pause();
  let rejected = false;
  for (let index = 0; index < 4096; index++) {
    if (!runtime.send(slow.peer, 'x'.repeat(16384))) { rejected = true; break; }
  }
  assert.equal(rejected, true);
  assert.equal(runtime.snapshot().slowSockets, 1);
  assert.ok(slow.peer.bufferedAmount <= 262144 + 128, 'backlog includes a bounded closing frame');
  await waitFor(() => slow.peer.readyState === WebSocket.CLOSED);
  assert.equal(runtime.snapshot().connections, 0);
  slow.client._socket.resume();
});
