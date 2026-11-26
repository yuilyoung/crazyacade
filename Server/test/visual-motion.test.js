import test from 'node:test';
import assert from 'node:assert/strict';
import { drawAvatar, drawOrb, drawPickup } from '../public/visuals.js';
import { CHARACTERS, SKINS, ORB_SKINS, ITEM_STYLES } from '../public/cosmetics.js';

// Record painted geometry after Canvas transforms, rather than inspecting source
// or counting calls. This is the Canvas boundary used by the real vector art.
function canvas() {
  let matrix = [1, 0, 0, 1, 0, 0], path = [];
  const stack = [], paints = [];
  const point = (x, y) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
  const multiply = ([a, b, c, d, e, f]) => {
    const [aa, bb, cc, dd, ee, ff] = matrix;
    matrix = [aa*a+cc*b, bb*a+dd*b, aa*c+cc*d, bb*c+dd*d, aa*e+cc*f+ee, bb*e+dd*f+ff];
  };
  const ctx = {
    paints, fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
    save() { stack.push({ matrix: [...matrix], fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, globalAlpha: this.globalAlpha }); },
    restore() { const saved = stack.pop(); matrix = saved.matrix; Object.assign(this, { fillStyle: saved.fillStyle, strokeStyle: saved.strokeStyle, lineWidth: saved.lineWidth, globalAlpha: saved.globalAlpha }); },
    translate(x, y) { multiply([1, 0, 0, 1, x, y]); },
    scale(x, y) { multiply([x, 0, 0, y, 0, 0]); },
    rotate(angle) { multiply([Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0]); },
    beginPath() { path = []; },
    moveTo(x, y) { path.push({ kind: 'move', at: point(x, y) }); },
    lineTo(x, y) { path.push({ kind: 'line', at: point(x, y) }); },
    quadraticCurveTo(cx, cy, x, y) { path.push({ kind: 'curve', control: point(cx, cy), at: point(x, y) }); },
    closePath() { path.push({ kind: 'close' }); },
    ellipse(x, y, rx, ry, rotation, start, end) {
      path.push({ kind: 'ellipse', at: point(x, y), xEdge: point(x + rx * Math.cos(rotation), y + rx * Math.sin(rotation)), yEdge: point(x - ry * Math.sin(rotation), y + ry * Math.cos(rotation)), rx, ry, start, end });
    },
    fill() { const color = typeof this.fillStyle === 'object' ? { gradient: this.fillStyle.coords, stops: this.fillStyle.stops } : this.fillStyle; paints.push({ mode: 'fill', color, path: structuredClone(path) }); },
    stroke() { paints.push({ mode: 'stroke', color: this.strokeStyle, width: this.lineWidth, path: structuredClone(path) }); },
    createRadialGradient(...coords) { return { coords, stops: [], addColorStop(at, color) { this.stops.push([at, color]); } }; },
    fillText(text, x, y) { paints.push({ mode: 'text', text, at: point(x, y), color: this.fillStyle }); },
  };
  return ctx;
}
const base = { characterId: 'momo', skinId: 'classic', facing: 'down', pin: false };
const pose = patch => ({ facing: 'down', moving: false, walkPhase: 0, walkWeight: 0, bubble: false, hit: null, rescue: null, spawn: null, death: null, alpha: 1, ...patch });
function avatar(options = {}, player = base) { const ctx = canvas(); drawAvatar(ctx, player, options); return ctx.paints; }
function object(draw, value, options) { const ctx = canvas(); draw(ctx, value, options); return ctx.paints; }
const filled = (art, color) => art.filter(p => p.mode === 'fill' && p.color === color);
const ellipses = (art, color, rx) => filled(art, color).flatMap(p => p.path).filter(p => p.kind === 'ellipse' && (rx === undefined || p.rx === rx));
const feet = art => filled(art, '#367e97').filter(p => p.path[0]?.kind === 'move' && p.path[0].at[1] > 14);
const hands = art => ellipses(art, '#6bbaca', 4.5);

test('four directions place the face toward travel and show a faceless rear silhouette', () => {
  const front = avatar({ pose: pose() });
  const left = avatar({ pose: pose({ facing: 'left' }) });
  const right = avatar({ pose: pose({ facing: 'right' }) });
  const rear = avatar({ pose: pose({ facing: 'up' }) });
  assert.equal(ellipses(front, '#203f50', 1.8).length, 2);
  assert.equal(ellipses(left, '#203f50', 1.8).length, 1);
  assert.equal(ellipses(right, '#203f50', 1.8).length, 1);
  assert.ok(ellipses(left, '#203f50', 1.8)[0].at[0] < -4);
  assert.ok(ellipses(right, '#203f50', 1.8)[0].at[0] > 4);
  assert.equal(ellipses(rear, '#203f50', 1.8).length, 0);
  assert.equal(filled(rear, '#fff7e4').length, 0);
  assert.notDeepEqual(feet(front), feet(rear));
});

