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
  { name: 'armLeft', parent: 'root', joint: 'shoulderLeft', z: 2 },
  { name: 'armRight', parent: 'root', joint: 'shoulderRight', z: 3 },
  { name: 'tufts', parent: 'head', joint: 'tufts', z: 4 },
  { name: 'head', parent: 'neck', joint: 'neck', z: 5 },
  { name: 'eyes', parent: 'head', joint: 'eyes', z: 6 },
  { name: 'wrap', parent: 'neck', joint: 'neck', z: 7 },
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

  const sockets = [];
  const labels = labelPixels(src, markers, w, h, sockets);

  // Depth per label, so dilation knows which neighbours sit in front.
  const zByLabel = new Int32Array(16).fill(-1);
  for (const spec of PART_SPECS) zByLabel[LABEL[spec.name]] = spec.z;

  const parts = [];
  for (const spec of PART_SPECS) {
    const part = extract(src, labels, spec.name, w, h, zByLabel);
    if (!part) continue;
    parts.push({ ...spec, ...part, pivot: pivotFor(spec.name, labels, markers, w, h) });
  }
  return { parts, width: w, height: h, sockets };
}

/* ----------------------------------------------------------------- labels */

const LABEL = {
  none: 0, tails: 1, wrap: 2, head: 3, eyes: 4, tufts: 5, body: 6,
  armLeft: 7, armRight: 8,
};

/**
 * Assign every opaque pixel to exactly one part.
 *
 * The first version of this asked "how far is this pixel from the head marker,
 * and what colour is it?" That fails on this drawing, because the head marker
 * is derived from eye spacing and the visor shards are small next to the
 * helmet: the estimated radius came out at 54px against a helmet 280px across.
 * Every distance rule downstream inherited that error, which is how `tufts`
 * ended up holding the back of the helmet and `body` became scattered debris.
 *
 * So the rules ask a better question: *what is connected to what*. On flat cel
 * art with a heavy ink line, connectivity is nearly ground truth. Three facts
 * about this drawing carry the whole cut:
 *
 *   - The scarf wraps the neck, so it separates the head from everything below.
 *     Flooding outward from the eyes through non-scarf pixels therefore lands
 *     exactly on the helmet, visor and hair, and stops on its own.
 *   - The gloves are the scarf's red but are not joined to it. As pixel
 *     components they fall out separately — no colour rule can do this, and no
 *     geometric one survives a figure diving at 45°.
 *   - An arm is whatever is joined to a glove. The legs touch no glove.
 *
 * What remains geometric is only what genuinely is: which side of the figure a
 * limb sits on, and where along the scarf the neck wrap ends.
 */
