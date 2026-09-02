/**
 * Turns raw tracker frames into RigState: the normalised pose every avatar
 * backend renders from. Nothing below this file knows what MediaPipe is.
 *
 * Responsibilities, in order:
 *   1. mirror the signal so the avatar reads as your reflection
 *   2. subtract a calibrated neutral pose
 *   3. apply per-channel gain and shaping curves
 *   4. One Euro filter everything
 *   5. add the motion you never perform yourself — breathing, sway, blinks,
 *      and body follow-through
 */
import { FilterBank } from '../core/oneEuro.js';
import { clamp, damp, DEG, lerp, makeSpring, remap, spring, TAU } from '../core/math.js';
import * as store from '../core/store.js';

/**
 * Ceilings on how fast the head may turn and travel, in radians and in units
 * of head-width per second. Both sit well above brisk human movement — a quick
 * 45-degree glance runs at roughly 5 rad/s — so they bite only on estimates no
 * neck could have produced.
 */
const MAX_HEAD_SLEW = 6;
const MAX_HEAD_DRIFT = 5;

/** How long the head takes to trust the tracker fully again after a dropout. */
const REACQUIRE_SECONDS = 0.3;

/**
 * How long the head keeps its pose after the face is lost, and how long it
 * then takes to let go. Sized from real dropouts: a glance down under a cap
 * brim runs one to two seconds, and should not move the model at all.
 */
const HOLD_SECONDS = 1.6;
const RELEASE_SECONDS = 2.0;

/** Blendshape channels that come in mirrored pairs. */
const PAIRS = [
  'browDown', 'browOuterUp', 'cheekSquint', 'eyeBlink', 'eyeLookDown', 'eyeLookIn',
  'eyeLookOut', 'eyeLookUp', 'eyeSquint', 'eyeWide', 'mouthDimple', 'mouthFrown',
  'mouthLowerDown', 'mouthPress', 'mouthSmile', 'mouthStretch', 'mouthUpperUp', 'noseSneer',
];

export function emptyRig() {
  return {
    tracked: false,
    confidence: 0,
    head: { yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, z: 0 },
    eyes: {
      blinkL: 0, blinkR: 0, squintL: 0, squintR: 0, wideL: 0, wideR: 0,
      gazeX: 0, gazeY: 0, browL: 0, browR: 0, browInner: 0,
    },
    mouth: { open: 0, smile: 0, frown: 0, pucker: 0, funnel: 0, wide: 0, press: 0, tongue: 0, shift: 0 },
    cheeks: { puff: 0, squintL: 0, squintR: 0 },
    body: { leanX: 0, leanY: 0, twist: 0, breath: 0, bounce: 0, hairX: 0, hairY: 0 },
    // Arm angles are relative to the torso, not the screen, so leaning does not
    // read as raising. `raise` is how far the wrist is above the shoulder.
    arms: {
      left: { upper: 0, fore: 0, raise: 0, seen: 0 },
      right: { upper: 0, fore: 0, raise: 0, seen: 0 },
    },
    expression: { blush: 0, anger: 0, sparkle: 0, sweat: 0, shock: 0 },
    viseme: 'rest',
  };
}

/** The saved rest pose, or null. Anything malformed is treated as none. */
function readNeutral() {
  try {
    const raw = store.get('camera.neutral');
    if (!raw) return null;
    const n = JSON.parse(raw);
    const ok = ['yaw', 'pitch', 'roll', 'x', 'y', 'z'].every((k) => Number.isFinite(n?.[k]));
    return ok ? n : null;
  } catch {
    return null;
  }
}

