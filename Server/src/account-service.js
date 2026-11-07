import { createAuthProvider } from './supabase.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const profileFields = 'id,nickname,rating,wins,losses,draws,score,created_at,updated_at';
export const accountError = (code, status = 503) => Object.assign(new Error(code), { code, status });
const integer = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
function profileView(rows, userId) {
  const row = rows?.[0];
  if (!Array.isArray(rows) || rows.length !== 1 || row?.id !== userId || typeof row.nickname !== 'string' ||
    !['rating', 'wins', 'losses', 'draws', 'score'].every(key => integer(row[key])) || !timestamp(row.created_at) || !timestamp(row.updated_at)) throw accountError('account_unavailable');
  return { id: row.id, nickname: row.nickname, rating: row.rating, wins: row.wins, losses: row.losses, draws: row.draws, score: row.score,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

/** All storage filters are derived from a Supabase-verified member, never request ids. */
export function createAccountService({ env = process.env, fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 5000 } = {}) {
  const base = env.SUPABASE_URL?.replace(/\/$/, ''), key = env.SUPABASE_SERVICE_ROLE_KEY;
  const auth = createAuthProvider({ env, fetchImpl, timeoutMs });
  async function member(token) {
    if (!token) throw accountError('unauthorized', 401);
    if (!base || !key) throw accountError('account_not_configured');
    let user;
    try { user = await auth.verifyAccessToken(token); } catch { throw accountError('account_unavailable'); }
    if (!user || !uuid.test(user.id) || user.is_anonymous === true || typeof user.email !== 'string' || !user.email) throw accountError('unauthorized', 401);
    return user;
  }
  async function query(table, values, { method = 'GET', body, prefer } = {}) {
    try {
      const response = await fetchImpl(`${base}/rest/v1/${table}?${new URLSearchParams(values)}`, {
        method, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw accountError('account_unavailable'); }
      return { rows: method === 'HEAD' ? null : await response.json(), response };
    } catch { throw accountError('account_unavailable'); }
  }
  async function readProfile(user) {
    const values = { select: profileFields, id: `eq.${user.id}`, limit: '2' };
    let { rows } = await query('profiles', values);
    if (Array.isArray(rows) && rows.length === 0) {
      // Older accounts and newly registered users may not have played a match yet.
      try { await auth.upsertProfile(user); } catch { throw accountError('account_unavailable'); }
      ({ rows } = await query('profiles', values));
    }
    return profileView(rows, user.id);
  }
  async function rank(profile) {
    const { response } = await query('profiles', { select: 'id', or: `(rating.gt.${profile.rating},and(rating.eq.${profile.rating},score.gt.${profile.score}))`, limit: '1' }, { method: 'HEAD', prefer: 'count=exact' });
    const total = response.headers.get('content-range')?.split('/')[1];
    if (!/^\d+$/.test(total ?? '') || !integer(Number(total))) throw accountError('account_unavailable');
    return Number(total) + 1;
  }
  async function matches(userId) {
    const { rows } = await query('match_participants', { select: 'user_id,match_id,team,outcome,score,matches!inner(id,mode,played_at)',
      user_id: `eq.${userId}`, order: 'matches(played_at).desc', limit: '20' });
    if (!Array.isArray(rows) || rows.length > 20) throw accountError('account_unavailable');
    return rows.map(row => {
      const match = row.matches;
      if (row.user_id !== userId || typeof row.match_id !== 'string' || match?.id !== row.match_id ||
        !['team', 'duel'].includes(match.mode) || !timestamp(match.played_at) || !['win', 'loss', 'draw'].includes(row.outcome) ||
        !integer(row.score) || ![null, 'blue', 'pink'].includes(row.team)) throw accountError('account_unavailable');
      return { id: match.id, mode: match.mode, playedAt: match.played_at, outcome: row.outcome, score: row.score, team: row.team };
    });
  }
  async function payments(userId) {
    const { rows } = await query('payment_records', { select: 'id,user_id,description,amount_minor,currency,status,created_at', user_id: `eq.${userId}`, order: 'created_at.desc,id.desc', limit: '20' });
    if (!Array.isArray(rows) || rows.length > 20) throw accountError('account_unavailable');
    return rows.map(row => {
      if (row.user_id !== userId || typeof row.id !== 'string' || typeof row.description !== 'string' || row.description.length > 160 ||
        !integer(row.amount_minor) || !/^[A-Z]{3}$/.test(row.currency) || !['pending', 'paid', 'failed', 'cancelled', 'refunded'].includes(row.status) || !timestamp(row.created_at)) throw accountError('account_unavailable');
      return { id: row.id, description: row.description, amountMinor: row.amount_minor, currency: row.currency, status: row.status, createdAt: row.created_at };
    });
  }
  return Object.freeze({
    async getAccount(token) {
      const user = await member(token), profile = await readProfile(user);
      const [ranking, history, paymentHistory] = await Promise.allSettled([rank(profile), matches(user.id), payments(user.id)]);
      const games = profile.wins + profile.losses + profile.draws;
      return { user: { id: user.id, email: user.email }, profile,
        stats: { games, winRate: games ? Math.round(profile.wins / games * 1000) / 10 : 0, rank: ranking.status === 'fulfilled' ? ranking.value : null },
        recentMatches: history.status === 'fulfilled' ? history.value : null, historyStatus: history.status === 'fulfilled' ? 'available' : 'unavailable',
        payments: paymentHistory.status === 'fulfilled' ? paymentHistory.value : null, paymentStatus: paymentHistory.status === 'fulfilled' ? 'history_only' : 'unavailable' };
    },
    async updateProfile(token, input) {
      const user = await member(token);
      const nickname = typeof input?.nickname === 'string' ? input.nickname.trim() : '';
      if ([...nickname].length < 2 || [...nickname].length > 12 || /[\u0000-\u001f\u007f]/u.test(nickname)) throw accountError('invalid_nickname', 400);
      await readProfile(user);
      const { rows } = await query('profiles', { id: `eq.${user.id}`, select: profileFields }, { method: 'PATCH', body: { nickname }, prefer: 'return=representation' });
      return { profile: profileView(rows, user.id) };
    }
  });
}
