import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, provider, waitFor, send, close } from './fixtures/relay-server.mjs';
const me = client => client.state.players.find(p => p.id === client.playerId);
const target = client => client.state.players.find(p => p.id !== client.playerId && p.x === client.state.training.target.x && p.y === client.state.training.target.y);
async function ready(client) {
  assert.equal(client.state.training.status, 'ready');
  send(client, 'training_ready');
  await waitFor(() => client.state.training.status === 'active');
}
async function nextStage(client, action, stage) {
  send(client, 'input', { action });
  await waitFor(() => client.state.training.stage === stage);
  assert.equal(client.state.training.status, stage === 'complete' ? 'complete' : 'ready');
}
async function throughInterception(client) {
  await ready(client); await nextStage(client, 'pass_star', 'intercept');
  assert.equal(client.state.relay.charges.passes, 1);
  assert.equal(me(client).passes, 1);
  await ready(client); await nextStage(client, 'pass_star', 'charge_rescue');
  assert.equal(client.state.relay.charges.total, 0);
  assert.equal(client.state.players.reduce((sum,p) => sum+p.interceptions, 0), 1);
}

test('trainingMode validates before auth and only private explicit training accepts it', async t => {
  const auth = await provider(t), { connect, sendJoin } = await setup(t, { ...auth.env, ALLOW_DEV_GUESTS: 'false' });
  for (const trainingMode of [null, true, 4, '', 'unknown', [], {}]) {
    assert.equal((await sendJoin(await connect(), { practice: true, training: true, trainingMode })).code, 'invalid_training_mode');
  }
  for (const fields of [{}, { practice:true }, { training:false }, { practice:true,training:false }]) {
    assert.equal((await sendJoin(await connect(), { ...fields, trainingMode:'harmony' })).code,'invalid_training_mode');
  }
  assert.equal(auth.requests.length,0);
});

test('harmony is an isolated fixed festival training with frozen ready stage and no forged actions', async t => {
  const auth=await provider(t), {join,connect,sendJoin}=await setup(t,{...auth.env,ALLOW_DEV_GUESTS:'false'},{tickMs:5});
  const client=await join({practice:true,training:true,trainingMode:'harmony',mapId:'harbor',ruleSet:'classic',itemMode:false});
  assert.equal(client.state.training.mode,'harmony');
  assert.equal(client.state.mapId,'festival');assert.equal(client.state.ruleSet,'harmony');assert.equal(client.state.itemMode,true);
  assert.equal(client.state.ranked,false);assert.equal(client.state.relay.goal,7);assert.equal(client.state.remaining,1800);assert.equal(client.state.remainingSeconds,180);
  assert.equal(client.state.training.stage,'pass');assert.equal(client.state.training.status,'ready');assert.equal(client.state.training.total,4);
  assert.equal(client.state.players.length,8);assert.equal(client.state.mapFeatures,null);
  assert.deepEqual([me(client).x,me(client).y,me(client).facing],[4,5,'right']);
  const initial=client.state.tick, positions=client.state.players.map(p=>[p.id,p.x,p.y,p.bubbleTicks]);
  for(const action of ['pass_star','right','place_orb','use_dart','training_complete'])send(client,'input',{action,completed:4,charges:99});
  send(client,'training_complete',{completed:4});
  await waitFor(()=>client.state.tick>initial+25);
  assert.deepEqual(client.state.players.map(p=>[p.id,p.x,p.y,p.bubbleTicks]),positions);
  assert.equal(me(client).passes,0);assert.equal(client.state.orbs.length,0);assert.equal(client.state.relay.charges.total,0);
  await ready(client); const started=client.state.tick;
  send(client,'input',{action:'not_an_action'});send(client,'training_ready',{stage:'complete'});
  await waitFor(()=>client.state.tick>started+5);
  assert.equal(client.state.training.stage,'pass');assert.equal(client.state.relay.carrierId,client.playerId);
  assert.equal(auth.requests.length,0);
  const intruder=await connect(); assert.equal((await sendJoin(intruder,{roomId:client.state.roomId,mode:'team',accessToken:'intruder'})).code,'room_unavailable');
});