export class Rig {
  constructor() {
    this.state = emptyRig();
    this.pose = new FilterBank({ minCutoff: 1.2, beta: 0.06, dCutoff: 1.0 });
    this.face = new FilterBank({ minCutoff: 2.4, beta: 0.25, dCutoff: 1.0 });
    // Arms get their own bank: pose runs on a stride, so it needs a slower
    // cutoff than the face, and its steadiness is a separate knob.
    this.arms = new FilterBank({ minCutoff: 0.9, beta: 0.04, dCutoff: 1.0 });

    this.neutral = readNeutral(); // calibrated baseline, set by calibrate()
    this.pendingCalibration = null;
    this.armNeutral = null; // resting arm angles, captured on the same signal

    this.springs = {
      leanX: makeSpring(), leanY: makeSpring(), twist: makeSpring(),
      hairX: makeSpring(), hairY: makeSpring(),
    };

    // How far back in after tracking was lost, 0 to 1. The tracker's first
    // estimates after a dropout are its least reliable, so they are eased in.
    this.reacquire = 1;
    this.lostFor = 0; // seconds since the face was last seen
    this.clock = 0;
    this.blink = { timer: 1.4, value: 0, phase: 'idle' };
    this.overrides = new Map(); // expression name -> weight, driven by hotkeys
    this.micLevel = 0;
    this.lastFrame = null;

    store.subscribe((key) => {
      if (key.startsWith('smooth.') || key === 'arms.smooth') this.applySmoothing();
    });
    this.applySmoothing();
  }

  applySmoothing() {
    this.pose.configure({
      minCutoff: store.get('smooth.minCutoff'),
      beta: store.get('smooth.beta'),
    });
    this.face.configure({
      minCutoff: store.get('smooth.expression'),
      beta: store.get('smooth.beta') * 3,
    });
    // Higher "smooth" means calmer arms, so it divides the cutoff.
    const armSmooth = Math.max(store.get('arms.smooth'), 0.05);
    this.arms.configure({ minCutoff: 0.9 / armSmooth, beta: 0.04 / armSmooth });
  }

  /** Capture the next tracked frame as the neutral rest pose. */
  calibrate() {
    this.pendingCalibration = { samples: [], needed: 12 };
    this.armNeutral = null; // re-read on the next pose frame
  }

  clearCalibration() {
    this.neutral = null;
    this.pendingCalibration = null;
    this.armNeutral = null;
    store.set('camera.neutral', '');
  }

  setOverride(name, weight) {
    if (weight <= 0) this.overrides.delete(name);
    else this.overrides.set(name, weight);
  }

  setMicLevel(rms) {
    this.micLevel = rms;
  }

