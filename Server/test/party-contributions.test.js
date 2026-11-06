import test from 'node:test';
import assert from 'node:assert/strict';
import { ownPartyContributions } from '../public/party-contributions.js';
const contribution=(playerId,patch={})=>({playerId,name:'Private name',team:'blue',score:100,bombsPlaced:2,itemsCollected:1,rescues:2,passes:3,interceptions:0,deliveries:4,...patch});
const party=()=>({complete:true,round:3,total:3,contributions:[contribution('mine',{score:300,rescues:4,deliveries:8}),contribution('other',{score:9999})],history:[{round:1,mapId:'garden',contributions:[contribution('mine')]},{round:2,mapId:'harbor',contributions:[contribution('mine')]},{round:3,mapId:'festival',contributions:[contribution('mine',{rescues:0,deliveries:0})]}]});
test('final party personal view uses only the owned server aggregate and per-round records',()=>{
 const s=party(),view=ownPartyContributions(s,'mine');
 assert.equal(view.totals.score,300);assert.equal(view.totals.rescues,4);assert.equal(view.totals.deliveries,8);
 assert.deepEqual(view.rounds.map(round=>round.totals.rescues),[2,2,0]);
 assert.doesNotMatch(JSON.stringify(view),/mine|other|Private|9999/);
 s.contributions[0].score=900;assert.equal(view.totals.score,300);assert.ok(Object.isFrozen(view.totals));
});
test('missing, duplicated or unfinished own aggregates cannot masquerade as complete totals',()=>{
 const s=party();assert.equal(ownPartyContributions({...s,complete:false},'mine'),null);
 assert.equal(ownPartyContributions({...s,contributions:[]},'mine'),null);
 assert.equal(ownPartyContributions({...s,contributions:[s.contributions[0],s.contributions[0]]},'mine'),null);
 assert.equal(ownPartyContributions({...s,round:4},'mine'),null);
 s.contributions[0].rescues=NaN;assert.equal(ownPartyContributions(s,'mine'),null);
});
test('a missing round stays unknown and future rounds cannot leak into a three-round personal history',()=>{
 const s=party();s.history[1].contributions=[];s.history.push({round:4,mapId:'candy',contributions:[contribution('mine')]});
 const view=ownPartyContributions(s,'mine');assert.equal(view.rounds.length,3);assert.equal(view.rounds[1].totals,null);
});
test('party sums and round counters obey the server caps instead of displaying unbounded numbers',()=>{
 const s=party();s.contributions[0].score=3000000;s.history[0].contributions[0].score=1000000;
 assert.equal(ownPartyContributions(s,'mine').totals.score,3000000);
 s.history[0].contributions[0].score=1000001;assert.equal(ownPartyContributions(s,'mine').rounds[0].totals,null);
 s.contributions[0].score=3000001;assert.equal(ownPartyContributions(s,'mine'),null);
});
