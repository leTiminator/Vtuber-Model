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
  /* Swapping the head for its mirror image once the turn commits.
   *
   * Renamed from parts.mirrorTurn, which had been turned off by hand while the
   * head still bent and the swap still cross-faded. A saved value outlives any
   * change of default, so the only way to hand back a setting somebody
   * switched off for a reason that no longer applies is to ask again under a
   * new name.
   */
  'parts.flipTurn': 1.0,
  // Radians of yaw before the mirror starts blending. Late on purpose: cross-
  // fading hard-edged line art ghosts, so the swap belongs where the far side
  // of the face is already hidden by the turn and there is least to see.
  'parts.mirrorStart': 0.30,

  /* The head-on view, built out of the three-quarter one.
   *
   * The artwork shows the face from one angle, and it is not the angle anybody
   * sits at. Looking straight down the camera, the avatar looked off to the
   * side — the single largest thing wrong with it, and the one no amount of
   * warping fixed, because a warp cannot put an eye where no eye was drawn.
   *
   * The near eye is drawn nearly square-on: solving the two shards as points
   * on a turned head puts it about seven degrees off the front, against
   * seventy-nine for the far one. So the head-on face is already here. Sliding
   * the pair onto the head's own centre and mirroring that near eye into the
   * far one's place assembles it, entirely out of pixels the artist drew.
   */
  'parts.headOn': 1.0,
  /* How far the head can turn before the head-on face starts giving way.
   *
   * Nobody streaming holds their head still. Talking is a constant ten or
   * fifteen degrees either side of centre, and the first version of this faded
   * the head-on face out across that entire range — so the eyes were sliding
   * back and forth over the visor the whole time somebody was speaking, and
   * the fade finished exactly where the flip starts, which put a drift and a
   * snap back to back. Both were read, correctly, as the eyes coming off the
   * face.
   *
   * A dead zone fixes it. Inside this the head-on face is simply held, so
   * ordinary talking does not move the eyes at all, and what is left is a
   * short handover well clear of the flip.
   *
   * Renamed from parts.headOnSpan, which meant something else — a saved value
   * outlives a change of default, and the old number in the new meaning would
   * put the handover on top of the flip again.
   */
  'parts.headOnHold': 0.14,
  // Radians of turn the handover itself takes, once the hold is past. Short:
  // it is a change of view, and a long one reads as the eyes wandering.
  'parts.headOnFade': 0.07,
  /* How big the mirrored far eye is against the near one.
   *
   * Equal, if the hood were redrawn head-on. It is not — the hood stays the
   * three-quarter cutout, so its far half is still foreshortened, and an eye
   * at full size there runs off the visor and onto the rim.
   */
  'parts.headOnTwin': 0.9,

  /* Face the other way.
   *
   * The drawing faces one way and that is the character's default, which is
   * fine until it is not the way you want to sit. Mirroring the picture alone
   * would leave the motion backwards — turn right and the avatar turns left —
   * so the tracking is read through the mirror too: sides swap, and everything
   * horizontal changes sign. The result is the same character facing the other
   * way and still copying you, rather than a reflection of a reflection.
   */
  'stage.faceFlip': false,

  /* How much of a part's invented margin survives the flip, in pixels.
   *
   * Enough to hide the hairline between two pieces that were one drawing, and
   * no more. The margin is a guess about what sits under a neighbour, and the
   * flip moves the head clear of every neighbour it had, so past a couple of
   * pixels the guess is just paint on the background.
   */
  'parts.flipMargin': 3,
  /* The same cap for every part, flipped or not.
   *
   * Full by default, because the margin is doing its job wherever a piece in
   * front is moving off a piece behind. It exists as a setting so a check can
   * turn it off and measure the drawing rather than the padding around it —
   * which matters more than it sounds: the scarf's two halves each carry
   * twenty-eight pixels of it, so a check for them coming apart was watching
   * fifty-six pixels of invented paint bridge every gap, and reported the
   * scarf perfectly joined however far it tore.
   */
  'parts.margin': 32,

  /* Turning the head as a rounded surface rather than bending it on a
   * cylinder. See shell.js: the cylinder slides pixels inside an outline that
   * never changes, and has no coherent answer for turning and nodding at once.
   */
  /* How far the head cutout turns as it nods, in radians per radian of pitch.
   *
   * The drawing shows one view of a face and cannot be made to show another,
   * so the head is turned rather than bent. Rotation is the one rigid motion
   * available here, and the only one that has ever read unambiguously.
   */
  'parts.nodTurn': 0.55,
  // The old bending, off. Kept so the two can be compared rather than argued
  // about; at zero the head is a rigid cutout.
  'parts.bendHead': 0,

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
