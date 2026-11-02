import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropPickup, collectPickup, rescueAdjacent, hitPlayer } from '../src/pickups.js';
import { fireDart, movementCooldown, eliminatePlayer, finishScores } from '../src/combat.js';
const p = (id, fields = {}) => ({ id, userId:id, name:id, team:'blue', x:1,y:1,alive:true,bubbleTicks:0,score:0,darts:0,speedLevel:0,...fields });
const room = players => ({mode:'team',tick:10,solid:new Set(),soft:new Set(),items:new Map(),orbs:new Map(),players:new Map(players.map(p=>[p.id,p])),roster:players});

test('normal mode has no item drops or collection, while speed/dart upgrades are capped', () => {
 const a=p('a'); const r=room([a]); r.itemMode=false;
 assert.equal(dropPickup(r,1,1,()=>0),null); assert.equal(r.items.size,0);
 r.items.set('1,1',{type:'dart'}); assert.equal(collectPickup(r,a),null); assert.equal(a.darts,0);
 r.itemMode=true;
 for(let i=0;i<7;i++){r.items.set('1,1',{type:'dart'});collectPickup(r,a);r.items.set('1,1',{type:'dash'});collectPickup(r,a);}
 assert.equal(a.darts,3); assert.equal(a.speedLevel,1); assert.equal(a.dash,true);
 assert.equal(movementCooldown(p('base')),2); assert.equal(movementCooldown(a),1);
});

test('darts consume one charge, rescue allies, finish enemy bubbles and award points once', () => {
 const a=p('a',{darts:3,facing:'right'}), ally=p('ally',{x:3,bubbleTicks:8}), enemy=p('enemy',{x:5,team:'pink',bubbleTicks:9});
 const r=room([a,ally,enemy]);
 assert.equal(fireDart(r,a,()=>{}),true); assert.equal(a.darts,2);assert.equal(ally.bubbleTicks,0);assert.equal(enemy.alive,true);assert.equal(a.score,50);
 assert.equal(fireDart(r,a,()=>{}),true);assert.equal(enemy.alive,false);assert.equal(a.score,150);assert.equal(a.darts,1);
 fireDart(r,a,()=>{});assert.equal(a.score,150);assert.equal(a.darts,0);
 assert.equal(fireDart(r,a,()=>{}),false);
});

test('dart trace respects walls, range and first bomb', () => {
 const a=p('a',{darts:3,facing:'right'}),enemy=p('enemy',{x:5,team:'pink',bubbleTicks:8});const r=room([a,enemy]);
 r.soft.add('3,1');fireDart(r,a,()=>{});assert.equal(enemy.alive,true);
 r.soft.clear();r.orbs.set('2,1',{x:2,y:1});let detonations=0;fireDart(r,a,orb=>{assert.equal(orb.x,2);detonations++;});assert.equal(detonations,1);assert.equal(enemy.alive,true);
 r.orbs.clear();enemy.x=10;fireDart(r,a,()=>{});assert.equal(enemy.alive,true);
});

test('bubbled, eliminated, and item-disabled players cannot fire darts', () => {
 for(const fields of [{bubbleTicks:5},{alive:false},{}]) {
  const a=p('a',{darts:2,facing:'right',...fields}),r=room([a]); if(!Object.keys(fields).length)r.itemMode=false;
  assert.equal(fireDart(r,a,()=>{throw Error('must not fire')}),false);assert.equal(a.darts,2);
 }
});

test('rescue provides brief immunity and cannot repeatedly award points for the same bubble', () => {
 const a=p('a'),b=p('b',{x:2,bubbleTicks:10});const r=room([a,b]);
 rescueAdjacent(r,a);rescueAdjacent(r,a);assert.equal(a.score,50);assert.equal(b.bubbleTicks,0);
 hitPlayer(b,11,'enemy');assert.equal(b.bubbleTicks,0);hitPlayer(b,15,'enemy');assert.equal(b.bubbleTicks,20);
});

test('bubble timeout awards only the opposing attacker and finishing awards winners once', () => {
 const a=p('a'),b=p('b',{team:'pink',bubbleSourceId:'a'});const r=room([a,b]);
 eliminatePlayer(r,b);eliminatePlayer(r,b);assert.equal(a.score,100);assert.equal(b.alive,false);
 r.result={winnerTeam:'blue'};finishScores(r);finishScores(r);assert.equal(a.score,300);assert.equal(r.result.scoreboard.length,2);assert.equal(r.result.scoreboard[0].id,'a');
 const self=p('self',{bubbleSourceId:'self'}),solo=room([self]);eliminatePlayer(solo,self);assert.equal(self.score,0);
});
