import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, send, waitFor } from './fixtures/relay-server.mjs';

test('a WebSocket release never moves a resting player and a quick tap takes one step', async t => {
  const { join } = await setup(t);
  const room = { roomId: 'movement-input', mode: 'duel', itemMode: false };
  const client = await join(room);
  await join(room);
  await waitFor(() => client.state.phase === 'playing');
  const player = () => client.state.players.find(p => p.id === client.playerId);
  const start = player().x;
  async function waitForInputToSettle() {
    const first = client.messages.length;
    send(client, 'ping');
    await waitFor(() => client.messages.slice(first).some(message => message.type === 'pong'));
    const settledTick = client.state.tick + player().moveCooldownTicks + 1;
    await waitFor(() => client.state.tick >= settledTick);
  }

  send(client, 'input', { action: 'right', phase: 'release' });
  await waitForInputToSettle();
  assert.equal(player().x, start);
  send(client, 'input', { action: 'right' });
  send(client, 'input', { action: 'right', phase: 'release' });
  await waitForInputToSettle();
  assert.equal(player().x, start + 1);
  send(client, 'input', { action: 'left', phase: 'repeat' });
  await waitForInputToSettle();
  assert.equal(player().x, start);
});
