import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, provider, waitFor, send, close } from './fixtures/relay-server.mjs';

test('harmony and orb appearance reject malformed selection before remote authentication', async t => {
  const auth=await provider(t);
  const {connect,sendJoin}=await setup(t,{...auth.env,ALLOW_DEV_GUESTS:'false'});
  for(const orbSkinId of [null,{},[],false,'unknown']) {
    const c=await connect(); assert.equal((await sendJoin(c,{mode:'team',ruleSet:'harmony',orbSkinId,accessToken:'secret'})).code,'invalid_selection');
  }
  const c=await connect(); assert.equal((await sendJoin(c,{ruleSet:'harmony',mode:'duel'})).code,'invalid_rule_mode');
  assert.equal(auth.requests.length,0);
  const unauth=await connect(); assert.equal((await sendJoin(unauth,{mode:'team',ruleSet:'harmony'})).code,'unauthorized');
});
test('harmony publishes gates, validated orb skins, charge and counters; reconnect retains appearance', async t => {
  const {join,connect,sendJoin}=await setup(t);
  const a=await join({roomId:'harmony',mode:'team',ruleSet:'harmony',mapId:'harbor',orbSkinId:'duck',reconnect:true});
  assert.equal(a.state.relay.goal,7); assert.equal(a.state.ranked,false);
  assert.ok(a.state.solid.length); assert.equal(a.state.mapFeatures.type,'tidegates');
  assert.deepEqual(a.state.relay.charges,{passes:0,rescue:0,total:0});
  assert.equal(a.state.players[0].orbSkinId,'duck'); assert.equal(a.state.players[0].passes,0); assert.equal(a.state.players[0].interceptions,0);
  const b=await join({roomId:'harmony',mode:'team'}); assert.equal(b.state.ruleSet,'harmony');
  const mismatch=await connect(); assert.equal((await sendJoin(mismatch,{roomId:'harmony',mode:'team',ruleSet:'relay'})).code,'rule_set_mismatch');
  const joined=a.messages.find(m=>m.type==='joined'); await close(a);
  const resumed=await connect(); send(resumed,'resume',{roomId:joined.roomId,playerId:joined.playerId,resumeToken:joined.resumeToken});
  await waitFor(()=>resumed.state); assert.equal(resumed.state.players.find(p=>p.id===a.playerId).orbSkinId,'duck');
});
test('authenticated harmony result is unranked and rematch resets counters and objective',async t=>{
  const auth=await provider(t); const {join}=await setup(t,{...auth.env,ALLOW_DEV_GUESTS:'false'});
  const clients=[]; for(let i=0;i<8;i++)clients.push(await join({roomId:'harmony-result',mode:'team',ruleSet:'harmony',accessToken:`auth-${i}`,orbSkinId:'star'}));
  await waitFor(()=>clients[0].state.phase==='playing');
  send(clients[0],'input',{action:'place_orb'});
  await waitFor(()=>clients[0].state.orbs.length>0);
  assert.equal(clients[0].state.orbs[0].orbSkinId,'star');
  const pink=clients.filter(c=>c.state.players.find(p=>p.id===c.playerId).team==='pink');
  for(const c of pink)await close(c);
  await waitFor(()=>clients[0].state.phase==='finished');
  assert.equal(clients[0].state.resultSaving.status,'unranked');
  assert.equal(auth.requests.filter(r=>r.path==='/rest/v1/rpc/record_match').length,0);
  const blue=clients.filter(c=>!pink.includes(c)); for(const c of blue)send(c,'rematch');
  await waitFor(()=>clients[0].state.phase==='waiting');
  assert.equal(clients[0].state.round,1); assert.equal(clients[0].state.relay.goal,7);
  assert.deepEqual(clients[0].state.relay.charges,{passes:0,rescue:0,total:0});
  assert.ok(clients[0].state.players.every(p=>p.passes===0&&p.interceptions===0&&p.orbSkinId==='star'));
});

const directions = [['up',0,1],['right',1,0],['down',0,-1],['left',-1,0]];
async function walkTo(client, x, y) {
  for (let attempt=0; attempt<100; attempt++) {
    const state=client.state, p=state.players.find(p=>p.id===client.playerId);
    if(p.x===x&&p.y===y)return;
    const blocked=new Set([...state.solid,...state.soft,...state.orbs.map(o=>`${o.x},${o.y}`)]);
    const queue=[{x:p.x,y:p.y}], seen=new Set([`${p.x},${p.y}`]); let action;
    for(let head=0;head<queue.length&&!action;head++)for(const [move,dx,dy]of directions){
      const point={x:queue[head].x+dx,y:queue[head].y+dy,move:queue[head].move??move}, cell=`${point.x},${point.y}`;
      if(seen.has(cell)||blocked.has(cell)||point.x<1||point.x>11||point.y<1||point.y>9)continue;
      seen.add(cell);queue.push(point);if(point.x===x&&point.y===y){action=point.move;break;}
    }
    assert.ok(action,`reachable ${x},${y} from ${p.x},${p.y}`);
    send(client,'input',{action});
    await waitFor(()=>{const now=client.state.players.find(q=>q.id===client.playerId);return now.x!==p.x||now.y!==p.y;});
  }
  assert.fail('movement did not reach target');
}
async function passTo(client,target) {
  const tick=client.state.tick;
  send(client,'input',{action:'pass_star'});
  await waitFor(()=>client.state.tick>tick&&client.state.relay.carrierId===target.playerId);
}
test('real WS passes charge distinct allies, intercept, and drop on disconnect without accepting client authority fields',async t=>{
  const {join}=await setup(t,{}, {tickMs:10}); const clients=[];
  for(let i=0;i<8;i++)clients.push(await join({roomId:'pass-physics',mode:'team',ruleSet:'harmony',mapId:'festival',reconnect:true}));
  const [carrier,enemy,ally,,third]=clients;
  await walkTo(carrier,6,5); await waitFor(()=>carrier.state.relay.carrierId===carrier.playerId);
  await walkTo(ally,4,5); await walkTo(third,8,5); await walkTo(enemy,10,5);
  // Approach from below, then face right by moving one cell to 7,5.
  await walkTo(carrier,7,5); await passTo(carrier,third);
  assert.equal(carrier.state.relay.charges.passes,1);
  await walkTo(carrier,7,6);
  await walkTo(third,7,5); await waitFor(()=>third.state.relay.passCooldownTicks===0); await passTo(third,ally);
  assert.equal(third.state.relay.charges.passes,2);
  await walkTo(ally,5,5); await waitFor(()=>ally.state.relay.passCooldownTicks===0); await passTo(ally,third);
  assert.equal(ally.state.relay.charges.passes,2,'repeated receiver does not add more than cap');
  // Client cannot select a recipient, charge, team, or forge another player's pass.
  const before=carrier.state.tick;
  send(carrier,'input',{action:'pass_star',playerId:third.playerId,targetId:enemy.playerId,charges:99});
  await waitFor(()=>carrier.state.tick>before+2); assert.equal(carrier.state.relay.carrierId,third.playerId);
  await walkTo(third,8,5); await waitFor(()=>third.state.relay.passCooldownTicks===0); await passTo(third,enemy);
  assert.deepEqual(third.state.relay.charges,{passes:0,rescue:0,total:0});
  assert.equal(third.state.players.find(p=>p.id===enemy.playerId).interceptions,1);
  assert.ok(third.state.relay.passEffects.some(e=>e.interception));
  await close(enemy); await waitFor(()=>third.state.relay.carrierId===null);
  assert.deepEqual(third.state.relay.star,{x:10,y:5}); assert.equal(third.state.relay.charges.total,0);
});