  /**
   * Fold in upper-body landmarks. Kept separate from the face update because
   * pose runs on a stride and can be switched off entirely.
   *
   * Angles are measured against the torso's own axis — shoulders to hips — so
   * they mean the same thing whether you are sitting straight or leaning.
   * Measuring against the screen would turn a lean into a raised arm.
   */
  updatePose(frame, hasPose, dt) {
    const arms = this.state.arms;
    if (!hasPose || !frame) {
      for (const side of ['left', 'right']) {
        const a = arms[side];
        a.seen = damp(a.seen, 0, 4, dt);
        a.upper = damp(a.upper, 0, 3, dt);
        a.fore = damp(a.fore, 0, 3, dt);
        a.raise = damp(a.raise, 0, 3, dt);
      }
      return;
    }

    const j = frame.joints;
    const mirror = store.get('camera.mirror');
    const shoulderL = mirror ? j.shoulderR : j.shoulderL;
    const shoulderR = mirror ? j.shoulderL : j.shoulderR;
    const elbowL = mirror ? j.elbowR : j.elbowL;
    const elbowR = mirror ? j.elbowL : j.elbowR;
    const wristL = mirror ? j.wristR : j.wristL;
    const wristR = mirror ? j.wristL : j.wristR;
    const hipL = mirror ? j.hipR : j.hipL;
    const hipR = mirror ? j.hipL : j.hipR;

    const flip = mirror ? -1 : 1;
    const mid = (a, b) => (a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a || b);
    const shoulders = mid(shoulderL, shoulderR);
    const hips = mid(hipL, hipR);
    if (!shoulders) return;

    // Torso axis, pointing down the body. Without hips (cropped out of frame,
    // which is normal at a desk) fall back to screen-down.
    let axisX = 0;
    let axisY = 1;
    if (hips) {
      axisX = hips.x - shoulders.x;
      axisY = hips.y - shoulders.y;
      const len = Math.hypot(axisX, axisY) || 1;
      axisX /= len;
      axisY /= len;
    }
    const torso = hips ? Math.hypot(hips.x - shoulders.x, hips.y - shoulders.y) : 0.25;
    const span = Math.max(torso, 0.08);

    const signedAngle = (ax, ay, bx, by) => {
      const dot = ax * bx + ay * by;
      const cross = ax * by - ay * bx;
      return Math.atan2(cross, dot);
    };

    const gain = store.get('arms.gain');
    const measured = {};

    const solve = (shoulder, elbow, wrist, key) => {
      const a = arms[key];
      if (!shoulder || !elbow) {
        a.seen = damp(a.seen, 0, 4, dt);
        return;
      }
      a.seen = damp(a.seen, 1, 8, dt);

      let ux = elbow.x - shoulder.x;
      let uy = elbow.y - shoulder.y;
      const ulen = Math.hypot(ux, uy) || 1;
      ux /= ulen; uy /= ulen;
      const upper = this.arms.filter(
        `${key}Upper`, clamp(signedAngle(axisX, axisY, ux, uy) * flip, -Math.PI, Math.PI), dt);

      let fore = 0;
      let raise = 0;
      if (wrist) {
        let fx = wrist.x - elbow.x;
        let fy = wrist.y - elbow.y;
        const flen = Math.hypot(fx, fy) || 1;
        fx /= flen; fy /= flen;
        fore = this.arms.filter(
          `${key}Fore`, clamp(signedAngle(ux, uy, fx, fy) * flip, -Math.PI, Math.PI), dt);
        // Positive when the wrist is above the shoulder — hands off the keyboard.
        raise = this.arms.filter(`${key}Raise`, clamp((shoulder.y - wrist.y) / span, -1.5, 2), dt);
      }

      measured[key] = { upper, fore, raise };

      // Everything downstream wants a *change* from how you normally sit, not
      // an absolute angle: the artwork already has arms drawn somewhere, and
      // the rig rotates them away from there. Without this, resting hands on
      // the keyboard would hold the drawn arms permanently bent.
      const rest = this.armNeutral?.[key];
      a.upper = (upper - (rest?.upper ?? 0)) * gain;
      a.fore = (fore - (rest?.fore ?? 0)) * gain;
      a.raise = (raise - (rest?.raise ?? 0)) * gain;
    };

    solve(shoulderL, elbowL, wristL, 'left');
    solve(shoulderR, elbowR, wristR, 'right');

    // First good look at both arms after a calibrate becomes the rest pose.
    if (!this.armNeutral && measured.left && measured.right) {
      this.armNeutral = measured;
      for (const side of ['left', 'right']) {
        arms[side].upper = 0;
        arms[side].fore = 0;
        arms[side].raise = 0;
      }
    }
  }

