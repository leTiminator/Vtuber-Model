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
/* How much further a wrist travels than an elbow on a raised arm, for reading
 * the raise off the elbow when the wrist is out of the picture. */
const ELBOW_RAISE = 1.6;

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
    // read as raising. `raise` is how far the wrist is above the shoulder —
    // or, with no wrist in the picture, how far the elbow is. `seen` is how
    // confidently the shoulder and elbow are tracked, `wrist` the wrist alone.
    arms: {
      left: { upper: 0, fore: 0, raise: 0, seen: 0, wrist: 0 },
      right: { upper: 0, fore: 0, raise: 0, seen: 0, wrist: 0 },
    },
    /* The body's own pose, measured from the shoulders rather than inferred
     * from the head. `seen` is how much the pose model is currently supplying
     * it; where that falls to zero the head takes over again. */
    torso: { turn: 0, lean: 0, rise: 0, seen: 0 },
    expression: { blush: 0, anger: 0, sparkle: 0, sweat: 0, shock: 0 },
    viseme: 'rest',
  };
}

/**
 * What a head can plausibly be resting at, per axis.
 *
 * These were five, twenty-five and ten degrees, off one recorded session that
 * happened to sit square to its camera — yaw median one and a third degrees,
 * so seemingly nothing to correct there and a bad capture the only way to get
 * a large one. A second session, taken at the camera position its owner
 * actually uses, has a resting yaw of twenty-six degrees: the lens is off to
 * one side of the screen, so looking at the screen genuinely is looking that
 * far from the camera. Extremely common, and the tight bound left twenty-one
 * degrees of it uncorrected — parking the model permanently past its own flip,
 * which is the fault the bound was added to prevent.
 *
 * So the bound cannot be what tells a resting pose from a glance. It is only
 * a backstop against a figure no camera placement explains, and the work of
 * telling the two apart belongs to the evidence: a pose has to hold still for
 * a stretch before it is believed. Nobody has to sit square to the lens.
 */
const REST_LIMIT = { yaw: 45 * DEG, pitch: 40 * DEG, roll: 30 * DEG };

/**
 * The saved rest pose, or null. Anything malformed is treated as none.
 *
 * Bounded on the way in as well as on the way out. A neutral saved before
 * these limits existed is still in the browser that saved it and outlives any
 * change to how one is captured — and a thirty-one degree yaw in there leaves
 * the model sitting permanently turned past its own flip, which reads as the
 * model being broken rather than the setup being wrong.
 */
