/** The parts of putting a model on a page that both pages need. */
import * as store from './store.js';

/* How many pixels the model is allowed to be drawn into. */
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

/** Paint the stage behind the model. */
export function applyBackground(stage) {
  const mode = store.get('stage.background');
  stage.style.background =
    mode === 'chroma' ? store.get('stage.chroma')
    : mode === 'color' ? store.get('stage.color')
    : 'transparent';
}