  /**
   * @param {object|null} frame  latest tracker frame, or null when no face
   * @param {boolean} tracked    whether that frame is current
   * @param {number} dt          seconds since the previous update
   */
  update(frame, tracked, dt) {
    dt = clamp(dt, 1 / 240, 1 / 15); // guard against tab-switch spikes
    this.clock += dt;
    const s = this.state;
    const mirror = store.get('camera.mirror');

    if (tracked && !this.state.tracked) this.reacquire = 0;
    if (tracked) this.reacquire = Math.min(1, this.reacquire + dt / REACQUIRE_SECONDS);
    this.lostFor = tracked ? 0 : this.lostFor + dt;

    if (frame && tracked) {
      const shapes = mirror ? mirrorShapes(frame.shapes) : frame.shapes;
      const head = mirror
        ? { yaw: -frame.head.yaw, pitch: frame.head.pitch, roll: -frame.head.roll }
        : frame.head;
      const pos = mirror
        ? { x: -frame.position.x, y: frame.position.y, z: frame.position.z }
        : frame.position;

      this.collectCalibration(head, pos);
      const before = { ...s.head };
      this.applyTracked(shapes, head, pos, dt);

      /* Limit how fast the head is allowed to move.
       *
       * A head has a top speed; a tracker does not. Recorded from a real
       * session: the face was found at yaw -0.29, lost for a single frame,
       * then found again at +1.14 — eighty-two degrees in a tenth of a second,
       * and back again shortly after. It was a bad estimate on reacquisition,
       * not a movement, but nothing downstream could tell the difference.
       *
       * The One Euro filter makes this worse rather than better: a large
       * derivative is precisely what widens its cutoff, so the jump passes
       * through almost untouched. That is the right behaviour for real fast
       * motion and the wrong one for a glitch, and the filter cannot
       * distinguish them.
       *
       * A speed cap can. It is set well above a brisk human head turn, so it
       * costs nothing on real movement, and it turns a teleport into a short
       * lean that unwinds as soon as good frames resume.
       */
      // Tighter while easing back in, because that is when a bad estimate is
      // most likely and when there is no recent history to judge it against.
      const trust = 0.25 + 0.75 * this.reacquire * this.reacquire;
      const step = MAX_HEAD_SLEW * trust * dt;
      for (const k of ['yaw', 'pitch', 'roll']) {
        s.head[k] = clamp(s.head[k], before[k] - step, before[k] + step);
      }
      const move = MAX_HEAD_DRIFT * trust * dt;
      for (const k of ['x', 'y']) {
        s.head[k] = clamp(s.head[k], before[k] - move, before[k] + move);
      }
      s.tracked = true;
      s.confidence = damp(s.confidence, 1, 8, dt);
    } else {
      s.tracked = false;
      s.confidence = damp(s.confidence, 0, 3, dt);
      this.relax(dt);
    }

    this.applyMouthSource(dt);
    this.applyAutoBlink(dt, tracked);
    this.applyOverrides(dt);
    this.applyBody(dt);
    s.viseme = pickViseme(s.mouth);
    return s;
  }

  collectCalibration(head, pos) {
    const cal = this.pendingCalibration;
    if (!cal) return;
    cal.samples.push({ ...head, px: pos.x, py: pos.y, pz: pos.z });
    if (cal.samples.length < cal.needed) return;

    const mean = (k) => cal.samples.reduce((a, v) => a + v[k], 0) / cal.samples.length;
    this.neutral = {
      yaw: mean('yaw'), pitch: mean('pitch'), roll: mean('roll'),
      x: mean('px'), y: mean('py'), z: mean('pz'),
    };
    this.pendingCalibration = null;
    store.set('camera.neutral', JSON.stringify(this.neutral));
  }

