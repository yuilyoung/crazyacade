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

export async function persistMatch(room) {
  if (!url || !serviceRoleKey) return;
  if (!room.matchId || !Array.isArray(room.participants)) throw new Error("Match identity and participant snapshot are required");
  const result = room.result ?? { draw: true };
  const participants = room.participants
    .filter(p => typeof p.userId === "string" && !p.userId.startsWith("dev-"))
    .map(p => ({
      user_id: p.userId,
      team: p.team ?? null,
      score: Math.min(1000000, Math.max(0, Number.isFinite(p.score) ? Math.floor(p.score) : 0)),
      outcome: result.draw ? "draw" :
        (result.winnerTeam ? (result.winnerTeam === p.team ? "win" : "loss") :
          (result.winnerId ? (result.winnerId === p.userId ? "win" : "loss") : "draw"))
    }));
  if (!participants.length) return;
  const response = await fetch(`${url}/rest/v1/rpc/record_match`, {
    method: "POST", headers: headers(),
    body: JSON.stringify({ p_match_id: room.matchId, p_room_id: room.id, p_mode: room.mode,
      p_winner_id: participants.some(p => p.user_id === result.winnerId) ? result.winnerId : null, p_result: result, p_participants: participants })
  });
  if (!response.ok) throw new Error(`Supabase match persistence failed (${response.status})`);
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
