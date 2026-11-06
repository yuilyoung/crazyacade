import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as displayModule from '../public/display.js';

function classes() {
  const values = new Set();
  return { toggle(name, on) { if (on) values.add(name); else values.delete(name); }, contains: name => values.has(name) };
}
function environment() {
  const listeners = new Map(), canvas = { width: 300, height: 150, style: {}, clientWidth: 390 }, battle = { classList: classes() };
  const document = { body: { classList: classes() }, fullscreenElement: null };
  const window = { devicePixelRatio: 3, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); } };
  return { canvas, battle, document, window, listeners };
}

test('quality changes backing pixels while all rendering stays in logical 780 by 660 coordinates', () => {
  const env = environment(), display = displayModule.createDisplay(env);
  assert.equal(displayModule.LOGICAL_WIDTH, 780); assert.equal(displayModule.LOGICAL_HEIGHT, 660);
  const high = display.resize({ quality: 'high' });
  assert.equal(high.width, 780); assert.equal(high.height, 660);
  assert.equal(env.canvas.width, 1560); assert.equal(env.canvas.height, 1320);
  const transforms = [];
  display.renderTransform({ setTransform: (...args) => transforms.push(args) });
  assert.deepEqual(transforms.at(-1), [2, 0, 0, 2, 0, 0]);
  display.resize({ quality: 'low' });
  assert.equal(env.canvas.width, 780); assert.equal(env.canvas.height, 660);
  display.renderTransform({ setTransform: (...args) => transforms.push(args) });
  assert.deepEqual(transforms.at(-1), [1, 0, 0, 1, 0, 0]);
  assert.equal(display.resize({ quality: 'auto', devicePixelRatio: 1 }).pixelRatio, 1);
  assert.equal(display.resize({ devicePixelRatio: 20 }).pixelRatio, 2);
  assert.equal(display.resize({ devicePixelRatio: NaN }).pixelRatio, 1);
});

test('orientation and CSS size changes keep logical aspect ratio, quality and transform stable', () => {
  const env = environment(), changes = [], display = displayModule.createDisplay({ ...env, onChange: value => changes.push(value) });
  display.resize({ quality: 'low' });
  env.canvas.clientWidth = 844;
  env.listeners.get('resize')();
  assert.equal(env.canvas.width, 780); assert.equal(env.canvas.height, 660);
  assert.equal(env.canvas.style.aspectRatio, '780 / 660');
  assert.equal(changes.at(-1).quality, 'low');
  assert.equal(changes.at(-1).width, 780);
  display.destroy(); assert.equal(env.listeners.size, 0);
});

test('unsupported or denied fullscreen resolves safely into focus mode', async () => {
  for (const requestFullscreen of [undefined, () => Promise.reject(Error('denied')), () => { throw Error('denied'); }]) {
    const env = environment(); env.battle.requestFullscreen = requestFullscreen;
    const changes = [], display = displayModule.createDisplay({ ...env, onChange: value => changes.push(value) });
    assert.equal(await display.fullscreen(), false);
    assert.equal(env.battle.classList.contains('focus-mode'), true);
    assert.equal(env.document.body.classList.contains('arena-focus'), true);
    assert.equal(changes.at(-1).focused, true);
    display.focus(false);
    assert.equal(env.battle.classList.contains('focus-mode'), false);
  }
});

test('fullscreen enters and exits using the injected DOM and focus follows the request', async () => {
  const env = environment();
  env.battle.requestFullscreen = async () => { env.document.fullscreenElement = env.battle; };
  env.document.exitFullscreen = async () => { env.document.fullscreenElement = null; };
  const display = displayModule.createDisplay(env);
  assert.equal(await display.fullscreen(), true);
  assert.equal(env.document.fullscreenElement, env.battle);
  assert.equal(env.battle.classList.contains('focus-mode'), true);
  assert.equal(await display.fullscreen(), true);
  assert.equal(env.document.fullscreenElement, null);
  assert.equal(env.battle.classList.contains('focus-mode'), false);
});
