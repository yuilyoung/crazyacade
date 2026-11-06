import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMotionTimeline } from '../public/motion-timeline.js';

const player = (extra = {}) => ({ id: 'p', name: 'Player', x: 1, y: 1, facing: 'up', alive: true, bubbleTicks: 0, itemsCollected: 0, ...extra });
const snapshot = (extra = {}) => ({ roomId: 'room', matchId: 'match', round: 1, mapId: 'garden', mode: 'solo', ruleSet: 'classic', phase: 'playing', tick: 10, players: [player()], soft: [], items: [], orbs: [], waves: [], dartEffects: [], relay: null, training: null, ...extra });
const clone = value => structuredClone(value);
const pose = frame => frame.players.get('p');
function frozen(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') frozen(child);
  return Object.freeze(value);
}
function movingTimeline() {
  const timeline = createMotionTimeline(), first = snapshot(), next = snapshot({ tick: 11, players: [player({ x: 2, facing: 'right' })] });
  timeline.update(first, { now: 0 });
  timeline.update(next, { now: 100 });
  return { timeline, first, next };
}

test('baseline copies player DTOs and gives existing tiles settled ages without events', () => {
  const timeline = createMotionTimeline(), state = frozen(snapshot({ orbs: [{ x: 2, y: 2, fuse: 4 }], waves: [{ x: 3, y: 3, ttl: 2 }] }));
  const frame = timeline.update(state, { now: 100 });
  assert.notEqual(pose(frame).player, state.players[0]);
  assert.deepEqual(pose(frame).player, state.players[0]);
  assert.equal(pose(frame).x, 1);
  assert.equal(pose(frame).hit, null);
  assert.equal(pose(frame).spawn, null);
  assert.equal(pose(frame).bubble, false);
  assert.ok(frame.orbs.get('2,2').ageMs >= 160);
  assert.ok(frame.waves.get('3,3').ageMs >= 450);
  assert.deepEqual(frame.effects, []);
});

test('confirmed adjacent movement interpolates midpoint and stops at exactly 80ms', () => {
  const { timeline, next } = movingTimeline();
  const middle = pose(timeline.update(next, { now: 140 }));
  assert.equal(middle.x, 1.5);
  assert.equal(middle.y, 1);
  assert.equal(middle.facing, 'right');
  assert.equal(middle.moving, true);
  assert.ok(middle.walkWeight > 0 && middle.walkWeight <= 1);
  assert.ok(Number.isFinite(middle.walkPhase));
  const end = pose(timeline.update(next, { now: 180 }));
  assert.equal(end.x, 2);
  assert.equal(end.moving, false);
  assert.equal(end.walkWeight, 0);
});

test('walk cadence follows elapsed milliseconds rather than the number of drawn frames', () => {
  const sparse = movingTimeline(), dense = movingTimeline();
  const start = pose(sparse.timeline.update(sparse.next, { now: 100 }));
  for (let now = 104; now < 140; now += 4) dense.timeline.update(dense.next, { now });
  const sparseMiddle = pose(sparse.timeline.update(sparse.next, { now: 140 }));
  const denseMiddle = pose(dense.timeline.update(dense.next, { now: 140 }));
  assert.notEqual(sparseMiddle.walkPhase, start.walkPhase);
  assert.equal(sparseMiddle.walkPhase, denseMiddle.walkPhase);
  assert.equal(sparseMiddle.x, denseMiddle.x);
});

test('a turn during interpolation starts from the previous confirmed cell', () => {
  const { timeline } = movingTimeline();
  const turn = snapshot({ tick: 12, players: [player({ x: 2, y: 2 })] });
  const start = pose(timeline.update(turn, { now: 140 }));
  assert.equal(start.x, 2);
  assert.equal(start.y, 1);
  const middle = pose(timeline.update(turn, { now: 180 }));
  assert.equal(middle.x, 2);
  assert.equal(middle.y, 1.5);
});

