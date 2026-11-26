import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as module from '../public/local-movement.js';
const me=(extra={})=>({id:'p',x:1,y:1,alive:true,bubbleTicks:0,moveCooldownTicks:2,connected:true,...extra});
const view=(extra={})=>{const player=me(extra);return {canInput:true,connection:'connected',playerId:'p',me:player,snapshot:{roomId:'r',matchId:'m',round:1,mapId:'garden',mode:'team',tick:1,phase:'playing',players:[player],solid:[],soft:[],orbs:[]}};};
const pose=v=>({...v.me,player:v.me,facing:'down',moving:false,walkWeight:0,walkPhase:0});
function fixture(){const controller=module.createLocalMovement();const v=view();controller.update(v,pose(v),0);return {controller,v};}

test('input starts visible movement before a server tick without mutating game state',()=>{
 const {controller:c,v}=fixture(),original=structuredClone(v.snapshot);
 assert.equal(c.press('right',v,0),true);
 const p=c.update(v,pose(v),16);assert.ok(p.x>1 && p.x<2);assert.equal(p.y,1);
 assert.deepEqual(v.snapshot,original);
});
test('confirmation retains position and does not play the movement a second time',()=>{
 const {controller:c,v}=fixture();c.press('right',v,0);
 const before=c.update(v,pose(v),99);const confirmed=view({x:2});confirmed.snapshot.tick=2;
 const at=c.update(confirmed,pose(confirmed),100);assert.ok(Math.abs(at.x-before.x)<.02);
 assert.equal(c.update(confirmed,pose(confirmed),200).x,2);
 assert.equal(c.update(confirmed,{...pose(confirmed),x:1.6},216).x,2);
});
test('held movement preserves a confirmed turn corner and one unconfirmed-cell bound',()=>{
 const {controller:c,v}=fixture();c.press('right',v,0);
 const confirmed=view({x:2});confirmed.snapshot.tick=2;
 c.update(confirmed,pose(confirmed),100,{direction:'up'});
 const corner=c.update(confirmed,pose(confirmed),200,{direction:'up'});assert.equal(corner.x,2);assert.equal(corner.y,1);
 const after=c.update(confirmed,pose(confirmed),216,{direction:'up'});assert.equal(after.x,2);assert.ok(after.y>1);
 const held=c.update(confirmed,pose(confirmed),399,{direction:'up'});assert.equal(held.x,2);assert.ok(held.y<=2);
});
test('walls crates bombs and borders are never predicted into',()=>{
 for(const kind of ['solid','soft','orbs','border']) {
  const {controller:c,v}=fixture();if(kind==='orbs')v.snapshot.orbs=[{x:2,y:1}];else if(kind!=='border')v.snapshot[kind]=['2,1'];
  assert.equal(c.press(kind==='border'?'left':'right',v,0),false,kind);
  assert.equal(c.update(v,pose(v),30).x,1);
 }
});
test('stale response rolls back and does not keep walking ahead',()=>{
 const {controller:c,v}=fixture();c.press('right',v,0);c.update(v,pose(v),200,{direction:'right'});
 c.update(v,pose(v),301,{direction:'right'});
 const p=c.update(v,pose(v),420,{direction:'right'});assert.equal(p.x,1);assert.equal(p.y,1);
});
test('newly blocked target rolls back and capture death modal or connection resets safely',()=>{
 const {controller:c,v}=fixture();c.press('right',v,0);c.update(v,pose(v),50);
 const blocked=view();blocked.snapshot.tick=2;blocked.snapshot.solid=['2,1'];c.update(blocked,pose(blocked),60);
 assert.equal(c.update(blocked,pose(blocked),160).x,1);
 for(const change of [{bubbleTicks:20},{alive:false}]) {
  const f=fixture();f.controller.press('right',f.v,0);const next=view(change);
  assert.equal(f.controller.update(next,pose(next),50).x,1);
 }
 for(const mode of ['modal','disconnect','reduced','hidden']) {
  const f=fixture();f.controller.press('right',f.v,0);const next={...f.v,canInput:mode!=='modal',connection:mode==='disconnect'?'reconnecting':'connected'};
  assert.equal(f.controller.update(next,pose(next),50,{enabled:mode!=='reduced',hidden:mode==='hidden'}).x,1);
 }
});
test('a map or match boundary discards local history',()=>{
 const {controller:c,v}=fixture();c.press('right',v,0);c.update(v,pose(v),50);
 const next=view();next.snapshot.mapId='lagoon';assert.equal(c.update(next,pose(next),80).x,1);
});

