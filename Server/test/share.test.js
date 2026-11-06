import test from 'node:test';
import assert from 'node:assert/strict';
import { createResultCardData, renderResultCard, createResultSharing } from '../public/share.js';

const state = () => ({ phase: 'finished', ruleSet: 'harmony', mapId: 'harbor',
  result: { winnerTeam: 'blue', scoreboard: [
    { id: 'own-uuid', name: '<img src=x onerror=alert(1)>', team: 'blue', score: 345, rescues: 2, passes: 3, interceptions: 1, deliveries: 4, accessToken: 'SECRET' },
    { id: 'other-uuid', name: 'OTHER PRIVATE NAME', score: 9999 }
  ] },
  players: [{ id: 'own-uuid', characterId: 'bibi', skinId: 'raincoat', orbSkinId: 'duck', score: 0, rescues: 0, passes: 0, deliveries: 0, resumeToken: 'RESUME_SECRET' }],
  accountId: 'ACCOUNT_SECRET' });

test('card exports only own final authoritative numbers and catalog appearance, never identity or secrets', () => {
  const card = createResultCardData(state(), 'own-uuid');
  assert.deepEqual(card, { version: 1, ruleSet: 'harmony', mapId: 'harbor', outcome: 'victory', practice: false,
    score: 345, rescues: 2, passes: 3, interceptions: 1, deliveries: 4,
    appearance: { characterId: 'bibi', skinId: 'raincoat', orbSkinId: 'duck', team: 'blue' } });
  assert.ok(Object.isFrozen(card) && Object.isFrozen(card.appearance));
  assert.doesNotMatch(JSON.stringify(card), /uuid|SECRET|PRIVATE|img|onerror|name|token|account/i);
  assert.equal(createResultCardData({ ...state(), phase: 'playing' }, 'own-uuid'), null);
  assert.equal(createResultCardData(state(), 'absent'), null);
  assert.equal(createResultCardData({ ...state(), result: {} }, 'own-uuid'), null);
  assert.equal(createResultCardData({ ...state(), players: [] }, 'own-uuid'), null);
});

test('card rejects malformed counters and unknown cosmetic or rule strings instead of printing input', () => {
  const s = state(); Object.assign(s.result.scoreboard[0], { score: Infinity, rescues: -4, passes: '900', deliveries: 3.7 });
  Object.assign(s.players[0], { characterId: '<script>', skinId: 'secret', orbSkinId: 'token' });
  s.ruleSet = '<img>'; s.mapId = 'PRIVATE';
  const card = createResultCardData(s, 'own-uuid');
  assert.deepEqual([card.score, card.rescues, card.passes, card.deliveries], [0, 0, 0, 0]);
  assert.deepEqual(card.appearance, { characterId: 'momo', skinId: 'classic', orbSkinId: 'bubble', team: 'blue' });
  assert.equal(card.ruleSet, 'classic'); assert.equal(card.mapId, 'garden');
});

function canvasFixture(fail = false) {
  const text = []; const calls = [];
  const context = new Proxy({ fillText(value) { text.push(value); }, measureText() { return { width: 100 }; },
    createLinearGradient() { return { addColorStop() {} }; } }, { get(target, key) { return target[key] ?? (() => {}); }, set(target, key, value) { target[key] = value; return true; } });
  const canvas = { getContext: () => context, toBlob(callback, type) { calls.push(type); callback(fail ? null : new Blob(['png-image'], { type: 'image/png' })); } };
  return { canvas, text, calls };
}

test('card renderer uses exact drawAvatar and prints own real contributions with fixed PNG dimensions', () => {
  const { canvas, text } = canvasFixture(); let avatar;
  renderResultCard(createResultCardData(state(), 'own-uuid'), { canvas, drawAvatar: (ctx, player, options) => { avatar = { player, options }; } });
  assert.equal(canvas.width, 1200); assert.equal(canvas.height, 630);
  assert.deepEqual(avatar.player, { characterId: 'bibi', skinId: 'raincoat', orbSkinId: 'duck', team: 'blue' });
  assert.equal(avatar.options.reducedMotion, true);
  for (const label of ['345', '2', '3', '1', '4']) assert.ok(text.includes(label));
  assert.doesNotMatch(text.join(' '), /SECRET|uuid|PRIVATE|onerror/);
});

function sharingOptions(overrides = {}) {
  const fixture = canvasFixture(); const copied = [];
  return { getResult: () => createResultCardData(state(), 'own-uuid'),
    getInviteUrl: () => 'https://game.example/play?room=friends&mode=team&rules=harmony&map=harbor&access_token=SECRET#resume_token=RESUME_SECRET',
    navigator: { clipboard: { async writeText(text) { copied.push(text); } } },
    canvasFactory: () => fixture.canvas, copied, ...overrides };
}

test('no sharing happens until called; unsupported native sharing copies only safe invitation and own text', async () => {
  const options = sharingOptions(); const actions = createResultSharing(options);
  assert.equal(options.copied.length, 0);
  const result = await actions.share();
  assert.equal(result.status, 'copied'); assert.equal(options.copied.length, 1);
  assert.match(options.copied[0], /345/); assert.match(options.copied[0], /rules=harmony/);
  assert.doesNotMatch(options.copied[0], /SECRET|token|uuid|OTHER|onerror/);
});

test('native file share receives a PNG and sanitised invite; cancellation does not copy or post', async () => {
  let payload; const options = sharingOptions();
  options.navigator.canShare = ({ files }) => files[0].type === 'image/png';
  options.navigator.share = async data => { payload = data; };
  assert.equal((await createResultSharing(options).share()).status, 'shared');
  assert.equal(payload.files[0].type, 'image/png'); assert.equal(payload.files[0].name, 'pop-pop-arena-result.png');
  assert.doesNotMatch(JSON.stringify(payload), /SECRET|token|uuid|OTHER/);
  options.navigator.share = async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); };
  assert.equal((await createResultSharing(options).share()).status, 'cancelled');
  assert.equal(options.copied.length, 0);
});

test('PNG encoding failure falls back to copy; clipboard failure supplies safe manual link', async () => {
  const options = sharingOptions({ canvasFactory: () => canvasFixture(true).canvas });
  assert.equal((await createResultSharing(options).download()).status, 'copied');
  options.navigator.clipboard.writeText = async () => { throw new Error('denied'); };
  const result = await createResultSharing(options).share();
  assert.equal(result.status, 'manual'); assert.match(result.message, /https:\/\/game.example/);
  assert.doesNotMatch(result.message, /SECRET|token|uuid/);
});

test('download triggers only the generated PNG and releases its object URL', async () => {
  let clicked = false, revoked; const options = sharingOptions({
    document: { createElement(tag) { assert.equal(tag, 'a'); return { click() { clicked = true; }, remove() {} }; }, body: { append() {} } },
    urlApi: { createObjectURL(blob) { assert.equal(blob.type, 'image/png'); return 'blob:test'; }, revokeObjectURL(url) { revoked = url; } },
    defer: fn => fn()
  });
  assert.equal((await createResultSharing(options).download()).status, 'downloaded');
  assert.equal(clicked, true); assert.equal(revoked, 'blob:test');
});
