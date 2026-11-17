/** Fixed movement rubric. Synthetic path measurement and actual browser evidence stay distinct. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createMotionTimeline} from '../Server/public/motion-timeline.js';
import {createLayout} from '../Server/public/map-catalog.js';
const TAU=Math.PI*2;
const fraction=(metric)=>metric.total?metric.passed/metric.total:0;

export function measureMovement(factory=createMotionTimeline) {
  const results=Object.fromEntries(['continuity','phase','speed','body'].map(k=>[k,{passed:0,total:0}]));
  const required={confirmedPath:true,noWallCrossing:true,reducedMotion:true,phaseContinuity:true};
  let stopCount=0,speedTransition=false;
  const record=(kind,pass)=>{results[kind].total++;results[kind].passed+=Boolean(pass);};
  const layout=createLayout('garden','team'),route=[[1,1]];
  for(const [dx,dy,count] of [[1,0,12],[0,1,10],[-1,0,12],[0,-1,10]]) for(let i=0;i<count;i++) {
    const [x,y]=route.at(-1);route.push([x+dx,y+dy]);
  }
  for(const scenario of ['turns','ten-stops','speed-pickup','receive-gap']) {
    const timeline=factory(),events=[];let index=0,nextMove=1,cooldown=2,endAt=null;
    const make=tick=>({roomId:'quality',matchId:scenario,round:1,mapId:'garden',mode:'team',phase:'playing',tick,
      players:[{id:'p',x:route[index][0],y:route[index][1],alive:true,bubbleTicks:0,speedLevel:cooldown===1?1:0,moveCooldownTicks:cooldown}],
      solid:[...layout.solid],soft:[],items:[],orbs:[],waves:[]});
    for(let tick=0;tick<200;tick++) {
      if(tick>=nextMove && index<route.length-1) {
        index++;
        if(scenario==='speed-pickup' && index===22) {cooldown=1;speedTransition=true;}
        nextMove=tick+cooldown;
        if(scenario==='ten-stops' && index<=40 && index%4===0) {nextMove+=3;stopCount++;}
      }
      // A 400ms interval between received snapshots exercises the >=300ms stale boundary.
      if(!(scenario==='receive-gap' && tick>=30 && tick<=32)) events.push({time:tick*100,state:make(tick)});
      if(index===route.length-1) {endAt ??= tick+5;if(tick>=endAt)break;}
    }
    let eventIndex=0,state=events[0].state,last=null,lastTime=null,lastStale=false,lastCooldown=2;
    const end=events.at(-1).time;
    for(let frame=0;frame<=Math.round(end*60/1000);frame++) {
      const now=frame*100/6;let boundary=false;
      while(eventIndex+1<events.length && events[eventIndex+1].time<=now+1e-6) {
        const before=timeline.update(state,{now}).players.get('p');
        const next=events[++eventIndex];boundary=next.time-events[eventIndex-1].time>300;
        state=next.state;
        const after=timeline.update(state,{now}).players.get('p');
        if(!boundary) {
          record('continuity',Math.hypot(after.x-before.x,after.y-before.y)<=.01);
          const valid=after.walkPhase+1e-8>=before.walkPhase;
          record('phase',valid);required.phaseContinuity&&=valid;
        }
      }
      const pose=timeline.update(state,{now}).players.get('p');
      const outerPath=(Math.abs(pose.x-1)<1e-6 || Math.abs(pose.x-13)<1e-6 || Math.abs(pose.y-1)<1e-6 || Math.abs(pose.y-11)<1e-6)
        && pose.x>=1 && pose.x<=13 && pose.y>=1 && pose.y<=11;
      required.confirmedPath&&=outerPath;
      required.noWallCrossing&&=!layout.solid.has(`${Math.round(pose.x)},${Math.round(pose.y)}`);
      const stale=now-events[eventIndex].time>300;
      if(last && !boundary && !stale && !lastStale) {
        const body=p=>Math.sin(p.walkPhase)*p.walkWeight*3.5/60;
        record('body',Math.abs(body(pose)-body(last))<=.1);
        const valid=pose.walkPhase+1e-8>=last.walkPhase;
        record('phase',valid);required.phaseContinuity&&=valid;
        if(last.moving && pose.moving) {
          const observed=Math.hypot(pose.x-last.x,pose.y-last.y)/(now-lastTime);
          const expected=1/(lastCooldown*100);
          // A server-confirmed item transition changes cadence at the next received step.
          record('speed',Math.abs(observed/expected-1)<=.1);
        }
      }
      last=pose;lastTime=now;lastStale=stale;lastCooldown=state.players[0].moveCooldownTicks;
    }
    const calm=timeline.update(state,{now:end+16,reducedMotion:true}).players.get('p');
    required.reducedMotion&&=calm.x===state.players[0].x && calm.y===state.players[0].y && !calm.moving;
  }
  const weights={continuity:25,phase:20,speed:20,body:15};
  return {method:'2026-11-17 fixed movement rubric with cell boundaries, idle snapshots and within-run speed pickup; automated engineering measurement, not human motion quality',
    scenarios:['straight/four turns','10 starts/stops with live idle snapshots','within-run speed pickup','300ms receive gap'],
    results,required,stopCount,speedTransition,scores:Object.fromEntries(Object.entries(weights).map(([k,w])=>[k,w*fraction(results[k])]))};
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const report=measureMovement();
  report.browser=null;report.total=null;
  if(process.argv[2]) {
    report.browser=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    assert.ok(report.browser.intervals.length>200 && report.browser.durationMs>=9900,'Need a fresh 10-second actual browser sample');
    report.scores.frames=20*report.browser.intervals.filter(ms=>ms<=25).length/report.browser.intervals.length;
    report.total=Object.values(report.scores).reduce((a,b)=>a+b,0);
  }
  console.log(JSON.stringify(report,null,2));
  assert.ok(Object.values(report.required).every(Boolean),'Required movement invariants failed');
  if(report.browser)assert.ok(report.total>=90,`Movement score ${report.total} is below 90`);
}