  applyTracked(shapes, head, pos, dt) {
    const s = this.state;
    const g = store.get.bind(store);
    const n = this.neutral;
    const limit = g('head.limitDeg') * DEG;
    const sh = (k) => shapes[k] ?? 0;

    // --- head ----------------------------------------------------------
    const yaw = (head.yaw - (n?.yaw ?? 0)) * g('head.yawGain');
    // Inverted here rather than at the renderer, so everything downstream —
    // the cloth's idea of where the head went, the hair's lag — agrees with
    // what is on screen.
    const pitch = (head.pitch - (n?.pitch ?? 0)) * g('head.pitchGain')
      * (g('head.invertNod') ? -1 : 1);
    const roll = (head.roll - (n?.roll ?? 0)) * g('head.rollGain');

    s.head.yaw = this.pose.filter('yaw', clamp(yaw, -limit, limit), dt);
    s.head.pitch = this.pose.filter('pitch', clamp(pitch, -limit, limit), dt);
    s.head.roll = this.pose.filter('roll', clamp(roll, -limit, limit), dt);

    // Translation arrives in centimetres; normalise to roughly -1..1 of frame.
    const pg = g('head.positionGain');
    s.head.x = this.pose.filter('px', clamp(((pos.x - (n?.x ?? 0)) / 14) * pg, -1.5, 1.5), dt);
    s.head.y = this.pose.filter('py', clamp(((pos.y - (n?.y ?? 0)) / 14) * pg, -1.5, 1.5), dt);
    s.head.z = this.pose.filter('pz', clamp(((pos.z - (n?.z ?? -45)) / 30) * pg, -1.5, 1.5), dt);

    // --- eyes ----------------------------------------------------------
    const blinkGain = g('eyes.blinkGain');
    const thresh = g('eyes.blinkThreshold');
    let bl = shapeBlink(sh('eyeBlinkLeft'), thresh, blinkGain);
    let br = shapeBlink(sh('eyeBlinkRight'), thresh, blinkGain);
    if (g('eyes.linkBlinks')) {
      // Winks read as tracking noise on most rigs; take the stronger eye for both.
      const both = Math.max(bl, br);
      bl = br = both;
    }
    s.eyes.blinkL = this.face.filter('blinkL', bl, dt);
    s.eyes.blinkR = this.face.filter('blinkR', br, dt);
    s.eyes.squintL = this.face.filter('squintL', sh('eyeSquintLeft'), dt);
    s.eyes.squintR = this.face.filter('squintR', sh('eyeSquintRight'), dt);
    s.eyes.wideL = this.face.filter('wideL', sh('eyeWideLeft'), dt);
    s.eyes.wideR = this.face.filter('wideR', sh('eyeWideRight'), dt);

    const gazeGain = g('eyes.gazeGain');
    const gx = (sh('eyeLookOutLeft') + sh('eyeLookInRight')) / 2 - (sh('eyeLookInLeft') + sh('eyeLookOutRight')) / 2;
    const gy = (sh('eyeLookUpLeft') + sh('eyeLookUpRight')) / 2 - (sh('eyeLookDownLeft') + sh('eyeLookDownRight')) / 2;
    s.eyes.gazeX = this.face.filter('gazeX', clamp(gx * gazeGain, -1, 1), dt);
    s.eyes.gazeY = this.face.filter('gazeY', clamp(gy * gazeGain, -1, 1), dt);

    const browGain = g('eyes.browGain');
    const browL = (sh('browOuterUpLeft') - sh('browDownLeft')) * browGain;
    const browR = (sh('browOuterUpRight') - sh('browDownRight')) * browGain;
    s.eyes.browL = this.face.filter('browL', clamp(browL, -1, 1), dt);
    s.eyes.browR = this.face.filter('browR', clamp(browR, -1, 1), dt);
    s.eyes.browInner = this.face.filter('browInner', clamp(sh('browInnerUp') * browGain, 0, 1), dt);

    // --- mouth ---------------------------------------------------------
    const open = clamp(sh('jawOpen') * g('mouth.openGain') - sh('mouthClose') * 0.5, 0, 1);
    this.cameraMouthOpen = this.face.filter('mouthOpen', open, dt);

    const smile = ((sh('mouthSmileLeft') + sh('mouthSmileRight')) / 2) * g('mouth.smileGain');
    const frown = (sh('mouthFrownLeft') + sh('mouthFrownRight')) / 2;
    s.mouth.smile = this.face.filter('smile', clamp(smile, 0, 1), dt);
    s.mouth.frown = this.face.filter('frown', clamp(frown * 1.2, 0, 1), dt);
    s.mouth.pucker = this.face.filter('pucker', clamp(sh('mouthPucker'), 0, 1), dt);
    s.mouth.funnel = this.face.filter('funnel', clamp(sh('mouthFunnel'), 0, 1), dt);
    const wide = ((sh('mouthStretchLeft') + sh('mouthStretchRight')) / 2) * g('mouth.wideGain');
    s.mouth.wide = this.face.filter('wide', clamp(wide, 0, 1), dt);
    s.mouth.press = this.face.filter('press', clamp((sh('mouthPressLeft') + sh('mouthPressRight')) / 2, 0, 1), dt);
    s.mouth.tongue = this.face.filter('tongue', clamp(sh('tongueOut'), 0, 1), dt);
    s.mouth.shift = this.face.filter('shift', clamp(sh('mouthRight') - sh('mouthLeft'), -1, 1), dt);

    // --- cheeks --------------------------------------------------------
    s.cheeks.puff = this.face.filter('puff', clamp(sh('cheekPuff'), 0, 1), dt);
    s.cheeks.squintL = this.face.filter('cheekSquintL', sh('cheekSquintLeft'), dt);
    s.cheeks.squintR = this.face.filter('cheekSquintR', sh('cheekSquintRight'), dt);
  }

