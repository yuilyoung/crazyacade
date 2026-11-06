import { initializeRelay, stepRelay, relayResult, relayState } from './relay.js';
import { initializeHarmonyTraining, stepHarmonyTraining, harmonyTrainingState } from './harmony-training.js';
import { initializeTraining, stepTraining, trainingResult, trainingState } from './training.js';

/** @typedef {{initialize: Function, step: Function, result: Function, snapshot: Function}} RuleStrategy
 * Strategies operate on the existing shared room, without owning session or transport state.
 * initialize(room, {resetPlayer}?) -> void; step(room, context) -> void;
 * result(room, matchTicks?) -> object|null; snapshot(room) -> {relay, training}.
 */
const classic = Object.freeze({
  initialize(room) { initializeRelay(room); },
  step() {},
  result(room, matchTicks = 1200) {
    const survivors = [...room.players.values()].filter(p => p.alive);
    if (room.mode === 'team') {
      const blue = survivors.filter(p => p.team === 'blue').length;
      const pink = survivors.filter(p => p.team === 'pink').length;
      if (blue > 0 && pink > 0 && room.tick < matchTicks) return null;
      return blue === pink ? { draw: true } : { winnerTeam: blue > pink ? 'blue' : 'pink' };
    }
    if (survivors.length > 1 && room.tick < matchTicks) return null;
    return survivors.length === 1 ? { winnerId: survivors[0].userId } : { draw: true };
  },
  snapshot() { return { relay: null, training: null }; }
});
const relay = Object.freeze({
  initialize: initializeRelay, step: stepRelay, result: relayResult,
  snapshot(room) { return { relay: relayState(room), training: null }; }
});
const training = Object.freeze({
  initialize(room, { resetPlayer } = {}) {
    initializeRelay(room);
    // Waiting rooms have no roster yet. Lesson initialization needs populated players.
    if (resetPlayer) initializeTraining(room, resetPlayer);
  },
  step(room, { resetPlayer } = {}) { stepTraining(room, resetPlayer); },
  result: trainingResult,
  snapshot(room) { return { relay: null, training: trainingState(room) }; }
});
const harmonyTraining = Object.freeze({
  initialize(room, { resetPlayer } = {}) { initializeHarmonyTraining(room, resetPlayer); },
  step(room, { resetPlayer } = {}) { stepHarmonyTraining(room, resetPlayer); },
  result: trainingResult,
  snapshot(room) { return { relay: relayState(room), training: harmonyTrainingState(room) }; }
});
/** @returns {RuleStrategy} */
export function ruleFor(room) {
  if (room.training) return room.trainingMode === 'harmony' ? harmonyTraining : training;
  return ['relay', 'harmony'].includes(room.ruleSet) ? relay : classic;
}
