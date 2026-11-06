import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setup, send, waitFor, close } from './fixtures/relay-server.mjs';

async function rankedProvider(t) {
  const control = { holdAuth: false, holdProfile: false, failProfile: false, pending: [], requests: [], ratings: new Map() };
  const http = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    control.requests.push({ path: req.url, method: req.method, body });
    const isAuth = req.url === '/auth/v1/user', isProfile = req.method === 'GET' && req.url.startsWith('/rest/v1/profiles');
    const reply = () => {
      if (isProfile && control.failProfile) { res.writeHead(503); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      const id = isAuth ? req.headers.authorization.slice(7) : new URL(req.url, 'http://test').searchParams.get('id')?.slice(3);
      res.end(JSON.stringify(isAuth ? { id, user_metadata: {} } : isProfile ? [{ id, rating: control.ratings.get(id) ?? 1000 }] : []));
    };
    if ((isAuth && control.holdAuth) || (isProfile && control.holdProfile)) control.pending.push(reply); else reply();
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(() => { control.release(); http.closeAllConnections(); http.close(); });
  control.release = () => { for (const reply of control.pending.splice(0)) reply(); };
  control.env = { ALLOW_DEV_GUESTS: 'false', SUPABASE_URL: `http://127.0.0.1:${http.address().port}`, SUPABASE_ANON_KEY: 'public', SUPABASE_SERVICE_ROLE_KEY: 'private', RUNTIME_DRAIN_MS: '20' };
  return control;
}
const latestQueue = client => client.messages.findLast(m => m.type === 'queue_state');
async function queue(client, requestId, fields = {}) {
  send(client, 'queue_join', { requestId, ...fields });
  await waitFor(() => latestQueue(client)?.status === 'searching' || client.messages.some(m => m.type === 'error' && m.requestId === requestId));
  return latestQueue(client);
}

test('queue validates authority fields before auth and uses only private server rating', async t => {
  const auth = await rankedProvider(t), server = await setup(t, auth.env), client = await server.connect();
  send(client, 'queue_join', { requestId: 'forged', accessToken: 'alice', rating: 1 });
  await waitFor(() => client.messages.some(m => m.code === 'invalid_queue'));
  assert.equal(auth.requests.length, 0);
  auth.ratings.set('alice', 1380);
  const state = await queue(client, 'rated', { accessToken: 'alice' });
  assert.equal(state.rating, 1380); assert.equal(state.tier, 'Gold'); assert.equal(state.source, 'supabase');
  assert.equal(state.requiredPlayers, 8); assert.equal(state.searchRadius, 100);
  assert.doesNotMatch(JSON.stringify(state), /alice|accessToken|private/);
  send(client, 'queue_cancel', { requestId: 'rated' });
  await waitFor(() => latestQueue(client)?.status === 'cancelled');
});

test('cancelled authentication cannot enqueue late and releases the global identity claim', async t => {
  const auth = await rankedProvider(t), server = await setup(t, auth.env), first = await server.connect();
  auth.holdAuth = true;
  send(first, 'queue_join', { requestId: 'old', accessToken: 'alice' });
  await waitFor(() => auth.pending.length === 1);
  send(first, 'queue_cancel', { requestId: 'old' });
  await waitFor(() => latestQueue(first)?.status === 'cancelled');
  auth.holdAuth = false;
  await queue(first, 'new', { accessToken: 'alice' });
  auth.release();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(latestQueue(first).requestId, 'new'); assert.equal(latestQueue(first).status, 'searching');
  const duplicate = await server.connect();
  await queue(duplicate, 'duplicate', { accessToken: 'alice' });
  assert.ok(duplicate.messages.some(m => m.code === 'already_in_room'));
  assert.equal((await server.sendJoin(duplicate, { roomId: 'bypass', accessToken: 'alice' })).code, 'already_in_room');
  await close(first);
  assert.equal((await server.sendJoin(duplicate, { roomId: 'released', accessToken: 'alice' })).type, 'joined');
});

test('eight humans are assigned atomically into protected balanced rooms without bots', async t => {
  const auth = await rankedProvider(t), server = await setup(t, auth.env), clients = [];
  for (let i = 0; i < 8; i++) { const c = await server.connect(); clients.push(c); await queue(c, `request-${i}`, { accessToken: `human-${i}` }); }
  await waitFor(() => clients.every(c => c.state?.phase === 'playing'));
  const state = clients[0].state;
  assert.equal(state.players.length, 8); assert.equal(state.itemMode, true); assert.equal(state.ruleSet, 'classic');
  assert.deepEqual(state.matchmaking, { source: 'supabase', requiredPlayers: 8 });
  assert.equal(state.players.some(p => p.isBot), false);
  assert.equal(state.players.filter(p => p.team === 'blue').length, 4);
  assert.equal(clients[0].messages.find(m => m.type === 'joined').requestId, 'request-0');
  const intruder = await server.connect();
  assert.equal((await server.sendJoin(intruder, { roomId: state.roomId, mode: 'team', accessToken: 'intruder' })).code, 'room_unavailable');
});

test('closing a queued socket releases its place before assignment and capacity returns after cancel', async t => {
  const server = await setup(t, { RUNTIME_MAX_QUEUED_PLAYERS: '2', RUNTIME_DRAIN_MS: '20' });
  const first = await server.connect(), second = await server.connect(), third = await server.connect();
  await queue(first, 'first'); await queue(second, 'second'); await queue(third, 'full');
  assert.ok(third.messages.some(m => m.code === 'queue_full'));
  await close(first);
  await queue(third, 'reused');
  assert.equal(latestQueue(third).status, 'searching');
  send(second, 'queue_cancel', { requestId: 'second' });
  await waitFor(() => latestQueue(second).status === 'cancelled');
  const diagnostics = await (await fetch(`http://127.0.0.1:${server.port}/health/runtime`)).json();
  assert.equal(diagnostics.queuedPlayers, 1);
});

test('profile cancellation releases ownership without allowing a late reply to clear a new claim', async t => {
  const auth = await rankedProvider(t), server = await setup(t, auth.env), first = await server.connect(), second = await server.connect();
  auth.holdProfile = true;
  send(first, 'queue_join', { requestId: 'old-profile', accessToken: 'alice' });
  await waitFor(() => auth.pending.length === 1);
  send(first, 'queue_cancel', { requestId: 'old-profile' });
  await waitFor(() => latestQueue(first)?.status === 'cancelled');
  auth.holdProfile = false;
  await queue(second, 'new-owner', { accessToken: 'alice' });
  auth.release();
  await new Promise(resolve => setTimeout(resolve, 30));
  await queue(first, 'duplicate-again', { accessToken: 'alice' });
  assert.ok(first.messages.some(m => m.requestId === 'duplicate-again' && m.code === 'already_in_room'));
  assert.equal(latestQueue(second).status, 'searching');
});

test('missing service profile credentials fail closed instead of inventing a production rating', async t => {
  const auth = await rankedProvider(t), server = await setup(t, { ...auth.env, SUPABASE_SERVICE_ROLE_KEY: '' }), client = await server.connect();
  await queue(client, 'unconfigured', { accessToken: 'alice' });
  assert.ok(client.messages.some(m => m.code === 'profile_unavailable'));
  assert.equal(client.messages.some(m => m.type === 'queue_state' && m.status === 'searching'), false);
});

test('next-match cancellation and profile failures retain the result room while rematch votes are protected', async t => {
  const auth = await rankedProvider(t), server = await setup(t, auth.env, { tickMs: 1 }), clients = [];
  for (let i = 0; i < 8; i++) { const c = await server.connect(); clients.push(c); await queue(c, `initial-${i}`, { accessToken: `player-${i}` }); }
  await waitFor(() => clients.every(c => c.state?.phase === 'finished'));
  const first = clients[0], original = first.state, matchId = original.matchId;
  await waitFor(() => first.state.resultSaving?.status === 'saved');
  send(first, 'rematch', { matchId });
  await waitFor(() => first.state.rematch.readyPlayerIds.includes(first.playerId));
  const count = first.messages.filter(m => m.type === 'state').length;
  send(first, 'rematch', { matchId });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(first.messages.filter(m => m.type === 'state').length, count);
  auth.holdProfile = true;
  send(first, 'next_match', { requestId: 'cancel-next', matchId });
  await waitFor(() => auth.pending.length === 1);
  for (const client of clients.slice(1)) send(client, 'rematch', { matchId });
  await waitFor(() => first.state.rematch.readyPlayerIds.length === 7);
  send(first, 'rematch', { matchId, ready: true });
  await waitFor(() => first.messages.some(m => m.code === 'already_joining'));
  assert.equal(first.state.matchId, matchId);
  send(first, 'queue_cancel', { requestId: 'cancel-next' });
  await waitFor(() => latestQueue(first)?.status === 'cancelled');
  auth.holdProfile = false; auth.release();
  auth.failProfile = true;
  send(first, 'next_match', { requestId: 'failed-next', matchId });
  await waitFor(() => first.messages.some(m => m.code === 'profile_unavailable' && m.requestId === 'failed-next'));
  assert.equal(first.state.roomId, original.roomId); assert.equal(first.state.matchId, matchId);
  auth.failProfile = false; auth.ratings.set('player-0', 1111);
  send(first, 'next_match', { requestId: 'refreshed-next', matchId });
  await waitFor(() => latestQueue(first)?.requestId === 'refreshed-next' && latestQueue(first).status === 'searching');
  assert.equal(latestQueue(first).rating, 1111);
  await waitFor(() => clients[1].state.players.length === 7);
  assert.equal(clients[1].state.phase, 'finished'); assert.equal(clients[1].state.matchId, matchId);
  const intruder = await server.connect();
  assert.equal((await server.sendJoin(intruder, { roomId: original.roomId, mode: 'team', accessToken: 'intruder' })).code, 'room_unavailable');
  const duplicate = await server.connect();
  assert.equal((await server.sendJoin(duplicate, { roomId: 'claim-bypass', accessToken: 'player-0' })).code, 'already_in_room');
});

test('room capacity preserves queued wait time and a closing candidate is removed before assignment', async t => {
  const server = await setup(t, { RUNTIME_MAX_ROOMS: '1' }), owner = await server.join({ roomId: 'held-room', mode: 'team' }), clients = [];
  for (let i = 0; i < 8; i++) { const c = await server.connect(); clients.push(c); await queue(c, `waiting-${i}`); }
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(clients.some(c => c.playerId), false);
  await close(clients[0]); await close(owner);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(clients.slice(1).some(c => c.playerId), false);
  const replacement = await server.connect(); await queue(replacement, 'replacement');
  await waitFor(() => clients.slice(1).every(c => c.state?.phase === 'playing'));
  assert.equal(replacement.state.players.length, 8);
});

test('concurrent eight joins never send cancellation after successful assignment', async t => {
  const server = await setup(t), clients = await Promise.all(Array.from({ length: 8 }, () => server.connect()));
  clients.forEach((client, index) => send(client, 'queue_join', { requestId: `concurrent-${index}` }));
  await waitFor(() => clients.every(client => client.playerId));
  await new Promise(resolve => setTimeout(resolve, 40));
  for (const client of clients) {
    const joinedAt = client.messages.findIndex(m => m.type === 'joined');
    assert.equal(client.messages.slice(joinedAt).some(m => m.type === 'queue_state' && m.status === 'cancelled'), false);
  }
});

test('queue cancellation requires its current request identity and rejects malformed commands', async t => {
  const server = await setup(t), client = await server.connect(); await queue(client, 'owned');
  send(client, 'queue_cancel', { requestId: null });
  await waitFor(() => client.messages.some(m => m.code === 'invalid_queue'));
  assert.equal(latestQueue(client).status, 'searching');
  send(client, 'queue_cancel', { requestId: 'other' });
  send(client, 'ping'); await waitFor(() => client.messages.some(m => m.type === 'pong'));
  assert.equal(latestQueue(client).status, 'searching');
});

test('matched rematch retains all original players and teams and resume omits obsolete assignment correlation', async t => {
  const server = await setup(t, {}, { tickMs: 1 }), clients = [];
  for (let i = 0; i < 8; i++) { const client = await server.connect(); clients.push(client); await queue(client, `rematch-${i}`); }
  await waitFor(() => clients.every(c => c.state?.phase === 'finished'));
  const original = clients[0].state, credentials = clients[0].messages.find(m => m.type === 'joined');
  await close(clients[0]);
  for (const client of clients.slice(1)) send(client, 'rematch', { matchId: original.matchId });
  await waitFor(() => clients[1].state.rematch.readyPlayerIds.length === 7);
  assert.equal(clients[1].state.matchId, original.matchId);
  const resumed = await server.connect();
  send(resumed, 'resume', { roomId: credentials.roomId, playerId: credentials.playerId, resumeToken: credentials.resumeToken });
  await waitFor(() => resumed.messages.some(m => m.type === 'joined'));
  const reply = resumed.messages.find(m => m.type === 'joined');
  assert.equal(reply.resumed, true); assert.equal(reply.requestId, undefined);
  send(resumed, 'rematch', { matchId: original.matchId, ready: true });
  await waitFor(() => resumed.state?.round === 1);
  assert.equal(resumed.state.phase, 'playing');
  assert.deepEqual(resumed.state.players.map(p => [p.id, p.team]), original.players.map(p => [p.id, p.team]));
  assert.notEqual(resumed.state.matchId, original.matchId);
  send(resumed, 'rematch', { matchId: original.matchId });
  send(resumed, 'next_match', { requestId: 'stale-next', matchId: original.matchId });
  await waitFor(() => resumed.messages.some(m => m.code === 'stale_match'));
});
