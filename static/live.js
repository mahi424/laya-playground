// Game stages. Each `.game-mount[data-demo]` gets its own stage and decision feed.
//
// With the local model connected, Laya plays live: the simulation runs on a fixed timestep and
// a separate async loop asks the model for decisions, so the game never waits. Without a model
// (a static deployment, or while checkpoints load) the stage replays a recorded run made by
// tools/record_run.mjs: real model decisions, reproduced step for step from a seed.
import demos from './demos/index.js';
import { Stage } from './dither.js';
import { STEP, MAX_RATE, answersFrom } from './sim.js';
import { h, bar, predict } from './ui.js';

const TONES = ['#0c0c0c', '#ffc609'];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const keys = new Set(), pressed = new Set(), stages = [];
let health = window.layaHealth ?? null;   // null: unknown, false: no server, object: checkpoint states

class GameStage {
  constructor(mount, demo) {
    Object.assign(this, { demo, pilot: 'laya', paused: reducedMotion, ratio: 0, mode: null, run: undefined, epoch: 0, acc: 0, feedDirty: true });
    this.params = Object.fromEntries(demo.params.map(p => [p.id, p.value]));
    this.build(mount);
    this.stage = new Stage(this.el.canvas, { w: 768, h: 432, tones: TONES });
    this.width = this.el.canvas.clientWidth;
    this.start('replay');
    fetch(`static/data/run-${demo.id}.json`).then(r => r.ok ? r.json() : null).catch(() => null).then(run => { this.run = run; if (this.mode === 'replay') this.start('replay'); });
    new IntersectionObserver(es => { this.ratio = es[0].isIntersecting ? es[0].intersectionRatio : 0; }, { threshold: [0, 0.25, 0.5, 0.75, 1] }).observe(mount);
    this.decide();
  }

  build(mount) {
    const el = this.el = {}, d = this.demo, dd = k => (el[k] = h('dd', {}, '—'));
    const pick = (values, on) => { const box = h('div', { class: 'seg', role: 'group' });
      box.append(...values.map(([v, label], i) => h('button', { class: i ? '' : 'on', onclick: e => { for (const b of box.children) b.classList.toggle('on', b === e.target); on(v); } }, label))); return box; };
    el.canvas = h('canvas', { class: 'pixelated', tabindex: 0, 'aria-label': d.title + ' game stage', onpointerdown: () => { if (this.pilot === 'you') pressed.add('pointer'); } });
    el.score = h('b', {}, '0000'); el.best = h('b', {}, '0000'); el.crashes = h('b', {}, '000'); el.msg = h('span');
    el.pause = h('button', { onclick: () => { this.paused = !this.paused; } });
    el.banner = h('p', { class: 'banner' });
    mount.append(
      h('div', {},
        h('div', { class: 'stage' }, el.canvas, el.banner,
          h('div', { class: 'hud' }, h('span', {}, 'SCORE ', el.score), h('span', {}, 'BEST ', el.best), h('span', { class: 'sp' }), h('span', {}, 'CRASHES ', el.crashes)),
          h('div', { class: 'stage-msg' }, el.msg)),
        h('div', { class: 'controls' }, pick([['laya', 'LAYA PLAYS'], ['you', 'YOU PLAY']], v => { this.pilot = v; el.canvas.focus({ preventScroll: true }); }), el.pause, h('span', { class: 'keys' }, d.keys))),
      h('dl', { class: 'feed' },
        h('dt', {}, 'SOURCE'), dd('source'), h('dt', {}, 'STATE SENT'), dd('state'), h('dt', {}, 'QUESTION'), dd('question'),
        h('dt', {}, 'ANSWER'), dd('bars'), h('dt', {}, 'ACTION'), dd('action'), h('dt', {}, 'TIMING'), dd('timing')));
  }

  // ---------------------------------------------------------------- modes
  ready() { return !!health && health.models[this.demo.checkpoint] === 'ready'; }
  wantMode() { return this.pilot === 'you' ? 'you' : this.ready() ? 'live' : 'replay'; }

  start(mode) {
    this.mode = mode; this.epoch++; this.step = 0; this.ri = 0; this.pending = null; this.acc = 0;
    this.feed = null; this.feedDirty = true; this.stamps = []; this.count = 0; this.lat = { model: 0, rtt: 0 }; this.error = '';
    const seed = mode === 'replay' && this.run ? this.run.seed : (Math.random() * 2 ** 32) >>> 0;
    this.inst = this.demo.create(seed);
  }

  tick(input) {
    if (this.mode === 'replay') {
      const d = this.run.decisions;
      if (this.pending && d[this.ri][1] === this.step) {
        const rec = d[this.ri++], answers = answersFrom(this.pending, rec[2]);
        this.note(this.pending, answers, this.inst.act(answers, this.run.params, true), rec[3]);
        this.pending = null;
      }
      if (!this.pending && this.ri < d.length && d[this.ri][0] === this.step) this.pending = this.inst.observe();
    }
    this.inst.update(STEP, input); this.step++;
    if (this.mode === 'replay' && this.step >= this.run.steps) this.start('replay');   // loop the recording
  }

  note(obs, answers, action, ms, rtt) {
    const k = this.count++ ? 0.12 : 1;
    this.lat.model += (ms - this.lat.model) * k; if (rtt != null) this.lat.rtt += (rtt - this.lat.rtt) * k;
    this.stamps.push(this.step); while (this.stamps[0] < this.step - 1 / STEP) this.stamps.shift();
    this.feed = { obs, answers, action }; this.feedDirty = true;
  }

