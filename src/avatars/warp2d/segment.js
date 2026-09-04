/**
 * Reads a piece of artwork and works out where its parts are.
 *
 * Two jobs. First, place the markers — head, neck, eyes — so loading an image
 * lands somewhere close instead of on four unplaced handles. Second, build the
 * region masks that let each part of the drawing move independently: cloth that
 * flows, tufts that whip, a torso that breathes, legs that barely move.
 *
 * Everything is computed on a downscaled copy; precision beyond a few hundred
 * pixels is noise once the weights are sampled onto a mesh.
 */
import { clamp } from '../../core/math.js';

const ANALYSIS_WIDTH = 420;
const ALPHA_FLOOR = 40;

/* ------------------------------------------------------------- pixel read */

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

const alphaAt = (px, i) => px.data[i * 4 + 3];
const opaque = (px, i) => px.data[i * 4 + 3] > ALPHA_FLOOR;

function lumAt(px, i) {
  const d = px.data;
  const o = i * 4;
  return 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];
}

/** Hue in turns (0..1) and saturation, cheap HSL without the full convert. */
function hueSat(px, i) {
  const d = px.data;
  const o = i * 4;
  const r = d[o] / 255, g = d[o + 1] / 255, b = d[o + 2] / 255;
  const hi = Math.max(r, g, b);
  const lo = Math.min(r, g, b);
  const c = hi - lo;
  const l = (hi + lo) / 2;
  if (c < 1e-6) return { h: 0, s: 0, l };
  const s = c / (1 - Math.abs(2 * l - 1));
  let h;
  if (hi === r) h = ((g - b) / c + 6) % 6;
  else if (hi === g) h = (b - r) / c + 2;
  else h = (r - g) / c + 4;
  return { h: h / 6, s, l };
}

/* ---------------------------------------------------------------- markers */

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

/* ------------------------------------------------------------------ masks */

/**
 * Build the per-pixel region weights the mesh samples from.
 *
 * Colour separates cloth reliably in most character art, but rarely separates a
 * helmet from a visor — those are usually the same hue at different lightness.
 * So cloth comes from hue, and everything inside the head comes from position
 * relative to the head marker.
 *
 * @returns {{head,face,tufts,cloth,torso,lower,clothT,tuftT:Float32Array, w,h:number}}
 */