test('walking alternates both feet and counter-swings the hands, then stops', () => {
  // The timeline supplies 2π per cell. A consecutive cell leads with the other foot.
  const a = avatar({ pose: pose({ moving: true, walkWeight: 1, walkPhase: Math.PI }) });
  const b = avatar({ pose: pose({ moving: true, walkWeight: 1, walkPhase: Math.PI * 3 }) });
  assert.notDeepEqual(feet(a), feet(b));
  assert.notDeepEqual(hands(a), hands(b));
  assert.ok((hands(a)[0].at[1] - hands(b)[0].at[1]) * (hands(a)[1].at[1] - hands(b)[1].at[1]) < 0);
  assert.deepEqual(avatar({ time: 10, pose: pose({ walkPhase: 1, walkWeight: 1 }) }), avatar({ time: 900, pose: pose({ walkPhase: 4, walkWeight: 1 }) }));
});

test('sideways walking swings the shoes along travel while the head stays grounded', () => {
  const step = distance => avatar({ pose: pose({ facing: 'right', moving: true, walkWeight: 1, walkPhase: distance * Math.PI * 2 }) });
  const a = step(.5), b = step(1.5);
  const soles = art => filled(art, '#367e97').filter(p => p.path[0]?.kind === 'move').slice(0, 2);
  const first = soles(a), second = soles(b);
  assert.equal(first.length, 2);
  const x = (steps, foot) => steps[foot].path[0].at[0];
  assert.ok(x(first, 0) - x(second, 0) > 4 && x(second, 1) - x(first, 1) > 4);
  assert.deepEqual(ellipses(a, '#203f50', 1.8), ellipses(step(0), '#203f50', 1.8));
});

test('trapped posture raises both hands and contracts the body even with reduced motion', () => {
  const normal = avatar({ reducedMotion: true, pose: pose() });
  const trapped = avatar({ reducedMotion: true, pose: pose({ bubble: true }) });
  assert.ok(hands(trapped).every((hand, i) => hand.at[1] < hands(normal)[i].at[1] - 4));
  assert.notDeepEqual(feet(trapped), feet(normal));
});

for (const state of ['hit', 'rescue', 'spawn', 'death']) {
  test(`${state} progress zero is active and changes body geometry before settling`, () => {
    const normal = avatar({ pose: pose() });
    const start = avatar({ pose: pose({ [state]: 0 }) });
    const later = avatar({ pose: pose({ [state]: .75 }) });
    assert.notDeepEqual(hands(start), hands(normal));
    assert.notDeepEqual(hands(start), hands(later));
  });
}

test('reduced motion freezes time, walk and transient deformation while keeping direction and trapping', () => {
  const options = { reducedMotion: true, pose: pose({ facing: 'left', bubble: true }) };
  const animated = { ...options, time: 321, pose: pose({ facing: 'left', bubble: true, moving: true, walkPhase: 2, walkWeight: 1, hit: 0, rescue: 0, spawn: 0 }) };
  assert.deepEqual(avatar(options), avatar(animated));
  assert.notDeepEqual(avatar(options), avatar({ reducedMotion: true, pose: pose() }));
});

test('previews and result cards remain static front views without pose for every character and costume', () => {
  const combinations = [];
  for (const character of CHARACTERS) for (const skin of SKINS) {
    const player = { ...base, characterId: character.id, skinId: skin.id, facing: 'up' };
    const still = avatar({ time: 0, reducedMotion: true }, player);
    assert.deepEqual(avatar({ time: 700 }, player), still);
    assert.equal(ellipses(still, '#203f50', 1.8).length, 2);
    combinations.push(JSON.stringify(still));
  }
  assert.equal(new Set(combinations).size, CHARACTERS.length * SKINS.length, 'each character and outfit combination retains distinct artwork');
});

