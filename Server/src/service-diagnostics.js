// Public diagnostics contain fixed status codes only. They never create users,
// read member rows, or invoke the result-writing RPC.
export function publicSupabaseKey(env) {
  const key = env.SUPABASE_ANON_KEY?.trim() || '';
  if (!key || key === env.SUPABASE_SERVICE_ROLE_KEY?.trim() || key.startsWith('sb_secret_')) return '';
  if (key.split('.').length === 3) {
    try {
      if (JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role !== 'anon') return '';
    } catch { return ''; }
  }
  return key;
}

const tables = {
  profiles: 'id,nickname,rating,wins,losses,draws,score,created_at,updated_at',
  matches: 'id,room_id,mode,winner_id,result,played_at',
  match_participants: 'match_id,user_id,team,outcome,score',
  payment_records: 'id,user_id,description,amount_minor,currency,status,created_at'
};
const rpcParameters = ['p_match_id','p_room_id','p_mode','p_winner_id','p_result','p_participants'];
const responseLimit = 1024 * 1024;
const discard = response => { void response?.body?.cancel().catch(() => {}); };

export function createServiceDiagnostics({ env = process.env, fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 5000, cacheMs = 30000, now = Date.now } = {}) {
  let cached, expires = 0, pending;
  async function probe(endpoint, key, head = false) {
    const controller = new AbortController();
    let timer, reader;
    try {
      return await Promise.race([
        new Promise(resolve => { timer = setTimeout(() => {
          controller.abort();
          void reader?.cancel().catch(() => {});
          resolve({ code: 'timeout' });
        }, timeoutMs); }),
        (async () => {
          const response = await fetchImpl(`${env.SUPABASE_URL.replace(/\/$/, '')}${endpoint}`, {
            method: head ? 'HEAD' : 'GET', redirect: 'error', signal: controller.signal,
            headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: endpoint === '/rest/v1/' ? 'application/openapi+json' : 'application/json' }
          });
          if (!response.ok) {
            discard(response);
            return { code: [401, 403].includes(response.status) ? 'unauthorized' : [400, 404].includes(response.status) ? 'schema_missing' : 'unavailable' };
          }
          if (head) { discard(response); return { code: 'ok' }; }
          if (!response.body) return { code: 'invalid_response' };
          reader = response.body.getReader();
          const chunks = [];
          let size = 0;
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > responseLimit) { void reader.cancel().catch(() => {}); return { code: 'invalid_response' }; }
              chunks.push(value);
            }
            return { code: 'ok', data: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
          } catch { return { code: controller.signal.aborted ? 'timeout' : 'invalid_response' }; }
          finally { reader.releaseLock(); }
        })()
      ]);
    } catch { return { code: controller.signal.aborted ? 'timeout' : 'unavailable' }; }
    finally { clearTimeout(timer); }
  }
  async function check() {
    const checks = { configuration: 'ok', authentication: 'not_checked', database: 'not_checked', resultStorage: 'not_checked' };
    const result = () => Object.freeze({ status: Object.values(checks).every(value => value === 'ok') ? 'ready' : 'unavailable', checks: Object.freeze(checks) });
    const settings = ['SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY'];
    if (!settings.every(name => env[name]?.trim())) {
      checks.configuration = 'missing'; return result();
    }
    let base;
    try { base = new URL(env.SUPABASE_URL); } catch { /* invalid below */ }
    const local = base && ['localhost','127.0.0.1','[::1]'].includes(base.hostname);
    if (!base || !(base.protocol === 'https:' || (local && base.protocol === 'http:')) ||
        base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
        !publicSupabaseKey(env) || settings.some(name => env[name] !== env[name].trim() || /[\r\n]/.test(env[name]))) {
      checks.configuration = 'invalid'; return result();
    }
    if (env.ALLOW_DEV_GUESTS === 'true') { checks.configuration = 'development_guests_enabled'; return result(); }
    const [auth, schema, rpc] = await Promise.all([
      probe('/auth/v1/settings', publicSupabaseKey(env)),
      Promise.all(Object.entries(tables).map(([table, select]) => probe(`/rest/v1/${table}?${new URLSearchParams({ select, limit: '0' })}`, env.SUPABASE_SERVICE_ROLE_KEY, true))),
      probe('/rest/v1/', env.SUPABASE_SERVICE_ROLE_KEY)
    ]);
    checks.authentication = auth.code;
    if (auth.code === 'ok') {
      if (typeof auth.data?.external?.email !== 'boolean' || typeof auth.data?.disable_signup !== 'boolean') checks.authentication = 'invalid_response';
      else if (!auth.data.external.email) checks.authentication = 'email_disabled';
      else if (auth.data.disable_signup) checks.authentication = 'signup_disabled';
    }
    checks.database = schema.find(entry => entry.code !== 'ok')?.code ?? 'ok';
    checks.resultStorage = rpc.code;
    if (rpc.code === 'ok') {
      const parameters = rpc.data?.paths?.['/rpc/record_match']?.post?.parameters;
      const required = Array.isArray(parameters) ? parameters.find(parameter => parameter?.in === 'body')?.schema?.required : null;
      if (!Array.isArray(required) || !rpcParameters.every(name => required.includes(name))) checks.resultStorage = 'schema_missing';
    }
    return result();
  }
  return async () => {
    if (cached && now() < expires) return cached;
    if (!pending) pending = check().then(value => { cached = value; expires = now() + cacheMs; return value; }).finally(() => { pending = undefined; });
    return pending;
  };
}
