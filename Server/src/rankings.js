import { persistMatch, readLeaderboard } from './supabase.js';

const demoProfiles = new Map();
const recordedDemoMatches = new Set();
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : fallback;
const name = value => typeof value === 'string' ? [...value].slice(0, 12).join('') : 'Popper';

export function ratingTier(rating) {
  if (rating >= 1450) return 'Diamond';
  if (rating >= 1250) return 'Gold';
  if (rating >= 1100) return 'Silver';
  return 'Bronze';
}

function outcomeFor(result, participant) {
  if (result.draw) return 'draw';
  if (result.winnerTeam) return participant.team === result.winnerTeam ? 'win' : 'loss';
  if (result.winnerId) return participant.userId === result.winnerId ? 'win' : 'loss';
  return 'draw';
}

/** Runs once on a completed match; retained starters include disconnected players. */
export async function finalizeMatch(room, env = process.env) {
  if (room.practice === true || room.ruleSet === 'relay') return;
  if (!room.matchId) throw new Error('Match ID is required');
  const starters = room.roster ?? room.participants;
  if (!Array.isArray(starters)) throw new Error('Match participant snapshot is required');
  room.participants = starters.map(p => ({ userId: p.userId, team: p.team, score: Math.min(number(p.score), 1000000) }));
  if (env.ALLOW_DEV_GUESTS !== 'true') return persistMatch(room);
  if (recordedDemoMatches.has(room.matchId)) return;
  const result = room.result ?? { draw: true };
  for (const participant of starters) {
    if (typeof participant.userId !== 'string') continue;
    const profile = demoProfiles.get(participant.userId) ?? { name: name(participant.name), rating: 1000, wins: 0, losses: 0, draws: 0, score: 0 };
    const outcome = outcomeFor(result, participant);
    profile.name = name(participant.name);
    profile.rating = Math.max(0, profile.rating + (outcome === 'win' ? 25 : outcome === 'loss' ? -15 : 5));
    profile[outcome === 'win' ? 'wins' : outcome === 'loss' ? 'losses' : 'draws']++;
    profile.score += Math.min(number(participant.score), 1000000);
    demoProfiles.set(participant.userId, profile);
  }
  recordedDemoMatches.add(room.matchId);
  // Development-only history is bounded and deliberately does not survive restarts.
  if (recordedDemoMatches.size > 5000) recordedDemoMatches.delete(recordedDemoMatches.values().next().value);
  while (demoProfiles.size > 1000) demoProfiles.delete(demoProfiles.keys().next().value);
}

export async function getLeaderboard(env = process.env) {
  const source = env.ALLOW_DEV_GUESTS === 'true' ? 'demo' : 'supabase';
  const profiles = source === 'demo' ? [...demoProfiles.values()] : await readLeaderboard(env);
  const entries = profiles.map(p => ({
    name: name(p.name ?? p.nickname), rating: number(p.rating, 1000),
    wins: number(p.wins), losses: number(p.losses), draws: number(p.draws), score: number(p.score)
  })).sort((a, b) => b.rating - a.rating || b.score - a.score || a.name.localeCompare(b.name)).slice(0, 50)
    .map((p, index) => ({ rank: index + 1, ...p, tier: ratingTier(p.rating) }));
  return { source, entries };
}
