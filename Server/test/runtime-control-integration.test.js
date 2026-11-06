import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setup, waitFor } from './fixtures/relay-server.mjs';

test('actual server limits native control floods while healthy game ticks and JSON pings continue', { timeout: 15000 }, async t => {
  const server = await setup(t), players = [];
  for (let index = 0; index < 8; index++) players.push(await server.join({ roomId: 'native-control', mode: 'team', ruleSet: 'relay' }));
  await waitFor(() => players.every(player => player.state?.phase === 'playing'));
  for (const method of ['ping', 'pong']) {
    const attacker = await server.connect(), closed = once(attacker.ws, 'close');
    const tickBefore = players[0].state.tick;
    for (let count = 0; count < 100; count++) attacker.ws[method]('native flood');
    assert.equal((await closed)[0], 1008);
    const messagesBefore = players[0].messages.length;
    players[0].ws.send(JSON.stringify({ type: 'ping' }));
    await waitFor(() => players[0].messages.slice(messagesBefore).some(message => message.type === 'pong'));
    await waitFor(() => players.every(player => player.state.tick > tickBefore));
    assert.ok(players.every(player => player.ws.readyState === player.ws.OPEN));
  }
  const metrics = await fetch(`http://127.0.0.1:${server.port}/health/runtime`).then(response => response.json());
  assert.equal(metrics.rateLimitedSockets, 2);
  assert.equal(metrics.connections, 8);
  assert.equal(metrics.rooms, 1);
});
