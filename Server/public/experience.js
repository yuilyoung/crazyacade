import { createAudioDirector } from './audio.js';

// Local presentation preferences and guidance; game progress comes from server snapshots.
export function createExperience($) {
  const motionKey = 'popPop:reducedMotion';
  let motionOverride = null;
  try {
    const saved = localStorage.getItem(motionKey);
    if (saved === 'true' || saved === 'false') motionOverride = saved === 'true';
  } catch { /* Preferences still work for this visit when storage is denied. */ }
  const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let reducedMotion = motionOverride ?? media?.matches ?? false;
  function renderMotion() {
    document.body.dataset.reducedMotion = String(reducedMotion);
    $('motion-toggle').setAttribute('aria-pressed', String(reducedMotion));
    $('motion-toggle').textContent = `모션 줄이기 ${reducedMotion ? '켜짐' : '꺼짐'}`;
  }
  renderMotion();
  media?.addEventListener?.('change', event => {
    if (motionOverride === null) { reducedMotion = event.matches; renderMotion(); }
  });
  $('motion-toggle').addEventListener('click', () => {
    motionOverride = reducedMotion = !reducedMotion;
    try { localStorage.setItem(motionKey, String(reducedMotion)); } catch { /* Keep in memory. */ }
    renderMotion();
  });

  let audio = createAudioDirector(), audioScene = 'lobby';
  function renderSound() {
    const { effectsEnabled, musicEnabled, effectsVolume, musicVolume, available } = audio.state;
    for (const [id, label, enabled] of [['sound-toggle', '효과음', effectsEnabled], ['music-toggle', '배경음악', musicEnabled]]) {
      $(id).setAttribute('aria-pressed', String(enabled));
      $(id).textContent = available ? `${label} ${enabled ? '켜짐' : '꺼짐'}` : `${label} 사용 불가`;
      $(id).disabled = !available;
    }
    for (const [id, volume] of [['effects-volume', effectsVolume], ['music-volume', musicVolume]]) {
      const percent = String(Math.round(volume * 100));
      $(id).value = percent; $(id).setAttribute('aria-valuetext', `${percent}%`); $(id).disabled = !available;
      $(`${id}-value`).textContent = `${percent}%`;
    }
    const note = available ? '소리 없이도 화면 안내로 플레이할 수 있어요.' : '소리를 사용할 수 없어요. 화면 안내를 따라주세요.';
    if ($('audio-note').textContent !== note) $('audio-note').textContent = note;
  }
  for (const [id, stateKey, method] of [['sound-toggle', 'effectsEnabled', 'setEffectsEnabled'], ['music-toggle', 'musicEnabled', 'setMusicEnabled']]) {
    $(id).addEventListener('click', async () => {
      const enable = !audio.state[stateKey], pending = audio[method](enable);
      renderSound();
      await pending;
      if (id === 'sound-toggle' && enable && audio.state.effectsEnabled) audio.playEffect('item');
      renderSound();
    });
  }
  for (const [id, method] of [['effects-volume', 'setEffectsVolume'], ['music-volume', 'setMusicVolume']]) {
    $(id).addEventListener('input', () => { audio[method](Number($(id).value) / 100); renderSound(); });
  }
  $('volume-toggle').addEventListener('click', () => {
    const expanded = $('volume-toggle').getAttribute('aria-expanded') !== 'true';
    $('volume-toggle').setAttribute('aria-expanded', String(expanded));
    $('volume-panel').hidden = !expanded;
  });
  audio.setHidden(document.hidden); renderSound();
  document.addEventListener('visibilitychange', () => { audio.setHidden(document.hidden); renderSound(); });
  window.addEventListener('pagehide', () => { audio.dispose(); renderSound(); });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    const { effectsVolume, musicVolume } = audio.state;
    audio = createAudioDirector();
    audio.setEffectsVolume(effectsVolume); audio.setMusicVolume(musicVolume);
    audio.setScene(audioScene); audio.setHidden(document.hidden); renderSound();
  });
  function cue(type) {
    audio.playEffect(type);
    if (!audio.state.available) renderSound();
  }
  function setScene(scene) {
    audioScene = scene;
    audio.setScene(scene);
    if (!audio.state.available) renderSound();
  }

  const steps = Object.fromEntries(['move', 'bomb', 'item', 'delivery'].map(key => [key, document.querySelector(`[data-step="${key}"]`)]));
  let startCell = null, completed = {}, previous = null;
  function renderTutorial(itemMode, ruleSet = 'classic') {
    const labels = {
      move: '이동 · 방향키 / WASD 또는 방향 버튼',
      bomb: '물폭탄 · SPACE / POP 후 안전한 길로 이동',
      item: itemMode ? '아이템 · 상자를 깨고 나온 아이템 위로 이동' : '아이템 · 기본전에서는 생략해요',
      delivery: '별 전달 · 중앙 별을 우리 팀 B / P 기지로! 먼저 3번 전달하면 승리해요.'
    };
    for (const [key, step] of Object.entries(steps)) {
      const optional = key === 'delivery' || key === 'item' && !itemMode;
      if (key === 'delivery') step.hidden = ruleSet !== 'relay';
      step.dataset.complete = String(Boolean(completed[key])); step.dataset.optional = String(optional);
      const label = `${completed[key] ? '완료' : optional ? '선택' : '대기'}: ${labels[key]}`;
      if (step.textContent !== label) step.textContent = label;
    }
    const complete = completed.move && completed.bomb && (completed.item || !itemMode);
    const summary = complete ? '기본 조작 완료! 버블 아군에게 다가가 팀을 구해 보세요.' : '직접 해보며 익혀요 · 성공한 행동에 완료 표시가 생겨요.';
    if ($('tutorial-summary').textContent !== summary) $('tutorial-summary').textContent = summary;
  }
  function reset(itemMode = true, ruleSet = 'classic') {
    startCell = null; completed = {}; previous = null; renderTutorial(itemMode, ruleSet);
    $('rescue-alert').hidden = true; setScene('lobby');
  }
  $('tutorial-toggle').addEventListener('click', () => {
    const expanded = $('tutorial-toggle').getAttribute('aria-expanded') !== 'true';
    $('tutorial-toggle').setAttribute('aria-expanded', String(expanded));
    $('tutorial-toggle').textContent = expanded ? '안내 접기' : '안내 다시 보기';
    $('tutorial-steps').hidden = !expanded;
  });
  function update(state, me) {
    setScene(state.phase === 'playing' ? 'battle' : state.phase === 'finished' ? 'result' : 'lobby');
    if (!me) return;
    if (state.phase === 'playing') startCell ??= `${me.x},${me.y}`;
    if (startCell !== null && (state.phase === 'playing' || state.phase === 'finished')) {
      completed.move ||= `${me.x},${me.y}` !== startCell;
      completed.bomb ||= me.bombsPlaced > 0;
      completed.item ||= me.itemsCollected > 0;
      completed.delivery ||= me.deliveries > 0;
    }
    renderTutorial(state.itemMode !== false, state.ruleSet);
    const waves = new Map((state.waves || []).map(wave => [`${wave.x},${wave.y}`, wave.ttl]));
    const snapshot = { phase: state.phase, x: me.x, y: me.y, bombs: me.bombsPlaced || 0, items: me.itemsCollected || 0,
      rescues: (state.players || []).reduce((sum, player) => sum + (player.rescues || 0), 0), deliveries: me.deliveries || 0, carrier: state.relay?.carrierId, waves };
    if (previous) {
      if (snapshot.phase === 'finished' && previous.phase !== 'finished') {
        const outcome = state.result?.draw ? 'draw' : state.result?.winnerTeam && me.team ? (state.result.winnerTeam === me.team ? 'victory' : 'defeat') : 'result';
        cue(outcome);
      }
      else if (snapshot.phase === 'playing') {
        if (snapshot.x !== previous.x || snapshot.y !== previous.y) cue('move');
        if (snapshot.bombs > previous.bombs) cue('bomb');
        if (snapshot.items > previous.items) cue('item');
        if (snapshot.rescues > previous.rescues) cue('rescue');
        if (snapshot.deliveries > previous.deliveries) cue('rescue');
        else if (snapshot.carrier === me.id && previous.carrier !== me.id) cue('item');
        if ([...waves].some(([cell, ttl]) => !previous.waves.has(cell) || ttl > previous.waves.get(cell))) cue('wave');
      }
    }
    previous = snapshot;
  }
  return { reset, update, get reducedMotion() { return reducedMotion; } };
}
