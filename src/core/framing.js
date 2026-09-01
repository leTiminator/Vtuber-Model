/**
 * Where the artwork sits in the output, and how big.
 *
 * Offsets are a fraction of the canvas's SHORTER side, not pixels. Pixels were
 * a bug: the same setting framed differently at different window sizes, so a
 * shot composed in a 1280-wide browser came out shifted when OBS rendered it at
 * 1920. A fraction is resolution-independent, and using the shorter side for
 * both axes means a nudge across feels the same size as a nudge down.
 *
 * One module because the renderers, the pointer handling and the fit presets
 * all have to agree; two copies of this maths would drift.
 */
import { clamp } from './math.js';

export const ZOOM_MIN = 0.15;
export const ZOOM_MAX = 6;

/**
 * @returns {{sx,sy,ox,oy:number}} scale and offset in 0..1 canvas space
 */
export function computeFrame(imageAspect, canvasW, canvasH, zoom, offX, offY) {
  const canvasAspect = canvasW / canvasH;
  let sx = zoom;
  let sy = zoom;
  // Fit the artwork inside the canvas before the user's zoom is applied, so
  // zoom 1 means "as large as it goes" whatever shape the window is.
  if (imageAspect > canvasAspect) sy = (zoom * canvasAspect) / imageAspect;
  else sx = (zoom * imageAspect) / canvasAspect;

  const minDim = Math.min(canvasW, canvasH);
  return {
    sx,
    sy,
    ox: (1 - sx) / 2 + (offX * minDim) / canvasW,
    oy: (1 - sy) / 2 + (offY * minDim) / canvasH,
  };
}

/** Inverse of the offset half: what offX/offY produce this ox/oy. */
export function offsetsFor(imageAspect, canvasW, canvasH, zoom, ox, oy) {
  const { sx, sy } = computeFrame(imageAspect, canvasW, canvasH, zoom, 0, 0);
  const minDim = Math.min(canvasW, canvasH);
  return {
    offX: ((ox - (1 - sx) / 2) * canvasW) / minDim,
    offY: ((oy - (1 - sy) / 2) * canvasH) / minDim,
  };
}

/** Artwork coordinates under a point on the canvas, both in 0..1. */
export function imagePointAt(frame, u, v) {
  return { x: (u - frame.ox) / (frame.sx || 1e-6), y: (v - frame.oy) / (frame.sy || 1e-6) };
}

/**
 * Zoom while keeping one point pinned under the cursor. Zooming about the
 * centre instead makes framing a fight — you chase the thing you are aiming at.
 */
export function zoomAbout(imageAspect, canvasW, canvasH, current, nextZoom, u, v) {
  const zoom = clamp(nextZoom, ZOOM_MIN, ZOOM_MAX);
  const before = computeFrame(imageAspect, canvasW, canvasH, current.zoom, current.offX, current.offY);
  const anchor = imagePointAt(before, u, v);
  const after = computeFrame(imageAspect, canvasW, canvasH, zoom, 0, 0);
  // Solve for the offset that puts the same artwork point back under the cursor.
  const { offX, offY } = offsetsFor(imageAspect, canvasW, canvasH, zoom,
    u - anchor.x * after.sx, v - anchor.y * after.sy);
  return { zoom, offX, offY };
}

/**
 * Framing that puts a given artwork rectangle in the middle of the canvas,
 * filling `fill` of the shorter side. Used by the fit presets.
 */
export function fitTo(imageAspect, canvasW, canvasH, box, fill = 0.9) {
  const boxW = Math.max(box.x1 - box.x0, 1e-4);
  const boxH = Math.max(box.y1 - box.y0, 1e-4);
  const base = computeFrame(imageAspect, canvasW, canvasH, 1, 0, 0);
  // How much zoom makes the box fill the canvas, on its tighter axis.
  const zoom = clamp(Math.min(fill / (boxW * base.sx), fill / (boxH * base.sy)), ZOOM_MIN, ZOOM_MAX);
  const scaled = computeFrame(imageAspect, canvasW, canvasH, zoom, 0, 0);
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  const { offX, offY } = offsetsFor(imageAspect, canvasW, canvasH, zoom,
    0.5 - cx * scaled.sx, 0.5 - cy * scaled.sy);
  return { zoom, offX, offY };
}
