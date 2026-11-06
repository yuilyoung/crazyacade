import { resolveAppearance } from './catalog.js';
import { ratingTier, readDemoProfile } from './rankings.js';
import { verifyAccessToken, upsertProfile, readRankedProfile } from './supabase.js';
import { createMatchmaking, searchRadius } from './matchmaking.js';

const requestIdValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const allowedJoin = new Set(['type', 'requestId', 'accessToken', 'name', 'characterId', 'skinId', 'orbSkinId']);
const validName = value => value === undefined || (typeof value === 'string' && [...value].length <= 12);

/**
 * @typedef {Object} QueueState
 * @property {'queue_state'} type
 * @property {string} requestId Correlates only this socket's admission request.
 * @property {'authenticating'|'searching'|'cancelled'|'expired'} status
 * @property {'demo'|'supabase'} source
 * @property {number} [rating] Verified profile or server session rating.
 * @property {string} [tier]
 * @property {number} elapsedMs Server time since accepted queue admission.
 * @property {number} searchRadius
 * @property {8} requiredPlayers
 */

/**
 * Private queue protocol. The room adapter performs assignment without an await.
 * Session operations own cancellation; claims move to a player or queue entry
 * before completion can release them. Successful assignments use joined/state.
 */
export function createQueueSessions({ capacity, demoMode, gate, send, begin, current, finish, cancelOperation, acquireClaim, releaseClaim,
  canAssign, assign, removePlayer, broadcast, isDraining, clock = Date.now }) {
  const queue = createMatchmaking({ capacity, clock });
  let lastUpdate = 0;
  const source = demoMode ? 'demo' : 'supabase';
  const fail = (session, code, requestId) => send(session.socket, { type: 'error', code, ...(requestId ? { requestId } : {}) });
  function notify(session, requestId, status, entry = session.queued) {
    const now = clock(), elapsedMs = entry ? Math.max(0, now - entry.queuedAt) : 0;
    send(session.socket, { type: 'queue_state', requestId, status, source,
      ...(entry ? { rating: entry.rating, tier: ratingTier(entry.rating) } : {}),
      elapsedMs, searchRadius: entry ? searchRadius(entry.queuedAt, now) : 100, requiredPlayers: 8 });
  }
  function releaseEntry(entry, status, notifyClient = true) {
    queue.remove(entry);
    if (entry.session.queued === entry) entry.session.queued = null;
    if (notifyClient) notify(entry.session, entry.requestId, status, entry);
    releaseClaim(entry.session);
  }
  function cancel(session, requestId, { silent = false } = {}) {
    const operation = session.operation;
    if (operation && ['queue', 'next_match'].includes(operation.kind) && (!requestId || operation.requestId === requestId)) {
      cancelOperation(session);
      if (!silent) notify(session, operation.requestId, 'cancelled');
    }
    if (session.queued && (!requestId || session.queued.requestId === requestId)) releaseEntry(session.queued, 'cancelled', !silent);
  }
  async function join(session, message, next = false) {
    const requestId = message.requestId;
    const allowed = next ? new Set(['type', 'requestId', 'matchId']) : allowedJoin;
    if (!requestIdValid(requestId) || Object.keys(message).some(key => !allowed.has(key)) || !validName(message.name) ||
        (!next && message.accessToken !== undefined && typeof message.accessToken !== 'string')) { fail(session, 'invalid_queue', requestIdValid(requestId) ? requestId : undefined); return; }
    if (isDraining()) { fail(session, 'server_draining', requestId); return; }
    if (session.operation || session.queued || (!next && session.player)) { fail(session, 'already_joining', requestId); return; }
    const previous = next ? session.player : null;
    if (next && (!previous?.room.matchmaking || previous.room.phase !== 'finished' || message.matchId !== previous.room.matchId)) { fail(session, 'stale_match', requestId); return; }
    const appearance = next ? resolveAppearance(previous.characterId, previous.skinId, previous.orbSkinId) : resolveAppearance(message.characterId, message.skinId, message.orbSkinId);
    if (!appearance) { fail(session, 'invalid_selection', requestId); return; }
    if (queue.size >= capacity) { fail(session, 'queue_full', requestId); return; }
    const operation = begin(session, next ? 'next_match' : 'queue', requestId);
    const room = previous?.room, matchId = room?.matchId;
    if (previous && room.readyPlayerIds.delete(previous.id)) broadcast(room);
    notify(session, requestId, 'authenticating');
    let stage = 'authentication_unavailable';
    try {
      await gate.run(async () => {
        let user;
        if (next) user = { id: previous.userId, user_metadata: { nickname: previous.name } };
        else if (demoMode) user = session.demoUser;
        else user = await verifyAccessToken(message.accessToken, { signal: operation.controller.signal });
        if (!current(session, operation)) return;
        if (!user) { fail(session, 'unauthorized', requestId); return; }
        if (!acquireClaim(session, user.id)) { fail(session, 'already_in_room', requestId); return; }
        operation.claim = session.claim;
        stage = 'profile_unavailable';
        if (!demoMode && !next) await upsertProfile(user, message.name, { signal: operation.controller.signal });
        if (!current(session, operation)) return;
        const profile = demoMode ? readDemoProfile(user.id) : await readRankedProfile(user.id, { signal: operation.controller.signal });
        if (!current(session, operation)) return;
        // A result room may have moved on while its profile request was in flight.
        if (next && (session.player !== previous || previous.room !== room || room.matchId !== matchId || room.phase !== 'finished')) { fail(session, 'stale_match', requestId); return; }
        const entry = { session, user, appearance, name: previous?.name ?? message.name, authenticated: !demoMode,
          rating: profile.rating, requestId, queuedAt: clock(), source };
        if (!queue.add(entry)) { fail(session, 'queue_full', requestId); return; }
        session.queued = entry;
        if (previous) removePlayer(previous);
        notify(session, requestId, 'searching', entry);
      }, { signal: operation.controller.signal });
    } catch (error) {
      if (current(session, operation)) fail(session, error.code === 'gate_full' ? 'queue_unavailable' : stage, requestId);
    } finally {
      if (session.operation === operation) {
        if (!session.queued && (!session.player || session.player === previous)) notify(session, requestId, 'cancelled');
        finish(session, operation);
        match();
      }
    }
  }
  function match() {
    if (isDraining()) return;
    for (const entry of queue.entries()) {
      if (entry.session.socket.readyState !== entry.session.socket.OPEN || entry.session.queued !== entry) releaseEntry(entry, 'cancelled', false);
    }
    for (const entry of queue.expire()) releaseEntry(entry, 'expired');
    while (canAssign()) {
      const selection = queue.select();
      if (!selection) break;
      // Selection, final liveness check, room creation and queue removal share this synchronous turn.
      if (selection.players.some(entry => entry.session.socket.readyState !== entry.session.socket.OPEN || entry.session.queued !== entry || !entry.session.claim)) {
        for (const entry of selection.players) if (entry.session.socket.readyState !== entry.session.socket.OPEN) releaseEntry(entry, 'cancelled', false);
        break;
      }
      if (!assign(selection, source)) break;
      for (const entry of selection.players) { queue.remove(entry); entry.session.queued = null; }
    }
  }
  return Object.freeze({
    join, cancel, match,
    get size() { return queue.size; },
    tick() {
      match();
      if (clock() - lastUpdate < 1000) return;
      lastUpdate = clock();
      for (const entry of queue.entries()) notify(entry.session, entry.requestId, 'searching', entry);
    },
    drain(sessions) { for (const session of sessions) cancel(session); }
  });
}
