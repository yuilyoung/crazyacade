import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, waitFor, send } from './fixtures/relay-server.mjs';
const legacy = { width: 13, height: 11 }, team = { width: 15, height: 13 };
function checkBoundary(state, expected) {
  assert.deepEqual(state.arena, expected);
  assert.deepEqual(Object.keys(state.arena).sort(), ['height', 'width']);
  assert.ok(state.solid.includes(`${expected.width - 1},${expected.height - 1}`));
  assert.ok(state.solid.every(cell => { const [x,y] = cell.split(',').map(Number); return x < expected.width && y < expected.height; }));
}
test('authoritative rooms select geometry for duel, team rules, bots, party and both guided modes', async t => {
  const { join } = await setup(t);
  checkBoundary((await join({ roomId: 'duel-geometry', mode: 'duel', arena: team })).state, legacy);
  for (const ruleSet of ['classic', 'relay', 'harmony']) {
    const human = await join({ roomId: `human-${ruleSet}`, mode: 'team', ruleSet, arena: legacy });
    checkBoundary(human.state, team);
    const practice = await join({ practice: true, mode: 'team', ruleSet });
    checkBoundary(practice.state, team); assert.equal(practice.state.players.length, 8);
    assert.deepEqual(practice.state.players.map(p => [p.x,p.y]), [[1,1],[13,1],[1,4],[13,4],[1,8],[13,8],[1,11],[13,11]]);
  }
  checkBoundary((await join({ roomId: 'shared-bots', mode: 'team', humanSlots: 2 })).state, team);
  checkBoundary((await join({ roomId: 'party-geometry', mode: 'team', seriesMode: 'party3' })).state, team);
  for (const trainingMode of ['classic', 'harmony']) {
    const guided = await join({ practice: true, training: true, trainingMode });
    checkBoundary(guided.state, legacy);
    send(guided, 'training_ready'); await waitFor(() => guided.state.training.status === 'active');
    if (trainingMode === 'harmony') {
      send(guided, 'input', { action: 'pass_star' }); await waitFor(() => guided.state.training.stage === 'intercept');
    } else {
      send(guided, 'input', { action: 'place_orb' });
      await waitFor(() => guided.state.training.attempts === 1, 6000);
      await waitFor(() => guided.state.training.status === 'ready');
    }
    checkBoundary(guided.state, legacy);
  }
});
