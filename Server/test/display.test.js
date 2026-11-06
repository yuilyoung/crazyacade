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

for (const quality of ['low','high']) test(`arena changes retain 60px tiles and ${quality} quality across resizes`, () => {
  const env=environment(), properties={}; env.battle.style={setProperty:(key,value)=>properties[key]=value};
  const display=displayModule.createDisplay(env), ratio=quality==='high'?2:1;
  display.resize({quality,arena:{width:15,height:13}});
  assert.equal(display.renderTransform().width,900); assert.equal(display.renderTransform().height,780);
  assert.equal(env.canvas.width,900*ratio); assert.equal(env.canvas.height,780*ratio);
  assert.equal(properties['--arena-ratio'],'15 / 13'); assert.equal(properties['--arena-width'],'15'); assert.equal(properties['--arena-height'],'13');
  env.listeners.get('resize')(); display.focus(true);
  assert.equal(env.canvas.width,900*ratio); assert.equal(env.canvas.height,780*ratio);
  display.resize({arena:{width:13,height:11}}); assert.equal(env.canvas.width,780*ratio); assert.equal(env.canvas.height,660*ratio);
  display.resize({arena:{width:15,height:13}}); display.resize({quality}); assert.equal(env.canvas.width,900*ratio);
  display.resize({arena:{width:15,height:11}}); assert.equal(env.canvas.width,780*ratio);
});

test('viewport resize keeps a partially clipped live party goal above fitting board and controls',()=>{
  const env=environment(), frames=new Map(), scrolls=[];let sequence=0;
  env.canvas.dataset={phase:'playing'};
  env.canvas.getBoundingClientRect=()=>({top:58,bottom:299,width:278,height:241});
  const goal={getBoundingClientRect:()=>({top:-3.90625,bottom:23.140625,width:530,height:27.046875})};
  env.battle.querySelector=()=>goal;
  env.battle.querySelectorAll=()=>[{getBoundingClientRect:()=>({top:118,bottom:270,width:44,height:44})}];
  Object.assign(env.window,{innerHeight:390,requestAnimationFrame:fn=>{frames.set(++sequence,fn);return sequence;},cancelAnimationFrame:id=>frames.delete(id),scrollBy:value=>scrolls.push(value)});
  const display=displayModule.createDisplay(env);
  env.listeners.get('resize')();assert.equal(scrolls.length,0,'wait for orientation layout and browser anchoring');
  for(let i=0;i<2;i++){const [id,fn]=frames.entries().next().value || [];frames.delete(id);fn?.();}
  assert.deepEqual(scrolls,[{top:-4,left:0,behavior:'instant'}]);
  display.destroy();
});

test('viewport resize preserves deliberate lower-panel scrolling and never pushes touch controls out',()=>{
  for(const [goalTop,goalBottom,controlsBottom,phase,blocked] of [[-60,-30,270,'playing'],[-4,23,389,'playing'],[-4,23,270,'finished'],[-4,23,270,'playing','fullscreen'],[-4,23,270,'playing','dialog']]) {
    const env=environment(), frames=[];let scrolls=0;
    if(blocked==='fullscreen')env.document.fullscreenElement={};
    if(blocked==='dialog')env.document.querySelector=()=>({});
    env.canvas.dataset={phase};env.canvas.getBoundingClientRect=()=>({top:58,bottom:299,width:278,height:241});
    env.battle.querySelector=()=>({getBoundingClientRect:()=>({top:goalTop,bottom:goalBottom,width:530,height:27})});
    env.battle.querySelectorAll=()=>[{getBoundingClientRect:()=>({top:118,bottom:controlsBottom,width:44,height:44})}];
    Object.assign(env.window,{innerHeight:390,requestAnimationFrame:fn=>{frames.push(fn);return frames.length;},scrollBy:()=>scrolls++});
    const display=displayModule.createDisplay(env);env.listeners.get('resize')();
    for(let i=0;i<2;i++)frames.shift()?.();
    assert.equal(scrolls,0);display.destroy();
  }
});
