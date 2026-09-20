// Tetris: every place the falling piece could come to rest is put into one sentence (holes left
// under it, the bump it makes on top, lines completed) and Laya is asked how the stack would
// look. Spots are read out left to right, one per decision; the piece heads for the highest
// P(clean) so far and drops once every spot has been read. Gravity does not wait: a spot the
// model had no time to read is never considered, and a bad answer really is played.
import { Scene3D, rng } from '../lib3d.js';
import { backdrop } from '../scenery.js';

const W = 10, H = 20, ROWS = H + 4, G0 = 8, GMAX = 40, RAMP = 0.25, LOCK = 0.22, MOVE = 1 / 60;   // rows a second at the start, its cap, and what each cleared line adds
// box size and cells (y up) of I O T S Z J L; the other three turns are derived clockwise
const TURNS = [[4, [[0, 2], [1, 2], [2, 2], [3, 2]]], [2, [[0, 0], [1, 0], [0, 1], [1, 1]]], [3, [[0, 1], [1, 1], [2, 1], [1, 2]]],
  [3, [[0, 1], [1, 1], [1, 2], [2, 2]]], [3, [[1, 1], [2, 1], [0, 2], [1, 2]]], [3, [[0, 1], [1, 1], [2, 1], [0, 2]]], [3, [[0, 1], [1, 1], [2, 1], [2, 2]]]]
  .map(([n, c]) => { const t = [c]; for (let i = 0; i < 3; i++) t.push(t[i].map(([x, y]) => [y, n - 1 - x])); return t; });
const startY = cells => H - 1 - Math.min(...cells.map(c => c[1]));   // lowest cell on the top visible row
const heights = g => Array.from({ length: W }, (_, x) => { let y = g.length; while (y > 0 && !g[y - 1][x]) y--; return y; });
const rough = hs => hs.reduce((n, v, i) => i ? n + Math.abs(v - hs[i - 1]) : 0, 0);   // summed steps between neighbouring columns

// The model cannot count or compare, so the arithmetic happens here and it gets the conclusion in words.
const HOLES = ['no holes', 'one hole', 'two holes', 'three holes', 'many holes'], LINES = ['', 'one line', 'two lines', 'three lines', 'four lines'];
const BUMPS = ['no bump', 'a small bump', 'a big bump', 'a tall tower'], grade = (v, from, step) => Math.max(0, Math.min(3, Math.ceil((v - from) / step)));
const QUESTIONS = { look: { type: 'choice', instructions: 'How does the stack look after the piece lands?',
  criteria: { clean: 'flat with no holes', messy: 'holes or a tall tower' } } };

class Tetris {
  constructor(seed) { this.rand = rng(seed); this.s3 = null; this.best = 0; this.crashes = 0; this.serial = 0; this.asked = null; this.bag = []; this.reset(); }

  reset() {
    this.t = 0; this.score = 0; this.dead = 0; this.flash = [];
    this.grid = Array.from({ length: ROWS }, () => new Array(W).fill(0));
    this.next = this.deal(); this.spawn();
  }