function labelPixels(src, m, w, h, sockets) {
  const n = w * h;
  const out = new Uint8Array(n);
  const d = src.data;

  const hx = m.headX * w;
  const hy = m.headY * h;
  const hr = m.headR * h;
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

  const cloth = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!opaque(i)) continue;
    const { hue, sat } = hsl(i);
    if (sat <= 0.3) continue;
    const dist = Math.min(Math.abs(hue - clothHue), 1 - Math.abs(hue - clothHue));
    if (dist < 0.055) cloth[i] = 1;
  }

  const scratch = new Int32Array(n);

  /* --- the head: flood from the eyes, bounded by the scarf ---------------
   * This is the load-bearing trick. The scarf wraps the neck completely, so a
   * flood that refuses to cross it cannot escape downward, and the helmet
   * needs no radius guess at all.
   */
  const eyeCx = Math.round(((m.eyeL[0] + m.eyeL[2] + m.eyeR[0] + m.eyeR[2]) / 4) * w);
  const eyeCy = Math.round(((m.eyeL[1] + m.eyeL[3] + m.eyeR[1] + m.eyeR[3]) / 4) * h);
  const headMask = new Uint8Array(n);
  {
    let head = 0, tail = 0;
    const seed = clamp(eyeCy, 0, h - 1) * w + clamp(eyeCx, 0, w - 1);
    if (opaque(seed)) { headMask[seed] = 1; scratch[tail++] = seed; }
    while (head < tail) {
      const i = scratch[head++];
      const x = i % w;
      const y = (i - x) / w;
      const go = (j) => {
        if (headMask[j] || !opaque(j) || cloth[j]) return;
        headMask[j] = 1;
        scratch[tail++] = j;
      };
      if (x > 0) go(i - 1);
      if (x < w - 1) go(i + 1);
      if (y > 0) go(i - w);
      if (y < h - 1) go(i + w);
    }
  }

  /* --- hair tufts: the thin spikes of that same region -------------------
   * A morphological opening keeps whatever survives being eroded and regrown.
   * The helmet is a solid mass and survives; the spikes are narrower than the
   * brush and vanish. Their width is the only thing that separates them, and
   * it is the thing that actually distinguishes them in the drawing.
   */
  const headSpan = spanOf(headMask, w, h);
  const tuftMask = new Uint8Array(n);
  {
    const radius = Math.max(4, Math.round(Math.max(headSpan.w, headSpan.h) * 0.085));
    const shell = opened(headMask, w, h, radius);
    for (let i = 0; i < n; i++) if (headMask[i] && !shell[i]) tuftMask[i] = 1;
    // Only spikes off the *back* of the hood are hair. Anything the opening
    // shaved off the front is a chin or a jaw edge and belongs to the shell.
    dropSmall(tuftMask, w, h, 200);
  }

  /* --- eyes: the bright shards on the visor ------------------------------
   * Taking every bright pixel inside the marker rectangle clips the shard
   * wherever it reaches past the box, and leaves the rest of it in the head
   * layer. That residue is why a shut eye kept a pale ghost: the head was
   * still carrying a piece of the shard behind the lid.
   *
   * So the rectangle only says roughly where to look. The shard itself is
   * whatever is connected to the brightest pixel in there and still reads as
   * bright — its own shape decides its extent.
   */
  const eyeMask = new Uint8Array(n);
  for (const key of ['eyeL', 'eyeR']) {
    const r = m[key];
    const x0 = Math.max(0, Math.floor(r[0] * w));
    const y0 = Math.max(0, Math.floor(r[1] * h));
    const x1 = Math.min(w - 1, Math.ceil(r[2] * w));
    const y1 = Math.min(h - 1, Math.ceil(r[3] * h));

    let seed = -1;
    let best = -1;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        if (!opaque(i)) continue;
        const { lum } = hsl(i);
        if (lum > best) { best = lum; seed = i; }
      }
    }
    if (seed < 0 || best < 0.6) continue;

    // Stay near the marker: a shard is a small feature, and an unbounded
    // flood through anything bright could walk off across a highlight.
    const reach = Math.max(x1 - x0, y1 - y0) * 1.6;
    const BRIGHT = 0.58;
    let head = 0, tail = 0;
    eyeMask[seed] = 1;
    scratch[tail++] = seed;
    while (head < tail) {
      const i = scratch[head++];
      const x = i % w;
      const y = (i - x) / w;
      const go = (j) => {
        if (eyeMask[j] || !opaque(j)) return;
        const jx = j % w;
        const jy = (j - jx) / w;
        if (Math.abs(jx - (x0 + x1) / 2) > reach || Math.abs(jy - (y0 + y1) / 2) > reach) return;
        if (hsl(j).lum < BRIGHT) return;
        eyeMask[j] = 1;
        scratch[tail++] = j;
      };
      if (x > 0) go(i - 1);
      if (x < w - 1) go(i + 1);
      if (y > 0) go(i - w);
      if (y < h - 1) go(i + w);
    }
  }

  // Keep the shards as they are before the ring joins them.
  //
  // Growing through ink merges both eyes into one blob, and the lid needs each
  // eye separately — measured from this copy, then padded to cover the ring.
  const shardMask = eyeMask.slice();

  // Hand the shard's ink outline to the eye as well, not just the shard.
  //
  // Left to the general rule, that ring gets split down the middle: the inner
  // half joins the eye, the outer half stays with the head. Two things go
  // wrong. A shut eye keeps the outer half as a dark rim, and the hole left in
  // the head is bounded by black — so the fill relaxes toward black and the
  // socket reads as a dark hollow instead of a visor.
  //
  // The outline is part of the slit, so it goes with the slit. Growing only
  // through ink stops at the first visor pixel on its own.
  {
    const OUTLINE_LUM = 0.25;
    const RING = ringWidth(w, h);
    let head = 0, tail = 0;
    const step = new Int16Array(n).fill(-1);
    for (let i = 0; i < n; i++) if (eyeMask[i]) { step[i] = 0; scratch[tail++] = i; }
    while (head < tail) {
      const i = scratch[head++];
      if (step[i] >= RING) continue;
      const x = i % w;
      const y = (i - x) / w;
      const go = (j) => {
        if (step[j] >= 0 || !opaque(j) || eyeMask[j]) return;
        if (hsl(j).lum >= OUTLINE_LUM) return; // reached the visor: stop
        step[j] = step[i] + 1;
        eyeMask[j] = 1;
        scratch[tail++] = j;
      };
      if (x > 0) go(i - 1);
      if (x < w - 1) go(i + 1);
      if (y > 0) go(i - w);
      if (y < h - 1) go(i + w);
    }
  }

  // Close any gaps the brightness test punched through the shard.
  //
  // The shard is not uniformly bright — it carries grey shading — so a flood
  // through bright pixels leaves those darker patches behind as islands of
  // head art marooned inside the eye. They scallop the cut edge, and they drag
  // the fill behind the eye toward their own colour. Anything enclosed by the
  // shard is the shard, whatever shade it happens to be.
  fillEnclosed(eyeMask, w, h);

  if (sockets) {
    const found = socketsFor(shardMask, m, w, h, ringWidth(w, h) + 2);
    if (found) sockets.push(...found);
  }

  /* --- everything below the neck, as connected pieces --------------------
   * Cloth and non-cloth are kept apart so a glove resting against a sleeve
   * stays its own piece. The largest cloth piece is the scarf; every other one
   * is a glove, and whatever a glove touches is an arm.
   */
  const pieces = components(opaque, cloth, headMask, w, h, scratch);
  const clothPieces = pieces.filter((p) => p.cloth && p.px >= MIN_AREA);
  const solidPieces = pieces.filter((p) => !p.cloth && p.px >= MIN_AREA);
  clothPieces.sort((a, b) => b.px - a.px);

  const scarf = clothPieces[0] ?? null;

  // A glove has to be a real piece of the drawing, not an artefact. Cel art
  // leaves thin anti-aliased slivers along every ink edge, and a few hundred
  // of those pixels can form their own component — one did, and it stole the
  // sleeve from the actual glove. A hand is a meaningful fraction of a head,
  // so that is the yardstick: measured here the real gloves are 9.4% and 4.6%
  // of the head's area, and the sliver that caused the trouble was 1.0%.
  let headArea = 0;
  for (let i = 0; i < n; i++) if (headMask[i]) headArea++;
  const GLOVE_MIN = Math.max(MIN_AREA, headArea * 0.03);
  const gloves = clothPieces.slice(1).filter((p) => p.px >= GLOVE_MIN);

  /* An arm is a glove plus whatever solid piece it is joined to across the ink
   * outline between them. Everything else solid is body.
   *
   * Two gloves can reach the same sleeve — the far hand crossing near the near
   * arm, say. They then belong to one arm, so a second claim joins the first
   * rather than replacing it; overwriting left the original glove stranded as
   * an arm of its own.
   */
  const REACH = Math.max(6, Math.round(headSpan.w * 0.06));
  const armOf = new Map(); // piece id -> arm index
  const arms = [];
  const join = (piece, index) => {
    armOf.set(piece.id, index);
    const arm = arms[index];
    arm.px += piece.px;
    arm.sx += piece.cx * piece.px;
    arm.sy += piece.cy * piece.px;
    arm.cx = arm.sx / arm.px;
    arm.cy = arm.sy / arm.px;
  };
  for (const glove of gloves) {
    const limb = nearestPiece(glove, solidPieces, REACH);
    const claimed = limb ? armOf.get(limb.id) : undefined;
    if (claimed !== undefined) { join(glove, claimed); continue; }
    const index = arms.length;
    arms.push({ px: 0, sx: 0, sy: 0, cx: 0, cy: 0 });
    join(glove, index);
    if (limb) join(limb, index);
  }

  // Left and right are decided by which side of the figure the arm sits on,
  // measured against the neck. With one arm that still works; with none the
  // labels simply go unused.
  const nxU = m.pivotX;
  const order = arms.map((a, i) => i).sort((a, b) => arms[a].cx - arms[b].cx);
  const sideOf = new Map();
  if (order.length === 1) {
    sideOf.set(order[0], arms[order[0]].cx < nxU ? LABEL.armLeft : LABEL.armRight);
  } else {
    order.forEach((armIndex, rank) => {
      sideOf.set(armIndex, rank === 0 ? LABEL.armLeft : LABEL.armRight);
    });
    // More than two blobs claimed to be arms: fold the extras into the body.
    for (let k = 2; k < order.length; k++) sideOf.delete(order[k]);
  }

  const pieceLabel = new Int32Array(pieces.length).fill(LABEL.body);
  for (const p of pieces) {
    if (p.px < MIN_AREA) { pieceLabel[p.id] = LABEL.none; continue; }
    const armIndex = armOf.get(p.id);
    if (armIndex !== undefined && sideOf.has(armIndex)) {
      pieceLabel[p.id] = sideOf.get(armIndex);
    } else if (p.cloth) {
      pieceLabel[p.id] = LABEL.tails; // the scarf, and any stray cloth
    } else {
      pieceLabel[p.id] = LABEL.body;
    }
  }
  if (scarf) pieceLabel[scarf.id] = LABEL.tails;

  /* --- pass 1: label only what we are sure about -------------------------
   * The line art is the hard part. Those strokes are near-black with no
   * saturation, so they fail every colour test and would all fall through to
   * whichever label is last — which is how "body" once ended up as a
   * frame-wide smear containing the outlines drawn around the scarf. So
   * outlines are left unlabelled here and handed to their owner in pass 2.
   */
  const OUTLINE_LUM = 0.25;
  const pieceOf = pieces.pieceOf;

  for (let i = 0; i < n; i++) {
    if (!opaque(i)) continue;

    if (eyeMask[i]) { out[i] = LABEL.eyes; continue; }
    if (hsl(i).lum < OUTLINE_LUM) continue; // line art: decided in pass 2

    if (headMask[i]) {
      out[i] = tuftMask[i] ? LABEL.tufts : LABEL.head;
      continue;
    }

    const piece = pieceOf[i];
    if (piece < 0) continue;
    const label = pieceLabel[piece];
    if (label === LABEL.none) continue;

    // The scarf splits in two: what hugs the neck rides with the head, and the
    // rest hangs free on the chain. Now that the head's extent is measured
    // rather than guessed, its own radius is the right yardstick.
    if (label === LABEL.tails) {
      const x = i % w;
      const y = (i - x) / w;
      const reach = Math.hypot((x - headSpan.cx) / aspect, y - headSpan.cy);
      out[i] = reach < headSpan.r * 1.15 ? LABEL.wrap : LABEL.tails;
      continue;
    }
    out[i] = label;
  }

  /* --- between passes: drop specks ---------------------------------------
   * A few stray pixels can land on the wrong label — a highlight the colour of
   * the scarf, say — and once dilated they read as debris floating beside the
   * character. Unlabelling anything too small to be a real piece lets pass 2
   * hand it to whichever neighbour actually surrounds it.
   *
   * Deliberately tiny. A speck is a handful of pixels; anything larger is real
   * art, and unlabelling it shifts which part owns those pixels — which
   * changes which dilated margins cover them and quietly corrupts the rest
   * pose. Measured: a threshold of 139px took reassembly from 0.03% to 6.3%.
   */
  dropSmallByLabel(out, w, h, MIN_AREA);

  /* --- pass 2: grow each part into the line art bounding it --------------
   * Multi-source flood: every labelled pixel seeds at distance zero, and the
   * nearest label claims each unlabelled stroke. An outline therefore goes to
   * the shape it was drawn around.
   */
  {
    const queue = scratch;
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

/** How far the eye's ink outline is grown into, in pixels. */
function ringWidth(w, h) {
  return Math.max(3, Math.round(Math.max(w, h) * 0.012));
}

/** Smallest piece worth keeping, in pixels. See the note in labelPixels. */
const MIN_AREA = 48;

/** Bounding box, centre and radius of a mask, in pixels. */
function spanOf(mask, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x1 < 0) return { x0: 0, y0: 0, x1: 0, y1: 0, w: 0, h: 0, cx: 0, cy: 0, r: 1 };
  return {
    x0, y0, x1, y1,
    w: x1 - x0 + 1, h: y1 - y0 + 1,
    cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
    r: Math.max(x1 - x0, y1 - y0) / 2,
  };
}

