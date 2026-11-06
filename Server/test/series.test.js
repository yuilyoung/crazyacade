import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeSeries, recordSeriesResult, advanceSeries, seriesState } from '../src/series.js';
import { queueInput, stepMatch } from '../src/match-engine.js';
import { finishScores } from '../src/combat.js';
import { ruleFor } from '../src/rules.js';

function fixture(extra = {}) {
  const room = { id: 'friends', mode: 'team', ruleSet: 'classic', mapId: 'garden', itemMode: true,
    round: 7, phase: 'playing', tick: 0, matchId: 'round-one', ranked: true,
    players: new Map(), items: new Map(), orbs: new Map(), solid: new Set(), soft: new Set(),
    waves: [], dartEffects: [], result: null, ...extra };
  const player = (id, team, x, y) => ({ id, userId: `user-${id}`, name: id, team,
    characterId: 'bibi', skinId: 'mint', orbSkinId: 'duck', room,
    accessToken: 'private-token', resumeToken: 'private-resume',
    alive: true, bubbleTicks: 0, x, y, maxOrbs: 1, activeOrbs: 0, range: 3,
    facing: 'right', nextMoveTick: 0, score: 0, bombsPlaced: 0, rescues: 0, itemsCollected: 0, passes: 0, interceptions: 0, deliveries: 0,
    socket: { readyState: 1, OPEN: 1 } });
  const blue = player('blue-one', 'blue', 2, 5), ally = player('blue-two', 'blue', 4, 5);
  const pink = player('pink-one', 'pink', 9, 5), pinkAlly = player('pink-two', 'pink', 9, 7);
  for (const p of [blue, ally, pink, pinkAlly]) room.players.set(p.id, p);
  room.roster = [...room.players.values()];
  ruleFor(room).initialize(room);
  return { room, blue, ally, pink, pinkAlly };
}

function finish(room, result = { draw: true }) {
  room.result = result;
  room.phase = 'finished';
  finishScores(room);
  return recordSeriesResult(room);
}

// The transport owns gameplay reset; exercise the same player references across rounds.
function nextRound(room, matchId) {
  const map = advanceSeries(room);
  assert.notEqual(map, null);
  for (const p of room.players.values()) Object.assign(p, { score: 0, bombsPlaced: 0, rescues: 0, itemsCollected: 0, passes: 0, interceptions: 0, deliveries: 0 });
  Object.assign(room, { phase: 'playing', matchId, result: null, scoresFinalized: false, roster: [...room.players.values()] });
  return map;
}

test('selected map starts three distinct maps and ordinary single rooms remain unchanged', () => {
  const cycles = { garden: ['garden', 'harbor', 'festival'], harbor: ['harbor', 'festival', 'garden'],
    festival: ['festival', 'harbor', 'garden'], lagoon: ['lagoon', 'harbor', 'festival'], candy: ['candy', 'harbor', 'festival'] };
  for (const [initialMap, expected] of Object.entries(cycles)) {
    const { room } = fixture({ mapId: initialMap });
    const state = initializeSeries(room, { seriesMode: 'party3', initialMap });
    assert.deepEqual(state.mapCycle, expected);
    assert.equal(state.round, 1);
    assert.equal(state.total, 3);
    assert.deepEqual(state.points, { blue: 0, pink: 0 });
    assert.equal(room.ranked, false);
    assert.equal(room.seriesMode, 'party3');
    assert.equal(room.round, 7, 'existing rematch metadata is independent');
  }
  const { room } = fixture();
  assert.equal(initializeSeries(room), null);
  assert.equal(seriesState(room), null);
  assert.equal(room.seriesMode, 'single');
  assert.equal(room.ranked, true);
  assert.equal(recordSeriesResult(room), false);
  assert.equal(advanceSeries(room), null);
});

test('party validation rejects incompatible modes before changing the room', () => {
  for (const [extra, mode] of [[{}, 'bogus'], [{ mode: 'duel' }, 'party3'], [{ training: true }, 'party3'],
    [{ training: { status: 'ready' } }, 'party3'], [{ matchmaking: { source: 'demo' } }, 'party3']]) {
    const { room } = fixture(extra);
    assert.throws(() => initializeSeries(room, { seriesMode: mode }), { code: 'invalid_series_mode' });
    assert.equal(room.seriesMode, undefined);
    assert.equal(room.ranked, true);
  }
  const { room } = fixture({ practice: true });
  assert.equal(initializeSeries(room, { seriesMode: 'party3' }).round, 1);
  assert.throws(() => initializeSeries(room, { seriesMode: 'party3', initialMap: 'unknown' }), { code: 'invalid_series_mode' });
});

