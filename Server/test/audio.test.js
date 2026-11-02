import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAudioDirector, scheduleMusicBar, scheduleEffect, musicBarDuration } from '../public/audio.js';

// Node has no Web Audio device. This boundary fake enforces AudioParam timing,
// tracks connected signal paths, and lets tests advance audio and wall clocks.
class Parameter {
  constructor(value = 0) { this.value = value; this.events = []; }
  event(kind, value, time) {
    assert.ok(Number.isFinite(value));
    assert.ok(Number.isFinite(time) && time >= 0);
    if (kind === 'exponential') assert.ok(value > 0);
    this.value = value; this.events.push({ kind, value, time }); return this;
  }
  setValueAtTime(value, time) { return this.event('set', value, time); }
  linearRampToValueAtTime(value, time) { return this.event('linear', value, time); }
  exponentialRampToValueAtTime(value, time) { return this.event('exponential', value, time); }
  cancelScheduledValues(time) { this.events = this.events.filter(event => event.time < time); return this; }
}
class AudioNode {
  constructor(context) { this.context = context; this.connections = []; context.nodes.push(this); }
  connect(node) { this.connections.push(node); return node; }
  disconnect() { this.connections = []; }
}
class Source extends AudioNode {
  constructor(context, kind) {
    super(context); this.kind = kind; this.frequency = new Parameter(440);
    this.playbackRate = new Parameter(1); this.stops = []; context.sources.push(this);
  }
  start(time = 0) { assert.ok(Number.isFinite(time) && time >= 0); this.startTime = time; }
  stop(time = 0) {
    assert.ok(Number.isFinite(time) && time >= 0);
    this.stops.push(time); this.stopTime = time;
    if (time <= this.context.currentTime) this.onended?.();
  }
}
class AudioContextFake {
  static instances = [];
  constructor() {
    this.state = 'suspended'; this.currentTime = 0; this.sampleRate = 8000;
    this.nodes = []; this.sources = []; this.destination = new AudioNode(this);
    AudioContextFake.instances.push(this);
  }
  createGain() { const node = new AudioNode(this); node.gain = new Parameter(1); return node; }
  createOscillator() { return new Source(this, 'oscillator'); }
  createBufferSource() { return new Source(this, 'noise'); }
  createBiquadFilter() { const node = new AudioNode(this); node.frequency = new Parameter(350); node.Q = new Parameter(1); return node; }
  createBuffer(channels, length, sampleRate) {
    assert.ok(Number.isInteger(length) && length > 0 && sampleRate > 0);
    const samples = Array.from({ length: channels }, () => new Float32Array(length));
    return { getChannelData: channel => samples[channel], duration: length / sampleRate };
  }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
  advance(time) {
    this.currentTime = time;
    for (const source of this.sources) if (!source.ended && source.stopTime <= time) {
      source.ended = true; source.onended?.();
    }
  }
}
function environment(t, Constructor = AudioContextFake) {
  AudioContextFake.instances = [];
  const originals = Object.fromEntries(['AudioContext', 'webkitAudioContext'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, writable: true, value: Constructor });
  Object.defineProperty(globalThis, 'webkitAudioContext', { configurable: true, writable: true, value: undefined });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { tick(time) {
    AudioContextFake.instances.at(-1)?.advance(time);
    t.mock.timers.tick(25);
  } };
}
function reaches(source, destination, visited = new Set()) {
  if (source === destination) return true;
  if (visited.has(source)) return false;
  visited.add(source);
  return source.connections.some(node => reaches(node, destination, visited));
}

test('audio stays silent and creates no context before explicit enable', t => {
  environment(t);
  const director = createAudioDirector();
  assert.equal(director.state.effectsEnabled, false);
  assert.equal(director.state.musicEnabled, false);
  assert.equal(director.state.available, true);
  director.setScene('battle'); director.playEffect('bomb'); director.setHidden(true); director.setHidden(false);
  director.setMusicVolume(.2); director.setEffectsVolume(.4);
  assert.equal(AudioContextFake.instances.length, 0);
  director.dispose();
});