test('the calico keeps its asymmetrical ears and curled tail in every direction, with whiskers only on the visible cheek', () => {
  for (const { id } of CHARACTERS) {
    for (const facing of ['down', 'left', 'right', 'up']) {
      const art = avatar({ pose: pose({ facing }) }, { characterId: id, skinId: 'cat' });
      const ears = art.filter(p => p.mode === 'fill' && p.path.length === 4 &&
        p.path[3].kind === 'close' && p.path.slice(0, 3).every(point => point.at[1] < -8) &&
        Math.min(...p.path.slice(0, 3).map(point => point.at[1])) < -25);
      assert.ok(ears.some(p => p.path[0].at[0] < 0 && p.color === '#ef9857'), id + ' orange ear ' + facing);
      assert.ok(ears.some(p => p.path[0].at[0] > 0 && p.color === '#48434b'), id + ' charcoal ear ' + facing);
      const tail = art.find(p => p.mode === 'stroke' && p.width >= 5 && p.path.filter(point => point.kind === 'curve').length >= 2);
      assert.ok(tail, id + ' curled calico tail ' + facing);
      const whiskers = art.filter(p => p.mode === 'stroke' && p.color === '#203f50' && p.path.length === 2 &&
        p.path[1].kind === 'line' && Math.abs(p.path[1].at[0]) > 13 && Math.abs(p.path[1].at[1]) < 7);
      const sides = [...new Set(whiskers.map(p => Math.sign(p.path[1].at[0])))].sort();
      assert.deepEqual(sides, { down: [-1, 1], left: [-1], right: [1], up: [] }[facing]);
    }
  }
});

test('tabby, tuxedo and calico retain distinct markings even with paint colors removed', () => {
  for (const { id } of CHARACTERS) {
    for (const facing of ['down', 'left', 'right', 'up']) {
      const drawings = ['tabby', 'tuxedo', 'cat'].map(skinId => {
        const art = avatar({ reducedMotion: true, pose: pose({ facing }) }, { characterId: id, skinId });
        return JSON.stringify(art.map(p => p.path));
      });
      assert.equal(new Set(drawings).size, 3, id + ' cat coat shapes ' + facing);
    }
  }
});

test('high contrast keeps face and costume identity with heavier outlines', () => {
  for (const skin of SKINS) {
    const player = { ...base, skinId: skin.id };
    const normal = avatar({ pose: pose({ facing: 'right' }) }, player);
    const contrast = avatar({ highContrast: true, pose: pose({ facing: 'right' }) }, player);
    assert.deepEqual(ellipses(contrast, '#203f50', 1.8), ellipses(normal, '#203f50', 1.8));
    assert.ok(contrast.some(p => p.mode === 'stroke' && p.width >= 2.7));
  }
});

test('each orb skin settles from placement elasticity to its unchanged baseline footprint', () => {
  for (const skin of ORB_SKINS) {
    const orb = { orbSkinId: skin.id, fuse: 20 };
    const placed = object(drawOrb, orb, { time: 0, ageMs: 0 });
    const baseline = object(drawOrb, orb, { time: 0, ageMs: 160 });
    assert.notDeepEqual(placed, baseline);
    assert.deepEqual(object(drawOrb, orb, { time: 0 }), baseline);
    assert.deepEqual(object(drawOrb, orb, { time: 0, ageMs: 400 }), baseline);
    assert.deepEqual(object(drawOrb, orb, { time: 500, ageMs: 0, reducedMotion: true }), object(drawOrb, orb, { time: 0, ageMs: 160, reducedMotion: true }));
  }
});

test('shorter orb fuse produces greater local movement while reduced motion retains a static warning', () => {
  const valve = art => filled(art, '#7ee1c6')[0].path[0].at;
  const long = valve(object(drawOrb, { fuse: 20 }, { time: 100 }));
  const short = valve(object(drawOrb, { fuse: 2 }, { time: 100 }));
  assert.ok(Math.abs(short[0] + 2) > Math.abs(long[0] + 2) + .2);
  const still = object(drawOrb, { fuse: 2 }, { time: 0, reducedMotion: true });
  assert.deepEqual(still, object(drawOrb, { fuse: 2 }, { time: 100, reducedMotion: true }));
  assert.ok(still.filter(p => p.mode === 'stroke' && p.path.some(n => n.kind === 'line' && Math.abs(n.at[0]) === 27)).length >= 2);
});

test('pickup wrappers and ability symbols float together, with a static ground shadow and reduced fallback', () => {
  for (const style of ITEM_STYLES) {
    const options = { style: style.id, time: 0 };
    const still = object(drawPickup, { type: 'dart' }, options);
    const floating = object(drawPickup, { type: 'dart' }, { ...options, time: 500 });
    assert.deepEqual(ellipses(floating, '#24475520'), ellipses(still, '#24475520'));
    const symbol = art => art.filter(p => p.mode === 'stroke' && p.width === 2.7);
    assert.notDeepEqual(symbol(floating), symbol(still));
    assert.deepEqual(object(drawPickup, { type: 'dart' }, { ...options, time: 500, reducedMotion: true }), still);
  }
});

