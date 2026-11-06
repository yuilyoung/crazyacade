import { isRankedMatch } from './ranked-policy.js';

const requestSignal = (timeoutMs, signal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

/** Authentication adapter: credentials, transport and timeout stay behind this port. */
export function createAuthProvider({ env = process.env, fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 5000 } = {}) {
  const url = env.SUPABASE_URL?.replace(/\/$/, '');
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY, anonKey = env.SUPABASE_ANON_KEY;
  const headers = token => ({ apikey: serviceRoleKey || anonKey, Authorization: `Bearer ${token ?? serviceRoleKey}`, 'Content-Type': 'application/json' });
  const discard = response => { void response.body?.cancel().catch(() => {}); };
  return Object.freeze({
    async verifyAccessToken(accessToken, { signal } = {}) {
      if (typeof accessToken !== 'string' || !accessToken.trim() || !url || (!serviceRoleKey && !anonKey)) return null;
      try {
        const response = await fetchImpl(`${url}/auth/v1/user`, { headers: headers(accessToken), signal: requestSignal(timeoutMs, signal) });
        if (!response.ok) {
          discard(response);
          if (response.status >= 500 || response.status === 408 || response.status === 429) throw Error('Provider unavailable');
          return null;
        }
        const user = await response.json();
        if (!user || typeof user.id !== 'string' || !user.id.trim() || user.id.length > 128) throw Error('Invalid identity');
        return user;
      } catch { throw new Error('Authentication provider unavailable'); }
    },
    async upsertProfile(user, requestedName, { signal } = {}) {
      if (!url || !serviceRoleKey || user.id.startsWith('dev-')) return;
      const requested = String(user.user_metadata?.nickname ?? requestedName ?? '').trim();
      const nickname = [...requested].length >= 2 ? [...requested].slice(0, 12).join('') : `Popper${user.id.slice(0, 4)}`;
      let response;
      try {
        response = await fetchImpl(`${url}/rest/v1/profiles?on_conflict=id`, {
          method: 'POST', headers: { ...headers(), Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify({ id: user.id, nickname }), signal: requestSignal(timeoutMs, signal)
        });
      } catch { throw new Error('Profile provider unavailable'); }
      discard(response);
      if (!response.ok) throw new Error(`Supabase profile update failed (${response.status})`);
    }
  });
}

const authProvider = createAuthProvider();
export const verifyAccessToken = (accessToken, options) => authProvider.verifyAccessToken(accessToken, options);
export const upsertProfile = (user, requestedName, options) => authProvider.upsertProfile(user, requestedName, options);

export function buildMatchPayload(room) {
  if (!isRankedMatch(room)) throw new Error('Invalid ranked result');
  if (!room.matchId || !Array.isArray(room.participants)) throw new Error("Match identity and participant snapshot are required");
  if (!['team', 'duel'].includes(room.mode)) throw new Error('Invalid match mode');
  if (typeof room.id !== 'string' || room.id.length > 64 || typeof room.matchId !== 'string' || room.matchId.length > 64) throw new Error('Invalid match identity');
  if (room.participants.length > 8) throw new Error('Invalid participant count');
  const counter = value => Math.min(1000000, Math.max(0, Number.isFinite(value) ? Math.floor(value) : 0));
  const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
  const original = room.result ?? { draw: true }, result = {};
  if (original.draw === true) result.draw = true;
  if (['blue', 'pink'].includes(original.winnerTeam)) result.winnerTeam = original.winnerTeam;
  if (identifier(original.winnerId)) result.winnerId = original.winnerId;
  if (identifier(original.disconnected)) result.disconnected = original.disconnected;
  if (Array.isArray(original.scoreboard)) result.scoreboard = original.scoreboard.slice(0, 8).map(p => ({
    id: identifier(p.id) ? p.id : '', name: typeof p.name === 'string' ? [...p.name].slice(0, 12).join('') : 'Popper',
    ...(p.team === 'blue' || p.team === 'pink' ? { team: p.team } : {}),
    score: counter(p.score), rescues: counter(p.rescues), deliveries: counter(p.deliveries)
  }));
  const participants = room.participants
    .filter(p => identifier(p.userId) && !/^(dev-|practice-|bot-)/.test(p.userId))
    .map(p => ({
      user_id: p.userId,
      team: ['blue', 'pink'].includes(p.team) ? p.team : null,
      score: counter(p.score),
      outcome: result.draw ? "draw" :
        (result.winnerTeam ? (result.winnerTeam === p.team ? "win" : "loss") :
          (result.winnerId ? (result.winnerId === p.userId ? "win" : "loss") : "draw"))
    }));
  if (new Set(participants.map(p => p.user_id)).size !== participants.length) throw new Error('Duplicate match participant');
  const payload = { p_match_id: room.matchId, p_room_id: room.id, p_mode: room.mode,
    p_winner_id: participants.some(p => p.user_id === result.winnerId) ? result.winnerId : null, p_result: result, p_participants: participants };
  const freeze = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };
  return freeze(payload);
}

export async function persistMatchPayload(payload, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const base = env.SUPABASE_URL?.replace(/\/$/, ''), key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw Object.assign(new Error('Match storage is not configured'), { retryable: false });
  let response;
  try {
    response = await fetchImpl(`${base}/rest/v1/rpc/record_match`, {
      method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    throw Object.assign(new Error('Match storage request failed or timed out'), { retryable: true });
  }
  if (!response.ok) {
    const status = response.status;
    // Never propagate a provider body, URL, token or arbitrary error message.
    void response.body?.cancel().catch(() => {});
    throw Object.assign(new Error(`Supabase match persistence failed (${status})`), { status, retryable: status === 408 || status === 429 || status >= 500 });
  }
  void response.body?.cancel().catch(() => {});
}

export async function persistMatch(room) {
  const payload = buildMatchPayload(room);
  if (!payload.p_participants.length) return;
  return persistMatchPayload(payload);
}


/** Fetch only explicitly public leaderboard fields; the service key stays server-side. */
export async function readLeaderboard(env = process.env) {
  const base = env.SUPABASE_URL?.replace(/\/$/, "");
  const key = env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error("Leaderboard storage is not configured");
  const response = await fetch(`${base}/rest/v1/profiles?select=nickname,rating,wins,losses,draws,score&order=rating.desc,score.desc,nickname.asc&limit=50`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`Supabase leaderboard unavailable (${response.status})`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error("Invalid leaderboard response");
  return data;
}

/** Read one verified account using server credentials; unavailable data never becomes a default rating. */
export async function readRankedProfile(verifiedUserId, { env = process.env, fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 5000, signal } = {}) {
  const base = env.SUPABASE_URL?.replace(/\/$/, ''), key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error('Ranked profile storage is not configured');
  if (typeof verifiedUserId !== 'string' || !verifiedUserId.trim() || verifiedUserId.length > 128) throw new Error('Invalid profile identity');
  try {
    const query = new URLSearchParams({ select: 'id,rating', id: `eq.${verifiedUserId}`, limit: '2' });
    const response = await fetchImpl(`${base}/rest/v1/profiles?${query}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: requestSignal(timeoutMs, signal)
    });
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error('Profile unavailable'); }
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.id !== verifiedUserId ||
        !Number.isInteger(rows[0].rating) || rows[0].rating < 0 || rows[0].rating > 2147483647) throw new Error('Invalid profile rating');
    return { rating: rows[0].rating };
  } catch { throw new Error('Ranked profile unavailable'); }
}