test('real movement rescues satisfy the party goal and only award one bonus', () => {
  const { room, blue, ally } = fixture();
  initializeSeries(room, { seriesMode: 'party3' });
  const secondAlly = { ...ally, id: 'third-ally', x: 3, y: 6, bubbleTicks: 10 };
  ally.bubbleTicks = 10;
  room.players.set(secondAlly.id, secondAlly);
  room.roster.push(secondAlly);
  queueInput(blue, { rescues: 100, progress: { blue: 2 } });
  stepMatch(room);
  assert.deepEqual(seriesState(room).mission.progress, { blue: 0, pink: 0 });
  queueInput(blue, 'right');
  stepMatch(room);
  assert.equal(blue.rescues, 2);
  assert.deepEqual(seriesState(room).mission, { kind: 'rescues', target: 2, progress: { blue: 2, pink: 0 } });
  assert.equal(finish(room), true);
  assert.deepEqual(seriesState(room).points, { blue: 2, pink: 1 });
  assert.equal(recordSeriesResult(room), false);
  blue.rescues = 0;
  assert.deepEqual(seriesState(room).mission.progress, { blue: 2, pink: 0 }, 'completed progress owns its values');
});

test('only current roster counters count, including disconnected starters, and each team bonus is capped', () => {
  const { room, blue, pink } = fixture();
  initializeSeries(room, { seriesMode: 'party3' });
  room.players.set('spectator', { id: 'spectator', team: 'pink', rescues: 9000 });
  room.result = { draw: true, scoreboard: [{ id: pink.id, team: 'pink', rescues: 9000 }] };
  blue.rescues = 100;
  room.players.delete(blue.id);
  assert.deepEqual(seriesState(room).mission.progress, { blue: 2, pink: 0 });
  pink.rescues = 100;
  assert.equal(finish(room, { winnerTeam: 'blue' }), true);
  assert.deepEqual(seriesState(room).points, { blue: 3, pink: 1 });
  assert.deepEqual(seriesState(room).history[0].points, { blue: 3, pink: 1 });
});

test('invalid counters and duplicate roster identities cannot create cooperation credit', () => {
  const { room, blue, ally, pink, pinkAlly } = fixture();
  initializeSeries(room, { seriesMode: 'party3' });
  Object.assign(blue, { rescues: 1 });
  Object.assign(ally, { rescues: '2' });
  Object.assign(pink, { rescues: Infinity });
  Object.assign(pinkAlly, { rescues: -100 });
  room.roster.push(blue);
  assert.deepEqual(seriesState(room).mission.progress, { blue: 1, pink: 0 });
  ally.rescues = 1.5;
  assert.deepEqual(seriesState(room).mission.progress, { blue: 1, pink: 0 });
  room.roster = [];
  assert.deepEqual(seriesState(room).mission.progress, { blue: 0, pink: 0 }, 'players are not a substitute for the current match roster');
});

test('finish and continuation reject early, duplicate and stale round results', () => {
  const { room } = fixture();
  initializeSeries(room, { seriesMode: 'party3' });
  room.result = { draw: true };
  assert.equal(recordSeriesResult(room), false, 'playing results are not finalized');
  assert.equal(advanceSeries(room), null);
  room.phase = 'finished';
  room.matchId = null;
  assert.equal(recordSeriesResult(room), false);
  room.matchId = 'round-one';
  assert.equal(recordSeriesResult(room), true);
  assert.equal(recordSeriesResult(room), false);
  room.matchId = 'another-id-same-round';
  assert.equal(recordSeriesResult(room), false, 'one round cannot be recorded twice with different IDs');
  assert.equal(advanceSeries(room), null, 'continuation must agree with the recorded match');
  room.matchId = 'round-one';
  assert.equal(advanceSeries(room), 'harbor');
  assert.equal(room.mapId, 'harbor');
  assert.equal(advanceSeries(room), null);
  assert.equal(recordSeriesResult(room), false, 'previous match cannot score in the new round');
  assert.deepEqual(seriesState(room).points, { blue: 1, pink: 1 });
  assert.equal(seriesState(room).round, 2);
});