  /** No face in frame: ease back toward rest instead of snapping. */
  relax(dt) {
    const s = this.state;
    const rate = 2.2;

    /* Hold the head where it was, before easing it back to neutral.
     *
     * Losing the face usually means the face went somewhere, not that the
     * person left. Recorded from a real session — someone in a cap, whose brim
     * hides their face whenever they look down — nine of eleven dropouts began
     * from a downward pitch, and four of them lasted over a second. Decaying
     * straight to neutral means the model looks *up* the moment they look
     * down, then snaps back when tracking returns: the opposite of what they
     * did, twice, every time they glance at the keyboard.
     *
     * So the pose is held while the absence is short, then let go gradually if
     * it is not. Expressions are not held — a smile frozen on an empty chair
     * is worse than a neutral face.
     */
    const letGo = clamp((this.lostFor - HOLD_SECONDS) / RELEASE_SECONDS, 0, 1);
    const headRate = rate * letGo * letGo;
    for (const k of ['yaw', 'pitch', 'roll', 'x', 'y', 'z']) {
      s.head[k] = damp(s.head[k], 0, headRate, dt);
    }
    for (const k of ['blinkL', 'blinkR', 'squintL', 'squintR', 'wideL', 'wideR',
                     'gazeX', 'gazeY', 'browL', 'browR', 'browInner']) {
      s.eyes[k] = damp(s.eyes[k], 0, rate, dt);
    }
    for (const k of Object.keys(s.mouth)) s.mouth[k] = damp(s.mouth[k], 0, rate, dt);
    for (const k of Object.keys(s.cheeks)) s.cheeks[k] = damp(s.cheeks[k], 0, rate, dt);
    this.cameraMouthOpen = damp(this.cameraMouthOpen ?? 0, 0, rate, dt);
    this.pose.reset();
    this.face.reset();
  }

  /** Blend camera-driven jaw with mic loudness, per the user's preference. */
  applyMouthSource(dt) {
    const source = store.get('mouth.source');
    const cam = this.cameraMouthOpen ?? 0;

    const gate = store.get('mouth.micGate');
    const level = clamp((this.micLevel - gate) / (0.16 - gate), 0, 1);
    // Perceptual curve: quiet speech should still open the mouth visibly.
    const mic = clamp(Math.pow(level, 0.62) * store.get('mouth.micGain'), 0, 1);
    const micSmooth = this.face.filter('micMouth', mic, dt);

    if (source === 'mic') this.state.mouth.open = micSmooth;
    else if (source === 'both') this.state.mouth.open = Math.max(cam, micSmooth * 0.95);
    else this.state.mouth.open = cam;
  }

  /**
   * Real blinks come from the camera. This fills the gaps: when the face is
   * lost, or when the tracker reports an unnaturally long stare, the avatar
   * blinks on its own so it never looks dead.
   */
  applyAutoBlink(dt, tracked) {
    if (!store.get('eyes.autoBlink')) {
      this.blink.value = damp(this.blink.value, 0, 12, dt);
      this.mergeAutoBlink(tracked);
      return;
    }

    const b = this.blink;
    const trackedBlink = Math.max(this.state.eyes.blinkL, this.state.eyes.blinkR);
    if (tracked && trackedBlink > 0.5) {
      // The user is blinking for real — reset the timer and stay out of the way.
      b.timer = 1.6 + Math.random() * 3.4;
      b.phase = 'idle';
      b.value = damp(b.value, 0, 14, dt);
      this.mergeAutoBlink(tracked);
      return;
    }

    b.timer -= dt;
    if (b.phase === 'idle' && b.timer <= 0) {
      b.phase = 'closing';
      b.timer = 2.0 + Math.random() * 4.0;
    }
    if (b.phase === 'closing') {
      b.value += dt * 16;
      if (b.value >= 1) { b.value = 1; b.phase = 'opening'; }
    } else if (b.phase === 'opening') {
      b.value -= dt * 9;
      if (b.value <= 0) { b.value = 0; b.phase = 'idle'; }
    }
    this.mergeAutoBlink(tracked);
  }