/**
 * Morphological opening: erode, then dilate by the same radius. Whatever is
 * narrower than the brush does not survive.
 *
 * Both steps use a chamfer distance rather than N passes of a 3x3 kernel, so
 * the cost does not grow with the radius.
 */
function opened(mask, w, h, radius) {
  const inside = distanceInside(mask, w, h);
  const core = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (inside[i] > radius) core[i] = 1;
  const outward = distanceInside(core, w, h, true);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (mask[i] && outward[i] <= radius) out[i] = 1;
  return out;
}

/**
 * Two-pass chamfer distance transform. `invert` measures distance *to* the
 * mask instead of inside it, which is what the dilate half of an opening needs.
 */
function distanceInside(mask, w, h, invert = false) {
  const n = w * h;
  const BIG = 1e9;
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) dist[i] = (invert ? mask[i] : !mask[i]) ? 0 : BIG;

  const D1 = 1, D2 = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = dist[i];
      if (y > 0) {
        if (x > 0) v = Math.min(v, dist[i - w - 1] + D2);
        v = Math.min(v, dist[i - w] + D1);
        if (x < w - 1) v = Math.min(v, dist[i - w + 1] + D2);
      }
      if (x > 0) v = Math.min(v, dist[i - 1] + D1);
      dist[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = dist[i];
      if (y < h - 1) {
        if (x < w - 1) v = Math.min(v, dist[i + w + 1] + D2);
        v = Math.min(v, dist[i + w] + D1);
        if (x > 0) v = Math.min(v, dist[i + w - 1] + D2);
      }
      if (x < w - 1) v = Math.min(v, dist[i + 1] + D1);
      dist[i] = v;
    }
  }
  return dist;
}