test('round two collects five real pickups through movement for its cooperation bonus', () => {
  const { room, blue } = fixture();
  initializeSeries(room, { seriesMode: 'party3' });
  finish(room);
  nextRound(room, 'round-two');
  assert.deepEqual(seriesState(room).mission, { kind: 'items', target: 5, progress: { blue: 0, pink: 0 } });
  for (let x = 3; x <= 7; x++) room.items.set(`${x},5`, { x, y: 5, type: 'wave' });
  for (let move = 0; move < 5; move++) {
    queueInput(blue, 'right');
    stepMatch(room);
    stepMatch(room);
  }
  assert.equal(blue.itemsCollected, 5);
  assert.deepEqual(seriesState(room).mission.progress, { blue: 5, pink: 0 });
  finish(room, { winnerTeam: 'pink' });
  assert.deepEqual(seriesState(room).history[1].points, { blue: 1, pink: 2 });
  assert.deepEqual(seriesState(room).points, { blue: 2, pink: 3 });
});

test('disabled items and classic round three use achievable rescue missions', () => {
  const { room } = fixture({ itemMode: false });
  initializeSeries(room, { seriesMode: 'party3' });
  finish(room);
  nextRound(room, 'round-two');
  assert.deepEqual(seriesState(room).mission, { kind: 'rescues', target: 2, progress: { blue: 0, pink: 0 } });
  finish(room);
  nextRound(room, 'round-three');
  assert.deepEqual(seriesState(room).mission, { kind: 'rescues', target: 2, progress: { blue: 0, pink: 0 } });
});

test('relay and harmony round three count only successful engine passes', () => {
  for (const ruleSet of ['relay', 'harmony']) {
    const { room, blue, ally } = fixture({ ruleSet });
    initializeSeries(room, { seriesMode: 'party3' });
    finish(room);
    nextRound(room, 'round-two');
    finish(room);
    nextRound(room, 'round-three');
    assert.deepEqual(seriesState(room).mission, { kind: 'passes', target: 3, progress: { blue: 0, pink: 0 } });
    Object.assign(blue, { x: 6, y: 5, facing: 'left' });
    Object.assign(ally, { x: 4, y: 5, facing: 'right' });
    stepMatch(room); // Pick up the actual center star.
    assert.equal(room.relay.carrierId, blue.id);
    for (const carrier of [blue, ally, blue]) {
      while (room.tick < room.relay.nextPassTick) stepMatch(room);
      queueInput(carrier, 'pass_star');
      stepMatch(room);
    }
    assert.equal(blue.passes + ally.passes, 3);
    assert.deepEqual(seriesState(room).mission.progress, { blue: 3, pink: 0 });
    finish(room);
    assert.deepEqual(seriesState(room).points, { blue: 4, pink: 3 });
    assert.deepEqual(seriesState(room).outcome, { winnerTeam: 'blue' });
  }
});

test('exactly three completed rounds determine a tie and explicit continuation creates a fresh party', () => {
  const { room, blue, pink } = fixture();
  initializeSeries(room, { seriesMode: 'party3' });
  const firstId = seriesState(room).id;
  blue.rescues = 2;
  finish(room);
  assert.equal(seriesState(room).complete, false);
  assert.equal(seriesState(room).outcome, null);
  nextRound(room, 'round-two');
  pink.itemsCollected = 5;
  finish(room);
  nextRound(room, 'round-three');
  finish(room);
  const result = seriesState(room);
  assert.equal(result.complete, true);
  assert.equal(result.round, 3);
  assert.equal(result.history.length, 3);
  assert.deepEqual(result.points, { blue: 4, pink: 4 });
  assert.deepEqual(result.outcome, { draw: true });
  room.matchId = 'unexpected-fourth';
  assert.equal(recordSeriesResult(room), false);
  assert.equal(advanceSeries(room), null);
  room.matchId = 'round-three';
  const players = [...room.players.values()], roster = room.roster;
  assert.equal(advanceSeries(room), 'garden');
  const fresh = seriesState(room);
  assert.notEqual(fresh.id, firstId);
  assert.equal(fresh.round, 1);
  assert.equal(fresh.history.length, 0);
  assert.deepEqual(fresh.points, { blue: 0, pink: 0 });
  assert.equal(fresh.complete, false);
  assert.equal(fresh.outcome, null);
  assert.deepEqual([...room.players.values()], players);
  assert.equal(room.roster, roster);
  assert.equal(blue.characterId, 'bibi');
  assert.equal(blue.skinId, 'mint');
  assert.equal(blue.orbSkinId, 'duck');
  assert.equal(blue.team, 'blue');
  assert.equal(room.round, 7);
  assert.equal(advanceSeries(room), null);
  assert.equal(result.history.length, 3, 'new party cannot mutate the earlier result projection');
});

