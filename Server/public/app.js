const $ = id => document.getElementById(id);
const form = $('join-form'), fields = $('selection-fields'), canvas = $('arena'), ctx = canvas.getContext('2d');
const names = { momo: '모모', nori: '노리', bibi: '비비', toto: '토토' };
const mapNames = { garden: '팝 가든', lagoon: '라군', candy: '캔디 타운' };
const colors = {
  garden: { floor: '#d9edc4', alternate: '#d1e7b9', wall: '#6eaaa0', wallTop: '#9acabc', box: '#e4b077', boxTop: '#f4d09c' },
  lagoon: { floor: '#ceeaf2', alternate: '#c0e2ec', wall: '#6298b5', wallTop: '#8fc3d6', box: '#d5b689', boxTop: '#f2d5a7' },
  candy: { floor: '#f1d5e4', alternate: '#edc9db', wall: '#a38aba', wallTop: '#c3afd9', box: '#e3a7b7', boxTop: '#ffd1dc' }
};
const errors = { unauthorized: '로그인을 확인할 수 없어요. 다시 입장해 주세요.', room_unavailable: '방이 가득 찼거나 경기가 진행 중이에요. 다른 방 이름을 입력해 주세요.', map_mismatch: '이 초대방은 다른 맵을 사용해요. 친구들과 같은 맵을 선택해 주세요.', already_in_room: '같은 계정이 이미 이 방에 있어요.', invalid_selection: '선택한 캐릭터·스킨·맵을 다시 확인해 주세요.', profile_unavailable: '프로필을 저장할 수 없어요. 잠시 후 다시 시도해 주세요.', authentication_unavailable: '로그인 서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.', invalid_mode: '대전 인원을 다시 선택해 주세요.' };
let config, socket = null, playerId = null, state = null, connecting = false, operation = 0, lastPhase = null, localUserId = null;
let movement = [], touchAction = null, lastMovement = 0, joinTimer;
const params = new URLSearchParams(location.search);
if (params.get('room')) $('room-id').value = params.get('room').slice(0, 64);
if (['duel', 'team'].includes(params.get('mode'))) $('mode').value = params.get('mode');

