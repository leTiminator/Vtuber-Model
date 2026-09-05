/** Flat, observable settings store with localStorage persistence. */
// Bumped when a saved value would misbehave under a new meaning. v4 saves only
// what differs from the defaults (see docs/DECISIONS.md).
const KEY = 'vtuber-model/settings/v4';

export const DEFAULTS = {
  // --- capture ---------------------------------------------------------
  'camera.deviceId': '',
  'camera.mirror': true,

  /* Crop the camera to your face before the tracker sees it. */
  'camera.faceZoom': 'auto',
  /* The calibrated rest pose, as JSON; empty means none. */
  'camera.neutral': '',

  // --- smoothing -------------------------------------------------------
  'smooth.minCutoff': 1.2, // Hz — lower is steadier, laggier
  'smooth.beta': 0.06, // speed coefficient — higher is snappier
  'smooth.expression': 2.4, // separate, faster cutoff for face shapes

  // --- head ------------------------------------------------------------
  'head.yawGain': 1.15,
  'head.pitchGain': 1.15,
  'head.rollGain': 1.25,
  'head.positionGain': 1.0,
  'head.limitDeg': 42,
  /* Tilt has a limit of its own, lower than the turn's. */
  'head.rollLimitDeg': 25,
  /* Which way a nod goes, as a preference on top of a convention that is now
   * fixed in code — see PITCH_SIGN in rig.js.
   */
  'head.flipNod': false,

  // --- eyes ------------------------------------------------------------
  'eyes.blinkGain': 1.35,
  'eyes.blinkThreshold': 0.42, // below this, the eye reads as fully open
  /* How much of the lid to blame on the gaze rather than on a blink. */
  'eyes.gazeLid': 0.6,
  'eyes.linkBlinks': true, // wink support off by default; most rigs look better linked
  'eyes.gazeGain': 1.0,
  'eyes.autoBlink': true, // fire natural blinks when tracking is idle/lost
  'eyes.browGain': 1.3,

  // --- mouth -----------------------------------------------------------
  'mouth.openGain': 1.5,
  'mouth.smileGain': 1.4,
  'mouth.wideGain': 1.2,
  'mouth.source': 'camera', // camera | mic | both
  'mouth.micGain': 1.8,
  'mouth.micGate': 0.012, // RMS below this counts as silence

  // --- arms -------------------------------------------------------------
  'arms.track': true, // a second model; costs roughly a third of a frame
  'arms.gain': 1.0,
  'arms.smooth': 1.0,

  // --- body / idle -----------------------------------------------------
  /* How much of the body's pose comes from your shoulders. */
  'body.shoulderGain': 1.0,
  'body.followGain': 0.55, // how much the torso trails the head
  'body.breathAmount': 1.0,
  'body.breathRate': 0.22, // Hz
  'body.swayAmount': 1.0,
  'body.hairPhysics': 1.0,

  // --- stage -----------------------------------------------------------
  'stage.background': 'transparent', // transparent | chroma | color
  'stage.chroma': '#00b140',
  'stage.color': '#101018',
  'stage.zoom': 0.86,
  // Fractions of the canvas's shorter side, so framing survives a resize and
  // matches between this window and OBS at any resolution.
  'stage.offsetX': 0,
  'stage.offsetY': 0,
  'stage.lockFraming': false,
  'stage.showPreview': true,

  // --- the parts model ------------------------------------------------
  'warp.eyesEnabled': true,
  // Depth between the layers: a soft dark shape laid behind each part so the
  // scarf reads as sitting in front of the arm rather than printed on it.
  'parts.contactShadow': 0.34,
  /* Whether the head-on drawing shows while the head is square to the camera. */
  'parts.headOn': true,
  /* How far the head can turn before the head-on face starts giving way. */
  'parts.headOnHold': 0.26,
  /* The least time a view is kept before it may hand over again, in seconds. */
  'parts.headOnDwell': 1.1,
  /* How long the latch waits before the face actually changes, in seconds. */
  'parts.headOnTime': 0.18,
  /* Face the other way. */
  'stage.faceFlip': false,

  /* How much invented paint the swinging cloth may draw, in pixels. */
  'parts.clothMargin': 8,

  /* How far the head cutout turns as it nods, in radians per radian of pitch. */
  'parts.nodTurn': 0.55,

  'warp.turn': 1.0, // how far the head rotates on its cylinder
  'warp.nod': 1.0,
  'warp.overshoot': 1.0, // head settles rather than stopping dead

  /* How far off the chain cloth still swings with it, in chain links. */
  'parts.clothReach': 2.0,

  'warp.clothWeight': 1.0, // scarf travel
  'warp.clothStiffness': 1.0, // higher returns to the drawn pose faster
  'warp.tuftWeight': 1.0,
  'warp.tuftStiffness': 1.0,
  'warp.wind': 1.0, // idle cloth movement when you are holding still

  'warp.squint': 1.0,
  'warp.eyeGlow': 0.7, // the visor is already blue-grey; a timid glow vanishes into it

};

const listeners = new Set();
let state = { ...DEFAULTS };

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    // Only adopt keys we still know about, so old saves cannot resurrect
    // settings that no longer exist.
    for (const k of Object.keys(DEFAULTS)) {
      if (k in saved) state[k] = saved[k];
    }
  } catch {
    /* corrupt or unavailable storage — fall back to defaults */
  }
}
load();

let saveTimer = 0;
/** Save only what the user actually changed. */
/* Whether changes are written down at all. */
let persist = true;
export function setPersistence(on) {
  persist = Boolean(on);
}

function scheduleSave() {
  if (!persist) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const changed = {};
      for (const k of Object.keys(DEFAULTS)) {
        if (!Object.is(state[k], DEFAULTS[k])) changed[k] = state[k];
      }
      localStorage.setItem(KEY, JSON.stringify(changed));
    } catch {
      /* private browsing / quota — settings just will not persist */
    }
  }, 250);
}

export const get = (key) => state[key];
export const snapshot = () => ({ ...state });

export function set(key, value) {
  if (!(key in DEFAULTS)) throw new Error(`unknown setting: ${key}`);
  if (state[key] === value) return;
  state[key] = value;
  scheduleSave();
  for (const fn of listeners) fn(key, value);
}

export function patch(values) {
  for (const [k, v] of Object.entries(values)) {
    if (k in DEFAULTS) set(k, v);
  }
}

export function reset() {
  patch(DEFAULTS);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function exportJSON() {
  return JSON.stringify({ app: 'vtuber-model', version: 1, settings: state }, null, 2);
}

export function importJSON(text) {
  const parsed = JSON.parse(text);
  const values = parsed?.settings ?? parsed;
  if (!values || typeof values !== 'object') throw new Error('not a settings file');
  patch(values);
}
