// Original score: an eight-bar C-major/pentatonic call-and-response melody.
// All instruments are synthesized locally; nothing is loaded or played on import.
const TEMPO = { lobby: 112, battle: 136, result: 104 };
const MELODY = [
  [[0, 72, .45], [.75, 76, .2], [1, 79, .5], [1.75, 76, .2], [2, 81, .6], [3, 79, .7]],
  [[0, 76, .5], [.75, 79, .2], [1.25, 81, .4], [2, 84, .6], [3, 81, .35], [3.5, 79, .3]],
  [[0, 81, .6], [1, 79, .35], [1.5, 76, .35], [2.25, 74, .35], [3, 76, .65]],
  [[0, 79, .4], [.75, 74, .2], [1.25, 76, .4], [2, 79, .4], [2.75, 74, .2], [3.25, 72, .5]],
  [[0, 76, .3], [.5, 79, .3], [1.25, 84, .55], [2, 81, .4], [2.75, 79, .2], [3.25, 76, .5]],
  [[0, 81, .45], [.75, 84, .25], [1.25, 86, .45], [2, 84, .6], [3, 79, .7]],
  [[0, 77, .4], [.75, 81, .2], [1.25, 79, .4], [2, 76, .4], [2.75, 74, .25], [3.25, 79, .5]],
  [[0, 76, .45], [.75, 74, .2], [1.25, 72, .55], [2.25, 79, .3], [3, 72, .8]]
];
const CHORDS = [[48, 60, 64, 67], [45, 57, 60, 64], [53, 60, 65, 69], [43, 59, 62, 67],
  [48, 60, 64, 67], [45, 57, 60, 64], [53, 60, 65, 69], [43, 59, 62, 67]];
const noiseBuffers = new WeakMap();
const sourceCleanup = new WeakMap();
const normalizeScene = scene => Object.hasOwn(TEMPO, scene) ? scene : 'lobby';
const frequency = note => 440 * 2 ** ((note - 69) / 12);
const safeStart = (context, when) => Math.max(context.currentTime, Number.isFinite(when) ? when : context.currentTime);

// Keep the score and event timing intact. Soft notes round off their attacks;
// percussion loses its highpass hiss, and the director also filters both buses.
function profileVoice(options, profile) {
  if (profile !== 'soft') return options;
  return {
    ...options, attack: Math.max(options.attack ?? .006, .032),
    ...(options.noise ? { highpass: false, cutoff: Math.min(options.cutoff ?? 2400, 1200), level: options.level * .65 } : {}),
  };
}

export function musicBarDuration(scene = 'lobby') { return 240 / TEMPO[normalizeScene(scene)]; }

function noiseBuffer(context) {
  let buffer = noiseBuffers.get(context);
  if (!buffer) {
    buffer = context.createBuffer(1, Math.ceil(context.sampleRate * .6), context.sampleRate);
    const samples = buffer.getChannelData(0);
    let seed = 0x23ab19;
    for (let index = 0; index < samples.length; index++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      samples[index] = (seed >>> 0) / 0x80000000 - 1;
    }
    noiseBuffers.set(context, buffer);
  }
  return buffer;
}

function stopSources(sources, when) {
  for (const source of [...sources]) {
    try { source.stop(when); } catch { /* A source can already have ended. */ }
    sourceCleanup.get(source)?.();
  }
  sources.clear?.();
}

