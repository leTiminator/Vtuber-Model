/**
 * First guess at where the head, neck and eyes are in a piece of artwork, so
 * loading an image lands you somewhere close instead of on four unplaced
 * markers. Everything it finds is still draggable afterwards.
 *
 * The neck is found by scanning how wide the opaque silhouette is on each row:
 * a character narrows at the neck and widens again at the shoulders, so the
 * first pronounced pinch below the top of the head is the pivot. Eyes are
 * found by looking for the brightest clusters inside the head, which works on
 * anything from white anime highlights to a glowing visor.
 */
import { clamp } from '../../core/math.js';

const ANALYSIS_WIDTH = 420; // downscale first; precision beyond this is noise
const ALPHA_FLOOR = 40;

export function autoMarkup(image) {
  const scale = Math.min(1, ANALYSIS_WIDTH / image.naturalWidth);
  const w = Math.max(8, Math.round(image.naturalWidth * scale));
  const h = Math.max(8, Math.round(image.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, w, h);

  let data;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null; // tainted canvas; fall back to the stored defaults
  }

  const alphaAt = (x, y) => data[(y * w + x) * 4 + 3];
  const lumAt = (x, y) => {
    const i = (y * w + x) * 4;
    return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  };

  // --- silhouette ------------------------------------------------------
  const widths = new Float32Array(h);
  const rowMin = new Int32Array(h).fill(-1);
  const rowMax = new Int32Array(h).fill(-1);
  let top = -1;
  let bottom = -1;

  for (let y = 0; y < h; y++) {
    let count = 0;
    for (let x = 0; x < w; x++) {
      if (alphaAt(x, y) > ALPHA_FLOOR) {
        count++;
        if (rowMin[y] < 0) rowMin[y] = x;
        rowMax[y] = x;
      }
    }
    widths[y] = count;
    if (count > w * 0.01) {
      if (top < 0) top = y;
      bottom = y;
    }
  }

  // A fully transparent or near-empty image tells us nothing.
  if (top < 0 || bottom - top < 8) return null;

  const smooth = smoothed(widths, Math.max(2, Math.round(h * 0.02)));

  // --- neck: the first pronounced pinch below the top of the head -------
  const searchFrom = top + Math.round((bottom - top) * 0.16);
  const searchTo = top + Math.round((bottom - top) * 0.62);
  let neckY = -1;
  let bestScore = 0;

  for (let y = searchFrom; y <= searchTo; y++) {
    let above = 0;
    for (let k = top; k < y; k++) above = Math.max(above, smooth[k]);
    let below = 0;
    for (let k = y; k <= Math.min(bottom, y + Math.round((bottom - top) * 0.22)); k++) {
      below = Math.max(below, smooth[k]);
    }
    if (!above || !below) continue;
    // A real neck is narrow relative to both the head above and body below.
    const score = (above - smooth[y]) / above + (below - smooth[y]) / below;
    if (score > bestScore) {
      bestScore = score;
      neckY = y;
    }
  }
  if (neckY < 0 || bestScore < 0.18) neckY = top + Math.round((bottom - top) * 0.42);

  // --- head: the mass above the neck ------------------------------------
  let sumX = 0;
  let sumY = 0;
  let mass = 0;
  let headLeft = w;
  let headRight = 0;
  for (let y = top; y <= neckY; y++) {
    for (let x = 0; x < w; x++) {
      if (alphaAt(x, y) <= ALPHA_FLOOR) continue;
      sumX += x;
      sumY += y;
      mass++;
      if (x < headLeft) headLeft = x;
      if (x > headRight) headRight = x;
    }
  }
  if (!mass) return null;

  const headCX = sumX / mass;
  const headCY = sumY / mass;
  const headRadiusPx = Math.max((headRight - headLeft) / 2, (neckY - top) / 2) * 1.04;

  // The pivot sits at the neck, on the head's centreline.
  const pivotX = rowMin[neckY] >= 0 ? (rowMin[neckY] + rowMax[neckY]) / 2 : headCX;

  // --- eyes: brightest clusters in the middle band of the head ----------
  const bandTop = Math.round(top + (neckY - top) * 0.2);
  const bandBottom = Math.round(top + (neckY - top) * 0.78);
  const samples = [];
  for (let y = bandTop; y <= bandBottom; y++) {
    for (let x = headLeft; x <= headRight; x++) {
      if (alphaAt(x, y) > ALPHA_FLOOR) samples.push(lumAt(x, y));
    }
  }

  let eyes = null;
  if (samples.length > 40) {
    samples.sort((a, b) => a - b);
    const median = samples[samples.length >> 1];
    const brightest = samples[Math.floor(samples.length * 0.995)];
    // Only trust this if there is real contrast to latch onto.
    if (brightest - median > 45) {
      const threshold = Math.max(median + (brightest - median) * 0.55, median + 35);
      const left = new Box();
      const right = new Box();
      for (let y = bandTop; y <= bandBottom; y++) {
        for (let x = headLeft; x <= headRight; x++) {
          if (alphaAt(x, y) <= ALPHA_FLOOR || lumAt(x, y) < threshold) continue;
          (x < headCX ? left : right).add(x, y);
        }
      }
      const min = Math.max(8, headRadiusPx * headRadiusPx * 0.004);
      if (left.count > min && right.count > min) {
        eyes = { left: left.pad(0.28, w, h), right: right.pad(0.28, w, h), detected: true };
      }
    }
  }

  if (!eyes) {
    // Nothing obvious to latch onto — place plausible boxes and let the user
    // drag them. Better a sane starting point than two unplaced squares.
    const ex = headRadiusPx * 0.52;
    const ey = headCY - headRadiusPx * 0.1;
    const ew = headRadiusPx * 0.42;
    const eh = headRadiusPx * 0.3;
    eyes = {
      left: [headCX - ex - ew / 2, ey - eh / 2, headCX - ex + ew / 2, ey + eh / 2],
      right: [headCX + ex - ew / 2, ey - eh / 2, headCX + ex + ew / 2, ey + eh / 2],
      detected: false,
    };
  }

  const u = (v) => clamp(v / w, 0, 1);
  const v = (y) => clamp(y / h, 0, 1);
  const rect = (r) => [u(r[0]), v(r[1]), u(r[2]), v(r[3])].map((n) => Math.round(n * 1e4) / 1e4);

  // The mesh measures head distance as hypot((du * aspect), dv) / headR with
  // aspect = width/height, so a radius of R pixels is R/height in those units
  // along both axes.
  return {
    headX: round(u(headCX)),
    headY: round(v(headCY)),
    headR: round(clamp(headRadiusPx / h, 0.03, 0.9)),
    pivotX: round(u(pivotX)),
    pivotY: round(v(neckY)),
    eyeL: rect(eyes.left),
    eyeR: rect(eyes.right),
    confidentEyes: eyes.detected,
  };
}

class Box {
  constructor() {
    this.x0 = Infinity;
    this.y0 = Infinity;
    this.x1 = -Infinity;
    this.y1 = -Infinity;
    this.count = 0;
  }
  add(x, y) {
    if (x < this.x0) this.x0 = x;
    if (y < this.y0) this.y0 = y;
    if (x > this.x1) this.x1 = x;
    if (y > this.y1) this.y1 = y;
    this.count++;
  }
  /** Grow by a fraction of the box's own size — the lid needs margin. */
  pad(fraction, w, h) {
    const px = Math.max(2, (this.x1 - this.x0) * fraction);
    const py = Math.max(2, (this.y1 - this.y0) * fraction);
    return [
      clamp(this.x0 - px, 0, w), clamp(this.y0 - py, 0, h),
      clamp(this.x1 + px, 0, w), clamp(this.y1 + py, 0, h),
    ];
  }
}

function smoothed(values, radius) {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, i - radius); k <= Math.min(values.length - 1, i + radius); k++) {
      sum += values[k];
      n++;
    }
    out[i] = sum / n;
  }
  return out;
}

const round = (n) => Math.round(n * 1e4) / 1e4;
