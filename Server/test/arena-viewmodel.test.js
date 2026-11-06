import test from 'node:test';
import assert from 'node:assert/strict';
import { createArenaViewModel } from '../public/arena-viewmodel.js';
const playing = () => ({ phase:'playing', ruleSet:'harmony', players:[{id:'me',alive:true,bubbleTicks:0,team:'blue'}], relay:{carrierId:'me',charges:{passes:2,rescue:1,total:3},goal:7,scores:{blue:0,pink:0}} });
test('VM copies and deeply freezes state and settings without exposing source references', () => {
 const vm=createArenaViewModel(), source=playing(); vm.receive(source); source.players[0].alive=false;
 assert.equal(vm.snapshot.players[0].alive,true); assert.throws(()=>{vm.snapshot.players.push({});},TypeError);
 const settings={bindings:{up:'KeyW'}}; vm.configure({settings}); settings.bindings.up='KeyZ'; assert.equal(vm.view.settings.bindings.up,'KeyW');
});
test('VM gates actual transport commands on connection, modal, phase and authoritative player', () => {
 const sent=[]; const vm=createArenaViewModel({transport:{send:m=>sent.push(m)}}); vm.receive(playing());
 assert.equal(vm.input('pass_star'),false); vm.configure({playerId:'me',connection:'connected'});
 assert.equal(vm.input('pass_star'),true); assert.deepEqual(sent,[{type:'input',action:'pass_star'}]);
 vm.configure({modalOpen:true}); assert.equal(vm.input('up'),false); vm.configure({modalOpen:false});
 assert.equal(vm.input('invented'),false); const s=playing(); s.players[0].bubbleTicks=2; vm.receive(s); assert.equal(vm.input('up'),false);
});
test('VM projects harmony contribution and cleans subscriptions', () => {
 const vm=createArenaViewModel(); let calls=0; const stop=vm.subscribe(()=>calls++); vm.configure({playerId:'me',connection:'connected'}); vm.receive(playing());
 assert.equal(vm.view.relay.deliveryValue,4); assert.equal(vm.view.canPass,true); const before=calls; stop(); vm.receive(playing()); assert.equal(calls,before); vm.reset(); assert.equal(vm.snapshot,null);
});

test('harmony learning projection follows authoritative stages and remapped keys', () => {
 const vm=createArenaViewModel(); vm.configure({playerId:'me',connection:'connected',settings:{bindings:{pass:'KeyH',dart:'KeyF'}}});
 const source=playing(); source.training={mode:'harmony',stage:'pass',status:'ready',title:'별 패스',instruction:'표시된 아군에게 별을 보내세요.',step:1,total:4,completed:0,attempts:0,target:{x:6,y:5}};
 vm.receive(source); assert.equal(vm.view.training.mode,'harmony');assert.match(vm.view.training.instruction,/H.*패스/);assert.ok(!vm.view.training.instruction.includes('G'));
 assert.equal(vm.view.canInput,false); assert.equal(vm.view.canTrainingReady,true);
 source.training={...source.training,stage:'charge_rescue',status:'retrying',failureReason:'target_eliminated',attempts:1}; vm.receive(source);
 assert.match(vm.view.training.failure,/구출.*시간|아군.*탈락/);assert.match(vm.view.training.instruction,/F/);
 source.training={...source.training,stage:'complete',status:'complete',completed:4}; vm.receive(source);
 assert.equal(vm.view.training.continueRuleSet,'harmony');assert.equal(vm.view.training.complete,true);
});

test('classic training keeps its own controls and continuation rules', () => {
 const vm=createArenaViewModel(); vm.receive({...playing(),ruleSet:'classic',training:{stage:'escape',status:'active',title:'회피',instruction:'안전칸으로 이동',step:1,total:4,completed:0,attempts:0}});
 assert.equal(vm.view.training.mode,'classic');assert.match(vm.view.training.instruction,/SPACE/);assert.equal(vm.view.training.continueRuleSet,null);
});
test('training explains paused reading time and a distinct idle expiry without claiming completion',()=>{
 const vm=createArenaViewModel();const source={...playing(),training:{stage:'pass',mode:'harmony',status:'ready',readingIdleRemainingSeconds:600}};
 vm.receive(source);assert.match(vm.view.training.readingHint,/3분.*멈춰/);assert.match(vm.view.training.readingHint,/10분/);
 vm.receive({...source,phase:'finished',result:{reason:'training_idle_timeout'}});
 assert.equal(vm.view.training.complete,false);assert.match(vm.view.training.endHint,/준비 대기.*다시/);
});