function selected(name) { return form.querySelector(`input[name="${name}"]:checked`).value; }
function setStatus(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
function showOverlay(title, message) { $('arena-overlay').hidden = false; $('overlay-title').textContent = title; $('overlay-copy').textContent = message; }
function resetControls() { movement = []; touchAction = null; }
function selectedCapacity() { return $('mode').value === 'team' ? 8 : 2; }
function resetView() {
  state = null; playerId = null; localUserId = null; lastPhase = null; canvas.dataset.phase = 'preview';
  $('phase').textContent = '입장 준비'; $('timer').textContent = '02:00'; $('player-count').textContent = `0 / ${selectedCapacity()}명`;
  $('blue-count').textContent = '0'; $('pink-count').textContent = '0'; $('room-label').textContent = '입장 대기';
  $('player-stats').textContent = '오브 1 · 파동 3 · 대시 — · 핀 —'; $('replay-button').hidden = true;
  $('roster').replaceChildren(Object.assign(document.createElement('p'), { className: 'empty-state', textContent: '아레나에 입장하면 우리 팀과 상대 팀이 표시돼요.' }));
  showOverlay('준비됐나요?', '캐릭터를 고르고 친구들과 입장하세요.');
}
function disconnect(message = '방에서 나왔어요. 다시 준비해 주세요.', isError = false) {
  operation++; clearTimeout(joinTimer); const old = socket; socket = null; if (old) old.close();
  connecting = false; document.body.classList.remove('in-room'); fields.disabled = false; $('join-button').disabled = !config; $('leave-button').hidden = true;
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
form.addEventListener('submit', async event => {
  event.preventDefault(); if (!config || connecting || playerId) return;
  const attempt = ++operation;
  connecting = true; fields.disabled = true; $('join-button').disabled = true; setStatus('로그인하고 방을 찾고 있어요…');
  const selection = { characterId: selected('characterId'), skinId: selected('skinId'), mapId: selected('mapId'), mode: $('mode').value };
  const roomId = $('room-id').value.trim() || `${selection.mode}-quick-${selection.mapId}`;
  try {
    const accessToken = await authenticate(); if (attempt !== operation) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`); socket = ws;
    joinTimer = setTimeout(() => { if (socket === ws && !playerId) disconnect('연결 시간이 초과됐어요. 다시 시도해 주세요.', true); }, 15000);
    ws.addEventListener('open', () => { if (socket === ws) ws.send(JSON.stringify({ type: 'join', roomId, name: $('nickname').value.trim() || 'Popper', ...selection, accessToken })); });
    ws.addEventListener('message', event => {
      if (socket !== ws) return;
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'joined') {
        playerId = message.playerId; connecting = false; document.body.classList.add('in-room'); window.scrollTo({ top: 0, behavior: 'instant' }); clearTimeout(joinTimer); $('leave-button').hidden = false;
        setStatus('입장했어요. 모두 모이면 자동으로 시작해요.'); $('room-label').textContent = message.roomId;
      } else if (message.type === 'state' && playerId) { state = message; updateHud(); }
      else if (message.type === 'error') disconnect(errors[message.code] || '방에 입장하지 못했어요. 다시 시도해 주세요.', true);
    });
    ws.addEventListener('close', () => { if (socket === ws) disconnect('연결이 끊겼어요. 다시 입장해 주세요.', true); });
    ws.addEventListener('error', () => { if (socket === ws) disconnect('대전 서버에 연결할 수 없어요. 다시 시도해 주세요.', true); });
  } catch (error) { if (attempt === operation) disconnect(error.name === 'TimeoutError' ? '로그인 시간이 초과됐어요. 다시 시도해 주세요.' : error.message, true); }
});
$('leave-button').addEventListener('click', () => disconnect());
$('replay-button').addEventListener('click', () => { disconnect('다시 준비해 주세요. 이전 방에 참가자가 남아 있으면 새 방 이름으로 입장할 수 있어요.'); $('setup-title').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
form.addEventListener('change', () => { if (!state) resetView(); });
function updateHud() {
  const players = state.players || [], capacity = state.mode === 'team' ? 8 : 2, me = players.find(p => p.id === playerId);
  canvas.dataset.phase = state.phase; canvas.dataset.map = state.mapId;
  $('phase').textContent = state.phase === 'playing' ? '대전 중' : state.phase === 'finished' ? '경기 종료' : '참가자 대기';
  const seconds = Math.ceil((state.remaining || 0) / 10); $('timer').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  $('player-count').textContent = `${players.length} / ${capacity}명`;
  $('blue-count').textContent = players.filter((p, i) => p.alive && (state.mode === 'team' ? p.team === 'blue' : i === 0)).length;
  $('pink-count').textContent = players.filter((p, i) => p.alive && (state.mode === 'team' ? p.team === 'pink' : i === 1)).length;
  if (me) $('player-stats').textContent = `${me.bubbleTicks > 0 ? '🫧 구조를 기다려요 · ' : !me.alive ? '관전 중 · ' : ''}오브 ${me.maxOrbs} · 파동 ${me.range} · 대시 ${me.dash ? '✓' : '—'} · 핀 ${me.pin ? '✓' : '—'}`;
  if (state.phase === 'waiting') showOverlay(`${players.length} / ${capacity}명 준비 완료`, `${mapNames[state.mapId] || state.mapId} · 친구들을 기다리고 있어요.\n같은 방 이름과 맵으로 입장하세요.`);
  else if (state.phase === 'finished') {
    let title = '경기 종료!';
    if (state.result?.draw) title = '무승부!';
    else if (state.result?.winnerTeam) title = `${state.result.winnerTeam === 'blue' ? '블루' : '핑크'} 팀 승리!`;
    else if (localUserId && state.result?.winnerId) title = state.result.winnerId === localUserId ? '승리했어요!' : '다음 판에 다시 도전!';
    showOverlay(title, '멋진 팀워크였어요. 다시 준비하고 한 판 더!'); $('replay-button').hidden = false; resetControls();
  } else { $('arena-overlay').hidden = true; }
  if (state.phase !== lastPhase) { lastPhase = state.phase; if (state.phase === 'playing') { setStatus('시작! 노란 표시가 나예요. 물폭탄을 놓고 버블 아군을 구해 주세요.'); canvas.focus({ preventScroll: true }); } }
  const roster = document.createDocumentFragment();
  for (let i = 0; i < players.length; i++) {
    const p = players[i], row = document.createElement('div'); row.className = `roster-player${p.id === playerId ? ' me' : ''}${p.alive ? '' : ' eliminated'}`;
    row.dataset.playerId = p.id; row.dataset.team = p.team || (i === 0 ? 'blue' : 'pink'); row.dataset.character = p.characterId; row.dataset.skin = p.skinId; row.dataset.cell = `${p.x},${p.y}`;
    const dot = document.createElement('span'); dot.className = 'dot';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = `${p.name}${p.id === playerId ? ' (나)' : ''}`;
    const status = document.createElement('span'); status.className = 'player-state'; status.textContent = p.bubbleTicks > 0 ? '구조 요청' : !p.alive ? '탈락' : names[p.characterId] || '준비';
    row.append(dot, name, status); roster.append(row);
  }
  $('roster').replaceChildren(roster);
}
function sendInput(action) {
  const me = state?.players?.find(p => p.id === playerId);
  if (socket?.readyState !== WebSocket.OPEN || state?.phase !== 'playing' || !me?.alive || me.bubbleTicks > 0) return;
  socket.send(JSON.stringify({ type: 'input', action }));
}
const keys = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right' };
window.addEventListener('keydown', event => {
  if (event.target.closest('input,select,textarea') || state?.phase !== 'playing') return;
  const action = keys[event.key] || keys[event.key.toLowerCase()];
  if (action) { event.preventDefault(); if (!movement.includes(action)) { movement.push(action); sendInput(action); lastMovement = performance.now(); } }
  if (event.code === 'Space') { event.preventDefault(); if (!event.repeat) { sendInput('place_orb'); } }
});
window.addEventListener('keyup', event => { const action = keys[event.key] || keys[event.key.toLowerCase()]; movement = movement.filter(a => a !== action); });
window.addEventListener('blur', resetControls); document.addEventListener('visibilitychange', resetControls);
for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('pointerdown', event => { event.preventDefault(); button.setPointerCapture(event.pointerId); const action = button.dataset.action; if (action === 'place_orb') { sendInput(action); } else { touchAction = action; sendInput(action); lastMovement = performance.now(); } });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, () => { if (touchAction === button.dataset.action) touchAction = null; });
}
window.addEventListener('pagehide', () => { if (socket) socket.close(); });

const tile = 60;
function roundRect(x, y, w, h, radius, fill, stroke) { ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); } }
function circle(x, y, r, fill, stroke) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); } }
function point(x, y) { return { x: x * tile + tile / 2, y: (10 - y) * tile + tile / 2 }; }
function previewSoft(mapId) {
  const cells = [];
  for (let x = 1; x < 12; x++) for (let y = 1; y < 10; y++) {
    if ((x % 2 === 0 && y % 2 === 0) || x <= 2 || x >= 10) continue;
    if (mapId === 'garden' ? (x + y * 3) % 4 === 0 : mapId === 'lagoon' ? (x * 3 + y) % 5 === 0 : (x * 2 + y * 3) % 5 === 1) cells.push(`${x},${y}`);
  }
  return cells;
}
function drawPlayer(p, time, index) {
  const q = point(p.x, p.y), me = p.id === playerId, blue = p.team ? p.team === 'blue' : index === 0;
  if (!p.alive) return;
  ctx.save(); ctx.translate(q.x, q.y);
  ctx.fillStyle = '#25444325'; ctx.beginPath(); ctx.ellipse(0, 20, 22, 7, 0, 0, Math.PI * 2); ctx.fill();
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
  if (p.pin) circle(20, -15, 5, '#ffe6a1', '#d9aa56');
  if (p.bubbleTicks > 0) { circle(0, 0, 27 + Math.sin(time / 100) * 2, '#b6eaff88', '#e5faff'); circle(-12, -13, 6, '#ffffffbb'); ctx.fillStyle = '#194c65'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center'; ctx.fillText(`${(p.bubbleTicks / 10).toFixed(1)}`, 0, 4); }
  ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = '#264d54'; ctx.fillText(me ? `${p.name} · 나` : p.name, 0, 38, 68);
  ctx.restore();
}
function draw(time) {
  const mapId = state?.mapId || selected('mapId'), theme = colors[mapId] || colors.garden;
  ctx.clearRect(0, 0, 780, 660);
  for (let x = 0; x < 13; x++) for (let y = 0; y < 11; y++) {
    const q = point(x, y); ctx.fillStyle = (x + y) % 2 ? theme.floor : theme.alternate; ctx.fillRect(q.x - 30, q.y - 30, 60, 60);
    if (x === 0 || y === 0 || x === 12 || y === 10 || (x % 2 === 0 && y % 2 === 0)) { roundRect(q.x - 28, q.y - 25, 56, 53, 8, theme.wall); roundRect(q.x - 28, q.y - 30, 56, 47, 8, theme.wallTop); roundRect(q.x - 21, q.y - 24, 42, 5, 3, '#ffffff30'); }
  }
  for (const cell of state?.soft || previewSoft(mapId)) {
    const [x, y] = cell.split(',').map(Number), q = point(x, y);
    roundRect(q.x - 23, q.y - 19, 46, 44, 7, theme.box); roundRect(q.x - 23, q.y - 25, 46, 38, 7, theme.boxTop);
    ctx.strokeStyle = theme.box; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(q.x - 14, q.y - 16); ctx.lineTo(q.x + 14, q.y + 5); ctx.moveTo(q.x + 14, q.y - 16); ctx.lineTo(q.x - 14, q.y + 5); ctx.stroke();
  }
  const symbols = { orb: '+', wave: '↔', dash: '»', pin: '✧' }, itemColors = { orb: '#75e0c7', wave: '#ffd778', dash: '#9abfff', pin: '#f9a4c4' };
  for (const item of state?.items || []) { const q = point(item.x, item.y); circle(q.x, q.y, 17, '#fff', '#ffffff'); circle(q.x, q.y, 14, itemColors[item.type] || '#fff'); ctx.fillStyle = '#355565'; ctx.font = 'bold 24px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(symbols[item.type] || '?', q.x, q.y); ctx.textBaseline = 'alphabetic'; }
  for (const orb of state?.orbs || []) { const q = point(orb.x, orb.y), radius = 18 + Math.sin(time / (orb.fuse < 8 ? 60 : 130)) * 2; circle(q.x, q.y + 6, radius + 2, '#24536c25'); const gradient = ctx.createRadialGradient(q.x - 7, q.y - 7, 1, q.x, q.y, radius); gradient.addColorStop(0, '#e0ffff'); gradient.addColorStop(.4, '#77dfef'); gradient.addColorStop(1, '#36a9d3'); circle(q.x, q.y, radius, gradient, '#e3fcff'); roundRect(q.x - 4, q.y - radius - 4, 8, 7, 3, '#6ce6c3'); }
  for (const wave of state?.waves || []) { const q = point(wave.x, wave.y); roundRect(q.x - 29, q.y - 27, 58, 54, 13, '#87eaffbb'); circle(q.x - 8, q.y - 7, 13, '#efffffaa'); circle(q.x + 13, q.y + 8, 8, '#e1ffffbb'); }
  (state?.players || []).forEach((p, i) => drawPlayer(p, time, i));
  const action = touchAction || movement.at(-1);
  if (action && time - lastMovement >= 120) { sendInput(action); lastMovement = time; }
  requestAnimationFrame(draw);
}
resetView(); requestAnimationFrame(draw);
fetch('/api/config', { cache: 'no-store' }).then(response => { if (!response.ok) throw new Error(); return response.json(); }).then(value => {
  config = value; $('join-button').disabled = false;
  if (config.allowDevGuests) { $('auth-note').textContent = '개발 게스트 모드 · 계정 없이 플레이하며 전적은 저장하지 않아요.'; $('join-button').firstChild.textContent = '개발 게스트로 입장 '; }
  else $('auth-note').textContent = '익명 로그인으로 안전하게 입장해요. 같은 탭에서는 계정을 유지해요.';
  setStatus('캐릭터와 맵을 골라 주세요. 같은 방으로 입장하면 함께 플레이할 수 있어요.');
}).catch(() => { setStatus('접속 설정을 불러오지 못했어요. 페이지를 새로고침해 주세요.', true); });
