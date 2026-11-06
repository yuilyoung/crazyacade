import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as relay from '../src/relay.js';
import { rescuePlayer } from '../src/combat.js';
import { decideBotInput } from '../src/bots.js';
function fixture(ruleSet = 'harmony') {
  const room = { ruleSet, mode: 'team', tick: 0, solid: new Set(), soft: new Set(), orbs: new Map(), waves: [], items: new Map(), players: new Map() };
  relay.initializeRelay(room);
  function add(id, x, team = 'blue', extra = {}) {
    const p = { id, x, y: 5, team, alive: true, bubbleTicks: 0, connected: true, facing: 'right', score: 0, ...extra };
    room.players.set(id,p); return p;
  }
  const carrier = add('a', 4), ally = add('b', 6), enemy = add('c', 9, 'pink');
  if (room.relay) { room.relay.carrierId = carrier.id; room.relay.star = null; }
  return { room, carrier, ally, enemy, add };
}
test('harmony initializes a seven-point objective and only actual allied rescues charge carried possession', () => {
  const { room, carrier, ally, enemy } = fixture();
  assert.equal(room.relay?.goal, 7);
  assert.equal(rescuePlayer(room, carrier, ally), false);
  assert.equal(relay.relayState(room).charges.rescue, 0);
  ally.bubbleTicks = 10; rescuePlayer(room, carrier, ally);
  assert.equal(relay.relayState(room).charges.rescue, 1);
  ally.bubbleTicks = 10; rescuePlayer(room, carrier, ally);
  assert.equal(relay.relayState(room).charges.rescue, 1);
  relay.dropRelayCarrier(room, carrier.id);
  assert.equal(relay.relayState(room).charges.total, 0);
  room.relay.carrierId = enemy.id; ally.bubbleTicks = 10; rescuePlayer(room, carrier, ally);
  assert.equal(relay.relayState(room).charges.total, 0);
});
test('pass reaches first eligible player, enforces shared ten tick cooldown and resets on interception', () => {
  const { room, carrier, ally, enemy, add } = fixture();
  assert.equal(typeof relay.passRelayStar, 'function');
  add('offline',5,'pink',{connected:false}); add('bubble',5,'pink',{bubbleTicks:10}); add('dead',5,'pink',{alive:false});
  assert.equal(relay.passRelayStar(room,carrier), true);
  assert.equal(room.relay.carrierId,ally.id); assert.equal(carrier.passes,1);
  assert.equal(relay.relayState(room).charges.passes,1);
  assert.equal(relay.passRelayStar(room,ally),false);
  room.tick=10;
  assert.equal(relay.passRelayStar(room,ally),true);
  assert.equal(room.relay.carrierId,enemy.id); assert.equal(enemy.interceptions,1);
  assert.equal(relay.relayState(room).charges.total,0);
  assert.equal(relay.relayState(room).passEffects.at(-1).interception,true);
});
for (const blocker of ['solid','soft','orbs']) test(`pass stops at ${blocker} and maintains possession without consuming cooldown`,()=>{
  const {room,carrier,ally}=fixture();
  assert.equal(typeof relay.passRelayStar,'function');
  if(blocker==='orbs') room.orbs.set('5,5',{x:5,y:5}); else room[blocker].add('5,5');
  assert.equal(relay.passRelayStar(room,carrier),false); assert.equal(room.relay.carrierId,carrier.id);
  room[blocker].clear(); assert.equal(relay.passRelayStar(room,carrier),true); assert.equal(room.relay.carrierId,ally.id);
});
test('pass maximum seven cells and ineligible carriers cannot transfer',()=>{
  const {room,carrier,ally,enemy}=fixture();
  assert.equal(typeof relay.passRelayStar,'function');
  carrier.x=1; ally.x=9; enemy.y=7;
  assert.equal(relay.passRelayStar(room,carrier),false);
  ally.x=8; carrier.connected=false; assert.equal(relay.passRelayStar(room,carrier),false);
  carrier.connected=true; assert.equal(relay.passRelayStar(room,carrier),true);
});
test('distinct receivers cap charge at two; harmony delivery adds at most four points and resets',()=>{
  const {room,carrier,ally,enemy,add}=fixture();
  assert.equal(typeof relay.passRelayStar,'function');
  const third=add('d',7);
  relay.passRelayStar(room,carrier);
  room.tick=10; ally.facing='left'; relay.passRelayStar(room,ally);
  room.tick=20; relay.passRelayStar(room,carrier);
  assert.equal(relay.relayState(room).charges.passes,2);
  room.tick=30; ally.facing='right'; relay.passRelayStar(room,ally);
  assert.equal(room.relay.carrierId,third.id); assert.equal(relay.relayState(room).charges.passes,2);
  carrier.bubbleTicks=10; rescuePlayer(room,third,carrier);
  third.x=1; relay.stepRelay(room);
  assert.equal(room.relay.scores.blue,4); assert.equal(third.deliveries,1);
  assert.equal(relay.relayState(room).charges.total,0);
  assert.equal(relay.relayResult(room),null); room.relay.scores.blue=7;
  assert.equal(relay.relayResult(room).winnerTeam,'blue');
});
test('classic relay supports passes but retains one point per delivery',()=>{
  const {room,carrier,ally}=fixture('relay');
  assert.equal(typeof relay.passRelayStar,'function');
  relay.passRelayStar(room,carrier); ally.x=1; relay.stepRelay(room);
  assert.equal(room.relay.scores.blue,1); assert.equal(room.relay.goal,3);
});
test('bot carrier requests a safe allied pass toward home using the same blocked ray',()=>{
  const {room,carrier,ally,enemy}=fixture();
  carrier.x=6; carrier.facing='left'; ally.x=3; enemy.y=7;
  assert.equal(decideBotInput(room,carrier).passStar,true);
  room.solid.add('5,5'); assert.notEqual(decideBotInput(room,carrier).passStar,true);
});
