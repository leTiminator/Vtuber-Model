/** Puts back what a background key took out of a drawing. */
import { clamp } from '/src/core/math.js';
import { fitBasis, robustRing } from './cut.js';

const CLEAR = 8;  // alpha at or below this has no colour worth keeping
const SOLID = 250; // alpha at or above this is untouched paint

/** How big a hole may be and still be taken for damage. */
const MAX_HOLE = 4000;

/**
 * @param {CanvasImageSource & {naturalWidth?: number, width?: number}} image
 * @returns {{canvas: HTMLCanvasElement, width: number, height: number,
 *            filled: number, holes: number, left: number}}
 */
export function repairKeyedHoles(image, maxHole = MAX_HOLE) {
  const w = image.naturalWidth ?? image.width;
  const h = image.naturalHeight ?? image.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);

  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const n = w * h;

  /* What the outside can reach, flooding through anything not fully opaque. */
  const outer = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const seed = (i) => {
    if (outer[i] || d[i * 4 + 3] >= SOLID) return;
    outer[i] = 1;
    queue[tail++] = i;
  };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (y > 0) seed(i - w);
    if (y < h - 1) seed(i + w);
  }

  const seen = new Uint8Array(n);
  const hole = [];
  let filled = 0;
  let holes = 0;
  let left = 0;

  const damaged = (i) => d[i * 4 + 3] < SOLID && !outer[i];
  for (let start = 0; start < n; start++) {
    if (seen[start] || !damaged(start)) continue;

    // One patch of damage, and the solid paint ringing it.
    hole.length = 0;
    const ring = [];
    seen[start] = 1;
    head = tail = 0;
    queue[tail++] = start;
    while (head < tail) {
      const i = queue[head++];
      hole.push(i);
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (!damaged(j)) { if (!outer[j]) ring.push(j); continue; }
          if (seen[j]) continue;
          seen[j] = 1;
          queue[tail++] = j;
        }
      }
    }
    if (hole.length > maxHole) { left += hole.length; continue; }
    if (hole.length < 4 || ring.length < 12) continue;

    /* The ring is not one surface. A keyed-out shard is bounded by its own
     * white fringe on most of its edge and by the ink outline on the rest, and
     * an average of the two is a dirty grey that reads as a smudge rather than
     * an eye. The same robust fit the shut-eye socket uses throws the minority
     * out: it fits, measures how far each sample falls from that fit, and
     * refits on what agrees.
     */
    const inliers = robustRing(ring, d, w);
    let cx = 0;
    let cy = 0;
    for (const i of inliers) { const x = i % w; cx += x; cy += (i - x) / w; }
    cx /= inliers.length;
    cy /= inliers.length;
    // Quadratic, so a shard sitting across a highlight is filled with the
    // highlight rolling through it rather than flattened to one tone.
    const basis = (x, y) => {
      const u = (x - cx) / 32;
      const v = (y - cy) / 32;
      return [1, u, v, u * u, u * v, v * v];
    };
    /* Colour taken from the fit where there is none left, and kept where there
     * still is some. A pixel the key thinned rather than removed still holds
     * the artist's own colour — the alpha channel is what was written, not the
     * three beside it — so it is trusted in proportion to how much of it
     * survived, and the fit only makes up the difference.
     */
    for (let ch = 0; ch < 3; ch++) {
      const coef = fitBasis(inliers, w, basis, (i) => d[i * 4 + ch]);
      for (const i of hole) {
        const x = i % w;
        const y = (i - x) / w;
        const b = basis(x, y);
        let v = 0;
        for (let k = 0; k < b.length; k++) v += coef[k] * b[k];
        const own = d[i * 4 + 3] / 255;
        d[i * 4 + ch] = clamp(v * (1 - own) + d[i * 4 + ch] * own, 0, 255);
      }
    }
    for (const i of hole) d[i * 4 + 3] = 255;
    filled += hole.length;
    holes++;
  }

  ctx.putImageData(img, 0, 0);
  return { canvas, width: w, height: h, filled, holes, left };
}
