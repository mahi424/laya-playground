// Check that every recorded run replays to exactly the outcome it was recorded with.
// Uses the same stepping rules as the browser stage (static/live.js → GameStage.tick).
//
//     node tools/verify_replay.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import demos from '../static/demos/index.js';
import { STEP, answersFrom } from '../static/sim.js';

let failed = false;
for (const demo of demos) {
  const run = JSON.parse(readFileSync(fileURLToPath(new URL(`../static/data/run-${demo.id}.json`, import.meta.url))));
  const inst = demo.create(run.seed), d = run.decisions;
  let ri = 0, pending = null, applied = 0;
  for (let step = 0; step < run.steps; step++) {
    if (pending && d[ri][1] === step) { inst.act(answersFrom(pending, d[ri++][2]), run.params, true); pending = null; applied++; }
    if (!pending && ri < d.length && d[ri][0] === step) pending = inst.observe();
    inst.update(STEP, {});
  }
  const got = { score: inst.score, best: inst.best, crashes: inst.crashes }, want = run.summary;
  const ok = got.score === want.score && got.best === want.best && got.crashes === want.crashes;
  failed ||= !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${demo.id.padEnd(8)} replayed ${applied}/${d.length} decisions -> ${JSON.stringify(got)}  recorded ${JSON.stringify({ score: want.score, best: want.best, crashes: want.crashes })}`);
}
process.exit(failed ? 1 : 0);