test('a confirmed orthogonal turn finishes its corner within 50ms then responds before 100ms',()=>{
 const {controller:c,v}=fixture();c.press('right',v,0);
 const confirmed=view({x:2});confirmed.snapshot.tick=2;c.update(confirmed,pose(confirmed),55,{direction:'right'});
 const before=c.update(confirmed,pose(confirmed),60,{direction:'right'});
 c.press('up',confirmed,60);
 const noJump=c.update(confirmed,pose(confirmed),60,{direction:'up'});assert.equal(noJump.x,before.x);assert.equal(noJump.y,1);
 c.update(confirmed,pose(confirmed),110,{direction:'up'});
 const turned=c.update(confirmed,pose(confirmed),126,{direction:'up'});assert.equal(turned.x,2);assert.ok(turned.y>1);
});
test('same-corridor reverse input responds immediately instead of completing the old stride',()=>{
 const {controller:c,v}=fixture();c.press('right',v,0);
 const confirmed=view({x:2});confirmed.snapshot.tick=2;c.update(confirmed,pose(confirmed),55,{direction:'right'});
 const before=c.update(confirmed,pose(confirmed),60,{direction:'right'});
 c.press('left',confirmed,60);
 const reversed=c.update(confirmed,pose(confirmed),76,{direction:'left'});assert.ok(reversed.x<before.x);assert.equal(reversed.y,1);
});

test('authority advancing during a correction cannot leave a stale settled display',()=>{
 const {controller:c,v}=fixture();c.press('right',v,0);c.update(v,pose(v),50);
 const turn=view({x:1,y:2});turn.snapshot.tick=2;c.update(turn,pose(turn),60);
 const advanced=view({x:1,y:3});advanced.snapshot.tick=3;c.update(advanced,pose(advanced),100);
 c.update(advanced,pose(advanced),150);
 const final=c.update(advanced,pose(advanced),280);assert.equal(final.x,1);assert.equal(final.y,3);
});

test('an unconfirmed reversal or orthogonal replacement responds without waiting for acknowledgement',()=>{
 for(const action of ['left','up']) {
  const c=module.createLocalMovement(),v=view({x:3,y:3});c.update(v,pose(v),0);c.press('right',v,0);c.update(v,pose(v),50);
  assert.equal(c.press(action,v,50),true);
  c.update(v,pose(v),90,{direction:action});const next=c.update(v,pose(v),106,{direction:action});
  if(action==='left')assert.ok(next.x<3.25);else {assert.equal(next.x,3);assert.ok(next.y>3);}
 }
});
test('a snapshot received before keydown does not make the turn wait a full old interpolation',()=>{
 const {controller:c,v}=fixture();const confirmed=view({x:2});confirmed.snapshot.tick=2;
 c.update(confirmed,{...pose(confirmed),x:1},100);
 assert.equal(c.press('up',confirmed,100),true);
 c.update(confirmed,{...pose(confirmed),x:1.25},150,{direction:'up'});
 const turn=c.update(confirmed,{...pose(confirmed),x:1.33},166,{direction:'up'});
 assert.equal(turn.x,2);assert.ok(turn.y>1);
});

test('an authoritative change of axis cannot turn a reverse request into a diagonal',()=>{
 const {controller:c,v}=fixture();c.press('right',v,0);
 const right=view({x:2});right.snapshot.tick=2;c.update(right,pose(right),100);c.update(right,pose(right),200);
 const up=view({x:2,y:2});up.snapshot.tick=3;c.update(up,pose(up),250);
 const before=c.update(up,pose(up),270);c.press('left',up,270);
 const after=c.update(up,pose(up),286);
 assert.ok(after.x===before.x || after.y===before.y,'one cardinal segment at a time');
});
test('returning to the authoritative origin before animation completes converges correctly',()=>{
 const {controller:c,v}=fixture();c.press('right',v,0);
 const accepted=view({x:2});accepted.snapshot.tick=2;c.update(accepted,pose(accepted),30);
 const returned=view();returned.snapshot.tick=3;c.update(returned,pose(returned),100);
 c.update(returned,pose(returned),200);
 assert.equal(c.update(returned,pose(returned),400).x,1);
});

