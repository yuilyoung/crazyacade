import { createExperience } from './experience.js';
import { buildInviteUrl, parseInvite } from './invite.js';

const $ = id => document.getElementById(id);
const form = $('join-form'), fields = $('selection-fields'), canvas = $('arena'), ctx = canvas.getContext('2d');
const experience = createExperience($);
const names = { momo: '모모', nori: '노리', bibi: '비비', toto: '토토' };
const mapNames = { garden: '팝 가든', lagoon: '라군', candy: '캔디 타운' };
const colors = {
  garden: { floor: '#d9edc4', alternate: '#d1e7b9', wall: '#6eaaa0', wallTop: '#9acabc', box: '#e4b077', boxTop: '#f4d09c' },
  lagoon: { floor: '#ceeaf2', alternate: '#c0e2ec', wall: '#6298b5', wallTop: '#8fc3d6', box: '#d5b689', boxTop: '#f2d5a7' },
  candy: { floor: '#f1d5e4', alternate: '#edc9db', wall: '#a38aba', wallTop: '#c3afd9', box: '#e3a7b7', boxTop: '#ffd1dc' }
};
const errors = { unauthorized: '로그인을 확인할 수 없어요. 다시 입장해 주세요.', room_unavailable: '방이 가득 찼거나 경기가 진행 중이에요. 다른 방 이름을 입력해 주세요.', map_mismatch: '이 초대방은 다른 맵을 사용해요. 친구들과 같은 맵을 선택해 주세요.', already_in_room: '같은 계정이 이미 이 방에 있어요.', invalid_selection: '선택한 캐릭터·스킨·맵을 다시 확인해 주세요.', profile_unavailable: '프로필을 저장할 수 없어요. 잠시 후 다시 시도해 주세요.', authentication_unavailable: '로그인 서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.', invalid_mode: '대전 인원을 다시 선택해 주세요.', item_mode_mismatch: '이 초대방은 아이템전 설정이 달라요. 같은 규칙을 선택해 주세요.' };
errors.practice_unavailable = '연습방이 모두 사용 중이에요. 잠시 후 다시 시도해 주세요.';
errors.invalid_practice = '연습전 설정을 확인할 수 없어요. 다시 시도해 주세요.';
errors.invalid_rule_set = '승리 규칙을 다시 선택해 주세요.';
errors.rule_set_mismatch = '이 방의 승리 규칙이 달라요. 친구의 초대 링크로 같은 규칙을 선택해 주세요.';
errors.invalid_rule_mode = '팝 릴레이는 4대4 팀전에서 플레이할 수 있어요.';
let config, socket = null, playerId = null, state = null, connecting = false, operation = 0, lastPhase = null, localUserId = null;
let joinedRoomId = null, rematchRequested = false;
let movement = [], touchAction = null, lastMovement = 0, joinTimer, rankingRefreshTimer;
const tileImages = {};
for (const map of Object.keys(mapNames)) for (const type of ['wall', 'crate']) {
  const image = new Image(); image.src = `/assets/tiles/${map}-${type}.svg`; tileImages[`${map}-${type}`] = image;
}
const invitation = parseInvite(location.search);
$('room-id').value = invitation.roomId; $('mode').value = invitation.mode;
$('rule-set').value = invitation.ruleSet; $('item-mode').checked = invitation.itemMode;
form.querySelector(`input[name="mapId"][value="${invitation.mapId}"]`).checked = true;

