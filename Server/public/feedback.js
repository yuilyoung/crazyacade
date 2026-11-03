const teamName = team => team === 'blue' ? '블루 B' : '핑크 P';
const count = value => Number.isFinite(value) ? value : 0;

function snapshot(state, me) {
  return {
    match: `${state.roomId ?? ''}:${state.matchId ?? ''}:${state.round ?? 0}`,
    phase: state.phase, me: me ? { ...me } : null, trainingStage: state.training?.stage,
    players: new Map((state.players ?? []).map(player => [player.id, { ...player }])),
    scores: { blue: count(state.relay?.scores?.blue), pink: count(state.relay?.scores?.pink) }
  };
}

function itemCaption(before, me) {
  const upgrades = [];
  if (me.maxOrbs > before.maxOrbs) upgrades.push(`물폭탄 ${me.maxOrbs}개`);
  if (me.range > before.range) upgrades.push(`물줄기 범위 ${me.range}칸`);
  if (me.speedLevel > before.speedLevel) upgrades.push('이동 속도 증가');
  if (me.darts > before.darts) upgrades.push(`다트 ${me.darts}개`);
  if (me.pin && !before.pin) upgrades.push('보호 핀 획득');
  return `아이템 습득${upgrades.length ? ` · ${upgrades.join(' / ')}` : ''}`;
}

function resultCaption(result, me) {
  if (result?.reason === 'training_complete') return '4단계 훈련 완료! 친구와 대전할 준비가 되었어요.';
  if (result?.reason === 'training_timeout') return '훈련 시간 종료 · 다시 도전할 수 있어요.';
  if (result?.draw) return '대전 종료 · 무승부';
  if (result?.winnerTeam) return `대전 종료 · ${teamName(result.winnerTeam)} 팀 승리${me?.team ? result.winnerTeam === me.team ? '! 우리 팀 승리!' : ' · 다음 경기에 다시 도전해요.' : ''}`;
  return '대전 종료 · 결과를 확인해 주세요.';
}

// Captions use authoritative snapshot transitions; callers render textContent, never HTML.
export function createEventFeed(limit = 5) {
  const capacity = Math.min(6, Math.max(4, Math.floor(Number.isFinite(limit) ? limit : 5)));
  let previous = null, entries = [], sequence = 0;
  const output = (latest = '') => ({ entries: entries.map(entry => ({ ...entry })), latest });
  function reset() { previous = null; entries = []; sequence = 0; }
  function update(state, me, { baseline = false } = {}) {
    if (!state || !me) return output();
    const current = snapshot(state, me);
    if (previous && current.match !== previous.match) reset();
    if (!previous || baseline) { previous = current; return output(); }
    let latest = '';
    function add(type, text) {
      entries.push({ id: ++sequence, type, text });
      if (entries.length > capacity) entries.shift();
      latest = text;
    }
    const before = previous.me;
    if (current.phase === 'playing' || current.phase === 'finished' && previous.phase === 'playing') {
      if (count(me.itemsCollected) > count(before?.itemsCollected)) add('item', itemCaption(before, me));
      let rescueShown = false;
      if (current.trainingStage === previous.trainingStage) {
        for (const player of current.players.values()) {
          if (player.id !== me.id && (!me.team || player.team !== me.team)) continue;
          const old = previous.players.get(player.id);
          if (!old) continue;
          const name = player.id === me.id ? '나' : String(player.name ?? '아군').slice(0, 40);
          if (old.alive && !player.alive) add('elimination', `${name} 탈락${player.respawnTicks > 0 ? ' · 잠시 후 다시 합류해요.' : ''}`);
          else if (player.alive && player.bubbleTicks > 0 && !(old.bubbleTicks > 0)) add('bubble', `${name} 물 감옥! 아군의 구출이 필요해요.`);
          else if (player.alive && old.bubbleTicks > 0 && !(player.bubbleTicks > 0)) {
            add('rescue', `${name} 구출! 다시 움직일 수 있어요.`); rescueShown = true;
          }
        }
      }
      if (!rescueShown && count(me.rescues) > count(before?.rescues)) add('rescue', `아군 구출! 총 ${me.rescues}회 구했어요.`);
      for (const team of ['blue', 'pink']) {
        if (current.scores[team] > previous.scores[team]) add('delivery', `${teamName(team)} 팀 별 전달! ${current.scores[team]} / ${state.relay?.goal ?? 3}`);
      }
    }
    if (current.phase === 'finished' && previous.phase !== 'finished') add('result', resultCaption(state.result, me));
    previous = current;
    return output(latest);
  }
  return { update, reset, baseline(state, me) { return update(state, me, { baseline: true }); } };
}
