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
/* Bumped from v3.
 *
 * Every save until now wrote the whole settings object, so any browser that
 * had ever touched a control was pinned to that build's defaults for all of
 * them — and stayed pinned, silently, through every later change. There is no
 * way to tell a deliberate choice from a frozen default inside such a blob,
 * so the only honest migration is to start again: current defaults for
 * everything, and from here on only real changes are written, so this cannot
 * happen twice.
 */
const KEY = 'vtuber-model/settings/v4';

export const DEFAULTS = {
  // --- capture ---------------------------------------------------------
  'camera.deviceId': '',
  'camera.mirror': true,

  /* Crop the camera to your face before the tracker sees it.
   *
   * The tracking model finds a face by looking over a downscaled copy of the
   * whole frame. Sitting back from the camera, that leaves it a face a few
   * dozen pixels across, and everything after — the head angles, and the
   * blendshapes especially — is only as good as what it had to look at. It
   * reads as a model that will not quite track, and nothing at the far end
   * fixes it, because the detail was gone before any of that ran.
   *
   * 'auto' follows the face and crops to it; 'off' hands over the whole frame,
   * which is what this always did.
   */
  'camera.faceZoom': 'auto',
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
  /* Tilt has a limit of its own, lower than the turn's.
   *
   * At the shared limit a person tilting their head hard — measured live,
   * raw roll +49° — rolled the model forty-two degrees, and a head that far
   * over turns inside its collar. Twenty-five keeps it level enough to read as
   * a head, and is about where a collar stops looking wrong under a jaw.
   */
  'head.rollLimitDeg': 25,
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
  /* How much of the body's pose comes from your shoulders.
   *
   * The body used to be the head's own angles scaled down, so it could only be
   * a smaller copy of wherever the face was pointing — it could not sit turned
   * while the head looked back at the camera, which is most of what a person
   * does at a desk. The pose model has returned both shoulders on every stride
   * all along; nothing read them.
   *
   * Needs arm tracking on, since that is what runs the pose model.
   */
  'body.shoulderGain': 1.0,
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
  /* Off. The head can be driven to head.limitDeg and the mirror fired just
   * under it, so a hard glance to the side swapped the whole head for its
   * reflection — "it just flips between left and right" — and every swap is a
   * seam somewhere. A drawn three-quarter view sliding as far as it can is
   * less true to the turn and far less noticeable than a face changing hands.
   * Left as a setting for anyone who wants the swap back.
   */
  'parts.flipTurn': 0,
  // Radians of yaw before the mirror starts blending. Late on purpose: cross-
  // fading hard-edged line art ghosts, so the swap belongs where the far side
  // of the face is already hidden by the turn and there is least to see.
  /* Pushed out from 0.30 to leave the head-on handover somewhere to happen.
   *
   * The square-on face gives way at 0.26 and the flip fired at 0.30, so the
   * two landed on top of each other — the eyes crossed the visor and the head
   * swapped sides in almost the same movement, which reads as one lurching
   * event rather than two decisions.
   */
  /* Raised well past where a person sits, because the swap costs more than it
   * pays inside that range.
   *
   * At twenty-three degrees it fired constantly — "it just flips between left
   * and right even if I'm looking directly at the camera" — and every firing
   * takes the chin off the scarf, because the head reflects and the neck cloth
   * only slides. There is a real drawing of the head-on face now and a drawn
   * three-quarter either side of it, so the range a person actually works in
   * is covered without ever reflecting anything. The mirror is left for a
   * genuine turn away, where a bad seam matters far less than a face pointing
   * the wrong way would.
   *
   * Reachable, which the first number chosen was not. The rig scales the head
   * by head.yawGain and THEN clamps at head.limitDeg, so the most yaw the
   * renderer ever sees is limitDeg itself — 0.733 rad at the default — and a
   * threshold above that is a mirror that never fires. This sits just under
   * it, so a head driven to its limit flips; which is also why the mirror is
   * now off by default (parts.flipTurn).
   */
  'parts.mirrorStart': 0.70,

  /* How much of the head-on face shows when the head is square to the camera.
   *
   * The artwork shows the face from one angle, and it is not the angle anybody
   * sits at. Looking straight down the camera, the avatar looked off to the
   * side — the single largest thing wrong with it, and the one no amount of
   * warping fixed, because a warp cannot put an eye where no eye was drawn.
   *
   * It is drawn now. A second file draws this character facing the camera —
   * a rounder hood, a symmetric visor, two matched shards — and its head is
   * registered onto this one's and swapped in, so the head-on view is a
   * drawing rather than an arrangement. What used to be here slid the near eye
   * onto the head's centre line and mirrored it into the far eye's place,
   * which is what read as the eyes coming off the face.
   *
   * Below a half this never reaches the swap, which is how it is switched off.
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
  'parts.headOnHold': 0.26,
  /* The least time a view is kept before it may hand over again, in seconds.
   *
   * A threshold on its own is not enough. Whatever angle it sits at, a head
   * that spends its time near that angle crosses it constantly — measured on a
   * real minute, thirty-three times, and every crossing slides the eyes across
   * the visor. Widening the band moves the problem; it does not remove it.
   *
   * Refusing to change again for a moment does remove it, because it turns a
   * threshold into a decision.
   */
  'parts.headOnDwell': 1.1,
  /* How long the latch waits before the face actually changes, in seconds.
   *
   * The two faces are two drawings of a hood and they swap rather than fade,
   * for the same reason the mirror does: two copies of hard-edged line art
   * laid over each other are legible as two. So this is no longer a fade
   * length — it is a ramp the swap happens halfway through, which gives the
   * latch a moment to be sure of a decision it has already made slowly.
   *
   * Tying any of this to the angle cannot win, which is why none of it is.
   * Narrow, and the face changes in a couple of degrees and reads as a twitch;
   * wide, and it changes back and forth the whole time somebody is talking.
   */
  'parts.headOnTime': 0.18,
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
  /* How much invented paint the swinging cloth may draw, in pixels.
   *
   * Every part is grown outward so the piece in front has something to move
   * off, and the limit above lets all of it through — which is right for a
   * part that barely moves. The scarf is not that: its chain may carry it a
   * hundred pixels, and the twenty-eight pixel band was painted to sit under
   * the body. Once it travels further than the band is wide, that invented
   * paint slides out into the open as a hard-edged red slab with nothing
   * behind it. That is the cutoff in the scarf.
   *
   * It is the backmost piece, so what its margin hides is only ever the
   * background, and it can afford to keep just enough to cover a seam.
   */
  'parts.clothMargin': 8,

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

  /* How far off the chain cloth still swings with it, in chain links.
   *
   * Only one piece of the scarf gets bones: the run with the most skeleton in
   * it, which on this drawing is the great sweeping arc. Every other piece —
   * here, the drape over the hip — binds to whichever end of that chain is
   * nearest and is carried rigidly from a pivot a long way off, so a small
   * motion at the tip arrives at the hip as a large one. That is the hip
   * being dragged about by the scarf lying over it.
   *
   * Measured on this artwork, the arc's own cloth overshoots the ends of its
   * chain by seven pixels at the median and thirty-one at the ninetieth,
   * against a hundred and five for the hip drape — so two links separates
   * cloth that is on the chain from cloth merely tied to it, with room to
   * spare either side. Raise it to give the loose ends their swing back.
   *
   * The sash is now kept off the chain by connectivity as well — it is not the
   * same piece of cloth as the ribbon — so at the default this only trims the
   * ribbon's own far corners. Kept because a drawing whose sash touches its
   * ribbon has nothing else.
   */
  'parts.clothReach': 2.0,

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
/**
 * Save only what the user actually changed.
 *
 * This used to write the whole settings object, which quietly froze every
 * returning user at the defaults of whatever build they were on the first time
 * they touched any one control. A single nudge of a single slider pinned all
 * ninety-odd keys, so every later improvement to a default reached nobody who
 * had ever used the app — and this codebase leans on changed defaults
 * constantly, with four separate comments explaining that a key had to be
 * renamed to get a new value out. Renaming only ever rescued the renamed key;
 * the rest stayed stale, invisibly, forever.
 *
 * Storing the difference instead means an untouched control keeps following
 * its default, and only a deliberate choice sticks. It also makes the saved
 * blob small and readable, and it retires the rename trick.
 */
/* Whether changes are written down at all.
 *
 * On by default and turned off by exactly one caller: the page OBS opens,
 * which is told its settings over the link rather than remembering any. OBS's
 * browser keeps its own storage, so a snapshot saved there would be read back
 * on the next launch and win until the first message arrived — a second or two
 * of a shot nobody framed, at the top of every stream.
 */
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
