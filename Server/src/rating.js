const K = 32;
const MAX_RATING = 2147483647;
const SCORES = Object.freeze({ win: 1, loss: 0, draw: 0.5 });

/** Clamp before adding so even a large safe integer delta cannot overflow. */
export function applyRatingDelta(rating, delta) {
  if (!Number.isInteger(rating) || rating < 0 || rating > MAX_RATING || !Number.isSafeInteger(delta)) {
    throw new TypeError('Invalid rating or rating delta');
  }
  if (delta < -rating) return 0;
  if (delta > MAX_RATING - rating) return MAX_RATING;
  return rating + delta || 0;
}

/** Team means may be fractional; cap the gap before exponentiation. */
export function expectedScore(ownMean, opponentMean) {
  if (![ownMean, opponentMean].every(value => Number.isFinite(value) && value >= 0)) {
    throw new TypeError('Rating means must be finite nonnegative numbers');
  }
  const difference = Math.max(-800, Math.min(800, opponentMean - ownMean));
  return 1 / (1 + 10 ** (difference / 400));
}

/** Round half away from zero, then normalize negative zero. */
export function eloDelta(ownMean, opponentMean, score) {
  if (![0, 0.5, 1].includes(score)) throw new TypeError('Rating score must be 0, 0.5 or 1');
  const raw = K * (score - expectedScore(ownMean, opponentMean));
  return Math.sign(raw) * Math.round(Math.abs(raw)) || 0;
}

/** Calculate changes from one immutable pre-update rating snapshot. The caller
 * owns profile updates and bounds after applying the returned signed delta. */
export function calculateRatingChanges(mode, participants) {
  if (!['team', 'duel'].includes(mode)) throw new TypeError('Invalid rating match mode');
  if (!Array.isArray(participants) || participants.length > (mode === 'team' ? 8 : 2)) {
    throw new TypeError('Invalid rating participant count');
  }
  const identities = new Set();
  for (const player of participants) {
    if (!player || typeof player !== 'object' || Array.isArray(player) ||
        typeof player.userId !== 'string' || !player.userId.trim() || player.userId.length > 128 ||
        identities.has(player.userId) || !Number.isInteger(player.rating) || player.rating < 0 || player.rating > MAX_RATING ||
        typeof player.outcome !== 'string' || !Object.hasOwn(SCORES, player.outcome) ||
        (mode === 'team' ? !['blue', 'pink'].includes(player.team) : player.team !== null && player.team !== undefined)) {
      throw new TypeError('Invalid rating participant');
    }
    identities.add(player.userId);
  }
  // Code-point ordering is deterministic across locales and never sorts the input.
  const ordered = [...participants].sort((a, b) => a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);
  const changes = new Map(ordered.map(player => [player.userId, 0]));
  const first = mode === 'team' ? ordered.filter(player => player.team === 'blue') : ordered.slice(0, 1);
  const second = mode === 'team' ? ordered.filter(player => player.team === 'pink') : ordered.slice(1);
  for (const side of [first, second]) {
    if (side.some(player => player.outcome !== side[0].outcome)) throw new TypeError('Inconsistent team outcomes');
  }
  // Legacy partial records preserve history without inventing an opponent rating.
  if (!first.length || !second.length) return changes;
  const score = SCORES[first[0].outcome];
  if (score + SCORES[second[0].outcome] !== 1) throw new TypeError('Opposing outcomes must be complementary');
  const mean = side => side.reduce((total, player) => total + player.rating, 0) / side.length;
  const delta = eloDelta(mean(first), mean(second), score);
  // Derive only once so floating-point rounding cannot disagree between sides.
  for (const player of first) changes.set(player.userId, delta);
  for (const player of second) changes.set(player.userId, -delta || 0);
  return changes;
}
