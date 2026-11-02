import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInviteUrl, parseInvite } from '../public/invite.js';

test('invite links carry only the selected room configuration on the current origin and path', () => {
  const link = buildInviteUrl('https://player:password@arena.example/play?access_token=secret&name=Original#refresh_token=hidden', {
    roomId: '우리 방 & 친구?', mode: 'team', mapId: 'candy', itemMode: false, ruleSet: 'relay',
    name: 'Private name', accessToken: 'private-token', skinId: 'mint', characterId: 'bibi'
  });
  const url = new URL(link);
  assert.equal(url.origin, 'https://arena.example');
  assert.equal(url.pathname, '/play');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.equal(url.hash, '');
  assert.deepEqual([...url.searchParams], [
    ['room', '우리 방 & 친구?'], ['mode', 'team'], ['map', 'candy'], ['items', '0'], ['rules', 'relay']
  ]);
  assert.ok(!link.includes('secret') && !link.includes('private-token'));
});

test('valid invitation choices round trip without losing encoded room names', () => {
  for (const [mode, mapId, itemMode, ruleSet] of [
    ['team', 'garden', true, 'classic'], ['team', 'lagoon', false, 'relay'],
    ['team', 'candy', true, 'relay'], ['duel', 'lagoon', false, 'classic']
  ]) {
    const expected = { roomId: '친구 + 50% / ?&=#', mode, mapId, itemMode, ruleSet };
    const link = buildInviteUrl('http://localhost:3000/arena/', expected);
    assert.deepEqual(parseInvite(new URL(link).search), expected);
  }
});

test('missing and unrecognized query values fall back to safe lobby choices', () => {
  const defaults = { roomId: '', mode: 'team', mapId: 'garden', itemMode: true, ruleSet: 'classic' };
  assert.deepEqual(parseInvite(''), defaults);
  assert.deepEqual(parseInvite('?mode=party&map=secret&items=false&rules=ranked&name=Other&skinId=mint'), defaults);
  assert.deepEqual(parseInvite('?mode=TEAM&map=GARDEN&items=2&rules=RELAY'), defaults);
});

test('duel invitations cannot request the team relay rule', () => {
  assert.deepEqual(parseInvite('?room=duel-room&mode=duel&map=candy&items=0&rules=relay'), {
    roomId: 'duel-room', mode: 'duel', mapId: 'candy', itemMode: false, ruleSet: 'classic'
  });
  const link = buildInviteUrl('https://arena.example/', {
    roomId: 'duel-room', mode: 'duel', mapId: 'garden', itemMode: true, ruleSet: 'relay'
  });
  assert.equal(new URL(link).searchParams.get('rules'), 'classic');
});

test('room names are trimmed and bounded before they reach the join form', () => {
  assert.equal(parseInvite('?room=%20%20hello%20%20').roomId, 'hello');
  assert.equal(parseInvite(`?room=${'x'.repeat(80)}`).roomId, 'x'.repeat(64));
  const link = buildInviteUrl('https://arena.example/', { roomId: `  ${'a'.repeat(80)}  ` });
  assert.equal(new URL(link).searchParams.get('room'), 'a'.repeat(64));
});

test('invalid builder values cannot export unsupported game settings', () => {
  const link = buildInviteUrl('https://arena.example/', {
    roomId: {}, mode: ['team'], mapId: 'unknown', itemMode: 'false', ruleSet: true
  });
  assert.deepEqual([...new URL(link).searchParams], [
    ['room', ''], ['mode', 'team'], ['map', 'garden'], ['items', '1'], ['rules', 'classic']
  ]);
});

test('private AI practice rooms cannot produce invitation links', () => {
  assert.throws(() => buildInviteUrl('https://arena.example/', {
    roomId: 'private-practice-room', mode: 'team', practice: true
  }), /practice/i);
});

test('invitation destinations must use a web origin', () => {
  assert.throws(() => buildInviteUrl('javascript:alert(1)', { roomId: 'friends' }), /origin|protocol/i);
});
