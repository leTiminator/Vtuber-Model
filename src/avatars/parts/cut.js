/**
 * Cuts the artwork into separate, independently movable parts.
 *
 * This is the step the single-mesh warp avoided. One continuous sheet can never
 * tear a hole, but it also means nothing can truly move on its own — the head
 * and arms end up sharing the scarf's motion because they share its sheet.
 * Real layers fix that, at the cost of having to answer "what is behind this?"
 *
 * The answer is dilation. Every part is grown outward past its visible edge by
 * flooding its own colours into the transparent margin. Move the head and there
 * is painted scarf behind it instead of a hole. Flat cel art dilates almost
 * perfectly, because the colour just past an edge is nearly always the colour
 * that edge sits on.
 *
 * Part rules are tuned to this specific character rather than being general.
 * That is deliberate: a rig that works beautifully for one piece of art beats a
 * generic one that works adequately for none.
 */
import { clamp } from '../../core/math.js';

const ALPHA_FLOOR = 40;

/**
 * Draw order, back to front, with the joint each part hangs off.
 * `parent` builds the hierarchy so a child inherits its parent's motion —
 * the head cannot drift off the neck because the neck carries it.
 */
export const PART_SPECS = [
  { name: 'tails', parent: 'root', joint: 'neck', z: 0 },
  { name: 'body', parent: 'root', joint: 'hips', z: 1 },
  { name: 'tufts', parent: 'head', joint: 'neck', z: 2 },
  { name: 'head', parent: 'neck', joint: 'neck', z: 3 },
  { name: 'eyes', parent: 'head', joint: 'eyes', z: 4 },
  { name: 'wrap', parent: 'neck', joint: 'neck', z: 5 },
];

/**
 * @param {HTMLImageElement} image
 * @param {object} markers  headX/headY/headR/pivotX/pivotY/waistY/eyeL/eyeR, UV
 * @returns {{parts: object[], width: number, height: number}}
 */
export function cutParts(image, markers) {
  const w = image.naturalWidth;
  const h = image.naturalHeight;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  const src = ctx.getImageData(0, 0, w, h);

  const labels = labelPixels(src, markers, w, h);

  // Depth per label, so dilation knows which neighbours sit in front.
  const zByLabel = new Int32Array(16).fill(-1);
  for (const spec of PART_SPECS) zByLabel[LABEL[spec.name]] = spec.z;

  const parts = [];
  for (const spec of PART_SPECS) {
    const part = extract(src, labels, spec.name, w, h, zByLabel);
    if (!part) continue;
    parts.push({ ...spec, ...part });
  }
  return { parts, width: w, height: h };
}

/* ----------------------------------------------------------------- labels */

const LABEL = { none: 0, tails: 1, wrap: 2, head: 3, eyes: 4, tufts: 5, body: 6 };

/**
 * Assign every opaque pixel to exactly one part.
 *
 * Colour alone cannot do this — the gloves are the scarf's red and the visor is
 * the hood's grey — so each rule combines colour with where the pixel sits
 * relative to the head, neck and waist markers the user placed.
 */
