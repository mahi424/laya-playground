// A very small software 3D layer for the live stages: perspective camera, near-plane clipping,
// lit boxes, distance fog, painter's-algorithm sorting. Everything is grayscale; color comes
// from the dither pass. World axes: x right, y up, z forward.

const NEAR = 0.15;
const LIGHT = norm([-0.45, 0.8, -0.4]);
function norm(v) { const l = Math.hypot(...v); return v.map(c => c / l); }

/** Seeded PRNG (mulberry32). Demos draw all randomness from one of these so a run can be replayed exactly. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// face index -> corner indices (counter-clockwise seen from outside) and outward normal
const FACES = [
  [[0, 1, 2, 3], [0, 0, -1]], [[5, 4, 7, 6], [0, 0, 1]],
  [[4, 0, 3, 7], [-1, 0, 0]], [[1, 5, 6, 2], [1, 0, 0]],
  [[3, 2, 6, 7], [0, 1, 0]],  [[4, 5, 1, 0], [0, -1, 0]],
];

export class Scene3D {
  constructor(w, h) { this.w = w; this.h = h; this.faces = []; this.fog = { gray: 0, dist: 0 }; }

  camera({ x = 0, y = 0, z = 0, yaw = 0, pitch = 0, fov = 60 }) {
    this.cam = { x, y, z, cy: Math.cos(yaw), sy: Math.sin(yaw), cp: Math.cos(pitch), sp: Math.sin(pitch) };
    this.f = (this.h / 2) / Math.tan(fov * Math.PI / 360);
    this.faces.length = 0;
  }

  toCam(p) {
    const c = this.cam, dx = p[0] - c.x, dy = p[1] - c.y, dz = p[2] - c.z;
    const x = c.cy * dx - c.sy * dz, z = c.sy * dx + c.cy * dz;
    return [x, c.cp * dy - c.sp * z, c.sp * dy + c.cp * z];
  }

  project(p) {  // world point -> [sx, sy, depth] or null when behind the camera
    const v = this.toCam(p);
    return v[2] < NEAR ? null : [this.w / 2 + this.f * v[0] / v[2], this.h / 2 - this.f * v[1] / v[2], v[2]];
  }

  /** Queue a polygon (world-space points). `layer` < 0 draws before everything else (ground);
   *  `outline` strokes the edge in that gray so a shape survives the dither. */
  poly(points, gray, { layer = 0, fog = true, outline = null } = {}) {
    let cam = points.map(p => this.toCam(p));
    if (cam.every(v => v[2] < NEAR)) return;
    if (cam.some(v => v[2] < NEAR)) cam = clipNear(cam);
    if (cam.length < 3) return;
    let depth = 0;
    const pts = cam.map(v => { depth += v[2]; return [this.w / 2 + this.f * v[0] / v[2], this.h / 2 - this.f * v[1] / v[2]]; });
    depth /= cam.length;
    if (fog && this.fog.dist) { const k = Math.min(1, depth / this.fog.dist); gray += (this.fog.gray - gray) * k * k; }
    this.faces.push({ pts, gray, outline, key: depth - layer * 1e6 });
  }

  /** Axis-aligned box centred at (cx, cy, cz). `base` is the lit gray level, 0-255. */
  box(cx, cy, cz, sx, sy, sz, base, opts) {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2, c = this.cam;
    const v = [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz], [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]]
      .map(o => [cx + o[0], cy + o[1], cz + o[2]]);
    for (const [idx, n] of FACES) {
      const fx = cx + n[0] * hx - c.x, fy = cy + n[1] * hy - c.y, fz = cz + n[2] * hz - c.z;
      if (fx * n[0] + fy * n[1] + fz * n[2] >= 0) continue;  // facing away
      const lit = 0.34 + 0.66 * Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
      this.poly(idx.map(i => v[i]), base * lit, opts);
    }
  }

  flush(ctx) {
    this.faces.sort((a, b) => b.key - a.key);
    for (const f of this.faces) {
      const g = Math.max(0, Math.min(255, f.gray)) | 0;
      ctx.fillStyle = `rgb(${g},${g},${g})`;
      ctx.beginPath();
      ctx.moveTo(f.pts[0][0], f.pts[0][1]);
      for (let i = 1; i < f.pts.length; i++) ctx.lineTo(f.pts[i][0], f.pts[i][1]);
      ctx.closePath(); ctx.fill();
      if (f.outline != null) { ctx.strokeStyle = `rgb(${f.outline},${f.outline},${f.outline})`; ctx.lineWidth = Math.max(1, this.w / 380); ctx.stroke(); }
    }
  }
}

function clipNear(poly) {  // Sutherland-Hodgman against z = NEAR, in camera space
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], ain = a[2] >= NEAR, bin = b[2] >= NEAR;
    if (ain) out.push(a);
    if (ain !== bin) { const t = (NEAR - a[2]) / (b[2] - a[2]); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]); }
  }
  return out;
}
