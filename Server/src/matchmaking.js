const MATCH_SIZE = 8;
const QUEUE_TTL_MS = 180000;
const SEARCH_RADII = [100, 150, 200, 250, 300, 350, 400];

export const queueElapsed = (queuedAt, now) => Math.max(0, now - queuedAt);
export const searchRadius = (queuedAt, now) => Math.min(400, 100 + 50 * Math.floor(queueElapsed(queuedAt, now) / 15000));

function balancedTeams(players) {
  const total = players.reduce((sum, player) => sum + player.rating, 0);
  let difference = Infinity, blue;
  // Fix one player on blue: choosing its other three teammates visits all 35
  // distinct 4v4 divisions without also examining their mirrored versions.
  for (let i = 1; i < 6; i++) for (let j = i + 1; j < 7; j++) for (let k = j + 1; k < 8; k++) {
    const team = [players[0], players[i], players[j], players[k]];
    const delta = Math.abs(2 * team.reduce((sum, player) => sum + player.rating, 0) - total);
    if (delta < difference) { difference = delta; blue = team; }
  }
  return { blue, pink: players.filter(player => !blue.includes(player)) };
}

function earlier(candidate, current) {
  if (!current) return true;
  for (let i = 0; i < MATCH_SIZE; i++) {
    if (candidate[i].order !== current[i].order) return candidate[i].order < current[i].order;
  }
  return false;
}

/** Server-owned tickets only. Socket, identity claims and room commits belong
 * to the caller; selection never removes a ticket or mutates its identity. */
export function createMatchmaking({ capacity = 128, clock = Date.now } = {}) {
  const tickets = new Set();
  return Object.freeze({
    get size() { return tickets.size; },
    add(entry) {
      if (tickets.has(entry)) return true;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
          !Number.isSafeInteger(entry.rating) || entry.rating < 0 || tickets.size >= capacity) return false;
      const queuedAt = entry.queuedAt === undefined ? clock() : entry.queuedAt;
      if (!Number.isFinite(queuedAt)) return false;
      if (entry.queuedAt === undefined) entry.queuedAt = queuedAt;
      tickets.add(entry);
      return true;
    },
    remove(entry) { return tickets.delete(entry); },
    has(entry) { return tickets.has(entry); },
    entries() { return [...tickets]; },
    expire() {
      const now = clock(), expired = [];
      for (const entry of tickets) if (queueElapsed(entry.queuedAt, now) >= QUEUE_TTL_MS) {
        tickets.delete(entry);
        expired.push(entry);
      }
      return expired;
    },
    select() {
      const now = clock();
      const available = [...tickets]
        .filter(entry => queueElapsed(entry.queuedAt, now) < QUEUE_TTL_MS)
        .sort((a, b) => a.queuedAt - b.queuedAt)
        .map((entry, order) => ({ entry, order, radius: searchRadius(entry.queuedAt, now) }));
      if (available.length < MATCH_SIZE) return null;
      const lowerBounds = new Set(available.map(player => player.entry.rating));
      let best = null;
      // Every feasible group fits a window starting at its minimum rating with
      // width equal to its least-expanded member's radius. Seven radius values
      // cover every such window in O(7*n²), avoiding an n-choose-8 search.
      search: for (const radius of SEARCH_RADII) for (const lower of lowerBounds) {
        const candidate = [];
        for (const player of available) {
          if (player.radius >= radius && player.entry.rating >= lower && player.entry.rating <= lower + radius) candidate.push(player);
          if (candidate.length === MATCH_SIZE) break;
        }
        if (candidate.length !== MATCH_SIZE || !earlier(candidate, best)) continue;
        best = candidate;
        if (best.every((player, index) => player.order === index)) break search;
      }
      if (!best) return null;
      const players = best.map(player => player.entry);
      return { players, teams: balancedTeams(players) };
    }
  });
}
