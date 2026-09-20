// Timing shared by the browser stage and the headless recorder (tools/record_run.mjs), so a
// recorded run replays step for step.

export const STEP = 1 / 120;       // fixed simulation timestep, seconds
export const MAX_RATE = 40;        // decisions per second, upper bound
export const MIN_GAP = Math.ceil(1 / MAX_RATE / STEP);  // steps between two observations

/** Rebuild the `answers` object a demo's act() expects from a recorded probability list. */
export function answersFrom(obs, probs) {
  const [qid, q] = Object.entries(obs.questions)[0];
  const keys = Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria);
  const probabilities = Object.fromEntries(keys.map((k, i) => [k, probs[i]]));
  return { [qid]: { type: q.type, probabilities, choice: keys[probs.indexOf(Math.max(...probs))] } };
}