test('early confirmation of a multi-segment replacement never cuts the remaining corner',()=>{
 for(const action of ['right','down']) {
  const c=module.createLocalMovement(),v=view({x:5,y:5});c.update(v,pose(v),0);c.press('right',v,0);
  c.update(v,pose(v),50);c.press('up',v,50);
  const confirmed=view({x:5,y:6});confirmed.snapshot.tick=2;c.update(confirmed,pose(confirmed),60);
  c.update(confirmed,pose(confirmed),65);c.press(action,confirmed,65);
  for(let now=66;now<120;now++) {
   const p=c.update(confirmed,pose(confirmed),now,{direction:action});
   assert.ok(Math.abs(p.x-Math.round(p.x))<1e-8 || Math.abs(p.y-Math.round(p.y))<1e-8,`${action} at ${now}`);
  }
 }
});

test('the latest straight input replaces a queued turn before the corner',()=>{
 const {controller:c,v}=fixture();c.press('right',v,0);
 const confirmed=view({x:2});confirmed.snapshot.tick=2;
 c.update(confirmed,pose(confirmed),55,{direction:'right'});
 c.press('up',confirmed,60);
 c.update(confirmed,pose(confirmed),75,{direction:'up'});
 c.press('right',confirmed,80);
 const corner=c.update(confirmed,pose(confirmed),110,{direction:'right'});
 assert.equal(corner.x,2);assert.equal(corner.y,1);
 const next=c.update(confirmed,pose(confirmed),126,{direction:'right'});
 assert.ok(next.x>2,'continues right instead of following the superseded turn');
 assert.equal(next.y,1);
});

test('a late acknowledgement of the superseded direction preserves the held turn',()=>{
 const c=module.createLocalMovement(),v=view({x:5,y:5});c.update(v,pose(v),0);
 c.press('right',v,0);c.update(v,pose(v),35);c.press('up',v,35);
 const right=view({x:6,y:5});
 c.update(right,pose(right),48,{direction:'up'});
 let p;for(let t=64;t<=128;t+=16)p=c.update(right,pose(right),t,{direction:'up'});
 assert.equal(p.x,6);assert.ok(p.y>5,'turn begins within 100 ms even with the old direction acknowledged');
});

test('a continuous stride carries unused frame time and walking cadence through a cell',()=>{
 const {controller:c,v}=fixture();c.press('right',v,0);
 const confirmed=view({x:2});c.update(confirmed,pose(confirmed),90,{direction:'right'});
 c.update(confirmed,pose(confirmed),185,{direction:'right'});
 const next=c.update(confirmed,pose(confirmed),217,{direction:'right'});
 assert.ok(Math.abs(next.x-2.085)<1e-6);assert.equal(next.walkWeight,1);
});

test('release preserves a discrete tap and retracts only an unconfirmed repeat',()=>{
 const {controller:c,v}=fixture();c.press('right',v,0);c.press('right',v,8,'release');
 assert.ok(c.update(v,pose(v),32).x>1);
 const right=view({x:2});c.update(right,pose(right),90);c.update(right,pose(right),200);
 c.press('right',right,201,'repeat');
 assert.ok(c.update(right,pose(right),232,{direction:'right'}).x>2);
 c.press('right',right,240,'release');
 const held=c.update(right,pose(right),240).x;
 assert.equal(c.update(right,pose(right),304).x,held,'wait for the in-flight repeat');
 const rejected=view({x:2});rejected.snapshot.tick=right.snapshot.tick+2;
 assert.equal(c.update(rejected,pose(rejected),340).x,held);
 const returning=c.update(rejected,pose(rejected),345).x;
 assert.ok(returning<held && returning>2,'unaccepted step retracts smoothly');
 assert.equal(c.update(rejected,pose(rejected),390).x,2);
});

test('taking over an interpolated server move continues past the drawn position',()=>{
 const {controller:c}=fixture(),right=view({x:2});
 c.update(right,{...pose(right),x:1},100);c.update(right,{...pose(right),x:1.25},150);
 c.press('right',right,150);
 assert.ok(c.update(right,pose(right),158).x>1.25);
});

