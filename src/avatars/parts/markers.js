/**
 * Finds the markers the cut needs in a piece of artwork: where the head is,
 * where the neck pivots, where the eyes are and how they tilt.
 *
 * Eyes lead, because they are the most reliable landmark in character art:
 * small, bright, roughly level. Everything is measured on a downscaled copy.
 */
import { clamp } from '../../core/math.js';

const ANALYSIS_WIDTH = 420;
const ALPHA_FLOOR = 40;

/** Draw the artwork into an offscreen canvas and hand back its pixels. */
export function readPixels(image, maxWidth = ANALYSIS_WIDTH) {
  // A canvas is as good a source as an <img>, and a drawing that has been
  // repaired on the way in arrives as one — see parts/repair.js.
  const iw = image.naturalWidth ?? image.width;
  const ih = image.naturalHeight ?? image.height;
  const scale = Math.min(1, maxWidth / iw);
  const w = Math.max(8, Math.round(iw * scale));
  const h = Math.max(8, Math.round(ih * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, w, h);

  try {
    return { data: ctx.getImageData(0, 0, w, h).data, w, h };
  } catch {
    return null; // tainted canvas
  }
}

const opaque = (px, i) => px.data[i * 4 + 3] > ALPHA_FLOOR;

function lumAt(px, i) {
  const d = px.data;
  const o = i * 4;
  return 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];
}

/**
 * Place head, neck and eyes. Eyes lead, because they are the most reliable
 * landmark in character art — small, bright, roughly level. Placing the head
 * from them survives compositions where something larger than the figure (a
 * cape, a scarf) dominates the silhouette.
 */
export function detectMarkers(px) {
  if (!px) return null;
  const { w, h } = px;

  const eyes = findEyes(px);
  let headCX, headCY, headRadiusPx, neckY, eyeBoxes;
  let eyeAngle = 0;

  if (eyes) {
    const [a, b] = eyes;
    const sep = a.merged ? a.separation : Math.hypot(b.cx - a.cx, b.cy - a.cy);
    eyeAngle = a.merged ? a.angle : Math.atan2(b.cy - a.cy, b.cx - a.cx);
    headCX = (a.cx + b.cx) / 2;
    headRadiusPx = clamp(sep * 2.0, 6, Math.max(w, h));
    headCY = (a.cy + b.cy) / 2 - headRadiusPx * 0.22; // eyes sit below centre
    neckY = clamp(headCY + headRadiusPx * 1.15, 0, h);
    eyeBoxes = { left: socket(a, 0.34), right: socket(b, 0.34) };
  } else {
    const fallback = silhouetteFallback(px);
    if (!fallback) return null;
    ({ headCX, headCY, headRadiusPx, neckY, eyeBoxes } = fallback);
  }

  // The neck sits under the head. Measure the silhouette's midpoint at that
  // height, but only within a window around the head — otherwise a cape or a
  // trailing scarf at the same height drags the pivot out into open space.
  const row = Math.round(clamp(neckY, 0, h - 1));
  const from = Math.max(0, Math.round(headCX - headRadiusPx * 1.2));
  const to = Math.min(w - 1, Math.round(headCX + headRadiusPx * 1.2));
  let lo = -1, hi = -1;
  for (let x = from; x <= to; x++) {
    if (opaque(px, row * w + x)) {
      if (lo < 0) lo = x;
      hi = x;
    }
  }
  const pivotX = lo >= 0 ? (lo + hi) / 2 : headCX;

  // Bottom of the figure, for a sensible default waistline.
  let bottom = h - 1;
  for (let y = h - 1; y >= 0; y--) {
    let any = false;
    for (let x = 0; x < w; x++) if (opaque(px, y * w + x)) { any = true; break; }
    if (any) { bottom = y; break; }
  }

  const u = (v) => round(clamp(v / w, 0, 1));
  const v = (y) => round(clamp(y / h, 0, 1));
  const rect = (r) => [u(r[0]), v(r[1]), u(r[2]), v(r[3])];

  return {
    headX: u(headCX),
    headY: v(headCY),
    // The mesh measures head distance as hypot(du * aspect, dv) / headR with
    // aspect = width/height, so R pixels is R/height in those units either way.
    headR: round(clamp(headRadiusPx / h, 0.03, 0.9)),
    pivotX: u(pivotX),
    pivotY: v(neckY),
    waistY: v(neckY + (bottom - neckY) * 0.45),
    eyeAngle: round(eyeAngle),
    eyeL: rect(eyeBoxes.left),
    eyeR: rect(eyeBoxes.right),
    confidentEyes: Boolean(eyes),
  };
}