function selected(name) { return form.querySelector(`input[name="${name}"]:checked`).value; }
function setStatus(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
function showOverlay(title, message) { $('arena-overlay').hidden = false; $('overlay-title').textContent = title; $('overlay-copy').textContent = message; }
function resetControls() { movement = []; touchAction = null; }
function selectedCapacity() { return $('mode').value === 'team' ? 8 : 2; }
function itemModeLabel(enabled) { return enabled ? '아이템전' : '기본전'; }
function numeric(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function selectionConfig() {
  return { roomId: $('room-id').value.trim(), mode: $('mode').value, mapId: selected('mapId'), itemMode: $('item-mode').checked, ruleSet: $('mode').value === 'duel' ? 'classic' : $('rule-set').value };
}
function updateRuleSelection() {
  const duel = $('mode').value === 'duel';
  if (duel) $('rule-set').value = 'classic';
  $('rule-set').disabled = duel;
  $('rule-help').textContent = $('rule-set').value === 'relay'
    ? '비랭크 4대4 · 중앙 별을 우리 팀 B / P 기지로 3번 전달하면 승리! 탈락해도 5초 후 복귀해요.'
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
function renderScoreboard(players) {
  const scores = state.result?.scoreboard || players;
  const rows = document.createDocumentFragment();
  [...scores].sort((a, b) => numeric(b.score) - numeric(a.score)).forEach((player, index) => {
    const row = document.createElement('div'); row.className = 'score-row'; row.dataset.team = player.team || '';
    const position = document.createElement('span'); position.textContent = String(index + 1).padStart(2, '0');
    const isBot = player.isBot ?? players.find(p => p.id === player.id)?.isBot;
    const name = document.createElement('strong'); name.textContent = `${player.team ? `${player.team === 'pink' ? 'P' : 'B'} · ` : ''}${player.name}${player.id === playerId ? ' (나)' : ''}${isBot ? ' · AI' : ''}`;
    const rescues = document.createElement('small'); rescues.className = 'rescue-score'; rescues.textContent = `${state.ruleSet === 'relay' ? `전달 ${numeric(player.deliveries)}회 · ` : ''}구조 ${numeric(player.rescues)}회`;
    const score = document.createElement('b'); score.textContent = `${numeric(player.score).toLocaleString()}점`;
    row.append(position, name, rescues, score); rows.append(row);
  });
  const me = scores.find(player => player.id === playerId), rescuers = scores.filter(player => numeric(player.rescues) > 0);
  const recognition = numeric(me?.rescues) > 0 ? `팀을 살린 나의 구조 ${numeric(me.rescues)}회!` : rescuers.length ? `구조로 팀을 지킨 플레이어: ${rescuers.map(player => `${player.name} ${numeric(player.rescues)}회`).join(', ')}` : '이번 판은 구조 0회 · 다음에는 버블 아군 옆으로 가서 팀을 구해 보세요.';
  $('rescue-recognition').textContent = `${state.ruleSet === 'relay' ? `팝 릴레이 · B ${numeric(state.result?.relayScores?.blue)} : ${numeric(state.result?.relayScores?.pink)} P · 비랭크, 전적과 랭킹에 저장하지 않아요. ` : state.practice ? 'AI 연습전 · 전적과 랭킹에 저장하지 않아요. ' : ''}${recognition}`;
  $('scoreboard-rows').replaceChildren(rows); $('match-scoreboard').hidden = false;
}
$('refresh-leaderboard').addEventListener('click', refreshLeaderboard);
function resetView() {
  state = null; playerId = null; localUserId = null; lastPhase = null; joinedRoomId = null; rematchRequested = false; canvas.dataset.phase = 'preview'; canvas.dataset.practice = 'false';
  updateRuleSelection(); canvas.dataset.ruleSet = $('rule-set').value; canvas.dataset.round = '0'; canvas.dataset.carrierId = '';
  experience.reset($('item-mode').checked, $('rule-set').value); $('match-kind').textContent = $('rule-set').value === 'relay' ? '팝 릴레이 · 비랭크' : '대전 준비';
  $('phase').textContent = '입장 준비'; $('timer').textContent = '02:00'; $('player-count').textContent = `0 / ${selectedCapacity()}명`;
  $('blue-count').textContent = '0'; $('pink-count').textContent = '0'; $('room-label').textContent = '입장 대기';
  $('player-stats').textContent = '물폭탄 1 · 파동 3 · 속도 1 · 다트 0 · 점수 0'; $('replay-button').hidden = true; $('replay-button').disabled = false;
  $('match-rules').textContent = itemModeLabel($('item-mode').checked); document.querySelector('.item-mode-toggle b').textContent = $('item-mode').checked ? 'ON' : 'OFF'; $('dart-count').textContent = '0'; $('dart-button').disabled = true; $('match-scoreboard').hidden = true;
  $('roster').replaceChildren(Object.assign(document.createElement('p'), { className: 'empty-state', textContent: '혼자라면 AI 연습전으로 바로 시작하세요. 입장하면 B 블루 / P 핑크 팀과 AI 표시를 볼 수 있어요.' }));
  showOverlay('준비됐나요?', 'AI와 바로 연습하거나 친구들과 같은 방에 입장하세요.');
  $('relay-status').hidden = true; document.querySelector('.rescue-alert-slot').classList.remove('has-relay');
  refreshInvite();
}
function disconnect(message = '방에서 나왔어요. 다시 준비해 주세요.', isError = false) {
  operation++; clearTimeout(joinTimer); clearTimeout(rankingRefreshTimer); const old = socket; socket = null; if (old) old.close();
  connecting = false; document.body.classList.remove('in-room'); fields.disabled = false; $('join-button').disabled = !config; $('practice-button').disabled = false; $('leave-button').hidden = true;
  resetControls(); resetView(); setStatus(message, isError);
}
async function authenticate() {
  if (config.allowDevGuests) { localUserId = null; return null; }
  if (!config.supabaseUrl || !config.supabaseAnonKey) throw new Error('로그인 설정이 아직 준비되지 않았어요. 서버 관리자에게 문의해 주세요.');
  const base = config.supabaseUrl.replace(/\/$/, ''), storageKey = `popPopBrowser:${base}`;
  let session;
  try { session = JSON.parse(sessionStorage.getItem(storageKey)); } catch { /* Storage may be unavailable. */ }
  if (session?.access_token && session.expires_at > Date.now() / 1000 + 60) { localUserId = session.user?.id; return session.access_token; }
  const refresh = session?.refresh_token;
  const response = await fetch(`${base}/auth/v1/${refresh ? 'token?grant_type=refresh_token' : 'signup'}`, {
    method: 'POST', headers: { apikey: config.supabaseAnonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(refresh ? { refresh_token: refresh } : { data: {} }), signal: AbortSignal.timeout(12000)
  });
  const payload = await response.json();
  if (!response.ok || !payload.access_token || !payload.refresh_token) throw new Error('로그인에 실패했어요. 네트워크와 익명 로그인 설정을 확인해 주세요.');
  payload.expires_at ||= Math.floor(Date.now() / 1000) + Number(payload.expires_in || 0);
  try { sessionStorage.setItem(storageKey, JSON.stringify(payload)); } catch { /* Authentication can proceed without storage. */ }
  localUserId = payload.user?.id; return payload.access_token;
}
async function join(practice = false) {
  if ((!practice && !config) || connecting || playerId) return;
  const attempt = ++operation;
  connecting = true; fields.disabled = true; $('join-button').disabled = true; $('practice-button').disabled = true;
  setStatus(practice ? 'AI 7명과 함께할 비랭크 연습방을 준비하고 있어요…' : '로그인하고 방을 찾고 있어요…');
  const selection = { characterId: selected('characterId'), skinId: selected('skinId'), mapId: selected('mapId'), mode: practice ? 'team' : $('mode').value, itemMode: $('item-mode').checked, ruleSet: $('rule-set').value };
  experience.reset(selection.itemMode, selection.ruleSet); refreshInvite();
  const roomId = $('room-id').value.trim() || `${selection.mode}-quick-${selection.mapId}-${selection.itemMode ? 'items' : 'basic'}-${selection.ruleSet}`;
  try {
    const accessToken = practice ? null : await authenticate(); if (attempt !== operation) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`); socket = ws;
    joinTimer = setTimeout(() => { if (socket === ws && !playerId) disconnect('연결 시간이 초과됐어요. 다시 시도해 주세요.', true); }, 15000);
    ws.addEventListener('open', () => { if (socket === ws) ws.send(JSON.stringify({ type: 'join', ...(practice ? { practice: true } : { roomId, accessToken }), name: $('nickname').value.trim() || 'Popper', ...selection })); });
    ws.addEventListener('message', event => {
      if (socket !== ws) return;
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'joined') {
        playerId = message.playerId; joinedRoomId = message.roomId; connecting = false; document.body.classList.add('in-room'); window.scrollTo({ top: 0, behavior: 'instant' }); clearTimeout(joinTimer); $('leave-button').hidden = false;
        setStatus(practice ? 'AI 연습전 · 전적과 랭킹에 저장하지 않아요.' : '입장했어요. 모두 모이면 자동으로 시작해요.'); $('room-label').textContent = practice ? '비공개 AI 연습방' : message.roomId;
      } else if (message.type === 'state' && playerId) {
        if (state && numeric(message.round) !== numeric(state.round)) {
          resetControls(); experience.reset(message.itemMode !== false, message.ruleSet); lastPhase = null; rematchRequested = false;
          $('match-scoreboard').hidden = true; $('replay-button').hidden = true; $('replay-button').disabled = false;
          clearTimeout(rankingRefreshTimer);
        }
        state = message; updateHud();
      }
      else if (message.type === 'error') disconnect(errors[message.code] || '방에 입장하지 못했어요. 다시 시도해 주세요.', true);
    });
    ws.addEventListener('close', () => { if (socket === ws) disconnect('연결이 끊겼어요. 다시 입장해 주세요.', true); });
    ws.addEventListener('error', () => { if (socket === ws) disconnect('대전 서버에 연결할 수 없어요. 다시 시도해 주세요.', true); });
  } catch (error) { if (attempt === operation) disconnect(error.name === 'TimeoutError' ? '로그인 시간이 초과됐어요. 다시 시도해 주세요.' : error.message, true); }
}
form.addEventListener('submit', event => { event.preventDefault(); void join(); });
$('practice-button').addEventListener('click', () => { void join(true); });
$('leave-button').addEventListener('click', () => disconnect());
$('replay-button').addEventListener('click', () => {
  if (state?.phase !== 'finished') return;
  if (state.practice) { disconnect('새 연습전을 준비하고 있어요.'); void join(true); return; }
  if (rematchRequested || socket?.readyState !== WebSocket.OPEN) return;
  rematchRequested = true; $('replay-button').disabled = true;
  socket.send(JSON.stringify({ type: 'rematch' }));
  setStatus('재대결 준비 완료! 방에 연결된 친구들이 모두 준비하면 다음 라운드를 시작해요.');
});
form.addEventListener('change', () => { if (!state) { updateRuleSelection(); resetView(); } });
function updateHud() {
  const players = state.players || [], capacity = state.mode === 'team' ? 8 : 2, me = players.find(p => p.id === playerId);
  canvas.dataset.phase = state.phase; canvas.dataset.map = state.mapId; canvas.dataset.itemMode = String(state.itemMode !== false);
  canvas.dataset.practice = String(state.practice === true); canvas.dataset.ruleSet = state.ruleSet || 'classic'; canvas.dataset.round = String(numeric(state.round)); canvas.dataset.carrierId = state.relay?.carrierId || '';
  $('match-kind').textContent = state.ruleSet === 'relay' ? `${state.practice ? 'AI ' : '팝 '}릴레이 · 비랭크` : state.practice ? 'AI 연습 · 비랭크' : config?.allowDevGuests ? '친구 대전 · 개발 게스트' : '친구 대전';
  refreshInvite();
  experience.update(state, me);
  $('match-rules').textContent = itemModeLabel(state.itemMode !== false);
  $('phase').textContent = state.phase === 'playing' ? '대전 중' : state.phase === 'finished' ? '경기 종료' : '참가자 대기';
  const seconds = Math.ceil((state.remaining || 0) / 10); $('timer').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  $('player-count').textContent = state.practice ? `나 + AI ${players.filter(player => player.isBot).length}명` : `${players.length} / ${capacity}명`;
  $('blue-count').textContent = players.filter((p, i) => p.alive && (state.mode === 'team' ? p.team === 'blue' : i === 0)).length;
  $('pink-count').textContent = players.filter((p, i) => p.alive && (state.mode === 'team' ? p.team === 'pink' : i === 1)).length;
  if (me) {
    $('player-stats').textContent = `${me.bubbleTicks > 0 ? '🫧 구조 요청 · ' : !me.alive ? state.ruleSet === 'relay' ? '복귀 대기 · ' : '관전 중 · ' : ''}물폭탄 ${me.maxOrbs} · 파동 ${me.range} · 속도 ${numeric(me.speedLevel) + 1} · 다트 ${numeric(me.darts)} · 핀 ${me.pin ? '✓' : '—'} · 구조 ${numeric(me.rescues)}회 · ${numeric(me.score)}점`;
    $('dart-count').textContent = String(numeric(me.darts));
    $('dart-button').disabled = state.phase !== 'playing' || !me.alive || me.bubbleTicks > 0 || !me.darts;
  }
  updateRelayStatus(players, me); updateRescueAlert(players, me);
  if (state.phase === 'waiting') showOverlay(`${players.length} / ${capacity}명 준비 완료`, `${mapNames[state.mapId] || state.mapId} · 친구들을 기다리고 있어요.\n같은 방 이름·맵·규칙으로 입장하세요.\n혼자 바로 시작하려면 방을 나가 AI 연습을 선택하세요.`);
  else if (state.phase === 'finished') {
    let title = '경기 종료!';
    if (state.result?.draw) title = '무승부!';
    else if (state.result?.winnerTeam) title = `${state.result.winnerTeam === 'blue' ? '블루' : '핑크'} 팀 승리!`;
    else if (localUserId && state.result?.winnerId) title = state.result.winnerId === localUserId ? '승리했어요!' : '다음 판에 다시 도전!';
    const ready = state.rematch?.readyPlayerIds || [], total = numeric(state.rematch?.total) || players.length;
    const ownReady = rematchRequested || ready.includes(playerId);
    const readyText = `재대결 준비 ${ready.length} / ${total}명${ownReady ? ' · 나는 준비 완료' : ' · 모두 준비하면 같은 방에서 시작해요.'}`;
    const relayResult = state.ruleSet === 'relay' ? `별 전달 B ${numeric(state.result?.relayScores?.blue)} : ${numeric(state.result?.relayScores?.pink)} P · 비랭크\n` : '';
    showOverlay(title, `${relayResult}${state.practice ? 'AI 연습전 완료 · 전적과 랭킹에 저장하지 않아요.\n아래에서 점수와 구조 기여를 확인하세요.' : `아래에서 이번 경기 기여를 확인하세요.\n${readyText}`}`);
    $('replay-button').textContent = state.practice ? '연습 바로 다시 시작' : `${ownReady ? '준비 완료' : '재대결 준비'} ${ready.length}/${total}`;
    $('replay-button').disabled = !state.practice && ownReady; $('replay-button').hidden = false; renderScoreboard(players); resetControls();
  } else { $('arena-overlay').hidden = true; }
  if (state.phase !== lastPhase) { if (state.phase === 'finished' && !state.practice && state.ruleSet !== 'relay') { clearTimeout(rankingRefreshTimer); rankingRefreshTimer = setTimeout(refreshLeaderboard, 1000); } lastPhase = state.phase; if (state.phase === 'playing') { setStatus(state.ruleSet === 'relay' ? '팝 릴레이 · 비랭크! 중앙 별을 우리 팀 B / P 기지로 3번 전달하세요. 탈락하면 5초 후 복귀해요.' : `${state.practice ? 'AI 연습 · 비랭크! ' : '시작! '}화살표와 ‘나’ 표시를 찾아 움직여 보세요. 버블 아군 옆으로 가면 구조!`); canvas.focus({ preventScroll: true }); } }
  const roster = document.createDocumentFragment();
  for (let i = 0; i < players.length; i++) {
    const p = players[i], row = document.createElement('div'); row.className = `roster-player${p.id === playerId ? ' me' : ''}${p.alive ? '' : ' eliminated'}`;
    row.dataset.playerId = p.id; row.dataset.team = p.team || (i === 0 ? 'blue' : 'pink'); row.dataset.character = p.characterId; row.dataset.skin = p.skinId; row.dataset.cell = `${p.x},${p.y}`; row.dataset.bot = String(p.isBot === true);
    const dot = document.createElement('span'); dot.className = 'dot team-symbol'; dot.textContent = row.dataset.team === 'blue' ? 'B' : 'P'; dot.setAttribute('aria-label', row.dataset.team === 'blue' ? '블루 팀' : '핑크 팀');
    const name = document.createElement('span'); name.className = 'name'; name.textContent = `${p.name}${p.id === playerId ? ' (나)' : ''}`;
    const bot = document.createElement('small'); bot.className = 'bot-badge'; bot.textContent = 'AI'; bot.hidden = !p.isBot;
    const status = document.createElement('span'); status.className = 'player-state'; status.textContent = `${p.bubbleTicks > 0 ? '구조 요청' : !p.alive ? state.ruleSet === 'relay' ? `복귀 ${Math.ceil(numeric(p.respawnTicks) / 10)}초` : '탈락' : state.relay?.carrierId === p.id ? '★ 별 운반' : names[p.characterId] || '준비'} · ${numeric(p.score)}점`;
    row.dataset.deliveries = String(numeric(p.deliveries)); row.dataset.respawnTicks = String(numeric(p.respawnTicks));
    row.append(dot, name, bot, status); roster.append(row);
  }
  $('roster').replaceChildren(roster);
}
function updateRelayStatus(players, me) {
  const relay = state.relay, visible = state.ruleSet === 'relay' && Boolean(relay);
  $('relay-status').hidden = !visible; document.querySelector('.rescue-alert-slot').classList.toggle('has-relay', visible);
  if (!visible) return;
  const carrier = players.find(player => player.id === relay.carrierId);
  const objective = state.phase === 'finished' ? '별 전달 종료' : !me?.alive && state.phase === 'playing'
    ? numeric(me.respawnTicks) > 0 ? `복귀 ${Math.ceil(me.respawnTicks / 10)}초` : '시작 지점이 안전해지면 복귀'
    : carrier ? carrier.id === playerId ? `★ 우리 ${me.team === 'blue' ? 'B' : 'P'} 기지로!` : `★ ${carrier.name} 운반 중`
      : relay.star ? '중앙 별 → 우리 B / P 기지' : `별 재등장 ${Math.ceil(numeric(relay.respawnTicks) / 10)}초`;
  const text = `★ B ${numeric(relay.scores?.blue)} : ${numeric(relay.scores?.pink)} P · 먼저 ${numeric(relay.goal)}번 전달\n${objective} · 나 전달 ${numeric(me?.deliveries)}회`;
  if ($('relay-status').textContent !== text) $('relay-status').textContent = text;
}
function updateRescueAlert(players, me) {
  const target = state.phase === 'playing' && me?.team ? players.filter(player => player.alive && player.bubbleTicks > 0 && player.team === me.team && player.id !== me.id).sort((a, b) => a.bubbleTicks - b.bubbleTicks)[0] : null;
  const alert = $('rescue-alert'); alert.hidden = !target;
  if (!target) return;
  // Whole seconds keep the live region readable instead of announcing every server tick.
  const text = state.ruleSet === 'relay'
    ? `구조 · ${target.name} · ${Math.ceil(target.bubbleTicks / 10)}초 · ${me.alive && !me.bubbleTicks ? '옆으로!' : '팀원 대기'}`
    : `구조 요청 · ${target.name} · ${Math.ceil(target.bubbleTicks / 10)}초 남음 · ${me.alive && !me.bubbleTicks ? '옆으로 다가가거나 다트를 쏘세요!' : '팀원의 구조를 기다리고 있어요.'}`;
  if (alert.textContent !== text) alert.textContent = text;
}
function sendInput(action) {
  const me = state?.players?.find(p => p.id === playerId);
  if (socket?.readyState !== WebSocket.OPEN || state?.phase !== 'playing' || !me?.alive || me.bubbleTicks > 0) return;
  socket.send(JSON.stringify({ type: 'input', action }));
}
const keys = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right' };
window.addEventListener('keydown', event => {
  if (event.target.closest('input,select,textarea,button,a,[contenteditable="true"]') || event.altKey || event.ctrlKey || event.metaKey || state?.phase !== 'playing') return;
  const action = keys[event.key] || keys[event.key.toLowerCase()];
  if (action) { event.preventDefault(); if (!event.repeat && !movement.includes(action)) { movement.push(action); sendInput(action); lastMovement = performance.now(); } }
  if (event.code === 'Space') { event.preventDefault(); if (!event.repeat) { sendInput('place_orb'); } }
  if (event.code === 'KeyF') { event.preventDefault(); if (!event.repeat) sendInput('use_dart'); }
});
window.addEventListener('keyup', event => { const action = keys[event.key] || keys[event.key.toLowerCase()]; movement = movement.filter(a => a !== action); });
window.addEventListener('blur', resetControls); document.addEventListener('visibilitychange', resetControls);
for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('pointerdown', event => { event.preventDefault(); button.setPointerCapture(event.pointerId); const action = button.dataset.action; if (action === 'place_orb' || action === 'use_dart') { sendInput(action); } else { touchAction = action; sendInput(action); lastMovement = performance.now(); } });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, () => { if (touchAction === button.dataset.action) touchAction = null; });
  button.addEventListener('click', event => { if (event.detail === 0) sendInput(button.dataset.action); });
}
window.addEventListener('pagehide', () => { if (socket) socket.close(); });

const tile = 60;
function roundRect(x, y, w, h, radius, fill, stroke) { ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); } }
function circle(x, y, r, fill, stroke) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); } }
function point(x, y) { return { x: x * tile + tile / 2, y: (10 - y) * tile + tile / 2 }; }
function drawStar(x, y, radius = 20) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const angle = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? radius * .45 : radius;
    const px = x + Math.cos(angle) * r, py = y + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath(); ctx.fillStyle = '#ffe482'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#875b13'; ctx.stroke();
}
function drawRelayBases(relay) {
  if (!relay) return;
  for (const [team, base] of Object.entries(relay.bases)) {
    const q = point(base.x, base.y), blue = team === 'blue';
    roundRect(q.x - 27, q.y - 26, 54, 52, 11, blue ? '#d5edff' : '#ffe1ed', blue ? '#175883' : '#8d2e54');
    ctx.fillStyle = blue ? '#175883' : '#8d2e54'; ctx.font = 'bold 12px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(`${blue ? 'B' : 'P'} 기지`, q.x, q.y + 23);
    ctx.font = 'bold 23px system-ui'; ctx.fillText('⌂', q.x, q.y + 3);
  }
}
function previewSoft(mapId) {
  const cells = [];
  for (let x = 1; x < 12; x++) for (let y = 1; y < 10; y++) {
    if ((x % 2 === 0 && y % 2 === 0) || x <= 2 || x >= 10) continue;
    if (mapId === 'garden' ? (x + y * 3) % 4 === 0 : mapId === 'lagoon' ? (x * 3 + y) % 5 === 0 : (x * 2 + y * 3) % 5 === 1) cells.push(`${x},${y}`);
  }
  return $('rule-set').value === 'relay' ? cells.filter(cell => {
    const [x, y] = cell.split(',').map(Number);
    return [[6, 5], [1, 5], [11, 5]].every(([bx, by]) => Math.abs(x - bx) + Math.abs(y - by) > 1);
  }) : cells;
}
function drawPlayer(p, time, index) {
  const q = point(p.x, p.y), me = p.id === playerId, blue = p.team ? p.team === 'blue' : index === 0;
  if (!p.alive) return;
  ctx.save(); ctx.translate(q.x, q.y);
  ctx.fillStyle = '#25444325'; ctx.beginPath(); ctx.ellipse(0, 20, 22, 7, 0, 0, Math.PI * 2); ctx.fill();
  if (me && p.facing && p.darts > 0) {
    const angle = { right: 0, up: -Math.PI / 2, left: Math.PI, down: Math.PI / 2 }[p.facing] ?? 0;
    ctx.save(); ctx.rotate(angle); ctx.fillStyle = '#f9c454'; ctx.beginPath(); ctx.moveTo(29, -5); ctx.lineTo(38, 0); ctx.lineTo(29, 5); ctx.fill(); ctx.restore();
  }
  if (me) { circle(0, 3, 26, null, '#ffe581'); ctx.fillStyle = '#ffe581'; ctx.beginPath(); ctx.moveTo(-6, -37); ctx.lineTo(6, -37); ctx.lineTo(0, -29); ctx.fill(); }
  const skin = p.skinId === 'sunset' ? '#ffab7d' : p.skinId === 'mint' ? '#91ead5' : '#fff1b7';
  const body = blue ? '#66bafa' : '#f594b5';
  roundRect(-17, -17, 34, 35, p.characterId === 'toto' ? 9 : 14, body, blue ? '#3d99d7' : '#df6d97');
  if (p.characterId === 'bibi') { roundRect(-14, -31, 8, 19, 4, skin); roundRect(6, -31, 8, 19, 4, skin); }
  else if (p.characterId === 'nori') { ctx.fillStyle = skin; ctx.beginPath(); ctx.ellipse(0, -17, 24, 7, 0, 0, Math.PI * 2); ctx.fill(); circle(0, -22, 12, skin); }
  else if (p.characterId === 'toto') roundRect(-20, -23, 40, 11, 4, skin);
  else { circle(0, -21, 11, skin); circle(0, -23, 4, '#ffffff8f'); }
  roundRect(-13, -5, 26, 19, 8, '#fff1d9'); circle(-5, 1, 2, '#263f4a'); circle(5, 1, 2, '#263f4a');
  ctx.strokeStyle = '#cb9b8b'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(0, 5, 3, 0, Math.PI); ctx.stroke();
  roundRect(-15, 17, 11, 5, 3, blue ? '#338ac6' : '#d3638e'); roundRect(4, 17, 11, 5, 3, blue ? '#338ac6' : '#d3638e');
  circle(20, 17, 8, blue ? '#175883' : '#8d2e54', '#fff'); ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = '#fff'; ctx.fillText(blue ? 'B' : 'P', 20, 21);
  if (p.pin) circle(20, -15, 5, '#ffe6a1', '#d9aa56');
  if (state?.relay?.carrierId === p.id) {
    drawStar(22, -25, 11); roundRect(-18, -48, 36, 14, 4, '#fff4bf', '#875b13');
    ctx.font = 'bold 10px system-ui'; ctx.fillStyle = '#704600'; ctx.textAlign = 'center'; ctx.fillText('별 운반', 0, -37);
  }
  if (p.bubbleTicks > 0) {
    circle(0, 0, 27 + (experience.reducedMotion ? 0 : Math.sin(time / 100) * 2), '#b6eaff88', '#e5faff'); circle(-12, -13, 6, '#ffffffbb'); ctx.fillStyle = '#194c65'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center'; ctx.fillText(`${(p.bubbleTicks / 10).toFixed(1)}`, 0, 4);
    if (!me && p.team && p.team === state?.players.find(player => player.id === playerId)?.team) { roundRect(-20, -39, 40, 16, 4, '#fff1c3'); ctx.fillStyle = '#704600'; ctx.fillText('+ 구조', 0, -27); }
  }
  ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = '#264d54'; ctx.fillText(me ? `${p.name} · 나` : p.name, 0, 38, 68);
  ctx.restore();
}
function draw(time) {
  const mapId = state?.mapId || selected('mapId'), theme = colors[mapId] || colors.garden;
  const relay = state?.relay || (!state && $('rule-set').value === 'relay' ? { star: { x: 6, y: 5 }, bases: { blue: { x: 1, y: 5 }, pink: { x: 11, y: 5 } } } : null);
  ctx.clearRect(0, 0, 780, 660);
  for (let x = 0; x < 13; x++) for (let y = 0; y < 11; y++) {
    const q = point(x, y); ctx.fillStyle = (x + y) % 2 ? theme.floor : theme.alternate; ctx.fillRect(q.x - 30, q.y - 30, 60, 60);
    if (x === 0 || y === 0 || x === 12 || y === 10 || (x % 2 === 0 && y % 2 === 0)) {
      const texture = tileImages[`${mapId}-wall`];
      if (texture?.complete && texture.naturalWidth) ctx.drawImage(texture, q.x - 30, q.y - 30, 60, 60);
      else { roundRect(q.x - 28, q.y - 25, 56, 53, 8, theme.wall); roundRect(q.x - 28, q.y - 30, 56, 47, 8, theme.wallTop); roundRect(q.x - 21, q.y - 24, 42, 5, 3, '#ffffff30'); }
    }
  }
  for (const cell of state?.soft || previewSoft(mapId)) {
    const [x, y] = cell.split(',').map(Number), q = point(x, y);
    const texture = tileImages[`${mapId}-crate`];
    if (texture?.complete && texture.naturalWidth) { ctx.drawImage(texture, q.x - 30, q.y - 30, 60, 60); continue; }
    roundRect(q.x - 23, q.y - 19, 46, 44, 7, theme.box); roundRect(q.x - 23, q.y - 25, 46, 38, 7, theme.boxTop);
    ctx.strokeStyle = theme.box; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(q.x - 14, q.y - 16); ctx.lineTo(q.x + 14, q.y + 5); ctx.moveTo(q.x + 14, q.y - 16); ctx.lineTo(q.x - 14, q.y + 5); ctx.stroke();
  }
  drawRelayBases(relay);
  const symbols = { orb: '+', wave: '↔', dash: '»', speed: '»', pin: '✧', dart: '↗' }, itemColors = { orb: '#75e0c7', wave: '#ffd778', dash: '#9abfff', speed: '#9abfff', pin: '#f9a4c4', dart: '#f8be76' };
  for (const item of state?.items || []) { const q = point(item.x, item.y); circle(q.x, q.y, 17, '#fff', '#ffffff'); circle(q.x, q.y, 14, itemColors[item.type] || '#fff'); ctx.fillStyle = '#355565'; ctx.font = 'bold 24px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(symbols[item.type] || '?', q.x, q.y); ctx.textBaseline = 'alphabetic'; }
  for (const orb of state?.orbs || []) { const q = point(orb.x, orb.y), radius = 18 + (experience.reducedMotion ? 0 : Math.sin(time / (orb.fuse < 8 ? 60 : 130)) * 2); circle(q.x, q.y + 6, radius + 2, '#24536c25'); const gradient = ctx.createRadialGradient(q.x - 7, q.y - 7, 1, q.x, q.y, radius); gradient.addColorStop(0, '#e0ffff'); gradient.addColorStop(.4, '#77dfef'); gradient.addColorStop(1, '#36a9d3'); circle(q.x, q.y, radius, gradient, '#e3fcff'); roundRect(q.x - 4, q.y - radius - 4, 8, 7, 3, '#6ce6c3'); }
  for (const wave of state?.waves || []) { const q = point(wave.x, wave.y); roundRect(q.x - 29, q.y - 27, 58, 54, 13, '#87eaffbb'); circle(q.x - 8, q.y - 7, 13, '#efffffaa'); circle(q.x + 13, q.y + 8, 8, '#e1ffffbb'); }
  for (const dart of state?.dartEffects || []) {
    const from = point(dart.x, dart.y), to = point(dart.x + dart.dx * dart.length, dart.y + dart.dy * dart.length);
    ctx.save(); ctx.globalAlpha = Math.min(1, (dart.ttl || 1) / 3); ctx.strokeStyle = '#fff2a8'; ctx.lineWidth = 5; ctx.setLineDash([8, 5]);
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke(); ctx.setLineDash([]);
    ctx.translate(to.x, to.y); ctx.rotate(Math.atan2(-dart.dy, dart.dx)); ctx.fillStyle = '#e9ae4e'; ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-6, -6); ctx.lineTo(-6, 6); ctx.fill(); ctx.restore();
  }
  if (relay?.star) {
    const q = point(relay.star.x, relay.star.y);
    circle(q.x, q.y, 25, '#ffffffa8'); drawStar(q.x, q.y - 3);
    ctx.fillStyle = '#704600'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center'; ctx.fillText('별', q.x, q.y + 24);
  }
  (state?.players || []).forEach((p, i) => drawPlayer(p, time, i));
  const action = touchAction || movement.at(-1);
  if (action && time - lastMovement >= 80) { sendInput(action); lastMovement = time; }
  requestAnimationFrame(draw);
}
resetView(); requestAnimationFrame(draw); refreshLeaderboard();
fetch('/api/config', { cache: 'no-store' }).then(response => { if (!response.ok) throw new Error(); return response.json(); }).then(value => {
  config = value; $('join-button').disabled = connecting || Boolean(playerId);
  if (config.allowDevGuests) { $('auth-note').textContent = '개발 게스트 대전 · 서버 임시 랭킹만 집계하며 계정 전적에는 저장하지 않아요.'; $('join-button').firstChild.textContent = '개발 게스트로 입장 '; }
  else $('auth-note').textContent = config.supabaseUrl && config.supabaseAnonKey ? '친구 대전은 익명 로그인으로 입장해요. 같은 탭에서는 계정을 유지해요.' : '친구 대전 로그인 설정 대기 · AI 연습은 지금 바로 시작할 수 있어요.';
  if (!connecting && !playerId) setStatus('혼자라면 AI와 바로 연습! 친구 대전은 같은 방·맵·규칙으로 입장하세요.');
}).catch(() => {
  $('auth-note').textContent = '친구 대전 설정을 불러오지 못했어요. AI 연습은 바로 시도할 수 있어요.';
  if (!connecting && !playerId) setStatus('AI 연습을 시작하거나, 친구 대전을 위해 페이지를 새로고침해 주세요.');
});
