const messages = {
  auth_not_configured: '회원 로그인 설정을 준비 중이에요. 지금은 연습 모드를 이용해 주세요.',
  invalid_email: '이메일 주소를 확인해 주세요.',
  invalid_password: '비밀번호는 8자 이상 128자 이하로 입력해 주세요.',
  invalid_nickname: '닉네임은 2자 이상 12자 이하로 입력해 주세요.',
  auth_failed: '이메일과 비밀번호를 확인해 주세요. 이메일 인증이 필요한 계정은 인증 후 로그인해 주세요.',
  email_not_confirmed: '이메일 인증이 필요해요. 받은 메일에서 확인 링크를 열고 로그인해 주세요.',
  email_rate_limit: '메일 요청이 많아요. 받은 편지함과 스팸함을 확인하고 잠시 후 다시 요청해 주세요.',
  signup_failed: '가입을 완료하지 못했어요. 입력 내용을 확인하거나 잠시 후 다시 시도해 주세요.',
  resend_failed: '확인 메일을 요청하지 못했어요. 이메일 주소를 확인하고 다시 시도해 주세요.',
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

const callbackKeys = ['access_token', 'refresh_token', 'provider_token', 'provider_refresh_token', 'token_hash',
  'token', 'code', 'error', 'error_code', 'error_description', 'error_uri'];

/** Default GoTrue email links verify at the provider. Only a password sign-in changes the member session here. */
export function consumeEmailConfirmation(href, history) {
  const url = new URL(href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const parts = [url.searchParams, fragment];
  const hasCallback = params => callbackKeys.some(key => params.has(key)) || params.get('type') === 'signup';
  if (!parts.some(hasCallback)) return null;

  let status = 'invalid';
  if (parts.some(params => params.get('error_code') === 'otp_expired')) status = 'expired';
  else if (!parts.some(params => params.has('error') || params.has('error_code') || params.has('error_description')) &&
      fragment.get('type') === 'signup' && fragment.get('access_token') && fragment.get('refresh_token')) status = 'opened';

  for (const key of [...callbackKeys, 'type', 'token_type', 'expires_at', 'expires_in', 'state', 'redirect_to', 'code_verifier']) {
    url.searchParams.delete(key);
  }
  if (hasCallback(fragment)) url.hash = '';
  history.replaceState(history.state, '', url.href);
  return status;
}

function emailAddress(value) {
  const email = typeof value === 'string' ? value.trim() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw failure('invalid_email');
  return email;
}

/** Registered members have their own persisted session; no anonymous signup fallback. */
export function createAccountClient({ fetch: request = (...args) => globalThis.fetch(...args), storage, now = Date.now,
  timeoutMs = 12000, location = globalThis.location, getConfirmationRedirect = () => location?.href } = {}) {
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
  function emailEndpoint(path) {
    if (!location?.href) return path;
    const page = new URL(location.href);
    if (!['http:', 'https:'].includes(page.protocol)) return path;
    const target = new URL(getConfirmationRedirect() || page.href, page);
    const source = target.origin === page.origin ? target : page;
    const redirect = new URL(page.origin);
    redirect.pathname = page.pathname;
    for (const key of ['room', 'mode', 'map', 'items', 'rules', 'humans', 'series']) {
      if (source.searchParams.has(key)) redirect.searchParams.set(key, source.searchParams.get(key));
    }
    const play = source.searchParams.get('play');
    if (play === 'friend' || play === 'ranked') redirect.searchParams.set('play', play);
    const team = source.searchParams.get('team');
    if (play === 'friend' && redirect.searchParams.get('mode') === 'team' &&
        ['2', '4', '6'].includes(redirect.searchParams.get('humans')) && ['blue', 'pink'].includes(team)) {
      redirect.searchParams.set('team', team);
    }
    return path + '?' + new URLSearchParams({ redirect_to: redirect.href });
  }
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
    if (response.status === 429 && /^(signup|resend)(\?|$)/.test(path)) throw failure('email_rate_limit');
    if (response.status >= 500 || response.status === 408 || response.status === 429) throw failure('auth_unavailable');
    return { response, data };
  }
  const credentials = (email, password, signup) => {
    email = emailAddress(email);
    if (typeof password !== 'string' || password.length < (signup ? 8 : 1) || password.length > 128) throw failure('invalid_password');
    return { email, password };
  };
  async function getAccessToken() {
    if (!current) return null;
    if (current.expires_at > now() / 1000 + 60) return current.access_token;
    if (refreshing) return refreshing;
    const initial = current;
    const pending = (async () => {
      const { response, data } = await auth('token?grant_type=refresh_token', { refresh_token: initial.refresh_token });
      if (initial !== current) return null;
      const next = normalize(data);
      if (!response.ok || !next || next.user.id !== initial.user.id) { save(null); throw failure('session_expired'); }
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
      const { response, data } = await auth(emailEndpoint('signup'), { ...input, data: { nickname: name } }, null, snapshot);
      if (!response.ok) throw failure('signup_failed');
      const next = normalize(data);
      // Raw GoTrue returns User directly while email confirmation is pending.
      // A confirmed signup instead returns tokens and a nested user.
      const confirmationUser = data?.user ?? data;
      const pendingConfirmation = confirmationUser && typeof confirmationUser.id === 'string' && confirmationUser.id.trim() &&
        typeof confirmationUser.email === 'string' && confirmationUser.email.trim() && confirmationUser.is_anonymous !== true &&
        !Object.hasOwn(data, 'access_token') && !Object.hasOwn(data, 'refresh_token');
      if (!next && !pendingConfirmation) throw failure('signup_failed');
      if (operation !== generation) return { session: null, confirmationRequired: false };
      if (next) save(next);
      return { session: clone(next), confirmationRequired: !next };
    },
    async resendConfirmation(email) {
      const { response } = await auth(emailEndpoint('resend'), { type: 'signup', email: emailAddress(email) });
      if (!response.ok) throw failure('resend_failed');
    },
    async signIn(email, password) {
      const snapshot = configured(), input = credentials(email, password, false), operation = ++generation;
      const { response, data } = await auth('token?grant_type=password', input, null, snapshot);
      if (!response.ok && (data?.error_code === 'email_not_confirmed' || data?.code === 'email_not_confirmed' ||
          data?.error_description === 'Email not confirmed' || data?.msg === 'Email not confirmed')) throw failure('email_not_confirmed');
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
