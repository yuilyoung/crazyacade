import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeMatch, getLeaderboard } from '../src/rankings.js';
import { finishScores } from '../src/combat.js';
import { setup, provider, waitFor, send, close } from './fixtures/relay-server.mjs';

test('malformed rules and relay duel are rejected before authentication or profile writes', async t => {
  const auth = await provider(t);
  const { connect, sendJoin } = await setup(t, { ...auth.env, ALLOW_DEV_GUESTS: 'false' });
  for (const ruleSet of [null, true, 0, [], {}, '', 'unknown']) {
    const client = await connect();
    assert.equal((await sendJoin(client, { ruleSet, accessToken: 'must-not-auth' })).code, 'invalid_rule_set');
  }
  const client = await connect();
  assert.equal((await sendJoin(client, { ruleSet: 'relay', mode: 'duel', accessToken: 'must-not-auth' })).code, 'invalid_rule_mode');
  assert.equal(auth.requests.length, 0);
});

test('classic defaults, omitted relay rules inherit, and explicit mismatches are rejected', async t => {
  const { join, connect, sendJoin } = await setup(t);
  const classic = await join({ roomId: 'classic' });
  assert.equal(classic.state.ruleSet, 'classic');
  assert.equal(classic.state.ranked, true);
  assert.equal(classic.state.relay, null);
  assert.equal(classic.state.matchId, null);
  assert.equal(classic.state.round, 0);
  assert.deepEqual(classic.state.rematch, { readyPlayerIds: [], total: 1 });
  const relay = await join({ roomId: 'relay', mode: 'team', ruleSet: 'relay', mapId: 'candy', itemMode: false });
  const inherited = await join({ roomId: 'relay', mode: 'team' });
  assert.equal(inherited.state.ruleSet, 'relay');
  assert.equal(inherited.state.mapId, 'candy');
  assert.equal(inherited.state.itemMode, false);
  assert.equal(inherited.state.ranked, false);
  assert.deepEqual(inherited.state.relay, { scores: { blue: 0, pink: 0 }, goal: 3, charges: { passes: 0, rescue: 0, total: 0 }, passCooldownTicks: 0, passEffects: [], star: { x: 7, y: 6 }, carrierId: null, respawnTicks: 0, bases: { blue: { x: 1, y: 6 }, pink: { x: 13, y: 6 } } });
  assert.ok(inherited.state.players.every(p => p.deliveries === 0 && p.respawnTicks === 0));
  const mismatch = await connect();
  assert.equal((await sendJoin(mismatch, { roomId: relay.state.roomId, mode: 'team', ruleSet: 'classic' })).code, 'rule_set_mismatch');
});

test('relay keeps production authentication while practice forces team and remains private', async t => {
  const { join, connect, sendJoin } = await setup(t, { ALLOW_DEV_GUESTS: 'false' });
  const unauthorized = await connect();
  assert.equal((await sendJoin(unauthorized, { mode: 'team', ruleSet: 'relay' })).code, 'unauthorized');
  const practice = await join({ practice: true, mode: 'duel', ruleSet: 'relay' });
  assert.equal(practice.state.mode, 'team');
  assert.equal(practice.state.ruleSet, 'relay');
  assert.equal(practice.state.ranked, false);
  assert.equal(practice.state.players.length, 8);
  assert.equal(practice.state.players.filter(p => p.isBot).length, 7);
  const intruder = await connect();
  assert.equal((await sendJoin(intruder, { roomId: practice.state.roomId, mode: 'team', ruleSet: 'relay', practice: true })).type, 'joined');
  assert.notEqual(intruder.state?.roomId, practice.state.roomId);
});

test('authenticated relay finishes with a forfeit only when an entire connected team leaves and writes no result', async t => {
  const auth = await provider(t);
  const { join } = await setup(t, { ...auth.env, ALLOW_DEV_GUESTS: 'false' });
  const clients = [];
  for (let i = 0; i < 8; i++) clients.push(await join({ accessToken: `verified-${i}`, roomId: 'relay-auth', mode: 'team', ruleSet: 'relay' }));
  await waitFor(() => clients[0].state.phase === 'playing');
  assert.match(clients[0].state.matchId, /^[0-9a-f-]{36}$/);
  const pink = clients.filter(c => c.state.players.find(p => p.id === c.playerId).team === 'pink');
  await close(pink[0]);
  await waitFor(() => clients[0].state.players.length === 7);
  assert.equal(clients[0].state.phase, 'playing');
  for (const client of pink.slice(1)) await close(client);
  await waitFor(() => clients[0].state.phase === 'finished');
  assert.equal(clients[0].state.result.reason, 'forfeit');
  assert.equal(clients[0].state.result.winnerTeam, 'blue');
  assert.deepEqual(clients[0].state.result.relayScores, { blue: 0, pink: 0 });
  assert.equal(clients[0].state.result.scoreboard.length, 8);
  assert.ok(clients[0].state.result.scoreboard.every(p => p.deliveries === 0));
  assert.equal(auth.requests.filter(r => r.path === '/auth/v1/user').length, 8);
  assert.equal(auth.requests.filter(r => r.path.startsWith('/rest/v1/profiles')).length, 8);
  assert.equal(auth.requests.filter(r => r.path === '/rest/v1/rpc/record_match').length, 0);
});

test('relay elimination respawns without ending the match or losing the bomb counter', async t => {
  const { join } = await setup(t, {}, { tickMs: 3 });
  const clients = [];
  for (let i = 0; i < 8; i++) clients.push(await join({ roomId: 'relay-respawn', mode: 'team', ruleSet: 'relay', itemMode: false }));
  const victim = clients[0];
  send(victim, 'input', { action: 'place_orb' });
  await waitFor(() => victim.messages.some(m => m.type === 'state' && m.players.some(p => p.id === victim.playerId && !p.alive)));
  const dead = victim.messages.find(m => m.type === 'state' && m.players.some(p => p.id === victim.playerId && !p.alive));
  assert.equal(dead.phase, 'playing');
  assert.equal(dead.players.find(p => p.id === victim.playerId).respawnTicks, 50);
  await waitFor(() => victim.state.tick > dead.tick && victim.state.players.find(p => p.id === victim.playerId).alive);
  const revived = victim.state.players.find(p => p.id === victim.playerId);
  assert.deepEqual([revived.x, revived.y, revived.bubbleTicks, revived.respawnTicks, revived.bombsPlaced], [1, 1, 0, 0, 1]);
  assert.equal(victim.state.phase, 'playing');
});

test('relay finalization skips demo ratings and scoreboard snapshots retain delivery counters', async () => {
  const player = { id: 'relay-demo', userId: 'dev-relay-demo', name: 'RelayOnly', team: 'blue', score: 450, deliveries: 3 };
  const room = { ruleSet: 'relay', matchId: 'relay-demo-match', roster: [player], result: { winnerTeam: 'blue' } };
  finishScores(room);
  assert.equal(room.result.scoreboard[0].deliveries, 3);
  await finalizeMatch(room, { ALLOW_DEV_GUESTS: 'true' });
  assert.equal((await getLeaderboard({ ALLOW_DEV_GUESTS: 'true' })).entries.some(p => p.name === 'RelayOnly'), false);
});