function labelPixels(src, m, w, h) {
  const n = w * h;
  const out = new Uint8Array(n);
  const d = src.data;

  const hx = m.headX * w;
  const hy = m.headY * h;
  const hr = m.headR * h;
  const nx = m.pivotX * w;
  const ny = m.pivotY * h;
  const aspect = w / h;

  const opaque = (i) => d[i * 4 + 3] > ALPHA_FLOOR;
  const hsl = (i) => {
    const o = i * 4;
    const r = d[o] / 255, g = d[o + 1] / 255, b = d[o + 2] / 255;
    const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
    const c = hi - lo, l = (hi + lo) / 2;
    if (c < 1e-6) return { hue: 0, sat: 0, lum: l };
    let hue = hi === r ? ((g - b) / c + 6) % 6 : hi === g ? (b - r) / c + 2 : (r - g) / c + 4;
    return { hue: hue / 6, sat: c / (1 - Math.abs(2 * l - 1)), lum: l };
  };

  // Scarf hue: the dominant saturated colour outside the head.
  const bins = new Float32Array(36);
  for (let i = 0; i < n; i++) {
    if (!opaque(i)) continue;
    const x = i % w, y = (i - (i % w)) / w;
    if (Math.hypot((x - hx) / aspect, y - hy) < hr) continue;
    const { hue, sat } = hsl(i);
    if (sat > 0.32) bins[Math.min(35, Math.floor(hue * 36))] += 1;
  }
  let peak = 0, peakBin = 0;
  for (let b = 0; b < 36; b++) if (bins[b] > peak) { peak = bins[b]; peakBin = b; }
  const clothHue = peakBin / 36 + 1 / 72;

  const isCloth = (i) => {
    const { hue, sat } = hsl(i);
    if (sat <= 0.3) return false;
    const dist = Math.min(Math.abs(hue - clothHue), 1 - Math.abs(hue - clothHue));
    return dist < 0.055;
  };

  // --- cloth, but only what the neck can reach --------------------------
  // The gloves are the same red. Connectivity is what separates them.
  const cloth = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (opaque(i) && isCloth(i)) cloth[i] = 1;
  const reached = fillHoles(floodFrom(cloth, w, h, nx, ny, Math.max(8, hr * 0.5)), w, h);

  // --- eyes: the bright blob on the visor -------------------------------
  const eyeMask = new Uint8Array(n);
  for (const key of ['eyeL', 'eyeR']) {
    const r = m[key];
    for (let y = Math.floor(r[1] * h); y <= Math.ceil(r[3] * h); y++) {
      for (let x = Math.floor(r[0] * w); x <= Math.ceil(r[2] * w); x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = y * w + x;
        if (opaque(i) && hsl(i).lum > 0.72) eyeMask[i] = 1;
      }
    }
  }

  // --- pass 1: label only what we are sure about -----------------------
  //
  // The line art is the hard part. Those strokes are near-black with no
  // saturation, so they fail every colour test and would all fall through to
  // whichever label is last — which is how "body" ended up as a frame-wide
  // smear containing the outlines drawn around the scarf. So outlines are left
  // unlabelled here and handed to their rightful owner in pass 2.
  const OUTLINE_LUM = 0.25;

  for (let i = 0; i < n; i++) {
    if (!opaque(i)) continue;
    const x = i % w;
    const y = (i - x) / w;
    const dHead = Math.hypot((x - hx) / aspect, y - hy) / hr;
    const { lum } = hsl(i);

    if (eyeMask[i]) { out[i] = LABEL.eyes; continue; }
    if (lum < OUTLINE_LUM) continue; // line art: decided in pass 2

    if (reached[i]) {
      // Cloth near the neck is the wrap and rides with the head; the rest
      // hangs free and gets the chain.
      out[i] = dHead < 1.45 ? LABEL.wrap : LABEL.tails;
      continue;
    }

    // The shell, out to where the hood actually ends.
    if (dHead < 1.35) { out[i] = LABEL.head; continue; }
    // Spikes off the back of the hood, above the neck.
    if (dHead < 2.2 && y < ny && lum < 0.5) { out[i] = LABEL.tufts; continue; }

    // Everything else is one body piece.
    //
    // Splitting arms from the trunk geometrically was tried and does not work:
    // this character is diving at roughly 45 degrees, so a "torso column" rule
    // shreds the figure into debris. The right signal for an arm cut is the
    // shoulder, elbow and wrist from pose tracking, so the split waits until
    // those landmarks exist rather than being guessed from colour.
    out[i] = LABEL.body;
  }

  // --- pass 2: grow each part into the line art bounding it -------------
  // Multi-source flood: every labelled pixel seeds at distance zero, and the
  // nearest label claims each unlabelled stroke. An outline therefore goes to
  // the shape it was drawn around.
  {
    const queue = new Int32Array(n);
    let head = 0, tail = 0;
    for (let i = 0; i < n; i++) if (out[i] !== LABEL.none) queue[tail++] = i;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      const y = (i - x) / w;
      const claim = (j) => {
        if (out[j] !== LABEL.none || !opaque(j)) return;
        out[j] = out[i];
        queue[tail++] = j;
      };
      if (x > 0) claim(i - 1);
      if (x < w - 1) claim(i + 1);
      if (y > 0) claim(i - w);
      if (y < h - 1) claim(i + w);
    }
  }

  return out;
}

/** Flood a binary mask outward from a seed disc; returns what it reached. */
function floodFrom(mask, w, h, cx, cy, radius) {
  const n = w * h;
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;

  const ax = Math.round(cx), ay = Math.round(cy), r = Math.round(radius);
  for (let y = Math.max(0, ay - r); y <= Math.min(h - 1, ay + r); y++) {
    for (let x = Math.max(0, ax - r); x <= Math.min(w - 1, ax + r); x++) {
      const i = y * w + x;
      if (mask[i] && !seen[i]) { seen[i] = 1; queue[tail++] = i; }
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; queue[tail++] = i - 1; }
    if (x < w - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; queue[tail++] = i + 1; }
    if (y > 0 && mask[i - w] && !seen[i - w]) { seen[i - w] = 1; queue[tail++] = i - w; }
    if (y < h - 1 && mask[i + w] && !seen[i + w]) { seen[i + w] = 1; queue[tail++] = i + w; }
  }
  // Nothing found near the anchor: keep the whole mask rather than erase it.
  if (tail === 0) return mask;
  return seen;
}