for (const [name, extra] of [['two cells', { x: 3 }], ['diagonal', { x: 2, y: 2 }]]) {
  test(`${name} movement snaps instead of crossing unknown cells`, () => {
    const timeline = createMotionTimeline();
    timeline.update(snapshot(), { now: 0 });
    const result = pose(timeline.update(snapshot({ players: [player(extra)] }), { now: 100 }));
    assert.equal(result.x, extra.x);
    assert.equal(result.y, extra.y ?? 1);
    assert.equal(result.moving, false);
  });
}

for (const settings of [{ effects: 'calm' }, { reducedMotion: true }, { effects: 'minimal' }]) {
  test(`motion settings snap confirmed positions: ${JSON.stringify(settings)}`, () => {
    const { timeline, next } = movingTimeline();
    const result = pose(timeline.update(next, { now: 140, ...settings }));
    assert.equal(result.x, 2);
    assert.equal(result.moving, false);
    assert.equal(result.walkWeight, 0);
    assert.equal(pose(timeline.update(next, { now: 150 })).x, 2, 'enabling full does not replay a completed move');
  });
}

test('new snapshots with the same tick process actual changes once', () => {
  const timeline = createMotionTimeline();
  timeline.update(snapshot(), { now: 0 });
  const changed = snapshot({ orbs: [{ x: 2, y: 2, fuse: 30 }] });
  const initial = timeline.update(changed, { now: 10 });
  assert.equal(initial.effects.length, 1);
  assert.equal(initial.effects[0].kind, 'place');
  assert.equal(initial.effects[0].ageMs, 0);
  const repeated = timeline.update(clone(changed), { now: 30 });
  assert.equal(repeated.effects.length, 1);
  assert.equal(repeated.effects[0].id, initial.effects[0].id);
  assert.equal(repeated.effects[0].ageMs, 20);
  assert.equal(repeated.orbs.get('2,2').ageMs, 20);
  assert.equal(timeline.update(changed, { now: 40 }).effects.length, 1);
});

test('repeated rAF frames do not refresh the snapshot receive deadline', () => {
  const { timeline, next } = movingTimeline();
  for (let now = 116; now <= 388; now += 16) timeline.update(next, { now });
  const changed = snapshot({ tick: 12, players: [player({ x: 3 })], orbs: [{ x: 4, y: 4 }] });
  const frame = timeline.update(changed, { now: 401 });
  assert.equal(pose(frame).x, 3);
  assert.deepEqual(frame.effects, []);
  assert.ok(frame.orbs.get('4,4').ageMs >= 160);
});

test('exactly 300ms between received snapshots still permits a real event', () => {
  const timeline = createMotionTimeline();
  timeline.update(snapshot(), { now: 0 });
  const frame = timeline.update(snapshot({ orbs: [{ x: 2, y: 2 }] }), { now: 300 });
  assert.equal(frame.effects[0].kind, 'place');
});

for (const [name, change, options] of [
  ['new match', { matchId: 'next' }, {}], ['new round', { round: 2 }, {}], ['new map', { mapId: 'candy' }, {}],
  ['new room', { roomId: 'other' }, {}], ['backward tick', { tick: 9 }, {}],
  ['clock reversal', {}, { now: -1 }], ['disconnected', {}, { connection: 'reconnecting' }], ['hidden tab', {}, { hidden: true }],
  ['waiting transition', { phase: 'waiting' }, {}]
]) {
  test(`${name} establishes a baseline without synthetic rescue or movement`, () => {
    const timeline = createMotionTimeline();
    timeline.update(snapshot({ players: [player({ bubbleTicks: 10 })] }), { now: 0 });
    const frame = timeline.update(snapshot({ players: [player({ x: 2 })], orbs: [{ x: 3, y: 3 }], ...change }), { now: 100, ...options });
    assert.equal(pose(frame).x, 2);
    assert.equal(pose(frame).rescue, null);
    assert.deepEqual(frame.effects, []);
  });
}

