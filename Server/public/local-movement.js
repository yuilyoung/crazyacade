import { insideArena } from './arena-geometry.js';
const DELTA={up:[0,1],down:[0,-1],left:[-1,0],right:[1,0]};
const distance=(a,b)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
const same=(a,b)=>distance(a,b)<1e-6;
const cell=p=>({x:p.x,y:p.y});
const strideMs=view=>view.me.moveCooldownTicks===1?100:200;
const identity=v=>JSON.stringify([v.snapshot.roomId,v.snapshot.matchId,v.snapshot.round,v.snapshot.mapId,
  v.snapshot.training?.stage,v.snapshot.training?.attempts,v.playerId]);
const eligible=v=>v?.snapshot && v.me?.alive && !v.me.bubbleTicks && v.me.connected!==false && v.canInput && v.connection==='connected';
function clearTarget(v,to) {
  const name=`${to.x},${to.y}`,s=v.snapshot;
  return insideArena(s,to.x,to.y) && !(s.solid||[]).includes(name) && !(s.soft||[]).includes(name)
    && !(s.orbs||[]).some(o=>o.x===to.x && o.y===to.y);
}
// Remove retraced portions of a cardinal corridor but keep every turn.
function remainingPath(points) {
  const path=[];
  for(const point of points) {
    const corner=path.at(-1),prior=path.at(-2);
    if(corner && same(corner,point)) continue;
    if(prior && ((prior.x===corner.x && corner.x===point.x) || (prior.y===corner.y && corner.y===point.y))) path.pop();
    if(!path.length || !same(path.at(-1),point)) path.push(point);
  }
  return path;
}
function sample(move,now) {
  const age=Math.max(0,Math.min(move.duration,now-move.start)),progress=age/move.duration;
  let remaining=age,travelled=0;
  for(let i=1;i<move.points.length;i++) {
    const a=move.points[i-1],b=move.points[i],length=distance(a,b),duration=move.durations[i-1];
    if(length && remaining<duration) {
      const f=remaining/duration;
      return {x:a.x+(b.x-a.x)*f,y:a.y+(b.y-a.y)*f,progress,nextIndex:i,travelled:travelled+length*f,
        facing:b.x>a.x?'right':b.x<a.x?'left':b.y>a.y?'up':'down'};
    }
    remaining-=duration;travelled+=length;
  }
  return {...move.points.at(-1),progress,nextIndex:move.points.length,travelled:move.length,facing:move.facing};
}

/** Only the local avatar's drawing is anticipated. No snapshot or rule is modified.
 * One unconfirmed cardinal cell; all upgrades/hits/bombs stay server-authoritative. */
