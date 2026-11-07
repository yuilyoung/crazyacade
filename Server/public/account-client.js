const messages = {
  auth_not_configured: '회원 로그인 설정을 준비 중이에요. 지금은 연습 모드를 이용해 주세요.',
  invalid_email: '이메일 주소를 확인해 주세요.',
  invalid_password: '비밀번호는 8자 이상 128자 이하로 입력해 주세요.',
  invalid_nickname: '닉네임은 2자 이상 12자 이하로 입력해 주세요.',
  auth_failed: '이메일과 비밀번호를 확인해 주세요. 이메일 인증이 필요한 계정은 인증 후 로그인해 주세요.',
  signup_failed: '가입을 완료하지 못했어요. 입력 내용을 확인하거나 잠시 후 다시 시도해 주세요.',
  auth_unavailable: '로그인 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.',
  session_expired: '로그인이 만료되었어요. 다시 로그인해 주세요.',
  unauthorized: '회원 로그인이 필요해요.',
  account_not_configured: '회원 저장소 설정을 준비 중이에요.',
  account_unavailable: '회원 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.'
};
const failure = code => Object.assign(new Error(messages[code] ?? messages.account_unavailable), { code });
const clone = value => value ? { ...value, user: { ...value.user } } : null;
function nickname(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if ([...name].length < 2 || [...name].length > 12 || /[\u0000-\u001f\u007f]/u.test(name)) throw failure('invalid_nickname');
  return name;
}

/** Registered members have their own persisted session; no anonymous signup fallback. */
export function createAccountClient({ fetch: request = (...args) => globalThis.fetch(...args), storage, now = Date.now, timeoutMs = 12000 } = {}) {
  let config = null, key = '', current = null, generation = 0, refreshing = null;
  const normalize = value => {
    const user = value?.user;
    if (!user || typeof user.id !== 'string' || !user.id || typeof user.email !== 'string' || !user.email || user.is_anonymous === true ||
      typeof value.access_token !== 'string' || !value.access_token || typeof value.refresh_token !== 'string' || !value.refresh_token) return null;
    const expiresAt = Number(value.expires_at) || Math.floor(now() / 1000) + Number(value.expires_in || 0);
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null;
    return { access_token: value.access_token, refresh_token: value.refresh_token, expires_at: expiresAt,
      user: { id: user.id, email: user.email, is_anonymous: false } };
  };
  const save = session => {
    current = session;
    try { if (session) storage?.setItem(key, JSON.stringify(session)); else storage?.removeItem(key); } catch { /* Sessions still work in memory. */ }
  };
  const configured = () => { if (!config) throw failure('auth_not_configured'); return { ...config }; };
  async function auth(path, body, token, snapshot = configured()) {
    let response;
    try {
      response = await request(`${snapshot.supabaseUrl}/auth/v1/${path}`, {
        method: 'POST', headers: { apikey: snapshot.supabaseAnonKey, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs)
      });
    } catch { throw failure('auth_unavailable'); }
    let data = null;
    try { data = await response.json(); } catch { /* Logout may have no response body. */ }
    if (response.status >= 500 || response.status === 408 || response.status === 429) throw failure('auth_unavailable');
    return { response, data };
  }
  const credentials = (email, password, signup) => {
    email = typeof email === 'string' ? email.trim() : '';
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw failure('invalid_email');
    if (typeof password !== 'string' || password.length < (signup ? 8 : 1) || password.length > 128) throw failure('invalid_password');
    return { email, password };
  };
  async function getAccessToken() {
    if (!current) return null;
    if (current.expires_at > now() / 1000 + 60) return current.access_token;
    if (refreshing) return refreshing;
    const initial = current, operation = generation;
    const pending = (async () => {
      const { response, data } = await auth('token?grant_type=refresh_token', { refresh_token: initial.refresh_token });
      if (operation !== generation) return null;
      const next = normalize(data);
      if (!response.ok || !next || next.user.id !== initial.user.id) { generation++; save(null); throw failure('session_expired'); }
      save(next); return next.access_token;
    })();
    refreshing = pending;
    try { return await pending; } finally { if (refreshing === pending) refreshing = null; }
  }
  async function account(path, method = 'GET', body) {
    const token = await getAccessToken();
    if (!token) throw failure('unauthorized');
    let response, data;
    try {
      response = await request(path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
      data = await response.json();
    } catch { throw failure('account_unavailable'); }
    if (!response.ok) {
      if (response.status === 401 && current?.access_token === token) { generation++; save(null); }
      throw failure(Object.hasOwn(messages, data?.error) ? data.error : 'account_unavailable');
    }
    return data;
  }
  return Object.freeze({
    configure(value) {
      const url = typeof value?.supabaseUrl === 'string' ? value.supabaseUrl.replace(/\/$/, '') : '';
      const next = url && value.supabaseAnonKey ? { supabaseUrl: url, supabaseAnonKey: value.supabaseAnonKey } : null;
      if (config?.supabaseUrl === next?.supabaseUrl && config?.supabaseAnonKey === next?.supabaseAnonKey) return;
      generation++; refreshing = null; config = next; current = null; key = next ? `popPopMember:${url}` : '';
      try { if (key) current = normalize(JSON.parse(storage?.getItem(key))); } catch { /* Invalid saved credentials require sign-in. */ }
    },
    getSession: () => clone(current),
    getAccessToken,
    async signUp(email, password, requestedName) {
      const snapshot = configured(), input = credentials(email, password, true), name = nickname(requestedName), operation = ++generation;
      const { response, data } = await auth('signup', { ...input, data: { nickname: name } }, null, snapshot);
      if (!response.ok) throw failure('signup_failed');
      const next = normalize(data);
      if (!next && !data?.user?.id) throw failure('signup_failed');
      if (operation !== generation) return { session: null, confirmationRequired: false };
      save(next);
      return { session: clone(next), confirmationRequired: !next };
    },
    async signIn(email, password) {
      const snapshot = configured(), input = credentials(email, password, false), operation = ++generation;
      const { response, data } = await auth('token?grant_type=password', input, null, snapshot);
      const next = normalize(data);
      if (!response.ok || !next) throw failure('auth_failed');
      if (operation !== generation) return null;
      save(next); return clone(next);
    },
    async signOut() {
      const token = current?.access_token, snapshot = config ? { ...config } : null;
      generation++; refreshing = null; save(null);
      if (token && snapshot) { try { await auth('logout?scope=local', null, token, snapshot); } catch { /* Always clear this browser even while offline. */ } }
    },
    getAccount: () => account('/api/account'),
    updateProfile: input => account('/api/account/profile', 'PATCH', { nickname: nickname(input?.nickname) })
  });
}
