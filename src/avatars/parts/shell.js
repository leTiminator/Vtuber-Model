/**
 * Depth for a flat drawing, so the head can be turned rather than smeared.
 *
 * The cylinder this replaces maps x onto a fixed-radius arc. It slides pixels
 * sideways inside an outline that never changes, which is why a turn reads as
 * the face sliding across the helmet rather than the helmet turning: a real
 * head's silhouette changes shape as it rotates, and a cylinder's cannot. It
 * also has no answer for yaw and pitch at once, because it applies them as two
 * independent bends on the same sheet.
 *
 * A drawing does not carry depth, but a silhouette implies one. Inflating a
 * shape by its distance from its own outline — flat at the edge, deepest in
 * the middle — is the oldest trick there is for this, and for a hood it is
 * close to true: it is a rounded object, and the drawing shows its outline.
 * With a depth per point the turn becomes an actual rotation, and the outline
 * turns with it.
 *
 * What this cannot invent is the far side, or move the painted highlights off
 * the surface they were painted on. Those need another drawing.
 */

/**
 * Chamfer distance to the nearest transparent pixel, in pixels.
 *
 * Two passes of a 3-4 approximation: exact enough for a depth field that is
 * about to be smoothed by a curve anyway, and linear in the number of pixels
 * rather than the quadratic an exact transform would cost.
 */
function distanceInside(mask, w, h) {
  const BIG = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? BIG : 0;

  const near = 3;
  const diag = 4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let best = d[i];
      if (y > 0) {
        if (x > 0) best = Math.min(best, d[i - w - 1] + diag);
        best = Math.min(best, d[i - w] + near);
        if (x < w - 1) best = Math.min(best, d[i - w + 1] + diag);
      }
      if (x > 0) best = Math.min(best, d[i - 1] + near);
      d[i] = best;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let best = d[i];
      if (y < h - 1) {
        if (x < w - 1) best = Math.min(best, d[i + w + 1] + diag);
        best = Math.min(best, d[i + w] + near);
        if (x > 0) best = Math.min(best, d[i + w - 1] + diag);
      }
      if (x < w - 1) best = Math.min(best, d[i + 1] + near);
      d[i] = best;
    }
  }
  for (let i = 0; i < d.length; i++) d[i] /= near;
  return d;
}

/**
 * How steeply the shell rises from its outline.
 *
 * This is the number that decides whether the surface folds over itself. A
 * height field seen from an angle folds where its slope exceeds the cotangent
 * of that angle — at the rig's forty-two degree limit, about 1.1 — and a fold
 * is the far side of the surface drawing over the near side, which looks like
 * the model turning inside out. The profile below rises with slope `RISE` at
 * the edge in units of the shell's own depth, so keeping depth times RISE
 * under that limit keeps it single-valued through the whole range.
 */
const RISE = 1.8;

/**
 * A depth field over the whole artwork, from one part's silhouette.
 *
 * Deliberately one field rather than one per part: give each piece its own
 * dome and they meet at different depths, so the neck wrap swings on a
 * different sphere from the hood it is wrapped around and they come apart the
 * moment either turns. The head defines the shell; everything else reads its
 * depth from the same field, and anything outside the head sits flat at zero
 * and simply foreshortens.
 *
 * @param {{canvas: HTMLCanvasElement, x: number, y: number, w: number, h: number}} part
 * @param {number} width   artwork width in pixels
 * @param {number} height  artwork height
 * @returns {{data: Float32Array, width: number, height: number, radius: number} | null}
 */
export function shellFrom(part, width, height) {
  if (!part?.canvas) return null;
  const ctx = part.canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const src = ctx.getImageData(0, 0, part.w, part.h).data;

  // The solid art only. A part's margins are invented padding that exists to
  // sit under its neighbours, and inflating them would put the widest part of
  // the shell outside the drawing.
  const mask = new Uint8Array(part.w * part.h);
  let solid = 0;
  for (let i = 0, p = 0; i < src.length; i += 4, p++) {
    if (src[i + 3] > 200) { mask[p] = 1; solid++; }
  }
  if (solid < 64) return null;

  const dist = distanceInside(mask, part.w, part.h);
  let max = 0;
  for (let i = 0; i < dist.length; i++) if (dist[i] > max) max = dist[i];
  if (max <= 0) return null;

  /* Round, with a finite slope at the outline.
   *
   * A true hemisphere is the obvious profile and the wrong one: its slope at
   * the silhouette is vertical, which folds at any angle at all. `1-(1-t)^p`
   * is the same shape away from the edge and meets it at slope p.
   */
  const data = new Float32Array(width * height);
  for (let y = 0; y < part.h; y++) {
    const iy = part.y + y;
    if (iy < 0 || iy >= height) continue;
    for (let x = 0; x < part.w; x++) {
      const ix = part.x + x;
      if (ix < 0 || ix >= width) continue;
      const t = dist[y * part.w + x] / max;
      data[iy * width + ix] = t <= 0 ? 0 : 1 - (1 - t) ** RISE;
    }
  }

  return { data, width, height, radius: max, rise: RISE };
}

/** Read the field at a point in image space (0..1 across the artwork). */
export function depthAt(shell, px, py) {
  if (!shell) return 0;
  const x = Math.round(px * shell.width);
  const y = Math.round(py * shell.height);
  if (x < 0 || y < 0 || x >= shell.width || y >= shell.height) return 0;
  return shell.data[y * shell.width + x];
}
