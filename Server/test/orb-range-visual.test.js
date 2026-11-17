import test from 'node:test';
import assert from 'node:assert/strict';
import { drawOrb } from '../public/visuals.js';
import { ORB_SKINS } from '../public/cosmetics.js';
import { setup, send, waitFor } from './fixtures/relay-server.mjs';

// Capture painted Canvas geometry after transforms, including text legibility.
function artwork(orb, options = {}) {
  let matrix = [1, 0, 0, 1, 0, 0], path = [];
  const stack = [], paints = [];
  const point = (x, y) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
  const multiply = ([a, b, c, d, e, f]) => {
    const [aa, bb, cc, dd, ee, ff] = matrix;
    matrix = [aa*a+cc*b, bb*a+dd*b, aa*c+cc*d, bb*c+dd*d, aa*e+cc*f+ee, bb*e+dd*f+ff];
  };
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    save() { stack.push({ matrix: [...matrix], fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline }); },
    restore() { const saved = stack.pop(); matrix = saved.matrix; Object.assign(this, saved); },
    translate(x, y) { multiply([1, 0, 0, 1, x, y]); },
    scale(x, y) { multiply([x, 0, 0, y, 0, 0]); },
    rotate(a) { multiply([Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]); },
    beginPath() { path = []; },
    moveTo(x, y) { path.push({ kind: 'move', at: point(x, y), local: [x, y] }); },
    lineTo(x, y) { path.push({ kind: 'line', at: point(x, y), local: [x, y] }); },
    quadraticCurveTo(cx, cy, x, y) { path.push({ kind: 'curve', control: point(cx, cy), at: point(x, y) }); },
    closePath() {},
    ellipse(x, y, rx, ry, rotation, start, end) {
      path.push({ kind: 'ellipse', at: point(x, y), xEdge: point(x + rx * Math.cos(rotation), y + rx * Math.sin(rotation)), yEdge: point(x - ry * Math.sin(rotation), y + ry * Math.cos(rotation)), rx, ry, start, end });
    },
    fill() {
      const color = typeof this.fillStyle === 'object' ? { gradient: this.fillStyle.gradient, stops: this.fillStyle.stops } : this.fillStyle;
      paints.push({ mode: 'fill', color, path: structuredClone(path), matrix: [...matrix] });
    },
    stroke() { paints.push({ mode: 'stroke', color: this.strokeStyle, width: this.lineWidth, path: structuredClone(path), matrix: [...matrix] }); },
    createRadialGradient(...coords) { return { gradient: coords, stops: [], addColorStop(at, color) { this.stops.push([at, color]); } }; },
    fillText(text, x, y) { paints.push({ mode: 'text', text, at: point(x, y), color: this.fillStyle, font: this.font, align: this.textAlign, baseline: this.textBaseline, matrix: [...matrix] }); },
  };
  drawOrb(ctx, orb, options);
  return paints;
}

const badge = art => art.filter(paint => paint.mode === 'text');
function bodyWidth(art, skin) {
  const body = art.find(paint => paint.mode === 'fill' && (skin === 'bubble' ? paint.color?.gradient : paint.color === (skin === 'star' ? '#b4e9f0' : '#ffe3a0')));
  if (skin === 'star') {
    const xs = body.path.map(node => node.at[0]);
    return Math.max(...xs) - Math.min(...xs);
  }
  return Math.hypot(body.path[0].xEdge[0] - body.path[0].at[0], body.path[0].xEdge[1] - body.path[0].at[1]) * 2;
}
const gauge = art => art.filter(paint => paint.mode === 'stroke' && (
  paint.path.some(node => node.kind === 'ellipse' && node.rx === 24 && node.ry === 24) ||
  paint.path.length === 2 && paint.path.every(node => Math.hypot(...node.at) >= 21.9 && Math.hypot(...node.at) <= 26) &&
    Math.abs(paint.path[0].at[0] * paint.path[1].at[1] - paint.path[0].at[1] * paint.path[1].at[0]) < 1e-8
));

test('ordinary snapshots carry each planted orb range before and after a real wave pickup', async t => {
  // Only the test process fixes randomness; crate destruction and pickups use
  // the ordinary server paths, with no special production map or player data.
  const { join } = await setup(t, {}, { tickMs: 20, preload: 'Math.random = () => 0.25;' });
  const client = await join({ mode: 'duel', roomId: 'orb-range', mapId: 'garden', itemMode: true });
  await join({ mode: 'duel', roomId: 'orb-range' });
  await waitFor(() => client.state.phase === 'playing');
  const human = () => client.state.players.find(player => player.id === client.playerId);
  async function move(action, x, y) {
    send(client, 'input', { action });
    await waitFor(() => human().x === x && human().y === y);
  }
  await move('right', 2, 1);
  send(client, 'input', { action: 'place_orb' });
  await waitFor(() => client.state.orbs.length === 1);
  assert.equal(client.state.orbs[0].range, 3, 'the wire must preserve the range captured when planting');
  await move('left', 1, 1);
  await move('up', 1, 2);
  await waitFor(() => client.state.orbs.length === 0 && client.state.waves.length === 0);
  assert.ok(client.state.items.some(item => item.x === 5 && item.y === 1 && item.type === 'wave'));
  await move('down', 1, 1);
  for (const x of [2, 3, 4, 5]) await move('right', x, 1);
  assert.equal(human().range, 4);
  assert.equal(human().itemsCollected, 1);
  send(client, 'input', { action: 'place_orb' });
  await waitFor(() => client.state.orbs.length === 1);
  const planted = client.state.orbs[0];
  assert.equal(planted.range, 4, 'newly planted art must receive the upgraded authoritative range');
  assert.deepEqual(badge(artwork(planted, { reducedMotion: true })).map(paint => paint.text), ['4']);
});