/**
 * Close enclosed gaps in a mask.
 *
 * The scarf is shaded, and its darkest folds are too desaturated to pass a hue
 * test — so they read as holes punched through the middle of the cloth and get
 * handed to whatever label comes last. Anything fully surrounded by the mask
 * belongs to it, whatever colour it happens to be.
 *
 * Found by flooding the *outside*: start from the border, and any gap the flood
 * cannot reach is enclosed.
 */
function fillHoles(mask, w, h) {
  const n = w * h;
  const outside = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;

  const seed = (i) => {
    if (mask[i] || outside[i]) return;
    outside[i] = 1;
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

  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = mask[i] || !outside[i] ? 1 : 0;
  return out;
}

/* ---------------------------------------------------------------- extract */

const DILATE = 28; // px of painted margin under neighbouring parts

/**
 * Pull one part out as its own image, grown outward so the parts that used to
 * cover it have something to move off.
 */
function extract(src, labels, name, w, h, zByLabel) {
  const id = LABEL[name];
  const z = zByLabel[id];
  const n = w * h;

  let x0 = w, y0 = h, x1 = -1, y1 = -1, count = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== id) continue;
    const x = i % w, y = (i - (i % w)) / w;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
    count++;
  }
  if (count < 40) return null;

  // Room for the dilated margin.
  x0 = Math.max(0, x0 - DILATE); y0 = Math.max(0, y0 - DILATE);
  x1 = Math.min(w - 1, x1 + DILATE); y1 = Math.min(h - 1, y1 + DILATE);
  const pw = x1 - x0 + 1;
  const ph = y1 - y0 + 1;

  const out = new ImageData(pw, ph);
  const od = out.data;
  const sd = src.data;

  // Distance-ordered flood: seed every pixel of this part, then push colour
  // outward one ring at a time. One pass, rather than N morphological passes.
  const dist = new Int32Array(pw * ph).fill(-1);
  const queue = new Int32Array(pw * ph);
  let head = 0, tail = 0;

  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const si = (y + y0) * w + (x + x0);
      const di = y * pw + x;
      if (labels[si] !== id) continue;
      const so = si * 4, dopo = di * 4;
      od[dopo] = sd[so]; od[dopo + 1] = sd[so + 1];
      od[dopo + 2] = sd[so + 2]; od[dopo + 3] = sd[so + 3];
      dist[di] = 0;
      queue[tail++] = di;
    }
  }

  while (head < tail) {
    const i = queue[head++];
    const step = dist[i] + 1;
    if (step > DILATE) continue;
    const x = i % pw;
    const y = (i - x) / pw;
    const spread = (j) => {
      if (dist[j] >= 0) return;
      // Only grow under parts drawn in front of this one. Growing into empty
      // space or into parts behind would paint over them when the stack is
      // assembled — the margin exists to be revealed when a covering part moves
      // away, not to be visible at rest.
      const jx = j % pw;
      const jy = (j - jx) / pw;
      const sl = labels[(jy + y0) * w + (jx + x0)];
      if (sl === LABEL.none || zByLabel[sl] <= z) return;
      dist[j] = step;
      const a = j * 4, b = i * 4;
      od[a] = od[b]; od[a + 1] = od[b + 1]; od[a + 2] = od[b + 2];
      // Fully opaque: this margin exists to be hidden under other parts, and a
      // soft edge here would show as a halo when one slides away.
      od[a + 3] = 255;
      queue[tail++] = j;
    };
    if (x > 0) spread(i - 1);
    if (x < pw - 1) spread(i + 1);
    if (y > 0) spread(i - pw);
    if (y < ph - 1) spread(i + pw);
  }

  const canvas = document.createElement('canvas');
  canvas.width = pw;
  canvas.height = ph;
  canvas.getContext('2d').putImageData(out, 0, 0);

  return {
    canvas,
    x: x0, y: y0, w: pw, h: ph,
    // Where the visible art sits inside the padded box, for anchoring.
    inset: DILATE,
    pixels: count,
  };
}