test('resuming after hidden or disconnected frames cannot replay changes', () => {
  for (const boundary of [{ hidden: true }, { connection: 'disconnected' }]) {
    const timeline = createMotionTimeline();
    timeline.update(snapshot(), { now: 0 });
    timeline.update(snapshot({ players: [player({ bubbleTicks: 10 })] }), { now: 100, ...boundary });
    const resumed = timeline.update(snapshot({ players: [player({ x: 2 })], orbs: [{ x: 2, y: 2 }] }), { now: 110 });
    assert.deepEqual(resumed.effects, []);
    assert.equal(pose(resumed).x, 2);
  }
});

for (const training of [
  { stage: 'pickup', attempts: 0, completed: 1, status: 'ready' },
  { stage: 'escape', attempts: 1, completed: 0, status: 'retrying' },
  { stage: 'escape', attempts: 0, completed: 0, status: 'ready' }
]) {
  test(`training reset is a baseline: ${JSON.stringify(training)}`, () => {
    const timeline = createMotionTimeline();
    timeline.update(snapshot({ training: { stage: 'escape', attempts: 0, completed: 0, status: 'active' }, players: [player({ bubbleTicks: 10 })] }), { now: 0 });
    const frame = timeline.update(snapshot({ training, players: [player({ x: 5 })] }), { now: 100 });
    assert.deepEqual(frame.effects, []);
    assert.equal(pose(frame).x, 5);
    assert.equal(pose(frame).rescue, null);
  });
}

function eventSnapshots() {
  const players = [player(), player({ id: 'rescue', bubbleTicks: 10 }), player({ id: 'death' }), player({ id: 'spawn', alive: false }), player({ id: 'pickup' })];
  const before = snapshot({ players, orbs: [{ x: 2, y: 2 }], soft: ['4,4'], items: [{ x: 1, y: 1, type: 'wave' }] });
  const after = snapshot({ tick: 11, players: players.map(p => ({ ...p, bubbleTicks: p.id === 'p' ? 10 : 0, alive: p.id !== 'death', itemsCollected: p.id === 'pickup' ? 1 : 0 })), orbs: [{ x: 3, y: 3 }], waves: [{ x: 2, y: 2, ttl: 4 }, { x: 4, y: 4, ttl: 4 }], dartEffects: [{ x: 1, y: 1, dx: 1, dy: 0, length: 3, ttl: 3 }], relay: { passEffects: [{ x: 1, y: 2, dx: 0, dy: 1, length: 4, interception: true, ttl: 5 }] } });
  return { before, after };
}

const durations = { place: 160, explode: 450, break: 380, pickup: 600, hit: 200, rescue: 650, death: 420, spawn: 500, dart: 200, pass: 250 };
test('real snapshot transitions generate all ten event kinds with active zero progress', () => {
  const timeline = createMotionTimeline(), { before, after } = eventSnapshots();
  timeline.update(before, { now: 0 });
  const frame = timeline.update(after, { now: 100 });
  assert.deepEqual(frame.effects.map(e => e.kind).sort(), Object.keys(durations).sort());
  for (const effect of frame.effects) {
    assert.equal(effect.ageMs, 0);
    assert.equal(effect.progress, 0);
    assert.equal(effect.durationMs, durations[effect.kind]);
    assert.ok(Number.isFinite(effect.x) && Number.isFinite(effect.y));
  }
  assert.equal(pose(frame).hit, 0);
  assert.equal(pose(frame).bubble, true);
  assert.equal(frame.players.get('rescue').rescue, 0);
  assert.equal(frame.players.get('spawn').spawn, 0);
  assert.equal(frame.players.get('death').death, 0);
  assert.ok(frame.players.get('death').alpha <= .6);
  const pass = frame.effects.find(e => e.kind === 'pass');
  assert.equal(pass.dx, 0);
  assert.equal(pass.dy, 1);
  assert.equal(pass.length, 4);
  assert.equal(pass.interception, true);
});

