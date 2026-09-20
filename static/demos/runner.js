// Lane runner: Laya is told which lanes the next row of barriers blocks and asked which lane is
// empty. The game stays put while P(current lane empty) is high enough, otherwise steps towards
// the most probable empty lane.
import { Scene3D, rng } from '../lib3d.js';
import { backdrop } from '../scenery.js';

const LANES = ['left', 'middle', 'right'], LX = [-1.35, 0, 1.35], LOOK = 24, FAR = 70;

class Runner {
  constructor(seed) { this.rand = rng(seed); this.s3 = null; this.best = 0; this.crashes = 0; this.reset(); }

  reset() {
    this.lane = 1; this.x = 0; this.t = 0; this.dist = 0; this.speed = 19; this.score = 0; this.dead = 0;
    this.rows = []; for (let z = 34; z < FAR; z += 17) this.rows.push(this.newRow(z));
  }

  newRow(z) {
    const blocked = [false, false, false], n = this.rand() < 0.45 ? 2 : 1;
    while (blocked.filter(Boolean).length < n) blocked[this.rand() * 3 | 0] = true;
    return { z, blocked };
  }
  nextRow() { return this.rows.find(r => r.z > 0.6 && r.z < LOOK); }

  update(dt, input) {
    this.t += dt;
    if (this.dead) { this.dead -= dt; if (this.dead <= 0) this.reset(); return; }
    if (input.left) this.steer(-1);
    if (input.right) this.steer(1);
    this.speed = Math.min(31, this.speed + dt * 0.3);
    this.dist += this.speed * dt;
    this.x += (LX[this.lane] - this.x) * Math.min(1, dt * 18);
    for (const r of this.rows) {
      const before = r.z; r.z -= this.speed * dt;
      if (before > 0 && r.z <= 0) {  // the row reaches the runner this step
        if (r.blocked.some((b, i) => b && Math.abs(this.x - LX[i]) < 0.72)) this.crash();
        else { this.score++; this.best = Math.max(this.best, this.score); }
      }
    }
    if (this.rows[0].z < -8) this.rows.shift();
    const last = this.rows[this.rows.length - 1], gap = Math.max(13, 18 - this.score * 0.12);
    if (last.z < FAR - gap) this.rows.push(this.newRow(last.z + gap));
  }

  steer(d) { if (!this.dead) this.lane = Math.max(0, Math.min(2, this.lane + d)); }
  crash() { if (!this.dead) { this.dead = 1.1; this.crashes++; } }

  observe() {
    const row = this.nextRow(), blocked = row ? row.blocked : [false, false, false];
    return {
      state: LANES.map((l, i) => `The ${l} lane is ${blocked[i] ? 'blocked by a barrier' : 'empty'}.`).join(' '),
      questions: { lane: { type: 'choice', instructions: 'Which lane is empty?', criteria: LANES } },
    };
  }

  act(answers, params, apply) {
    const p = answers.lane.probabilities, cur = LANES[this.lane], pc = p[cur];
    if (pc >= params.stay) return { label: 'STAY', why: `P(${cur} empty) ${pc.toFixed(2)} ≥ ${params.stay.toFixed(2)}` };
    const want = LANES.indexOf(answers.lane.choice), d = Math.sign(want - this.lane);
    if (apply) this.steer(d);
    return { label: d < 0 ? '← LEFT' : 'RIGHT →', why: `P(${cur} empty) ${pc.toFixed(2)} < ${params.stay.toFixed(2)}, best is ${answers.lane.choice}` };
  }