export function buildMasks(px, markers) {
  const { w, h } = px;
  const n = w * h;
  const aspect = w / h;

  const head = new Float32Array(n);
  const face = new Float32Array(n);
  const tufts = new Float32Array(n);
  const cloth = new Float32Array(n);
  const torso = new Float32Array(n);
  const lower = new Float32Array(n);

  const hx = markers.headX * w;
  const hy = markers.headY * h;
  const hr = markers.headR * h;
  const waist = markers.waistY * h;

  // Dominant chromatic hue outside the head — the cloth colour.
  const bins = new Float32Array(36);
  for (let i = 0; i < n; i++) {
    if (!opaque(px, i)) continue;
    const x = i % w, y = (i - (i % w)) / w;
    if (Math.hypot((x - hx) / aspect, y - hy) < hr) continue;
    const { h: hue, s } = hueSat(px, i);
    if (s > 0.32) bins[Math.min(35, Math.floor(hue * 36))] += 1;
  }
  let peakBin = -1, peakCount = 0;
  for (let b = 0; b < 36; b++) if (bins[b] > peakCount) { peakCount = bins[b]; peakBin = b; }
  const clothHue = peakBin / 36 + 1 / 72;
  const hasCloth = peakCount > n * 0.004;

  // Split the head into shell and face plate at the midpoint of its own
  // lightness range, so it adapts to whatever the artwork's palette is.
  const headLums = [];
  for (let i = 0; i < n; i++) {
    if (!opaque(px, i)) continue;
    const x = i % w, y = (i - (i % w)) / w;
    if (Math.hypot((x - hx) / aspect, y - hy) > hr) continue;
    const { s: sat, l } = hueSat(px, i);
    if (sat < 0.32) headLums.push(l);
  }
  headLums.sort((a, b) => a - b);
  const faceCut = headLums.length > 40
    ? (headLums[Math.floor(headLums.length * 0.25)] + headLums[Math.floor(headLums.length * 0.9)]) / 2
    : 0.42;

  for (let i = 0; i < n; i++) {
    if (!opaque(px, i)) continue;
    const x = i % w;
    const y = (i - x) / w;

    const d = Math.hypot((x - hx) / aspect, y - hy) / hr;
    const headW = 1 - smoothstep(0.95, 2.0, d);
    head[i] = headW;

    const { h: hue, s, l } = hueSat(px, i);
    const hueDist = Math.min(Math.abs(hue - clothHue), 1 - Math.abs(hue - clothHue));
    const isCloth = hasCloth && s > 0.3 && hueDist < 0.055;

    if (isCloth) {
      cloth[i] = 1;
      continue;
    }

    // Tufts are tested before the head, and overlap it on purpose. Hair
    // sticking off a hood is the same colour as the hood and sits inside the
    // head's own radius, so there is no clean line between them — but it does
    // live in the outer band. Weighting it in from there gives the spikes their
    // own lag on top of the head's motion, which is what they need.
    const outer = clamp((d - 0.78) / 0.4, 0, 1);
    if (l < 0.5 && outer > 0 && d < 2.2) {
      tufts[i] = outer * (1 - smoothstep(1.5, 2.2, d));
    }

    if (headW > 0.5) {
      // Face plate is filled in afterwards, by growing out from the eyes.
      continue;
    }

    if (y < waist) torso[i] = 1;
    else lower[i] = 1;
  }

  // The face plate is whatever light surface the eyes actually sit on, found by
  // growing outward from them. Thresholding on lightness alone would also catch
  // a glossy highlight elsewhere on the head, and that highlight would then
  // slide with the face and shear a hard edge across the artwork.
  {
    const stack = [];
    const seen = new Uint8Array(n);
    const seed = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = y * w + x;
      if (seen[i] || !opaque(px, i)) return;
      seen[i] = 1;
      face[i] = 1;
      stack.push(i);
    };

    for (const key of ['eyeL', 'eyeR']) {
      const r = markers[key];
      for (let y = Math.floor(r[1] * h); y <= Math.ceil(r[3] * h); y++) {
        for (let x = Math.floor(r[0] * w); x <= Math.ceil(r[2] * w); x++) seed(x, y);
      }
    }

    while (stack.length) {
      const i = stack.pop();
      const x = i % w;
      const y = (i - x) / w;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (seen[j] || !opaque(px, j)) continue;
        const d = Math.hypot((nx - hx) / aspect, ny - hy) / hr;
        if (d > 1.15) continue; // do not leak off the head
        const { s: sat, l } = hueSat(px, j);
        if (sat > 0.32 || l <= faceCut) continue; // stop at the shell and at cloth
        seen[j] = 1;
        face[j] = 1;
        stack.push(j);
      }
    }
  }

  // Colour alone is not enough to say what is cloth. This character's gloves are
  // the same red as the scarf, so a pure hue test hands the hands to the cloth
  // solver and the arms start flowing like fabric. Cloth is what the neck can
  // actually reach: flood out from the anchor and drop anything disconnected,
  // handing it back to the body so it moves with the torso instead.
  {
    const reach = new Uint8Array(n);
    const queue = new Int32Array(n);
    let qh = 0, qt = 0;

    const ax = Math.round(markers.pivotX * w);
    const ay = Math.round(markers.pivotY * h);
    const seedR = Math.max(6, Math.round(Math.min(w, h) * 0.08));
    for (let y = Math.max(0, ay - seedR); y <= Math.min(h - 1, ay + seedR); y++) {
      for (let x = Math.max(0, ax - seedR); x <= Math.min(w - 1, ax + seedR); x++) {
        const i = y * w + x;
        if (cloth[i] > 0 && !reach[i]) { reach[i] = 1; queue[qt++] = i; }
      }
    }
    while (qh < qt) {
      const i = queue[qh++];
      const x = i % w;
      const y = (i - x) / w;
      if (x > 0 && cloth[i - 1] > 0 && !reach[i - 1]) { reach[i - 1] = 1; queue[qt++] = i - 1; }
      if (x < w - 1 && cloth[i + 1] > 0 && !reach[i + 1]) { reach[i + 1] = 1; queue[qt++] = i + 1; }
      if (y > 0 && cloth[i - w] > 0 && !reach[i - w]) { reach[i - w] = 1; queue[qt++] = i - w; }
      if (y < h - 1 && cloth[i + w] > 0 && !reach[i + w]) { reach[i + w] = 1; queue[qt++] = i + w; }
    }

    // Only bother if the flood actually found the scarf; if the anchor is
    // nowhere near any cloth, keep the hue result rather than erasing it all.
    let found = 0;
    for (let i = 0; i < n; i++) if (reach[i]) found++;
    if (found > n * 0.002) {
      for (let i = 0; i < n; i++) {
        if (cloth[i] <= 0 || reach[i]) continue;
        cloth[i] = 0;
        const y = (i - (i % w)) / w;
        if (y < waist) torso[i] = 1;
        else lower[i] = 1;
      }
    }
  }

  // Cloth wrapped over the head should ride with the head, not swing.
  for (let i = 0; i < n; i++) if (cloth[i] > 0 && head[i] > 0.6) head[i] = Math.max(head[i], cloth[i]);

  const anchor = { x: markers.pivotX * w, y: markers.pivotY * h };
  const clothT = radialParam(cloth, w, h, anchor);
  const tuftT = radialParam(tufts, w, h, { x: hx, y: hy });

  // Soften relative to mesh vertex spacing: a 36-cell grid over a 420px
  // analysis image lands a vertex every ~12px, so a 2px edge aliases badly.
  const soft = Math.max(2, Math.round(Math.min(w, h) / 110));
  return {
    w, h,
    head: blur(head, w, h, soft),
    face: blur(face, w, h, soft),
    tufts: blur(tufts, w, h, soft),
    cloth: blur(cloth, w, h, soft),
    torso: blur(torso, w, h, soft + 2),
    lower: blur(lower, w, h, soft + 2),
    clothT,
    tuftT,
  };
}