/**
 * Connected pieces of the opaque region below the neck, keeping cloth and
 * non-cloth apart so a glove touching a sleeve stays its own piece.
 */
function components(opaque, cloth, exclude, w, h, scratch) {
  const n = w * h;
  const pieceOf = new Int32Array(n).fill(-1);
  const list = [];
  for (let start = 0; start < n; start++) {
    if (pieceOf[start] >= 0 || !opaque(start) || exclude[start]) continue;
    const id = list.length;
    const isCloth = cloth[start] === 1;
    let head = 0, tail = 0;
    pieceOf[start] = id;
    scratch[tail++] = start;
    let px = 0, sx = 0, sy = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
    while (head < tail) {
      const i = scratch[head++];
      const x = i % w;
      const y = (i - x) / w;
      px++; sx += x; sy += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      const go = (j) => {
        if (pieceOf[j] >= 0 || !opaque(j) || exclude[j]) return;
        if ((cloth[j] === 1) !== isCloth) return;
        pieceOf[j] = id;
        scratch[tail++] = j;
      };
      if (x > 0) go(i - 1);
      if (x < w - 1) go(i + 1);
      if (y > 0) go(i - w);
      if (y < h - 1) go(i + w);
    }
    list.push({ id, cloth: isCloth, px, cx: sx / px / w, cy: sy / px / h, x0, y0, x1, y1 });
  }
  list.pieceOf = pieceOf;
  return list;
}

