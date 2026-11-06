import { randomUUID } from 'node:crypto';
import { resolveMap } from './catalog.js';

const TOTAL_ROUNDS = 3;
const TEAMS = ['blue', 'pink'];
const CONTRIBUTION_COUNTERS = ['score', 'bombsPlaced', 'itemsCollected', 'rescues', 'passes', 'interceptions', 'deliveries'];
const contributionCount = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000) : 0;
const teamValues = values => ({ blue: values.blue, pink: values.pink });
const copyMission = mission => ({ kind: mission.kind, target: mission.target, progress: teamValues(mission.progress) });
const copyOutcome = outcome => outcome ? outcome.draw ? { draw: true } : { winnerTeam: outcome.winnerTeam } : null;
const copyContribution = entry => ({ playerId: entry.playerId, name: entry.name, team: entry.team,
  ...Object.fromEntries(CONTRIBUTION_COUNTERS.map(field => [field, entry[field]])) });

function roundRoster(room) {
  const players = [], ids = new Set();
  for (const player of Array.isArray(room.roster) ? room.roster : []) {
    if (!player || typeof player.id !== 'string' || !player.id || player.id.length > 128 || ids.has(player.id) || !TEAMS.includes(player.team)) continue;
    ids.add(player.id);
    players.push(player);
    if (players.length === 8) break;
  }
  return players;
}

function roundContributions(room) {
  return roundRoster(room).map(player => ({ playerId: player.id,
    name: typeof player.name === 'string' ? [...player.name].slice(0, 12).join('') : 'Popper', team: player.team,
    ...Object.fromEntries(CONTRIBUTION_COUNTERS.map(field => [field, contributionCount(player[field])])) }));
}

function contributionTotals(history) {
  const players = new Map();
  for (const round of history) for (const entry of round.contributions) {
    const total = players.get(entry.playerId);
    if (!total) players.set(entry.playerId, copyContribution(entry));
    else for (const field of CONTRIBUTION_COUNTERS) total[field] += entry[field];
  }
  return [...players.values()];
}

/** The caller owns admission and readiness. Validate before changing any room state. */
export function initializeSeries(room, { seriesMode = 'single', initialMap = room.mapId } = {}) {
  if (!['single', 'party3'].includes(seriesMode) || (seriesMode === 'party3' &&
    (room.mode !== 'team' || room.training || room.matchmaking || !resolveMap(initialMap)))) {
    throw Object.assign(new Error('Invalid party series configuration'), { code: 'invalid_series_mode' });
  }
  room.seriesMode = seriesMode;
  room.series = seriesMode === 'party3' ? {
    id: randomUUID(), round: 1, total: TOTAL_ROUNDS,
    mapCycle: [initialMap, ...['harbor', 'festival', 'garden'].filter(mapId => mapId !== initialMap)].slice(0, TOTAL_ROUNDS),
    points: { blue: 0, pink: 0 }, history: [], complete: false, outcome: null
  } : null;
  if (room.series) room.ranked = false;
  return seriesState(room);
}

function currentMission(room) {
  const series = room.series;
  const recorded = series.history.find(entry => entry.round === series.round);
  if (recorded) return copyMission(recorded.mission);
  const kind = series.round === 2 && room.itemMode !== false ? 'items'
    : series.round === 3 && ['relay', 'harmony'].includes(room.ruleSet) ? 'passes' : 'rescues';
  const target = kind === 'items' ? 5 : kind === 'passes' ? 3 : 2;
  const progress = { blue: 0, pink: 0 };
  // Advancing precedes the transport's gameplay reset. Do not show the previous
  // game's counters during that boundary or count non-roster room occupants.
  if (!room.matchId || !['playing', 'finished'].includes(room.phase) || room.matchId === series.previousMatchId ||
    series.history.some(entry => entry.matchId === room.matchId)) return { kind, target, progress };
  const field = kind === 'items' ? 'itemsCollected' : kind;
  for (const player of roundRoster(room)) {
    const count = Number.isSafeInteger(player[field]) && player[field] > 0 ? player[field] : 0;
    progress[player.team] = Math.min(target, progress[player.team] + count);
  }
  return { kind, target, progress };
}

/** Called synchronously after finishScores; repeated callbacks cannot score twice. */
export function recordSeriesResult(room) {
  const series = room.series;
  if (!series || series.complete || room.phase !== 'finished' || typeof room.matchId !== 'string' || !room.matchId ||
    !room.result || series.previousMatchId === room.matchId || series.history.length !== series.round - 1 ||
    series.history.some(entry => entry.matchId === room.matchId)) return false;
  const outcome = room.result.draw === true ? { draw: true }
    : TEAMS.includes(room.result.winnerTeam) ? { winnerTeam: room.result.winnerTeam } : null;
  if (!outcome) return false;
  const mission = currentMission(room), points = { blue: 0, pink: 0 };
  for (const team of TEAMS) {
    points[team] = (outcome.draw ? 1 : outcome.winnerTeam === team ? 2 : 0) + Number(mission.progress[team] >= mission.target);
    series.points[team] += points[team];
  }
  series.history.push({ round: series.round, matchId: room.matchId, mapId: room.mapId, points, mission, outcome,
    contributions: roundContributions(room) });
  if (series.round === TOTAL_ROUNDS) {
    series.complete = true;
    series.outcome = series.points.blue === series.points.pink ? { draw: true }
      : { winnerTeam: series.points.blue > series.points.pink ? 'blue' : 'pink' };
  }
  return true;
}

/** Call only after readiness agreement, before layout/player reset. Returns the next map. */
export function advanceSeries(room) {
  const series = room.series;
  const last = series?.history.at(-1);
  if (!series || room.phase !== 'finished' || !last || last.round !== series.round || last.matchId !== room.matchId) return null;
  if (series.complete) {
    initializeSeries(room, { seriesMode: 'party3', initialMap: series.mapCycle[0] });
    room.series.previousMatchId = room.matchId;
  } else {
    series.round++;
  }
  room.mapId = room.series.mapCycle[room.series.round - 1];
  return room.mapId;
}

/** Read-only allowlist projection; no roster, credentials or shared nested values escape. */
export function seriesState(room) {
  const series = room.series;
  if (!series) return null;
  return {
    id: series.id, round: series.round, total: series.total, mapCycle: [...series.mapCycle],
    points: teamValues(series.points), mission: currentMission(room), contributions: contributionTotals(series.history),
    history: series.history.map(entry => ({ round: entry.round, matchId: entry.matchId, mapId: entry.mapId,
      points: teamValues(entry.points), mission: copyMission(entry.mission), outcome: copyOutcome(entry.outcome),
      contributions: entry.contributions.map(copyContribution) })),
    complete: series.complete, outcome: copyOutcome(series.outcome)
  };
}
