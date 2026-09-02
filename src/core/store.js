/**
 * Flat, observable settings store with localStorage persistence.
 *
 * Keys are dotted paths ("head.yawGain") so the UI can bind a control to a
 * setting by name alone. Everything the user can tune lives here, which also
 * makes export/import a one-liner.
 */
// Bumped when a saved value would actively misbehave, not merely differ.
// v2: stage offsets went from pixels to a fraction of the canvas, and reading
//     an old number as the new unit flung the character off screen.
// v3: saves from before the parts model pinned the retired whole-image warp
//     and a head flip that folds in on itself past 25 degrees. Both are
//     settings a save can carry forward into a broken-looking model.
const KEY = 'vtuber-model/settings/v3';

export const DEFAULTS = {
  // --- capture ---------------------------------------------------------
  'camera.deviceId': '',
  'camera.mirror': true,

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

  // --- eyes ------------------------------------------------------------
  'eyes.blinkGain': 1.35,
  'eyes.blinkThreshold': 0.42, // below this, the eye reads as fully open
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
  'body.followGain': 0.55, // how much the torso trails the head
  'body.breathAmount': 1.0,
  'body.breathRate': 0.22, // Hz
  'body.swayAmount': 1.0,
  'body.hairPhysics': 1.0,

  // --- stage -----------------------------------------------------------
  'stage.avatar': 'parts2d', // parts2d | warp2d | layered2d
  // Set once the user picks a model themselves, so the one-time migration off
  // the old default never overrides a deliberate choice.
  'stage.avatarChosen': false,
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

  // --- rigged artwork (warp2d) -----------------------------------------
  // Geometry is in UV space, 0..1 across the loaded image, so markup survives
  // swapping the artwork for a different resolution.
  'warp.headX': 0.5,
  'warp.headY': 0.3,
  'warp.headR': 0.2,
  'warp.pivotX': 0.5,
  'warp.pivotY': 0.52,
  'warp.waistY': 0.78,
  'warp.eyeL': '[0.41,0.27,0.48,0.32]',
  'warp.eyeR': '[0.52,0.27,0.59,0.32]',
  'warp.eyeAngle': 0, // radians; drawings rarely have level eyes
  'warp.eyesEnabled': true,
  // Turning a 3/4 character by mirroring its head is closer to the truth than
  // warping toward a view the drawing does not contain.
  // Off by default. Mirroring the head does read as the opposite 3/4 view,
  // but the mirrored copy is still bent by the same yaw as the unmirrored one,
  // so past about 25 degrees it folds in on itself and goes black. The
  // cylindrical bend alone turns the head convincingly; the flip stays here as
  // a slider until it is right.
  'parts.mirrorTurn': 0,
  'parts.mirrorStart': 0.14, // radians of yaw before the mirror starts blending

  'warp.turn': 1.0, // how far the head rotates on its cylinder
  'warp.nod': 1.0,
  'warp.parallax': 1.0, // how far the face plate slides across the skull
  'warp.overshoot': 1.0, // head settles rather than stopping dead

  'warp.clothWeight': 1.0, // scarf travel
  'warp.clothStiffness': 1.0, // higher returns to the drawn pose faster
  'warp.tuftWeight': 1.0,
  'warp.tuftStiffness': 1.0,
  'warp.wind': 1.0, // idle cloth movement when you are holding still

  'warp.lowerDamping': 0.15, // waist down barely moves
  'warp.squint': 1.0,
  'warp.eyeGlow': 0.35,
  'warp.keyWhite': 0, // 0 = off, otherwise the luminance threshold
  'warp.mesh': 48, // grid resolution; higher bends more smoothly

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
    // The cut-into-parts model was added after warp2d and was never made the
    // default, so every existing save still pins the old whole-image warp —
    // which distorts the face when you turn, cannot flip the head, and paints
    // a flat lid over the eyes. Those are exactly the complaints the parts
    // model exists to answer, so an old save must not keep serving them.
    // A deliberate choice of warp2d is easy to make again from the panel.
    if (state['stage.avatar'] === 'warp2d' && !saved['stage.avatarChosen']) {
      state['stage.avatar'] = 'parts2d';
    }
  } catch {
    /* corrupt or unavailable storage — fall back to defaults */
  }
}
load();

let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
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
