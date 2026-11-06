const activeStatuses = new Set(['authenticating', 'searching']);
const tiers = { Bronze: '브론즈', Silver: '실버', Gold: '골드', Diamond: '다이아' };
const errors = {
  1008: '요청이 너무 빨라 연결을 잠시 쉬어요. 조금 기다린 뒤 천천히 다시 시작해 주세요.',
  1013: '접속이 몰리거나 서버가 점검을 준비하고 있어요. 잠시 후 다시 시도해 주세요.',
  queue_full: '지금 상대를 찾는 사람이 많아요. 잠시 후 다시 시도하거나 AI 연습을 선택해 주세요.',
  queue_unavailable: '지금 상대 찾기를 시작할 수 없어요. 잠시 후 다시 시도해 주세요.',
  server_draining: '서버 점검을 준비하고 있어요. 잠시 후 다시 찾아 주세요.',
  service_busy: '접속이 몰리고 있어요. 잠시 기다린 뒤 다시 시도해 주세요.',
  server_busy: '접속이 몰리고 있어요. 잠시 기다린 뒤 다시 시도해 주세요.',
  rate_limited: '요청이 너무 빨라요. 잠시 기다린 뒤 천천히 다시 눌러 주세요.',
  profile_unavailable: '내 등급을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.',
  authentication_unavailable: '로그인을 확인할 수 없어요. 잠시 후 다시 시도해 주세요.',
  unauthorized: '로그인을 다시 확인한 뒤 상대를 찾아 주세요.',
  already_in_room: '같은 계정이 다른 경기에 참가 중이에요. 해당 경기를 마친 뒤 다시 찾아 주세요.',
  already_joining: '이미 입장을 준비하고 있어요. 잠시 기다려 주세요.',
  stale_match: '경기 상태가 바뀌었어요. 현재 경기 결과에서 다시 선택해 주세요.',
  room_unavailable: '지금 경기에 입장할 수 없어요. 잠시 후 다시 시도해 주세요.'
};
export function queueErrorText(code) { return errors[code] || '상대 찾기를 시작하지 못했어요. 잠시 후 다시 시도해 주세요.'; }
const number = value => Number.isFinite(value) ? Math.max(0, value) : 0;
/** Own queue state only. Request ownership remains valid across authentication and result-room transitions. */
export function createMatchmakingViewModel({ transport = { send: () => false } } = {}) {
  let context = { enabled: false, connection: 'disconnected', snapshot: null, modalOpen: false };
  let request = null, listeners = new Set();
  function project() {
    const status = request?.status || 'idle', busy = activeStatuses.has(status) || Boolean(request?.cancelPending), snapshot = context.snapshot;
    const canNextMatch = !busy && !context.modalOpen && context.connection === 'connected' && snapshot?.phase === 'finished' && Boolean(snapshot.matchmaking) && typeof snapshot.matchId === 'string' && !(request?.leftResult && request.fromMatchId === snapshot.matchId);
    const canStart = context.enabled && !context.modalOpen && !busy && !snapshot;
    const source = request?.source;
    const elapsedMs=Number.isFinite(request?.elapsedMs) && request.elapsedMs>=0 ? Math.min(180000,request.elapsedMs) : null;
    const searchRadius=Number.isFinite(request?.searchRadius) && request.searchRadius>=100 ? Math.min(400,Math.floor(request.searchRadius)) : null;
    const remainingSeconds=elapsedMs === null ? null : Math.ceil((180000-elapsedMs)/1000);
    const nextWidenSeconds=elapsedMs !== null && elapsedMs<180000 && searchRadius !== null && searchRadius<400 ? Math.ceil((15000-elapsedMs%15000)/1000) : null;
    const identity = Number.isInteger(request?.rating) && ['demo', 'supabase'].includes(source)
      ? `${source === 'demo' ? '개발 서버 임시 등급' : '인증 계정'} · ${tiers[request.tier] || '등급 확인 중'} ${request.rating.toLocaleString('ko-KR')}점`
      : '서버에서 내 등급을 확인하고 있어요.';
    const messages = { authenticating: '로그인과 내 등급을 확인하고 있어요.', searching: '비슷한 등급의 사람 8명을 찾고 있어요. 클래식 · 아이템전 · 맵 자동 선택', cancelled: '상대 찾기를 취소했어요.', expired: '이번에는 상대를 찾지 못했어요. 다시 찾거나 AI 연습을 선택해 주세요.', matched: '8명이 모였어요. 경기를 준비합니다.' };
    return Object.freeze({ status, requestId: request?.id || null, busy, visible: Boolean(request) && status !== 'matched',
      canStart, canNextMatch, canCancel: activeStatuses.has(status) && !context.modalOpen, canPractice: Boolean(request) && status !== 'matched' && !context.modalOpen,
      preserveResult: Boolean(request?.fromMatchId && !request.leftResult), source, identity, elapsedSeconds: Math.floor(number(elapsedMs) / 1000),
      searchRadius, requiredPlayers: 8, remainingSeconds, nextWidenSeconds,
      policyText:'최대 3분(180초) 검색 · 처음 ±100점, 15초마다 50점씩 넓혀 최대 ±400점까지 찾아요.',
      message: request?.cancelPending ? '상대 찾기 취소를 확인하고 있어요. 잠시 기다려 주세요.' : request?.error || messages[status] || '' });
  }
  let view = project();
  function publish() { view = project(); for (const listener of listeners) listener(view); }
  function begin(id, fromMatchId = null) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return false;
    request = { id, status: 'authenticating', fromMatchId, leftResult: false }; publish(); return true;
  }
  function owns(message) { return Boolean(request && activeStatuses.has(request.status) && message?.requestId === request.id); }
  return Object.freeze({
    get view() { return view; },
    configure(patch) { context = { ...context, ...patch }; publish(); },
    subscribe(listener) { listeners.add(listener); listener(view); return () => listeners.delete(listener); },
    begin(id) { return view.canStart && begin(id); },
    joinPayload(accessToken, selection = {}) {
      if (request?.status !== 'authenticating' || request.fromMatchId) return null;
      const { name, characterId, skinId, orbSkinId } = selection;
      return { type: 'queue_join', requestId: request.id, ...(typeof accessToken === 'string' ? {accessToken} : {}), name, characterId, skinId, orbSkinId };
    },
    nextMatch(id) {
      if (!view.canNextMatch || !begin(id, context.snapshot.matchId)) return false;
      if (transport.send({ type: 'next_match', requestId: id, matchId: request.fromMatchId }) === false) { request.status = 'cancelled'; request.error = queueErrorText('queue_unavailable'); publish(); return false; }
      return true;
    },
    receive(message) {
      // A next-match cancellation can cross the server's accepted departure. Keep cancellation
      // final, but consume that ownership fact so the old result never remains actionable.
      if (request?.status === 'cancelled' && request.fromMatchId && !request.leftResult && message?.requestId === request.id && message.status === 'searching') {
        request.leftResult = true; publish(); return true;
      }
      if (request?.cancelPending && message?.requestId === request.id && ['cancelled','expired'].includes(message.status)) {
        request.cancelPending=false; publish(); return true;
      }
      if (!owns(message) || !['authenticating', 'searching', 'cancelled', 'expired'].includes(message.status)) return false;
      if (request.status === 'searching' && message.status === 'authenticating') return false;
      if(request.status === 'searching' && message.status === 'searching' && Number.isFinite(request.elapsedMs) && Number.isFinite(message.elapsedMs) && message.elapsedMs<request.elapsedMs) return false;
      const { status, source, rating, tier, elapsedMs, searchRadius } = message;
      request = { ...request, status, source, rating, tier, elapsedMs, searchRadius, leftResult: request.leftResult || status === 'searching' };
      publish(); return true;
    },
    acceptJoined(message, resumeRecord = null) {
      const resuming = context.connection === 'reconnecting' && message?.resumed === true && resumeRecord && message.playerId === resumeRecord.playerId && message.roomId === resumeRecord.roomId;
      if (!resuming && !owns(message)) return false;
      if (request) { request.status = 'matched'; request.cancelPending=false; } publish(); return true;
    },
    fail(message) { if (!owns(message)) return false; request.status = 'cancelled'; request.error = queueErrorText(message.code); publish(); return true; },
    cancel() {
      if (!view.canCancel) return false;
      const id = request.id; request.cancelPending=Boolean(request.fromMatchId && !request.leftResult); request.status = 'cancelled'; publish();
      transport.send({ type: 'queue_cancel', requestId: id }); return true;
    },
    reset() { request = null; context = { ...context, snapshot: null, connection: 'disconnected' }; publish(); }
  });
}