// Gauge paths are selected by spatial meaning: a radius-24 track/arc or a
// two-point radial tick around it, independent of palette and draw ordering.
const fuseGauge = art => art.filter(p => p.mode === 'stroke' && (
  p.path.some(n => n.kind === 'ellipse' && n.rx === 24 && n.ry === 24) ||
  p.path.length === 2 && p.path.every(n => ['move', 'line'].includes(n.kind) && Math.hypot(...n.at) >= 21.9 && Math.hypot(...n.at) <= 26) &&
    Math.abs(p.path[0].at[0] * p.path[1].at[1] - p.path[0].at[1] * p.path[1].at[0]) < 1e-8
));
const gaugeCircles = gauge => gauge.flatMap(p => p.path).filter(n => n.kind === 'ellipse');
const gaugeTicks = gauge => gauge.filter(p => p.path.length === 2 && p.path[0].kind === 'move');
const remainingTicks = gauge => gaugeTicks(gauge).filter(p => Math.hypot(p.path[1].at[0] - p.path[0].at[0], p.path[1].at[1] - p.path[0].at[1]) > 2);

for (const skin of ORB_SKINS) {
  test(`${skin.id} fuse gauge shows full, half and urgent remaining arcs with noncolor tick counts in every motion/contrast mode`, () => {
    for (const reducedMotion of [false, true]) for (const highContrast of [false, true]) {
      const options = { reducedMotion, highContrast, time: 500, ageMs: 50 };
      const gauges = [20, 10, 2].map(fuse => fuseGauge(object(drawOrb, { orbSkinId: skin.id, fuse }, options)));
      for (const [index, count] of [20, 10, 2].entries()) {
        const gauge = gauges[index];
        assert.ok(gaugeCircles(gauge).some(n => n.start === 0 && n.end === Math.PI * 2), 'complete fixed track remains visible');
        const arc = gaugeCircles(gauge).find(n => n.start === -Math.PI / 2);
        assert.ok(arc, 'remaining fuse uses a distinct arc from twelve oclock');
        assert.ok(Math.abs((arc.end - arc.start) - [Math.PI * 2, Math.PI, Math.PI / 5][index]) < 1e-10);
        assert.deepEqual(arc.at, [0, 0]);
        assert.deepEqual(arc.xEdge, [24, 0]);
        assert.equal(remainingTicks(gauge).length, count);
        assert.equal(gaugeTicks(gauge).length, 20, 'spent ticks preserve the twenty-tick reference scale');
        assert.ok(gauge.every(p => p.path.every(n => n.kind === 'ellipse' ? n.rx + p.width / 2 <= 26 : Math.hypot(...n.at) + p.width / 2 <= 26)));
      }
      assert.notDeepEqual(gauges[0], gauges[1]);
      assert.notDeepEqual(gauges[1], gauges[2]);
    }
  });
}

test('fuse gauge stays anchored and unchanged across local time and placement animation for the same authoritative value', () => {
  for (const skin of ORB_SKINS) for (const highContrast of [false, true]) {
    const orb = { orbSkinId: skin.id, fuse: 2 };
    const baseline = fuseGauge(object(drawOrb, orb, { time: 0, ageMs: 160, highContrast }));
    assert.ok(baseline.length > 20);
    for (const [time, ageMs] of [[100, 0], [777, 70], [80000, 2000]]) {
      assert.deepEqual(fuseGauge(object(drawOrb, orb, { time, ageMs, highContrast })), baseline);
      assert.deepEqual(fuseGauge(object(drawOrb, orb, { time, ageMs, highContrast, reducedMotion: true })), baseline);
    }
  }
});

test('fuse gauge clamps snapshot values to zero through twenty ticks without inventing a countdown', () => {
  const gauge = fuse => fuseGauge(object(drawOrb, { fuse }, { reducedMotion: true }));
  assert.deepEqual(gauge(21), gauge(20));
  assert.deepEqual(gauge(-3), gauge(0));
  assert.equal(remainingTicks(gauge(0)).length, 0);
  assert.equal(gaugeCircles(gauge(0)).filter(n => n.start === -Math.PI / 2 && n.end > n.start).length, 0);
  assert.equal(remainingTicks(gauge(1)).length, 1);
});

test('unknown and nonfinite fuse leave static preview artwork without a timing gauge', () => {
  for (const skin of ORB_SKINS) {
    const preview = object(drawOrb, { orbSkinId: skin.id }, { reducedMotion: true });
    assert.equal(fuseGauge(preview).length, 0);
    for (const fuse of [undefined, null, NaN, Infinity, -Infinity, '10']) {
      const art = object(drawOrb, { orbSkinId: skin.id, fuse }, { reducedMotion: true, time: 9000 });
      assert.deepEqual(art, preview);
      assert.equal(fuseGauge(art).length, 0);
    }
  }
});