function voice(context, destination, { when, duration, level, pitch = 440, endPitch, type = 'sine', noise = false, cutoff = 2400, highpass = false, attack = .006 }) {
  const nodes = [];
  let source;
  const cleanup = () => { for (const node of nodes) { try { node.disconnect(); } catch { /* Closed audio context. */ } } };
  try {
    source = noise ? context.createBufferSource() : context.createOscillator(); nodes.push(source);
    const envelope = context.createGain(); nodes.push(envelope);
    const end = when + duration;
    envelope.gain.setValueAtTime(0, when);
    envelope.gain.linearRampToValueAtTime(level, when + Math.min(attack, duration / 4));
    envelope.gain.exponentialRampToValueAtTime(.0001, end - .008);
    envelope.gain.linearRampToValueAtTime(0, end);
    if (noise) {
      source.buffer = noiseBuffer(context);
      const filter = context.createBiquadFilter(); nodes.push(filter);
      filter.type = highpass ? 'highpass' : 'lowpass';
      filter.frequency.setValueAtTime(cutoff, when); filter.Q.value = .6;
      source.connect(filter); filter.connect(envelope);
    } else {
      source.type = type; source.frequency.setValueAtTime(pitch, when);
      if (endPitch) source.frequency.exponentialRampToValueAtTime(endPitch, end);
      source.connect(envelope);
    }
    envelope.connect(destination);
    source.onended = cleanup; sourceCleanup.set(source, cleanup);
    source.start(when); source.stop(end + .005);
    return source;
  } catch (error) {
    if (source) { try { source.stop(); } catch { /* It may not have started. */ } }
    cleanup(); throw error;
  }
}

// Returned nodes include future notes, allowing callers to cancel the whole bar.
export function scheduleMusicBar(context, destination, when, barIndex = 0, scene = 'lobby', profile = 'bright') {
  scene = normalizeScene(scene);
  const start = safeStart(context, when), beat = 60 / TEMPO[scene];
  const bar = Number.isFinite(barIndex) ? ((Math.floor(barIndex) % 8) + 8) % 8 : 0;
  const sources = [], chord = CHORDS[bar];
  const add = options => sources.push(voice(context, destination, profileVoice(options, profile)));
  try {
    for (const [offset, note, length] of MELODY[bar]) {
      const when = start + offset * beat, duration = length * beat;
      add({ when, duration, pitch: frequency(note), type: 'triangle', level: .085 });
      // A soft octave makes the battle melody sparkle without a harsh square wave.
      if (scene === 'battle') add({ when, duration: duration * .65, pitch: frequency(note + 12), level: .016 });
    }
    const chordBeats = scene === 'result' ? [0, 2] : [.5, 2.5];
    for (const offset of chordBeats) for (const note of chord.slice(1)) {
      add({ when: start + offset * beat, duration: beat * (scene === 'result' ? 1.45 : .65),
        pitch: frequency(note), type: 'triangle', level: .017, attack: .018 });
    }
    for (const [offset, note] of [[0, chord[0]], [1.5, chord[0] + 7], [2, chord[0]], [3.5, chord[0] + 12]]) {
      add({ when: start + offset * beat, duration: beat * .38, pitch: frequency(note), level: .085 });
    }
    for (const offset of [0, 2]) add({ when: start + offset * beat, duration: .11, pitch: 135, endPitch: 48, level: .075 });
    for (const offset of [1, 3]) add({ when: start + offset * beat, duration: .09, noise: true, cutoff: 1900, level: .045 });
    const hatBeats = scene === 'battle' ? [0, .5, 1, 1.5, 2, 2.5, 3, 3.5] : [.5, 1.5, 2.5, 3.5];
    for (const offset of hatBeats) add({ when: start + offset * beat, duration: .045, noise: true,
      cutoff: Math.min(6500, context.sampleRate * .4), highpass: true, level: scene === 'result' ? .012 : .022 });
    return sources;
  } catch (error) { stopSources(sources, context.currentTime); throw error; }
}