test('a correction follows its remaining corner without retracing discarded strides',()=>{
 const c=module.createLocalMovement(),v=view({x:5,y:5});c.update(v,pose(v),0);c.press('right',v,0);
 c.update(v,pose(v),50);c.press('up',v,50);
 const accepted=view({x:6,y:5});c.update(accepted,pose(accepted),110,{direction:'up'});
 let previousX=5;
 for(let t=111;t<=150;t++) {
   const p=c.update(accepted,pose(accepted),t,{direction:'up'});
   assert.ok(p.x>=previousX,'correction only advances toward the accepted cell');previousX=p.x;
 }
});

test('a second tap in the same direction is preserved through a confirmed stride',()=>{
 const {controller:c,v}=fixture();c.press('right',v,0);
 const confirmed=view({x:2});c.update(confirmed,pose(confirmed),60);
 c.press('right',confirmed,110);c.press('right',confirmed,125,'repeat');c.press('right',confirmed,128,'release');
 const p=c.update(confirmed,pose(confirmed),225);
 assert.ok(p.x>2);assert.ok(p.x<3);
});

test('a short reversal stays in motion through the remaining confirmed cooldown',()=>{
 const c=module.createLocalMovement(),start=view({x:3,y:2});c.update(start,pose(start),0);c.press('up',start,0);
 const accepted=view({x:3,y:3});c.update(accepted,pose(accepted),45,{direction:'up'});
 const turned=c.update(accepted,pose(accepted),60,{direction:'up'});c.press('down',accepted,60);
 let previous=turned.y;
 for(let t=76;t<=236;t+=16) {
   const p=c.update(accepted,pose(accepted),t,{direction:'down'});
   assert.ok(p.y<previous,'every frame moves toward the next legal cell');assert.ok(p.y>=2);
   previous=p.y;
 }
});

test('changing an unconfirmed reversal returns promptly to the confirmed cell',()=>{
 const c=module.createLocalMovement(),v=view({x:4,y:5});c.update(v,pose(v),0);c.press('right',v,0);
 const next=view({x:5,y:5});c.update(next,pose(next),45,{direction:'right'});
 c.press('left',next,60);c.update(next,pose(next),100,{direction:'left'});c.press('right',next,100);
 assert.ok(c.update(next,pose(next),151,{direction:'right'}).x>5);
});

for (const [name, x, y] of [['straight', 5, 3], ['turn', 4, 4]]) {
  test(`bunched confirmations keep the onscreen ${name} continuous`, () => {
    const c = module.createLocalMovement();
    const initial = view({ x: 3, y: 3 }), first = view({ x: 4, y: 3 }), second = view({ x, y });
    first.snapshot.tick = 3;
    second.snapshot.tick = 5;
    c.update(initial, pose(initial), 0);
    c.press('right', initial, 0);
    c.update(first, pose(first), 160);
    let previous = c.update(first, pose(first), 175);
    for (let t = 176; t <= 510; t++) {
      const next = c.update(second, pose(second), t);
      assert.ok(Math.hypot(next.x - previous.x, next.y - previous.y) <= .011,
        `jump at ${t}ms from ${previous.x},${previous.y} to ${next.x},${next.y}`);
      assert.ok(next.y === 3 || next.x === 4, 'the accepted corner is retained');
      previous = next;
    }
    assert.deepEqual([previous.x, previous.y], [x, y]);
    assert.equal(previous.facing, name === 'straight' ? 'right' : 'up');
  });
}

test('an accepted held step never reverses when keyup precedes the server acknowledgement', () => {
  const c = module.createLocalMovement();
  const initial = view({ x: 3, y: 3 }), first = view({ x: 4, y: 3 }), second = view({ x: 5, y: 3 });
  c.update(initial, pose(initial), 0);
  c.press('right', initial, 0);
  c.update(first, pose(first), 100, { direction: 'right' });
  c.update(first, pose(first), 200, { direction: 'right' });
  let previous = 4;
  for (let t = 216; t <= 560; t += 8) {
    if (t === 280) c.press('right', first, t, 'release');
    const state = t < 392 ? first : second;
    const next = c.update(state, pose(state), t, { direction: t < 280 ? 'right' : null });
    assert.ok(next.x >= previous, `accepted step moved backwards at ${t}: ${previous} to ${next.x}`);
    assert.ok(next.x <= 5);
    previous = next.x;
  }
  assert.equal(previous, 5);
});

