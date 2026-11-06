import { initializeRelay, stepRelay } from './relay.js';
import { createLayout } from './catalog.js';

const STAGES = ['pass', 'intercept', 'charge_rescue', 'delivery'];
const LESSONS = {
  pass: { title: '아군에게 별 패스', instruction: '별을 들고 오른쪽 아군을 바라보고 있어요. 패스해 보세요. 서로 다른 아군이 받으면 전달 점수가 1점 더 충전돼요.', target: { x: 6, y: 5 } },
  intercept: { title: '가로채기와 충전 초기화', instruction: '앞 단계에서 얻은 충전 1점을 가지고 있어요. 이번에는 오른쪽 적에게 패스해 보세요. 처음 만난 적이 가로채면 충전은 0이 돼요.', target: { x: 6, y: 5 } },
  charge_rescue: { title: '별 보유 중 아군 구출', instruction: '우리 팀이 별을 들고 있어요. 오른쪽으로 한 칸 다가가거나 다트를 쏘아 버블 아군을 구하세요. 실제 구출은 전달 점수를 1점 더 충전해요. 제한시간은 10초예요.', target: { x: 6, y: 5 } },
  delivery: { title: '충전한 별을 기지로 전달', instruction: '앞 단계에서 구출로 얻은 충전을 가지고 있어요. 왼쪽으로 세 칸 이동해 B 기지에 별을 전달하세요. 기본 1점에 구출 1점을 더해 2점을 얻어요.', target: { x: 1, y: 5 } },
  complete: { title: '하모니 훈련 완료', instruction: '실제 패스, 가로채기, 구출 충전과 기지 전달을 모두 해냈어요. 하모니 경기에서는 이 행동을 이어 먼저 7점을 얻으세요.', target: null }
};
const PARKING = [[1, 1], [11, 1], [1, 3], [11, 3], [1, 7], [11, 7], [1, 9]];
const TOTALS = ['score', 'bombsPlaced', 'itemsCollected', 'rescues', 'deliveries', 'passes', 'interceptions'];
const active = room => room.practice && room.training?.mode === 'harmony' ? room.training : null;
const clearInput = player => Object.assign(player, { input: null, placeRequested: false, dartRequested: false, passRequested: false });
const earnedCharge = room => ({ recipients: [...room.relay.passRecipients], rescue: room.relay.rescueCharge });

/** Private lesson setup may position participants, but never invents action counters or points.
 * Later lessons retain only charge already earned through the preceding engine action.
 */
function prepareLesson(room, resetPlayer) {
  const training = active(room);
  room.solid = createLayout('festival', 'team').solid;
  room.soft.clear(); room.orbs.clear(); room.items.clear(); room.waves = []; room.dartEffects = [];
  let index = 0;
  for (const participant of room.players.values()) {
    const totals = Object.fromEntries(TOTALS.map(field => [field, participant[field] ?? 0]));
    resetPlayer(participant); Object.assign(participant, totals);
    participant.nextMoveTick = room.tick;
    if (participant.id === training.playerId) Object.assign(participant, { x: 4, y: 5, facing: training.stage === 'delivery' ? 'left' : 'right' });
    else [participant.x, participant.y] = PARKING[index++];
  }
  const player = room.players.get(training.playerId);
  const ally = [...room.players.values()].find(p => p.isBot && p.team === player.team);
  const enemy = [...room.players.values()].find(p => p.isBot && p.team !== player.team);
  const target = training.stage === 'intercept' ? enemy : training.stage === 'delivery' ? null : ally;
  if (target) Object.assign(target, { x: 6, y: 5 });
  if (training.stage === 'charge_rescue') { target.bubbleTicks = 100; player.darts = 1; }
  Object.assign(room.relay, { carrierId: player.id, star: null, nextSpawnTick: null, dropTick: null,
    nextPassTick: room.tick, passEffects: [], passRecipients: new Set(training.entryCharge.recipients), rescueCharge: training.entryCharge.rescue });
  Object.assign(training, { status: 'ready', retryAt: null, targetId: target?.id ?? null,
    proof: { passes: player.passes, rescues: player.rescues, deliveries: player.deliveries,
      interceptions: target?.interceptions ?? 0, teamScore: room.relay.scores[player.team] } });
}

