// Shared 2D backdrop for the stages: sky gradient, sun, two parallax ridgelines. Grayscale only.

const gray = g => `rgb(${g | 0},${g | 0},${g | 0})`;
const tri = x => 1 - Math.abs(((x % 2) + 2) % 2 - 1);
const ridge = x => 0.55 * tri(x * 0.9 + 0.3) + 0.3 * tri(x * 2.3 + 1.7) + 0.15 * tri(x * 5.1 + 0.4);

export function backdrop(ctx, w, h, { horizon, scroll = 0, sunX = 0.7, sunY = 0.55, sunR = 0.2, sky = [10, 135], ridges = [[0.34, 100, 0.25], [0.2, 52, 0.6]] }) {
  const sk = ctx.createLinearGradient(0, 0, 0, horizon);
  sk.addColorStop(0, gray(sky[0])); sk.addColorStop(1, gray(sky[1]));
  ctx.fillStyle = sk; ctx.fillRect(0, 0, w, horizon + 1);

  const sx = w * sunX, sy = horizon * sunY, r = h * sunR;
  const glow = ctx.createRadialGradient(sx, sy, r * 0.9, sx, sy, r * 2.6);
  glow.addColorStop(0, 'rgba(255,255,255,0.42)'); glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, w, horizon);
  ctx.fillStyle = gray(255); ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();

  for (const [height, g, speed] of ridges) {  // far to near
    ctx.fillStyle = gray(g); ctx.beginPath(); ctx.moveTo(0, horizon + 1);
    for (let x = 0; x <= w; x += 2) ctx.lineTo(x, horizon - ridge((x / w) * 3 + scroll * speed) * horizon * height);
    ctx.lineTo(w, horizon + 1); ctx.closePath(); ctx.fill();
  }
}