  async decide() {   // live mode only: one request in flight, as fast as the model answers
    for (;;) {
      if (this.mode !== 'live' || !this.active || this.paused || this.inst.dead || document.hidden) { await sleep(80); continue; }   // never call the model for a page nobody is watching
      const mine = this.epoch, obs = this.inst.observe(), t0 = performance.now();
      let res;
      try { res = await predict({ state: obs.state, questions: obs.questions, model: this.demo.checkpoint }); this.error = ''; }
      catch (e) { this.error = e.message; this.feedDirty = true; await sleep(1000); continue; }
      const rtt = performance.now() - t0;
      if (mine !== this.epoch) continue;   // restarted while this was in flight
      this.note(obs, res.answers, this.inst.act(res.answers, this.params, !this.paused), res.latency_ms, rtt);
      if (rtt < 1000 / MAX_RATE) await sleep(1000 / MAX_RATE - rtt);
    }
  }

  // ---------------------------------------------------------------- per frame
  frame(dt, active) {
    this.active = active;
    const want = this.wantMode();
    if (want !== this.mode) this.start(want);
    const playable = this.mode !== 'replay' || this.run;
    if (active && !this.paused && playable) {
      this.acc += dt;
      const input = this.mode === 'you' ? this.demo.input(keys, pressed) : {};
      while (this.acc >= STEP) { this.tick(input); this.acc -= STEP; for (const k in input) input[k] = false; }
      pressed.clear();
    }
    if (!active && this.drawn) return;   // off-stage: keep the last frame, but never leave the canvas blank
    this.drawn = true;
    const { el, inst } = this;
    inst.draw(this.stage.ctx, this.stage.w, this.stage.h); this.stage.present();
    el.score.textContent = String(inst.score).padStart(4, '0');
    el.best.textContent = String(inst.best).padStart(4, '0');
    el.crashes.textContent = String(inst.crashes).padStart(3, '0');
    el.pause.textContent = this.paused ? (this.step ? 'RESUME' : 'START') : 'PAUSE';
    el.msg.textContent = this.paused ? 'PAUSED' : inst.dead ? 'CRASH' : this.error ? 'MODEL UNREACHABLE'
      : !playable ? (this.run === null ? 'RUNS WITH THE LOCAL MODEL' : 'LOADING') : '';
    this.renderBanner();
    if (this.feedDirty) this.renderFeed();
  }

  // What is on screen: a recording on the public site, a recording while local checkpoints load, or the live model.
  // Only the public recording points at running it locally; everyone else already is.
  renderBanner() {
    const local = health !== false && health !== null, text = this.mode === 'live' ? 'Live. The model on this machine is playing.'
      : this.mode === 'you' ? 'You are playing. Same physics, no model.'
      : local ? 'Recorded run. The model is loading and will take over shortly.'
      : 'Recorded run: real decisions, replayed.';
    if (this.bannerText === text) return;
    this.bannerText = text;
    this.el.banner.replaceChildren(text, ...(this.mode === 'replay' && !local ? [' ', h('a', { class: 'nw', href: './#run-it' }, 'Run it locally'), ' to watch it play\u00a0live.'] : []));
    this.el.banner.classList.toggle('live', this.mode === 'live');
  }

  renderFeed() {
    this.feedDirty = false;
    const { el, run } = this;
    el.source.textContent = this.mode === 'live' ? `live model · ${this.demo.checkpoint} checkpoint`
      : this.mode === 'you' ? 'you are playing · the model is idle'
      : run ? `recorded run · ${run.machine} · ${run.recorded}` : '—';
    if (!this.feed) { for (const k of ['state', 'question', 'action', 'timing']) el[k].textContent = '—'; return el.bars.replaceChildren(); }
    const { obs, answers, action } = this.feed, [qid, q] = Object.entries(obs.questions)[0], a = answers[qid];
    el.state.textContent = typeof obs.state === 'string' ? obs.state : JSON.stringify(obs.state);
    el.question.textContent = q.instructions;
    el.bars.replaceChildren(...Object.entries(a.probabilities).map(([k, p]) => bar(k, p, k === a.choice)));
    el.action.replaceChildren(h('b', {}, action.label), h('span', { class: 'why' }, action.why));
    el.timing.textContent = `${this.lat.model.toFixed(1)} ms per decision · ${this.stamps.length} decisions a second · ${this.count} so far`;
  }
}

// ------------------------------------------------------------------ input goes to the stage in view while YOU play
const typing = e => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
addEventListener('keydown', e => {
  const s = stages.find(s => s.active);
  if (!s || s.pilot !== 'you' || typing(e) || !['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) return;
  e.preventDefault();
  if (!keys.has(e.code)) pressed.add(e.code === 'ArrowUp' ? 'Space' : e.code).add(e.code);   // up doubles as space (flap); Tetris tells them apart
  keys.add(e.code);
});
addEventListener('keyup', e => keys.delete(e.code));

// ------------------------------------------------------------------ one loop for every stage; only the most visible one runs
let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (document.hidden) return;
  const top = stages.reduce((a, s) => (s.ratio > (a ? a.ratio : 0) ? s : a), null);
  for (const s of stages) s.frame(dt, s === top);
}

addEventListener('laya:health', e => { health = e.detail; });
addEventListener('resize', () => stages.forEach(s => {   // phones fire resize whenever the URL bar moves
  const w = s.el.canvas.clientWidth; if (w !== s.width) { s.width = w; s.stage.layout(); s.drawn = false; }
}));
for (const mount of document.querySelectorAll('.game-mount')) {
  const demo = demos.find(d => d.id === mount.dataset.demo);
  if (demo) stages.push(new GameStage(mount, demo));
}
requestAnimationFrame(loop);