export function scheduleEffect(context, destination, kind, when = context.currentTime, profile = 'bright') {
  const start = safeStart(context, when), sources = [];
  const add = options => sources.push(voice(context, destination, profileVoice({ when: start, ...options }, profile)));
  const arpeggio = (notes, step, level = .11, duration = .18) => {
    notes.forEach((note, index) => add({ when: start + index * step, duration, pitch: frequency(note), type: 'triangle', level }));
  };
  try {
    switch (kind) {
      case 'move': add({ duration: .045, pitch: 250, endPitch: 190, level: .028 }); break;
      case 'bomb':
        add({ duration: .13, pitch: 390, endPitch: 115, level: .16 });
        add({ when: start + .055, duration: .09, pitch: 650, endPitch: 240, level: .06 }); break;
      case 'wave':
        add({ duration: .32, noise: true, cutoff: 2400, level: .14, attack: .012 });
        add({ duration: .22, pitch: 180, endPitch: 48, level: .13 });
        add({ when: start + .07, duration: .14, pitch: 600, endPitch: 170, level: .055 }); break;
      case 'item': arpeggio([76, 79, 84], .075, .115); break;
      case 'rescue': arpeggio([67, 72, 76, 79, 84], .07, .12, .23); break;
      case 'victory':
        arpeggio([72, 76, 79, 84, 79, 84], .115, .11, .27);
        for (const note of [60, 64, 67]) add({ when: start + .58, duration: .52, pitch: frequency(note), level: .035 }); break;
      case 'defeat': arpeggio([72, 69, 65, 60], .14, .09, .3); break;
      case 'draw': arpeggio([72, 76, 74, 79], .12, .09, .22); break;
      case 'result': arpeggio([72, 76, 79, 72], .12, .09, .25); break;
      default: break;
    }
    return sources;
  } catch (error) { stopSources(sources, context.currentTime); throw error; }
}

