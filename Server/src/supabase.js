const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;

function headers(token) { return { "apikey": serviceRoleKey ?? anonKey, "Authorization": token ? `Bearer ${token}` : `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" }; }

export async function verifyAccessToken(accessToken) {
  if (typeof accessToken !== "string" || !accessToken.trim() || !url || (!serviceRoleKey && !anonKey)) return null;
  const response = await fetch(`${url}/auth/v1/user`, { headers: headers(accessToken) });
  return response.ok ? response.json() : null;
}

export async function upsertProfile(user, requestedName) {
  if (!url || !serviceRoleKey || user.id.startsWith("dev-")) return;
  const requested = String(user.user_metadata?.nickname ?? requestedName ?? "").trim();
  const nickname = Array.from(requested).length >= 2
    ? Array.from(requested).slice(0, 12).join("") : `Popper${user.id.slice(0, 4)}`;
  const response = await fetch(`${url}/rest/v1/profiles?on_conflict=id`, {
    method: "POST", headers: { ...headers(), "Prefer": "resolution=merge-duplicates" },
    body: JSON.stringify({ id: user.id, nickname })
  });
  if (!response.ok) throw new Error(`Supabase profile update failed (${response.status})`);
}

export function buildMatchPayload(room) {
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