  deal() {   // seven-bag: every piece once in shuffled order, then again
    if (!this.bag.length) { this.bag = [0, 1, 2, 3, 4, 5, 6]; for (let i = 6; i > 0; i--) { const j = this.rand() * (i + 1) | 0; [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]]; } }
    return this.bag.pop();
  }

  spawn() {
    const k = this.next; this.next = this.deal();
    this.p = { k, r: 0, x: (W - (k === 1 ? 2 : k ? 3 : 4)) >> 1, y: startY(TURNS[k][0]) };
    this.serial++; this.goal = null; this.done = false; this.fall = 0; this.rest = 0; this.steer = 0;
    this.spots = this.survey();
    if (this.hits(k, 0, this.p.x, this.p.y)) this.crash();
  }

  cells(k, r, x, y) { return TURNS[k][r].map(c => [x + c[0], y + c[1]]); }
  hits(k, r, x, y) { return this.cells(k, r, x, y).some(([ax, ay]) => ax < 0 || ax >= W || ay < 0 || (ay < ROWS && this.grid[ay][ax])); }
  move(dx, dy) { const p = this.p; if (this.hits(p.k, p.r, p.x + dx, p.y + dy)) return false; p.x += dx; p.y += dy; return true; }
  turn() {   // clockwise, nudged sideways off a wall or the stack when it has to be
    const p = this.p, r = (p.r + 1) % 4, dx = [0, -1, 1, -2, 2].find(d => !this.hits(p.k, r, p.x + d, p.y));
    if (dx == null) return false;
    p.r = r; p.x += dx; return true;
  }

  update(dt, input) {
    this.t += dt; this.flash = this.flash.filter(f => (f.t -= dt) > 0);
    if (this.dead) { this.dead -= dt; if (this.dead <= 0) this.reset(); return; }
    if (input.left) this.move(-1, 0);
    if (input.right) this.move(1, 0);
    if (input.turn) this.turn();
    if (input.drop) return this.drop();
    if (this.goal && (this.steer -= dt) <= 0) { this.steer = MOVE; if (this.pilot()) return; }
    const p = this.p;
    for (this.fall += Math.min(GMAX, G0 + this.score * RAMP) * dt; this.fall >= 1; this.fall--) if (!this.move(0, -1)) { this.fall = 0; break; }
    if (!this.hits(p.k, p.r, p.x, p.y - 1)) this.rest = 0;
    else if ((this.rest += dt) >= LOCK) this.lock();
  }

  drop() { while (this.move(0, -1)); this.lock(); }
  pilot() {   // one key press towards the chosen spot, like anyone's; once there with every spot read, drops and returns true
    const p = this.p, g = this.goal;
    if (p.r === g.r && p.x === g.x) return this.done && (this.drop(), true);
    if (p.r === g.r || !this.turn()) this.move(Math.sign(g.x - p.x), 0);
  }

  lock() {
    const p = this.p;
    for (const [x, y] of this.cells(p.k, p.r, p.x, p.y)) this.grid[y][x] = 1;
    for (let y = ROWS - 1; y >= 0; y--) if (this.grid[y].every(Boolean)) {
      this.grid.splice(y, 1); this.grid.push(new Array(W).fill(0)); this.flash.push({ y, t: 0.16 });
      this.score++; this.best = Math.max(this.best, this.score);
    }
    if (this.grid[H].some(Boolean)) this.crash(); else this.spawn();   // anything left above the rim ends the game
  }

  crash() { if (!this.dead) { this.dead = 1.1; this.crashes++; this.goal = null; } }

  survey() {   // every distinct resting place reachable by turning, sliding and falling straight down, left to right
    const k = this.p.k, hs = heights(this.grid), before = rough(hs), sum = hs.reduce((a, b) => a + b), seen = new Set(), out = [];
    for (let r = 0; r < 4; r++) for (let x = -2; x < W; x++) {
      let y = startY(TURNS[k][r]);
      if (this.hits(k, r, x, y)) continue;
      while (!this.hits(k, r, x, y - 1)) y--;
      const cells = this.cells(k, r, x, y), key = cells.map(c => c[1] * W + c[0]).sort((a, b) => a - b).join();
      if (seen.has(key)) continue;   // S, Z, I and O look the same after some turns
      seen.add(key);
      const low = {}; for (const [ax, ay] of cells) low[ax] = Math.min(low[ax] ?? ROWS, ay);
      const holes = Object.keys(low).reduce((n, ax) => n + low[ax] - hs[ax], 0);   // empty cells the piece would roof over
      const g = this.grid.map(row => row.slice()); for (const [ax, ay] of cells) g[ay][ax] = 1;
      const kept = g.filter(row => !row.every(Boolean)), lines = ROWS - kept.length, top = Math.max(...cells.map(c => c[1])) + 1;
      // a bump is the top of the stack getting rougher, or the piece ending up well above the average column, whichever is worse
      const bump = Math.max(grade(rough(heights(kept)) - before, 0, 2), grade(top * W - sum, 3 * W, W));
      const text = `The piece leaves ${HOLES[Math.min(4, holes)]} under it and makes ${BUMPS[bump]} on top.` + (lines ? ` It completes ${LINES[lines]}.` : '');
      out.push({ r, x, cells, left: Math.min(...cells.map(c => c[0])), text, p: null });
    }
    return out.sort((a, b) => a.left - b.left || a.r - b.r);
  }

  observe() {   // the next spot not yet read; once all are read, the chosen one again until the piece lands
    const c = this.spots.find(c => c.p == null) || this.goal || this.spots[0] || { text: 'The well is full.', p: 0 };
    this.asked = { serial: this.serial, c, again: c.p != null };
    return { state: c.text, questions: QUESTIONS };
  }

  act(answers, params, apply) {
    const a = this.asked, p = answers.look.probabilities.clean, best = this.goal;
    if (a && a.again) return { label: 'DROP', why: 'every spot read, the piece is on its way down' };
    if (!a || a.serial !== this.serial || this.dead) return { label: 'TOO LATE', why: 'the piece landed before this answer arrived' };
    const better = !best || p > best.p, last = this.spots.every(c => c.p != null || c.text === a.c.text);
    if (apply) {
      for (const c of this.spots) if (c.text === a.c.text) c.p = p;   // the same sentence always gets the same answer, so it is asked once
      if (better) this.goal = a.c;
      if (last) { this.done = true; this.pilot(); }   // already in place: drop now rather than ask about a piece that is gone
    }
    return { label: last ? 'DROP' : better ? 'AIM HERE' : 'SKIP', why: (best ? `P(clean) ${p.toFixed(2)} ${better ? '>' : '≤'} ${best.p.toFixed(2)}, the best spot so far` : `P(clean) ${p.toFixed(2)}, the first spot read`) + (last ? ', the last one' : '') };
  }

  draw(ctx, w, h) {
    const s3 = this.s3 && this.s3.w === w ? this.s3 : (this.s3 = new Scene3D(w, h)), pitch = 0.05, o = { outline: 0 }, lit = { outline: 0, fog: false };
    s3.fog = { gray: 46, dist: 120 };
    s3.camera({ x: 7.5, y: 8.6, z: -27, yaw: -0.15, pitch, fov: 50 });
    const horizon = h / 2 + s3.f * Math.tan(pitch);
    backdrop(ctx, w, h, { horizon, scroll: this.t * 0.012, sunX: 0.8, sunY: 0.5, sunR: 0.17, sky: [0, 58], ridges: [[0.3, 96, 0.25], [0.17, 20, 0.6]] });
    ctx.fillStyle = 'rgb(10,10,10)'; ctx.fillRect(0, horizon, w, h - horizon);

    s3.poly([[-60, 0, -8], [80, 0, -8], [80, 0, 40], [-60, 0, 40]], 22, { layer: -3, fog: false });
    for (let x = -57.5; x < 80; x += 5) s3.poly([[x, 0.01, -8], [x + 0.14, 0.01, -8], [x + 0.14, 0.01, 40], [x, 0.01, 40]], 70, { layer: -2 });
    for (const z of [-8, -4, 0.8, 6, 12, 20, 30, 40]) s3.poly([[-60, 0.01, z], [80, 0.01, z], [80, 0.01, z + 0.12], [-60, 0.01, z + 0.12]], 70, { layer: -2 });

    // the well: a dark back wall so the blocks read against the sky, two posts and a plinth
    s3.poly([[-5, 0, 0.5], [5, 0, 0.5], [5, H, 0.5], [-5, H, 0.5]], 0, { layer: -1, fog: false });
    for (let x = -4; x < 5; x++) s3.poly([[x - 0.03, 0, 0.49], [x + 0.03, 0, 0.49], [x + 0.03, H, 0.49], [x - 0.03, H, 0.49]], 44, { layer: -0.9, fog: false });
    for (const x of [-5.4, 5.4]) { s3.box(x, H / 2, 0, 0.8, H, 1.6, 300, o); s3.box(x, H + 0.22, 0, 1.2, 0.44, 2, 420, o); }
    s3.box(0, -0.3, 0, 11.6, 0.6, 2, 420, { outline: 0, layer: -0.5 });   // under everything that stands on it

    const cube = (x, y, base, opts) => s3.box(x - 4.5, y + 0.5, 0, 0.94, 0.94, 0.94, base, opts);
    if (!(this.dead && Math.floor(this.dead * 12) % 2))   // blink while crashed
      for (let y = 0; y < ROWS; y++) for (let x = 0; x < W; x++) if (this.grid[y][x]) cube(x, y, 330, o);
    for (const f of this.flash) s3.box(0, f.y + 0.5, 0, 10, 0.9, 1.3, 760, lit);
    if (!this.dead) {
      const p = this.p; let gy = p.y; while (!this.hits(p.k, p.r, p.x, gy - 1)) gy--;
      for (const [x, y] of this.goal ? this.goal.cells : this.cells(p.k, p.r, p.x, gy)) cube(x, y, 100, { fog: false });   // a faint ghost where it is heading
      for (const [x, y] of this.cells(p.k, p.r, p.x, p.y)) cube(x, y, 760, lit);
    }
    s3.box(-10.5, 1.2, 0, 3.4, 2.4, 2, 300, o); s3.box(-10.5, 2.6, 0, 3.9, 0.44, 2.4, 420, o);   // the next piece waits on a plinth
    const n = TURNS[this.next][0], cx = n.reduce((s, c) => s + c[0], 0) / 4, cy = Math.min(...n.map(c => c[1]));
    for (const [x, y] of n) s3.box(-10.5 + (x - cx) * 0.8, 3.22 + (y - cy) * 0.8, 0, 0.75, 0.75, 0.75, 330, o);
    s3.flush(ctx);
  }
}

let repeatAt = 0;
export default {
  id: 'tetris', title: 'Tetris', checkpoint: 'english', keys: '← → MOVE · ↑ TURN · SPACE DROP',
  blurb: 'Every spot the piece could land in is described in a sentence and Laya is asked how the stack would look. The piece goes where P(clean) was highest, and gravity does not wait for the answer.',
  params: [],
  input(keys, pressed) {   // a held arrow repeats after 170 ms, then every 45 ms; up arrives as Space too, so tell them apart
    const d = keys.has('ArrowRight') - keys.has('ArrowLeft'), now = performance.now(), rep = d && repeatAt && now >= repeatAt;
    repeatAt = !d ? 0 : rep ? now + 45 : repeatAt || now + 170;
    return { left: pressed.has('ArrowLeft') || (rep && d < 0), right: pressed.has('ArrowRight') || (rep && d > 0), turn: pressed.has('ArrowUp'),
      drop: pressed.has('ArrowDown') || (pressed.has('Space') && !pressed.has('ArrowUp')) };
  },
  create: seed => new Tetris(seed),
};
