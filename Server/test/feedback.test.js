import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventFeed } from '../public/feedback.js';

const player = (id = 'me', patch = {}) => ({ id, name: id === 'me' ? '나' : '<img src=x onerror=alert(1)>', team: 'blue',
  alive: true, bubbleTicks: 0, maxOrbs: 1, range: 3, speedLevel: 0, darts: 0, pin: false, itemsCollected: 0, rescues: 0, ...patch });
const state = (players, patch = {}) => ({ roomId: 'friend', matchId: 'match-1', round: 1, tick: 1, phase: 'playing', players, ...patch });
function update(feed, players, patch) { return feed.update(state(players, patch), players[0]); }

test('item upgrades produce a useful caption once, including capped pickups', () => {
  const feed = createEventFeed();
  assert.equal(update(feed, [player()]).latest, '');
  const upgraded = player('me', { itemsCollected: 1, range: 4 });
  let result = update(feed, [upgraded]);
  assert.match(result.latest, /물줄기|범위|파동/);
  assert.equal(result.entries.length, 1);
  assert.equal(update(feed, [upgraded]).latest, '');
  result = update(feed, [player('me', { itemsCollected: 2, range: 4 })]);
  assert.match(result.latest, /아이템/);
  assert.equal(result.entries.length, 2);
});

test('bubble entry, ally rescue and death are distinct deduplicated events', () => {
  const feed = createEventFeed();
  update(feed, [player(), player('ally')]);
  assert.match(update(feed, [player('me', { bubbleTicks: 20 }), player('ally', { bubbleTicks: 20 })]).latest, /버블|물 감옥/);
  const rescued = update(feed, [player(), player('ally')]);
  assert.match(rescued.latest, /구출/);
  assert.ok(rescued.entries.some(entry => entry.text.includes('<img src=x onerror=alert(1)>')));
  assert.match(update(feed, [player('me', { alive: false }), player('ally')]).latest, /탈락/);
  assert.equal(update(feed, [player('me', { alive: false }), player('ally')]).latest, '');
});

test('team deliveries and the final result remain visible without sound', () => {
  const feed = createEventFeed();
  const relay = { scores: { blue: 0, pink: 0 }, goal: 3 };
  update(feed, [player()], { relay });
  assert.match(update(feed, [player()], { relay: { ...relay, scores: { blue: 1, pink: 0 } } }).latest, /블루.*1/);
  assert.match(update(feed, [player()], { phase: 'finished', result: { winnerTeam: 'blue' } }).latest, /승리/);
  assert.equal(update(feed, [player()], { phase: 'finished', result: { winnerTeam: 'blue' } }).latest, '');
});

test('recovery baselines skip old events and new matches clear previous entries', () => {
  const feed = createEventFeed();
  update(feed, [player()]);
  update(feed, [player('me', { itemsCollected: 1, darts: 1 })]);
  const resumed = player('me', { itemsCollected: 4, darts: 3 });
  assert.equal(feed.update(state([resumed]), resumed, { baseline: true }).latest, '');
  assert.equal(update(feed, [resumed]).entries.length, 1);
  const newMatch = update(feed, [player()], { matchId: 'match-2', round: 2 });
  assert.deepEqual(newMatch.entries, []);
  assert.equal(newMatch.latest, '');
  const pinCaption = update(feed, [player('me', { itemsCollected: 1, pin: true })], { matchId: 'match-2', round: 2 }).latest;
  assert.match(pinCaption, /보호|방어/);
  assert.doesNotMatch(pinCaption, /탈출/);
  feed.reset();
  assert.deepEqual(update(feed, [player()]).entries, []);
});

test('duel opponents are not described as allies when neither player has a team', () => {
  const feed = createEventFeed(), me = player('me', { team: null });
  update(feed, [me, player('opponent', { team: null })]);
  assert.equal(update(feed, [me, player('opponent', { team: null, bubbleTicks: 20 })]).latest, '');
  assert.match(update(feed, [player('me', { team: null, bubbleTicks: 20 }), player('opponent', { team: null, bubbleTicks: 19 })]).latest, /물 감옥/);
});