/** The piece whose bounding box comes within `reach` pixels of this one. */
function nearestPiece(from, candidates, reach) {
  let best = null;
  let bestGap = Infinity;
  for (const p of candidates) {
    const gapX = Math.max(0, Math.max(from.x0 - p.x1, p.x0 - from.x1));
    const gapY = Math.max(0, Math.max(from.y0 - p.y1, p.y0 - from.y1));
    const gap = Math.hypot(gapX, gapY);
    if (gap <= reach && gap < bestGap) { bestGap = gap; best = p; }
  }
  return best;
}

/**
 * Fill anything the mask fully encloses.
 *
 * Found by flooding the *outside*: start from the border, and any gap the
 * flood cannot reach is surrounded, so it belongs to the mask.
 */
function fillEnclosed(mask, w, h) {
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
  for (let i = 0; i < n; i++) if (!outside[i]) mask[i] = 1;
}

/** Clear connected runs of a binary mask smaller than `min` pixels. */
function dropSmall(mask, w, h, min) {
  const n = w * h;
  const seen = new Uint8Array(n);
  const stack = [];
  const region = [];
  for (let start = 0; start < n; start++) {
    if (seen[start] || !mask[start]) continue;
    region.length = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop();
      region.push(i);
      const x = i % w;
      const y = (i - x) / w;
      const visit = (j) => { if (!seen[j] && mask[j]) { seen[j] = 1; stack.push(j); } };
      if (x > 0) visit(i - 1);
      if (x < w - 1) visit(i + 1);
      if (y > 0) visit(i - w);
      if (y < h - 1) visit(i + w);
    }
    if (region.length < min) for (const i of region) mask[i] = 0;
  }
}

/** As dropSmall, but over a label map: unlabel runs too small to be real art. */
function dropSmallByLabel(out, w, h, min) {
  const n = w * h;
  const seen = new Uint8Array(n);
  const stack = [];
  const region = [];
  for (let start = 0; start < n; start++) {
    if (seen[start] || out[start] === LABEL.none) continue;
    const id = out[start];
    region.length = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop();
      region.push(i);
      const x = i % w;
      const y = (i - x) / w;
      const visit = (j) => { if (!seen[j] && out[j] === id) { seen[j] = 1; stack.push(j); } };
      if (x > 0) visit(i - 1);
      if (x < w - 1) visit(i + 1);
      if (y > 0) visit(i - w);
      if (y < h - 1) visit(i + w);
    }
    if (region.length < min) for (const i of region) out[i] = LABEL.none;
  }
}

/**
 * Where a part turns.
 *
 * An arm turns at the shoulder, and the shoulder is the end of the arm nearest
 * the neck. The joint itself is under the scarf and was never drawn, so the
 * pivot is pushed a little further that way — rotating about the visible end
 * of a sleeve makes the arm pull out of its socket.
 *
 * Everything else turns at its own joint in the hierarchy and needs no pivot.
 */
