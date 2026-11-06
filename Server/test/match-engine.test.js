import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ruleFor } from '../src/rules.js';
import { stepMatch, queueInput } from '../src/match-engine.js';
import { initializeMapFeatures } from '../src/map-features.js';
import { createLayout } from '../src/catalog.js';
import { arenaHazards } from '../src/hazards.js';

function fixture(ruleSet='harmony') {
  const room={ruleSet,mode:'team',mapId:'harbor',itemMode:true,tick:99,players:new Map(),items:new Map(),orbs:new Map(),waves:[],dartEffects:[],...createLayout('harbor','team')};
  const player={id:'p',userId:'u',team:'blue',alive:true,bubbleTicks:0,connected:true,socket:{readyState:1,OPEN:1},x:6,y:2,facing:'up',range:4,darts:1,maxOrbs:1,activeOrbs:0,bombsPlaced:0,nextMoveTick:0};
  room.players.set(player.id,player);initializeMapFeatures(room);ruleFor(room).initialize(room);
  return {room,player};
}
test('every selected rule exposes lifecycle and detached presentation through the same contract',()=>{
  for(const ruleSet of ['classic','relay','harmony']) {
    const {room}=fixture(ruleSet), rule=ruleFor(room);
    for(const method of ['initialize','step','result','snapshot'])assert.equal(typeof rule[method],'function');
    if(ruleSet==='classic')assert.equal(rule.result(room).winnerTeam,'blue');
    else { room.players.set('enemy',{id:'enemy',team:'pink',alive:false}); assert.equal(rule.result(room),null); const publicState=rule.snapshot(room);publicState.relay.scores.blue=99; assert.equal(room.relay.scores.blue,0); }
  }
});
test('gate closes before movement, passes, darts, blasts and neutral hazard prediction',()=>{
  const {room,player}=fixture();
  const target={id:'target',team:'blue',x:6,y:5,alive:true,bubbleTicks:12,connected:true};room.players.set(target.id,target);
  room.relay.carrierId=player.id;room.relay.star=null;
  queueInput(player,'up');queueInput(player,'use_dart');queueInput(player,'pass_star');
  room.orbs.set('6,2',{x:6,y:2,fuse:1,range:4,ownerId:player.id});
  stepMatch(room);
  assert.equal(room.solid.has('6,3'),true);assert.deepEqual([player.x,player.y],[6,2]);
  assert.equal(target.bubbleTicks,11,'closed gate blocks rescue dart and explosion');
  assert.equal(room.waves.some(w=>w.x===6&&w.y>=3),false);
  assert.equal(room.relay.passEffects.length,0);
  room.orbs.set('6,2',{x:6,y:2,fuse:5,range:4});
  assert.equal(arenaHazards(room).deadlines.has('6,5'),false);
});
test('occupying a closing gate holds it open until a player leaves; then all actions see closure',()=>{
  const {room,player}=fixture();player.y=3;
  stepMatch(room);assert.equal(room.solid.has('6,3'),false);
  queueInput(player,'down');stepMatch(room);assert.equal(player.y,2);assert.equal(room.solid.has('6,3'),false);
  stepMatch(room);assert.equal(room.solid.has('6,3'),true);
});
test('bot pass decisions execute ordinary pass input and charge harmony without privileged transfer',()=>{
  const {room,player}=fixture();room.tick=2;room.solid.clear();room.soft.clear();room.mapFeatures=null;
  Object.assign(player,{x:6,y:5,isBot:true,facing:'right'});
  room.relay.carrierId=player.id;room.relay.star=null;
  const ally={id:'ally',team:'blue',x:3,y:5,alive:true,bubbleTicks:0,connected:true,socket:{readyState:1,OPEN:1}};room.players.set(ally.id,ally);
  stepMatch(room);
  assert.equal(room.relay.carrierId,ally.id);assert.equal(player.passes,1);
  assert.equal(room.relay.passRecipients.size,1);assert.equal(room.relay.nextPassTick,13);
});
test('both movement and ranged dart rescues charge the carried team once and a drop clears actual charges',()=>{
  for(const action of ['right','use_dart']) {
    const {room,player}=fixture();room.tick=1;room.solid.clear();room.soft.clear();room.mapFeatures=null;
    Object.assign(player,{x:2,y:5,facing:'right'});
    const carrier={id:'carrier',team:'blue',x:8,y:5,alive:true,bubbleTicks:0,connected:true,socket:{readyState:1,OPEN:1}};
    const trapped={id:'trapped',team:'blue',x:4,y:5,alive:true,bubbleTicks:10,connected:true,socket:{readyState:1,OPEN:1}};
    room.players.set(carrier.id,carrier);room.players.set(trapped.id,trapped);room.relay.carrierId=carrier.id;room.relay.star=null;
    queueInput(player,action);stepMatch(room);
    assert.equal(trapped.bubbleTicks,0);assert.equal(player.rescues,1);assert.equal(room.relay.rescueCharge,1);
    carrier.connected=false;stepMatch(room);assert.equal(room.relay.rescueCharge,0);assert.equal(room.relay.carrierId,null);
  }
});
