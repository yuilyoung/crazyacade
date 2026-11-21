import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, waitFor } from './fixtures/relay-server.mjs';

test('friends see all three equipped cat skins and start with the same combat stats', async t => {
  const server = await setup(t);
  const choices = [['momo', 'cat'], ['nori', 'tabby'], ['bibi', 'tuxedo'], ['toto', 'classic']];
  const clients = [];
  for (const [characterId, skinId] of choices) {
    clients.push(await server.join({ roomId: 'cat-collection', mode: 'team', humanSlots: 4, characterId, skinId }));
  }
  await waitFor(() => clients.every(client => client.state?.phase === 'playing'));
  for (const viewer of clients) {
    for (const [index, participant] of clients.entries()) {
      const player = viewer.state.players.find(p => p.id === participant.playerId);
      assert.deepEqual([player.characterId, player.skinId], choices[index]);
      assert.deepEqual([player.maxOrbs, player.range, player.speedLevel, player.darts], [1, 3, 0, 0]);
    }
  }
});