function readNeutral() {
  try {
    const raw = store.get('camera.neutral');
    if (!raw) return null;
    const n = JSON.parse(raw);
    const ok = ['yaw', 'pitch', 'roll', 'x', 'y', 'z'].every((k) => Number.isFinite(n?.[k]));
    if (!ok) return null;
    for (const [k, limit] of Object.entries(REST_LIMIT)) n[k] = clamp(n[k], -limit, limit);
    return n;
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
    // Why the neutral cannot be trusted, when it cannot. Empty when it can.
    this.neutralWarning = '';

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
      // The OBS page builds its rig against an empty store and is told the
      // settings afterwards. Without this it drew with no neutral for as long
      // as the tracker page had one, and the two heads did not match.
      if (key === 'camera.neutral') this.neutral = readNeutral();
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

  /**
   * Capture the resting pose.
   *
   * Everything the head does is measured against this, so getting it wrong
   * does not degrade the model gracefully — it parks it permanently in the
   * worst part of its range. A neutral thirty degrees off means sitting
   * straight reads as a hard turn: the head stays flipped, and the head-on
   * face, which only shows within ten degrees of centre, is never reached at
   * all. That is not hypothetical; it is what a session looked like.
   *
   * It used to take twelve frames — four tenths of a second — the instant the
   * camera started, and average them. Nobody is looking at the lens four
   * tenths of a second after clicking a button; they are looking at the
   * button. So it waited, and now it also refuses.
   *
   * @param {boolean} auto  Fired by the camera starting rather than by a
   *   person asking. An automatic capture has to earn its neutral: it waits,
   *   wants the head reasonably still and reasonably square, and gives up
   *   rather than saving a guess. Asking for it explicitly is taken at face
   *   value — someone with a camera off to one side is entitled to a neutral
   *   that looks turned, and they are the only one who can say so.
   */
  calibrate(auto = false) {
    // A camera restart re-reads the shoulders' rest but never replaces a head
    // neutral somebody already has; only a request does that.
    if (auto && this.neutral) {
      this.armNeutral = null;
      this.torsoNeutral = null;
      return;
    }
    this.pendingCalibration = {
      samples: [],
      // A second and a half at thirty frames, so a blink or a glance is a
      // minority of it rather than all of it.
      needed: 45,
      /* Nothing is sampled until this. A second and a half for an automatic
       * capture, so the camera has settled. Three seconds for a requested one,
       * so whoever pressed the button can look where they mean to look rather
       * than at the button: measured live, a neutral set from the button read
       * thirty-eight degrees from the camera, because the button is on the
       * screen and the camera was not.
       */
      armAt: this.clock + (auto ? 1.5 : 3),
      auto,
      deadline: this.clock + (auto ? 12 : 0),
    };
    this.armNeutral = null; // re-read on the next pose frame
    this.torsoNeutral = null; // and the shoulders' rest with it
    this.neutralWarning = '';
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
      const t = this.state.torso;
      t.seen = damp(t.seen, 0, 3, dt);
      t.turn = damp(t.turn, 0, 3, dt);
      t.lean = damp(t.lean, 0, 3, dt);
      t.rise = damp(t.rise, 0, 3, dt);
      for (const side of ['left', 'right']) {
        const a = arms[side];
        a.seen = damp(a.seen, 0, 4, dt);
        a.wrist = damp(a.wrist, 0, 4, dt);
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

    /* The body, from the shoulders — not from the head.
     *
     * Until now `body.leanX/leanY/twist` were the head's own angles scaled
     * down, so the body could only ever be a smaller copy of wherever the head
     * was pointing. It could not sit square while the head looked away, or sit
     * turned while the head came back to the camera, because it had nothing of
     * its own to be turned by. The pose model has returned both shoulders on
     * every stride the whole time; nothing read them.
     *
     * Three numbers, each from what a shoulder line actually does:
     *
     *  - **turn** from foreshortening. Face on, the shoulders are their full
     *    width apart; turn, and they close up. Signed by which one is nearer
     *    the camera, which the landmarks' own depth says.
     *  - **lean** from where the middle of that line sits across the frame.
     *  - **rise** from where it sits up and down — leaning in and out.
     *
     * All three are measured against a shoulder line captured at rest, for the
     * same reason the head is: a camera off to one side, or shoulders that are
     * not level, is a pose to measure from rather than one to correct.
     */
    const width = Math.hypot(shoulderL.x - shoulderR.x, shoulderL.y - shoulderR.y);
    const depth = (shoulderL.z ?? 0) - (shoulderR.z ?? 0);
    const torsoNow = {
      width,
      turn: 0,
      lean: shoulders.x - 0.5,
      rise: shoulders.y - 0.5,
      depth,
    };
    /* Foreshortening is measured against the shoulder width captured with the
     * rest pose, not the widest ever seen. The widest-ever was a ratchet: lean
     * toward the camera once and the shoulders read wider than they ever will
     * sitting back, so every pose after it read as turned. Measured live, the
     * body held at a quarter turn for a whole session with its owner sitting
     * square. Against the rest width, sitting square is square, and leaning
     * in reads as nothing rather than as "even more square than square".
     */
    const restWidth = this.torsoNeutral?.width ?? width;
    if (restWidth > 0.02) {
      // cos of the turn, near enough, and the sign from which shoulder is nearer.
      const closed = clamp(width / restWidth, 0, 1);
      torsoNow.turn = Math.acos(closed) * Math.sign(depth || 1) * flip;
    }
    if (!this.torsoNeutral) this.torsoNeutral = { ...torsoNow };
    const tn = this.torsoNeutral;
    const tg = store.get('body.shoulderGain');
    const t = this.state.torso;
    t.seen = damp(t.seen, 1, 6, dt);
    t.turn = this.arms.filter('torsoTurn',
      clamp((torsoNow.turn - tn.turn) * tg, -1.4, 1.4), dt);
    t.lean = this.arms.filter('torsoLean',
      clamp((torsoNow.lean - tn.lean) * 4 * tg * flip, -1.5, 1.5), dt);
    t.rise = this.arms.filter('torsoRise',
      clamp((torsoNow.rise - tn.rise) * 4 * tg, -1.5, 1.5), dt);

    const gain = store.get('arms.gain');
    const measured = {};

    const solve = (shoulder, elbow, wrist, key) => {
      const a = arms[key];
      if (!shoulder || !elbow) {
        // Held where it was, not zeroed: a joint at the edge of the frame
        // comes and goes several times a second, and an arm that answered
        // each loss by dropping would shake.
        a.seen = damp(a.seen, 0, 4, dt);
        a.wrist = damp(a.wrist, 0, 4, dt);
        return;
      }
      a.seen = damp(a.seen, 1, 8, dt);
      a.wrist = damp(a.wrist, wrist ? 1 : 0, 6, dt);

      let ux = elbow.x - shoulder.x;
      let uy = elbow.y - shoulder.y;
      const ulen = Math.hypot(ux, uy) || 1;
      ux /= ulen; uy /= ulen;
      const upper = this.arms.filter(
        `${key}Upper`, clamp(signedAngle(axisX, axisY, ux, uy) * flip, -Math.PI, Math.PI), dt);

      /* The wrist is the joint most often out of the picture.
       *
       * Measured on a real minute at a desk: one wrist absent in every frame,
       * the other present in six per cent of them, the elbows below the
       * bottom edge more than half the time. A missing wrist used to read as a
       * wrist at zero — a measurement, not an absence — so an arm whose hand
       * drifted out of frame jumped to wherever "zero minus the rest pose"
       * put it, and an arm whose hand drifted back in jumped again. That is
       * the twitch that was reported as arm tracking not working.
       *
       * What is not seen is not measured. The forearm angle and the wrist's
       * height are null without a wrist; how high the elbow sits is always
       * there, and says most of the same thing about a raised arm.
       */
      let fore = null;
      let raise = null;
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
      const lift = this.arms.filter(`${key}Lift`,
        clamp((shoulder.y - elbow.y) / span, -1.5, 2), dt);

      measured[key] = { upper, fore, raise, lift };

      // Everything downstream wants a *change* from how you normally sit, not
      // an absolute angle: the artwork already has arms drawn somewhere, and
      // the rig rotates them away from there. Without this, resting hands on
      // the keyboard would hold the drawn arms permanently bent.
      //
      // Each quantity has its own rest, adopted the first time it is actually
      // measured — a rest pose captured with the hands out of frame has no
      // opinion about where the wrists sit until it has seen them.
      const rest = this.armNeutral?.[key];
      if (rest) {
        if (rest.fore == null && fore != null) rest.fore = fore;
        if (rest.raise == null && raise != null) rest.raise = raise;
      }
      a.upper = (upper - (rest?.upper ?? 0)) * gain;
      if (fore != null) a.fore = (fore - (rest?.fore ?? fore)) * gain;
      /* Raise from the wrist while there is one, from the elbow's height when
       * there is not. The two agree at rest by construction and roughly
       * elsewhere — the wrist travels about half again as far as the elbow on
       * a raised arm — and the change between them is eased rather than cut,
       * so a hand at the edge of the frame does not make the arm stutter.
       */
      const fromWrist = raise != null && rest?.raise != null ? (raise - rest.raise) * gain : null;
      const fromElbow = (lift - (rest?.lift ?? lift)) * gain * ELBOW_RAISE;
      a.raise = damp(a.raise, fromWrist ?? fromElbow, 14, dt);
    };

    solve(shoulderL, elbowL, wristL, 'left');
    solve(shoulderR, elbowR, wristR, 'right');

    // First good look at both arms after a calibrate becomes the rest pose.
    // Whatever the wrists were doing is filled in the first time they show.
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
    if (this.clock < cal.armAt) return;
    cal.samples.push({ ...head, px: pos.x, py: pos.y, pz: pos.z });
    if (cal.samples.length < cal.needed) return;

    /* The middle sample, not the average of them.
     *
     * An average is moved by anything that happens during the window; a median
     * is not moved by a glance away unless the glance is most of the window.
     */
    const mid = (k) => {
      const v = cal.samples.map((s) => s[k]).sort((a, b) => a - b);
      return v[v.length >> 1];
    };
    const spread = (k) => {
      const v = cal.samples.map((s) => s[k]);
      return Math.max(...v) - Math.min(...v);
    };

    /* Steadiness is what separates a resting pose from a glance.
     *
     * Not how far round it is — a camera beside the screen puts a perfectly
     * ordinary working pose twenty-six degrees off the lens, and refusing that
     * is refusing the pose somebody actually sits in. What a glance cannot do
     * is hold still, so that is the thing worth waiting for.
     */
    const STILL = 12 * DEG;
    const steady = spread('yaw') < STILL && spread('pitch') < STILL;
    if (cal.auto && !steady) {
      cal.samples = [];
      if (this.clock < cal.deadline) return;
      /* Past the deadline it gives up, as promised above. It used to save the
       * median of whatever it had at that point — a head that never held
       * still — and that guess then stood as "forward" for the whole session,
       * with no warning, because a guess inside the per-axis bounds looks
       * exactly like a pose. Nothing is better than a guess here: with no
       * neutral the model follows the camera's own frame, and the readout
       * says what to do.
       */
      this.pendingCalibration = null;
      this.neutralWarning = 'no steady pose found to set as neutral — press C sitting the way you stream';
      return;
    }

    /* Bounded to what a resting head can actually be, one axis at a time.
     *
     * Measured on a real session rather than assumed. Sitting at a desk, yaw
     * comes out at a median of one and a third degrees — the tracker reads
     * square when you are square, and there is nothing there to correct. Pitch
     * does not: the median is seventeen degrees down, because that is where
     * the screen is. Roll is half a degree.
     *
     * So a captured neutral is worth almost nothing on yaw and a great deal on
     * pitch, and the failure that was actually reported — a neutral thirty-one
     * degrees round, taken while the person was looking away, leaving the model
     * permanently turned past its own flip — is a capture writing over a signal
     * that was already right.
     *
     * Bounding each axis by what that axis plausibly rests at makes a bad
     * capture harmless instead of ruinous, which is better than demanding a
     * careful one. Nobody should have to hold still to be looked at.
     */
    const held = (k) => clamp(mid(k), -REST_LIMIT[k], REST_LIMIT[k]);
    const raw = { yaw: mid('yaw'), pitch: mid('pitch'), roll: mid('roll') };

    this.neutral = {
      yaw: held('yaw'), pitch: held('pitch'), roll: held('roll'),
      x: mid('px'), y: mid('py'), z: mid('pz'),
    };
    this.pendingCalibration = null;
    const trimmed = Object.keys(REST_LIMIT).some((k) => Math.abs(raw[k] - this.neutral[k]) > 1e-4);
    this.neutralWarning = trimmed
      ? 'that pose read further round than any camera placement explains — set it again while sitting normally'
      : '';
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
    /* The tracker's pitch runs the opposite way to this rig's.
     *
     * Measured, finally, the only way that settles it: two photographs of the
     * running app, one looking up and one looking down, with the head found by
     * connected components rather than by a colour guess. Looking down put the
     * head seventy-seven pixels HIGHER on screen than looking up. Every check
     * I could run here said the sign was right, which only means none of them
     * were testing the thing the person in front of the camera could see.
     *
     * Corrected here, in code, rather than by changing the default of a
     * setting — a browser that has already saved a setting keeps its value
     * forever, so a changed default reaches nobody who has run the app.
     */
    const PITCH_SIGN = -1;
    // Inverted here rather than at the renderer, so everything downstream —
    // the cloth's idea of where the head went, the hair's lag — agrees with
    // what is on screen.
    const pitch = (head.pitch - (n?.pitch ?? 0)) * PITCH_SIGN * g('head.pitchGain')
      * (g('head.flipNod') ? -1 : 1);
    const roll = (head.roll - (n?.roll ?? 0)) * g('head.rollGain');
    // Tilt has a limit of its own — see head.rollLimitDeg.
    const rollLimit = g('head.rollLimitDeg') * DEG;

    s.head.yaw = this.pose.filter('yaw', clamp(yaw, -limit, limit), dt);
    s.head.pitch = this.pose.filter('pitch', clamp(pitch, -limit, limit), dt);
    s.head.roll = this.pose.filter('roll', clamp(roll, -rollLimit, rollLimit), dt);

    // Translation arrives in centimetres; normalise to roughly -1..1 of frame.
    const pg = g('head.positionGain');
    s.head.x = this.pose.filter('px', clamp(((pos.x - (n?.x ?? 0)) / 14) * pg, -1.5, 1.5), dt);
    s.head.y = this.pose.filter('py', clamp(((pos.y - (n?.y ?? 0)) / 14) * pg, -1.5, 1.5), dt);
    s.head.z = this.pose.filter('pz', clamp(((pos.z - (n?.z ?? -45)) / 30) * pg, -1.5, 1.5), dt);

    /* --- eyes ------------------------------------------------------------
     *
     * The lid follows the eye, and the tracker cannot tell the difference.
     *
     * Look down with your eyes wide open and the upper lid comes down with
     * your gaze, covering the iris exactly as the start of a blink does — and
     * the blink weight rises accordingly. Measured on a recorded session: the
     * blink signal correlates +0.79 with the eyes looking down, climbing from
     * 0.15 to 0.64 as the gaze drops, and every one of the twelve highest
     * "blink" frames in that session is a wide-open eye looking down at
     * something. It shut the model's eyes in 105 frames out of 247 — nearly
     * half the time — with nobody blinking at all.
     *
     * So the part of the lid that the gaze accounts for is not a blink, and is
     * taken back out. A real blink survives it: the strongest genuine one in
     * that session still clears the shut threshold with room to spare, because
     * a blink closes the lid much further than looking down ever does.
     */
    const lidFromGaze = (sh('eyeLookDownLeft') + sh('eyeLookDownRight')) / 2
      * clamp(g('eyes.gazeLid'), 0, 1);
    const deLid = (v) => Math.max(0, v - lidFromGaze);

    const blinkGain = g('eyes.blinkGain');
    const thresh = g('eyes.blinkThreshold');
    let bl = shapeBlink(deLid(sh('eyeBlinkLeft')), thresh, blinkGain);
    let br = shapeBlink(deLid(sh('eyeBlinkRight')), thresh, blinkGain);
    if (g('eyes.linkBlinks')) {
      // Winks read as tracking noise on most rigs; take the stronger eye for both.
      const both = Math.max(bl, br);
      bl = br = both;
    }
    s.eyes.blinkL = this.face.filter('blinkL', bl, dt);
    s.eyes.blinkR = this.face.filter('blinkR', br, dt);
    // Squint narrows the eye the same way and is contaminated the same way —
    // it tracks the blink weight at +0.71 through the same recording.
    s.eyes.squintL = this.face.filter('squintL', deLid(sh('eyeSquintLeft')), dt);
    s.eyes.squintR = this.face.filter('squintR', deLid(sh('eyeSquintRight')), dt);
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

    /* The shoulders drive the body where they are seen; the head does where
     * they are not.
     *
     * Blended by how confidently the pose model has them rather than switched,
     * so losing the pose for a moment does not throw the body across the
     * screen. Where it is seen, the head's own contribution goes away
     * completely — that is the point: the body is meant to be able to sit at
     * an angle the head is not at, and a head term left in would keep dragging
     * it back to wherever the face is pointing.
     */
    const t = s.torso;
    const fromBody = clamp(t.seen, 0, 1);
    const leanTarget = lerp(s.head.yaw * follow, t.lean, fromBody) + swayX * swayAmt;
    const riseTarget = lerp(s.head.pitch * follow * 0.7, t.rise, fromBody) + swayY * swayAmt;
    const twistTarget = lerp(s.head.roll * follow * 0.8, t.turn, fromBody);
    spring(this.springs.leanX, leanTarget, 90, 13, dt);
    spring(this.springs.leanY, riseTarget, 90, 13, dt);
    spring(this.springs.twist, twistTarget, 80, 12, dt);

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
