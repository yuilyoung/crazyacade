import test from 'node:test';
import assert from 'node:assert/strict';
import {createArenaViewModel} from '../public/arena-viewmodel.js';
const roster=()=>Array.from({length:8},(_,i)=>({id:i===0?'me':`p${i}`,connected:true,isBot:false,team:i<4?'blue':'pink'}));
const series=()=>({id:'party',round:3,total:3,mapCycle:['candy','harbor','festival'],points:{blue:5,pink:3},mission:{kind:'passes',target:3,progress:{blue:2,pink:3}},history:[{round:1,matchId:'m1',mapId:'candy',points:{blue:3,pink:0},mission:{kind:'rescues',target:2,progress:{blue:2,pink:0}},outcome:{winnerTeam:'blue'}},{round:2,matchId:'m2',mapId:'harbor',points:{blue:2,pink:3},mission:{kind:'items',target:5,progress:{blue:5,pink:5}},outcome:{draw:true}}],complete:false,outcome:null});
test('party HUD projects authoritative mission and cumulative points without inventing completion',()=>{
  const vm=createArenaViewModel();vm.configure({playerId:'me',connection:'connected'});
  const source={phase:'playing',seriesMode:'party3',series:series(),players:roster(),mapId:'festival'};vm.receive(source);
  assert.equal(vm.view.series.roundLabel,'3 / 3라운드');assert.equal(vm.view.series.missionLabel,'팀 패스 3회');
  assert.equal(vm.view.series.missionText,'B 2/3 · P 3/3');assert.equal(vm.view.series.scoreText,'B 5 : 3 P');
  assert.equal(vm.view.series.history.length,2);assert.equal(vm.view.series.complete,false);assert.equal(vm.view.series.outcomeText,'');
  source.series.complete=true;source.series.outcome={winnerTeam:'blue'};source.series.points={blue:7,pink:4};source.phase='finished';source.matchId='m3';vm.receive(source);
  assert.equal(vm.view.series.outcomeText,'블루 팀 파티 승리!');assert.equal(vm.view.rematch.actionLabel,'새 3라운드 파티 준비');
});
test('ready toggles on the same room and is blocked by pending queue and stale phase',()=>{
  const sent=[];const vm=createArenaViewModel({transport:{send:m=>sent.push(m)}});vm.configure({playerId:'me',connection:'connected'});
  const source={phase:'finished',matchId:'m',practice:true,series:series(),players:roster(),rematch:{readyPlayerIds:[],total:1}};vm.receive(source);
  assert.equal(vm.rematch(),true);assert.deepEqual(sent[0],{type:'rematch',ready:true,matchId:'m'});assert.equal(vm.view.rematch.ownReady,true);
  vm.receive({...source,rematch:{readyPlayerIds:['me'],total:1}});assert.equal(vm.rematch(false),true);assert.deepEqual(sent[1],{type:'rematch',ready:false,matchId:'m'});
  vm.configure({queueBusy:true});assert.equal(vm.rematch(),false);vm.configure({queueBusy:false});vm.receive({...source,phase:'playing'});assert.equal(vm.rematch(),false);
});
test('rated rematch requires the original eight connected humans while readiness cancellation stays available',()=>{
  const vm=createArenaViewModel();vm.configure({playerId:'me',connection:'connected'});
  const source={phase:'finished',matchId:'m',matchmaking:{source:'demo',requiredPlayers:8},players:roster().slice(0,7),rematch:{readyPlayerIds:[],total:8}};
  vm.receive(source);assert.equal(vm.view.canRematch,false);assert.match(vm.view.rematch.message,/8명|이탈/);
  source.rematch.readyPlayerIds=['me'];vm.receive(source);assert.equal(vm.view.canRematch,true);
  source.players=roster();source.rematch.readyPlayerIds=[];vm.receive(source);assert.equal(vm.view.canRematch,true);
  source.players[7].connected=false;vm.receive(source);assert.equal(vm.view.canRematch,false);assert.match(vm.view.rematch.message,/복귀/);
});
test('party guidance explains actual targets, remapped controls and the remaining map plan',()=>{
 const vm=createArenaViewModel();vm.configure({playerId:'me',settings:{bindings:{dart:'KeyH',pass:'KeyJ'}}});
 const source={phase:'playing',ruleSet:'relay',itemMode:false,series:series(),players:roster()};vm.receive(source);
 assert.match(vm.view.series.missionHelp,/J.*패스/);
 assert.deepEqual(vm.view.series.roundPlan.map(row=>row.missionLabel),['팀 구출 2회','팀 구출 2회','팀 패스 3회']);
 source.series.mission={kind:'rescues',target:2,progress:{blue:0,pink:0}};vm.receive(source);
 assert.match(vm.view.series.missionHelp,/H.*다트/);
 source.series.mission=null;vm.receive(source);assert.equal(vm.view.series.missionKnown,false);assert.equal(vm.view.series.missionText,'');assert.match(vm.view.series.missionLabel,/확인 중/);
});
test('party next action follows the actual phase and never asks a finished player to deliver',()=>{
 const vm=createArenaViewModel();vm.configure({playerId:'me'});
 const source={phase:'playing',ruleSet:'relay',series:series(),players:roster()};source.series.mission.progress.blue=3;vm.receive(source);
 assert.match(vm.view.series.nextStep,/승리.*기지.*전달/);
 source.phase='finished';vm.receive(source);
 assert.match(vm.view.series.nextStep,/기록.*다음 라운드/);assert.doesNotMatch(vm.view.series.nextStep,/전달|살아남/);
 source.series.complete=true;vm.receive(source);
 assert.match(vm.view.series.nextStep,/전체.*새.*파티/);assert.doesNotMatch(vm.view.series.nextStep,/전달|살아남/);
});
