const SCREENS = ['title', 'lobby', 'loadout', 'maps', 'connecting', 'waiting', 'battle', 'results', 'login', 'profile', 'ranking'];

/** Owns screen visibility without replacing the existing game controls or their handlers. */
export function createGameShell({ document: documentRef = globalThis.document, onNavigate = () => {}, onPlay = () => {}, onLeave = () => {}, onAccount = () => {} } = {}) {
  const $ = id => documentRef.getElementById(id);
  const query = selector => documentRef.querySelector(selector);
  const make = (tag, className, html = '') => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    node.innerHTML = html;
    return node;
  };
  const shell = make('div', 'game-shell');
  shell.id = 'game-shell';
  const originalNodes = [...documentRef.body.children];
  documentRef.body.prepend(shell);
  const form = $('join-form'), fields = $('selection-fields'), setup = query('.setup');
  const battle = query('.battle');
  const header = make('header', 'shell-header', `
    <button type="button" class="shell-brand" data-screen="lobby" aria-label="Pop Pop Arena 로비"><span class="shell-brand-mark">✦</span><span>POP POP <b>ARENA</b></span></button>
    <nav class="shell-nav" aria-label="게임 메뉴"><button type="button" data-screen="lobby">로비</button><button type="button" data-screen="loadout">캐릭터</button><button type="button" data-screen="maps">맵 · 규칙</button><button type="button" data-screen="ranking">랭킹</button><button type="button" data-account="profile">내 정보</button></nav>
    <button type="button" id="shell-member-name" class="shell-member-badge" data-account="profile">게스트</button><div class="shell-tools"></div>`);
  header.querySelector('.shell-tools').append(query('.display-toolbar'));
  const stage = make('main', 'shell-stage');
  stage.id = 'shell-stage';
  shell.append(header, stage);
  const scenes = {};
  function scene(name, title, subtitle = '') {
    const node = make('section', `shell-scene shell-scene-${name}`);
    node.id = `screen-${name}`;
    node.dataset.screen = name;
    node.setAttribute('aria-label', title);
    node.hidden = true;
    node.tabIndex = -1;
    if (name !== 'battle') {
      const heading = make('div', 'shell-scene-heading', `<div><p class="shell-kicker">POP POP ARENA / ${name.toUpperCase()}</p><h1>${title}</h1>${subtitle ? `<p>${subtitle}</p>` : ''}</div><button class="shell-back" type="button" data-screen="lobby">← 로비</button>`);
      node.append(heading);
    }
    const content = make('div', 'shell-scene-content');
    node.append(content);
    stage.append(node);
    scenes[name] = node;
    return content;
  }
  const title = scene('title', '함께 터뜨리는 짜릿한 한 판.');
  title.innerHTML = `
    <div class="shell-title-copy"><span class="shell-pill">4 vs 4 · 버블 팀 배틀</span><p class="shell-wordmark">POP POP<br><span>ARENA</span><i>✦</i></p><h2>작은 물방울, 커다란 팀워크.</h2><p>길을 열고, 친구를 구하고, 별을 패스해요.<br>우리 팀과 함께 짜릿한 한 판!</p><div class="shell-title-actions"><button class="shell-button shell-button-primary" type="button" data-screen="lobby">게임 시작 <span>→</span></button><button class="shell-button shell-button-light" type="button" data-account="login">로그인 · 회원가입</button></div><button type="button" class="shell-text-button" data-play="training">처음이라면? 4단계 훈련으로 시작 →</button></div>
    <div class="shell-hero-art" aria-hidden="true"><div class="shell-orbit shell-orbit-one"></div><div class="shell-orbit shell-orbit-two"></div><div class="shell-hero-star">✦</div><div class="shell-hero-character shell-momo"><span class="avatar momo"><i></i></span><span class="shell-team-tag">B · BLUE TEAM</span></div><div class="shell-hero-character shell-bibi"><span class="avatar bibi"><i></i></span><span class="shell-team-tag">P · PINK TEAM</span></div><span class="shell-art-bubble one"></span><span class="shell-art-bubble two"></span><span class="shell-art-bubble three"></span><span class="shell-art-caption">SAVE. PASS. POP!</span></div>`;

  const lobby = scene('lobby', '오늘도, 한 판 같이!', '플레이 방식을 고르고 아레나에 입장하세요.');
  lobby.innerHTML = `<div class="shell-lobby-banner"><div><span class="shell-pill">READY TO POP?</span><h2>내 팀의 다음 영웅은 나.</h2><p>물폭탄을 피하고 버블 속 친구를 구해요.</p></div><div class="shell-lobby-mascot" aria-hidden="true"><span class="avatar momo"><i></i></span><span>✦</span></div></div><div class="shell-lobby-play"></div><div class="shell-lobby-menu"><button type="button" data-screen="loadout"><span class="shell-menu-icon mint">☺</span><span><strong>캐릭터 · 스킨</strong><small id="shell-loadout-summary">나만의 탐험대</small></span><b>↗</b></button><button type="button" data-screen="maps"><span class="shell-menu-icon blue">▦</span><span><strong>맵 · 규칙 선택</strong><small id="shell-map-summary">우리 팀의 놀이터</small></span><b>↗</b></button><button type="button" data-screen="ranking"><span class="shell-menu-icon gold">♜</span><span><strong>랭킹 · 등급</strong><small>아레나의 주인공들</small></span><b>↗</b></button><button type="button" data-account="profile"><span class="shell-menu-icon pink">☆</span><span><strong>내 정보 · 전적</strong><small>나의 팀 배틀 이야기</small></span><b>↗</b></button></div>`;
  const quickStart = query('.quick-start');
  lobby.querySelector('.shell-lobby-play').append(quickStart);
  $('quick-practice').querySelector('strong').textContent = '혼자 AI 연습';
  $('quick-practice').querySelector('span').textContent = '로그인 없이 바로 · 나 + AI 7명';
  $('quick-friends').querySelector('strong').textContent = '온라인 팀전';
  $('quick-friends').querySelector('span').textContent = '친구와 함께 · 맵 선택 후 입장';
  quickStart.prepend($('quick-practice'));

  const loadout = scene('loadout', '나만의 탐험대', '어떤 모습이든 같은 능력! 모든 착장을 자유롭게 골라요.');
  const maps = scene('maps', '우리 팀의 놀이터', '맵과 규칙을 정하고, 아래 입장 버튼으로 출발하세요.');
  const loadoutCard = make('div', 'shell-loadout-card shell-card');
  const mapCard = make('div', 'shell-map-card shell-card');
  const mapRules = make('div', 'shell-map-rules shell-card');
  const mapSelection = query('.map-grid');
  const mapLabel = mapSelection.previousElementSibling;
  const fieldNodes = [...fields.children];
  let mapStarted = false, rulesStarted = false;
  for (const node of fieldNodes) {
    if (node === mapLabel) mapStarted = true;
    if (mapStarted && node.classList.contains('two-fields')) rulesStarted = true;
    (rulesStarted ? mapRules : mapStarted ? mapCard : loadoutCard).append(node);
  }
  const setupHeading = setup.querySelector('.section-heading');
  // Keep the original heading ID for integrations that label the form.
  setupHeading.classList.add('sr-only');
  loadoutCard.prepend(setupHeading);
  loadout.append(loadoutCard, make('div', 'shell-scene-actions', '<button class="shell-button shell-button-primary" type="button" data-screen="maps">맵 · 규칙 선택으로 →</button><button class="shell-button shell-button-light" type="button" data-screen="lobby">선택 완료 · 로비</button>'));
  maps.append(mapCard, mapRules);
  const entries = make('div', 'shell-entry-card shell-card', '<div class="shell-entry-heading"><span class="shell-kicker">LET’S PLAY</span><h2>준비됐다면, 아레나로!</h2></div>');
  for (const selector of ['.practice-entry', '.ranked-entry', '#auth-note', '#join-button']) entries.append(query(selector));
  maps.append(entries);
  setup.classList.add('shell-setup');
  fields.append(scenes.loadout, scenes.maps);
  stage.append(setup);

  const connecting = scene('connecting', '아레나를 준비하고 있어요', '잠깐만 기다려 주세요. 곧 함께 플레이해요.');
  connecting.innerHTML = '<div class="shell-connection-art" aria-hidden="true"><span>✦</span><i></i><i></i><i></i></div><p id="shell-connection-status" role="status">안전하게 게임 서버에 연결하고 있어요.</p><button class="shell-button shell-button-light" type="button" data-leave>취소 · 로비로</button>';
  connecting.append($('matchmakingPanel'));
  const waiting = scene('waiting', '친구들을 기다려요', '모두 모이면 팀 배틀이 시작돼요.');
  waiting.append(query('.roster-panel'), query('.invite-panel'));
  waiting.append(make('div', 'shell-waiting-note', '<span class="shell-waiting-dot"></span> 참가자가 모두 모이면 자동으로 시작해요.'));
  waiting.append(make('div', 'shell-scene-actions', '<button class="shell-button shell-button-light" type="button" data-leave>대기방 나가기</button>'));

  const battleScene = scene('battle', '대전 아레나');
  const rail = make('div', 'shell-battle-rail');
  const arenaSlot = make('div', 'shell-arena-slot');
  arenaSlot.append(query('.arena-wrap'));
  battle.append(arenaSlot, rail);
  for (const selector of ['.battle-heading', '.scorebar', '#seriesHud', '.rescue-alert-slot']) rail.append(query(selector));
  const trainingCue = make('div', 'shell-training-cue');
  trainingCue.hidden = true;
  for (const id of ['training-status', 'training-instruction', 'training-progress']) trainingCue.append($(id));
  rail.append(trainingCue, query('.touch-controls'), query('.battle-footer'));
  const results = scene('results', '멋진 팀워크였어요!', '한 판의 기록을 확인하고, 다음 도전을 이어가세요.');
  results.append(make('div', 'shell-result-summary', '<h2 id="shell-result-title"></h2><p id="shell-result-copy"></p>'));
  results.append($('match-scoreboard'));
  const resultActions = make('div', 'shell-scene-actions shell-result-actions');
  resultActions.append($('replay-button'), $('nextMatchButton'));
  resultActions.append(make('button', 'shell-button shell-button-light', '로비로 돌아가기'));
  resultActions.lastElementChild.type = 'button';
  resultActions.lastElementChild.dataset.leave = '';
  results.append($('training-next-actions'), resultActions);

  const dialog = $('settings-dialog');
  const dialogExtras = make('div', 'shell-settings-extra');
  for (const selector of ['.experience-settings', '.play-settings', '.control-hint', '#seriesGuide', '#training-panel', '.event-panel', '#tutorial-panel', '.guide-panel']) dialogExtras.append(query(selector));
  dialog.append(dialogExtras);
  battle.replaceChildren(arenaSlot, rail);
  battleScene.append(battle);

  const login = scene('login', '다시 만나서 반가워요', '로그인하고 친구들과 함께 팀 배틀을 즐겨요.');
  login.append(make('div', 'shell-member-mount'));
  login.lastElementChild.id = 'member-login-panel';
  const profile = scene('profile', '나의 아레나', '프로필, 경기 기록과 계정 정보를 한곳에서 확인해요.');
  profile.append(make('div', 'shell-member-mount'));
  profile.lastElementChild.id = 'member-panel';
  const ranking = scene('ranking', '아레나의 주인공들', '친구들과 함께 쌓아가는 도전의 기록.');
  ranking.append(query('.leaderboard-panel'));

  const statusBar = make('div', 'shell-statusbar', '<span class="shell-status-dot" aria-hidden="true"></span><span class="shell-status-brand">POP POP ARENA</span>');
  statusBar.prepend($('status'));
  shell.append(header, stage, statusBar, dialog);
  documentRef.body.prepend(shell);
  // All ID-bearing controls have been moved above. Remove only the old page scaffolding.
  for (const node of originalNodes) if (node !== shell && node.parentNode === documentRef.body && node.tagName !== 'SCRIPT') node.remove();
  documentRef.body.classList.add('game-shell-mounted');

  let current = null, previousLifecycle = null, destroyed = false;
  function updateSummary() {
    const selectedLabel = name => form.querySelector(`input[name="${name}"]:checked`)?.closest('label')?.querySelector('strong')?.textContent;
    $('shell-loadout-summary').textContent = [selectedLabel('characterId'), form.querySelector('input[name="skinId"]:checked')?.closest('label')?.textContent.trim()].filter(Boolean).join(' · ') || '나만의 탐험대';
    $('shell-map-summary').textContent = [selectedLabel('mapId'), $('rule-set').selectedOptions?.[0]?.textContent?.split(' · ')[0]].filter(Boolean).join(' · ') || '우리 팀의 놀이터';
  }
  function show(name) {
    if (destroyed || !SCREENS.includes(name)) return false;
    if (current === name) return true;
    current = name;
    shell.dataset.screen = name;
    for (const [key, node] of Object.entries(scenes)) {
      node.hidden = key !== name;
      node.inert = key !== name;
    }
    for (const button of header.querySelectorAll('[data-screen]')) {
      if (button.dataset.screen === name) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    updateSummary();
    // Focus the scene rather than an action: opening a scene must never start play.
    scenes[name].focus?.({ preventScroll: true });
    return true;
  }
  function click(event) {
    const button = event.target.closest?.('button');
    if (!button || !shell.contains(button) || button.disabled) return;
    if (button.hasAttribute('data-screen')) onNavigate(button.dataset.screen);
    else if (button.hasAttribute('data-account')) onAccount(button.dataset.account);
    else if (button.hasAttribute('data-play')) onPlay(button.dataset.play);
    else if (button.hasAttribute('data-leave')) onLeave();
  }
  shell.addEventListener('click', click);
  form.addEventListener('change', updateSummary);
  show('title');
  return {
    element: shell,
    get screen() { return current; },
    show,
    sync({ state = null, connecting: isConnecting = false, recovering = false, queueBusy = false } = {}) {
      trainingCue.hidden = !state?.training;
      shell.dataset.training = String(Boolean(state?.training));
      if (state?.phase === 'finished') {
        $('shell-result-title').textContent = $('overlay-title').textContent;
        $('shell-result-copy').textContent = $('overlay-copy').textContent;
      }
      const target = recovering || isConnecting || queueBusy ? 'connecting'
        : state ? state.phase === 'finished' ? 'results' : state.phase === 'waiting' ? 'waiting' : 'battle' : null;
      const lifecycle = target || 'idle';
      if (lifecycle !== previousLifecycle) {
        const wasActive = previousLifecycle && previousLifecycle !== 'idle';
        previousLifecycle = lifecycle;
        if (target) show(target);
        else if (wasActive && ['connecting', 'waiting', 'battle', 'results'].includes(current)) show('lobby');
      }
    },
    setStatus(message, isError = false) {
      const status = $('status');
      status.textContent = String(message || '');
      status.classList.toggle('error', Boolean(isError));
      statusBar.classList.toggle('has-error', Boolean(isError));
      $('shell-connection-status').textContent = String(message || '안전하게 게임 서버에 연결하고 있어요.');
    },
    destroy() {
      destroyed = true;
      shell.removeEventListener('click', click);
      form.removeEventListener('change', updateSummary);
    }
  };
}