test('cumulative points determine the final winner independently of the last round winner', () => {
  const { room, blue } = fixture();
  initializeSeries(room, { seriesMode: 'party3' });
  blue.rescues = 2;
  finish(room, { winnerTeam: 'blue' });
  nextRound(room, 'round-two');
  blue.itemsCollected = 5;
  finish(room, { winnerTeam: 'blue' });
  nextRound(room, 'round-three');
  finish(room, { winnerTeam: 'pink' });
  assert.deepEqual(seriesState(room).points, { blue: 6, pink: 2 });
  assert.deepEqual(seriesState(room).outcome, { winnerTeam: 'blue' });
});

test('public state owns nested values, excludes private fields and never updates internal state', () => {
  const { room, blue } = fixture();
  initializeSeries(room, { seriesMode: 'party3' });
  blue.rescues = 2;
  finish(room, { winnerTeam: 'blue', accessToken: 'private-result' });
  room.series.accessToken = 'private-series';
  const before = structuredClone(room.series);
  const state = seriesState(room);
  assert.deepEqual(room.series, before);
  assert.doesNotMatch(JSON.stringify(state), /private-|accessToken|resumeToken|userId|socket|recordedMatch/);
  state.points.blue = 999;
  state.mapCycle[0] = 'fake';
  state.mission.progress.blue = 999;
  state.history[0].points.blue = 999;
  state.history[0].mission.progress.blue = 999;
  state.history[0].outcome.winnerTeam = 'pink';
  assert.deepEqual(seriesState(room).points, { blue: 3, pink: 0 });
  assert.equal(seriesState(room).mapCycle[0], 'garden');
  assert.deepEqual(seriesState(room).mission.progress, { blue: 2, pink: 0 });
  assert.equal(seriesState(room).history[0].outcome.winnerTeam, 'blue');
  nextRound(room, 'round-two');
  assert.deepEqual(seriesState(room).history[0].mission.progress, { blue: 2, pink: 0 });
});

test('whole-party contributions retain actual earlier rescues after later counters reset', () => {
  const { room, blue, ally } = fixture();
  initializeSeries(room, { seriesMode: 'party3' });
  assert.deepEqual(seriesState(room).contributions, []);
  ally.bubbleTicks = 10;
  const secondAlly = { ...ally, id: 'third-ally', x: 3, y: 6 };
  room.players.set(secondAlly.id, secondAlly);
  room.roster.push(secondAlly);
  queueInput(blue, 'right');
  stepMatch(room);
  assert.equal(blue.rescues, 2, 'two rescues came from authoritative movement');
  assert.deepEqual(seriesState(room).contributions, [], 'ongoing counters are not completed round contributions');
  finish(room, { winnerTeam: 'blue' });
  const first = seriesState(room).history[0].contributions.find(entry => entry.playerId === blue.id);
  assert.deepEqual(first, { playerId: 'blue-one', name: 'blue-one', team: 'blue', score: 300,
    bombsPlaced: 0, itemsCollected: 0, rescues: 2, passes: 0, interceptions: 0, deliveries: 0 });
  nextRound(room, 'round-two');
  assert.equal(blue.rescues, 0);
  room.items.set('3,6', { x: 3, y: 6, type: 'wave' });
  queueInput(blue, 'up');
  stepMatch(room);
  stepMatch(room);
  assert.equal(blue.itemsCollected, 1);
  assert.equal(seriesState(room).contributions.find(entry => entry.playerId === blue.id).itemsCollected, 0);
  finish(room);
  nextRound(room, 'round-three');
  finish(room, { winnerTeam: 'pink' });
  const completed = seriesState(room), own = completed.contributions.find(entry => entry.playerId === blue.id);
  assert.equal(completed.complete, true);
  assert.deepEqual(own, { playerId: 'blue-one', name: 'blue-one', team: 'blue', score: 310,
    bombsPlaced: 0, itemsCollected: 1, rescues: 2, passes: 0, interceptions: 0, deliveries: 0 });
  assert.equal(room.result.scoreboard.find(entry => entry.id === blue.id).rescues, 0, 'ordinary scoreboard remains the last round');
  assert.deepEqual(completed.history.map(round => round.contributions.find(entry => entry.playerId === blue.id).rescues), [2, 0, 0]);
});

