import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectedScore, eloDelta, calculateRatingChanges } from '../src/rating.js';
import * as ratingModule from '../src/rating.js';

const participant = (userId, team, rating, outcome) => ({ userId, team, rating, outcome });
const duel = (ratingA = 1000, ratingB = 1000, outcomeA = 'win', outcomeB = 'loss') => [
  participant('alice', null, ratingA, outcomeA), participant('bob', null, ratingB, outcomeB)
];
const entries = changes => [...changes];

test('applying a delta caps final ratings at both int32 boundaries', () => {
  assert.equal(typeof ratingModule.applyRatingDelta, 'function');
  const { applyRatingDelta } = ratingModule;
  assert.equal(applyRatingDelta(1000, 16), 1016);
  assert.equal(applyRatingDelta(1000, -16), 984);
  assert.equal(applyRatingDelta(5, -16), 0);
  assert.equal(applyRatingDelta(2147483640, 16), 2147483647);
  assert.equal(applyRatingDelta(0, -Number.MAX_SAFE_INTEGER), 0);
  assert.equal(applyRatingDelta(2147483647, Number.MAX_SAFE_INTEGER), 2147483647);
  assert.equal(Object.is(applyRatingDelta(0, -0), -0), false);
});

test('applying a rating delta requires an int32 rating and safe integer delta', () => {
  assert.equal(typeof ratingModule.applyRatingDelta, 'function');
  for (const invalid of [-1, 2147483648, 0.5, NaN, Infinity, null, '1000']) {
    assert.throws(() => ratingModule.applyRatingDelta(invalid, 16));
  }
  for (const invalid of [0.5, NaN, Infinity, null, '16', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => ratingModule.applyRatingDelta(1000, invalid));
  }
});

test('equal strength has a half expectation and K32 yields symmetric win loss and draw deltas', () => {
  assert.equal(expectedScore(1000, 1000), 0.5);
  assert.equal(eloDelta(1000, 1000, 1), 16);
  assert.equal(eloDelta(1000, 1000, 0), -16);
  assert.equal(eloDelta(1000, 1000, 0.5), 0);
  assert.equal(Object.is(eloDelta(1000, 1000, 0.5), -0), false);
});

test('an underdog win earns more than a favorite win and rating gaps saturate at 800', () => {
  assert.ok(Math.abs(expectedScore(1000, 1400) - 1 / 11) < 1e-15);
  assert.equal(eloDelta(1000, 1400, 1), 29);
  assert.equal(eloDelta(1400, 1000, 1), 3);
  assert.equal(eloDelta(1000, 1400, 0.5), 13);
  assert.equal(eloDelta(1400, 1000, 0.5), -13);
  assert.equal(expectedScore(0, 2147483647), expectedScore(0, 800));
  assert.equal(expectedScore(2147483647, 0), expectedScore(800, 0));
  for (const score of [0, 0.5, 1]) for (const pair of [[0, 2147483647], [2147483647, 0]]) {
    assert.ok(Math.abs(eloDelta(...pair, score)) <= 32);
  }
});

test('signed half values round away from zero and rounded zero is never negative', () => {
  const gap = 400 * Math.log10(33 / 31);
  assert.equal(eloDelta(0, gap, 0.5), 1);
  assert.equal(eloDelta(gap, 0, 0.5), -1);
  assert.equal(eloDelta(0, gap, 0), -16);
  assert.equal(eloDelta(gap, 0, 1), 16);
  assert.equal(eloDelta(0, 800, 0), 0);
  assert.equal(Object.is(eloDelta(0, 800, 0), -0), false);
});

test('mathematical helpers reject nonfinite negative means and noncanonical scores', () => {
  for (const invalid of [NaN, Infinity, -Infinity, -1, '1000', null, undefined, true]) {
    assert.throws(() => expectedScore(invalid, 1000));
    assert.throws(() => expectedScore(1000, invalid));
    assert.throws(() => eloDelta(invalid, 1000, 1));
  }
  for (const score of [-1, 0.1, 0.25, 0.75, 2, NaN, null, true, '1']) {
    assert.throws(() => eloDelta(1000, 1000, score));
  }
  assert.ok(Number.isFinite(expectedScore(1000.5, 1200.25)));
});

test('duel returns one canonical change and its exact inverse regardless of participant order', () => {
  const players = duel(700, 1100);
  assert.deepEqual(entries(calculateRatingChanges('duel', players)), [['alice', 29], ['bob', -29]]);
  assert.deepEqual(calculateRatingChanges('duel', [...players].reverse()), calculateRatingChanges('duel', players));
  assert.deepEqual(entries(calculateRatingChanges('duel', duel(1000, 1000, 'draw', 'draw'))), [['alice', 0], ['bob', 0]]);
});

