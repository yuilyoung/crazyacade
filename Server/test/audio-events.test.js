import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as audio from '../public/audio-events.js';
const state=(extra={})=>({match:'room:match:1:stage0',phase:'playing',alive:true,bubbleTicks:0,wallHits:0,x:1,y:1,...extra});
test('audio uses confirmed capture escape and collision transitions only',()=>{
  assert.deepEqual(audio.combatSounds(state(),state({bubbleTicks:20})),['capture']);
  assert.deepEqual(audio.combatSounds(state({bubbleTicks:10}),state()),['escape']);
  assert.deepEqual(audio.combatSounds(state({bubbleTicks:1}),state({alive:false})),[]);
  assert.deepEqual(audio.combatSounds(state(),state({wallHits:1})),['wall']);
  assert.deepEqual(audio.combatSounds(state({wallHits:1}),state({wallHits:1})),[]);
  assert.deepEqual(audio.combatSounds(state(),state({match:'new-match',wallHits:10,bubbleTicks:20})),[]);
  assert.deepEqual(audio.combatSounds(null,state({bubbleTicks:20})),[]);
});
