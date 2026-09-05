/**
 * Finds the centreline running through a piece of cloth, so it can be driven by
 * bones instead of shoved around as a block.
 *
 * A displacement field can move a scarf but never change its shape. To contort,
 * the strip needs a skeleton: thin the mask to a one-pixel path, walk it from
 * the anchor to the far tip, and resample that walk into a chain of bones. Every
 * pixel then binds to the nearest bone and follows it.
 */
import { clamp } from '/src/core/math.js';

/**
 * Zhang-Suen thinning: repeatedly peel boundary pixels that can go without
 * breaking the shape's connectivity, until only a one-pixel skeleton is left.
 */
export function thin(mask, w, h) {
  const img = Uint8Array.from(mask);
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : img[y * w + x]);

  let changed = true;
  const doomed = [];
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      doomed.length = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (!img[y * w + x]) continue;
          // Eight neighbours, clockwise from north.
          const p = [
            at(x, y - 1), at(x + 1, y - 1), at(x + 1, y), at(x + 1, y + 1),
            at(x, y + 1), at(x - 1, y + 1), at(x - 1, y), at(x - 1, y - 1),
          ];
          const filled = p.reduce((a, b) => a + b, 0);
          if (filled < 2 || filled > 6) continue;
          // Number of 0->1 transitions going round; must be exactly one, or
          // removing this pixel would split the shape.
          let transitions = 0;
          for (let i = 0; i < 8; i++) if (!p[i] && p[(i + 1) % 8]) transitions++;
          if (transitions !== 1) continue;
          if (pass === 0) {
            if (p[0] * p[2] * p[4]) continue;
            if (p[2] * p[4] * p[6]) continue;
          } else {
            if (p[0] * p[2] * p[6]) continue;
            if (p[0] * p[4] * p[6]) continue;
          }
          doomed.push(y * w + x);
        }
      }
      for (const i of doomed) img[i] = 0;
      if (doomed.length) changed = true;
    }
  }
  return img;
}

/**
 * Walk the skeleton from the anchor and return the longest path through it.
 *
 * Cloth skeletons branch — a ribbon that crosses itself leaves spurs — so the
 * farthest reachable point is taken as the tip and the path traced back to the
 * anchor. Spurs are simply never on that path.
 *
 * @returns {{path: number[][], length: number}|null} path in pixel coords
 */
export function longestPath(skeleton, w, h, anchorX, anchorY) {
  const n = w * h;

  /* Follow the cloth, not whatever happens to be nearest the body.
   *
   * This used to seed from the skeleton pixel closest to the anchor and flood
   * from there, which cannot leave that pixel's connected component — and a
   * ribbon that crosses itself is not one component. On this drawing the
   * anchor sits under the visor and the nearest piece of scarf is the little
   * drape over the hip, fifty pixels away; the great sweeping arc that is
   * visually the entire scarf is two hundred away and was never reached. So
   * all sixteen bones landed on a bar a hundred and seventy pixels long in the
   * bottom corner, and nine tenths of the ribbon hung off its ends as one
   * rigid slab. It could not read as a chain because there was no chain in it.
   *
   * The piece with the most skeleton in it is the piece the cloth is made of.
   */
  const label = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const sizes = [];
  for (let seed = 0; seed < n; seed++) {
    if (!skeleton[seed] || label[seed] >= 0) continue;
    const id = sizes.length;
    let head = 0;
    let tail = 0;
    label[seed] = id;
    queue[tail++] = seed;
    let count = 0;
    while (head < tail) {
      const i = queue[head++];
      count++;
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (!skeleton[j] || label[j] >= 0) continue;
          label[j] = id;
          queue[tail++] = j;
        }
      }
    }
    sizes.push(count);
  }
  if (!sizes.length) return null;

  let pick = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[pick]) pick = i;

  /* The longest run through that piece, found the usual way: the point
   * furthest from anywhere, then the point furthest from that. Walking out
   * from a chosen start instead gives whatever path that start happens to sit
   * on, which for a skeleton with spurs is routinely not the ribbon.
   */
  const from = new Int32Array(n);
  const seen = new Uint8Array(n);
  const sweep = (source) => {
    from.fill(-1);
    seen.fill(0);
    let head = 0;
    let tail = 0;
    seen[source] = 1;
    queue[tail++] = source;
    let far = source;
    while (head < tail) {
      const i = queue[head++];
      far = i; // BFS order: the last one dequeued is the furthest
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (label[j] !== pick || seen[j]) continue;
          seen[j] = 1;
          from[j] = i;
          queue[tail++] = j;
        }
      }
    }
    return far;
  };

  let any = -1;
  for (let i = 0; i < n && any < 0; i++) if (label[i] === pick) any = i;
  if (any < 0) return null;
  const tip = sweep(any);
  const other = sweep(tip);

  const path = [];
  for (let i = other; i >= 0; i = from[i]) {
    const x = i % w;
    path.push([x, (i - x) / w]);
  }

  /* Anchor end first, because node zero is the one the chain pins.
   *
   * Which end that is depends on the drawing, so it is asked rather than
   * assumed: whichever end of the run is nearer the body leads.
   */
  const head0 = path[0];
  const tail0 = path[path.length - 1];
  const near = (p) => (p[0] - anchorX) ** 2 + (p[1] - anchorY) ** 2;
  if (near(tail0) < near(head0)) path.reverse();
  return { path, length: path.length };
}

/** Even-spaced samples along a path, so bones are equal length. */
export function resample(path, count) {
  if (path.length < 2) return null;
  let total = 0;
  const cumulative = [0];
  for (let i = 1; i < path.length; i++) {
    total += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    cumulative.push(total);
  }
  if (total <= 0) return null;

  const nodes = [];
  let cursor = 1;
  for (let k = 0; k < count; k++) {
    const target = (k / (count - 1)) * total;
    while (cursor < cumulative.length - 1 && cumulative[cursor] < target) cursor++;
    const t0 = cumulative[cursor - 1];
    const t1 = cumulative[cursor];
    const f = t1 > t0 ? (target - t0) / (t1 - t0) : 0;
    const a = path[cursor - 1];
    const b = path[cursor];
    nodes.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
  }
  return nodes;
}

/**
 * Everything at once: mask in, bone chain out, in image UV.
 *
 * @param {Uint8Array} mask   1 where the cloth is
 * @param {number} scale      how much the mask was downscaled from the artwork
 */
export function extractSpine(mask, w, h, anchor, count = 16) {
  const skeleton = thin(mask, w, h);
  const walk = longestPath(skeleton, w, h, anchor.x, anchor.y);
  if (!walk || walk.length < count) return null;
  const nodes = resample(walk.path, count);
  if (!nodes) return null;
  return {
    nodes: nodes.map(([x, y]) => [clamp(x / w, 0, 1), clamp(y / h, 0, 1)]),
    pixels: walk.length,
  };
}
