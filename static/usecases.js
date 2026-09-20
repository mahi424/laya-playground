// Use-case diagrams. Illustrations of a pattern, not data; nothing here calls the model.
//
// Built to read clearly through the dither: pure ink background, every coordinate snapped to a
// whole pixel (so edges never shimmer against the dither grid), one item on stage at a time, and
// beat-based motion: a fast ease-out hop between stations, then a rest.
import { Stage } from './dither.js';
import { h } from './ui.js';

const TONES = ['#0c0c0c', '#ffc609'], SOLID = 255, SOFT = 96;
const rnd = i => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const clamp = p => Math.max(0, Math.min(1, p)), out = p => 1 - (1 - clamp(p)) ** 3, mix = (a, b, p) => a + (b - a) * p;
const between = (t, a, b) => clamp((t - a) / (b - a));
const gray = v => `rgb(${v},${v},${v})`;

/** Drawing kit bound to one frame: w/h, a line unit `u`, and pixel-snapped primitives. */
function kit(c, w, hgt) {
  const u = Math.max(2, Math.round(w / 210)), s = Math.round(w * 0.05), r = Math.round;
  const fill = (x, y, ww, hh, v = SOLID) => { c.fillStyle = gray(v); c.fillRect(r(x), r(y), r(ww), r(hh)); };
  const frame = (x, y, ww, hh, v = SOLID) => { fill(x, y, ww, u, v); fill(x, y + hh - u, ww, u, v); fill(x, y, u, hh, v); fill(x + ww - u, y, u, hh, v); };
  return { w, h: hgt, u, s, fill, frame,
    line: (x0, y0, x1, y1, v = SOFT) => x0 === x1 ? fill(x0 - u / 2, Math.min(y0, y1), u, Math.abs(y1 - y0), v) : fill(Math.min(x0, x1), y0 - u / 2, Math.abs(x1 - x0), u, v),
    item: (x, y, hollow, size = s) => hollow ? frame(x - size / 2, y - size / 2, size, size) : fill(x - size / 2, y - size / 2, size, size),
    station: (x, y, ww, hh, on) => on ? fill(x - ww / 2, y - hh / 2, ww, hh) : frame(x - ww / 2, y - hh / 2, ww, hh) };
}