test('music and effects have independent gains and muting cancels their future sources', async t => {
  const clock = environment(t); const director = createAudioDirector(); t.after(() => director.dispose());
  await director.setMusicEnabled(true);
  await director.setEffectsEnabled(true);
  const context = AudioContextFake.instances[0];
  const musicSources = [...context.sources];
  director.playEffect('rescue');
  const effectSources = context.sources.slice(musicSources.length);
  assert.ok(musicSources.length > 0 && effectSources.length > 0);
  const masters = context.nodes.filter(node => node.gain && node.connections.includes(context.destination));
  assert.equal(masters.length, 2);
  const musicMaster = masters.find(node => reaches(musicSources[0], node));
  const effectsMaster = masters.find(node => reaches(effectSources[0], node));
  assert.notEqual(musicMaster, effectsMaster);
  director.setMusicVolume(.19); director.setEffectsVolume(.73);
  assert.equal(musicMaster.gain.value, .19); assert.equal(effectsMaster.gain.value, .73);
  director.setMusicVolume(-1); director.setEffectsVolume(2);
  assert.equal(musicMaster.gain.value, 0); assert.equal(effectsMaster.gain.value, 1);
  director.setMusicVolume(Number.NaN); director.setEffectsVolume(Number.POSITIVE_INFINITY);
  assert.ok(Number.isFinite(musicMaster.gain.value) && Number.isFinite(effectsMaster.gain.value));
  await director.setMusicEnabled(false);
  assert.ok(musicSources.every(source => source.stopTime === 0));
  assert.ok(effectSources.every(source => source.stopTime > 0));
  assert.equal(effectsMaster.gain.value, 1);
  await director.setEffectsEnabled(false);
  assert.ok(effectSources.every(source => source.stopTime === 0));
  assert.equal(effectsMaster.gain.value, 0);
  const finalCount = context.sources.length; clock.tick(10);
  assert.equal(context.sources.length, finalCount);
});

test('hidden tabs cancel scheduled sound and resume only the enabled music channel', async t => {
  const clock = environment(t); const director = createAudioDirector(); t.after(() => director.dispose());
  await director.setMusicEnabled(true); await director.setEffectsEnabled(true);
  director.playEffect('wave'); const context = AudioContextFake.instances[0];
  const initialCount = context.sources.length;
  director.setHidden(true);
  assert.ok(context.sources.every(source => source.stopTime === 0));
  director.playEffect('item'); clock.tick(10);
  assert.equal(context.sources.length, initialCount);
  assert.equal(director.state.musicEnabled, true);
  director.setHidden(false); await Promise.resolve();
  assert.ok(context.sources.length > initialCount);
  assert.ok(context.sources.slice(initialCount).every(source => source.startTime >= 10));
  director.setHidden(true); await director.setMusicEnabled(false);
  const stoppedCount = context.sources.length;
  director.setHidden(false); await Promise.resolve(); clock.tick(11);
  assert.equal(context.sources.length, stoppedCount);
});

test('scene changes cancel the old phrase and long timer stalls do not schedule a backlog', async t => {
  const clock = environment(t); const director = createAudioDirector(); t.after(() => director.dispose());
  await director.setMusicEnabled(true); const context = AudioContextFake.instances[0];
  const lobbySources = [...context.sources]; director.setScene('battle');
  assert.ok(lobbySources.every(source => source.stopTime === 0));
  const oldCount = context.sources.length; clock.tick(50);
  const resumed = context.sources.slice(oldCount);
  assert.ok(resumed.length > 0 && resumed.length < 100);
  assert.ok(resumed.every(source => source.startTime >= 50));
  assert.ok(musicBarDuration('battle') < musicBarDuration('lobby'));
  assert.ok(musicBarDuration('result') > musicBarDuration('lobby'));
});

test('browser audio interruptions clear queued notes and resume enabled music without a backlog', async t => {
  const clock = environment(t); const director = createAudioDirector(); t.after(() => director.dispose());
  await director.setMusicEnabled(true); await director.setEffectsEnabled(true);
  director.playEffect('rescue');
  const context = AudioContextFake.instances[0], interruptedSources = [...context.sources];
  context.state = 'interrupted'; context.onstatechange?.(); clock.tick(.2);
  assert.ok(interruptedSources.every(source => source.stopTime === 0));
  context.currentTime = 8; context.state = 'running'; context.onstatechange?.();
  const resumed = context.sources.slice(interruptedSources.length);
  assert.ok(resumed.length > 0 && resumed.length < 100);
  assert.ok(resumed.every(source => source.startTime >= 8));
  await director.setMusicEnabled(false);
  const mutedCount = context.sources.length;
  context.state = 'suspended'; context.onstatechange?.();
  context.state = 'running'; context.onstatechange?.(); clock.tick(10);
  assert.equal(context.sources.length, mutedCount);
  director.dispose();
  assert.equal(context.onstatechange, null);
});

test('disposal during a pending browser unlock cannot start audio later', async t => {
  let resume;
  class DelayedContext extends AudioContextFake {
    resume() { return new Promise(resolve => { resume = () => { this.state = 'running'; resolve(); }; }); }
  }
  const clock = environment(t, DelayedContext); const director = createAudioDirector();
  const enabling = director.setMusicEnabled(true);
  director.dispose(); resume(); await enabling;
  assert.equal(director.state.musicEnabled, false);
  clock.tick(10);
  assert.equal(AudioContextFake.instances[0].sources.length, 0);
  await director.setEffectsEnabled(true);
  director.playEffect('bomb'); director.setHidden(false);
  assert.equal(AudioContextFake.instances.length, 1);
});

