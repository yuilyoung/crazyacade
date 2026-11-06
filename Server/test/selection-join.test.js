import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createLayout } from '../src/catalog.js';

async function setup(t) {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const proc = spawn(process.execPath, ['src/index.js'], {
    env: { ...process.env, RUNTIME_DRAIN_MS: '20', PORT: String(port), SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '', ALLOW_DEV_GUESTS: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => proc.kill());
  await Promise.race([once(proc.stdout, 'data'), once(proc, 'exit').then(() => { throw Error('server exited'); })]);
  async function client() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`); await once(ws, 'open');
    const messages = []; ws.on('message', raw => messages.push(JSON.parse(raw)));
    t.after(() => ws.terminate());
    return { ws, messages };
  }
  async function waitFor(fn) {
    const end = Date.now() + 2000;
    while (!fn()) { if (Date.now() > end) throw Error('timed out waiting for server'); await new Promise(r => setTimeout(r, 10)); }
  }
  return { client, waitFor };
}

test('default and explicit selections appear in authoritative state', async t => {
  const { client, waitFor } = await setup(t);
  const first = await client();
  first.ws.send(JSON.stringify({ type: 'join', roomId: 'default' }));
  await waitFor(() => first.messages.some(m => m.type === 'state'));
  const state = first.messages.find(m => m.type === 'state');
  assert.equal(state.mapId, 'garden');
  assert.deepEqual(state.arena, { width: 13, height: 11 });
  assert.equal(state.players[0].characterId, 'momo');
  assert.equal(state.players[0].skinId, 'classic');
  const chosen = await client();
  chosen.ws.send(JSON.stringify({ type: 'join', roomId: 'chosen', mode: 'team', mapId: 'lagoon', characterId: 'nori', skinId: 'mint' }));
  await waitFor(() => chosen.messages.some(m => m.type === 'state'));
  const chosenState = chosen.messages.find(m => m.type === 'state');
  assert.equal(chosenState.mapId, 'lagoon');
  assert.deepEqual(chosenState.arena, { width: 15, height: 13 });
  assert.equal(chosenState.players[0].characterId, 'nori');
  assert.equal(chosenState.players[0].skinId, 'mint');
  assert.deepEqual(new Set(chosenState.soft), createLayout('lagoon', 'team').soft);
});

test('invalid selection is rejected and explicit map conflict is rejected while omitted map inherits', async t => {
  const { client, waitFor } = await setup(t);
  const invalid = await client();
  invalid.ws.send(JSON.stringify({ type: 'join', roomId: 'invalid', characterId: 'bogus' }));
  await waitFor(() => invalid.messages.some(m => m.type === 'error' || m.type === 'joined'));
  assert.equal(invalid.messages.some(m => m.type === 'joined'), false);
  assert.equal(invalid.messages.find(m => m.type === 'error').code, 'invalid_selection');
  for (const bad of [{ skinId: 'bogus' }, { mapId: 'bogus' }]) {
    const rejected = await client();
    rejected.ws.send(JSON.stringify({ type: 'join', roomId: 'invalid', ...bad }));
    await waitFor(() => rejected.messages.some(m => m.type === 'error' || m.type === 'joined'));
    assert.equal(rejected.messages.some(m => m.type === 'joined'), false);
    assert.equal(rejected.messages.find(m => m.type === 'error').code, 'invalid_selection');
  }
  const first = await client();
  first.ws.send(JSON.stringify({ type: 'join', roomId: 'shared', mode: 'team', mapId: 'candy' }));
  await waitFor(() => first.messages.some(m => m.type === 'joined'));
  const conflict = await client();
  conflict.ws.send(JSON.stringify({ type: 'join', roomId: 'shared', mode: 'team', mapId: 'garden' }));
  await waitFor(() => conflict.messages.some(m => m.type === 'error' || m.type === 'joined'));
  assert.equal(conflict.messages.some(m => m.type === 'joined'), false);
  assert.equal(conflict.messages.find(m => m.type === 'error').code, 'map_mismatch');
  const inheritor = await client();
  inheritor.ws.send(JSON.stringify({ type: 'join', roomId: 'shared', mode: 'team' }));
  await waitFor(() => inheritor.messages.some(m => m.type === 'state'));
  assert.equal(inheritor.messages.find(m => m.type === 'state').mapId, 'candy');
});
