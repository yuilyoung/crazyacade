import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMatchmaking, queueElapsed, searchRadius } from '../src/matchmaking.js';

const entry = (id, rating = 1000, queuedAt) => ({ id, rating, ...(queuedAt === undefined ? {} : { queuedAt }) });
const populate = (queue, ratings, queuedAt = 0) => ratings.map((rating, index) => {
  const player = entry(`player-${index}`, rating, queuedAt);
  assert.equal(queue.add(player), true);
  return player;
});
const ids = players => players.map(player => player.id);

test('queue membership uses object identity and duplicate admission preserves its age at capacity', () => {
  let now = 500;
  const queue = createMatchmaking({ capacity: 1, clock: () => now });
  const first = entry('same');
  assert.equal(queue.add(first), true);
  assert.equal(first.queuedAt, 500);
  now = 900;
  assert.equal(queue.add(first), true);
  assert.equal(first.queuedAt, 500);
  assert.equal(queue.add(entry('other')), false);
  assert.equal(queue.remove(entry('same')), false);
  assert.equal(queue.has(first), true);
  assert.equal(queue.size, 1);
  assert.equal(queue.remove(first), true);
  assert.equal(queue.remove(first), false);
  assert.equal(queue.has(first), false);
  assert.equal(queue.add(entry('replacement')), true);
});

test('entry snapshots cannot alter membership and a returned entrant retains its original wait', () => {
  const queue = createMatchmaking({ clock: () => 2000 });
  const first = entry('first', 1000, 0);
  queue.add(first);
  queue.entries().splice(0);
  assert.equal(queue.size, 1);
  assert.equal(queue.entries()[0], first);
  queue.remove(first);
  queue.add(first);
  assert.equal(first.queuedAt, 0);
});

test('invalid server rating data is never admitted', () => {
  const queue = createMatchmaking({ clock: () => 0 });
  for (const rating of [undefined, null, '1000', NaN, Infinity, -1, 1000.5]) {
    assert.equal(queue.add({ rating }), false, String(rating));
  }
  assert.equal(queue.add(null), false);
  assert.equal(queue.add({ rating: 1000, queuedAt: NaN }), false);
  assert.equal(queue.size, 0);
});

test('server elapsed time expands the search every fifteen seconds and caps it', () => {
  for (const [now, expected] of [[999, 100], [1000, 100], [15999, 100], [16000, 150], [31000, 200], [91000, 400], [170000, 400]]) {
    assert.equal(searchRadius(1000, now), expected, String(now));
  }
  assert.equal(queueElapsed(1000, 999), 0);
  assert.equal(queueElapsed(1000, 16000), 15000);
});

test('seven available humans never become a match and selection does not remove a full group', () => {
  const queue = createMatchmaking({ clock: () => 0 });
  const players = populate(queue, Array(7).fill(1000));
  assert.equal(queue.select(), null);
  const eighth = entry('eighth');
  queue.add(eighth);
  const selected = queue.select();
  assert.deepEqual(selected.players, [...players, eighth]);
  assert.equal(queue.size, 8);
  assert.equal(queue.has(eighth), true);
  assert.deepEqual(queue.select().players, selected.players);
});

test('rating span at the search boundary is eligible but one point beyond must wait', () => {
  let now = 0;
  const queue = createMatchmaking({ clock: () => now });
  populate(queue, [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1101]);
  assert.equal(queue.select(), null);
  now = 15000;
  assert.equal(queue.select().players.length, 8);
  const boundary = createMatchmaking({ clock: () => 0 });
  populate(boundary, [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1100]);
  assert.equal(boundary.select().players.length, 8);
});

test('an older expanded search cannot pull a new player beyond the new player range', () => {
  let now = 30000;
  const queue = createMatchmaking({ clock: () => now });
  populate(queue, Array(7).fill(1000));
  queue.add(entry('newcomer', 1150));
  assert.equal(queue.select(), null);
  now = 44999;
  assert.equal(queue.select(), null);
  now = 45000;
  assert.equal(queue.select().players.length, 8);
});

test('all members share a compatible span rather than only matching the anchor rating', () => {
  const queue = createMatchmaking({ clock: () => 0 });
  populate(queue, [1000, 900, 900, 900, 1100, 1100, 1100, 1100]);
  assert.equal(queue.select(), null);
});

test('an isolated oldest player does not block a feasible group and equal wait uses admission order', () => {
  const queue = createMatchmaking({ clock: () => 1000 });
  queue.add(entry('isolated', 300, 0));
  const players = populate(queue, Array(9).fill(1000), 500);
  assert.deepEqual(ids(queue.select().players), ids(players.slice(0, 8)));
  assert.equal(queue.size, 10);
});

test('selection prefers the oldest feasible group over a younger group with narrower ratings', () => {
  const queue = createMatchmaking({ clock: () => 10000 });
  const oldest = entry('oldest', 900, 0);
  queue.add(oldest);
  const nearby = populate(queue, Array(7).fill(1000), 1000);
  for (let i = 0; i < 8; i++) queue.add(entry(`young-${i}`, 1010, 2000));
  assert.deepEqual(queue.select().players, [oldest, ...nearby]);
});

test('candidate search finds a feasible group across both sides of its oldest player', () => {
  const queue = createMatchmaking({ clock: () => 0 });
  const oldest = entry('oldest', 1000, -100);
  queue.add(oldest);
  const companions = populate(queue, [950, 960, 970, 990, 1010, 1030, 1050]);
  queue.add(entry('outside', 1060));
  assert.deepEqual(queue.select().players, [oldest, ...companions]);
});

test('teams contain four distinct entrants each and attain the smallest possible rating difference', () => {
  const queue = createMatchmaking({ clock: () => 0 });
  const players = populate(queue, [1000, 1001, 1004, 1010, 1020, 1033, 1048, 1084]);
  const match = queue.select();
  assert.equal(match.teams.blue.length, 4);
  assert.equal(match.teams.pink.length, 4);
  assert.equal(new Set([...match.teams.blue, ...match.teams.pink]).size, 8);
  assert.deepEqual(new Set([...match.teams.blue, ...match.teams.pink]), new Set(players));
  const sum = team => team.reduce((rating, player) => rating + player.rating, 0);
  // Offsets total 200: 84+10+4+1 = 99, while 48+33+20+0 = 101.
  // No four offsets total 100, so the optimal difference is exactly two.
  assert.equal(Math.abs(sum(match.teams.blue) - sum(match.teams.pink)), 2);
});

test('the search cap does not silently admit an opponent outside the maximum span', () => {
  const queue = createMatchmaking({ clock: () => 170000 });
  populate(queue, [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1401]);
  assert.equal(queue.select(), null);
});

test('expired entries cannot be selected and explicit expiry returns only those removed', () => {
  let now = 179999;
  const queue = createMatchmaking({ clock: () => now });
  const players = populate(queue, Array(8).fill(1000));
  const fresh = entry('fresh', 1000, 1);
  queue.add(fresh);
  assert.equal(queue.select().players.length, 8);
  now = 180000;
  assert.equal(queue.select(), null);
  assert.equal(queue.size, 9);
  assert.deepEqual(queue.expire(), players);
  assert.deepEqual(queue.entries(), [fresh]);
  assert.deepEqual(queue.expire(), []);
  now = 180001;
  assert.deepEqual(queue.expire(), [fresh]);
  assert.equal(queue.size, 0);
});