function pivotFor(name, labels, m, w, h) {
  if (name !== 'armLeft' && name !== 'armRight') return null;
  const id = LABEL[name];
  const nx = m.pivotX * w;
  const ny = m.pivotY * h;

  let bestX = 0, bestY = 0, best = Infinity;
  for (let i = 0; i < w * h; i++) {
    if (labels[i] !== id) continue;
    const x = i % w;
    const y = (i - x) / w;
    const d = (x - nx) * (x - nx) + (y - ny) * (y - ny);
    if (d < best) { best = d; bestX = x; bestY = y; }
  }
  if (best === Infinity) return null;

  const INTO_BODY = 0.15; // fraction of the way to the neck
  return [
    (bestX + (nx - bestX) * INTO_BODY) / w,
    (bestY + (ny - bestY) * INTO_BODY) / h,
  ];
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

      // Average every neighbour already filled, rather than copying the one
      // pixel we happened to arrive from. Copying draws streaks: a hole
      // surrounded by alternating ink and surface pulls both inward in
      // stripes, which is exactly what the eye socket looked like behind the
      // eye layer. Averaging diffuses the surrounding colour into the hole
      // instead, and only ever touches invented pixels — real art is at
      // distance 0 and never revisited.
      let sr = 0, sg = 0, sb = 0, n = 0;
      const tally = (k) => {
        if (dist[k] < 0 || dist[k] >= step) return;
        sr += od[k * 4]; sg += od[k * 4 + 1]; sb += od[k * 4 + 2]; n++;
      };
      const left = jx > 0, right = jx < pw - 1, up = jy > 0, down = jy < ph - 1;
      if (left) tally(j - 1);
      if (right) tally(j + 1);
      if (up) tally(j - pw);
      if (down) tally(j + pw);
      if (up && left) tally(j - pw - 1);
      if (up && right) tally(j - pw + 1);
      if (down && left) tally(j + pw - 1);
      if (down && right) tally(j + pw + 1);

      const a = j * 4;
      if (n > 0) {
        od[a] = sr / n; od[a + 1] = sg / n; od[a + 2] = sb / n;
      } else {
        const b = i * 4;
        od[a] = od[b]; od[a + 1] = od[b + 1]; od[a + 2] = od[b + 2];
      }
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

  /* Repaint holes the part fully encloses.
   *
   * The eye is cut out of the head, so the head is left with a hole where the
   * slit used to be. Whatever fills it is what shows when the eye closes, and
   * getting it wrong is what made a shut eye look like a smudge: the flood's
   * nearest-pixel copy drew streaks out of the ink around the socket, and
   * diffusing instead only converges after roughly width-squared sweeps, which
   * is slow and still left the hole a shade off.
   *
   * But the surface being reconstructed is a visor: a smooth ramp of one
   * colour, not arbitrary texture. Fitting that ramp is both exact and cheap.
   * A least-squares plane through the real pixels ringing the hole extends the
   * gradient across it seamlessly, with no mottling and no edge to see.
   *
   * Only enclosed holes get this. The outer margins exist to sit under other
   * parts and are never looked at directly, so the flood's colours are fine
   * there — and a plane fitted to a part's whole silhouette would be wrong.
   */
  fillEnclosedHoles(od, dist, pw, ph);

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

/**
 * Repaint each hole a part encloses with a plane fitted to its surroundings.
 *
 * `dist` marks real art as 0 and invented margin as > 0. A hole is invented
 * pixels that cannot reach the edge of the part's box without crossing real
 * art — which is exactly the case that gets revealed when the part in front
 * moves away.
 */
function fillEnclosedHoles(od, dist, pw, ph) {
  const n = pw * ph;
  const outer = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;

  // Flood the invented region inward from the border; whatever it misses is
  // enclosed.
  const seed = (i) => {
    if (outer[i] || dist[i] === 0) return; // real art blocks the flood
    outer[i] = 1;
    queue[tail++] = i;
  };
  for (let x = 0; x < pw; x++) { seed(x); seed((ph - 1) * pw + x); }
  for (let y = 0; y < ph; y++) { seed(y * pw); seed(y * pw + pw - 1); }
  while (head < tail) {
    const i = queue[head++];
    const x = i % pw;
    const y = (i - x) / pw;
    if (x > 0) seed(i - 1);
    if (x < pw - 1) seed(i + 1);
    if (y > 0) seed(i - pw);
    if (y < ph - 1) seed(i + pw);
  }

  const seen = new Uint8Array(n);
  const group = [];
  for (let start = 0; start < n; start++) {
    if (seen[start] || outer[start] || dist[start] <= 0) continue;

    // One enclosed hole, plus the real pixels ringing it.
    group.length = 0;
    const ring = [];
    seen[start] = 1;
    head = tail = 0;
    queue[tail++] = start;
    while (head < tail) {
      const i = queue[head++];
      group.push(i);
      const x = i % pw;
      const y = (i - x) / pw;
      const visit = (j) => {
        if (dist[j] === 0) { ring.push(j); return; } // boundary sample
        if (seen[j] || outer[j] || dist[j] < 0) return;
        seen[j] = 1;
        queue[tail++] = j;
      };
      if (x > 0) visit(i - 1);
      if (x < pw - 1) visit(i + 1);
      if (y > 0) visit(i - pw);
      if (y < ph - 1) visit(i + pw);
    }
    if (group.length < 12 || ring.length < 8) continue;

    // Fit, then throw out the samples the fit disagrees with most and fit
    // again. The ring around a cut-out slit is not purely surface: a few
    // pixels of its ink outline, or a sliver of the slit itself, survive on
    // this side of the cut. Left in, they drag the fit light or dark and leave
    // a visible rim. One robust pass is enough to shake them off.
    const inliers = robustRing(ring, od, pw);

    // Quadratic, not a plane. The visor is a curved surface with a highlight
    // rolling across it, so its shading is not a straight ramp — a plane
    // matches the average and misses the curvature, which shows as a patch
    // slightly too flat against everything around it. Six terms follow the
    // roll closely enough that the shut eye reads as visor.
    let cx = 0, cy = 0;
    for (const i of inliers) { const x = i % pw; cx += x; cy += (i - x) / pw; }
    cx /= inliers.length;
    cy /= inliers.length;
    const basis = (x, y) => {
      const u = (x - cx) / 32;
      const v = (y - cy) / 32;
      return [1, u, v, u * u, u * v, v * v];
    };

    for (let ch = 0; ch < 3; ch++) {
      const coef = fitBasis(inliers, pw, basis, (i) => od[i * 4 + ch]);
      for (const i of group) {
        const x = i % pw;
        const y = (i - x) / pw;
        const b = basis(x, y);
        let v = 0;
        for (let k = 0; k < b.length; k++) v += coef[k] * b[k];
        od[i * 4 + ch] = clamp(v, 0, 255);
      }
    }
    for (const i of group) od[i * 4 + 3] = 255;
  }
}

/**
 * Least-squares plane v = a + b*x + c*y through one channel of the sampled
 * pixels. Falls back to their mean when the samples are collinear, which no
 * plane can be fitted through.
 */
function fitPlane(samples, od, pw, channel) {
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, sv = 0, sxv = 0, syv = 0;
  for (const i of samples) {
    const x = i % pw;
    const y = (i - x) / pw;
    const v = od[i * 4 + channel];
    n++; sx += x; sy += y;
    sxx += x * x; sxy += x * y; syy += y * y;
    sv += v; sxv += x * v; syv += y * v;
  }
  const m = [n, sx, sy, sx, sxx, sxy, sy, sxy, syy];
  const det =
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6]);
  if (Math.abs(det) < 1e-6) return { a: sv / Math.max(n, 1), b: 0, c: 0 };

  const solve = (r0, r1, r2) => {
    const k = [...m];
    k[0] = r0; k[3] = r1; k[6] = r2;
    return k[0] * (k[4] * k[8] - k[5] * k[7]) -
           k[1] * (k[3] * k[8] - k[5] * k[6]) +
           k[2] * (k[3] * k[7] - k[4] * k[6]);
  };
  const solveCol = (col) => {
    const k = [...m];
    k[col] = sv; k[col + 3] = sxv; k[col + 6] = syv;
    return (k[0] * (k[4] * k[8] - k[5] * k[7]) -
            k[1] * (k[3] * k[8] - k[5] * k[6]) +
            k[2] * (k[3] * k[7] - k[4] * k[6])) / det;
  };
  void solve;
  return { a: solveCol(0), b: solveCol(1), c: solveCol(2) };
}

