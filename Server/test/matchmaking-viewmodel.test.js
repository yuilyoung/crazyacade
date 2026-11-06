import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatchmakingViewModel, queueErrorText } from '../public/matchmaking-viewmodel.js';

function setup() {
  const sent=[];
  const vm=createMatchmakingViewModel({transport:{send:message=>{sent.push(message);return true;}}});
  vm.configure({enabled:true,connection:'connected'});
  return {vm,sent};
}
test('queue commands omit client rating and private room choices',()=>{
  const {vm}=setup();
  assert.equal(vm.begin('queue_1'),true);
  assert.deepEqual(vm.joinPayload('verified-token',{name:'Popper',characterId:'momo',skinId:'mint',orbSkinId:'star',rating:9999,roomId:'private',seriesMode:'party3'}),{
    type:'queue_join',requestId:'queue_1',accessToken:'verified-token',name:'Popper',characterId:'momo',skinId:'mint',orbSkinId:'star'
  });
  vm.receive({type:'queue_state',requestId:'queue_1',status:'searching',source:'supabase',rating:1250,tier:'Gold',elapsedMs:16000,searchRadius:150,requiredPlayers:8});
  assert.equal(vm.view.identity,'인증 계정 · 골드 1,250점');
  assert.equal(vm.view.elapsedSeconds,16);assert.equal(vm.view.searchRadius,150);
  assert.equal(vm.view.canCancel,true);assert.equal(vm.view.canStart,false);
});
test('cancelled authentication and old queue replies cannot reopen a search or match',()=>{
  const {vm,sent}=setup();vm.begin('old');assert.equal(vm.cancel(),true);
  assert.deepEqual(sent,[{type:'queue_cancel',requestId:'old'}]);
  assert.equal(vm.joinPayload('late-token',{}),null);
  assert.equal(vm.receive({type:'queue_state',requestId:'old',status:'searching',rating:1000}),false);
  assert.equal(vm.acceptJoined({requestId:'old'}),false);
  vm.begin('new');assert.equal(vm.receive({type:'queue_state',requestId:'old',status:'cancelled'}),false);
  assert.equal(vm.fail({requestId:'old',code:'profile_unavailable'}),false);
  assert.equal(vm.view.status,'authenticating');
  vm.receive({type:'queue_state',requestId:'new',status:'searching',source:'demo',rating:1000,tier:'Bronze',elapsedMs:0,searchRadius:100,requiredPlayers:8});
  assert.equal(vm.receive({type:'queue_state',requestId:'new',status:'authenticating'}),false);
  assert.match(vm.view.identity,/개발.*임시/);assert.equal(vm.acceptJoined({requestId:'new'}),true);
  assert.equal(vm.view.status,'matched');assert.equal(vm.cancel(),false);
});
test('development guest queue omits an absent access token accepted by the server protocol',()=>{
  const {vm}=setup();vm.begin('demo');
  assert.equal(Object.hasOwn(vm.joinPayload(null,{name:'Guest',characterId:'momo',skinId:'classic',orbSkinId:'bubble'}),'accessToken'),false);
});
test('next match requires a current connected finished matching room and preserves it on failure',()=>{
  const {vm,sent}=setup();const finished={phase:'finished',matchId:'match-1',matchmaking:{source:'demo',requiredPlayers:8}};
  vm.configure({snapshot:{...finished,phase:'playing'}});assert.equal(vm.nextMatch('next'),false);
  vm.configure({snapshot:finished,modalOpen:true});assert.equal(vm.nextMatch('next'),false);
  vm.configure({modalOpen:false,connection:'reconnecting'});assert.equal(vm.nextMatch('next'),false);
  vm.configure({connection:'connected'});assert.equal(vm.nextMatch('next'),true);
  assert.deepEqual(sent,[{type:'next_match',requestId:'next',matchId:'match-1'}]);
  assert.equal(vm.view.canNextMatch,false);assert.equal(vm.view.preserveResult,true);
  assert.equal(vm.fail({requestId:'next',code:'profile_unavailable'}),true);
  assert.equal(vm.view.canNextMatch,true);assert.equal(vm.view.preserveResult,true);
  assert.match(vm.view.message,/다시/);
});
test('accepted next search leaves the result and closed views cannot issue commands',()=>{
  const {vm}=setup();vm.configure({snapshot:{phase:'finished',matchId:'m',matchmaking:{source:'demo',requiredPlayers:8}}});
  vm.nextMatch('n');vm.receive({type:'queue_state',requestId:'n',status:'searching',source:'demo',rating:1000,tier:'Bronze',elapsedMs:0,searchRadius:100,requiredPlayers:8});
  assert.equal(vm.view.preserveResult,false);
  vm.reset();assert.equal(vm.acceptJoined({requestId:'n'}),false);assert.equal(vm.cancel(),false);
  vm.configure({enabled:true,modalOpen:true});assert.equal(vm.begin('hidden'),false);
});
test('ranked reload recovery accepts only the saved participant on the reconnecting transport',()=>{
  const {vm}=setup(), record={playerId:'mine',roomId:'ranked-room'};
  const resumed={requestId:'old-queue',resumed:true,playerId:'mine',roomId:'ranked-room'};
  assert.equal(vm.acceptJoined(resumed,record),false);
  vm.configure({connection:'reconnecting'});
  assert.equal(vm.acceptJoined({...resumed,roomId:'other'},record),false);
  assert.equal(vm.acceptJoined({...resumed,resumed:false},record),false);
  assert.equal(vm.acceptJoined(resumed,record),true);
  assert.equal(vm.acceptJoined({...resumed,resumed:false}),false);
});
test('cancelled next match acknowledges an already accepted departure without reopening its queue',()=>{
  const {vm}=setup();vm.configure({snapshot:{phase:'finished',matchId:'m',matchmaking:{source:'demo',requiredPlayers:8}}});
  vm.nextMatch('n');vm.cancel();assert.equal(vm.view.preserveResult,true);
  assert.equal(vm.receive({type:'queue_state',requestId:'n',status:'searching',source:'demo',rating:1000,tier:'Bronze',elapsedMs:0,searchRadius:100}),true);
  assert.equal(vm.view.status,'cancelled');assert.equal(vm.view.busy,true);assert.equal(vm.view.preserveResult,false);
  assert.equal(vm.view.canNextMatch,false);
  assert.equal(vm.acceptJoined({requestId:'n'}),false);
  vm.receive({type:'queue_state',requestId:'n',status:'cancelled'});assert.equal(vm.view.busy,false);
  vm.configure({snapshot:null});assert.equal(vm.view.canNextMatch,false);assert.equal(vm.view.canStart,true);
});
test('next-match cancellation waits for acknowledgment before another result command can replace ownership',()=>{
  const {vm}=setup();vm.configure({snapshot:{phase:'finished',matchId:'m',matchmaking:{source:'demo',requiredPlayers:8}}});
  vm.nextMatch('departed');vm.cancel();
  assert.equal(vm.nextMatch('retry-before-ack'),false);assert.equal(vm.view.busy,true);
  vm.receive({type:'queue_state',requestId:'departed',status:'searching'});
  vm.receive({type:'queue_state',requestId:'departed',status:'cancelled'});
  assert.equal(vm.view.canNextMatch,false);assert.equal(vm.view.preserveResult,false);
  vm.reset();vm.configure({snapshot:{phase:'finished',matchId:'other',matchmaking:{source:'demo',requiredPlayers:8}},connection:'connected'});
  vm.nextMatch('stayed');vm.cancel();vm.receive({type:'queue_state',requestId:'stayed',status:'cancelled'});
  assert.equal(vm.view.canNextMatch,true);assert.equal(vm.view.preserveResult,true);
});
test('authoritative recovery clears a cancellation pending on the previous connection',()=>{
  const {vm}=setup();vm.configure({snapshot:{phase:'finished',matchId:'m',matchmaking:{source:'demo',requiredPlayers:8}}});
  vm.nextMatch('interrupted');vm.cancel();vm.configure({connection:'reconnecting'});
  const record={roomId:'room',playerId:'me'};
  assert.equal(vm.acceptJoined({...record,resumed:true},record),true);
  vm.configure({connection:'connected'});
  assert.equal(vm.view.busy,false);assert.equal(vm.view.canNextMatch,true);
});
test('queue expiry and service pressure explain a player action without internal details',()=>{
  const {vm}=setup();vm.begin('q');vm.receive({type:'queue_state',requestId:'q',status:'expired'});
  assert.equal(vm.view.canCancel,false);assert.equal(vm.view.canPractice,true);assert.match(vm.view.message,/다시|연습/);
  for(const code of ['server_draining','queue_full','queue_unavailable','rate_limited','service_busy']) {
    assert.doesNotMatch(queueErrorText(code),/HTTP|gate|429|503|lock/);
    assert.match(queueErrorText(code),/잠시|점검|기다|천천/);
  }
  assert.match(queueErrorText(1008),/천천/);
  assert.match(queueErrorText(1013),/점검/);
});
test('queue policy projects actual widening boundaries and nonnegative remaining search time',()=>{
 const {vm,sent}=setup();vm.begin('policy');
 for(const [elapsedMs,radius,remaining,next] of [[0,100,180,15],[14999,100,166,1],[15000,150,165,15],[89999,350,91,1],[90000,400,90,null],[180000,400,0,null]]) {
  vm.receive({type:'queue_state',requestId:'policy',status:'searching',elapsedMs,searchRadius:radius});
  assert.equal(vm.view.remainingSeconds,remaining);assert.equal(vm.view.nextWidenSeconds,next);
 }
 assert.equal(vm.view.status,'searching');assert.equal(vm.view.canCancel,true);assert.deepEqual(sent,[]);
 assert.match(vm.view.policyText,/180초|3분/);assert.match(vm.view.policyText,/15초.*50/);assert.match(vm.view.policyText,/400/);
});
test('queue timing rejects stale progress and bounds malformed remote elapsed time and radius',()=>{
 const {vm}=setup();vm.begin('policy');
 vm.receive({type:'queue_state',requestId:'policy',status:'searching',elapsedMs:30000,searchRadius:200});
 assert.equal(vm.receive({type:'queue_state',requestId:'policy',status:'searching',elapsedMs:1000,searchRadius:100}),false);
 assert.equal(vm.view.elapsedSeconds,30);
 vm.receive({type:'queue_state',requestId:'policy',status:'searching',elapsedMs:999999,searchRadius:999});
 assert.equal(vm.view.elapsedSeconds,180);assert.equal(vm.view.remainingSeconds,0);assert.equal(vm.view.searchRadius,400);assert.equal(vm.view.nextWidenSeconds,null);
 vm.reset();vm.begin('unknown');vm.receive({type:'queue_state',requestId:'unknown',status:'searching',elapsedMs:NaN,searchRadius:-20});
 assert.equal(vm.view.remainingSeconds,null);assert.equal(vm.view.nextWidenSeconds,null);assert.equal(vm.view.searchRadius,null);
});