  /**
   * While tracking, auto-blink only fills gaps, so it takes whichever of the
   * two is more closed. With no face it is the sole source and must assign
   * outright — taking the max there would ratchet the eyes shut and leave
   * them that way, since nothing else drives the channel down.
   */
  mergeAutoBlink(tracked) {
    const s = this.state.eyes;
    if (tracked) {
      s.blinkL = Math.max(s.blinkL, this.blink.value);
      s.blinkR = Math.max(s.blinkR, this.blink.value);
    } else {
      s.blinkL = this.blink.value;
      s.blinkR = this.blink.value;
    }
  }

  applyOverrides(dt) {
    const e = this.state.expression;
    for (const key of Object.keys(e)) {
      e[key] = damp(e[key], this.overrides.get(key) ?? 0, 9, dt);
    }
  }

  /**
   * Secondary motion. The torso trails the head, the chest breathes, and the
   * whole body drifts on a slow lissajous so a still pose is never frozen.
   */
  applyBody(dt) {
    const s = this.state;
    const follow = store.get('body.followGain');
    const swayAmt = store.get('body.swayAmount');
    const hairAmt = store.get('body.hairPhysics');

    const swayX = Math.sin(this.clock * 0.37) * 0.05 + Math.sin(this.clock * 0.19) * 0.03;
    const swayY = Math.sin(this.clock * 0.29 + 1.1) * 0.035;

    spring(this.springs.leanX, s.head.yaw * follow + swayX * swayAmt, 90, 13, dt);
    spring(this.springs.leanY, s.head.pitch * follow * 0.7 + swayY * swayAmt, 90, 13, dt);
    spring(this.springs.twist, s.head.roll * follow * 0.8, 80, 12, dt);

    s.body.leanX = this.springs.leanX.value;
    s.body.leanY = this.springs.leanY.value;
    s.body.twist = this.springs.twist.value;

    // Hair lags the head with a looser spring, then overshoots — the wobble
    // that sells the whole thing as a physical object.
    spring(this.springs.hairX, (s.head.yaw * 1.6 + s.head.x * 0.5) * hairAmt, 46, 6.5, dt);
    spring(this.springs.hairY, (s.head.pitch * 1.2 + s.head.y * 0.5) * hairAmt, 46, 6.5, dt);
    s.body.hairX = s.head.yaw * 1.6 * hairAmt - this.springs.hairX.value;
    s.body.hairY = s.head.pitch * 1.2 * hairAmt - this.springs.hairY.value;

    const breathAmt = store.get('body.breathAmount');
    const rate = store.get('body.breathRate');
    s.body.breath = (Math.sin(this.clock * TAU * rate) * 0.5 + 0.5) * breathAmt;
    s.body.bounce = Math.sin(this.clock * TAU * rate * 2 + 0.6) * 0.25 * breathAmt;
  }
}

/** Swap every Left/Right blendshape pair so the avatar mirrors the user. */
function mirrorShapes(shapes) {
  const out = { ...shapes };
  for (const base of PAIRS) {
    const l = `${base}Left`, r = `${base}Right`;
    out[l] = shapes[r] ?? 0;
    out[r] = shapes[l] ?? 0;
  }
  out.mouthLeft = shapes.mouthRight ?? 0;
  out.mouthRight = shapes.mouthLeft ?? 0;
  out.jawLeft = shapes.jawRight ?? 0;
  out.jawRight = shapes.jawLeft ?? 0;
  return out;
}

/**
 * Raw eyeBlink scores hover in the middle for a half-lidded eye, which renders
 * as a permanently sleepy avatar. Rescale from the threshold up, then apply a
 * gamma so the eye commits to closed rather than lingering.
 */
function shapeBlink(raw, threshold, gain) {
  const scaled = remap(raw * gain, threshold, 0.92, 0, 1);
  return clamp(Math.pow(scaled, 0.72), 0, 1);
}

/** Coarse viseme classification, for avatars that swap discrete mouth art. */
function pickViseme(m) {
  if (m.open < 0.12) return m.smile > 0.35 ? 'smile' : 'rest';
  if (m.pucker > 0.4 || m.funnel > 0.45) return 'U';
  if (m.open > 0.6) return 'A';
  if (m.wide > 0.35 || m.smile > 0.4) return 'I';
  if (m.open > 0.32) return 'E';
  return 'O';
}
