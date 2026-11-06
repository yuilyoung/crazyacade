import { createArenaViewModel } from './arena-viewmodel.js';
import { createSocketTransport } from './socket-transport.js';
import { createArenaRenderer } from './arena-renderer.js';
import { createInputController } from './input-controller.js';
import { createDisplay } from './display.js';
import { PRESETS } from './controls.js';
import { MAPS, createLayout } from './map-catalog.js';
import { CHARACTERS } from './cosmetics.js';
import { drawAvatar, drawOrb } from './visuals.js';
import { createResultCardData, createResultSharing } from './share.js';
import { createExperience } from './experience.js';
import { buildInviteUrl, parseInvite } from './invite.js';
import { createResumeStore, createRecoveryWindow, createBrowserAuthenticator } from './reconnect.js';
import { createResultSavingPresenter } from './result-saving.js';
import { DEFAULT_BINDINGS, ACTION_LABELS, keyLabel, validateBindings, actionForEvent } from './controls.js';
import { createPreferences } from './preferences.js';
import { createEventFeed } from './feedback.js';

const $ = id => document.getElementById(id);
const form = $('join-form'), fields = $('selection-fields'), canvas = $('arena');
const experience = createExperience($);
const resultSaving = createResultSavingPresenter();
const preferences = createPreferences(), eventFeed = createEventFeed(5);
let bindingCapture = null;
const names = Object.fromEntries(CHARACTERS.map(character=>[character.id,character.label]));
const mapNames = Object.fromEntries(MAPS.map(map => [map.id,map.name]));
const errors = { unauthorized: '로그인을 확인할 수 없어요. 다시 입장해 주세요.', room_unavailable: '방이 가득 찼거나 경기가 진행 중이에요. 다른 방 이름을 입력해 주세요.', map_mismatch: '이 초대방은 다른 맵을 사용해요. 친구들과 같은 맵을 선택해 주세요.', already_in_room: '같은 계정이 이미 이 방에 있어요.', invalid_selection: '선택한 캐릭터·스킨·맵을 다시 확인해 주세요.', profile_unavailable: '프로필을 저장할 수 없어요. 잠시 후 다시 시도해 주세요.', authentication_unavailable: '로그인 서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.', invalid_mode: '대전 인원을 다시 선택해 주세요.', item_mode_mismatch: '이 초대방은 아이템전 설정이 달라요. 같은 규칙을 선택해 주세요.' };
errors.practice_unavailable = '연습방이 모두 사용 중이에요. 잠시 후 다시 시도해 주세요.';
errors.invalid_practice = '연습전 설정을 확인할 수 없어요. 다시 시도해 주세요.';
errors.invalid_training_mode = '훈련 종류를 확인해 주세요. 구조 또는 하모니 훈련 버튼으로 시작하세요.';
errors.invalid_rule_set = '승리 규칙을 다시 선택해 주세요.';
errors.rule_set_mismatch = '이 방의 승리 규칙이 달라요. 친구의 초대 링크로 같은 규칙을 선택해 주세요.';
errors.invalid_rule_mode = '팝 릴레이는 4대4 팀전에서 플레이할 수 있어요.';
errors.resume_unavailable = '복귀 시간이 지났거나 방이 종료됐어요. 새 경기를 시작해 주세요.';
Object.assign(errors, { invalid_human_slots: '함께할 사람 수를 다시 선택해 주세요.', human_slots_mismatch: '이 방의 사람 정원이 달라요. 친구의 초대 링크를 열어 주세요.', invalid_team_preference: 'AI를 포함한 친구 팀전에서 팀을 선택할 수 있어요.', team_full: '선택한 팀이 가득 찼어요. 자동 배정이나 다른 팀을 선택해 주세요.', bot_rooms_unavailable: 'AI 친구방이 모두 사용 중이에요. 잠시 후 다시 시도해 주세요.', invalid_training: '훈련 설정을 확인할 수 없어요. 훈련 시작 버튼으로 다시 입장해 주세요.' });
let config, socket = null, playerId = null, state = null, connecting = false, operation = 0, lastPhase = null, localUserId = null;
let joinedRoomId = null, rematchRequested = false;
let touchAction = null, joinTimer;
const transport = createSocketTransport({ url: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}` });
const viewModel = createArenaViewModel({ transport: { send: message => socket?.send(message) ?? false } });
viewModel.subscribe(view => { state = view.snapshot; playerId = view.playerId; });
const input = createInputController({ bindings: preferences.value.bindings, movementMode: preferences.value.movementMode, onAction: action => sendInput(({bomb:'place_orb',dart:'use_dart',pass:'pass_star'})[action] || action) });
const display = createDisplay({ canvas, battle: document.querySelector('.battle') });
const resultSharing = createResultSharing({ getResult: () => createResultCardData(state,playerId), getInviteUrl: () => state?.practice ? null : buildInviteUrl(location.href,{...state,roomId:state?.roomId || joinedRoomId}) });

let storage; try { storage = sessionStorage; } catch { /* Recovery can still use memory. */ }
const resumeStore = createResumeStore(storage, `popPop:resume:v1:${location.pathname}`), recovery = createRecoveryWindow();
const authenticateSession = createBrowserAuthenticator({ storage });
let resumeRecord = resumeStore.load(), recovering = false, resumeBusy = false, suspended = false, retryTimer;
let lastMessageAt = 0, lastPingAt = 0;
for (const name of ['characterId','skinId']) {
  const radio=[...form.querySelectorAll(`input[name="${name}"]`)].find(node=>node.value===preferences.value.loadout[name]);
  if(radio) radio.checked=true;
}
$('orb-skin').value=preferences.value.loadout.orbSkinId;
const invitation = parseInvite(location.search);
$('room-id').value = invitation.roomId; $('mode').value = invitation.mode;
$('human-slots').value = String(invitation.humanSlots || 8);
$('rule-set').value = invitation.ruleSet; $('item-mode').checked = invitation.itemMode;
form.querySelector(`input[name="mapId"][value="${invitation.mapId}"]`).checked = true;

function selected(name) { return form.querySelector(`input[name="${name}"]:checked`).value; }
function setStatus(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
function showOverlay(title, message, actions = '') { $('arena-overlay').hidden = false; $('overlay-title').textContent = title; $('overlay-copy').textContent = message; $('training-ready-button').hidden = actions !== 'ready'; $('training-next-actions').hidden = actions !== 'next'; }
function resetControls() { input.reset(); touchAction = null; }
function renderPlaySettings() {
  const prefs = preferences.value;
  viewModel.configure({settings:prefs}); input.configure({bindings:prefs.bindings,movementMode:prefs.movementMode});
  display.resize({quality:prefs.quality}); display.focus(prefs.focus);
  document.body.dataset.fontScale = prefs.fontScale; document.body.dataset.effects=prefs.effects;
  document.body.dataset.captions=String(prefs.captions);
  for (const [id,key] of [['render-quality','quality'],['effect-level','effects'],['text-scale','fontScale'],['item-style','itemStyle'],['movement-mode','movementMode']]) $(id).value=String(prefs[key]);
  $('captions-toggle').checked=prefs.captions; $('pass-guide-toggle').checked=prefs.passGuide; $('focus-toggle').setAttribute('aria-pressed',String(prefs.focus));
  experience.setEffects?.(prefs.effects);
  document.body.dataset.highContrast = String(prefs.highContrast);
  document.body.dataset.leftHanded = String(prefs.leftHanded);
  for (const [id, label, enabled] of [['contrast-toggle', '고대비', prefs.highContrast], ['left-hand-toggle', '왼손 배치', prefs.leftHanded]]) {
    $(id).setAttribute('aria-pressed', String(enabled)); $(id).textContent = `${label} ${enabled ? '켜짐' : '꺼짐'}`;
  }
  for (const button of document.querySelectorAll('[data-binding]')) {
    const action = button.dataset.binding;
    button.textContent = bindingCapture === action ? '새 키 입력…' : keyLabel(prefs.bindings[action]);
    button.setAttribute('aria-label', `${ACTION_LABELS[action]} 조작 키 ${button.textContent}`);
    button.setAttribute('aria-pressed', String(bindingCapture === action));
  }
  const move = ['up', 'left', 'down', 'right'].map(action => keyLabel(prefs.bindings[action])).join(' ');
  $('move-key-hint').textContent = move; $('bomb-key-hint').textContent = keyLabel(prefs.bindings.bomb); $('dart-key-hint').textContent = keyLabel(prefs.bindings.dart);
  experience.setControlLabels({ move, bomb: keyLabel(prefs.bindings.bomb), pass:keyLabel(prefs.bindings.pass) });
  $('pass-button').querySelector('span').textContent=`패스 ${keyLabel(prefs.bindings.pass)}`; updateRuleSelection();
  if (state) { if(state.training) renderTraining(); updateRelayStatus(state.players || [],viewModel.view.me); }
}
function cancelBindingCapture() { if (bindingCapture) { bindingCapture = null; renderPlaySettings(); } }
function renderEvents(snapshot, me, baseline = false) {
  const view = eventFeed.update(snapshot, me, { baseline });
  const entries = view.entries.map(entry => { const row = document.createElement('li'); row.dataset.type = entry.type; row.textContent = entry.text; return row; });
  if (!entries.length) entries.push(Object.assign(document.createElement('li'), { textContent: '경기가 시작되면 아이템·구출·탈락을 글로 알려드려요.' }));
  // Keep the non-live history stable between snapshots; announce only fresh events.
  const signature = view.entries.map(entry => entry.id).join(',');
  if ($('event-feed').dataset.events !== signature) { $('event-feed').replaceChildren(...entries); $('event-feed').dataset.events = signature; }
  if (baseline) { $('event-announcement').textContent = ''; $('event-peek').hidden = true; $('event-peek').textContent = ''; }
  else if (view.latest) { $('event-announcement').textContent = view.latest; $('event-peek').textContent = view.latest; $('event-peek').hidden = false; }
}
function resetEvents() { eventFeed.reset(); $('event-feed').dataset.events = ''; $('event-feed').replaceChildren(Object.assign(document.createElement('li'), { textContent: '경기가 시작되면 아이템·구출·탈락을 글로 알려드려요.' })); $('event-announcement').textContent = ''; $('event-peek').textContent = ''; $('event-peek').hidden = true; }
$('play-settings-toggle').addEventListener('click', () => {
  const expanded = $('play-settings-toggle').getAttribute('aria-expanded') !== 'true';
  $('play-settings-toggle').setAttribute('aria-expanded', String(expanded)); $('play-settings-panel').hidden = !expanded;
  resetControls(); cancelBindingCapture();
});
for (const [id, preference] of [['contrast-toggle', 'highContrast'], ['left-hand-toggle', 'leftHanded']]) $(id).addEventListener('click', () => {
  resetControls(); cancelBindingCapture(); preferences.update({ [preference]: !preferences.value[preference] }); renderPlaySettings();
});
for (const button of document.querySelectorAll('[data-binding]')) button.addEventListener('click', () => {
  resetControls(); bindingCapture = button.dataset.binding; renderPlaySettings();
  $('binding-status').textContent = `${ACTION_LABELS[bindingCapture]}에 사용할 새 키를 누르세요. ESC로 취소해요.`;
});
$('reset-keys').addEventListener('click', () => {
  resetControls(); bindingCapture = null; preferences.update({ bindings: { ...DEFAULT_BINDINGS } }); renderPlaySettings();
  $('binding-status').textContent = '기본 조작 키로 복원했어요.';
});
function selectedCapacity() { return $('mode').value === 'team' ? 8 : 2; }
function itemModeLabel(enabled) { return enabled ? '아이템전' : '기본전'; }
function numeric(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function selectionConfig() {
  return { roomId: $('room-id').value.trim(), mode: $('mode').value, mapId: selected('mapId'), itemMode: $('item-mode').checked, ruleSet: $('mode').value === 'duel' ? 'classic' : $('rule-set').value, humanSlots: $('mode').value === 'team' ? Number($('human-slots').value) : 2 };
}
function updateRuleSelection() {
  const duel = $('mode').value === 'duel';
  if (duel) $('rule-set').value = 'classic';
  $('rule-set').disabled = duel;
  $('friend-options').hidden = duel; $('human-slots').disabled = duel;
  const humans = Number($('human-slots').value), withBots = !duel && humans < 8;
  $('team-preference').disabled = !withBots;
  if (!withBots) $('team-preference').value = 'auto';
  $('friend-help').textContent = duel ? '두 사람이 모이면 1대1로 시작해요.' : withBots ? `사람 ${humans}명이 모이면 AI ${8 - humans}명을 채워 4대4로 시작해요. 비랭크 · 팀당 최대 4명 · 내 팀 선택은 초대 링크에 포함되지 않아요.` : '8명이 모이면 4대4로 시작해요.';
  $('rule-help').textContent = ['relay','harmony'].includes($('rule-set').value)
    ? $('rule-set').value === 'harmony' ? `비랭크 하모니 · 서로 다른 아군 패스 +2, 팀 구출 +1! 한 번에 최대 4점, 먼저 7점. ${keyLabel(preferences.value.bindings.pass)}로 바라보는 방향에 패스하세요.` : '비랭크 4대4 · 중앙 별을 우리 팀 B / P 기지로 3번 전달하면 승리! 탈락해도 5초 후 복귀해요.'
    : duel ? '1대1은 클래식으로 진행해요. 마지막까지 살아남으면 승리!' : '클래식은 마지막까지 살아남은 팀이 승리해요.';
}
function refreshInvite() {
  $('invite-button').disabled = connecting || state?.practice === true;
  if (state?.practice) {
    $('invite-url').value = ''; $('invite-status').textContent = 'AI 연습방은 공유할 수 없어요. 방을 나가 친구 대전을 준비해 주세요.';
  } else if ($('invite-url').value) {
    const url = buildInviteUrl(location.href, state ? { ...state, roomId: state.roomId || joinedRoomId } : selectionConfig());
    if ($('invite-url').value !== url) { $('invite-url').value = url; $('invite-status').textContent = '방 설정이 바뀌었어요. 초대 링크를 다시 복사해 주세요.'; }
  } else {
    $('invite-status').textContent = '친구는 링크를 열고 직접 입장해요. AI 연습방은 공유할 수 없어요.';
  }
}
$('invite-button').addEventListener('click', async () => {
  if (connecting || state?.practice) return;
  if (!state && !$('room-id').value.trim()) {
    const random = crypto.getRandomValues(new Uint32Array(2));
    $('room-id').value = `pop-${Array.from(random, value => value.toString(16).padStart(8, '0')).join('')}`;
  }
  const url = buildInviteUrl(location.href, state ? { ...state, roomId: state.roomId || joinedRoomId } : selectionConfig());
  $('invite-url').value = url;
  let copied = false;
  try { await navigator.clipboard.writeText(url); copied = true; } catch {
    $('invite-url').focus(); $('invite-url').select();
    try { copied = document.execCommand('copy'); } catch { /* The visible URL supports manual copying. */ }
  }
  if ($('invite-url').value === url) $('invite-status').textContent = copied
    ? '초대 링크를 복사했어요. 친구에게 보내고 같은 방에 입장하세요.'
    : '아래 링크를 선택해 직접 복사해 주세요. 친구는 링크를 열고 입장하면 돼요.';
});
const tierNames = { Bronze: '브론즈', Silver: '실버', Gold: '골드', Diamond: '다이아' };
async function refreshLeaderboard() {
  $('refresh-leaderboard').disabled = true;
  try {
    const response = await fetch('/api/leaderboard', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('unavailable');
    const data = await response.json();
    if (!Array.isArray(data.entries)) throw new Error('invalid');
    $('leaderboard-note').textContent = data.source === 'demo'
      ? '개발 서버 임시 랭킹 · 서버를 재시작하면 초기화됩니다. 정식 계정 전적과 별개입니다.'
      : '인증된 경기 결과로 집계한 랭킹입니다. 승리 +25 · 패배 −15 · 무승부 +5';
    const rows = document.createDocumentFragment();
    for (const entry of data.entries) {
      const tr = document.createElement('tr');
      for (const value of [entry.rank, entry.name, tierNames[entry.tier] || entry.tier, entry.rating, `${numeric(entry.wins)} / ${numeric(entry.losses)} / ${numeric(entry.draws)}`, numeric(entry.score)]) {
        const td = document.createElement('td'); td.textContent = String(value ?? '—'); tr.append(td);
      }
      tr.children[2].className = 'rank-tier';
      const badge = document.createElement('span'); badge.className = `tier ${Object.hasOwn(tierNames, entry.tier) ? entry.tier : 'Bronze'}`;
      badge.textContent = tierNames[entry.tier] || '브론즈'; tr.children[2].replaceChildren(badge);
      rows.append(tr);
    }
    $('leaderboard-rows').replaceChildren(rows);
    $('leaderboard-empty').hidden = data.entries.length > 0;
  } catch {
    $('leaderboard-note').textContent = '랭킹을 불러오지 못했어요. 서버 설정을 확인하거나 잠시 후 다시 시도해 주세요.';
  } finally { $('refresh-leaderboard').disabled = false; }
}
function renderResultSaving() {
  const view = resultSaving.update(state), label = $('result-saving');
  label.hidden = view.hidden; label.dataset.status = view.status;
  label.dataset.matchId = state?.matchId || '';
  if (label.textContent !== view.text) label.textContent = view.text;
  if (view.refreshLeaderboard) void refreshLeaderboard();
}
function renderScoreboard(players) {
  const scores = state.result?.scoreboard || players;
  const rows = document.createDocumentFragment();
  [...scores].sort((a, b) => numeric(b.score) - numeric(a.score)).forEach((player, index) => {
    const row = document.createElement('div'); row.className = 'score-row'; row.dataset.team = player.team || '';
    const position = document.createElement('span'); position.textContent = String(index + 1).padStart(2, '0');
    const isBot = player.isBot ?? players.find(p => p.id === player.id)?.isBot;
    const name = document.createElement('strong'); name.textContent = `${player.team ? `${player.team === 'pink' ? 'P' : 'B'} · ` : ''}${player.name}${player.id === playerId ? ' (나)' : ''}${isBot ? ' · AI' : ''}`;
    const rescues = document.createElement('small'); rescues.className = 'rescue-score'; rescues.textContent = `${['relay','harmony'].includes(state.ruleSet) ? `전달 ${numeric(player.deliveries)}회 · ` : ''}구조 ${numeric(player.rescues)}회${['relay','harmony'].includes(state.ruleSet) ? ` · 패스 ${numeric(player.passes)} · 가로채기 ${numeric(player.interceptions)}` : ''}`;
    const score = document.createElement('b'); score.textContent = `${numeric(player.score).toLocaleString()}점`;
    row.append(position, name, rescues, score); rows.append(row);
  });
  const me = scores.find(player => player.id === playerId), rescuers = scores.filter(player => numeric(player.rescues) > 0);
  const recognition = numeric(me?.rescues) > 0 ? `팀을 살린 나의 구조 ${numeric(me.rescues)}회!` : rescuers.length ? `구조로 팀을 지킨 플레이어: ${rescuers.map(player => `${player.name} ${numeric(player.rescues)}회`).join(', ')}` : '이번 판은 구조 0회 · 다음에는 버블 아군 옆으로 가서 팀을 구해 보세요.';
  $('rescue-recognition').textContent = viewModel.view.training?.achievement ? `${viewModel.view.training.achievement.text} · 비랭크 훈련, 전적과 랭킹에 저장하지 않아요.` : `${['relay','harmony'].includes(state.ruleSet) ? `${state.ruleSet === 'harmony' ? '하모니' : '팝 릴레이'} · B ${numeric(state.result?.relayScores?.blue)} : ${numeric(state.result?.relayScores?.pink)} P · 비랭크, 전적과 랭킹에 저장하지 않아요. ` : state.training ? `${viewModel.view.training.label} · 전적과 랭킹에 저장하지 않아요. ` : state.practice ? 'AI 연습전 · 전적과 랭킹에 저장하지 않아요. ' : state.withBots ? '친구 + AI · 전적과 랭킹에 저장하지 않아요. ' : ''}${recognition}`;
  const shareable = Boolean(createResultCardData(state,playerId)); $('download-result-button').disabled = !shareable; $('share-result-button').disabled = !shareable;
  $('scoreboard-rows').replaceChildren(rows); $('match-scoreboard').hidden = false;
}
$('refresh-leaderboard').addEventListener('click', refreshLeaderboard);
function resetView() {
  viewModel.reset(); localUserId = null; lastPhase = null; joinedRoomId = null; rematchRequested = false; canvas.dataset.phase = 'preview'; canvas.dataset.practice = 'false';
  renderResultSaving(); $('result-share-status').textContent='';
  updateRuleSelection(); canvas.dataset.ruleSet = $('rule-set').value; canvas.dataset.round = '0'; canvas.dataset.carrierId = '';
  experience.reset($('item-mode').checked, $('rule-set').value); resetEvents(); $('match-kind').textContent = ['relay','harmony'].includes($('rule-set').value) ? `${$('rule-set').value === 'harmony' ? '하모니' : '팝 릴레이'} · 비랭크` : '대전 준비';
  $('phase').textContent = '입장 준비'; $('timer').textContent = '02:00'; $('player-count').textContent = `0 / ${selectedCapacity()}명`;
  $('blue-count').textContent = '0'; $('pink-count').textContent = '0'; $('room-label').textContent = '입장 대기';
  $('player-stats').textContent = '물폭탄 1 · 파동 3 · 속도 1 · 다트 0 · 점수 0'; $('replay-button').hidden = true; $('replay-button').disabled = false;
  $('match-rules').textContent = itemModeLabel($('item-mode').checked); document.querySelector('.item-mode-toggle b').textContent = $('item-mode').checked ? 'ON' : 'OFF'; $('dart-count').textContent = '0'; $('dart-button').disabled = true; $('match-scoreboard').hidden = true;
  $('roster').replaceChildren(Object.assign(document.createElement('p'), { className: 'empty-state', textContent: '혼자라면 AI 연습전으로 바로 시작하세요. 입장하면 B 블루 / P 핑크 팀과 AI 표시를 볼 수 있어요.' }));
  showOverlay('준비됐나요?', 'AI와 바로 연습하거나 친구들과 같은 방에 입장하세요.');
  $('pass-button').hidden = true; $('relay-status').hidden = true; document.querySelector('.rescue-alert-slot').classList.remove('has-relay');
  renderTraining();
  refreshInvite();
}
function disconnect(message = '방에서 나왔어요. 다시 준비해 주세요.', isError = false, notifyServer = true) {
  operation++; clearTimeout(joinTimer); clearTimeout(retryTimer);
  recovering = false; resumeBusy = false; recovery.stop(); resumeRecord = null; resumeStore.clear();
  const old = socket; socket = null;
  if (old) { if (notifyServer && old.readyState === WebSocket.OPEN) old.send(JSON.stringify({ type: 'leave' })); old.close(); }
  connecting = false; document.body.classList.remove('in-room'); fields.disabled = false; $('join-button').disabled = !config; $('practice-button').disabled = false; $('leave-button').hidden = true;
  resetControls(); resetView(); canvas.dataset.connection = 'disconnected'; setStatus(message, isError);
}
async function authenticate() {
  const session = await authenticateSession(config);
  localUserId = session?.user?.id || null;
  return session?.access_token || null;
}
function renderRecovery() {
  const seconds = Math.ceil(recovery.remaining() / 1000);
  viewModel.configure({connection:'reconnecting'}); canvas.dataset.connection = 'reconnecting';
  $('phase').textContent = '복구 중';
  $('replay-button').disabled = true; $('dart-button').disabled = true;
  const message = `${navigator.onLine === false ? '인터넷 연결을 기다리고 있어요.' : '같은 캐릭터로 돌아가고 있어요.'} 복귀 시도 ${seconds}초 남음 · 경기는 계속 진행돼요.`;
  setStatus(message); showOverlay('연결 복구 중', message);
}
function queueResume() {
  clearTimeout(retryTimer);
  if (!recovering || suspended || resumeBusy) return;
  const delay = recovery.nextDelay();
  if (delay === null) { disconnect('연결을 복구하지 못했어요. 네트워크를 확인하고 새 경기를 시작해 주세요.', true, false); return; }
  retryTimer = setTimeout(() => { if (navigator.onLine === false) queueResume(); else void tryResume(); }, delay);
}
function beginRecovery(ws = socket) {
  if (ws && socket !== ws) return;
  operation++; clearTimeout(joinTimer); resumeBusy = false;
  const old = socket; socket = null; if (old) old.close();
  if (!resumeRecord) { disconnect('대전 서버에 연결할 수 없어요. 다시 시도해 주세요.', true, false); return; }
  recovering = true; connecting = true; recovery.start(resumeRecord.reconnectGraceMs);
  fields.disabled = true; $('join-button').disabled = true; $('practice-button').disabled = true; $('leave-button').hidden = false;
  document.body.classList.add('in-room'); resetControls(); cancelBindingCapture(); rematchRequested = false;
  renderRecovery(); queueResume();
}
async function tryResume() {
  if (!recovering || !resumeRecord || suspended || resumeBusy) return;
  clearTimeout(retryTimer);
  if (recovery.remaining() <= 0) { queueResume(); return; }
  const attempt = ++operation, record = resumeRecord;
  resumeBusy = true;
  try {
    if (!record.practice && !config) {
      const response = await fetch('/api/config', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('config unavailable');
      config = await response.json();
    }
    const accessToken = record.practice ? null : await authenticate();
    if (attempt !== operation || suspended) return;
    openSocket({ type: 'resume', roomId: record.roomId, playerId: record.playerId, resumeToken: record.resumeToken, accessToken }, record.practice, true);
  } catch {
    if (attempt !== operation) return;
    resumeBusy = false; queueResume();
  }
}
function restoreSelections(message) {
  const me = message.players?.find(player => player.id === playerId);
  // Training uses a fixed arena; keep the player's selected map/rules for the next match.
  if (!message.training) { $('mode').value = message.mode; $('rule-set').value = message.ruleSet || 'classic'; $('item-mode').checked = message.itemMode !== false; }
  if (!message.practice) $('human-slots').value = String(message.humanSlots || 8);
  if (!message.practice) $('room-id').value = message.roomId;
  for (const [name, value] of [['mapId', message.mapId], ['characterId', me?.characterId], ['skinId', me?.skinId]]) {
    if (message.training && name === 'mapId') continue;
    const input = [...form.querySelectorAll(`input[name="${name}"]`)].find(element => element.value === value);
    if (input) input.checked = true;
  }
  if (me?.name) $('nickname').value = me.name;
  if (me?.orbSkinId) $('orb-skin').value = me.orbSkinId;
  updateRuleSelection();
}
function openSocket(payload, practice, isResume = false) {
  const ws = transport.connect(payload, { onMessage(message) {
    if (socket !== ws || suspended) return;
    lastMessageAt = Date.now();
    if (message.type === 'joined') {
      viewModel.configure({playerId:message.playerId}); joinedRoomId = message.roomId;
      if (message.resumeToken) {
        resumeRecord = { roomId: message.roomId, playerId: message.playerId, resumeToken: message.resumeToken, reconnectGraceMs: message.reconnectGraceMs, practice };
        resumeStore.save(resumeRecord);
      }
      document.body.classList.add('in-room'); $('leave-button').hidden = false;
      if (!isResume) {
        connecting = false; window.scrollTo({ top: 0, behavior: 'instant' });
        setStatus(practice ? 'AI 연습전 · 전적과 랭킹에 저장하지 않아요.' : '입장했어요. 모두 모이면 자동으로 시작해요.');
      }
      $('room-label').textContent = practice ? '비공개 AI 연습방' : message.roomId;
    } else if (message.type === 'state' && playerId) {
      if (!message.players?.some(player => player.id === playerId)) { disconnect('현재 방에서 참가 정보를 찾을 수 없어요. 다시 입장해 주세요.', true, false); return; }
      if (state?.training && (state.training.stage !== message.training?.stage || state.training.status !== message.training?.status)) resetControls();
      if (state && numeric(message.round) !== numeric(state.round)) {
        resetControls(); experience.reset(message.itemMode !== false, message.ruleSet); resetEvents(); lastPhase = null; rematchRequested = false;
        $('match-scoreboard').hidden = true; $('result-share-status').textContent=''; $('replay-button').hidden = true; $('replay-button').disabled = false;
      }
      const restored = recovering;
      if (!state || restored) restoreSelections(message);
      if (restored) { rematchRequested = (message.rematch?.readyPlayerIds || []).includes(playerId); resetControls(); renderEvents(message, message.players.find(player => player.id === playerId), true); }
      clearTimeout(joinTimer); resumeBusy = false; recovering = false; connecting = false; recovery.stop(); clearTimeout(retryTimer);
      const trainingActivated = message.training?.status === 'active' && state?.training?.status !== 'active';
      const trainingPrepared = message.training?.status === 'ready' && (state?.training?.status !== 'ready' || state?.training?.stage !== message.training.stage);
      canvas.dataset.connection = 'connected'; viewModel.configure({connection:'connected'}); viewModel.receive(message); updateHud();
      if (trainingActivated) canvas.focus({ preventScroll: true });
      else if (trainingPrepared) $('training-ready-button').focus({ preventScroll: true });
      if (restored) setStatus('연결을 복구했어요. 같은 캐릭터로 계속 플레이하세요.');
    } else if (message.type === 'error') {
      if (isResume && message.code === 'authentication_unavailable') { beginRecovery(ws); return; }
      disconnect(errors[message.code] || '방에 입장하지 못했어요. 다시 시도해 주세요.', true, false);
    }
  }, onClose(event) {
    if (socket !== ws || suspended) return;
    if (event.code === 4001) disconnect('다른 창에서 같은 참가자로 연결했어요. 이 창의 복귀를 종료합니다.', true, false);
    else beginRecovery(ws);
  }, onError() { if (socket === ws && !suspended) beginRecovery(ws); } });
  socket = ws;
  lastMessageAt = lastPingAt = Date.now();
  joinTimer = setTimeout(() => {
    if (socket !== ws) return;
    if (isResume) beginRecovery(ws);
    else disconnect('연결 시간이 초과됐어요. 다시 시도해 주세요.', true);
  }, isResume ? Math.min(8000, recovery.remaining()) : 15000);
}

async function join(practice = false, training = false, trainingMode = 'classic') {
  if ((!practice && !config) || connecting || playerId) return;
  resetControls(); cancelBindingCapture();
  const attempt = ++operation;
  resumeRecord = null; resumeStore.clear();
  connecting = true; fields.disabled = true; $('join-button').disabled = true; $('practice-button').disabled = true; $('training-button').disabled = true; $('harmony-training-button').disabled = true; $('harmony-training-panel-button').disabled = true;
  canvas.dataset.connection = 'connecting';
  setStatus(training ? `4단계 ${trainingMode === 'harmony' ? '하모니 패스' : '구조'} 훈련을 준비하고 있어요…` : practice ? 'AI 7명과 함께할 비랭크 연습방을 준비하고 있어요…' : '로그인하고 방을 찾고 있어요…');
  const selection = { characterId: selected('characterId'), skinId: selected('skinId'), orbSkinId: $('orb-skin').value, mapId: training ? 'garden' : selected('mapId'), mode: practice ? 'team' : $('mode').value, itemMode: training || $('item-mode').checked, ruleSet: training ? trainingMode === 'harmony' ? 'harmony' : 'classic' : $('rule-set').value };
  if (!practice && selection.mode === 'team') {
    selection.humanSlots = Number($('human-slots').value);
    if (selection.humanSlots < 8) selection.teamPreference = $('team-preference').value;
  }
  experience.reset(selection.itemMode, selection.ruleSet); refreshInvite();
  const roomId = $('room-id').value.trim() || `${selection.mode}-quick-${selection.mapId}-${selection.itemMode ? 'items' : 'basic'}-${selection.ruleSet}${selection.humanSlots < 8 ? `-humans${selection.humanSlots}` : ''}`;
  try {
    const accessToken = practice ? null : await authenticate(); if (attempt !== operation || suspended) return;
    openSocket({ type: 'join', reconnect: true, ...(practice ? { practice: true, ...(training ? { training: true, ...(trainingMode === 'harmony' ? { trainingMode } : {}) } : {}) } : { roomId, accessToken }), name: $('nickname').value.trim() || 'Popper', ...selection }, practice);
  } catch (error) { if (attempt === operation) disconnect(error.name === 'TimeoutError' ? '로그인 시간이 초과됐어요. 다시 시도해 주세요.' : error.message, true); }
}
form.addEventListener('submit', event => { event.preventDefault(); void join(); });
$('practice-button').addEventListener('click', () => { void join(true); });
function startTraining(mode = 'classic') {
  if (connecting || state && !(state.training && state.phase === 'finished')) return;
  if (state) disconnect('새 훈련을 준비하고 있어요.');
  void join(true, true, mode);
}
$('training-button').addEventListener('click', () => startTraining(viewModel.view.training?.mode || 'classic'));
$('harmony-training-button').addEventListener('click', () => startTraining('harmony'));
$('harmony-training-panel-button').addEventListener('click', () => startTraining('harmony'));
$('quick-training').addEventListener('click', () => startTraining('classic'));
$('quick-practice').addEventListener('click', () => { void join(true); });
function prepareFriendMatch() {
  if (connecting || state && !(state.training && state.phase === 'finished')) return;
  const continueRuleSet = viewModel.view.training?.continueRuleSet;
  if (state) disconnect('친구와 함께할 팀전을 준비해요.');
  if (continueRuleSet) $('rule-set').value=continueRuleSet;
  $('mode').value = 'team'; $('human-slots').value = '2'; $('team-preference').value = 'auto'; $('room-id').value = ''; $('invite-url').value = '';
  resetView(); setStatus('친구 2명 + AI 6명의 4대4 · 맵과 팀을 고른 뒤 초대 링크를 복사해 주세요.');
  document.querySelector('.setup').scrollIntoView({ behavior: experience.reducedMotion ? 'instant' : 'smooth', block: 'start' });
  $('human-slots').focus({ preventScroll: true });
}
$('quick-friends').addEventListener('click', prepareFriendMatch);
$('training-friends-button').addEventListener('click', prepareFriendMatch);
$('training-practice-button').addEventListener('click', () => {
  if (connecting || !state?.training || state.phase !== 'finished') return;
  const continueRuleSet = viewModel.view.training?.continueRuleSet;
  disconnect('AI와 함께 실전에 도전해요.');
  if (continueRuleSet) { $('mode').value='team'; $('rule-set').value=continueRuleSet; updateRuleSelection(); }
  void join(true);
});
$('training-ready-button').addEventListener('click', () => {
  if (recovering || connecting || state?.training?.status !== 'ready' || state.phase !== 'playing' || socket?.readyState !== WebSocket.OPEN) return;
  resetControls(); cancelBindingCapture(); viewModel.trainingReady();
});
$('leave-button').addEventListener('click', () => disconnect());
$('replay-button').addEventListener('click', () => {
  if (state?.phase !== 'finished' || recovering) return;
  if (state.practice) { const training = Boolean(state.training), mode=viewModel.view.training?.mode || 'classic'; disconnect('새 연습전을 준비하고 있어요.'); void join(true, training, mode); return; }
  if (rematchRequested || socket?.readyState !== WebSocket.OPEN) return;
  rematchRequested = true; $('replay-button').disabled = true;
  viewModel.rematch();
  setStatus('재대결 준비 완료! 방에 연결된 친구들이 모두 준비하면 다음 라운드를 시작해요.');
});
form.addEventListener('change', () => { if (!state) { preferences.update({loadout:{characterId:selected('characterId'),skinId:selected('skinId'),orbSkinId:$('orb-skin').value}}); updateRuleSelection(); resetView(); renderPreview(); } });
function updateHud() {
  const players = state.players || [], capacity = state.mode === 'team' ? 8 : 2, me = viewModel.view.me;
  renderResultSaving();
  canvas.dataset.phase = state.phase; canvas.dataset.map = state.mapId; canvas.dataset.itemMode = String(state.itemMode !== false);
  canvas.dataset.practice = String(state.practice === true); canvas.dataset.ruleSet = state.ruleSet || 'classic'; canvas.dataset.round = String(numeric(state.round)); canvas.dataset.carrierId = state.relay?.carrierId || '';
  $('match-kind').textContent = state.training ? `${viewModel.view.training.label} · 비랭크` : ['relay','harmony'].includes(state.ruleSet) ? `${state.ruleSet === 'harmony' ? '하모니' : '팝 릴레이'} · 비랭크` : state.practice ? 'AI 연습 · 비랭크' : state.withBots ? '친구+AI · 비랭크' : config?.allowDevGuests ? '친구 대전 · 개발 게스트' : '친구 대전';
  refreshInvite();
  experience.update(state, me, viewModel.view);
  renderEvents(state, me); renderTraining();
  $('match-rules').textContent = itemModeLabel(state.itemMode !== false);
  $('phase').textContent = state.phase === 'playing' ? state.training ? '훈련 중' : '대전 중' : state.phase === 'finished' ? '경기 종료' : '참가자 대기';
  const seconds = Math.ceil((state.remaining || 0) / 10); $('timer').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  $('player-count').textContent = state.training ? `${state.training.completed} / 4단계 완료` : state.practice ? `나 + AI ${players.filter(player => player.isBot).length}명` : state.withBots ? `사람 ${players.filter(player => !player.isBot).length}/${state.humanSlots} · AI ${capacity - state.humanSlots}` : `${players.length} / ${capacity}명`;
  $('blue-count').textContent = players.filter((p, i) => p.alive && (state.mode === 'team' ? p.team === 'blue' : i === 0)).length;
  $('pink-count').textContent = players.filter((p, i) => p.alive && (state.mode === 'team' ? p.team === 'pink' : i === 1)).length;
  if (me) {
    $('player-stats').textContent = `${me.bubbleTicks > 0 ? '🫧 구조 요청 · ' : !me.alive ? ['relay','harmony'].includes(state.ruleSet) ? '복귀 대기 · ' : '관전 중 · ' : ''}물폭탄 ${me.maxOrbs} · 파동 ${me.range} · 속도 ${numeric(me.speedLevel) + 1} · 다트 ${numeric(me.darts)} · 핀 ${me.pin ? '✓' : '—'} · 구조 ${numeric(me.rescues)}회 · ${numeric(me.score)}점`;
    $('dart-count').textContent = String(numeric(me.darts));
    $('dart-button').disabled = !viewModel.view.canDart;
  }
  $('pass-button').hidden = !viewModel.view.isRelay; $('pass-button').disabled = !viewModel.view.canPass;
  updateRelayStatus(players, me); updateRescueAlert(players, me);
  if (state.phase === 'playing' && state.training?.status === 'ready') {
    showOverlay(`${state.training.step}/${state.training.total} · ${state.training.title}`, `${viewModel.view.training.instruction}\n설명을 읽고 준비되면 시작하세요.`, 'ready');
  }
  else if (state.phase === 'waiting') {
    const pending = players.filter(player => player.connected === false).length;
    const humans = players.filter(player => !player.isBot), slots = state.humanSlots || capacity;
    showOverlay(`${humans.length - pending} / ${slots}명 연결 완료`, `${mapNames[state.mapId] || state.mapId} · ${pending ? `${pending}명 연결 복귀를 기다리고 있어요.` : '친구들을 기다리고 있어요.'}\n${state.withBots ? `사람이 모이면 AI ${capacity - slots}명과 4대4 · 비랭크\n` : ''}같은 방 이름·맵·규칙으로 입장하세요.`);
  }
  else if (state.phase === 'finished') {
    let title = '경기 종료!';
    if (state.result?.draw) title = '무승부!';
    else if (state.result?.winnerTeam) title = `${state.result.winnerTeam === 'blue' ? '블루' : '핑크'} 팀 승리!`;
    else if (localUserId && state.result?.winnerId) title = state.result.winnerId === localUserId ? '승리했어요!' : '다음 판에 다시 도전!';
    const ready = state.rematch?.readyPlayerIds || [], total = numeric(state.rematch?.total) || players.length;
    const ownReady = rematchRequested || ready.includes(playerId);
    const pending = players.filter(player => player.connected === false).length;
    const readyText = `재대결 준비 ${ready.length} / ${total}명${pending ? ` · ${pending}명 연결 복귀 대기` : ownReady ? ' · 나는 준비 완료' : ' · 모두 준비하면 같은 방에서 시작해요.'}`;
    const relayResult = ['relay','harmony'].includes(state.ruleSet) ? `별 전달 B ${numeric(state.result?.relayScores?.blue)} : ${numeric(state.result?.relayScores?.pink)} P · 비랭크\n` : '';
    if (state.training) title = viewModel.view.training.complete ? `${viewModel.view.training.label} 완료!` : '훈련 시간 종료';
    showOverlay(title, state.training ? `${viewModel.view.training.achievement?.text || `${state.training.completed} / 4단계 완료`} · 재도전 ${state.training.attempts}회\n다시 훈련하거나 친구와 팀전에 도전해 보세요.` : `${relayResult}${state.practice ? 'AI 연습전 완료 · 전적과 랭킹에 저장하지 않아요.\n아래에서 점수와 구조 기여를 확인하세요.' : `${state.withBots ? '친구 + AI · 비랭크\n' : ''}아래에서 이번 경기 기여를 확인하세요.\n${readyText}`}`, state.training ? 'next' : '');
    $('training-practice-button').textContent=viewModel.view.training?.mode === 'harmony' ? '하모니 AI 연습' : 'AI 연습 이어하기';
    $('training-friends-button').textContent=viewModel.view.training?.mode === 'harmony' ? '친구와 하모니 준비' : '친구와 팀전 준비';
    $('replay-button').textContent = state.training ? '훈련 다시 시작' : state.practice ? '연습 바로 다시 시작' : `${ownReady ? '준비 완료' : '재대결 준비'} ${ready.length}/${total}`;
    $('replay-button').disabled = !state.practice && ownReady; $('replay-button').hidden = false; renderScoreboard(players); resetControls();
  } else { $('arena-overlay').hidden = true; }
  if (state.phase !== lastPhase) { lastPhase = state.phase; if (state.phase === 'playing') { setStatus(['relay','harmony'].includes(state.ruleSet) ? state.ruleSet === 'harmony' ? '하모니 · 비랭크! 패스와 아군 구출로 충전해 한 번에 최대 4점, 먼저 7점! 탈락하면 5초 후 복귀해요.' : '팝 릴레이 · 비랭크! 중앙 별을 우리 팀 B / P 기지로 3번 전달하세요. 탈락하면 5초 후 복귀해요.' : `${state.practice ? 'AI 연습 · 비랭크! ' : '시작! '}화살표와 ‘나’ 표시를 찾아 움직여 보세요. 버블 아군 옆으로 가면 구조!`); canvas.focus({ preventScroll: true }); } }
  const roster = document.createDocumentFragment();
  for (let i = 0; i < players.length; i++) {
    const p = players[i], row = document.createElement('div'); row.className = `roster-player${p.id === playerId ? ' me' : ''}${p.alive ? '' : ' eliminated'}`;
    row.dataset.playerId = p.id; row.dataset.team = p.team || (i === 0 ? 'blue' : 'pink'); row.dataset.character = p.characterId; row.dataset.skin = p.skinId; row.dataset.cell = `${p.x},${p.y}`; row.dataset.bot = String(p.isBot === true); row.dataset.connected = String(p.connected !== false);
    const dot = document.createElement('span'); dot.className = 'dot team-symbol'; dot.textContent = row.dataset.team === 'blue' ? 'B' : 'P'; dot.setAttribute('aria-label', row.dataset.team === 'blue' ? '블루 팀' : '핑크 팀');
    const name = document.createElement('span'); name.className = 'name'; name.textContent = `${p.name}${p.id === playerId ? ' (나)' : ''}`;
    const bot = document.createElement('small'); bot.className = 'bot-badge'; bot.textContent = 'AI'; bot.hidden = !p.isBot;
    const status = document.createElement('span'); status.className = 'player-state'; status.textContent = `${p.connected === false ? `연결 복귀 ${Math.ceil(numeric(p.reconnectRemainingMs) / 1000)}초` : p.bubbleTicks > 0 ? '구조 요청' : !p.alive ? ['relay','harmony'].includes(state.ruleSet) ? `복귀 ${Math.ceil(numeric(p.respawnTicks) / 10)}초` : '탈락' : state.relay?.carrierId === p.id ? '★ 별 운반' : names[p.characterId] || '준비'} · ${numeric(p.score)}점`;
    row.dataset.deliveries = String(numeric(p.deliveries)); row.dataset.respawnTicks = String(numeric(p.respawnTicks));
    row.append(dot, name, bot, status); roster.append(row);
  }
  $('roster').replaceChildren(roster);
}
function renderTraining() {
  const training = state?.training, view = viewModel.view.training;
  const disabled = connecting || Boolean(state && !(training && state.phase === 'finished'));
  for (const id of ['training-button','harmony-training-button','harmony-training-panel-button']) $(id).disabled = disabled;
  $('training-button').textContent = training && state.phase === 'finished' ? `${view.label} 다시 시작` : '구조 훈련 시작';
  $('training-progress').hidden = !training; $('training-progress').value = training?.completed || 0; $('training-progress').max=training?.total || 4;
  canvas.dataset.trainingMode = view?.mode || ''; canvas.dataset.trainingStage = training?.stage || ''; canvas.dataset.trainingStatus = training?.status || '';
  canvas.dataset.trainingFailure = training?.failureReason || '';
  canvas.dataset.trainingTarget = training?.target ? `${training.target.x},${training.target.y}` : '';
  const title = training ? `${training.step} / ${training.total} · ${training.title}` : '4단계 구조 · 하모니 훈련';
  const status = training ? `${view.progress} · 재도전 ${training.attempts}회${training.status === 'ready' ? ' · 설명을 읽고 이 단계 시작을 눌러 주세요.' : training.status === 'retrying' ? ' · 잠시 후 같은 단계를 다시 준비해요.' : training.status === 'complete' ? ' · 모든 훈련을 마쳤어요!' : ''}` : '구조: 회피 → 아이템 → 가까이 구출 → 다트 구출 / 하모니: 패스 → 가로채기 → 구출 충전 → 기지 전달';
  const instruction = training ? view.achievement ? view.achievement.text : view.instruction : state ? '방에서 나간 뒤 훈련을 시작할 수 있어요. 표시된 목표를 따라 직접 플레이하며 익혀요.' : '로그인 없이 시작해요. 각 단계 설명을 읽은 뒤 직접 조작하세요. 전적·랭킹에는 저장하지 않아요.';
  for (const [id, text] of [['training-title', title], ['training-status', status], ['training-instruction', instruction]]) if ($(id).textContent !== text) $(id).textContent = text;
}
function updateRelayStatus(players, me) {
  if (state.training) {
    const training = state.training, view=viewModel.view.training;
    $('relay-status').hidden = false; document.querySelector('.rescue-alert-slot').classList.add('has-relay');
    const heading = `${training.step}/${training.total} · ${training.title}${training.status === 'ready' ? ' · 시작 대기' : training.status === 'retrying' ? ' · 재도전' : ''}`;
    const charge = view.mode === 'harmony' && training.status === 'active' ? ` · 전달 ${view.deliveryValue}점` : '';
    const summary=view.achievement ? `${view.achievement.deliveredPoints}점 전달 · 패스 ${view.achievement.passes} · 구출 ${view.achievement.rescues}` : training.status === 'retrying' && view.failure ? view.failure : state.training.status === 'active' && viewModel.view.passHint ? viewModel.view.passHint : view.shortInstruction;
    const showingGuide=training.status === 'active' && Boolean(viewModel.view.passHint);
    const text = showingGuide ? `${heading}${charge}\n${summary}` : `${heading}\n${summary}${charge}`;
    if ($('relay-status').textContent !== text) $('relay-status').textContent = text;
    return;
  }
  const relay = state.relay, visible = ['relay','harmony'].includes(state.ruleSet) && Boolean(relay);
  $('relay-status').hidden = !visible; document.querySelector('.rescue-alert-slot').classList.toggle('has-relay', visible);
  if (!visible) return;
  const carrier = players.find(player => player.id === relay.carrierId);
  const objective = state.phase === 'finished' ? '별 전달 종료' : !me?.alive && state.phase === 'playing'
    ? numeric(me.respawnTicks) > 0 ? `복귀 ${Math.ceil(me.respawnTicks / 10)}초` : '시작 지점이 안전해지면 복귀'
    : carrier ? carrier.id === playerId ? `★ 우리 ${me.team === 'blue' ? 'B' : 'P'} 기지로!` : `★ ${carrier.name} 운반 중`
      : relay.star ? '중앙 별 → 우리 B / P 기지' : `별 재등장 ${Math.ceil(numeric(relay.respawnTicks) / 10)}초`;
  const charge = state.ruleSet === 'harmony' ? `충전 ${numeric(relay.charges?.passes)}패스+${numeric(relay.charges?.rescue)}구출 → ${viewModel.view.relay.deliveryValue}점` : `나 전달 ${numeric(me?.deliveries)}회`;
  const heading=`★ B ${numeric(relay.scores?.blue)} : ${numeric(relay.scores?.pink)} P · 목표 ${numeric(relay.goal)}점`;
  const guide=state.phase === 'playing' && relay.carrierId === playerId ? viewModel.view.passHint : '';
  const text = guide ? `${heading} · 전달 ${viewModel.view.relay.deliveryValue}점\n${guide}` : `${heading}\n${state.phase === 'playing' && relay.carrierId === playerId ? `${keyLabel(preferences.value.bindings.pass)} 패스 / 기지 전달` : objective} · ${charge}`;
  $('relay-status').title=charge;
  if ($('relay-status').textContent !== text) $('relay-status').textContent = text;
}
function updateRescueAlert(players, me) {
  const target = state.phase === 'playing' && me?.team ? players.filter(player => player.alive && player.bubbleTicks > 0 && player.team === me.team && player.id !== me.id).sort((a, b) => a.bubbleTicks - b.bubbleTicks)[0] : null;
  const alert = $('rescue-alert'); alert.hidden = !target;
  if (!target) return;
  // Whole seconds keep the live region readable instead of announcing every server tick.
  const text = ['relay','harmony'].includes(state.ruleSet)
    ? `구조 · ${target.name} · ${Math.ceil(target.bubbleTicks / 10)}초 · ${me.alive && !me.bubbleTicks ? '옆으로!' : '팀원 대기'}`
    : `구조 요청 · ${target.name} · ${Math.ceil(target.bubbleTicks / 10)}초 남음 · ${me.alive && !me.bubbleTicks ? '옆으로 다가가거나 다트를 쏘세요!' : '팀원의 구조를 기다리고 있어요.'}`;
  if (alert.textContent !== text) alert.textContent = text;
}
function sendInput(action) { if (!recovering && !connecting) viewModel.input(action); }
window.addEventListener('keydown', event => {
  if (bindingCapture) {
    event.preventDefault(); if (event.repeat) return;
    if (event.code === 'Escape') { cancelBindingCapture(); $('binding-status').textContent = '키 변경을 취소했어요.'; return; }
    const next = { ...preferences.value.bindings, [bindingCapture]: event.code }, check = validateBindings(next);
    if (event.altKey || event.ctrlKey || event.metaKey || !check.valid) { $('binding-status').textContent = '이미 사용 중인 키는 중복할 수 없어요. 영문·숫자·SPACE 중 다른 키를 선택하세요.'; return; }
    preferences.update({ bindings: next }); resetControls(); bindingCapture = null; renderPlaySettings(); $('binding-status').textContent = '조작 키를 저장했어요.'; return;
  }
  if (event.code === 'Escape') { event.preventDefault(); if ($('settings-dialog').open) closeSettings(); else openSettings(); return; }
  if (!viewModel.view.canInput) return;
  const action = actionForEvent(event, preferences.value.bindings);
  if (!action) return;
  event.preventDefault(); input.press(event);
});
window.addEventListener('keyup', event => input.release(event));
window.addEventListener('blur', cancelBindingCapture);
window.addEventListener('blur', resetControls); document.addEventListener('visibilitychange', resetControls);
for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('pointerdown', event => { event.preventDefault(); button.setPointerCapture(event.pointerId); const action = button.dataset.action; if (['place_orb','use_dart','pass_star'].includes(action)) { sendInput(action); } else { touchAction = action; sendInput(action); } });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, () => { if (touchAction === button.dataset.action) touchAction = null; });
  button.addEventListener('click', event => { if (event.detail === 0) sendInput(button.dataset.action); });
}
setInterval(() => { const action=touchAction || input.tick(); if (action && (!touchAction || preferences.value.movementMode === 'continuous')) sendInput(action); }, 80);
document.addEventListener('focusin', event => { if (event.target !== canvas && event.target.closest?.('input,select,textarea,button,a,[contenteditable]')) resetControls(); });
window.addEventListener('offline', () => { if (resumeRecord) beginRecovery(); });
window.addEventListener('online', () => { if (recovering && !socket && !resumeBusy) void tryResume(); });
window.addEventListener('pagehide', () => {
  suspended = true; operation++; clearTimeout(joinTimer); clearTimeout(retryTimer); resumeBusy = false; resetControls();
  const old = socket; socket = null; if (old) old.close();
});
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  suspended = false;
  if (resumeRecord) beginRecovery(); else disconnect();
});
setInterval(() => {
  if (suspended) return;
  if (recovering) {
    if (recovery.remaining() <= 0) { disconnect('연결을 복구하지 못했어요. 네트워크를 확인하고 새 경기를 시작해 주세요.', true, false); return; }
    renderRecovery();
  }
  if (socket?.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  if (now - lastMessageAt >= 12000) { beginRecovery(); return; }
  if (now - lastPingAt >= 5000) { socket.send(JSON.stringify({ type: 'ping' })); lastPingAt = now; }
}, 500);

// DOM view bindings: preferences and browser focus stay outside the ViewModel.
let settingsReturnFocus = null, settingsWasExpanded = false;
const settingsHome = $('play-settings-panel').parentElement;
function openSettings() {
  if ($('settings-dialog').open) return;
  resetControls(); cancelBindingCapture(); settingsReturnFocus=document.activeElement;
  settingsWasExpanded=!$('play-settings-panel').hidden;
  $('settings-dialog-content').append($('play-settings-panel')); $('play-settings-panel').hidden=false;
  viewModel.configure({modalOpen:true}); $('settings-dialog').showModal(); $('settings-close').focus();
}
function closeSettings() {
  if (!$('settings-dialog').open) return;
  $('settings-dialog').close();
}
$('settings-open').addEventListener('click',openSettings); $('settings-close').addEventListener('click',closeSettings);
$('settings-dialog').addEventListener('cancel',event=>{event.preventDefault();closeSettings();});
$('settings-dialog').addEventListener('close',()=>{
  resetControls(); cancelBindingCapture(); settingsHome.append($('play-settings-panel'));
  $('play-settings-panel').hidden=!settingsWasExpanded; viewModel.configure({modalOpen:false});
  if (settingsReturnFocus?.isConnected) settingsReturnFocus.focus({preventScroll:true});
});
for(const [id,key] of [['render-quality','quality'],['effect-level','effects'],['text-scale','fontScale'],['item-style','itemStyle'],['movement-mode','movementMode']]) $(id).addEventListener('change',()=>{
  resetControls();preferences.update({[key]:key==='fontScale'?Number($(id).value):$(id).value});renderPlaySettings();
});
$('pass-guide-toggle').addEventListener('change',()=>{preferences.update({passGuide:$('pass-guide-toggle').checked});renderPlaySettings();});
$('captions-toggle').addEventListener('change',()=>{preferences.update({captions:$('captions-toggle').checked});renderPlaySettings();});
$('key-preset').addEventListener('change',()=>{preferences.update({bindings:PRESETS[$('key-preset').value]});renderPlaySettings();});
$('focus-toggle').addEventListener('click',()=>{resetControls();preferences.update({focus:!preferences.value.focus});renderPlaySettings();});
$('fullscreen-toggle').addEventListener('click',async()=>{resetControls();await display.fullscreen();preferences.update({focus:document.body.classList.contains('arena-focus')});renderPlaySettings();});
for(const [id,method] of [['download-result-button','download'],['share-result-button','share']]) $(id).addEventListener('click',async()=>{
  $(id).disabled=true;try { const outcome=await resultSharing[method]();$('result-share-status').textContent=outcome.message; } finally { $(id).disabled=!createResultCardData(state,playerId); }
});
function renderPreview() {
  const preview=$('appearance-preview'),pc=preview.getContext('2d');pc.clearRect(0,0,240,140);
  pc.fillStyle='#ecf8f3';pc.fillRect(0,0,240,140);pc.save();pc.translate(77,77);pc.scale(1.7,1.7);
  drawAvatar(pc,{characterId:selected('characterId'),skinId:selected('skinId'),team:'blue'},{time:0,reducedMotion:true});pc.restore();
  pc.save();pc.translate(181,76);pc.scale(1.35,1.35);drawOrb(pc,{orbSkinId:$('orb-skin').value,fuse:20},{time:0,reducedMotion:true});pc.restore();
  $('map-description').textContent=MAPS.find(map=>map.id===selected('mapId'))?.description || '';
}
for(const option of document.querySelectorAll('.map-option')) {
  const mapId=option.querySelector('input').value, miniature=document.createElement('canvas'); miniature.width=130;miniature.height=110;miniature.className='map-art'; miniature.setAttribute('aria-hidden','true');
  const mc=miniature.getContext('2d'), layout=createLayout(mapId,'team');
  for(let x=0;x<13;x++)for(let y=0;y<11;y++){mc.fillStyle=layout.solid.has(`${x},${y}`)?'#477587':layout.soft.has(`${x},${y}`)?'#d9a574':'#d8ece4';mc.fillRect(x*10,(10-y)*10,9,9);}
  option.querySelector('.map-art').replaceWith(miniature);
}
renderPreview();
const arenaRenderer = createArenaRenderer({ canvas, display });
function draw(time) { arenaRenderer.draw(time, { ...viewModel.view, selection: selectionConfig(), reducedMotion: experience.reducedMotion }); requestAnimationFrame(draw); }
renderPlaySettings(); resetView(); requestAnimationFrame(draw); refreshLeaderboard();
canvas.dataset.connection = 'disconnected';
if (resumeRecord) {
  connecting = true; fields.disabled = true; $('join-button').disabled = true; $('practice-button').disabled = true; $('leave-button').hidden = false;
  document.body.classList.add('in-room'); showOverlay('이전 경기 확인 중', '같은 참가자로 복귀할 준비를 하고 있어요.');
}
fetch('/api/config', { cache: 'no-store', signal: AbortSignal.timeout(5000) }).then(response => { if (!response.ok) throw new Error(); return response.json(); }).then(value => {
  config = value; $('join-button').disabled = connecting || Boolean(playerId);
  if (config.allowDevGuests) { $('auth-note').textContent = '개발 게스트 대전 · 서버 임시 랭킹만 집계하며 계정 전적에는 저장하지 않아요.'; $('join-button').firstChild.textContent = '개발 게스트로 입장 '; }
  else $('auth-note').textContent = config.supabaseUrl && config.supabaseAnonKey ? '친구 대전은 익명 로그인으로 입장해요. 같은 탭에서는 계정을 유지해요.' : '친구 대전 로그인 설정 대기 · AI 연습은 지금 바로 시작할 수 있어요.';
  if (resumeRecord && !socket && !recovering && !suspended) beginRecovery();
  else if (!connecting && !playerId) setStatus('혼자라면 AI와 바로 연습! 친구 대전은 같은 방·맵·규칙으로 입장하세요.');
}).catch(() => {
  $('auth-note').textContent = '친구 대전 설정을 불러오지 못했어요. AI 연습은 바로 시도할 수 있어요.';
  if (resumeRecord && !socket && !recovering && !suspended) beginRecovery();
  else if (!connecting && !playerId) setStatus('AI 연습을 시작하거나, 친구 대전을 위해 페이지를 새로고침해 주세요.');
});
