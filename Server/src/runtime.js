// Only deployment settings can alter these bounds. No player/IP keyed maps or
// application payloads are retained in the runtime diagnostics.
const settings = {
  maxConnections: ['RUNTIME_MAX_CONNECTIONS', 256, 1, 4096],
  maxRooms: ['RUNTIME_MAX_ROOMS', 64, 1, 512],
  maxQueuedPlayers: ['RUNTIME_MAX_QUEUED_PLAYERS', 128, 1, 2048],
  authCapacity: ['RUNTIME_AUTH_CAPACITY', 4, 1, 32],
  authMaxPending: ['RUNTIME_AUTH_MAX_PENDING', 32, 0, 1024],
  messageRate: ['RUNTIME_MESSAGE_RATE', 30, 1, 120],
  messageBurst: ['RUNTIME_MESSAGE_BURST', 60, 1, 240],
  sendSoftBytes: ['RUNTIME_SEND_SOFT_BYTES', 64 * 1024, 1, 1024 * 1024],
  sendHardBytes: ['RUNTIME_SEND_HARD_BYTES', 256 * 1024, 2, 4 * 1024 * 1024],
  sendMaxDelayMs: ['RUNTIME_SEND_MAX_DELAY_MS', 3000, 1, 30000],
  drainMs: ['RUNTIME_DRAIN_MS', 130000, 1, 130000]
};
export const DEFAULT_RUNTIME_LIMITS = Object.freeze(Object.fromEntries(
  Object.entries(settings).map(([key, [, value]]) => [key, value])
));

function validatedLimits(overrides) {
  const limits = { ...DEFAULT_RUNTIME_LIMITS, ...overrides };
  for (const [key, [envKey, , minimum, maximum]] of Object.entries(settings)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < minimum || limits[key] > maximum) {
      throw new TypeError(`Invalid ${envKey}: expected an integer from ${minimum} to ${maximum}`);
    }
  }
  if (limits.sendSoftBytes >= limits.sendHardBytes) throw new TypeError('Invalid send limits: soft must be below hard');
  return Object.freeze(limits);
}

export function loadRuntimeLimits(env = process.env) {
  const overrides = {};
  for (const [key, [envKey]] of Object.entries(settings)) {
    if (env[envKey] === undefined) continue;
    if (typeof env[envKey] !== 'string' || !/^\d+$/.test(env[envKey])) throw new TypeError(`Invalid ${envKey}: expected an integer`);
    overrides[key] = Number(env[envKey]);
  }
  return validatedLimits(overrides);
}

const nonnegative = value => Number.isFinite(value) ? Math.max(0, value) : 0;
const count = value => Math.min(Number.MAX_SAFE_INTEGER, Math.floor(nonnegative(value)));