test('party aggregates every allowed counter exactly once and explicit new party clears the totals', () => {
  const { room, blue } = fixture();
  initializeSeries(room, { seriesMode: 'party3' });
  Object.assign(blue, { score: 12, bombsPlaced: 3, itemsCollected: 4, rescues: 2, passes: 6, interceptions: 1, deliveries: 2 });
  finish(room);
  assert.equal(recordSeriesResult(room), false);
  nextRound(room, 'round-two');
  Object.assign(blue, { score: 8, bombsPlaced: 1, itemsCollected: 2, rescues: 1, passes: 1, interceptions: 2, deliveries: 1 });
  finish(room);
  nextRound(room, 'round-three');
  Object.assign(blue, { score: 4, bombsPlaced: 2, itemsCollected: 0, rescues: 0, passes: 2, interceptions: 0, deliveries: 2 });
  finish(room);
  assert.equal(recordSeriesResult(room), false);
  const result = seriesState(room);
  assert.deepEqual(result.contributions?.find(entry => entry.playerId === blue.id), {
    playerId: 'blue-one', name: 'blue-one', team: 'blue', score: 24,
    bombsPlaced: 6, itemsCollected: 6, rescues: 3, passes: 9, interceptions: 3, deliveries: 5
  });
  assert.equal(advanceSeries(room), 'garden');
  assert.deepEqual(seriesState(room).contributions, []);
  assert.equal(result.contributions.find(entry => entry.playerId === blue.id).rescues, 3, 'the prior public party result remains intact');
  assert.equal(recordSeriesResult(room), false, 'the preceding match cannot seed the new party totals');
});

test('contribution history includes departed starters and ignores non-roster occupants and duplicate identities', () => {
  const { room, blue } = fixture();
  initializeSeries(room, { seriesMode: 'party3' });
  blue.rescues = 2;
  room.players.delete(blue.id);
  room.players.set('newcomer', { id: 'newcomer', name: 'New', team: 'blue', score: 9999, rescues: 99 });
  room.roster.push(blue);
  finish(room);
  let result = seriesState(room);
  assert.equal(result.history[0].contributions?.filter(entry => entry.playerId === blue.id).length, 1);
  assert.equal(result.contributions.find(entry => entry.playerId === blue.id).rescues, 2);
  assert.equal(result.contributions.some(entry => entry.playerId === 'newcomer'), false);
  nextRound(room, 'round-two');
  finish(room);
  result = seriesState(room);
  assert.equal(result.contributions.find(entry => entry.playerId === blue.id).rescues, 2);
  assert.equal(result.history[1].contributions.some(entry => entry.playerId === blue.id), false);
  assert.equal(result.contributions.some(entry => entry.playerId === 'newcomer'), true);
});

test('contributions are bounded to eight unique roster players per round with finite counters', () => {
  const { room } = fixture();
  initializeSeries(room, { seriesMode: 'party3' });
  for (let round = 1; round <= 3; round++) {
    const entries = Array.from({ length: 10 }, (_, index) => ({ id: `round-${round}-player-${index}`, team: 'blue',
      name: 'abcdefghijklmnop', score: 2_000_000, bombsPlaced: -1, itemsCollected: '5', rescues: Infinity, passes: 1.5,
      interceptions: NaN, deliveries: 3 }));
    room.players = new Map(entries.map(player => [player.id, player]));
    room.roster = [entries[0], entries[0], ...entries.slice(1)];
    finish(room);
    const completed = seriesState(room).history.at(-1);
    assert.equal(completed.contributions?.length, 8);
    assert.deepEqual(completed.contributions[0], { playerId: `round-${round}-player-0`, name: 'abcdefghijkl', team: 'blue',
      score: 1_000_000, bombsPlaced: 0, itemsCollected: 0, rescues: 0, passes: 0, interceptions: 0, deliveries: 3 });
    if (round < 3) nextRound(room, `round-${round + 1}`);
  }
  assert.equal(seriesState(room).contributions.length, 24, 'departed identities remain bounded by three rosters');
});

test('public contributions own their nested values and cannot leak roster credentials', () => {
  const { room, blue } = fixture();
  initializeSeries(room, { seriesMode: 'party3' });
  blue.rescues = 2;
  finish(room);
  const state = seriesState(room);
  assert.ok(Array.isArray(state.contributions));
  assert.doesNotMatch(JSON.stringify(state), /private-|accessToken|resumeToken|userId|socket/);
  blue.rescues = 999;
  blue.name = 'Changed';
  state.contributions[0].rescues = 999;
  state.history[0].contributions[0].rescues = 888;
  state.history[0].contributions.push({ playerId: 'injected' });
  const copy = seriesState(room);
  assert.equal(copy.contributions[0].rescues, 2);
  assert.equal(copy.contributions[0].name, 'blue-one');
  assert.equal(copy.history[0].contributions[0].rescues, 2);
  assert.equal(copy.history[0].contributions.length, 4);
});
