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