export function createRuntime({ limits: overrides = {}, clock = () => performance.now() } = {}) {
  const limits = validatedLimits(overrides), sockets = new Map();
  const startedAt = clock();
  let draining = false, closed = false;
  const metrics = {
    connectionsRejected: 0, messagesAccepted: 0, messagesRejected: 0,
    rateLimitedSockets: 0, slowSockets: 0, stateSkipped: 0, sendErrors: 0,
    ticks: 0, tickDurationMs: 0, tickMaxDurationMs: 0, tickLagMs: 0, tickMaxLagMs: 0
  };

  function releaseSocket(socket) {
    const entry = sockets.get(socket);
    if (!entry) return;
    clearTimeout(entry.backlogTimer); clearTimeout(entry.closeTimer);
    socket.off?.('close', entry.onClose);
    sockets.delete(socket);
  }

  function disconnect(socket, entry, code, reason) {
    if (entry.closing) return;
    entry.closing = true;
    clearTimeout(entry.backlogTimer);
    try { socket.close(code, reason); } catch { socket.terminate(); }
    // A close frame itself can be stuck behind a slow peer's backlog. Bound its
    // grace period as well; this timer is owned by an admitted socket.
    if (sockets.has(socket)) {
      entry.closeTimer = setTimeout(() => { socket.terminate(); releaseSocket(socket); }, 250);
      entry.closeTimer.unref?.();
    }
  }

  function checkBacklog(socket, entry) {
    if (entry.closing) return false;
    const buffered = nonnegative(socket.bufferedAmount), now = clock();
    if (buffered < limits.sendSoftBytes) {
      entry.backlogSince = null;
      clearTimeout(entry.backlogTimer); entry.backlogTimer = null;
      return true;
    }
    entry.backlogSince ??= now;
    if (buffered >= limits.sendHardBytes || now - entry.backlogSince >= limits.sendMaxDelayMs) {
      metrics.slowSockets++;
      disconnect(socket, entry, 1013, 'Client too slow');
      return false;
    }
    if (!entry.backlogTimer) {
      entry.backlogTimer = setTimeout(() => {
        entry.backlogTimer = null;
        if (sockets.get(socket) === entry) checkBacklog(socket, entry);
      }, Math.max(1, limits.sendMaxDelayMs - (now - entry.backlogSince)));
      entry.backlogTimer.unref?.();
    }
    return true;
  }

  function sendControl(socket, method, payload = Buffer.alloc(0)) {
    const entry = sockets.get(socket);
    if (!entry || socket.readyState !== socket.OPEN || !checkBacklog(socket, entry)) return false;
    if ((!Buffer.isBuffer(payload) && typeof payload !== 'string') || Buffer.byteLength(payload) > 125) return false;
    if (socket.bufferedAmount + Buffer.byteLength(payload) + 2 > limits.sendHardBytes) {
      metrics.slowSockets++;
      disconnect(socket, entry, 1013, 'Client too slow');
      return false;
    }
    try {
      socket[method](payload, undefined, error => {
        if (!error || sockets.get(socket) !== entry || entry.closing) return;
        metrics.sendErrors++;
        disconnect(socket, entry, 1011, 'Send failed');
      });
      return checkBacklog(socket, entry);
    } catch {
      metrics.sendErrors++;
      disconnect(socket, entry, 1011, 'Send failed');
      return false;
    }
  }

  return {
    admitSocket(socket) {
      if (sockets.has(socket)) return !sockets.get(socket).closing;
      if (closed || draining || sockets.size >= limits.maxConnections) {
        metrics.connectionsRejected++;
        try { socket.close(1013, draining ? 'Server draining' : 'Server at capacity'); }
        finally { socket.terminate(); }
        return false;
      }
      if (socket.readyState !== socket.OPEN) return false;
      const entry = { tokens: limits.messageBurst, receivedAt: clock(), violations: 0, violationWindowAt: clock(),
        backlogSince: null, backlogTimer: null, closeTimer: null, closing: false,
        onClose: () => releaseSocket(socket) };
      sockets.set(socket, entry);
      socket.once('close', entry.onClose);
      return true;
    },
    releaseSocket,
    allowMessage(socket) {
      const entry = sockets.get(socket);
      if (!entry || entry.closing || socket.readyState !== socket.OPEN) return false;
      const now = clock();
      entry.tokens = Math.min(limits.messageBurst, entry.tokens + Math.max(0, now - entry.receivedAt) * limits.messageRate / 1000);
      entry.receivedAt = now;
      if (entry.tokens < 1) {
        metrics.messagesRejected++;
        // Successful token refills do not erase a sustained pattern of abuse.
        if (now - entry.violationWindowAt >= 1000) { entry.violations = 0; entry.violationWindowAt = now; }
        if (++entry.violations >= 8) {
          metrics.rateLimitedSockets++;
          disconnect(socket, entry, 1008, 'Message rate exceeded');
        }
        return false;
      }
      entry.tokens--; metrics.messagesAccepted++;
      return true;
    },
    ping(socket, payload) { return sendControl(socket, 'ping', payload); },
    pong(socket, payload) { return sendControl(socket, 'pong', payload); },
    send(socket, payload, { replaceable = false } = {}) {
      const entry = sockets.get(socket);
      if (!entry || socket.readyState !== socket.OPEN || !checkBacklog(socket, entry)) return false;
      if (replaceable && socket.bufferedAmount >= limits.sendSoftBytes) { metrics.stateSkipped++; return false; }
      try {
        const message = typeof payload === 'string' ? payload : JSON.stringify(payload);
        if (socket.bufferedAmount + Buffer.byteLength(message) > limits.sendHardBytes) {
          metrics.slowSockets++;
          disconnect(socket, entry, 1013, 'Client too slow');
          return false;
        }
        socket.send(message, error => {
          if (!error || sockets.get(socket) !== entry || entry.closing) return;
          metrics.sendErrors++;
          disconnect(socket, entry, 1011, 'Send failed');
        });
        return checkBacklog(socket, entry);
      } catch {
        metrics.sendErrors++;
        disconnect(socket, entry, 1011, 'Send failed');
        return false;
      }
    },
    recordTick({ durationMs = 0, lagMs = 0 } = {}) {
      metrics.ticks++;
      metrics.tickDurationMs = nonnegative(durationMs);
      metrics.tickLagMs = nonnegative(lagMs);
      metrics.tickMaxDurationMs = Math.max(metrics.tickMaxDurationMs, metrics.tickDurationMs);
      metrics.tickMaxLagMs = Math.max(metrics.tickMaxLagMs, metrics.tickLagMs);
    },
    snapshot({ rooms = 0, queuedPlayers = 0, auth = {} } = {}) {
      return { draining, connections: sockets.size, maxConnections: limits.maxConnections,
        rooms: count(rooms), maxRooms: limits.maxRooms, queuedPlayers: count(queuedPlayers), maxQueuedPlayers: limits.maxQueuedPlayers,
        authActive: count(auth.active), authPending: count(auth.pending), authRejected: count(auth.rejected),
        authCapacity: limits.authCapacity, authMaxPending: limits.authMaxPending,
        ...metrics, rssBytes: process.memoryUsage().rss, uptimeSeconds: nonnegative(clock() - startedAt) / 1000 };
    },
    setDraining(value = true) { draining = closed || Boolean(value); },
    close() {
      closed = true; draining = true;
      for (const socket of sockets.keys()) { socket.terminate(); releaseSocket(socket); }
    }
  };
}