test('the final delivery is retained before the result caption on the same tick', () => {
  const feed = createEventFeed();
  update(feed, [player()], { relay: { scores: { blue: 2, pink: 0 }, goal: 3 } });
  const result = update(feed, [player()], { phase: 'finished', relay: { scores: { blue: 3, pink: 0 }, goal: 3 }, result: { winnerTeam: 'blue' } });
  assert.ok(result.entries.some(entry => entry.type === 'delivery' && /3 \/ 3/.test(entry.text)));
  assert.equal(result.entries.at(-1).type, 'result');
  assert.match(result.latest, /승리/);
});

test('feed is bounded, returns defensive snapshots, and announces training completion', () => {
  const feed = createEventFeed(4);
  update(feed, [player()]);
  for (let count = 1; count <= 8; count++) update(feed, [player('me', { itemsCollected: count })]);
  const result = update(feed, [player('me', { itemsCollected: 8 })], { phase: 'finished', result: { reason: 'training_complete', winnerTeam: 'blue' } });
  assert.equal(result.entries.length, 4);
  assert.match(result.latest, /훈련.*완료/);
  result.entries[0].text = 'mutated';
  assert.ok(update(feed, [player('me', { itemsCollected: 8 })], { phase: 'finished' }).entries.every(entry => entry.text !== 'mutated'));
});

