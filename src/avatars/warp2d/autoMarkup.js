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
  // Longest contiguous run per row, not total opaque count: a head is one
  // wide run, whereas flowing cloth is several thin ones. Counting totals
  // lets a big scarf out-measure the body it is attached to.
  const runs = new Float32Array(h);
  const rowMin = new Int32Array(h).fill(-1);
  const rowMax = new Int32Array(h).fill(-1);
  let top = -1;
  let bottom = -1;

  for (let y = 0; y < h; y++) {
    let best = 0;
    let run = 0;
    for (let x = 0; x < w; x++) {
      if (alphaAt(x, y) > ALPHA_FLOOR) {
        run++;
        if (run > best) best = run;
        if (rowMin[y] < 0) rowMin[y] = x;
        rowMax[y] = x;
      } else {
        run = 0;
      }
    }
    runs[y] = best;
    if (best > w * 0.02) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  if (top < 0 || bottom - top < 8) return null;

  // --- eyes first ------------------------------------------------------
  // The eyes are the most reliable landmark in this kind of artwork: two
  // small, bright, roughly level blobs. Finding them first means the head can
  // be placed from them, which survives compositions where the character is
  // off-centre or wrapped in something larger than they are.
  const eyePair = findEyes(data, w, h, alphaAt, lumAt);

  let headCX;
  let headCY;
  let headRadiusPx;
  let neckY;
  let eyes;

  if (eyePair) {
    const [a, b] = eyePair;
    const sep = Math.abs(a.cx - b.cx);
    headCX = (a.cx + b.cx) / 2;
    headCY = (a.cy + b.cy) / 2 - sep * 0.16; // eyes sit below the head centre
    headRadiusPx = clamp(sep * 1.6, 6, Math.max(w, h));
    neckY = clamp(headCY + headRadiusPx * 1.15, top + 4, bottom);
    eyes = {
      left: padBox(a, 0.3, w, h),
      right: padBox(b, 0.3, w, h),
      detected: true,
    };
  } else {
    // Fall back to the silhouette: the sharpest pinch below the top of the
    // head, where a figure narrows at the neck and widens at the shoulders.
    const smooth = smoothed(runs, Math.max(2, Math.round(h * 0.02)));
    const searchFrom = top + Math.round((bottom - top) * 0.16);
    const searchTo = top + Math.round((bottom - top) * 0.62);
    let bestScore = 0;
    neckY = -1;

    for (let y = searchFrom; y <= searchTo; y++) {
      let above = 0;
      for (let k = top; k < y; k++) above = Math.max(above, smooth[k]);
      let below = 0;
      for (let k = y; k <= Math.min(bottom, y + Math.round((bottom - top) * 0.22)); k++) {
        below = Math.max(below, smooth[k]);
      }
      if (!above || !below) continue;
      const score = (above - smooth[y]) / above + (below - smooth[y]) / below;
      if (score > bestScore) {
        bestScore = score;
        neckY = y;
      }
    }
    if (neckY < 0 || bestScore < 0.18) neckY = top + Math.round((bottom - top) * 0.42);

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

    headCX = sumX / mass;
    headCY = sumY / mass;
    headRadiusPx = Math.max((headRight - headLeft) / 2, (neckY - top) / 2) * 1.04;

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

  const pivotX = rowMin[Math.round(neckY)] >= 0
    ? (rowMin[Math.round(neckY)] + rowMax[Math.round(neckY)]) / 2
    : headCX;

  const u = (v) => clamp(v / w, 0, 1);
  const v = (y) => clamp(y / h, 0, 1);
  const rect = (r) => [u(r[0]), v(r[1]), u(r[2]), v(r[3])].map(round);

  // The mesh measures head distance as hypot(du * aspect, dv) / headR with
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

/**
 * Two small bright blobs, roughly level and of similar size. Returns them
 * left-first, or null when nothing convincing stands out.
 */
function findEyes(data, w, h, alphaAt, lumAt) {
  const lums = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alphaAt(x, y) > ALPHA_FLOOR) lums.push(lumAt(x, y));
    }
  }
  if (lums.length < 200) return null;

  lums.sort((a, b) => a - b);
  const median = lums[lums.length >> 1];
  const peak = lums[Math.floor(lums.length * 0.998)];
  if (peak - median < 50) return null; // nothing bright enough to trust

  const threshold = Math.max(median + (peak - median) * 0.6, median + 40);
  const blobs = labelBlobs(w, h, (x, y) => alphaAt(x, y) > ALPHA_FLOOR && lumAt(x, y) >= threshold);

  // Eyes are small relative to the whole picture; reject page-sized regions.
  const maxArea = w * h * 0.05;
  const minArea = Math.max(6, w * h * 0.00012);
  const candidates = blobs
    .filter((b) => b.count >= minArea && b.count <= maxArea)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  if (candidates.length < 2) return null;

  let best = null;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      const sep = Math.abs(a.cx - b.cx);
      const drop = Math.abs(a.cy - b.cy);
      const size = Math.max(a.width, b.width, a.height, b.height);
      if (sep < size * 0.6 || sep > size * 8) continue; // implausible spacing
      if (drop > size * 1.1) continue; // eyes sit roughly level
      const ratio = Math.max(a.count, b.count) / Math.min(a.count, b.count);
      if (ratio > 5) continue; // wildly different sizes are not a pair
      const score = (a.count + b.count) / (1 + drop / size) / (1 + ratio * 0.2);
      if (!best || score > best.score) {
        best = { score, pair: a.cx <= b.cx ? [a, b] : [b, a] };
      }
    }
  }
  return best?.pair ?? null;
}

/** Flood-fill labelling of a boolean mask, returning per-blob extents. */
function labelBlobs(w, h, test) {
  const seen = new Uint8Array(w * h);
  const blobs = [];
  const stack = [];

  for (let y0 = 0; y0 < h; y0++) {
    for (let x0 = 0; x0 < w; x0++) {
      const start = y0 * w + x0;
      if (seen[start] || !test(x0, y0)) continue;

      let sumX = 0;
      let sumY = 0;
      let count = 0;
      let minX = w;
      let minY = h;
      let maxX = 0;
      let maxY = 0;

      seen[start] = 1;
      stack.push(start);
      while (stack.length) {
        const idx = stack.pop();
        const x = idx % w;
        const y = (idx - x) / w;
        sumX += x;
        sumY += y;
        count++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;

        if (x > 0 && !seen[idx - 1] && test(x - 1, y)) { seen[idx - 1] = 1; stack.push(idx - 1); }
        if (x < w - 1 && !seen[idx + 1] && test(x + 1, y)) { seen[idx + 1] = 1; stack.push(idx + 1); }
        if (y > 0 && !seen[idx - w] && test(x, y - 1)) { seen[idx - w] = 1; stack.push(idx - w); }
        if (y < h - 1 && !seen[idx + w] && test(x, y + 1)) { seen[idx + w] = 1; stack.push(idx + w); }
      }

      blobs.push({
        count, cx: sumX / count, cy: sumY / count,
        x0: minX, y0: minY, x1: maxX, y1: maxY,
        width: maxX - minX + 1, height: maxY - minY + 1,
      });
    }
  }
  return blobs;
}

/** Grow a blob's box outward — the lid trick needs margin around the eye. */
function padBox(b, fraction, w, h) {
  const px = Math.max(2, b.width * fraction);
  const py = Math.max(2, b.height * fraction);
  return [
    clamp(b.x0 - px, 0, w), clamp(b.y0 - py, 0, h),
    clamp(b.x1 + px, 0, w), clamp(b.y1 + py, 0, h),
  ];
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
