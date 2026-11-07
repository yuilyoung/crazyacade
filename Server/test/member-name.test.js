import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

test('verified member joins use the chosen name, keep metadata as an empty-name fallback, and preserve Unicode limits', async t => {
  const cases = [
    { name: '새닉네임', metadata: 'SignupName', want: '새닉네임' },
    { name: '  Chosen  ', metadata: 'SignupName', want: 'Chosen' },
    { name: '', metadata: 'SignupName', want: 'SignupName' },
    { name: '   ', metadata: 'SignupName', want: 'SignupName' },
    { metadata: 'MetadataNameTooLong', want: 'MetadataName' },
    { name: '😀'.repeat(12), metadata: 'SignupName', want: '😀'.repeat(12) }
  ];
  const provider = createServer((req, res) => {
    const index = Number(req.headers.authorization?.replace('Bearer member-', ''));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`, user_metadata: { nickname: cases[index].metadata } }));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(() => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); }));
  const server = spawn(process.execPath, ['src/index.js'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', ALLOW_DEV_GUESTS: 'false', SUPABASE_URL: `http://127.0.0.1:${provider.address().port}`,
      SUPABASE_ANON_KEY: 'fixture-public', SUPABASE_SERVICE_ROLE_KEY: '', RUNTIME_DRAIN_MS: '20' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => { if (server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; } });
  const [output] = await once(server.stdout, 'data');
  const port = /127\.0\.0\.1:(\d+)/.exec(output.toString())?.[1];
  assert.ok(port);
  for (const [index, fixture] of cases.entries()) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    t.after(() => socket.terminate());
    await once(socket, 'open');
    const snapshot = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Timed out waiting for a member snapshot')), 3000);
      socket.on('message', data => {
        const message = JSON.parse(data);
        if (message.type === 'error') { clearTimeout(timer); reject(Error(message.code)); }
        if (message.type === 'state') { clearTimeout(timer); resolve(message); }
      });
    });
    socket.send(JSON.stringify({ type: 'join', accessToken: `member-${index}`, roomId: `member-name-${index}`, mode: 'team',
      ...(fixture.name === undefined ? {} : { name: fixture.name }) }));
    const state = await snapshot;
    assert.equal(state.players[0].name, fixture.want, `member name case ${index}`);
    socket.close();
  }
});
