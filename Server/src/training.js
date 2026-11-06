const STAGES = ['escape', 'item', 'rescue', 'dart'];
const LESSONS = {
  escape: { title: '물폭탄 놓고 피하기', instruction: '시작 칸에 물폭탄을 놓고 위로 두 칸, 오른쪽 한 칸의 표시로 피하세요.', target: { x: 2, y: 3 } },
  item: { title: '상자를 깨고 아이템 줍기', instruction: '시작 칸에 물폭탄을 놓고 모퉁이로 피하세요. 파동이 사라지면 표시된 상자의 아이템을 주우세요.', target: { x: 3, y: 1 } },
  rescue: { title: '다가가서 아군 구출하기', instruction: '표시된 물감옥의 옆 칸으로 이동해 아군을 구출하세요. 제한시간은 10초예요.', target: { x: 3, y: 1 } },
  dart: { title: '다트로 멀리 있는 아군 구출하기', instruction: '오른쪽을 향한 상태예요. 다트를 쏘아 멀리 있는 아군을 구출하세요.', target: { x: 5, y: 1 } },
  complete: { title: '기본 훈련 완료', instruction: '물폭탄 회피, 아이템 습득, 가까운 구출과 다트 구출을 모두 해냈어요.', target: null }
};
const DUMMY_CELLS = [[5, 7], [7, 7], [9, 7], [5, 9], [7, 9], [9, 9], [11, 9]];
const LEARNING_TOTALS = ['score', 'bombsPlaced', 'itemsCollected', 'rescues', 'deliveries'];
const activeTraining = room => room.practice && room.training && typeof room.training === 'object' ? room.training : null;
const clearInput = player => Object.assign(player, { input: null, placeRequested: false, dartRequested: false, passRequested: false });

function prepareLesson(room, resetPlayer) {
  const training = activeTraining(room);
  room.soft = new Set(training.stage === 'escape' || training.stage === 'item' ? ['3,1'] : []);
  room.orbs.clear(); room.items.clear(); room.waves = []; room.dartEffects = [];
  let dummyIndex = 0;
  for (const player of room.players.values()) {
    const totals = Object.fromEntries(LEARNING_TOTALS.map(field => [field, player[field] ?? 0]));
    resetPlayer(player); Object.assign(player, totals);
    player.nextMoveTick = room.tick;
    if (player.id === training.playerId) { player.x = 1; player.y = 1; }
    else { [player.x, player.y] = DUMMY_CELLS[dummyIndex++]; }
  }
  const player = room.players.get(training.playerId);
  const ally = [...room.players.values()].find(p => p.isBot && p.team === player.team);
  training.targetId = null;
  if (training.stage === 'rescue' || training.stage === 'dart') {
    const cell = LESSONS[training.stage].target;
    Object.assign(ally, { x: cell.x, y: cell.y, bubbleTicks: 100 }); training.targetId = ally.id;
  }
  if (training.stage === 'dart') { player.darts = 1; player.facing = 'right'; }
  Object.assign(training, { status: 'ready', retryAt: null, sawOwnBomb: false, droppedPickup: false,
    dartRescued: false, bombsBefore: player.bombsPlaced, itemsBefore: player.itemsCollected,
    rangeBefore: player.range, rescuesBefore: player.rescues });
}

/** Only a private practice join can opt in; ordinary practice retains its AI game. */
export function initializeTraining(room, resetPlayer) {
  if (!room.practice || room.training !== true) { room.training = null; return; }
  const player = [...room.players.values()].find(p => !p.isBot);
  if (!player || ![...room.players.values()].some(p => p.isBot && p.team === player.team)) { room.training = null; return; }
  room.training = { stage: 'escape', playerId: player.id, attempts: 0, completed: 0 };
  prepareLesson(room, resetPlayer);
}

