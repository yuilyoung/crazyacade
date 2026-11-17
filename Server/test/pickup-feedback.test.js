import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as feedback from '../public/pickup-feedback.js';

test('pickup feedback describes actual capacity, blast range and tile speed including caps',()=>{
  assert.equal(feedback.pickupLabel('orb',{maxOrbs:5}),'폭탄 5/5');
  assert.equal(feedback.pickupLabel('wave',{range:4}),'물줄기 4/7');
  assert.equal(feedback.pickupLabel('dash',{moveCooldownTicks:1}),'속도 10칸/초');
  assert.equal(feedback.pickupLabel('dash',{moveCooldownTicks:2}),'속도 5칸/초');
  assert.equal(feedback.pickupLabel('orb',{}),'폭탄 +');
  assert.equal(feedback.pickupLabel('unknown',{}),'획득');
});