function findEyes(px) {
  const { w, h } = px;
  const lums = [];
  for (let i = 0; i < w * h; i++) if (opaque(px, i)) lums.push(lumAt(px, i));
  if (lums.length < 200) return null;

  lums.sort((a, b) => a - b);
  const median = lums[lums.length >> 1];
  const peak = lums[Math.floor(lums.length * 0.998)];
  if (peak - median < 50) return null;

  const threshold = Math.max(median + (peak - median) * 0.6, median + 40);
  const blobs = labelBlobs(px, (i) => opaque(px, i) && lumAt(px, i) >= threshold);

  const maxArea = w * h * 0.05;
  const minArea = Math.max(6, w * h * 0.00012);
  const candidates = blobs
    .filter((b) => b.count >= minArea && b.count <= maxArea)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  if (!candidates.length) return null;

  let best = null;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      const sep = Math.abs(a.cx - b.cx);
      const drop = Math.abs(a.cy - b.cy);
      const size = Math.max(a.width, b.width, a.height, b.height);
      if (sep < size * 0.6 || sep > size * 8) continue;
      if (drop > size * 1.1) continue;
      const ratio = Math.max(a.count, b.count) / Math.min(a.count, b.count);
      if (ratio > 5) continue;
      const score = (a.count + b.count) / (1 + drop / size) / (1 + ratio * 0.2);
      if (!best || score > best.score) best = { score, pair: a.cx <= b.cx ? [a, b] : [b, a] };
    }
  }
  if (best) return best.pair;

  // No pair — but a single elongated blob is very often both eyes joined by
  // bright antialiasing across a visor. Split it along its own principal axis;
  // splitting along screen x would be wrong the moment the head is tilted.
  const widest = candidates[0];
  if (widest && widest.major > widest.minor * 1.7) {
    // For a roughly uniform blob the full extent is about sqrt(12) sigma.
    const extent = widest.major * 3.46;
    const ux = Math.cos(widest.angle);
    const uy = Math.sin(widest.angle);
    const make = (sign) => ({
      cx: widest.cx + ux * (extent / 4) * sign,
      cy: widest.cy + uy * (extent / 4) * sign,
      halfAlong: extent / 4,
      halfAcross: Math.max(2, widest.minor * 1.73),
      angle: widest.angle,
      count: widest.count / 2,
      merged: true,
      separation: extent / 2,
    });
    const a = make(-1);
    const b = make(1);
    return ux >= 0 ? [a, b] : [b, a];
  }
  return null;
}

