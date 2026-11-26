import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fireDart } from '../src/combat.js';

// Regression: a successful final-tick action used to disappear from the checklist.
// Presentation runs with unavailable audio/storage; combat snapshots stay authoritative.
test('tutorial counts accepted final-tick actions and a fresh basic match resets progress', async t => {
  const originals = new Map(['window', 'document', 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const attributes = new Map();
      elements.set(id, { dataset: {}, textContent: '', hidden: false,
        setAttribute(key, value) { attributes.set(key, value); }, getAttribute(key) { return attributes.get(key); }, addEventListener() {} });
    }
    return elements.get(id);
  }
  globalThis.document = { body: { dataset: {} }, hidden: false, addEventListener() {}, querySelector: element };
  globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: true, addEventListener() {} }) };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage blocked'); } });
  const { createExperience } = await import('../public/experience.js');
  const experience = createExperience(element);
  assert.equal(experience.reducedMotion, true);
  assert.equal(element('sound-toggle').disabled, true);
  assert.equal(element('music-toggle').disabled, true);
  experience.reset(true);
  const me = { id: 'human', x: 1, y: 1, bombsPlaced: 0, itemsCollected: 0, rescues: 0 };
  experience.update({ phase: 'playing', itemMode: true, players: [me], waves: [] }, me);
  for (const step of ['move', 'bomb', 'item']) assert.equal(element(`[data-step="${step}"]`).dataset.complete, 'false');
  const final = { ...me, x: 2, bombsPlaced: 1, itemsCollected: 1 };
  experience.update({ phase: 'finished', itemMode: true, players: [final], waves: [], result: { draw: true } }, final);
  for (const step of ['move', 'bomb', 'item']) assert.equal(element(`[data-step="${step}"]`).dataset.complete, 'true', `${step} accepted on the final tick`);
  experience.reset(false);
  assert.equal(element('[data-step="item"]').dataset.optional, 'true');
  for (const step of ['move', 'bomb', 'item']) assert.equal(element(`[data-step="${step}"]`).dataset.complete, 'false', 'fresh match must reset progress');
});

test('actual experience baselines audio on reconnect, map change, stale gaps and hidden recovery',async t=>{
  const originals=new Map(['window','document','localStorage'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  t.after(()=>{for(const [k,d] of originals) {if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}});
  const elements=new Map();
  const $=id=>{if(!elements.has(id))elements.set(id,{dataset:{},textContent:'',setAttribute(){},getAttribute(){},addEventListener(){}});return elements.get(id);};
  globalThis.document={body:{dataset:{}},hidden:false,addEventListener(){},querySelector:$};
  globalThis.window={matchMedia:()=>({matches:false,addEventListener(){}}),addEventListener(){}};
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem(){return null;}}});
  const sounds=[];let now=0;
  const audio={state:{available:true},setHidden(){},setScene(){},setMap(){},setProfile(){},playEffect:k=>sounds.push(k)};
  const {createExperience}=await import('../public/experience.js');
  const experience=createExperience($,{audioFactory:()=>audio,now:()=>now});
  const me={id:'p',x:1,y:1,alive:true,bubbleTicks:0,wallHits:0};
  let tick=1;
  const update=(change={},mapId='garden',phase='playing')=>{Object.assign(me,change);experience.update({roomId:'r',matchId:'m',round:1,tick:tick++,phase,mapId,players:[me],waves:[]},me);};
  update();now=100;update({wallHits:1});assert.deepEqual(sounds,['wall']);sounds.length=0;
  experience.baseline();now=200;update({wallHits:4,bubbleTicks:20,itemsCollected:3});assert.deepEqual(sounds,[]);
  now=300;update({wallHits:8,itemsCollected:6},'lagoon');assert.deepEqual(sounds,[]);
  now=1200;update({wallHits:10,bubbleTicks:0,itemsCollected:8},'lagoon');assert.deepEqual(sounds,[]);
  document.hidden=true;now=1300;update({wallHits:11},'lagoon');
  document.hidden=false;now=1400;update({wallHits:12},'lagoon');assert.deepEqual(sounds,[]);
  now=1500;update({wallHits:13},'lagoon');assert.deepEqual(sounds,['wall']);
  sounds.length=0;
  now=1600;update({darts:2,itemsCollected:9},'lagoon');assert.deepEqual(sounds,['item']);sounds.length=0;
  now=1700;update({darts:2},'lagoon');assert.deepEqual(sounds,[]);
  now=1800;update({darts:1,dartsUsed:1},'lagoon');assert.deepEqual(sounds,['dart']);sounds.length=0;
  now=1900;update({},'lagoon');assert.deepEqual(sounds,[]);
  experience.baseline();now=2000;update({dartsUsed:2},'lagoon');assert.deepEqual(sounds,[]);
  now=2100;update({dartsUsed:3,itemsCollected:10},'lagoon');assert.deepEqual(sounds,['item','dart']);sounds.length=0;
  now=2200;update({dartsUsed:4},'lagoon','finished');assert.deepEqual(sounds,['dart','result']);
});

test('only accepted dart use advances the player counter', () => {
  const player = { x: 1, y: 1, alive: true, bubbleTicks: 0, darts: 1, dartsUsed: 0, facing: 'up' };
  const room = { itemMode: false, solid: new Set(['1,2']), soft: new Set(), orbs: new Map(), players: new Map() };
  assert.equal(fireDart(room, player, () => assert.fail('unexpected explosion')), false);
  assert.equal(player.dartsUsed, 0);
  room.itemMode = true;
  assert.equal(fireDart(room, player, () => assert.fail('unexpected explosion')), true);
  assert.equal(player.dartsUsed, 1);
  assert.equal(fireDart(room, player, () => assert.fail('unexpected explosion')), false);
  assert.equal(player.dartsUsed, 1);
});
