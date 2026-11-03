import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventFeed } from '../public/feedback.js';

const player = (id = 'me', patch = {}) => ({ id, name: id === 'me' ? '나' : '<img src=x onerror=alert(1)>', team: 'blue',
  alive: true, bubbleTicks: 0, maxOrbs: 1, range: 3, speedLevel: 0, darts: 0, pin: false, itemsCollected: 0, rescues: 0, ...patch });
const state = (players, patch = {}) => ({ roomId: 'friend', matchId: 'match-1', round: 1, tick: 1, phase: 'playing', players, ...patch });
function update(feed, players, patch) { return feed.update(state(players, patch), players[0]); }

test('item upgrades produce a useful caption once, including capped pickups', () => {
  const feed = createEventFeed();
  assert.equal(update(feed, [player()]).latest, '');
  const upgraded = player('me', { itemsCollected: 1, range: 4 });
  let result = update(feed, [upgraded]);
  assert.match(result.latest, /물줄기|범위|파동/);
  assert.equal(result.entries.length, 1);
  assert.equal(update(feed, [upgraded]).latest, '');
  result = update(feed, [player('me', { itemsCollected: 2, range: 4 })]);
  assert.match(result.latest, /아이템/);
  assert.equal(result.entries.length, 2);
});

test('bubble entry, ally rescue and death are distinct deduplicated events', () => {
  const feed = createEventFeed();
  update(feed, [player(), player('ally')]);
  assert.match(update(feed, [player('me', { bubbleTicks: 20 }), player('ally', { bubbleTicks: 20 })]).latest, /버블|물 감옥/);
  const rescued = update(feed, [player(), player('ally')]);
  assert.match(rescued.latest, /구출/);
  assert.ok(rescued.entries.some(entry => entry.text.includes('<img src=x onerror=alert(1)>')));
  assert.match(update(feed, [player('me', { alive: false }), player('ally')]).latest, /탈락/);
  assert.equal(update(feed, [player('me', { alive: false }), player('ally')]).latest, '');
});

test('team deliveries and the final result remain visible without sound', () => {
  const feed = createEventFeed();
  const relay = { scores: { blue: 0, pink: 0 }, goal: 3 };
  update(feed, [player()], { relay });
  assert.match(update(feed, [player()], { relay: { ...relay, scores: { blue: 1, pink: 0 } } }).latest, /블루.*1/);
  assert.match(update(feed, [player()], { phase: 'finished', result: { winnerTeam: 'blue' } }).latest, /승리/);
  assert.equal(update(feed, [player()], { phase: 'finished', result: { winnerTeam: 'blue' } }).latest, '');
});

test('recovery baselines skip old events and new matches clear previous entries', () => {
  const feed = createEventFeed();
  update(feed, [player()]);
  update(feed, [player('me', { itemsCollected: 1, darts: 1 })]);
  const resumed = player('me', { itemsCollected: 4, darts: 3 });
  assert.equal(feed.update(state([resumed]), resumed, { baseline: true }).latest, '');
  assert.equal(update(feed, [resumed]).entries.length, 1);
  const newMatch = update(feed, [player()], { matchId: 'match-2', round: 2 });
  assert.deepEqual(newMatch.entries, []);
  assert.equal(newMatch.latest, '');
  const pinCaption = update(feed, [player('me', { itemsCollected: 1, pin: true })], { matchId: 'match-2', round: 2 }).latest;
  assert.match(pinCaption, /보호|방어/);
  assert.doesNotMatch(pinCaption, /탈출/);
  feed.reset();
  assert.deepEqual(update(feed, [player()]).entries, []);
});

test('duel opponents are not described as allies when neither player has a team', () => {
  const feed = createEventFeed(), me = player('me', { team: null });
  update(feed, [me, player('opponent', { team: null })]);
  assert.equal(update(feed, [me, player('opponent', { team: null, bubbleTicks: 20 })]).latest, '');
  assert.match(update(feed, [player('me', { team: null, bubbleTicks: 20 }), player('opponent', { team: null, bubbleTicks: 19 })]).latest, /물 감옥/);
});

test('the final delivery is retained before the result caption on the same tick', () => {
  const feed = createEventFeed();
  update(feed, [player()], { relay: { scores: { blue: 2, pink: 0 }, goal: 3 } });
  const result = update(feed, [player()], { phase: 'finished', relay: { scores: { blue: 3, pink: 0 }, goal: 3 }, result: { winnerTeam: 'blue' } });
  assert.ok(result.entries.some(entry => entry.type === 'delivery' && /3 \/ 3/.test(entry.text)));
  assert.equal(result.entries.at(-1).type, 'result');
  assert.match(result.latest, /승리/);
});

test('feed is bounded, returns defensive snapshots, and announces training completion', () => {
  const feed = createEventFeed(4);
  update(feed, [player()]);
  for (let count = 1; count <= 8; count++) update(feed, [player('me', { itemsCollected: count })]);
  const result = update(feed, [player('me', { itemsCollected: 8 })], { phase: 'finished', result: { reason: 'training_complete', winnerTeam: 'blue' } });
  assert.equal(result.entries.length, 4);
  assert.match(result.latest, /훈련.*완료/);
  result.entries[0].text = 'mutated';
  assert.ok(update(feed, [player('me', { itemsCollected: 8 })], { phase: 'finished' }).entries.every(entry => entry.text !== 'mutated'));
});