for(const rescue of ['right','use_dart'])test(`four real harmony lessons finish through ${rescue} rescue, charged delivery and no persistence`, async t=>{
  const auth=await provider(t), {join}=await setup(t,{...auth.env,ALLOW_DEV_GUESTS:'false'},{tickMs:10});
  const client=await join({practice:true,training:true,trainingMode:'harmony'});
  await throughInterception(client);
  assert.equal(target(client).bubbleTicks,100);assert.equal(me(client).darts,1);
  const reading=client.state.tick;send(client,'input',{action:rescue});
  await waitFor(()=>client.state.tick>reading+10);assert.equal(target(client).bubbleTicks,100);
  await ready(client);await nextStage(client,rescue,'delivery');
  assert.equal(me(client).rescues,1);assert.equal(client.state.relay.charges.rescue,1);
  assert.equal(client.state.relay.charges.total,1);assert.equal(client.state.relay.scores.blue,0);
  assert.deepEqual(client.state.training.target,{x:1,y:5});
  await ready(client);
  for(const x of [3,2]){send(client,'input',{action:'left'});await waitFor(()=>me(client).x===x);}
  await nextStage(client,'left','complete');await waitFor(()=>client.state.phase==='finished');
  assert.equal(client.state.training.completed,4);assert.equal(client.state.result.reason,'training_complete');
  assert.equal(client.state.resultSaving.status,'unranked');assert.equal(me(client).deliveries,1);
  assert.equal(client.state.relay.scores.blue,2);assert.equal(me(client).passes,1);assert.equal(me(client).rescues,1);
  assert.equal(auth.requests.length,0);
});

test('failed possession retries only current lesson and restores earned entry charge without inventing counters',async t=>{
  const {join}=await setup(t,{}, {tickMs:5});const client=await join({practice:true,training:true,trainingMode:'harmony'});
  await ready(client);await nextStage(client,'pass_star','intercept');
  await ready(client);send(client,'input',{action:'place_orb'});
  await waitFor(()=>client.messages.some(m=>m.type==='state'&&m.training?.status==='retrying'));
  await waitFor(()=>client.state.training.status==='ready'&&client.state.training.attempts===1);
  assert.equal(client.state.training.stage,'intercept');assert.equal(client.state.training.completed,1);
  assert.equal(client.state.training.failureReason,'self_bubble');
  assert.equal(me(client).passes,1);assert.equal(me(client).bombsPlaced,1);assert.equal(me(client).deliveries,0);
  assert.equal(client.state.relay.charges.total,1);assert.equal(client.state.relay.scores.blue,0);
  await ready(client);assert.equal(client.state.training.failureReason,null);
  await nextStage(client,'pass_star','charge_rescue');
  await ready(client);
  await waitFor(()=>client.state.training.status==='ready'&&client.state.training.attempts===2);
  assert.equal(client.state.training.stage,'charge_rescue');assert.equal(client.state.training.completed,2);
  assert.equal(client.state.training.failureReason,'target_eliminated');
  assert.equal(target(client).bubbleTicks,100);assert.equal(me(client).rescues,0);assert.equal(client.state.relay.charges.total,0);
});

test('harmony pauses while reading, expires after its active budget, and releases its private room',async t=>{
  const {join}=await setup(t,{}, {tickMs:1});const harmony=await join({practice:true,training:true,trainingMode:'harmony'});
  const classic=await join({practice:true,training:true});const practice=await join({practice:true,ruleSet:'harmony'});
  assert.equal(classic.state.training.mode,'classic');assert.equal(classic.state.training.stage,'escape');assert.equal(classic.state.mapId,'garden');
  assert.equal(practice.state.training,null);
  send(practice,'training_ready',{roomId:harmony.state.roomId,playerId:harmony.playerId});
  await waitFor(()=>harmony.state.tick>1800);
  assert.equal(harmony.state.phase,'playing');assert.equal(harmony.state.remaining,1800);
  assert.equal(classic.state.phase,'playing');assert.equal(classic.state.remaining,1800);
  await ready(harmony);
  await waitFor(()=>harmony.state.phase==='finished');
  assert.ok(harmony.state.tick>3600);assert.equal(harmony.state.remainingSeconds,0);assert.equal(harmony.state.training.completed,0);assert.equal(harmony.state.result.reason,'training_timeout');
  assert.equal(harmony.state.resultSaving.status,'unranked');
  await close(harmony); const replay=await join({practice:true,training:true,trainingMode:'harmony'});
  assert.equal(replay.state.training.completed,0);assert.equal(replay.state.training.status,'ready');assert.notEqual(replay.state.roomId,harmony.state.roomId);
});