export function createLocalMovement() {
  let key=null,source=null,receivedAt=0,movedAt=-Infinity,observed=null,anchor=null,position=null,active=null,owned=false;
  let walked=0,lastFacing='down',blocked=null,queued=null,gaitStart=null;
  function reset() {key=source=observed=anchor=position=active=null;owned=false;walked=0;movedAt=-Infinity;blocked=queued=gaitStart=null;}
  function begin(points,now,duration,confirmed,to,durations=null) {
    const length=points.slice(1).reduce((n,p,i)=>n+distance(points[i],p),0);
    gaitStart??=now;
    active={points,length,start:now,duration,confirmed,confirmedAt:now,to,from:points[0],facing:lastFacing,walked,
      durations:durations || points.slice(1).map((p,i)=>length ? duration*distance(points[i],p)/length : duration/(points.length-1))};
  }
  function queue(action,repeat,now) {
    if(queued?.action!==action || (!repeat && queued.repeat)) queued={action,repeat,at:now};
  }
  function rollback(view,now,block=false) {
    if(!active || active.correcting) return;
    const current=sample(active,now),origin=cell(view.me);
    if(block) blocked=active.facing;
    walked=active.walked+current.travelled;
    // Return along the same cardinal segment; never cut across a turn's wall.
    const points=[cell(current),...active.points.slice(0,current.nextIndex).reverse()];
    if(!same(points.at(-1),active.from)) points.push(active.from);
    if(!same(points.at(-1),origin)) points.push(origin);
    if(points.slice(1).some((p,i)=>p.x!==points[i].x && p.y!==points[i].y)) {
      active=null;position=origin;owned=true;return;
    }
    const path=remainingPath(points);
    if(path.length===1) {position=origin;active=null;return;}
    begin(path,now,block?90:40,true,origin);active.correcting=true;
  }
  function sync(view,fallback,now) {
    const next=identity(view),fresh=source!==view.snapshot;
    if(key!==next) {reset();key=next;position=cell(fallback);}
    if(fresh) {
      const prior=observed;anchor=prior;source=view.snapshot;receivedAt=now;observed=cell(view.me);
      if(prior && !same(observed,prior)) {blocked=null;movedAt=now;}
      if(active && !active.correcting) {
        if(same(observed,active.to)) {
          if(!active.confirmed) active.confirmedAt=now;
          active.confirmed=true;
        }
        else if(!same(observed,active.from)) {
          // A different authoritative move supersedes a direction prediction.
          if(distance(observed,active.from)===1) rollback(view,now);
          else {active=null;position=cell(view.me);owned=true;walked=0;}
        } else if(!clearTarget(view,active.to)) rollback(view,now,true);
      } else if(owned && !active && prior && !same(prior,observed)) {
        if(distance(position,observed)<=1+1e-6) begin([position,observed],now,strideMs(view),true,observed);
        else position=observed;
      }
    }
  }
  function start(action,view,now,repeat) {
    if(!DELTA[action] || active || blocked===action || now-receivedAt>300) return false;
    const origin=cell(view.me),[dx,dy]=DELTA[action],to={x:origin.x+dx,y:origin.y+dy};
    // Finish an already confirmed visible segment before anticipating its next corner.
    if(!position || !same(position,origin) || !clearTarget(view,to)) return false;
    lastFacing=action;owned=true;
    begin([origin,to],now,strideMs(view),false,to);active.repeat=repeat;
    return true;
  }
  return {
    reset,
    press(action,view,now,phase) {
      if(!eligible(view) || !DELTA[action]) return false;
      if(key!==identity(view)) {reset();key=identity(view);position=cell(view.me);}
      sync(view,{...view.me},now);
      if(phase==='release') {
        if(queued?.repeat && queued.action===action) queued=null;
        if(active?.repeat && !active.confirmed && active.facing===action) rollback(view,now);
        if(blocked===action) blocked=null;
        return true;
      }
      const repeat=phase==='repeat';
      if(!repeat) blocked=null;
      if(active?.correcting) {
        queue(action,repeat,now);
        return true;
      }
      if(!active && position && !same(position,view.me)) {
        const origin=cell(view.me),target={x:origin.x+DELTA[action][0],y:origin.y+DELTA[action][1]};
        if(!clearTarget(view,target)) return false;
        const points=[position];
        if(anchor && !same(position,anchor)) points.push(anchor);
        if(!same(points.at(-1),origin)) points.push(origin);
        if(points.slice(1).some((p,i)=>p.x!==points[i].x && p.y!==points[i].y)) return false;
        owned=true;begin(remainingPath(points),now,50,true,origin);queue(action,repeat,now);return true;
      }
      if(active && (queued || active.confirmed) && action===active.facing) {
        // The newest input wins, even when it follows the current segment.
        queue(action,repeat,now);return true;
      }
      if(active && action!==active.facing) {
        const current=sample(active,now),origin=cell(view.me),[dx,dy]=DELTA[action],to={x:origin.x+dx,y:origin.y+dy};
        const [oldX,oldY]=DELTA[current.facing] || [0,0];
        walked=active.walked+current.travelled;
        const remaining=(to.x-current.x)*dx+(to.y-current.y)*dy;
        const onCorridor=dx ? current.y===to.y : current.x===to.x;
        if(dx===-oldX && dy===-oldY && onCorridor && remaining>0 && remaining<=1 && clearTarget(view,to)) {
          // Pace a partial reversal through the next legal server step. Arriving
          // early would leave the avatar stationary even while the key is held.
          const stride=strideMs(view),duration=Math.max(16,remaining*stride,movedAt+stride-now);
          lastFacing=action;
          begin([cell(current),to],now,duration,false,to);
          active.from=origin;active.repeat=repeat;position=cell(current);queued=null;
        } else if(active.confirmed) {
          const target=active.to,from=active.from;
          begin([cell(current),...active.points.slice(current.nextIndex)],now,Math.max(1,Math.min(50,(1-current.progress)*active.duration)),true,target);
          active.from=from;queue(action,repeat,now);
        } else if(clearTarget(view,to)) {
          // Replace a speculative direction: return to the confirmed corner first.
          const points=[cell(current),origin,to],base=strideMs(view);
          lastFacing=action;begin(points,now,40+base,false,to,[40,base]);active.from=origin;active.repeat=repeat;queued=null;
        } else {rollback(view,now);queued=null;}
        return true;
      }
      return start(action,view,now,repeat);
    },
    update(view,fallback,now,{direction=null,enabled=true,hidden=false}={}) {
      if(!enabled || hidden || !eligible(view)) {reset();return fallback;}
      sync(view,fallback,now);
      if(active && !active.confirmed && now-receivedAt>300) rollback(view,now,true);
      // Repeated fresh snapshots can reject a predicted move without a network gap.
      if(active && !active.confirmed && now-active.start>300) rollback(view,now,true);
      let nextStart=now,motion=active && sample(active,now);
      if(motion) {
        position=cell(motion);
        if(motion.progress===1 && active.confirmed) {
          nextStart=Math.max(active.start+active.duration,active.confirmedAt);
          walked=active.walked+active.length;lastFacing=motion.facing;
          active=null;motion=null;
          if(!same(position,view.me)) {
            const target=cell(view.me);
            if(position.x===target.x || position.y===target.y) {
              begin([position,target],now,90,true,target);active.correcting=true;
            } else {position=target;}
          }
        }
      }
      if(active && !motion) motion=sample(active,now);
      if(!direction && !active && now-receivedAt<=300) blocked=null;
      if(!active && (queued || direction)) {
        const next=queued ?? {action:direction,repeat:true,at:nextStart};
        queued=null;
        if(now-receivedAt<=300) start(next.action,view,Math.max(nextStart,next.at),next.repeat);
        motion=active&&sample(active,now);
        if(motion) position=cell(motion);
      }
      if(!active) gaitStart=null;
      if(!owned) {position=cell(fallback);return fallback;}
      if(!position) position=cell(view.me);
      const moving=Boolean(motion && motion.progress<1);
      const travelled=active?motion?.travelled||0:0;
      return {...fallback,...position,moving,facing:motion?.facing||lastFacing,
        walkPhase:(active?active.walked+travelled:walked)*Math.PI*2,
        walkWeight:moving?Math.min(1,(now-gaitStart)/40):0,predicted:Boolean(active&&!active.confirmed)};
    }
  };
}