/**
 * Distance along a mask from its anchor, normalised to 0..1.
 *
 * This started as a flood fill, on the reasoning that a ribbon looping back on
 * itself passes close to its own anchor and should not be treated as attached
 * there. That is true physically and wrong visually: where a ribbon crosses
 * itself, two touching pixels get very different distances, so neighbouring
 * mesh vertices get very different displacements and the sheet creases. On real
 * artwork it crumpled a smooth scarf into faceted shards.
 *
 * Straight-line distance is continuous everywhere by construction. A folded-back
 * section moves as though it were near the anchor, which is slightly wrong and
 * completely invisible; the crumpling was neither.
 */
function radialParam(mask, w, h, anchor) {
  const out = new Float32Array(w * h);
  let maxDist = 1e-4;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] <= 0.4) continue;
    const x = i % w;
    const y = (i - x) / w;
    const d = Math.hypot(x - anchor.x, y - anchor.y);
    if (d > maxDist) maxDist = d;
  }
  for (let i = 0; i < mask.length; i++) {
    const x = i % w;
    const y = (i - x) / w;
    out[i] = clamp(Math.hypot(x - anchor.x, y - anchor.y) / maxDist, 0, 1);
  }
  return blur(out, w, h, Math.max(3, Math.round(Math.min(w, h) / 90)));
}

// eslint-disable-next-line no-unused-vars -- kept for reference; see above.
function geodesic(mask, w, h, anchor) {
  const out = new Float32Array(w * h);
  const dist = new Float32Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;

  // Seed from every masked pixel near the anchor.
  const ax = Math.round(anchor.x);
  const ay = Math.round(anchor.y);
  const radius = Math.max(4, Math.round(Math.min(w, h) * 0.06));
  for (let y = Math.max(0, ay - radius); y <= Math.min(h - 1, ay + radius); y++) {
    for (let x = Math.max(0, ax - radius); x <= Math.min(w - 1, ax + radius); x++) {
      const i = y * w + x;
      if (mask[i] > 0.4 && dist[i] < 0) { dist[i] = 0; queue[tail++] = i; }
    }
  }
  // Nothing near the anchor — start from whatever masked pixel is closest.
  if (tail === 0) {
    let bestI = -1, bestD = Infinity;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] <= 0.4) continue;
      const x = i % w, y = (i - (i % w)) / w;
      const d = Math.hypot(x - anchor.x, y - anchor.y);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    if (bestI < 0) return out;
    dist[bestI] = 0;
    queue[tail++] = bestI;
  }

  let maxDist = 1;
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const y = (i - x) / w;
    const d = dist[i] + 1;
    if (d > maxDist) maxDist = d;
    if (x > 0 && mask[i - 1] > 0.4 && dist[i - 1] < 0) { dist[i - 1] = d; queue[tail++] = i - 1; }
    if (x < w - 1 && mask[i + 1] > 0.4 && dist[i + 1] < 0) { dist[i + 1] = d; queue[tail++] = i + 1; }
    if (y > 0 && mask[i - w] > 0.4 && dist[i - w] < 0) { dist[i - w] = d; queue[tail++] = i - w; }
    if (y < h - 1 && mask[i + w] > 0.4 && dist[i + w] < 0) { dist[i + w] = d; queue[tail++] = i + w; }
  }

  for (let i = 0; i < out.length; i++) out[i] = dist[i] < 0 ? 0 : dist[i] / maxDist;
  return blur(out, w, h, Math.max(4, Math.round(Math.min(w, h) / 48)));
}