for (const [kind, duration] of Object.entries(durations)) {
  test(`${kind} advances with time and expires at exactly ${duration}ms`, () => {
    const timeline = createMotionTimeline(), { before, after } = eventSnapshots();
    timeline.update(before, { now: 0 });
    timeline.update(after, { now: 100 });
    for (let age = 50; age < duration; age += 50) timeline.update(clone(after), { now: 100 + age });
    const almost = timeline.update(clone(after), { now: 100 + duration - 1 });
    const effect = almost.effects.find(e => e.kind === kind);
    assert.equal(effect.ageMs, duration - 1);
    assert.equal(effect.progress, (duration - 1) / duration);
    const expired = timeline.update(clone(after), { now: 100 + duration });
    assert.equal(expired.effects.some(e => e.kind === kind), false);
    if (kind === 'death') {
      assert.equal(expired.players.get('death').alpha, 0);
      assert.equal(expired.players.get('death').death, null);
    }
  });
}

test('disappearing tiles without a real wave create no explosion or break', () => {
  const timeline = createMotionTimeline();
  timeline.update(snapshot({ soft: ['2,2'], orbs: [{ x: 3, y: 3 }] }), { now: 0 });
  assert.deepEqual(timeline.update(snapshot(), { now: 100 }).effects, []);
});

test('pickup needs an increased counter and uses a generic marker when type is uncertain', () => {
  const timeline = createMotionTimeline();
  timeline.update(snapshot({ items: [{ x: 4, y: 4, type: 'dart' }] }), { now: 0 });
  assert.deepEqual(timeline.update(snapshot(), { now: 100 }).effects, []);
  const frame = timeline.update(snapshot({ players: [player({ itemsCollected: 1 })] }), { now: 200 });
  assert.equal(frame.effects[0].kind, 'pickup');
  assert.equal(frame.effects[0].itemType, undefined);
});

test('a known disappeared pickup at the collecting cell preserves its actual type', () => {
  const timeline = createMotionTimeline();
  timeline.update(snapshot({ items: [{ x: 1, y: 1, type: 'wave' }] }), { now: 0 });
  const frame = timeline.update(snapshot({ players: [player({ itemsCollected: 1 })] }), { now: 100 });
  assert.equal(frame.effects[0].itemType, 'wave');
});

test('several pickups between snapshots use a generic marker rather than guessing one type', () => {
  const timeline = createMotionTimeline();
  timeline.update(snapshot({ items: [{ x: 1, y: 1, type: 'wave' }] }), { now: 0 });
  const frame = timeline.update(snapshot({ players: [player({ itemsCollected: 2 })] }), { now: 100 });
  assert.equal(frame.effects.length, 1);
  assert.equal(frame.effects[0].kind, 'pickup');
  assert.equal(frame.effects[0].itemType, undefined);
});

test('new waves begin at zero age and renewed wave TTL restarts only that tile', () => {
  const timeline = createMotionTimeline();
  timeline.update(snapshot(), { now: 0 });
  const initial = timeline.update(snapshot({ waves: [{ x: 2, y: 2, ttl: 4 }, { x: 3, y: 3, ttl: 4 }] }), { now: 100 });
  assert.equal(initial.waves.get('2,2').ageMs, 0);
  const aged = timeline.update(snapshot({ waves: [{ x: 2, y: 2, ttl: 3 }, { x: 3, y: 3, ttl: 3 }] }), { now: 200 });
  assert.equal(aged.waves.get('2,2').ageMs, 100);
  const renewed = timeline.update(snapshot({ waves: [{ x: 2, y: 2, ttl: 4 }, { x: 3, y: 3, ttl: 2 }] }), { now: 250 });
  assert.equal(renewed.waves.get('2,2').ageMs, 0);
  assert.equal(renewed.waves.get('3,3').ageMs, 150);
  assert.deepEqual(renewed.effects, []);
});

test('consuming an owned pin records an actual hit while preserving an unbubbled pose', () => {
  const timeline = createMotionTimeline();
  timeline.update(snapshot({ players: [player({ pin: true })] }), { now: 0 });
  const frame = timeline.update(snapshot({ players: [player({ pin: false })] }), { now: 100 });
  assert.equal(pose(frame).bubble, false);
  assert.equal(pose(frame).hit, 0);
  assert.equal(frame.effects[0].kind, 'hit');
});