/**
 * Drop the boundary samples that sit furthest from a first pass through them,
 * measured on luminance. Keeps at least half, so a genuinely varied edge is
 * still fitted rather than whittled down to a single tone.
 */
function robustRing(ring, od, pw) {
  if (ring.length < 16) return ring;
  const lum = (i) =>
    0.2126 * od[i * 4] + 0.7152 * od[i * 4 + 1] + 0.0722 * od[i * 4 + 2];

  const plane = fitPlaneOf(ring, pw, lum);
  const scored = ring.map((i) => {
    const x = i % pw;
    const y = (i - x) / pw;
    return { i, err: Math.abs(lum(i) - (plane.a + plane.b * x + plane.c * y)) };
  });
  scored.sort((p, q) => p.err - q.err);

  // Median absolute residual sets the scale; anything several times that is an
  // outline pixel or a leftover of the part that was cut away.
  const median = scored[scored.length >> 1].err;
  const limit = Math.max(6, median * 2.5);
  const kept = scored.filter((p) => p.err <= limit).map((p) => p.i);
  return kept.length >= ring.length / 2 ? kept
    : scored.slice(0, Math.max(8, ring.length >> 1)).map((p) => p.i);
}

/** fitPlane over an arbitrary value function, for the robust pass. */
function fitPlaneOf(samples, pw, value) {
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, sv = 0, sxv = 0, syv = 0;
  for (const i of samples) {
    const x = i % pw;
    const y = (i - x) / pw;
    const v = value(i);
    n++; sx += x; sy += y;
    sxx += x * x; sxy += x * y; syy += y * y;
    sv += v; sxv += x * v; syv += y * v;
  }
  const m = [n, sx, sy, sx, sxx, sxy, sy, sxy, syy];
  const det =
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6]);
  if (Math.abs(det) < 1e-6) return { a: sv / Math.max(n, 1), b: 0, c: 0 };
  const col = (c) => {
    const k = [...m];
    k[c] = sv; k[c + 3] = sxv; k[c + 6] = syv;
    return (k[0] * (k[4] * k[8] - k[5] * k[7]) -
            k[1] * (k[3] * k[8] - k[5] * k[6]) +
            k[2] * (k[3] * k[7] - k[4] * k[6])) / det;
  };
  return { a: col(0), b: col(1), c: col(2) };
}

