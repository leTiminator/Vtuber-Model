/**
 * The parts of putting a model on a page that both pages need.
 *
 * There are two: the one you sit in front of, and the one OBS opens. The
 * second has no camera, no controls and no tracking model — but it has to size
 * its canvas and paint its background exactly as the first one does, or the
 * shot you framed is not the shot that goes out.
 *
 * So those live here rather than in either page, and cannot drift apart.
 */
import * as store from './store.js';

/* How many pixels the model is allowed to be drawn into.
 *
 * A phone reports a device pixel ratio of three or more, and taking it at its
 * word on a tall screen asks for a canvas of four and a half megapixels —
 * redrawn every frame, through sixteen blended passes, on a tiled mobile GPU,
 * sometimes inside an in-app browser with less memory to give than the real
 * one. What comes back when that runs short is missing tiles: rectangular
 * holes that sit still on the screen while the character slides past them,
 * which is exactly how it was described.
 *
 * Two ratios of supersampling is already past what the screen can show at
 * arm's length, so the cap costs nothing to look at and gives back most of
 * the fragment work.
 */
const MAX_RATIO = 2;
const MAX_PIXELS = 2.4e6;

export function renderScale(w, h) {
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_RATIO);
  const area = Math.max(w * h, 1);
  return Math.min(dpr, Math.sqrt(MAX_PIXELS / area));
}

/** Fit an avatar's canvas to the window it is in. */
export function fitToWindow(avatar) {
  if (!avatar) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  avatar.resize(w, h, renderScale(w, h));
}

/**
 * Paint the stage behind the model.
 *
 * Transparent is the one that matters: it is what a Browser Source composites
 * against your scene, and what makes keying unnecessary. The other two are for
 * capturing a window, which cannot carry transparency.
 */
export function applyBackground(stage) {
  const mode = store.get('stage.background');
  stage.style.background =
    mode === 'chroma' ? store.get('stage.chroma')
    : mode === 'color' ? store.get('stage.color')
    : 'transparent';
}