export function initializeHarmonyTraining(room, resetPlayer) {
  initializeRelay(room);
  if (!resetPlayer) return; // Room creation precedes the private human and bot roster.
  if (!room.practice || room.training !== true || room.trainingMode !== 'harmony') return;
  const player = [...room.players.values()].find(p => !p.isBot);
  if (!player) return;
  room.training = { mode: 'harmony', stage: 'pass', playerId: player.id, attempts: 0, completed: 0,
    failureReason: null, entryCharge: earnedCharge(room) };
  prepareLesson(room, resetPlayer);
}
function retry(room, reason) {
  const training = active(room);
  Object.assign(training, { status: 'retrying', retryAt: room.tick + 10, failureReason: reason, attempts: training.attempts + 1 });
  for (const player of room.players.values()) clearInput(player);
}
function advance(room, resetPlayer) {
  const training = active(room);
  training.completed++;
  training.stage = STAGES[training.completed] ?? 'complete';
  training.failureReason = null;
  if (training.stage !== 'complete') {
    training.entryCharge = earnedCharge(room);
    prepareLesson(room, resetPlayer);
  } else {
    training.status = 'complete';
    for (const player of room.players.values()) clearInput(player);
    room.orbs.clear(); room.waves = [];
  }
}

/** Progress requires authoritative counters AND the corresponding objective transition. */
export function stepHarmonyTraining(room, resetPlayer) {
  const training = active(room);
  if (!training || ['ready', 'complete'].includes(training.status)) return;
  if (training.status === 'retrying') {
    if (room.tick >= training.retryAt) prepareLesson(room, resetPlayer);
    return;
  }
  const player = room.players.get(training.playerId), target = room.players.get(training.targetId);
  if (!player?.alive) { retry(room, 'player_eliminated'); return; }
  if (player.bubbleTicks > 0) { retry(room, 'self_bubble'); return; }
  if (target && !target.alive) { retry(room, 'target_eliminated'); return; }
  stepRelay(room);
  const relay = room.relay, proof = training.proof;
  if (training.stage === 'pass' && player.passes > proof.passes && relay.carrierId === target.id && relay.passRecipients.has(target.id)) {
    advance(room, resetPlayer); return;
  }
  if (training.stage === 'intercept' && target.interceptions > proof.interceptions && relay.carrierId === target.id && relay.passRecipients.size === 0 && relay.rescueCharge === 0) {
    advance(room, resetPlayer); return;
  }
  if (training.stage === 'charge_rescue' && player.rescues > proof.rescues && target.bubbleTicks === 0 && relay.rescueCharge === 1 && relay.carrierId === player.id) {
    advance(room, resetPlayer); return;
  }
  if (training.stage === 'delivery' && player.deliveries > proof.deliveries && relay.scores[player.team] - proof.teamScore >= 2) {
    advance(room, resetPlayer); return;
  }
  if (relay.carrierId !== player.id) retry(room, 'star_dropped');
}
export function harmonyTrainingState(room) {
  const training = active(room);
  if (!training) return null;
  const lesson = LESSONS[training.stage];
  return { mode: 'harmony', stage: training.stage, step: Math.min(training.completed + 1, 4), total: 4,
    title: lesson.title, instruction: training.status === 'retrying' ? '같은 단계에서 다시 해 볼까요? 잠시 후 설명을 읽고 재시작할 수 있어요.' : lesson.instruction,
    target: lesson.target ? { ...lesson.target } : null, attempts: training.attempts,
    completed: training.completed, status: training.status, failureReason: training.failureReason };
}
