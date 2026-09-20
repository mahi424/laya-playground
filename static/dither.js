// Post-processing for every canvas on the page: a scene is drawn in grayscale at low resolution,
// then presented as an ordered (Bayer 8x8) dither between two or more tones.

const BAYER8 = [
   0, 32,  8, 40,  2, 34, 10, 42,   48, 16, 56, 24, 50, 18, 58, 26,
  12, 44,  4, 36, 14, 46,  6, 38,   60, 28, 52, 20, 62, 30, 54, 22,
   3, 35, 11, 43,  1, 33,  9, 41,   51, 19, 59, 27, 49, 17, 57, 25,
  15, 47,  7, 39, 13, 45,  5, 37,   63, 31, 55, 23, 61, 29, 53, 21,
].map(v => (v + 0.5) / 64);

function abgr(hex) {  // ImageData is little-endian RGBA, so a Uint32 view wants 0xAABBGGRR
  const n = parseInt(hex.slice(1), 16);
  return (0xff << 24 | (n & 0xff) << 16 | (n >> 8 & 0xff) << 8 | n >> 16) >>> 0;
}

export class Stage {
  /**
   * @param canvas      the visible canvas (give it a CSS width and an aspect-ratio)
   * @param opts.w,h    target scene resolution; the real one is chosen near it by layout()
   * @param opts.tones  dark -> light colors, e.g. [ink, amber]
   * Draw the scene in grayscale into `stage.ctx` at `stage.w` x `stage.h`, then call present().
   */
  constructor(canvas, { w = 768, h = 432, tones }) {
    this.canvas = canvas;
    this.out = canvas.getContext('2d');
    this.target = w; this.aspect = h / w;
    this.scene = document.createElement('canvas');
    this.ctx = this.scene.getContext('2d', { willReadFrequently: true });
    this.pal = tones.map(abgr);
    this.layout();
  }

  // Pick a scene width near the target that divides the canvas's device-pixel width exactly,
  // so every dither pixel is the same whole number of device pixels (no moire from uneven scaling).
  layout() {
    const dev = (this.canvas.clientWidth || this.target) * (window.devicePixelRatio || 1);
    const k = Math.max(1, Math.round(dev / this.target));
    this.w = Math.max(120, Math.round(dev / k)); this.h = Math.round(this.w * this.aspect);
    this.scene.width = this.canvas.width = this.w; this.scene.height = this.canvas.height = this.h;
    this.img = this.out.createImageData(this.w, this.h);
    this.px = new Uint32Array(this.img.data.buffer);
  }

  present() {
    const { w, h, px, pal } = this, src = this.ctx.getImageData(0, 0, w, h).data, top = pal.length - 1;
    for (let y = 0, i = 0; y < h; y++) {
      const row = (y & 7) << 3;
      for (let x = 0; x < w; x++, i++) {
        const t = src[i << 2] / 255 * top, base = t | 0;
        px[i] = pal[base + (t - base > BAYER8[row | (x & 7)] ? 1 : 0)];
      }
    }
    this.out.putImageData(this.img, 0, 0);
  }
}
