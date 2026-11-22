import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { consumeEmailConfirmation, createAccountClient } from '../../../Server/public/account-client.js';

const game = 'http://127.0.0.1:18081';
const provider = 'http://127.0.0.1:18080';
const invitation = game + '/?room=mail-duel&mode=duel&play=friend';
const mailbox = 'http://mail:8025/api/v1';
const password = randomUUID();

function apiKey(role) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({ role, exp: Math.floor(Date.now() / 1000) + 300 });
  return data + '.' + createHmac('sha256', process.env.AUTH_SMOKE_SECRET).update(data).digest('base64url');
}

async function waitFor(read, description, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(80);
  }
  throw Error('Timed out waiting for ' + description);
}

// Self-hosted Supabase's public gateway strips these prefixes before forwarding.
function gateway() {
  return createServer((req, res) => {
    const match = /^\/(auth|rest)\/v1(\/.*)$/.exec(req.url);
    if (!match) { res.writeHead(404).end(); return; }
    const target = match[1] === 'auth' ? 'http://auth:9999' : 'http://rest:3000';
    const upstream = request(target + match[2], { method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });
}

async function deliveredLink(email, previousId) {
  const messageId = await waitFor(async () => {
    const inbox = await (await fetch(mailbox + '/messages')).json();
    return inbox.messages.find(message => message.ID !== previousId && message.To.some(to => to.Address === email))?.ID;
  }, 'the local SMTP delivery');
  const message = await (await fetch(mailbox + '/message/' + messageId)).json();
  const link = new URL(message.HTML.match(/href="([^"]+)"/i)[1].replaceAll('&amp;', '&'));
  assert.equal(link.origin + link.pathname, provider + '/auth/v1/verify');
  return { messageId, link };
}

async function register(name, resend) {
  const email = name.toLowerCase() + '@arena.test';
  const account = createAccountClient({ location: { href: invitation }, fetch: (path, options) => fetch(new URL(path, game), options) });
  account.configure({ supabaseUrl: provider, supabaseAnonKey: apiKey('anon') });
  const signup = await account.signUp(email, password, name);
  assert.ok(signup.confirmationRequired && !signup.session);
  await assert.rejects(account.signIn(email, password), { code: 'email_not_confirmed' });
  let mail = await deliveredLink(email);
  if (resend) {
    await delay(1100); // This fixture configures GoTrue's per-address mail cooldown to one second.
    await account.resendConfirmation(email);
    mail = await deliveredLink(email, mail.messageId);
  }
  const confirmation = await fetch(mail.link, { redirect: 'manual' });
  assert.ok([302, 303].includes(confirmation.status), 'GoTrue must redirect the delivered link back to the game');
  let clean;
  const status = consumeEmailConfirmation(confirmation.headers.get('location'), { replaceState(_state, _title, url) { clean = url; } });
  assert.equal(status, 'opened');
  assert.ok(clean === invitation, 'the sanitized callback must contain only the original game invitation');
  assert.equal(await account.getAccessToken(), null);
  const session = await account.signIn(email, password);
  const member = await account.getAccount();
  assert.equal(member.user.id, session.user.id);
  assert.equal(member.user.email, email);
  assert.equal(member.profile.nickname, name);
  assert.deepEqual(member.recentMatches, []);
  return { account, id: session.user.id };
}

async function join(member, sockets) {
  const socket = new WebSocket(game.replace('http:', 'ws:'));
  sockets.push(socket);
  const client = { socket, state: null, joined: null };
  socket.addEventListener('message', event => {
    const frame = JSON.parse(event.data);
    if (frame.type === 'state') client.state = frame;
    if (frame.type === 'joined') client.joined = frame.playerId;
    if (frame.type === 'error') client.error = frame.code;
  });
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'join', roomId: 'mail-duel', mode: 'duel', accessToken: await member.account.getAccessToken() }));
  await waitFor(() => client.joined || client.error, 'the server to authenticate the player');
  assert.equal(client.error, undefined);
  assert.ok(client.joined);
  return client;
}

test('two email-confirmed members play a duel and read their saved PostgreSQL result', { timeout: 60000 }, async t => {
  const http = gateway().listen(18080, '127.0.0.1');
  await once(http, 'listening');
  const server = spawn(process.execPath, ['Server/src/index.js'], { stdio: 'inherit', env: {
    ...process.env, HOST: '127.0.0.1', PORT: '18081', ALLOW_DEV_GUESTS: 'false', RESULT_OUTBOX_DIR: '/tmp/results',
    SUPABASE_URL: provider, SUPABASE_ANON_KEY: apiKey('anon'), SUPABASE_SERVICE_ROLE_KEY: apiKey('service_role')
  } });
  const sockets = [];
  t.after(() => {
    for (const socket of sockets) socket.close();
    server.kill();
    http.closeAllConnections();
    http.close();
  });
  await waitFor(() => fetch(game + '/health').then(response => response.ok, () => false), 'the game server');
  const readiness = await fetch(game + '/health/services');
  assert.equal(readiness.status, 200);
  assert.deepEqual(await readiness.json(), {
    status: 'ready', emailConfirmation: 'required',
    checks: { configuration: 'ok', authentication: 'ok', database: 'ok', resultStorage: 'ok', leaderboard: 'ok' }
  });
  const [host, guest] = await Promise.all([register('HostCat', true), register('GuestCat', false)]);
  assert.notEqual(host.id, guest.id);
  const first = await join(host, sockets);
  const second = await join(guest, sockets);
  const players = [first, second];
  await waitFor(() => players.every(player => player.state?.phase === 'playing'), 'both clients to see a playing duel');
  assert.equal(first.state.matchId, second.state.matchId);
  for (const player of players) {
    assert.deepEqual(player.state.players.map(p => p.id).sort(), [first.joined, second.joined].sort());
  }
  second.socket.send(JSON.stringify({ type: 'input', action: 'place_orb' }));
  await waitFor(() => players.every(player => player.state?.phase === 'finished' && player.state.resultSaving?.status === 'saved'), 'both clients to receive the persisted result');
  assert.equal(first.state.result.winnerId, host.id);
  for (const [member, outcome] of [[host, 'win'], [guest, 'loss']]) {
    const { profile, recentMatches } = await member.account.getAccount();
    assert.equal(profile.wins, outcome === 'win' ? 1 : 0);
    assert.equal(profile.losses, outcome === 'loss' ? 1 : 0);
    assert.equal(recentMatches.length, 1);
    assert.equal(recentMatches[0].id, first.state.matchId);
    assert.equal(recentMatches[0].outcome, outcome);
    await member.account.signOut();
  }
  const leaderboard = await fetch(game + '/api/leaderboard');
  assert.equal(leaderboard.status, 200);
  const { source, entries } = await leaderboard.json();
  assert.equal(source, 'supabase');
  assert.deepEqual(entries.map(({ rank, name, rating, wins, losses }) => ({ rank, name, rating, wins, losses })), [
    { rank: 1, name: 'HostCat', rating: 1016, wins: 1, losses: 0 },
    { rank: 2, name: 'GuestCat', rating: 984, wins: 0, losses: 1 }
  ]);
});
