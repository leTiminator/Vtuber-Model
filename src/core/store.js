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
  /* The calibrated rest pose, as JSON; empty means none.
   *
   * Kept here rather than in memory because a camera off to one side is not a
   * one-off. Sitting at an angle reads as a permanent yaw, so without a
   * neutral the model sits turned before you have moved — parked in the part
   * of its range it renders worst. That is a property of where the camera is
   * bolted, not of this session, so it should outlive a reload.
   */
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
  /* Which way a nod goes, as a preference on top of a convention that is now
   * fixed in code — see PITCH_SIGN in rig.js.
   *
   * Renamed from head.invertNod deliberately. That key shipped with a default
   * of false, browsers saved it, and a later change of the default could not
   * reach any of them: a saved value always wins over a default, so changing a
   * default is not a fix for anyone who has already run the app. A new name
   * has no saved value to lose to, which is the whole reason for the rename.
   */
  'head.flipNod': false,

  // --- eyes ------------------------------------------------------------
  'eyes.blinkGain': 1.35,
  'eyes.blinkThreshold': 0.42, // below this, the eye reads as fully open
  /* How much of the lid to blame on the gaze rather than on a blink.
   *
   * Looking down pulls the upper lid down with it, which the tracker reports
   * as a blink; see the note in rig.js. Zero trusts the tracker's blink as it
   * comes, which shuts the eyes for anyone who looks down at a screen.
   */
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
  // Mirroring the cutout is the opposite 3/4 view, which beats warping toward
  // one. It went black before because both copies were drawn semi-transparent
  // and "over" blending bottoms out at 0.75 alpha halfway through; the far
  // copy is painted solid now and the near one dissolves over it.
  // Depth between the layers: a soft dark shape laid behind each part so the
  // scarf reads as sitting in front of the arm rather than printed on it.
  'parts.contactShadow': 0.34,
  'parts.mirrorTurn': 1.0,
  // Radians of yaw before the mirror starts blending. Late on purpose: cross-
  // fading hard-edged line art ghosts, so the swap belongs where the far side
  // of the face is already hidden by the turn and there is least to see.
  'parts.mirrorStart': 0.30,

  /* Turning the head as a rounded surface rather than bending it on a
   * cylinder. See shell.js: the cylinder slides pixels inside an outline that
   * never changes, and has no coherent answer for turning and nodding at once.
   */
  'parts.turnShell': 1.0,
  // How deep the shell stands off the drawing, as a fraction of the head's own
  // radius. Past about 0.6 the surface folds over itself inside the rig's own
  // turn limit, which reads as the head turning inside out.
  'parts.shellDepth': 0.55,

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
  'warp.eyeGlow': 0.7, // the visor is already blue-grey; a timid glow vanishes into it
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