for (const skin of ORB_SKINS) {
  test(`${skin.id} body grows modestly with range while its badge gives the exact count`, () => {
    for (const highContrast of [false, true]) {
      const options = { reducedMotion: true, highContrast };
      const widths = [3, 4, 5, 6, 7].map(range => {
        const art = artwork({ orbSkinId: skin.id, fuse: 20, range }, options);
        const labels = badge(art);
        assert.equal(labels.length, 1);
        assert.equal(labels[0].text, String(range));
        assert.ok(Number.parseFloat(labels[0].font.match(/(\d+(?:\.\d+)?)px/)?.[1]) >= 11, 'count remains readable at a 60px cell');
        assert.equal(labels[0].align, 'center');
        assert.equal(labels[0].baseline, 'middle');
        return bodyWidth(art, skin.id);
      });
      for (let index = 1; index < widths.length; index++) assert.ok(widths[index] > widths[index - 1]);
      assert.ok(widths[4] / widths[0] > 1.05 && widths[4] / widths[0] < 1.15, 'size suggests power without pretending to show the blast footprint');
    }
  });

  test(`${skin.id} range cue remains static in reduced motion and keeps the fuse gauge independent`, () => {
    for (const highContrast of [false, true]) {
      const orb = { orbSkinId: skin.id, range: 7, fuse: 2 };
      const baseline = artwork(orb, { reducedMotion: true, highContrast });
      assert.equal(badge(baseline)[0]?.text, '7');
      assert.deepEqual(artwork(orb, { reducedMotion: true, highContrast, time: 9999, ageMs: 0 }), baseline);
      for (const [time, ageMs] of [[0, 0], [100, 70], [9999, 1000]]) {
        const animated = artwork(orb, { highContrast, time, ageMs });
        assert.deepEqual(badge(animated), badge(baseline), 'range count is anchored outside animation');
        assert.deepEqual(gauge(animated), gauge(artwork({ ...orb, range: 3 }, { highContrast, time, ageMs })));
      }
    }
  });
}

test('missing or invalid range keeps legacy preview size without inventing a count', () => {
  for (const skin of ORB_SKINS) {
    const preview = artwork({ orbSkinId: skin.id }, { reducedMotion: true });
    assert.equal(badge(preview).length, 0);
    assert.equal(bodyWidth(preview, skin.id), bodyWidth(artwork({ orbSkinId: skin.id, range: 3 }, { reducedMotion: true }), skin.id));
    for (const range of [undefined, null, NaN, Infinity, -Infinity, '7', 0, -1, 3.5]) {
      assert.deepEqual(artwork({ orbSkinId: skin.id, range }, { reducedMotion: true, time: 9000 }), preview);
    }
  }
});

test('maximum range body and badge stay inside their 60px cell throughout placement and urgent fuse animation', () => {
  for (const skin of ORB_SKINS) for (const highContrast of [false, true]) {
    for (const time of [0, 70, 130, 250, 400, 777]) for (const ageMs of [0, 40, 72, 80, 120, 160]) {
      const art = artwork({ orbSkinId: skin.id, range: 7, fuse: 2 }, { time, ageMs, highContrast });
      for (const paint of art.filter(p => p.mode !== 'text')) {
        // Legacy warning rays sit outside the body and are not range-scaled.
        if (paint.path.length === 2 && paint.path.every(node => node.local && Math.abs(node.local[0]) >= 24)) continue;
        const [a, b, c, d] = paint.matrix;
        // Largest singular value scales the stroke's radius even when local
        // placement squash and rotation combine into an affine transform.
        const sum = a*a+b*b+c*c+d*d, determinant = a*d-b*c;
        const stroke = paint.mode === 'stroke' ? paint.width / 2 * Math.sqrt((sum + Math.sqrt(Math.max(0, sum*sum - 4*determinant*determinant))) / 2) : 0;
        for (const node of paint.path) {
          const extent = node.kind === 'ellipse'
            ? [Math.hypot(node.xEdge[0]-node.at[0], node.yEdge[0]-node.at[0]), Math.hypot(node.xEdge[1]-node.at[1], node.yEdge[1]-node.at[1])]
            : [0, 0];
          assert.ok(Math.abs(node.at[0]) + extent[0] + stroke < 30 && Math.abs(node.at[1]) + extent[1] + stroke < 30, `${skin.id} paint stays in its authoritative cell: ${JSON.stringify({ time, ageMs, paint, node, stroke })}`);
          if (node.control) assert.ok(node.control.every(value => Math.abs(value) + stroke < 30));
        }
      }
    }
  }
});