export function createAudioDirector() {
  const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
  const state = { effectsEnabled: false, musicEnabled: false, effectsVolume: .6, musicVolume: .35, profile: 'bright', available: Boolean(Audio) };
  let context, effectsGain, musicGain, effectsFilter, musicFilter, resumePromise, timer;
  let disposed = false, hidden = false, scene = 'lobby', nextBar = 0, barIndex = 0;
  const musicSources = new Set(), effectsSources = new Set(), lastEffect = new Map();

  function track(sources, collection) {
    for (const source of sources) {
      const cleanup = source.onended;
      source.onended = () => { collection.delete(source); cleanup?.(); };
      collection.add(source);
    }
  }
  function gain(node, value) {
    if (!node || !context) return;
    node.gain.cancelScheduledValues(context.currentTime);
    node.gain.setValueAtTime(value, context.currentTime);
  }
  function clearMusic() {
    if (timer !== undefined) { globalThis.clearTimeout(timer); timer = undefined; }
    stopSources(musicSources, context?.currentTime || 0);
  }
  function closeContext() {
    if (!context) return;
    context.onstatechange = null;
    if (context.state === 'closed') return;
    try { Promise.resolve(context.close()).catch(() => {}); } catch { /* Browser teardown may already be closing. */ }
  }
  function fail() {
    state.available = state.effectsEnabled = state.musicEnabled = false;
    clearMusic(); stopSources(effectsSources, context?.currentTime || 0);
    try { gain(musicGain, 0); gain(effectsGain, 0); } catch { /* Broken context cannot play. */ }
    try { musicGain?.disconnect(); effectsGain?.disconnect(); musicFilter?.disconnect(); effectsFilter?.disconnect(); } catch { /* Already disconnected. */ }
    closeContext();
  }
  async function unlock() {
    try {
      if (!context) {
        context = new Audio();
        effectsGain = context.createGain(); musicGain = context.createGain();
        effectsGain.gain.value = musicGain.gain.value = 0;
        effectsFilter = context.createBiquadFilter(); musicFilter = context.createBiquadFilter();
        effectsFilter.connect(effectsGain); musicFilter.connect(musicGain);
        effectsGain.connect(context.destination); musicGain.connect(context.destination);
        context.onstatechange = () => {
          if (disposed || !state.available) return;
          if (context.state === 'running') reconcile();
          else {
            // OS/device interruptions may suspend a visible page. Drop queued
            // notes now and start a fresh phrase when the browser resumes audio.
            clearMusic(); stopSources(effectsSources, context.currentTime); lastEffect.clear();
            if (context.state === 'closed') fail();
          }
        };
      }
      if (context.state !== 'running') {
        if (!resumePromise) resumePromise = Promise.resolve(context.resume()).finally(() => { resumePromise = undefined; });
        await resumePromise;
      }
      if (disposed) return false;
      if (context.state !== 'running') throw new Error('Audio did not start');
      return true;
    } catch { if (!disposed) fail(); return false; }
  }
  function pump() {
    if (disposed || hidden || !state.musicEnabled || context?.state !== 'running') return;
    try {
      const now = context.currentTime;
      // Browser timer throttling must never replay all missed bars in one burst.
      if (nextBar < now) nextBar = now + .025;
      while (nextBar < now + .12) {
        track(scheduleMusicBar(context, musicFilter, nextBar, barIndex++, scene, state.profile), musicSources);
        nextBar += musicBarDuration(scene);
      }
      timer = globalThis.setTimeout(() => { timer = undefined; pump(); }, 25);
    } catch { fail(); }
  }
  function reconcile(startMusic = true) {
    if (!context || disposed) return;
    try {
      const soft = state.profile === 'soft';
      for (const [filter, cutoff] of [[effectsFilter, 1600], [musicFilter, 1800]]) {
        // Allpass preserves the bright profile's spectrum and avoids rewiring
        // active sources when a player changes their comfort preference.
        filter.type = soft ? 'lowpass' : 'allpass';
        filter.frequency.setValueAtTime(Math.min(soft ? cutoff : context.sampleRate * .45, context.sampleRate * .45), context.currentTime);
        filter.Q.value = .707;
      }
      gain(effectsGain, !hidden && state.effectsEnabled ? state.effectsVolume * (soft ? .6 : 1) : 0);
      gain(musicGain, !hidden && state.musicEnabled ? state.musicVolume * (soft ? .8 : 1) : 0);
      if (startMusic && !hidden && state.musicEnabled && timer === undefined) {
        nextBar = context.currentTime + .025; pump();
      }
    } catch { fail(); }
  }
  async function setEnabled(channel, enabled) {
    if (disposed || !state.available) return false;
    const key = `${channel}Enabled`; state[key] = Boolean(enabled);
    if (!state[key]) {
      if (channel === 'music') clearMusic();
      else { stopSources(effectsSources, context?.currentTime || 0); lastEffect.clear(); }
      reconcile(); return false;
    }
    if (await unlock()) reconcile();
    return state[key] && !disposed;
  }
  function setVolume(channel, value) {
    if (disposed || !Number.isFinite(value)) return;
    state[`${channel}Volume`] = Math.min(1, Math.max(0, value)); reconcile();
  }
  return {
    get state() { return { ...state }; },
    setEffectsEnabled: enabled => setEnabled('effects', enabled),
    setMusicEnabled: enabled => setEnabled('music', enabled),
    setEffectsVolume: value => setVolume('effects', value),
    setMusicVolume: value => setVolume('music', value),
    setProfile(profile) {
      if (disposed || (profile !== 'bright' && profile !== 'soft')) return false;
      state.profile = profile;
      // Selecting a profile is configuration, never a browser audio unlock.
      reconcile(false); return true;
    },
    playEffect(kind) {
      if (disposed || hidden || !state.effectsEnabled || context?.state !== 'running') return;
      const now = context.currentTime, interval = kind === 'wave' ? .12 : .045;
      if (now - (lastEffect.get(kind) ?? -Infinity) < interval || effectsSources.size >= 64) return;
      try {
        track(scheduleEffect(context, effectsFilter, kind, now, state.profile), effectsSources);
        lastEffect.set(kind, now);
      } catch { fail(); }
    },
    setScene(nextScene) {
      if (disposed || scene === normalizeScene(nextScene)) return;
      scene = normalizeScene(nextScene); barIndex = 0; clearMusic(); reconcile();
    },
    setHidden(value) {
      if (disposed || hidden === Boolean(value)) return;
      hidden = Boolean(value);
      if (hidden) {
        clearMusic(); stopSources(effectsSources, context?.currentTime || 0); lastEffect.clear(); reconcile();
      } else if (context && (state.effectsEnabled || state.musicEnabled)) {
        if (context.state === 'running') reconcile();
        else void unlock().then(ok => { if (ok) reconcile(); });
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true; state.effectsEnabled = state.musicEnabled = false;
      clearMusic(); stopSources(effectsSources, context?.currentTime || 0); lastEffect.clear();
      try { gain(effectsGain, 0); gain(musicGain, 0); effectsGain?.disconnect(); musicGain?.disconnect(); effectsFilter?.disconnect(); musicFilter?.disconnect(); } catch { /* Closing browser. */ }
      closeContext();
    }
  };
}