test('team uses opposing team means and applies one shared delta to each teammate', () => {
  const players = [participant('a', 'blue', 800, 'win'), participant('b', 'blue', 1200, 'win'),
    participant('c', 'pink', 1200, 'loss'), participant('d', 'pink', 1600, 'loss')];
  assert.deepEqual(entries(calculateRatingChanges('team', players)), [['a', 29], ['b', 29], ['c', -29], ['d', -29]]);
  assert.deepEqual(calculateRatingChanges('team', [...players].reverse()), calculateRatingChanges('team', players));
  const swapped = players.map(p => ({ ...p, team: p.team === 'blue' ? 'pink' : 'blue' }));
  assert.deepEqual(calculateRatingChanges('team', swapped), calculateRatingChanges('team', players));
});

test('fractional team averages stay fractional and a strong team loses rating on a draw', () => {
  const players = [participant('a', 'blue', 1000, 'draw'), participant('b', 'blue', 1001, 'draw'),
    participant('c', 'pink', 1400, 'draw'), participant('d', 'pink', 1402, 'draw')];
  const delta = eloDelta(1000.5, 1401, 0.5);
  assert.deepEqual(entries(calculateRatingChanges('team', players)), [['a', delta], ['b', delta], ['c', -delta], ['d', -delta]]);
  assert.ok(delta > 0);
  // A 10.75-point gap draws to zero; prematurely rounding the 1000.25
  // team mean makes the gap 11 and incorrectly awards one point.
  const boundary = [participant('a', 'blue', 1000, 'draw'), participant('b', 'blue', 1000, 'draw'),
    participant('c', 'blue', 1000, 'draw'), participant('d', 'blue', 1001, 'draw'), participant('e', 'pink', 1011, 'draw')];
  assert.deepEqual(entries(calculateRatingChanges('team', boundary)), [['a', 0], ['b', 0], ['c', 0], ['d', 0], ['e', 0]]);
});

test('valid empty and one-sided historical results have zero changes without inventing an opponent', () => {
  for (const mode of ['team', 'duel']) assert.deepEqual(calculateRatingChanges(mode, []), new Map());
  assert.deepEqual(entries(calculateRatingChanges('duel', [participant('solo', undefined, 1000, 'win')])), [['solo', 0]]);
  assert.deepEqual(entries(calculateRatingChanges('team', [participant('a', 'pink', 1000, 'loss'), participant('b', 'pink', 1500, 'loss')])), [['a', 0], ['b', 0]]);
});

test('ratings are not floored or mutated by the pure calculation', () => {
  const players = duel(0, 0, 'loss', 'win');
  const before = structuredClone(players);
  for (const p of players) Object.freeze(p);
  Object.freeze(players);
  assert.deepEqual(entries(calculateRatingChanges('duel', players)), [['alice', -16], ['bob', 16]]);
  assert.deepEqual(players, before);
  const maximum = duel(2147483647, 2147483647);
  assert.equal(calculateRatingChanges('duel', maximum).get('alice'), 16);
});

test('both sides must report complementary results and teammates must agree even without an opponent', () => {
  for (const outcomes of [['win', 'win'], ['loss', 'loss'], ['draw', 'win'], ['loss', 'draw']]) {
    assert.throws(() => calculateRatingChanges('duel', duel(1000, 1000, ...outcomes)));
    assert.throws(() => calculateRatingChanges('team', [participant('a', 'blue', 1000, outcomes[0]), participant('b', 'pink', 1000, outcomes[1])]));
  }
  assert.throws(() => calculateRatingChanges('team', [participant('a', 'blue', 1000, 'win'), participant('b', 'blue', 1000, 'loss')]));
});

test('invalid modes counts duplicate identities teams ratings and outcomes fail before calculation', () => {
  for (const mode of ['unknown', null, undefined]) assert.throws(() => calculateRatingChanges(mode, []));
  for (const value of [null, undefined, {}, 'players']) assert.throws(() => calculateRatingChanges('duel', value));
  assert.throws(() => calculateRatingChanges('duel', [...duel(), participant('c', null, 1000, 'loss')]));
  assert.throws(() => calculateRatingChanges('team', Array.from({ length: 9 }, (_, i) => participant(`p${i}`, 'blue', 1000, 'win'))));
  assert.throws(() => calculateRatingChanges('duel', [duel()[0], { ...duel()[1], userId: 'alice' }]));
  for (const userId of ['', ' '.repeat(3), 'x'.repeat(129), 1, null, undefined]) {
    assert.throws(() => calculateRatingChanges('duel', [{ ...duel()[0], userId }]));
  }
  for (const rating of [-1, 2147483648, 0.5, NaN, Infinity, '1000', null]) {
    assert.throws(() => calculateRatingChanges('duel', [{ ...duel()[0], rating }]));
  }
  for (const outcome of ['winner', '', null, undefined, ['win'], { toString: () => 'win' }]) assert.throws(() => calculateRatingChanges('duel', [{ ...duel()[0], outcome }]));
  for (const team of ['blue', 'pink', '', false, 0]) assert.throws(() => calculateRatingChanges('duel', [{ ...duel()[0], team }]));
  for (const team of [null, undefined, 'other']) assert.throws(() => calculateRatingChanges('team', [{ ...duel()[0], team }]));
  for (const invalid of [null, [], 1, 'player']) assert.throws(() => calculateRatingChanges('team', [invalid]));
});