test('final elimination remains visible on playing to finished without a rescue', () => {
  const timeline = createMotionTimeline();
  timeline.update(snapshot({ players: [player({ bubbleTicks: 1 })] }), { now: 0 });
  const frame = timeline.update(snapshot({ phase: 'finished', players: [player({ alive: false })] }), { now: 100 });
  assert.deepEqual(frame.effects.map(e => e.kind), ['death']);
  assert.equal(pose(frame).death, 0);
});

test('finished screens cannot turn cleared bubbles into rescues', () => {
  const timeline = createMotionTimeline();
  timeline.update(snapshot({ players: [player({ bubbleTicks: 1 })] }), { now: 0 });
  const frame = timeline.update(snapshot({ phase: 'finished' }), { now: 100 });
  assert.equal(pose(frame).rescue, null);
  assert.deepEqual(frame.effects, []);
});

test('a removed player creates neither a death ghost nor a spawn when newly listed', () => {
  const timeline = createMotionTimeline();
  timeline.update(snapshot(), { now: 0 });
  const removed = timeline.update(snapshot({ players: [] }), { now: 100 });
  assert.equal(removed.players.size, 0);
  assert.deepEqual(removed.effects, []);
  assert.deepEqual(timeline.update(snapshot(), { now: 200 }).effects, []);
});

test('respawning snaps immediately even at an adjacent position', () => {
  const timeline = createMotionTimeline();
  timeline.update(snapshot({ players: [player({ alive: false })] }), { now: 0 });
  const frame = timeline.update(snapshot({ players: [player({ x: 2 })] }), { now: 100 });
  assert.equal(pose(frame).x, 2);
  assert.equal(pose(frame).moving, false);
  assert.equal(pose(frame).spawn, 0);
});

test('dart and pass paths restart only when newly visible or their TTL increases', () => {
  const timeline = createMotionTimeline();
  timeline.update(snapshot(), { now: 0 });
  const path = { x: 1, y: 1, dx: 1, dy: 0, length: 3, ttl: 3 };
  const state = snapshot({ dartEffects: [path], relay: { passEffects: [path] } });
  const first = timeline.update(state, { now: 10 });
  assert.equal(first.effects.length, 2);
  const decreasing = snapshot({ dartEffects: [{ ...path, ttl: 2 }], relay: { passEffects: [{ ...path, ttl: 2 }] } });
  assert.equal(timeline.update(decreasing, { now: 30 }).effects.length, 2);
  const renewed = timeline.update(clone(state), { now: 50 });
  assert.equal(renewed.effects.length, 4);
  assert.equal(renewed.effects.filter(e => e.ageMs === 0).length, 2);
});

test('baseline paths do not launch projectiles on the next identical snapshot', () => {
  const timeline = createMotionTimeline(), state = snapshot({ dartEffects: [{ x: 1, y: 1, dx: 1, dy: 0, length: 3, ttl: 3 }] });
  timeline.update(state, { now: 0 });
  assert.deepEqual(timeline.update(clone(state), { now: 100 }).effects, []);
});

test('calm and reduced motion keep static event timing while minimal omits decorations', () => {
  for (const options of [{ effects: 'calm' }, { reducedMotion: true }]) {
    const timeline = createMotionTimeline();
    timeline.update(snapshot(), { now: 0, ...options });
    const next = snapshot({ players: [player({ bubbleTicks: 10 })] });
    const frame = timeline.update(next, { now: 100, ...options });
    assert.equal(pose(frame).hit, 0);
    assert.equal(frame.effects[0].kind, 'hit');
    assert.equal(pose(frame).bubble, true);
    assert.deepEqual(timeline.update(next, { now: 110, effects: 'minimal' }).effects, []);
    assert.deepEqual(timeline.update(next, { now: 120 }).effects, []);
  }
});