const VIZ = {
  // one ticket at a time: in, decided, sent to a queue
  route: { labels: [['ticket', 4, 28], ['billing', 81, 12], ['technical', 81, 34], ['sales', 81, 58], ['other', 81, 80]], draw(k, t) {
    const T = 1.5, n = Math.floor(t / T), q = t - n * T, lane = Math.floor(rnd(n) * 4), ys = [0.16, 0.38, 0.62, 0.84].map(y => y * k.h);
    const x0 = k.w * 0.1, x1 = k.w * 0.38, x2 = k.w * 0.68, y0 = k.h * 0.5;
    k.line(x0, y0, x1, y0); ys.forEach(y => { k.line(x1, y0, x1, y); k.line(x1, y, x2, y); });
    ys.forEach((y, i) => k.station(x2 + k.s, y, k.s * 2, k.s * 1.5, i === lane && q > 0.85));
    k.station(x1, y0, k.s * 1.6, k.s * 1.6, q > 0.28 && q < 0.5);
    if (q < 0.28) k.item(mix(x0, x1, out(q / 0.28)), y0);
    else if (q >= 0.5 && q < 0.68) k.item(x1, mix(y0, ys[lane], out((q - 0.5) / 0.18)));
    else if (q >= 0.68 && q <= 0.85) k.item(mix(x1, x2 + k.s, out((q - 0.68) / 0.17)), ys[lane]);
  } },

  // a gate in front of an agent: a hollow (hostile) prompt does not get through
  guard: { labels: [['prompt', 4, 28], ['gate', 45, 4], ['agent', 80, 28]], draw(k, t) {
    const T = 1.7, n = Math.floor(t / T), q = t - n * T, bad = rnd(n + 11) < 0.4, y = k.h * 0.5;
    const x0 = k.w * 0.1, xg = k.w * 0.5, x2 = k.w * 0.84, open = !bad && q > 0.45 && q < 1.0;
    k.line(x0, y, xg - k.s, y); k.line(xg + k.s, y, x2, y);
    k.fill(xg - k.u * 2, k.h * 0.16, k.u * 4, k.h * 0.22); k.fill(xg - k.u * 2, k.h * 0.62, k.u * 4, k.h * 0.22);
    if (!open) k.fill(xg - k.u * 2, k.h * 0.38, k.u * 4, k.h * 0.24, bad && q > 0.35 && q < 0.9 ? SOLID : SOFT);   // the door
    k.station(x2 + k.s, y, k.s * 2, k.s * 2, !bad && q > 0.85);
    if (q < 0.35) k.item(mix(x0, xg - k.s * 1.4, out(q / 0.35)), y, bad);
    else if (bad) { if (q < 0.9) k.item(mix(xg - k.s * 1.4, xg - k.s * 3.2, out((q - 0.45) / 0.2)), y, true); }
    else if (q < 0.45) k.item(xg - k.s * 1.4, y);
    else if (q <= 0.85) k.item(mix(xg - k.s * 1.4, x2 + k.s, out((q - 0.45) / 0.4)), y);
  } },

  // a distribution over ordered levels, and the expected level under it
  score: { labels: [['how urgent is this?', 4, 4], ['0', 16, 88], ['1', 32, 88], ['2', 48, 88], ['3', 64, 88], ['4', 80, 88]], draw(k, t) {
    const D = [[.62, .25, .08, .03, .02], [.05, .18, .5, .2, .07], [.02, .04, .1, .3, .54], [.1, .42, .34, .1, .04]];
    const T = 2, n = Math.floor(t / T), p = out(between(t - n * T, 0, 0.3)), a = D[n % 4], b = D[(n + 1) % 4];
    const v = a.map((x, i) => mix(x, b[i], p)), best = v.indexOf(Math.max(...v)), base = k.h * 0.8, bw = k.w * 0.1;
    let mean = 0;
    v.forEach((x, i) => { mean += x * i; const px = k.w * (0.12 + i * 0.16); k.fill(px, base - x * k.h * 0.6, bw, x * k.h * 0.6, i === best ? SOLID : SOFT); });
    k.fill(k.w * 0.1, base, k.w * 0.78, k.u);
    k.fill(k.w * (0.12 + mean * 0.16) + bw / 2 - k.u * 1.5, base + k.u * 3, k.u * 3, k.u * 3);   // expected level
  } },

  // a column-by-column sweep: the bad ones light up, then they are gone
  filter: { labels: [['inbox', 4, 4]], draw(k, t) {
    const cols = 12, rows = 5, T = 5, n = Math.floor(t / T), q = t - n * T, col = Math.floor(q / 0.15), cw = k.w * 0.9 / cols, ch = k.h * 0.74 / rows, gone = q > 3.2;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const bad = rnd(n * 131 + y * cols + x) < 0.22, seen = x <= col, cx = k.w * 0.05 + (x + 0.5) * cw, cy = k.h * 0.2 + (y + 0.5) * ch;
      if (bad && seen) { if (!gone) k.item(cx, cy, false, Math.min(cw, ch) * 0.78); }
      else k.item(cx, cy, true, Math.min(cw, ch) * 0.5);
    }
    if (col < cols) k.frame(k.w * 0.05 + col * cw, k.h * 0.16, cw, k.h * 0.82);
  } },

  // every step of an agent run is checked; the risky one stops the run and raises a flag
  watch: { labels: [['agent run', 4, 70], ['needs review', 36, 6]], draw(k, t) {
    const steps = 9, beat = 0.34, stop = 0.95, T = steps * beat + stop + 0.9, n = Math.floor(t / T), q = t - n * T, flag = 2 + Math.floor(rnd(n + 5) * 5);
    const head = q < flag * beat ? Math.floor(q / beat) : q < flag * beat + stop ? flag : Math.min(steps - 1, flag + Math.floor((q - flag * beat - stop) / beat));
    const y = k.h * 0.58, x = i => k.w * (0.08 + 0.84 * i / (steps - 1));
    k.line(x(0), y, x(steps - 1), y);
    for (let i = 0; i < steps; i++) {
      if (i === flag && i <= head) { const up = out((q - flag * beat) / 0.18) * k.h * 0.34; k.fill(x(i) - k.u / 2, y - up, k.u, up); k.fill(x(i), y - up, k.s * 2.2, k.s); k.item(x(i), y, false, k.s * 1.5); }
      else k.item(x(i), y, i > head, k.s * 0.9);
    }
  } },

  // sure answers are acted on at once; unsure ones take the slow road
  cascade: { labels: [['decision', 4, 28], ['sure: act', 70, 8], ['unsure: ask an LLM or a person', 34, 88]], draw(k, t) {
    const T = 1.6, n = Math.floor(t / T), q = t - n * T, unsure = rnd(n + 23) < 0.3, y = k.h * 0.5, y1 = k.h * (unsure ? 0.74 : 0.26);
    const x0 = k.w * 0.1, x1 = k.w * 0.4, x2 = k.w * 0.8;
    k.line(x0, y, x1, y); [0.26, 0.74].forEach(f => { k.line(x1, y, x1, k.h * f); k.line(x1, k.h * f, x2, k.h * f); });
    k.station(x1, y, k.s * 1.6, k.s * 1.6, q > 0.3 && q < 0.45);
    k.station(x2 + k.s, k.h * 0.26, k.s * 2, k.s * 1.5, !unsure && q > 0.8);
    k.frame(x2, k.h * 0.74 - k.s, k.s * 3, k.s * 2);
    if (unsure && q > 0.95) k.fill(x2, k.h * 0.74 - k.s, k.s * 3 * between(q, 0.95, T), k.s * 2, SOFT);   // the slow path, working
    if (q < 0.3) k.item(mix(x0, x1, out(q / 0.3)), y, unsure);
    else if (q >= 0.45 && q < 0.6) k.item(x1, mix(y, y1, out((q - 0.45) / 0.15)), unsure);
    else if (q >= 0.6 && q <= (unsure ? 0.95 : 0.8)) k.item(mix(x1, x2 + k.s, out((q - 0.6) / (unsure ? 0.35 : 0.2))), y1, unsure);
  } },
};

