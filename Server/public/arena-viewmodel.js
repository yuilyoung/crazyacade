import { DEFAULT_BINDINGS, keyLabel } from './controls.js';
const actions = new Set(['up','down','left','right','place_orb','use_dart','pass_star']);
function immutable(value) {
  const copy = structuredClone(value);
  function freeze(item) { if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); } return item; }
  return freeze(copy);
}
const PASS_DIRECTIONS = Object.freeze({ up:[0,1], down:[0,-1], left:[-1,0], right:[1,0] });
const passEligible = player => player?.alive && player.bubbleTicks === 0 && player.connected !== false;
/** Informational ray projection of the public snapshot. Server input still carries only pass_star. */
export function projectPass(snapshot, me) {
  if (snapshot?.phase !== 'playing' || !['relay','harmony'].includes(snapshot.ruleSet) || snapshot.relay?.carrierId !== me?.id || !passEligible(me)) return null;
  const [dx,dy] = PASS_DIRECTIONS[me.facing] || PASS_DIRECTIONS.up;
  const solid=new Set(snapshot.solid || []),soft=new Set(snapshot.soft || []),orbs=new Set((snapshot.orbs || []).map(orb=>`${orb.x},${orb.y}`));
  const cells=[]; let target=null,obstacle=null,status='empty';
  for(let distance=1;distance<=7;distance++) {
    const x=me.x+dx*distance,y=me.y+dy*distance,cell=`${x},${y}`;
    const kind=x<=0 || x>=12 || y<=0 || y>=10 || solid.has(cell) ? 'wall' : soft.has(cell) ? 'crate' : orbs.has(cell) ? 'orb' : null;
    if(kind) { obstacle={x,y,kind}; status='blocked'; break; }
    cells.push({x,y});
    const recipient=(snapshot.players || []).find(player=>player.id!==me.id && passEligible(player) && player.x===x && player.y===y);
    if(recipient) { target={id:recipient.id,team:recipient.team,x,y}; status=recipient.team===me.team?'ally':'enemy'; break; }
  }
  return immutable({status:snapshot.relay.passCooldownTicks>0?'cooldown':status,outcome:status,from:{x:me.x,y:me.y},cells,target,obstacle});
}
function passHint(guide,settings) {
  if(!guide) return '';
  const descriptions={ally:'아군에게 패스 가능',enemy:'상대가 가로채요',empty:'앞에 수신자 없음',cooldown:'잠시 후 패스',blocked:guide.obstacle?.kind==='orb'?'물폭탄에 막혀요':guide.obstacle?.kind==='crate'?'상자에 막혀요':'벽에 막혀요'};
  return `${keyLabel(settings.bindings?.pass || DEFAULT_BINDINGS.pass)} 예상 패스 → ${descriptions[guide.status]}`;
}
/** Training descriptions derive from server progress; labels follow the player's actual bindings. */
export function projectTraining(training, settings = {}, relay = null, outcome = {}) {
  if (!training) return null;
  const bindings = { ...DEFAULT_BINDINGS, ...settings.bindings };
  const mode = training.mode === 'harmony' ? 'harmony' : 'classic';
  const label = mode === 'harmony' ? '하모니 패스 훈련' : '구조 훈련';
  const controls = {
    escape: `${keyLabel(bindings.bomb)} 물폭탄 → 안전칸`, item: `${keyLabel(bindings.bomb)} 물폭탄 → 아이템 습득`,
    rescue: '이동 → 아군 옆에서 구출', dart: `${keyLabel(bindings.dart)} 다트 → 아군 구출`,
    pass: `${keyLabel(bindings.pass)} 패스 → 표시된 아군`, intercept: `${keyLabel(bindings.pass)} 패스 → 상대 가로채기 확인`,
    charge_rescue: `이동 또는 ${keyLabel(bindings.dart)} 다트 → 구출 충전`, delivery: '우리 B 기지로 이동 → 충전 점수 전달',
    complete: `${label} 완료 · 실전으로 이어가세요.`
  };
  const failures = {
    self_bubble: '물 감옥에 갇혔어요. 파동을 피한 뒤 다시 시도하세요.', player_eliminated: '탈락했어요. 안전한 길을 살펴 다시 시작하세요.',
    star_dropped: '별을 떨어뜨렸어요. 별을 보유한 상태로 목표 행동을 해 보세요.', target_eliminated: '구출 시간이 지나 아군이 탈락했어요. 더 빨리 구출해 보세요.'
  };
  const failure = failures[training.failureReason] || '';
  const shortInstruction = controls[training.stage] || training.instruction || '';
  const value = mode === 'harmony' && training.status !== 'complete' ? 1 + Math.min(3, Number(relay?.charges?.total) || 0) : null;
  let achievement = null;
  if (mode === 'harmony' && training.status === 'complete') {
    const own=outcome.result?.scoreboard?.find(player=>player.id===outcome.me?.id) || outcome.me || {};
    const count=value=>Number.isFinite(value)?Math.max(0,value):0;
    const deliveredPoints=count(outcome.result?.relayScores?.[outcome.me?.team] ?? relay?.scores?.[outcome.me?.team]);
    const passes=count(own.passes),rescues=count(own.rescues),deliveries=count(own.deliveries);
    achievement=Object.freeze({deliveredPoints,passes,rescues,deliveries,text:`${training.completed || 0} / ${training.total || 4}단계 완료 · ${deliveredPoints}점 전달 · 패스 ${passes}회 · 구출 ${rescues}회 · 전달 ${deliveries}회`});
  }
  return Object.freeze({ mode, label, shortInstruction, failure, achievement,
    instruction: [failure, training.instruction, shortInstruction].filter(Boolean).join(' '),
    progress: `${training.completed || 0} / ${training.total || 4}단계 완료`,
    complete: training.status === 'complete', continueRuleSet: mode === 'harmony' ? 'harmony' : null,
    deliveryValue:value,
    targetLabel: ({ pass:'패스', intercept:'상대', charge_rescue:'구출', delivery:'기지', escape:'안전칸' })[training.stage] || '목표'
  });
}
/** Pure display/command projection. It never creates browser or transport resources. */
export function projectArena(snapshot, { playerId = null, connection = 'disconnected', settings = {}, modalOpen = false } = {}) {
  const me = snapshot?.players?.find(player => player.id === playerId) || null;
  const canInput = connection === 'connected' && !modalOpen && snapshot?.phase === 'playing' && (!snapshot.training || snapshot.training.status === 'active') && Boolean(me?.alive) && !(me.bubbleTicks > 0) && me.connected !== false;
  const relay = snapshot?.relay;
  const passGuide=settings.passGuide === false ? null : projectPass(snapshot,me);
  return Object.freeze({ snapshot, playerId, connection, settings, modalOpen, me,
    passGuide, passHint:passHint(passGuide,settings),
    canInput, canDart: canInput && me.darts > 0,
    canPass: canInput && relay?.carrierId === playerId && !(relay.passCooldownTicks > 0),
    canRematch: connection === 'connected' && !modalOpen && snapshot?.phase === 'finished',
    canTrainingReady: connection === 'connected' && !modalOpen && snapshot?.phase === 'playing' && snapshot.training?.status === 'ready',
    training: projectTraining(snapshot?.training, settings, relay, {me,result:snapshot?.result}),
    isRelay: ['relay','harmony'].includes(snapshot?.ruleSet),
    relay: relay ? Object.freeze({ ...relay, deliveryValue: snapshot.ruleSet === 'harmony' ? 1 + Math.min(3, Number(relay.charges?.total) || 0) : 1 }) : null
  });
}
export function createArenaViewModel({ transport = { send: () => false } } = {}) {
  let snapshot = null, context = immutable({ playerId:null, connection:'disconnected', settings:{}, modalOpen:false });
  let view = projectArena(snapshot, context);
  const listeners = new Set();
  function publish() { view = projectArena(snapshot, context); for (const listener of [...listeners]) listener(view); }
  function send(message) { return transport.send(message) !== false; }
  return Object.freeze({
    get snapshot() { return snapshot; }, get view() { return view; },
    receive(value) { snapshot = immutable(value); publish(); },
    configure(patch) { context = immutable({ ...context, ...patch }); publish(); },
    subscribe(listener) { listeners.add(listener); listener(view); return () => listeners.delete(listener); },
    input(action) { if (!actions.has(action) || !view.canInput || action === 'pass_star' && !view.canPass || action === 'use_dart' && !view.canDart) return false; return send({type:'input',action}); },
    trainingReady() { return view.canTrainingReady && send({type:'training_ready'}); },
    rematch() { return view.canRematch && send({type:'rematch'}); },
    reset() { snapshot=null; context=immutable({...context,playerId:null,connection:'disconnected'}); publish(); },
    dispose() { listeners.clear(); }
  });
}
