// Flappy: Laya is asked WHERE the bird is relative to the gap; the game flaps when
// P(below) clears a threshold. Asking what to DO comes out inverted, and numbers are not understood.
import { Scene3D, rng } from '../lib3d.js';
import { backdrop } from '../scenery.js';

const G = 22, FLAP = 6.8, COOLDOWN = 0.18, SPEED = 6.6, SPACING = 8.5, GAP = 3.5, PW = 1.4, PD = 2.4, CEIL = 10.6, R = 0.32;
const BANDS = [[-1.2, 'far below'], [-0.4, 'a little below'], [0.4, 'level with'], [1.2, 'a little above'], [Infinity, 'far above']];

class Flappy {
  constructor(seed) { this.rand = rng(seed); this.s3 = null; this.best = 0; this.crashes = 0; this.reset(); }

  reset() {
    this.y = 5.5; this.vy = 0; this.cool = 0; this.t = 0; this.score = 0; this.dead = 0; this.wing = 0;
    this.pillars = []; let c = 5.5;
    for (let i = 0; i < 7; i++) { c = this.nextGap(c); this.pillars.push({ x: 11 + i * SPACING, c, passed: false }); }
  }

  nextGap(prev) { return Math.max(3, Math.min(7.6, prev + (this.rand() * 2 - 1) * 2.6)); }
  target() { return this.pillars.find(p => p.x + PW / 2 > -0.4); }

  update(dt, input) {
    this.t += dt;
    if (this.dead) { this.dead -= dt; if (this.dead <= 0) this.reset(); return; }
    this.cool -= dt;
    if (input.flap) this.flap();
    this.vy -= G * dt; this.y += this.vy * dt; this.wing = Math.max(0, this.wing - dt * 5);
    if (this.y > CEIL) { this.y = CEIL; this.vy = Math.min(0, this.vy); }
    for (const p of this.pillars) {
      p.x -= SPEED * dt;
      if (!p.passed && p.x + PW / 2 < -R) { p.passed = true; this.score++; this.best = Math.max(this.best, this.score); }
      if (Math.abs(p.x) < PW / 2 + R && (this.y - R < p.c - GAP / 2 || this.y + R > p.c + GAP / 2)) this.crash();
    }
    if (this.y < R) this.crash();
    const last = this.pillars[this.pillars.length - 1];
    if (this.pillars[0].x < -14) { this.pillars.shift(); this.pillars.push({ x: last.x + SPACING, c: this.nextGap(last.c), passed: false }); }
  }

  flap() { if (this.cool <= 0 && !this.dead) { this.vy = FLAP; this.cool = COOLDOWN; this.wing = 1; return true; } return false; }
  crash() { if (!this.dead) { this.dead = 1.1; this.crashes++; } }

  observe() {
    const tgt = this.target(), d = this.y - (tgt ? tgt.c : 5.5);
    return {
      state: `The bird is ${BANDS.find(b => d < b[0])[1]} the gap.`,
      questions: { where: { type: 'choice', instructions: 'Where is the bird relative to the gap?',
        criteria: { below: 'lower than the gap', level: 'lined up with the gap', above: 'higher than the gap' } } },
    };
  }

  act(answers, params, apply) {
    const p = answers.where.probabilities.below, go = p > params.threshold;
    if (go && apply) this.flap();
    return { label: go ? 'FLAP' : 'GLIDE', why: `P(below) ${p.toFixed(2)} ${go ? '>' : '≤'} ${params.threshold.toFixed(2)}` };
  }

  draw(ctx, w, h) {
    const s3 = this.s3 && this.s3.w === w ? this.s3 : (this.s3 = new Scene3D(w, h)), horizon = h * 0.6;
    backdrop(ctx, w, h, { horizon, scroll: this.t * 0.08, sunX: 0.76, sunY: 0.46, sunR: 0.15, sky: [0, 58], ridges: [[0.3, 96, 0.25], [0.17, 20, 0.6]] });
    ctx.fillStyle = 'rgb(10,10,10)'; ctx.fillRect(0, horizon, w, h - horizon);
    s3.fog = { gray: 46, dist: 48 };
    s3.camera({ x: -0.6, y: 5.3, z: -11.4, yaw: 0.26, pitch: -0.02, fov: 52 });

    s3.poly([[-30, 0, -3.5], [60, 0, -3.5], [60, 0, 9], [-30, 0, 9]], 22, { layer: -2, fog: false });
    const off = (this.t * SPEED) % 2.5;
    for (let x = -22 - off; x < 56; x += 2.5) s3.poly([[x, 0.01, -3.5], [x + 0.12, 0.01, -3.5], [x + 0.12, 0.01, 9], [x, 0.01, 9]], 70, { layer: -1 });
    for (const z of [-3.5, -1.2, 1.2, 3.5, 6.2, 9]) s3.poly([[-30, 0.01, z], [60, 0.01, z], [60, 0.01, z + 0.1], [-30, 0.01, z + 0.1]], 70, { layer: -1 });

    for (const p of this.pillars) {
      const lo = p.c - GAP / 2, hi = p.c + GAP / 2;
      const o = { outline: 0 };
      s3.box(p.x, lo / 2, 0, PW, lo, PD, 300, o);
      s3.box(p.x, lo - 0.22, 0, PW + 0.4, 0.44, PD + 0.4, 420, o);
      s3.box(p.x, (hi + 11.5) / 2, 0, PW, 11.5 - hi, PD, 300, o);
      s3.box(p.x, hi + 0.22, 0, PW + 0.4, 0.44, PD + 0.4, 420, o);
    }

    const sh = Math.max(0.25, 1 - this.y / 12) * 0.55;  // ground shadow shrinks with height
    s3.poly([[-sh, 0.02, -sh], [sh, 0.02, -sh], [sh, 0.02, sh], [-sh, 0.02, sh]], 12, { layer: -0.5, fog: false });
    if (!(this.dead && Math.floor(this.dead * 12) % 2)) {  // blink while crashed
      const y = this.y, flapUp = Math.sin(this.wing * Math.PI) * 0.5, o = { outline: 0, fog: false };
      s3.box(0, y, 0, 1.05, 0.76, 0.8, 760, o);                     // body; far above 255 so every face stays solid amber
      s3.box(0.64, y - 0.06, 0, 0.34, 0.24, 0.34, 0, o);          // beak
      s3.box(-0.62, y + 0.12, 0, 0.26, 0.4, 0.44, 760, o);          // tail
      s3.box(-0.05, y + 0.1 + flapUp, -0.6, 0.62, 0.12, 0.46, 760, o);
      s3.box(-0.05, y + 0.1 + flapUp, 0.6, 0.62, 0.12, 0.46, 760, o);
    }
    s3.flush(ctx);
  }
}


export default {
  id: 'flappy', title: 'Flappy', checkpoint: 'english', keys: 'SPACE / CLICK TO FLAP',
  blurb: 'Each tick the bird’s height is put into words and Laya is asked where the bird is. The game flaps when P(below) clears the threshold.',
  params: [{ id: 'threshold', label: 'FLAP WHEN P(BELOW) >', min: 0.05, max: 0.95, step: 0.05, value: 0.5 }],
  touch: true,
  input: (keys, pressed) => ({ flap: pressed.has('Space') || pressed.has('pointer') }),
  create: seed => new Flappy(seed),
};