  draw(ctx, w, h) {
    const s3 = this.s3 && this.s3.w === w ? this.s3 : (this.s3 = new Scene3D(w, h));
    s3.fog = { gray: 50, dist: 84 };
    s3.camera({ x: this.x * 0.4, y: 2.5, z: -5, pitch: -0.17, fov: 62 });
    const horizon = s3.project([s3.cam.x, 0, 4000])[1];
    backdrop(ctx, w, h, { horizon, scroll: this.t * 0.02 + this.x * 0.01, sunX: 0.5, sunY: 0.62, sunR: 0.2, sky: [0, 62], ridges: [[0.34, 100, 0.25], [0.2, 20, 0.6]] });
    ctx.fillStyle = 'rgb(8,8,8)'; ctx.fillRect(0, horizon, w, h - horizon);

    s3.poly([[-2.1, 0, -6], [2.1, 0, -6], [2.1, 0, 160], [-2.1, 0, 160]], 30, { layer: -3, fog: false });
    for (const x of [-2.1, 2.02]) s3.poly([[x, 0.01, -6], [x + 0.08, 0.01, -6], [x + 0.08, 0.01, 160], [x, 0.01, 160]], 200, { layer: -2 });
    const off = this.dist % 4;
    for (let z = -4 - off; z < 120; z += 4) for (const x of [-0.72, 0.62])
      s3.poly([[x, 0.01, z], [x + 0.1, 0.01, z], [x + 0.1, 0.01, z + 1.8], [x, 0.01, z + 1.8]], 235, { layer: -2 });

    const poff = this.dist % 9;
    for (let z = 2 - poff; z < 110; z += 9) {
      const k = Math.round((z + this.dist) / 9), hgt = 0.7 + ((k * 7) % 5) * 0.38;
      s3.box(-3.7, hgt / 2, z, 0.45, hgt, 0.45, 210, { outline: 0 }); s3.box(3.7, hgt / 2, z, 0.45, hgt, 0.45, 210, { outline: 0 });
    }

    for (const r of this.rows) r.blocked.forEach((b, i) => {
      if (!b || r.z < -5) return;
      s3.box(LX[i], 0.55, r.z, 1.15, 1.1, 0.5, 440, { outline: 0, fog: false });
      s3.box(LX[i], 1.2, r.z, 1.25, 0.2, 0.6, 0, { outline: 0 });
    });

    s3.poly([[this.x - 0.34, 0.02, -0.3], [this.x + 0.34, 0.02, -0.3], [this.x + 0.34, 0.02, 0.34], [this.x - 0.34, 0.02, 0.34]], 8, { layer: -1, fog: false });
    if (!(this.dead && Math.floor(this.dead * 12) % 2)) {
      const stride = Math.sin(this.dist * 1.6), bob = Math.abs(stride) * 0.1;
      const o = { outline: 0, fog: false };
      s3.box(this.x - 0.14, 0.27, stride * 0.22, 0.19, 0.54, 0.21, 760, o);
      s3.box(this.x + 0.14, 0.27, -stride * 0.22, 0.19, 0.54, 0.21, 760, o);
      s3.box(this.x, 0.92 + bob, 0, 0.58, 0.76, 0.32, 760, o);
      s3.box(this.x - 0.38, 0.98 + bob, -stride * 0.2, 0.14, 0.56, 0.18, 760, o);   // arms swing against the legs
      s3.box(this.x + 0.38, 0.98 + bob, stride * 0.2, 0.14, 0.56, 0.18, 760, o);
      s3.box(this.x, 1.52 + bob, 0, 0.36, 0.36, 0.32, 760, o);
    }
    s3.flush(ctx);
  }
}

export default {
  id: 'runner', title: 'Lane Runner', checkpoint: 'english', keys: '← → TO STEER',
  blurb: 'The next row of barriers is described in a sentence and Laya is asked which lane is empty. It speeds up until the model’s latency loses.',
  params: [{ id: 'stay', label: 'STAY WHEN P(CURRENT LANE EMPTY) ≥', min: 0.05, max: 0.6, step: 0.05, value: 0.25 }],
  input: (keys, pressed) => ({ left: pressed.has('ArrowLeft'), right: pressed.has('ArrowRight') }),
  create: seed => new Runner(seed),
};