/** Art with no visible eyes: find the neck as the sharpest pinch below the top. */
function silhouetteFallback(px) {
  const { w, h } = px;
  // Longest contiguous run per row, not total opaque count: a head is one wide
  // run, whereas flowing cloth is several thin ones.
  const runs = new Float32Array(h);
  let top = -1, bottom = -1;
  for (let y = 0; y < h; y++) {
    let best = 0, run = 0;
    for (let x = 0; x < w; x++) {
      if (opaque(px, y * w + x)) { run++; if (run > best) best = run; } else run = 0;
    }
    runs[y] = best;
    if (best > w * 0.02) { if (top < 0) top = y; bottom = y; }
  }
  if (top < 0 || bottom - top < 8) return null;

  const smooth = boxBlur1D(runs, Math.max(2, Math.round(h * 0.02)));
  const from = top + Math.round((bottom - top) * 0.16);
  const to = top + Math.round((bottom - top) * 0.62);
  let neckY = -1, bestScore = 0;
  for (let y = from; y <= to; y++) {
    let above = 0;
    for (let k = top; k < y; k++) above = Math.max(above, smooth[k]);
    let below = 0;
    for (let k = y; k <= Math.min(bottom, y + Math.round((bottom - top) * 0.22)); k++) {
      below = Math.max(below, smooth[k]);
    }
    if (!above || !below) continue;
    const score = (above - smooth[y]) / above + (below - smooth[y]) / below;
    if (score > bestScore) { bestScore = score; neckY = y; }
  }
  if (neckY < 0 || bestScore < 0.18) neckY = top + Math.round((bottom - top) * 0.42);

  let sumX = 0, sumY = 0, mass = 0, left = w, right = 0;
  for (let y = top; y <= neckY; y++) {
    for (let x = 0; x < w; x++) {
      if (!opaque(px, y * w + x)) continue;
      sumX += x; sumY += y; mass++;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (!mass) return null;

  const headCX = sumX / mass;
  const headCY = sumY / mass;
  const headRadiusPx = Math.max((right - left) / 2, (neckY - top) / 2) * 1.04;
  const ex = headRadiusPx * 0.52, ey = headCY - headRadiusPx * 0.1;
  const ew = headRadiusPx * 0.42, eh = headRadiusPx * 0.3;
  return {
    headCX, headCY, headRadiusPx, neckY,
    eyeBoxes: {
      left: [headCX - ex - ew / 2, ey - eh / 2, headCX - ex + ew / 2, ey + eh / 2],
      right: [headCX + ex - ew / 2, ey - eh / 2, headCX + ex + ew / 2, ey + eh / 2],
    },
  };
}

function labelBlobs(px, test) {
  const { w, h } = px;
  const seen = new Uint8Array(w * h);
  const blobs = [];
  const stack = [];

  for (let start = 0; start < w * h; start++) {
    if (seen[start] || !test(start)) continue;
    let sumX = 0, sumY = 0, count = 0;
    let sxx = 0, syy = 0, sxy = 0;
    let minX = w, minY = h, maxX = 0, maxY = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop();
      const x = i % w;
      const y = (i - x) / w;
      sumX += x; sumY += y; count++;
      sxx += x * x; syy += y * y; sxy += x * y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (x > 0 && !seen[i - 1] && test(i - 1)) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < w - 1 && !seen[i + 1] && test(i + 1)) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && !seen[i - w] && test(i - w)) { seen[i - w] = 1; stack.push(i - w); }
      if (y < h - 1 && !seen[i + w] && test(i + w)) { seen[i + w] = 1; stack.push(i + w); }
    }
    const cx = sumX / count;
    const cy = sumY / count;
    // Central second moments give the principal axis, which is how a tilted
    // pair of eyes is recognised as tilted rather than as one wide blob.
    const vxx = sxx / count - cx * cx;
    const vyy = syy / count - cy * cy;
    const vxy = sxy / count - cx * cy;
    const term = Math.sqrt(Math.max(0, (vxx - vyy) * (vxx - vyy) + 4 * vxy * vxy));
    blobs.push({
      count, cx, cy,
      angle: 0.5 * Math.atan2(2 * vxy, vxx - vyy),
      major: Math.sqrt(Math.max(0, (vxx + vyy + term) / 2)),
      minor: Math.sqrt(Math.max(0, (vxx + vyy - term) / 2)),
      x0: minX, y0: minY, x1: maxX, y1: maxY,
      width: maxX - minX + 1, height: maxY - minY + 1,
    });
  }
  return blobs;
}

/**
 * The socket a lid sweeps through, padded so the lid has face to close over.
 * Returned as [x0, y0, x1, y1] about the eye's centre in its own rotated frame;
 * the shader rotates back by eyeAngle, and the editor draws the box to match.
 */
function socket(b, pad) {
  const along = (b.halfAlong ?? b.width / 2) * (1 + pad);
  const across = (b.halfAcross ?? b.height / 2) * (1 + pad * 2.2);
  return [b.cx - along, b.cy - across, b.cx + along, b.cy + across];
}

function boxBlur1D(values, radius) {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0, n = 0;
    for (let k = Math.max(0, i - radius); k <= Math.min(values.length - 1, i + radius); k++) { sum += values[k]; n++; }
    out[i] = sum / n;
  }
  return out;
}

const round = (n) => Math.round(n * 1e4) / 1e4;