test('a quiet network interval following an unchanged tick is not a movement rejection', () => {
  const { controller: c, v } = fixture();
  c.press('right', v, 0);
  const unchanged = view(); unchanged.snapshot.tick = 3;
  c.update(unchanged, pose(unchanged), 190, { direction: 'right' });
  for (let t = 200; t <= 380; t += 10) {
    assert.equal(c.update(unchanged, pose(unchanged), t, { direction: 'right' }).x, 2);
  }
  const accepted = view({ x: 2 }); accepted.snapshot.tick = 4;
  assert.equal(c.update(accepted, pose(accepted), 390, { direction: 'right' }).x, 2);
  assert.ok(c.update(accepted, pose(accepted), 406, { direction: 'right' }).x > 2);
});

test('a late old-direction acknowledgement preserves the reversed straight corridor', () => {
  const c = module.createLocalMovement();
  const start = view({ x: 3 }), left = view({ x: 2 }), late = view({ x: 1 });
  c.update(start, pose(start), 0); c.press('left', start, 0);
  c.update(left, pose(left), 100, { direction: 'left' });
  c.update(left, pose(left), 200, { direction: 'left' });
  c.press('right', left, 250);
  const before = c.update(left, pose(left), 279, { direction: 'right' });
  let previous = before.x;
  for (let t = 280; t <= 420; t += 4) {
    const next = c.update(late, pose(late), t, { direction: 'right' });
    assert.ok(next.x >= previous && next.x <= 2, 'continue toward the new safe target');
    previous = next.x;
  }
});

test('tiny reversals have a visible first frame even when the next server step is far away', () => {
  const c = module.createLocalMovement(), start = view({ x: 3 }), next = view({ x: 4 });
  c.update(start, pose(start), 0); c.press('right', start, 0);
  c.update(next, pose(next), 3, { direction: 'right' });
  const before = c.update(next, pose(next), 12, { direction: 'right' });
  c.press('left', next, 12);
  const after = c.update(next, pose(next), 28, { direction: 'left' });
  assert.ok(before.x - after.x > .01, 'at least half a pixel on a 50px tile');
});

test('an accepted continuation arriving mid-retraction resumes immediately', () => {
  const c = module.createLocalMovement();
  const start = view({ x: 3 }), first = view({ x: 4 }), unchanged = view({ x: 4 }), second = view({ x: 5 });
  first.snapshot.tick = 3; unchanged.snapshot.tick = 5; second.snapshot.tick = 6;
  c.update(start, pose(start), 0); c.press('right', start, 0);
  c.update(first, pose(first), 100, { direction: 'right' });
  c.update(first, pose(first), 200, { direction: 'right' });
  c.press('right', first, 280, 'release');
  c.update(unchanged, pose(unchanged), 380);
  const accepted = c.update(second, pose(second), 392);
  assert.ok(c.update(second, pose(second), 408).x > accepted.x);
  assert.equal(c.update(second, pose(second), 610).x, 5);
});

test('capture disables prediction immediately and settles from the last visible fraction', () => {
  const { controller: c, v } = fixture();
  c.press('right', v, 0);
  const preceding = c.update(v, pose(v), 120).x;
  const trapped = view({ bubbleTicks: 18 });
  const bubble = {...pose(trapped),bubble:true,capture:0};
  const hit = c.update(trapped, bubble, 121, { direction: 'right' });
  assert.equal(hit.x, preceding);
  assert.equal(hit.bubble, true);
  assert.equal(hit.moving, false);
  assert.equal(c.press('right', trapped, 124), false);
  const halfway = c.update(trapped, bubble, 150, { direction: 'right' });
  assert.ok(halfway.x < preceding && halfway.x > 1);
  assert.equal(c.update(trapped, bubble, 235).x, 1);
  assert.equal(trapped.me.bubbleTicks, 18);
});

test('a coalesced straight step can be recovered while an unrelated relocation still snaps', () => {
  const { controller: c, v } = fixture();
  c.press('right', v, 0);
  const coalesced = view({ x: 3 }); coalesced.snapshot.tick = 5;
  const before = c.update(v, pose(v), 150);
  const received = c.update(coalesced, pose(coalesced), 151);
  assert.ok(Math.abs(received.x - before.x) < .01);
  const teleport = view({ x: 7, y: 5 }); teleport.snapshot.tick = 6;
  const relocalized = c.update(teleport, pose(teleport), 200);
  assert.deepEqual([relocalized.x, relocalized.y], [7, 5]);
});
