// Record real Laya-driven runs of the live demos, for replay on a static site with no model.
//
//     node tools/record_run.mjs                 # needs `python server.py` running
//     SECONDS=90 SEED=7 node tools/record_run.mjs
//     ONLY=tetris node tools/record_run.mjs     # one demo; the other recordings stay as they are
//
// Each game is simulated headlessly at the browser's fixed timestep. Every decision is a real
// call to the local model; the simulation advances by the measured round-trip time before the
// action is applied, exactly as it would in the browser. Nothing is scripted or filtered.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import demos from '../static/demos/index.js';
import { STEP, MIN_GAP, answersFrom } from '../static/sim.js';

const API = process.env.LAYA_API || 'http://127.0.0.1:8770';
const SECONDS = +(process.env.SECONDS || 60), SEED = +(process.env.SEED || 20260920);
const OUT = fileURLToPath(new URL('../static/data/', import.meta.url));

async function predict(body) {
  const r = await fetch(API + '/api/predict', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json()).error);
  return r.json();
}

const health = await (await fetch(API + '/api/health')).json();
mkdirSync(OUT, { recursive: true });

for (const demo of demos) {
  if (process.env.ONLY && !process.env.ONLY.split(',').includes(demo.id)) continue;   // ONLY=tetris leaves the other recordings alone
  if (health.models[demo.checkpoint] !== 'ready') throw new Error(`${demo.checkpoint} checkpoint is not loaded yet`);
  const inst = demo.create(SEED), params = Object.fromEntries(demo.params.map(p => [p.id, p.value]));
  const total = Math.round(SECONDS / STEP), decisions = [];
  let step = 0;
  const advance = n => { for (let i = 0; i < n && step < total; i++, step++) inst.update(STEP, {}); };

  const warm = inst.observe();
  for (let i = 0; i < 3; i++) await predict({ state: warm.state, questions: warm.questions, model: demo.checkpoint });

  while (step < total) {
    if (inst.dead) { advance(1); continue; }
    const obs = inst.observe(), s0 = step, t0 = performance.now();
    const res = await predict({ state: obs.state, questions: obs.questions, model: demo.checkpoint });
    advance(Math.max(1, Math.ceil((performance.now() - t0) / 1000 / STEP)));   // the game kept running meanwhile
    const probs = Object.values(Object.values(res.answers)[0].probabilities).map(p => +p.toFixed(3));
    inst.act(answersFrom(obs, probs), params, true);   // act on the rounded values so replay is bit-exact
    decisions.push([s0, step, probs, +res.latency_ms.toFixed(1)]);
    if (step - s0 < MIN_GAP) advance(MIN_GAP - (step - s0));
  }

  const ms = decisions.map(d => d[3]).sort((a, b) => a - b);
  const summary = { score: inst.score, best: inst.best, crashes: inst.crashes, decisions: decisions.length,
    per_second: +(decisions.length / SECONDS).toFixed(1), median_ms: ms[ms.length >> 1] };
  writeFileSync(`${OUT}run-${demo.id}.json`, JSON.stringify({
    demo: demo.id, checkpoint: demo.checkpoint, seed: SEED, steps: total, params,
    recorded: new Date().toISOString().slice(0, 10), machine: process.env.MACHINE || 'Apple M1 Max, GPU', laya: health.version,
    summary, decisions }));
  console.log(demo.id.padEnd(8), JSON.stringify(summary));
}
