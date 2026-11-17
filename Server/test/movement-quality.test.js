import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as quality from '../../scripts/movement-quality.mjs';
import {createMotionTimeline} from '../public/motion-timeline.js';

test('quality measurement detects gait reset at a tile boundary and exercises a real speed transition',()=>{
  assert.equal(typeof quality.measureMovement,'function');
  const real=quality.measureMovement();
  assert.equal(real.required.phaseContinuity,true);
  assert.equal(real.speedTransition,true);
  assert.equal(real.stopCount,10);
  const broken=quality.measureMovement(()=>{
    const timeline=createMotionTimeline();
    return {update(state,options){
      const frame=timeline.update(state,options);
      for(const p of frame.players.values()) if(p.moving)p.walkPhase%=Math.PI*2;
      return frame;
    }};
  });
  assert.equal(broken.required.phaseContinuity,false,'a known broken walking phase must fail the benchmark');
  assert.ok(broken.results.phase.passed<broken.results.phase.total);
});
