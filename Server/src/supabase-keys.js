// A member session has its own JWT. New application keys belong in apikey alone.
export function supabaseHeaders(key, memberToken) {
  const headers = { apikey: key };
  if (memberToken) headers.Authorization = `Bearer ${memberToken}`;
  else if (!key.startsWith('sb_publishable_') && !key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;
  return headers;
}

// Used only for configuration checks. Session verification belongs to Supabase Auth.
function legacyKeyRole(key) {
  try { return JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString())?.role; }
  catch { return undefined; }
}

export function isPublicSupabaseKey(key) {
  return typeof key === 'string' && (key.startsWith('sb_publishable_') ||
    (key.split('.').length === 3 && legacyKeyRole(key) === 'anon'));
}

export function publicSupabaseKey(env) {
  const key = env.SUPABASE_ANON_KEY?.trim() || '';
  if (!key || key === env.SUPABASE_SERVICE_ROLE_KEY?.trim() || key.startsWith('sb_secret_')) return '';
  if (key.split('.').length === 3 && legacyKeyRole(key) !== 'anon') return '';
  return key;
}