test('unsupported audio and rejected browser unlocks leave controls safely disabled', async t => {
  environment(t, undefined);
  // Explicitly remove the optional browser constructor (the helper has a default).
  globalThis.AudioContext = undefined;
  const unsupported = createAudioDirector();
  assert.equal(unsupported.state.available, false);
  await unsupported.setEffectsEnabled(true); await unsupported.setMusicEnabled(true);
  unsupported.playEffect('item'); unsupported.dispose();
  assert.equal(unsupported.state.effectsEnabled, false);
  class RejectedContext extends AudioContextFake { async resume() { throw new Error('denied'); } }
  globalThis.AudioContext = RejectedContext;
  const rejected = createAudioDirector();
  await rejected.setMusicEnabled(true);
  assert.equal(rejected.state.available, false);
  assert.equal(rejected.state.musicEnabled, false);
  rejected.dispose();
});

test('audio device construction or scheduling failure cannot escape into gameplay', async t => {
  const clock = environment(t, class { constructor() { throw new Error('device unavailable'); } });
  const noDevice = createAudioDirector();
  await noDevice.setEffectsEnabled(true);
  assert.equal(noDevice.state.available, false);
  noDevice.playEffect('item'); noDevice.dispose();
  globalThis.AudioContext = AudioContextFake;
  const director = createAudioDirector(); t.after(() => director.dispose());
  await director.setEffectsEnabled(true); await director.setMusicEnabled(true);
  const context = AudioContextFake.instances[0];
  context.createOscillator = () => { throw new Error('device disconnected'); };
  director.playEffect('bomb');
  assert.equal(director.state.available, false);
  assert.equal(director.state.effectsEnabled, false);
  assert.equal(director.state.musicEnabled, false);
  assert.ok(context.sources.every(source => source.stopTime === 0));
  const count = context.sources.length; clock.tick(10);
  assert.equal(context.sources.length, count);
});

test('eight music bars schedule connected finite notes, soft envelopes and varied phrases', () => {
  const phrases = [];
  for (const scene of ['lobby', 'battle', 'result']) {
    for (let bar = 0; bar < 8; bar++) {
      const context = new AudioContextFake(); const start = 3;
      const sources = scheduleMusicBar(context, context.destination, start, bar, scene);
      assert.ok(sources.length >= 10);
      assert.ok(sources.some(source => source.kind === 'noise'));
      assert.ok(sources.every(source => reaches(source, context.destination)));
      assert.ok(sources.every(source => source.startTime >= start && source.startTime < start + musicBarDuration(scene)));
      assert.ok(sources.every(source => source.stopTime > source.startTime && source.stopTime <= start + musicBarDuration(scene) + .5));
      for (const node of context.nodes.filter(node => node.gain)) {
        assert.ok(node.gain.events.every(event => event.value >= 0 && event.value <= .3));
      }
      if (scene === 'lobby') phrases.push(sources.filter(source => source.kind === 'oscillator').map(source => source.frequency.events.map(event => event.value)).flat().join(','));
      context.advance(10);
      assert.ok(sources.every(source => source.connections.length === 0));
    }
  }
  assert.ok(new Set(phrases).size >= 6);
});

test('effects are short, distinct, connected sounds and movement is quieter than rewards', () => {
  const signatures = new Set(); const peaks = {};
  for (const kind of ['move', 'bomb', 'wave', 'item', 'rescue', 'victory', 'defeat', 'draw']) {
    const context = new AudioContextFake(); const sources = scheduleEffect(context, context.destination, kind, 2);
    assert.ok(sources.length > 0);
    assert.ok(sources.every(source => reaches(source, context.destination)));
    assert.ok(sources.every(source => source.startTime >= 2 && source.stopTime <= 4));
    peaks[kind] = Math.max(...context.nodes.filter(node => node.gain).flatMap(node => node.gain.events.map(event => event.value)));
    signatures.add(sources.map(source => `${source.kind}:${source.frequency.events.map(event => event.value)}:${source.startTime}`).join('|'));
    context.advance(5); assert.ok(sources.every(source => source.connections.length === 0));
  }
  assert.equal(signatures.size, 8);
  assert.ok(peaks.move < peaks.item && peaks.move < peaks.rescue);
  const context = new AudioContextFake();
  assert.deepEqual(scheduleEffect(context, context.destination, 'unknown', 0), []);
  const firstNoise = scheduleEffect(context, context.destination, 'wave', 0).find(source => source.kind === 'noise').buffer.getChannelData(0);
  const otherContext = new AudioContextFake();
  const secondNoise = scheduleEffect(otherContext, otherContext.destination, 'wave', 0).find(source => source.kind === 'noise').buffer.getChannelData(0);
  assert.deepEqual(firstNoise, secondNoise);
  assert.ok(firstNoise.some(value => value !== 0));
});