test('players, transient events, and tile history stay within their hard caps', () => {
  const timeline = createMotionTimeline();
  timeline.update(snapshot(), { now: 0 });
  const tiles = Array.from({ length: 180 }, (_, i) => ({ x: i % 13, y: Math.floor(i / 13) }));
  const frame = timeline.update(snapshot({ players: Array.from({ length: 20 }, (_, i) => player({ id: `p${i}` })), orbs: tiles, waves: tiles }), { now: 100 });
  assert.equal(frame.players.size, 8);
  assert.equal(frame.orbs.size, 143);
  assert.equal(frame.waves.size, 143);
  assert.equal(frame.effects.length, 128);
  assert.equal(new Set(frame.effects.map(e => e.id)).size, 128);
  const cleared = timeline.update(snapshot(), { now: 200 });
  assert.equal(cleared.orbs.size, 0);
  assert.equal(cleared.waves.size, 0);
});

test('input snapshots and previous frames remain unchanged by later updates or frame edits', () => {
  const timeline = createMotionTimeline(), first = frozen(snapshot()), next = frozen(snapshot({ players: [player({ x: 2 })], orbs: [{ x: 2, y: 2 }] }));
  const before = JSON.stringify([first, next]);
  timeline.update(first, { now: 0 });
  const frame = timeline.update(next, { now: 100 });
  const previousFrame = clone(frame);
  timeline.update(next, { now: 140 });
  assert.deepEqual(frame, previousFrame);
  pose(frame).player.x = 99;
  frame.effects[0].x = 99;
  frame.orbs.get('2,2').ageMs = 99;
  const later = timeline.update(next, { now: 150 });
  assert.equal(pose(later).x, 1.625);
  assert.equal(later.effects[0].x, 2);
  assert.equal(later.orbs.get('2,2').ageMs, 50);
  assert.equal(JSON.stringify([first, next]), before);
});

test('explicit reset and absent snapshots clear all history and reestablish a baseline', () => {
  const { timeline, next } = movingTimeline();
  timeline.reset();
  assert.equal(pose(timeline.update(next, { now: 150 })).x, 2);
  const empty = timeline.update(null, { now: 160 });
  assert.equal(empty.players.size, 0);
  assert.equal(empty.orbs.size, 0);
  assert.deepEqual(empty.effects, []);
  const returned = timeline.update(snapshot({ players: [player({ x: 3 })] }), { now: 170 });
  assert.equal(pose(returned).x, 3);
  assert.deepEqual(returned.effects, []);
});

for (const [name, initial, changed] of [
  ['full to calm and back', { effects: 'full' }, { effects: 'calm' }],
  ['reduced motion on and off', { effects: 'full' }, { effects: 'full', reducedMotion: true }],
  ['calm to minimal and back', { effects: 'calm' }, { effects: 'minimal' }],
  ['minimal to full and back', { effects: 'minimal' }, { effects: 'full' }],
  ['reduced preference changes within calm', { effects: 'calm' }, { effects: 'calm', reducedMotion: true }]
]) {
  test(`settings boundary settles all already observed motion: ${name}`, () => {
    const timeline = createMotionTimeline();
    timeline.update(snapshot(), { now: 0, ...initial });
    const observed = snapshot({ players: [player({ x: 2, bubbleTicks: 10 })], orbs: [{ x: 2, y: 2 }], waves: [{ x: 3, y: 3, ttl: 4 }] });
    timeline.update(observed, { now: 100, ...initial });
    for (const [now, settings] of [[110, changed], [120, initial]]) {
      const frame = timeline.update(observed, { now, ...settings });
      assert.deepEqual(frame.effects, [], 'changing preferences must clear old events');
      assert.equal(pose(frame).x, 2);
      assert.equal(pose(frame).moving, false);
      assert.equal(pose(frame).hit, null);
      assert.equal(pose(frame).bubble, true, 'essential state survives');
      assert.ok(frame.orbs.get('2,2').ageMs >= 160, 'an observed orb cannot resume placement spring');
      assert.ok(frame.waves.get('3,3').ageMs >= 450, 'existing waves settle with the boundary');
    }
    const next = timeline.update(snapshot({ ...observed, orbs: [...observed.orbs, { x: 4, y: 4 }] }), { now: 130, ...initial });
    assert.equal(next.effects.some(effect => effect.kind === 'place'), initial.effects !== 'minimal', 'new authoritative events remain enabled');
  });
}
