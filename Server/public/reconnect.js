// A private per-tab capability, never part of invitations or public game state.
function participant(value) {
  if (!value || typeof value !== 'object') return null;
  for (const key of ['roomId', 'playerId', 'resumeToken']) {
    if (typeof value[key] !== 'string' || !value[key] || value[key].length > 256) return null;
  }
  if (typeof value.practice !== 'boolean') return null;
  return { roomId: value.roomId, playerId: value.playerId, resumeToken: value.resumeToken,
    practice: value.practice, reconnectGraceMs: Math.min(30000, Math.max(1000, Number(value.reconnectGraceMs) || 30000)) };
}

export function createResumeStore(storage, key) {
  let current = null, loaded = false;
  return {
    load() {
      if (!loaded) {
        loaded = true;
        try { current = participant(JSON.parse(storage?.getItem(key))); } catch { /* Recovery still works in memory. */ }
      }
      return current ? { ...current } : null;
    },
    save(value) {
      current = participant(value); loaded = true;
      try { if (current) storage?.setItem(key, JSON.stringify(current)); else storage?.removeItem(key); } catch { /* Same-page recovery remains available. */ }
    },
    clear() { current = null; loaded = true; try { storage?.removeItem(key); } catch { /* No persistent storage. */ } }
  };
}

export function createRecoveryWindow(now = Date.now) {
  let deadline = null, attempt = 0;
  return {
    start(graceMs = 30000) { if (deadline === null) { deadline = now() + Math.min(30000, Math.max(1000, graceMs)); attempt = 0; } },
    stop() { deadline = null; attempt = 0; },
    remaining() { return deadline === null ? 0 : Math.max(0, deadline - now()); },
    nextDelay() {
      if (deadline === null || now() >= deadline) return null;
      return Math.min(deadline - now(), [500, 1000, 2000, 4000][Math.min(attempt++, 3)]);
    }
  };
}

export function createBrowserAuthenticator({ storage, fetch: request = globalThis.fetch, now = Date.now } = {}) {
  const sessions = new Map();
  return async config => {
    if (config?.allowDevGuests) return null;
    if (!config?.supabaseUrl || !config.supabaseAnonKey) throw new Error('로그인 설정이 아직 준비되지 않았어요. 서버 관리자에게 문의해 주세요.');
    const base = config.supabaseUrl.replace(/\/$/, ''), key = `popPopBrowser:${base}`;
    if (!sessions.has(base)) {
      let saved;
      try { saved = JSON.parse(storage?.getItem(key)); } catch { /* Same-page authentication does not require storage. */ }
      sessions.set(base, saved || null);
    }
    const session = sessions.get(base);
    if (session?.access_token && session.expires_at > now() / 1000 + 60) return session;
    const refresh = session?.refresh_token;
    const response = await request(`${base}/auth/v1/${refresh ? 'token?grant_type=refresh_token' : 'signup'}`, {
      method: 'POST', headers: { apikey: config.supabaseAnonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(refresh ? { refresh_token: refresh } : { data: {} }), signal: AbortSignal.timeout(12000)
    });
    const payload = await response.json();
    if (!response.ok || !payload.access_token || !payload.refresh_token) throw new Error('로그인에 실패했어요. 네트워크와 익명 로그인 설정을 확인해 주세요.');
    payload.expires_at ||= Math.floor(now() / 1000) + Number(payload.expires_in || 0);
    sessions.set(base, payload);
    try { storage?.setItem(key, JSON.stringify(payload)); } catch { /* Keep the same anonymous identity for transport recovery. */ }
    return payload;
  };
}