/** Reading time pauses the lesson; starting an active attempt never resets it. */
export function startTrainingLesson(room) {
  const training = activeTraining(room);
  if (!training || training.status !== 'ready') return false;
  for (const player of room.players.values()) clearInput(player);
  training.status = 'active';
  if (training.mode === 'harmony') training.failureReason = null;
  return true;
}
function retryLesson(room) {
  const training = activeTraining(room);
  training.status = 'retrying'; training.retryAt = room.tick + 10; training.attempts++;
  for (const player of room.players.values()) clearInput(player);
}
function advanceLesson(room, resetPlayer) {
  const training = activeTraining(room);
  training.completed++; training.stage = STAGES[training.completed] ?? 'complete';
  if (training.stage !== 'complete') { prepareLesson(room, resetPlayer); return; }
  training.status = 'complete';
  for (const player of room.players.values()) clearInput(player);
  room.orbs.clear(); room.waves = [];
}

/** Run after real movement, blast hits, pickups, rescues and bubble expiry. */
export function stepTraining(room, resetPlayer) {
  const training = activeTraining(room);
  if (!training || training.status === 'complete' || training.status === 'ready') return;
  const player = room.players.get(training.playerId);
  if (!player) return;
  if (training.status === 'retrying') {
    if (room.tick >= training.retryAt) prepareLesson(room, resetPlayer);
    return;
  }
  if (!player.alive) { retryLesson(room); return; }
  if (training.stage === 'escape') {
    if (player.bombsPlaced > training.bombsBefore && [...room.orbs.values()].some(orb => orb.ownerId === player.id)) training.sawOwnBomb = true;
    if (training.sawOwnBomb && room.orbs.size === 0 && room.waves.length === 0 && player.bubbleTicks === 0 && player.x === 2 && player.y === 3) advanceLesson(room, resetPlayer);
  } else if (training.stage === 'item') {
    if (training.droppedPickup && player.itemsCollected > training.itemsBefore && player.range > training.rangeBefore && player.bubbleTicks === 0) advanceLesson(room, resetPlayer);
    else if (training.droppedPickup && !room.items.has('3,1') && room.orbs.size === 0 && room.waves.length === 0 && player.bubbleTicks === 0) retryLesson(room);
  } else {
    const ally = room.players.get(training.targetId);
    if (!ally?.alive) { retryLesson(room); return; }
    if (ally.bubbleTicks > 0) return;
    if (player.rescues > training.rescuesBefore && (training.stage === 'rescue' || training.dartRescued)) advanceLesson(room, resetPlayer);
    else retryLesson(room);
  }
}

/** A true result means this private lesson handled the drop, even when suppressed. */
export function dropTrainingPickup(room, x, y) {
  const training = activeTraining(room);
  if (!training) return false;
  if (training.status === 'active' && training.stage === 'item' && x === 3 && y === 1 && !training.droppedPickup && !room.soft.has('3,1')) {
    room.items.set('3,1', { x, y, type: 'wave' }); training.droppedPickup = true;
  }
  return true;
}

/** Called by the server only after fireDart actually increases the rescuer's total. */
export function noteTrainingDartRescue(room, player) {
  const training = activeTraining(room);
  if (!training || training.status !== 'active' || training.stage !== 'dart' || player.id !== training.playerId) return;
  const ally = room.players.get(training.targetId);
  if (ally?.alive && ally.bubbleTicks === 0 && player.rescues > training.rescuesBefore &&
      Math.abs(player.x - ally.x) + Math.abs(player.y - ally.y) > 1) training.dartRescued = true;
}
export function trainingResult(room) {
  const training = activeTraining(room);
  if (!training) return null;
  if (training.status === 'complete') return { winnerTeam: 'blue', reason: 'training_complete' };
  return room.tick >= 1800 ? { draw: true, reason: 'training_timeout' } : null;
}
export function trainingState(room) {
  const training = activeTraining(room);
  if (!training) return null;
  const lesson = LESSONS[training.stage];
  return { mode: 'classic', stage: training.stage, step: Math.min(training.completed + 1, 4), total: 4,
    title: lesson.title, instruction: training.status === 'retrying' ? '다시 해 볼까요? 잠시 후 같은 단계에서 다시 시작해요.' : lesson.instruction,
    target: lesson.target ? { ...lesson.target } : null, attempts: training.attempts,
    completed: training.completed, status: training.status };
}