const items = [...document.querySelectorAll('.uc-viz[data-viz]')].map(box => {
  const viz = VIZ[box.dataset.viz], canvas = h('canvas', { class: 'pixelated', role: 'img', 'aria-label': box.dataset.label || '' });
  box.append(canvas, ...viz.labels.map(([text, x, y]) => h('span', { style: `left:${x}%;top:${y}%` }, text)));
  const it = { viz, box, stage: new Stage(canvas, { w: 420, h: 262, tones: TONES }), width: box.clientWidth, visible: false };
  new IntersectionObserver(es => { it.visible = es[0].isIntersecting; }).observe(box);
  return it;
});

const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
function paint(t, all) {
  for (const it of items) if (all || it.visible) {
    const { ctx, w, h: hh } = it.stage;
    ctx.fillStyle = gray(0); ctx.fillRect(0, 0, w, hh);
    it.viz.draw(kit(ctx, w, hh), t); it.stage.present();
  }
}
function loop(now) { requestAnimationFrame(loop); if (!document.hidden) paint(now / 1000); }
addEventListener('resize', () => {   // phones fire resize whenever the URL bar moves; only re-lay-out when the width really changed
  let changed = false;
  for (const it of items) if (it.box.clientWidth !== it.width) { it.width = it.box.clientWidth; it.stage.layout(); changed = true; }
  if (changed) paint(0.95, true);
});
paint(0.95, true);   // a first frame for every diagram, so none is blank before it scrolls into view
if (!still) requestAnimationFrame(loop);