/* ---------------------------------------------------------------- helpers */

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

function padBox(b, fraction, w, h) {
  const px = Math.max(2, b.width * fraction);
  const py = Math.max(2, b.height * fraction);
  return [
    clamp(b.x0 - px, 0, w), clamp(b.y0 - py, 0, h),
    clamp(b.x1 + px, 0, w), clamp(b.y1 + py, 0, h),
  ];
}

/** Separable box blur; softens mask edges so mesh sampling does not alias. */
function blur(src, w, h, radius) {
  if (radius < 1) return src;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, n = 0;
      for (let k = Math.max(0, x - radius); k <= Math.min(w - 1, x + radius); k++) { sum += src[y * w + k]; n++; }
      tmp[y * w + x] = sum / n;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let sum = 0, n = 0;
      for (let k = Math.max(0, y - radius); k <= Math.min(h - 1, y + radius); k++) { sum += tmp[k * w + x]; n++; }
      out[y * w + x] = sum / n;
    }
  }
  return out;
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

const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};

const round = (n) => Math.round(n * 1e4) / 1e4;


/**
 * The colour each eyelid is painted in: the face immediately around the socket,
 * with the bright eye itself excluded. Cel-shaded art has a flat surface there,
 * so a single colour reads as a closed eye far better than smearing a row of
 * the texture down over it.
 *
 * @returns {{left:number[], right:number[]}} 0..1 RGB triples
 */
export function sampleLidColours(px, markers, eyeAngle = 0) {
  const { w, h } = px;
  const cos = Math.cos(-eyeAngle);
  const sin = Math.sin(-eyeAngle);

  const pick = (rect) => {
    const cx = ((rect[0] + rect[2]) / 2) * w;
    const cy = ((rect[1] + rect[3]) / 2) * h;
    const hw = Math.max((Math.abs(rect[2] - rect[0]) / 2) * w, 1e-5);
    const hh = Math.max((Math.abs(rect[3] - rect[1]) / 2) * h, 1e-5);

    const reds = [], greens = [], blues = [];
    const reach = Math.ceil(Math.max(hw, hh) * 1.9);
    for (let y = Math.round(cy - reach); y <= cy + reach; y++) {
      for (let x = Math.round(cx - reach); x <= cx + reach; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = y * w + x;
        if (!opaque(px, i)) continue;
        const dx = x - cx, dy = y - cy;
        const ex = (dx * cos - dy * sin) / hw;
        const ey = (dx * sin + dy * cos) / hh;
        const r = Math.hypot(ex, ey);
        // A ring just outside the socket, skipping the socket's own contents.
        if (r < 1.05 || r > 1.7) continue;
        // Skip anything as bright as an eye; that is a highlight, not face.
        if (lumAt(px, i) > 205) continue;
        const o = i * 4;
        reds.push(px.data[o]); greens.push(px.data[o + 1]); blues.push(px.data[o + 2]);
      }
    }
    if (reds.length < 12) return [0.35, 0.38, 0.45];
    const mid = (arr) => { arr.sort((a, b) => a - b); return arr[arr.length >> 1] / 255; };
    return [mid(reds), mid(greens), mid(blues)];
  };

  return { left: pick(markers.eyeL), right: pick(markers.eyeR) };
}