test('harmony captions describe successful passes, rescue charge and interception once', () => {
  const feed = createEventFeed();
  const relay = {carrierId:'me',scores:{blue:0,pink:0},goal:7,charges:{passes:0,rescue:0,total:0}};
  update(feed,[player(),player('ally')],{ruleSet:'harmony',relay});
  const passed=[player('me',{passes:1}),player('ally')];
  let result=update(feed,passed,{ruleSet:'harmony',relay:{...relay,carrierId:'ally',charges:{passes:1,rescue:0,total:1}}});
  assert.ok(result.entries.some(e=>e.type==='pass')); assert.match(result.latest,/2점/);
  assert.equal(update(feed,passed,{ruleSet:'harmony',relay:{...relay,carrierId:'ally',charges:{passes:1,rescue:0,total:1}}}).latest,'');
  result=update(feed,passed,{ruleSet:'harmony',relay:{...relay,carrierId:'ally',charges:{passes:1,rescue:1,total:2}}});
  assert.match(result.latest,/구출.*3점/);
  result=update(feed,[...passed,player('enemy',{team:'pink',interceptions:1})],{ruleSet:'harmony',relay:{...relay,carrierId:'enemy'}});
  assert.match(result.latest,/가로채기|초기화/);
});
const partyState=(progress,patch={})=>({tick:1,ruleSet:'classic',series:{id:'party-1',round:1,total:3,mission:{kind:'rescues',target:2,progress}},...patch});
test('actual party goal crossing announces each team once while preserving ordinary captions',()=>{
 const feed=createEventFeed();update(feed,[player()],partyState({blue:0,pink:0}));
 const completed=update(feed,[player('me',{rescues:2})],partyState({blue:2,pink:0},{tick:2}));
 assert.equal(completed.partyGoals.length,1);assert.match(completed.partyGoals[0],/블루.*구출 목표 달성.*보너스 \+1.*승리/);
 assert.equal(completed.announcement,'');
 assert.match(completed.partyGoalSummary,/블루.*구출 목표 달성.*\+1/);
 assert.doesNotMatch(completed.partyGoalSummary,/이제|승리|전달/);
 assert.ok(completed.entries.some(entry=>entry.type==='rescue'));
 assert.ok(completed.entries.some(entry=>entry.type==='party-goal'));
 assert.deepEqual(update(feed,[player('me',{rescues:2})],partyState({blue:2,pink:0},{tick:3})).partyGoals,[]);
 const enemy=update(feed,[player('me',{rescues:2})],partyState({blue:2,pink:2},{tick:4}));
 assert.equal(enemy.partyGoals.length,1);assert.match(enemy.partyGoals[0],/핑크/);
});
test('two simultaneous goals have one compact summary without repeating live instructions',()=>{
 const feed=createEventFeed();update(feed,[player()],partyState({blue:1,pink:1}));
 const result=update(feed,[player()],partyState({blue:2,pink:2},{tick:2}));
 assert.equal(result.partyGoals.length,2);assert.match(result.partyGoalSummary,/양 팀.*목표 달성.*\+1점씩/);
 assert.equal(result.announcement,'');
});
test('past completion and recovery baselines never replay goal bonuses',()=>{
 const feed=createEventFeed(),players=[player()];
 assert.deepEqual(update(feed,players,partyState({blue:2,pink:0})).partyGoals,[]);
 const ready=state(players,partyState({blue:2,pink:2},{tick:5}));
 assert.deepEqual(feed.update(ready,players[0],{baseline:true}).partyGoals,[]);
 assert.deepEqual(update(feed,players,partyState({blue:2,pink:2},{tick:6})).partyGoals,[]);
});
test('stale ticks, invalid future rounds and same-round rollback cannot manufacture another bonus',()=>{
 const feed=createEventFeed();update(feed,[player()],partyState({blue:1,pink:0},{tick:10}));
 assert.deepEqual(update(feed,[player()],partyState({blue:2,pink:0},{tick:9})).partyGoals,[]);
 const future=partyState({blue:2,pink:0},{tick:11});future.series.round=4;
 assert.deepEqual(update(feed,[player()],future).partyGoals,[]);
 assert.equal(update(feed,[player()],partyState({blue:2,pink:0},{tick:12})).partyGoals.length,1);
 update(feed,[player()],partyState({blue:0,pink:0},{tick:13}));
 assert.deepEqual(update(feed,[player()],partyState({blue:2,pink:0},{tick:14})).partyGoals,[]);
});
test('new round goal can be earned again without replaying old round packets',()=>{
 const feed=createEventFeed();update(feed,[player()],partyState({blue:0,pink:0}));
 update(feed,[player()],partyState({blue:2,pink:0},{tick:2}));
 feed.reset({preserveParty:true});
 const second=partyState({blue:0,pink:0},{matchId:'match-2',round:2,tick:1});second.series.round=2;
 update(feed,[player()],second);
 second.series.mission.progress.blue=2;second.tick=2;
 assert.equal(update(feed,[player()],second).partyGoals.length,1);
 assert.deepEqual(update(feed,[player()],partyState({blue:2,pink:2},{tick:50})).partyGoals,[]);
});
test('invalid mission targets and missing progress do not create goal events',()=>{
 const feed=createEventFeed();update(feed,[player()],partyState({blue:0,pink:0}));
 for(const mission of [{kind:'rescues',target:0,progress:{blue:99,pink:99}},{kind:'rescues',target:2,progress:{blue:3,pink:0}},{kind:'passes',target:3,progress:{blue:3}}]) {
  const s=partyState({blue:2,pink:2},{tick:2});s.series.mission=mission;assert.deepEqual(update(feed,[player()],s).partyGoals,[]);
 }
});
test('reading idle expiry is announced as a retryable training end',()=>{
 const feed=createEventFeed();update(feed,[player()],{training:{mode:'classic'}});
 assert.match(update(feed,[player()],{phase:'finished',training:{mode:'classic'},result:{reason:'training_idle_timeout'}}).latest,/준비 대기.*다시/);
});
test('a final-tick party goal keeps one goal announcement plus the separate result announcement',()=>{
 const feed=createEventFeed();update(feed,[player()],partyState({blue:1,pink:0}));
 const result=update(feed,[player()],partyState({blue:2,pink:0},{tick:2,phase:'finished',result:{winnerTeam:'blue'}}));
 assert.equal(result.partyGoals.length,1);assert.match(result.announcement,/대전 종료/);assert.doesNotMatch(result.announcement,/목표 달성/);
});