/**
 * The true extent of each eye, measured from the pixels that were actually
 * cut out rather than from the marker rectangle.
 *
 * The lid closes across a box, and sizing that box from the marker leaves
 * whatever the shard reaches past it permanently uncovered — a sliver of open
 * eye at full blink, which is exactly what a shut eye must not have. The
 * marker is a hint about where to look; the shard's own pixels are the answer.
 *
 * Measured in the lid's own rotated frame, because that is the frame the
 * shader tests in. An axis-aligned box around a slanted shard is far larger
 * than the shard, and a lid sized to it would sweep across half the visor.
 *
 * @returns {Array<{cx,cy,hx,hy}>|null} left then right, in image UV
 */
function socketsFor(shardMask, m, w, h, pad) {
  const angle = m.eyeAngle || 0;

  // Split the eye pixels into their connected shards, biggest two win.
  const seen = new Uint8Array(w * h);
  const stack = [];
  const shards = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || !shardMask[start]) continue;
    const pixels = [];
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop();
      pixels.push(i);
      const x = i % w;
      const y = (i - x) / w;
      const visit = (j) => { if (!seen[j] && shardMask[j]) { seen[j] = 1; stack.push(j); } };
      if (x > 0) visit(i - 1);
      if (x < w - 1) visit(i + 1);
      if (y > 0) visit(i - w);
      if (y < h - 1) visit(i + w);
    }
    if (pixels.length >= MIN_AREA) shards.push(pixels);
  }
  if (!shards.length) return null;
  shards.sort((a, b) => b.length - a.length);

  // This visor is one continuous slit, not two eyes. The marker pass reports
  // two because it splits a single bright blob down its principal axis, and
  // sizing the lids to those halves leaves the ends of the slit permanently
  // open. One shard means one lid shape, used for both channels: with blinks
  // linked, which they are by default, it shuts as one piece.
  const pair = shards.length >= 2 ? shards.slice(0, 2) : [shards[0], shards[0]];

  const boxes = pair.map((pixels) => {
    let sx = 0, sy = 0;
    for (const i of pixels) { const x = i % w; sx += x; sy += (i - x) / w; }
    const cx = sx / pixels.length;
    const cy = sy / pixels.length;

    // Extent along the lid's own axes.
    const c = Math.cos(-angle);
    const sn = Math.sin(-angle);
    let hx = 0, hy = 0;
    for (const i of pixels) {
      const x = i % w;
      const y = (i - x) / w;
      const dx = x - cx;
      const dy = y - cy;
      hx = Math.max(hx, Math.abs(dx * c - dy * sn));
      hy = Math.max(hy, Math.abs(dx * sn + dy * c));
    }
    // Pad out to cover the ink ring that was handed to the eye with it, plus
    // a shade more so the sweep clears the anti-aliased edge.
    return { cx: cx / w, cy: cy / h, hx: (hx + pad) / w, hy: (hy + pad) / h };
  });

  boxes.sort((a, b) => a.cx - b.cx);
  return boxes;
}

/**
 * Least squares over an arbitrary basis, solved by Gaussian elimination with
 * partial pivoting.
 *
 * Falls back to progressively simpler fits when the samples cannot support the
 * full basis — a hole ringed by a thin arc has no information about curvature,
 * and forcing six terms through it produces wild extrapolation inside the gap.
 */
function fitBasis(samples, pw, basis, value) {
  const probe = basis(0, 0);
  const n = probe.length;
  if (samples.length < n * 3) {
    const mean = samples.reduce((sum, i) => sum + value(i), 0) / Math.max(samples.length, 1);
    return [mean, ...new Array(n - 1).fill(0)];
  }

  // Normal equations: (B^T B) c = B^T v
  const A = Array.from({ length: n }, () => new Float64Array(n + 1));
  for (const i of samples) {
    const x = i % pw;
    const y = (i - x) / pw;
    const b = basis(x, y);
    const v = value(i);
    for (let r = 0; r < n; r++) {
      for (let k = 0; k < n; k++) A[r][k] += b[r] * b[k];
      A[r][n] += b[r] * v;
    }
  }

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    if (Math.abs(A[pivot][col]) < 1e-9) {
      // Rank-deficient: drop to the terms already solved and zero the rest.
      const out = new Array(n).fill(0);
      const mean = samples.reduce((sum, i) => sum + value(i), 0) / samples.length;
      out[0] = mean;
      return out;
    }
    [A[col], A[pivot]] = [A[pivot], A[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let k = col; k <= n; k++) A[r][k] -= f * A[col][k];
    }
  }
  const out = new Array(n);
  for (let r = 0; r < n; r++) out[r] = A[r][n] / A[r][r];
  return out;
}
