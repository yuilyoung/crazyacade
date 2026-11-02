const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;

function headers(token) { return { "apikey": serviceRoleKey ?? anonKey, "Authorization": token ? `Bearer ${token}` : `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" }; }

export async function verifyAccessToken(accessToken) {
  if (!url || (!serviceRoleKey && !anonKey)) return null;
  const response = await fetch(`${url}/auth/v1/user`, { headers: headers(accessToken) });
  return response.ok ? response.json() : null;
}

export async function upsertProfile(user, requestedName) {
  if (!url || !serviceRoleKey) return;
  const nickname = String(user.user_metadata?.nickname ?? requestedName ?? `Popper${user.id.slice(0, 4)}`).slice(0, 12);
  await fetch(`${url}/rest/v1/profiles?on_conflict=id`, { method: "POST", headers: { ...headers(), "Prefer": "resolution=merge-duplicates" }, body: JSON.stringify({ id: user.id, nickname }) });
}

export async function persistMatch(room) {
  if (!url || !serviceRoleKey) return;
  const result = room.result ?? { draw: true };
  await fetch(`${url}/rest/v1/matches`, {
    method: "POST",
    headers: { ...headers(), "Prefer": "resolution=merge-duplicates" },
    body: JSON.stringify({ room_id: room.id, winner_id: result.winnerId ?? null, result })
  }).catch(error => console.error("Supabase match persistence failed", error.message));
}
