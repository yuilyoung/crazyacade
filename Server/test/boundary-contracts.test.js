import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createResultOutbox } from '../src/result-outbox.js';
import * as providerModule from '../src/supabase.js';
import { finalizeMatch, getLeaderboard } from '../src/rankings.js';

const snapshot = () => ({ id:'boundary', matchId:'c0000000-0000-4000-8000-000000000001', mode:'team',
  result:{winnerTeam:'blue'}, participants:[{userId:'verified-boundary',team:'blue',score:100}] });

test('outbox itself refuses AI and every unranked rule before disk or HTTP work', async t => {
  const directory = await mkdtemp(path.join(tmpdir(),'arena-policy-'));
  let requests = 0;
  const box = createResultOutbox({directory,persist:async()=>{requests++;}});
  t.after(async()=>{await box.close();await rm(directory,{recursive:true,force:true});});
  await box.start();
  for(const flags of [{withBots:true},{practice:true},{training:{stage:'escape'}},{ranked:false},
    {ruleSet:'relay'},{ruleSet:'harmony'},{ruleSet:'unknown'},{ruleSet:null}]) {
    await assert.rejects(box.enqueue({...snapshot(),...flags}),/ranked/i,JSON.stringify(flags));
  }
  assert.deepEqual((await readdir(directory)).filter(file => file !== '.writer.lock'),[]);
  assert.equal(requests,0);
});

test('direct payload and demo ranking entry points share the same unranked boundary', async()=>{
  for(const flags of [{withBots:true},{practice:true},{ruleSet:'harmony'},{ruleSet:'unknown'}]) {
    assert.throws(()=>providerModule.buildMatchPayload({...snapshot(),...flags}),/ranked/i);
    await finalizeMatch({...snapshot(),...flags,roster:[{userId:'excluded-demo',name:'ExcludedBoundary',team:'blue',score:999}]},{ALLOW_DEV_GUESTS:'true'});
  }
  assert.equal((await getLeaderboard({ALLOW_DEV_GUESTS:'true'})).entries.some(p=>p.name.startsWith('Excluded')),false);
  assert.equal(providerModule.buildMatchPayload(snapshot()).p_participants.length,1);
});

test('auth provider has independent injected configuration and sanitizes failures', async()=>{
  const calls = [];
  const auth = providerModule.createAuthProvider({env:{SUPABASE_URL:'https://configured.invalid/',SUPABASE_SERVICE_ROLE_KEY:'',SUPABASE_ANON_KEY:'private-placeholder'},
    fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({id:'alice',user_metadata:{}})};}});
  assert.equal((await auth.verifyAccessToken('client-token')).id,'alice');
  assert.equal(calls[0].url,'https://configured.invalid/auth/v1/user');
  assert.equal(calls[0].options.headers.apikey,'private-placeholder');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(await auth.verifyAccessToken(''),null);
  assert.equal(calls.length,1);
  const failed = providerModule.createAuthProvider({env:{SUPABASE_URL:'https://secret.invalid',SUPABASE_SERVICE_ROLE_KEY:'server-secret'},
    fetchImpl:async()=>{throw Error('leaked-client-token server-secret https://secret.invalid');}});
  await assert.rejects(failed.verifyAccessToken('client-token'),error=>/authentication.*unavailable/i.test(error.message)&&!/secret|client-token/.test(error.message));
  await assert.rejects(failed.upsertProfile({id:'alice'},'Alice'),error=>/profile.*unavailable/i.test(error.message)&&!/secret|client-token/.test(error.message));
});

test('auth and profile requests abort a real stalled provider within their injected bound', async t=>{
  const server = createServer(()=>{});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const aborted = [];
  const auth = providerModule.createAuthProvider({env:{SUPABASE_URL:`http://127.0.0.1:${server.address().port}`,SUPABASE_SERVICE_ROLE_KEY:'fixture'},timeoutMs:100,
    fetchImpl:async(url,options)=>{
      try { return await fetch(url,options); }
      catch(error) { aborted.push({aborted:options.signal.aborted,name:error.name}); throw error; }
    }});
  await assert.rejects(auth.verifyAccessToken('token'),/authentication.*unavailable/i);
  await assert.rejects(auth.upsertProfile({id:'alice'},'Alice'),/profile.*unavailable/i);
  // Under CPU pressure the deadline may expire before the socket sends HTTP.
  // Both operations must actually time out, rather than fail for an unrelated network error.
  assert.deepEqual(aborted,[{aborted:true,name:'TimeoutError'},{aborted:true,name:'TimeoutError'}]);
});

test('invalid token rejection differs from provider outage and malformed identity', async()=>{
  const env={SUPABASE_URL:'https://configured.invalid',SUPABASE_ANON_KEY:'fixture'};
  const denied=providerModule.createAuthProvider({env,fetchImpl:async()=>({ok:false,status:401})});
  assert.equal(await denied.verifyAccessToken('token'),null);
  const outage=providerModule.createAuthProvider({env,fetchImpl:async()=>({ok:false,status:503})});
  await assert.rejects(outage.verifyAccessToken('token'),/authentication.*unavailable/i);
  const malformed=providerModule.createAuthProvider({env,fetchImpl:async()=>({ok:true,json:async()=>({id:null})})});
  await assert.rejects(malformed.verifyAccessToken('token'),/authentication.*unavailable/i);
});
