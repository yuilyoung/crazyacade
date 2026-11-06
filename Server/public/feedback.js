const teamName = team => team === 'blue' ? '블루 B' : '핑크 P';
const count = value => Number.isFinite(value) ? value : 0;

function snapshot(state, me) {
  return {
    match: `${state.roomId ?? ''}:${state.matchId ?? ''}:${state.round ?? 0}`,
    carrierId: state.relay?.carrierId, charges:{ passes:count(state.relay?.charges?.passes), rescue:count(state.relay?.charges?.rescue),total:count(state.relay?.charges?.total) },
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

function resultCaption(result, me, training) {
  if (result?.reason === 'training_complete') return training?.mode === 'harmony' ? '4단계 하모니 훈련 완료! 패스와 구출을 이어 기지에 전달했어요.' : '4단계 훈련 완료! 친구와 대전할 준비가 되었어요.';
  if (result?.reason === 'training_timeout') return '훈련 시간 종료 · 다시 도전할 수 있어요.';
  if (result?.reason === 'training_idle_timeout') return '준비 대기 시간이 지나 훈련을 마쳤어요. 다시 시작해 연습을 이어갈 수 있어요.';
  if (result?.draw) return '대전 종료 · 무승부';
  if (result?.winnerTeam) return `대전 종료 · ${teamName(result.winnerTeam)} 팀 승리${me?.team ? result.winnerTeam === me.team ? '! 우리 팀 승리!' : ' · 다음 경기에 다시 도전해요.' : ''}`;
  return '대전 종료 · 결과를 확인해 주세요.';
}

function createPartyGoals() {
  let previous=null, awarded=new Set(), closedParties=new Set();
  function reset() { previous=null;awarded.clear();closedParties.clear(); }
  function update(state, baseline) {
    const series=state.series, mission=series?.mission, target=({rescues:2,items:5,passes:3})[mission?.kind];
    if(typeof series?.id!=='string' || !series.id || series.total!==3 || !Number.isInteger(series.round) || series.round<1 || series.round>3 || !state.matchId || !target || mission.target!==target || ['blue','pink'].some(team=>!Number.isInteger(mission.progress?.[team]) || mission.progress[team]<0 || mission.progress[team]>target)) return [];
    const current={id:series.id,round:series.round,matchId:state.matchId,tick:count(state.tick),phase:state.phase,kind:mission.kind,target,progress:{...mission.progress}};
    if(previous && previous.id===current.id) {
      if(current.round<previous.round || current.round===previous.round && current.matchId!==previous.matchId || current.round>previous.round && (current.matchId===previous.matchId || !baseline && current.round!==previous.round+1) || current.matchId===previous.matchId && current.tick<previous.tick) return [];
    } else if(previous) {
      if(closedParties.has(current.id)) return [];
      closedParties.add(previous.id);if(closedParties.size>8) closedParties.delete(closedParties.values().next().value);
      awarded.clear();
    }
    const sameRound=previous?.id===current.id && previous.round===current.round && previous.matchId===current.matchId && previous.kind===current.kind;
    const goals=[];
    for(const team of ['blue','pink']) {
      const key=`${current.id}:${current.round}:${team}`;
      if(current.progress[team]!==target || awarded.has(key)) continue;
      awarded.add(key);
      if(!baseline && sameRound && previous.progress[team]<target && (current.phase==='playing' || current.phase==='finished' && previous.phase==='playing')) {
        const label=({rescues:'구출',items:'아이템',passes:'패스'})[current.kind];
        const next=current.phase==='finished' ? '보너스는 이번 라운드 팀 점수에 반영돼요.' : state.ruleSet==='classic' ? '이제 승리를 향해 아군을 지키며 끝까지 살아남으세요.' : '이제 라운드 승리를 향해 별을 우리 기지로 전달하세요.';
        goals.push(`${teamName(team)} 팀 ${label} 목표 달성 · 파티 보너스 +1점! ${next}`);
      }
    }
    previous=current;return goals;
  }
  return {update,reset};
}

// Captions use authoritative snapshot transitions; callers render textContent, never HTML.
export function createEventFeed(limit = 5) {
  const capacity = Math.min(6, Math.max(4, Math.floor(Number.isFinite(limit) ? limit : 5)));
  let previous = null, entries = [], sequence = 0;
  const partyGoals=createPartyGoals();
  const output = (latest = '',goals=[]) => {
    const summary=goals.length ? `${goals[0].split('!')[0]}!` : '';
    return { entries: entries.map(entry => ({ ...entry })), latest,announcement:goals.includes(latest) ? '' : latest,partyGoals:goals,
      partyGoalSummary:goals.length===2 ? summary.replace(/^(블루 B|핑크 P) 팀/,'양 팀').replace('+1점!','+1점씩!') : summary };
  };
  function reset({preserveParty=false}={}) { previous = null; entries = []; sequence = 0;if(!preserveParty) partyGoals.reset(); }
  function update(state, me, { baseline = false } = {}) {
    if (!state || !me) return output();
    const current = snapshot(state, me);
    if (previous && current.match !== previous.match) reset({preserveParty:true});
    const goals=partyGoals.update(state,!previous || baseline);
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
      for (const player of current.players.values()) {
        const old = previous.players.get(player.id);
        const label = player.id === me.id ? '나' : teamName(player.team);
        if (count(player.interceptions) > count(old?.interceptions)) add('interception', `${label} 별 가로채기! 충전이 초기화됐어요.`);
        else if (count(player.passes) > count(old?.passes)) add('pass', `${label} 별 패스 성공!`);
      }
      if (state.ruleSet === 'harmony') {
        if (current.charges.total > previous.charges.total) add('charge', `${current.charges.rescue > previous.charges.rescue ? '아군 구출 충전' : '새 아군 패스 충전'}! 기지 전달 시 ${1 + Math.min(3,current.charges.total)}점 · 패스 ${current.charges.passes}/2 + 구출 ${current.charges.rescue}/1`);
        else if (previous.charges.total > 0 && current.charges.total === 0 && current.scores.blue === previous.scores.blue && current.scores.pink === previous.scores.pink) add('charge-reset','별 소유권 변경 · 충전 초기화, 다시 이어 주세요.');
      }
      for (const team of ['blue', 'pink']) {
        if (current.scores[team] > previous.scores[team]) add('delivery', `${teamName(team)} 팀 별 전달! ${current.scores[team]} / ${state.relay?.goal ?? 3}`);
      }
    }
    for(const text of goals) add('party-goal',text);
    if (current.phase === 'finished' && previous.phase !== 'finished') add('result', resultCaption(state.result, me, state.training));
    previous = current;
    return output(latest,goals);
  }
  return { update, reset, baseline(state, me) { return update(state, me, { baseline: true }); } };
}
