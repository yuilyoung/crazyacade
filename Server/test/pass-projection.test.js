import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPass, createArenaViewModel } from '../public/arena-viewmodel.js';
const person=(id,x,y,patch={})=>({id,x,y,team:'blue',alive:true,bubbleTicks:0,connected:true,facing:'right',...patch});
const me=()=>person('me',2,5);
const state=(players=[],patch={})=>({phase:'playing',ruleSet:'harmony',players:[me(),...players],solid:[],soft:[],orbs:[],relay:{carrierId:'me',passCooldownTicks:0},...patch});
test('pass guide chooses the first eligible recipient in facing direction, with no source mutation',()=>{
 const source=state([person('bubble',3,5,{bubbleTicks:5}),person('offline',4,5,{connected:false}),person('dead',5,5,{alive:false}),person('ally',6,5),person('enemy',7,5,{team:'pink'})]);
 const result=projectPass(source,source.players[0]);assert.equal(result.status,'ally');assert.equal(result.target.id,'ally');assert.deepEqual(result.cells.at(-1),{x:6,y:5});
 assert.throws(()=>result.cells.push({x:7,y:5}),TypeError);assert.equal(source.players[0].facing,'right');
 source.players[4].team='pink';assert.equal(projectPass(source,source.players[0]).status,'enemy');
});
test('walls, crates, orbs and map bounds stop before a recipient on the same cell',()=>{
 for(const [field,values,kind] of [['solid',['4,5'],'wall'],['soft',['4,5'],'crate'],['orbs',[{x:4,y:5}],'orb']]){
  const source=state([person('ally',4,5)],{[field]:values});const result=projectPass(source,source.players[0]);assert.equal(result.status,'blocked');assert.equal(result.obstacle.kind,kind);assert.equal(result.target,null);assert.deepEqual(result.cells,[{x:3,y:5}]);
 }
 const source=state();source.players[0]=person('me',1,5,{facing:'left'});assert.equal(projectPass(source,source.players[0]).obstacle.kind,'wall');
});
test('guide respects seven cells, cooldown, no carrier, bubbles and finished state',()=>{
 const source=state([person('far',10,5)]);assert.equal(projectPass(source,source.players[0]).status,'empty');assert.equal(projectPass(source,source.players[0]).cells.length,7);
 source.relay.passCooldownTicks=3;assert.equal(projectPass(source,source.players[0]).status,'cooldown');
 source.relay.carrierId='far';assert.equal(projectPass(source,source.players[0]),null);source.relay.carrierId='me';source.players[0].bubbleTicks=1;assert.equal(projectPass(source,source.players[0]),null);
 source.players[0].bubbleTicks=0;source.phase='finished';assert.equal(projectPass(source,source.players[0]),null);
});
test('VM pass guide uses remapped key, can be disabled, and never adds a chosen target to input',()=>{
 const sent=[];const vm=createArenaViewModel({transport:{send:m=>sent.push(m)}});vm.configure({playerId:'me',connection:'connected',settings:{bindings:{pass:'KeyH'}}});vm.receive(state([person('ally',4,5)]));
 assert.match(vm.view.passHint,/H.*아군/);assert.equal(vm.view.passGuide.status,'ally');assert.equal(vm.input('pass_star'),true);assert.deepEqual(sent,[{type:'input',action:'pass_star'}]);
 vm.configure({settings:{passGuide:false}});assert.equal(vm.view.passGuide,null);assert.equal(vm.view.passHint,'');
});
test('finished harmony training shows actual delivered score and own contributions, never a reset next-star value',()=>{
 const source=state();source.phase='finished';source.training={mode:'harmony',stage:'complete',status:'complete',completed:4,total:4,attempts:0};source.players[0]={...source.players[0],passes:1,rescues:1,deliveries:1};
 source.relay={...source.relay,carrierId:null,scores:{blue:2,pink:0},charges:{passes:0,rescue:0,total:0}};source.result={reason:'training_complete',scoreboard:[{id:'me',passes:1,rescues:1,deliveries:1}]};
 const vm=createArenaViewModel();vm.configure({playerId:'me'});vm.receive(source);
 assert.equal(vm.view.training.deliveryValue,null);assert.equal(vm.view.training.achievement.deliveredPoints,2);assert.match(vm.view.training.achievement.text,/2점 전달/);assert.match(vm.view.training.achievement.text,/4.*4.*단계/);assert.match(vm.view.training.achievement.text,/패스 1.*구출 1/);
});

test('large pass guides cross both legacy boundaries and stop at authoritative borders',()=>{
 for(const [from,target,facing,border] of [[{x:10,y:6},{x:13,y:6},'right',{x:14,y:6}],[{x:7,y:8},{x:7,y:11},'up',{x:7,y:12}]]) {
  const source=state([person('ally',target.x,target.y)],{arena:{width:15,height:13}}); source.players[0]=person('me',from.x,from.y,{facing});
  assert.equal(projectPass(source,source.players[0]).target?.id,'ally');
  source.players.pop(); assert.deepEqual(projectPass(source,source.players[0]).obstacle,{...border,kind:'wall'});
  delete source.arena; assert.equal(projectPass(source,source.players[0]).obstacle?.kind,'wall');
 }
});
