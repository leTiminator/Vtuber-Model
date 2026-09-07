/**
 * Unit tests for the rig's signal handling. These run headless, with no
 * camera and no browser, by feeding synthetic tracker frames straight in.
 */
import './node-shim.mjs';

const settings = await import('../src/core/store.js');
const { Rig } = await import('../src/tracking/rig.js');

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

const DT = 1 / 60;
const frame = (over = {}) => ({
  shapes: { ...over.shapes },
  head: { yaw: 0, pitch: 0, roll: 0, ...over.head },
  position: { x: 0, y: 0, z: -45, ...over.position },
});

const run = (rig, n, f, tracked = true) => {
  let last;
  for (let i = 0; i < n; i++) last = rig.update(f, tracked, DT);
  return last;
};

/* --- auto-blink must reopen the eyes -------------------------------------
 * Regression: while untracked, auto-blink merged with Math.max against a
 * channel nothing else drove down, so the first blink shut the eyes for good.
 */
{
  settings.reset();
  const rig = new Rig();
  let min = 1;
  let max = 0;
  for (let i = 0; i < 1800; i++) {
    const state = rig.update(null, false, DT);
    if (i > 300) {
      min = Math.min(min, state.eyes.blinkL);
      max = Math.max(max, state.eyes.blinkL);
    }
  }
  check('idle eyes reopen after an auto-blink', min < 0.1, `min blink ${min.toFixed(3)}`);
  check('idle eyes still blink at all', max > 0.6, `max blink ${max.toFixed(3)}`);
}

/* --- mirroring swaps left and right -------------------------------------- */
{
  settings.reset();
  settings.set('eyes.linkBlinks', false);
  settings.set('camera.mirror', true);
  const rig = new Rig();
  // The subject closes their own left eye.
  const state = run(rig, 200, frame({ shapes: { eyeBlinkLeft: 1, eyeBlinkRight: 0 } }));
  check('mirrored, a left-eye blink drives the avatar\'s right',
    state.eyes.blinkR > 0.6 && state.eyes.blinkL < 0.2,
    `L=${state.eyes.blinkL.toFixed(2)} R=${state.eyes.blinkR.toFixed(2)}`);
}
{
  settings.reset();
  settings.set('eyes.linkBlinks', false);
  settings.set('camera.mirror', false);
  const rig = new Rig();
  const state = run(rig, 200, frame({ shapes: { eyeBlinkLeft: 1, eyeBlinkRight: 0 } }));
  check('unmirrored, the same blink stays on the left',
    state.eyes.blinkL > 0.6 && state.eyes.blinkR < 0.2,
    `L=${state.eyes.blinkL.toFixed(2)} R=${state.eyes.blinkR.toFixed(2)}`);
}

/* --- yaw sign: mirrored output must oppose the camera -------------------- */
{
  settings.reset();
  const rig = new Rig();
  const state = run(rig, 200, frame({ head: { yaw: 0.4 } }));
  check('mirroring flips head yaw', state.head.yaw < -0.1, `yaw ${state.head.yaw.toFixed(3)}`);
}

/* --- calibration zeroes a resting offset, within reason ------------------ */
{
  settings.reset();
  const rig = new Rig();
  const offset = frame({ head: { yaw: 0.06, pitch: 0.25 } });
  run(rig, 120, offset);
  rig.calibrate();
  const state = run(rig, 400, offset);
  check('calibration removes a resting head offset',
    Math.abs(state.head.yaw) < 0.05 && Math.abs(state.head.pitch) < 0.05,
    `yaw ${state.head.yaw.toFixed(3)} pitch ${state.head.pitch.toFixed(3)}`);
}

/* --- head range is clamped ----------------------------------------------- */
{
  settings.reset();
  settings.set('head.limitDeg', 30);
  const rig = new Rig();
  const state = run(rig, 400, frame({ head: { yaw: 2.5, pitch: -2.5 } }));
  const limit = (30 * Math.PI) / 180 + 1e-6;
  check('head rotation stays inside the configured limit',
    Math.abs(state.head.yaw) <= limit && Math.abs(state.head.pitch) <= limit,
    `yaw ${state.head.yaw.toFixed(3)} limit ${limit.toFixed(3)}`);
}

/* --- tilt has a limit of its own ----------------------------------------- */
{
  settings.reset();
  const rig = new Rig();
  const state = run(rig, 400, frame({ head: { yaw: 2.5, roll: 2.5 } }));
  const rollLimit = (25 * Math.PI) / 180 + 1e-6;
  const yawLimit = (42 * Math.PI) / 180 + 1e-6;
  check('tilt stops at its own limit while the turn keeps the wider one',
    Math.abs(state.head.roll) <= rollLimit && Math.abs(state.head.roll) > rollLimit - 0.02
      && Math.abs(state.head.yaw) > rollLimit + 0.1 && Math.abs(state.head.yaw) <= yawLimit,
    `roll ${state.head.roll.toFixed(3)} yaw ${state.head.yaw.toFixed(3)}`);
}

/* --- an automatic neutral gives up rather than guessing ------------------ */
{
  settings.reset();
  const rig = new Rig();
  rig.calibrate(true);
  // A head that never holds still: a glance every third of a second.
  for (let i = 0; i < 60 * 15; i++) {
    rig.update(frame({ head: { yaw: (Math.floor(i / 20) % 2) * 0.5 } }), true, DT);
  }
  check('an unsteady automatic capture saves nothing and says so',
    rig.pendingCalibration === null && rig.neutral === null && /steady/.test(rig.neutralWarning),
    `neutral ${JSON.stringify(rig.neutral)} — ${rig.neutralWarning || 'no warning'}`);

  // A requested one waits three seconds first, so the person can look where
  // they mean to, and then takes what it sees.
  const rig2 = new Rig();
  rig2.calibrate();
  run(rig2, 120, frame({ head: { yaw: 0.3 } }));
  check('a requested capture has not sampled during its countdown',
    rig2.neutral === null && rig2.pendingCalibration !== null,
    `neutral ${JSON.stringify(rig2.neutral)}`);
  run(rig2, 120, frame({ head: { yaw: 0.1 } }));
  check('and takes the pose held after it',
    rig2.neutral !== null && Math.abs(Math.abs(rig2.neutral.yaw) - 0.1) < 0.02,
    `neutral yaw ${rig2.neutral?.yaw.toFixed(3)}`);
}

/* --- a neutral written to the store reaches a rig already built ----------- */
{
  settings.reset();
  const rig = new Rig();
  settings.set('camera.neutral', JSON.stringify({ yaw: 0.3, pitch: 0.1, roll: 0, x: 0, y: 0, z: -45 }));
  check('the OBS page\'s rig picks up a neutral sent after it was built',
    rig.neutral !== null && Math.abs(rig.neutral.yaw - 0.3) < 1e-6,
    `neutral ${JSON.stringify(rig.neutral)}`);
  settings.reset();
}

/* --- Flip nod reverses the nod, and only the nod --------------------------- */
{
  settings.reset();
  const plain = run(new Rig(), 200, frame({ head: { pitch: 0.3, yaw: 0.2 } }));
  settings.set('head.flipNod', true);
  const flipped = run(new Rig(), 200, frame({ head: { pitch: 0.3, yaw: 0.2 } }));
  check('Flip nod reverses the pitch the renderer is given',
    Math.abs(plain.head.pitch) > 0.1 && Math.abs(flipped.head.pitch + plain.head.pitch) < 1e-6,
    `pitch ${plain.head.pitch.toFixed(3)} then ${flipped.head.pitch.toFixed(3)}`);
  check('and leaves the turn alone', Math.abs(flipped.head.yaw - plain.head.yaw) < 1e-6,
    `yaw ${plain.head.yaw.toFixed(3)} then ${flipped.head.yaw.toFixed(3)}`);
  settings.reset();
}

/* --- restarting the camera keeps a neutral somebody set ------------------- */
{
  settings.reset();
  settings.set('camera.neutral', JSON.stringify({ yaw: 0.3, pitch: 0.1, roll: 0, x: 0, y: 0, z: -45 }));
  const rig = new Rig();
  rig.calibrate(true); // what a camera start or a device change does
  run(rig, 600, frame({ head: { yaw: 0 } }));
  check('an automatic capture never replaces a neutral that exists',
    rig.pendingCalibration === null && rig.neutral !== null && Math.abs(rig.neutral.yaw - 0.3) < 1e-6,
    `neutral ${JSON.stringify(rig.neutral)}`);
  rig.calibrate(); // but asking for one does
  run(rig, 400, frame({ head: { yaw: 0 } }));
  check('while a requested capture replaces it',
    rig.neutral !== null && Math.abs(rig.neutral.yaw) < 0.02,
    `neutral yaw ${rig.neutral?.yaw.toFixed(3)}`);
  settings.reset();
}

/* --- losing the face relaxes rather than freezing ------------------------ */
{
  settings.reset();
  const rig = new Rig();
  run(rig, 200, frame({ head: { yaw: 0.4 }, shapes: { jawOpen: 1 } }));
  let state;
  for (let i = 0; i < 400; i++) state = rig.update(null, false, DT);
  check('the pose eases back to rest when the face is lost',
    Math.abs(state.head.yaw) < 0.02 && state.mouth.open < 0.05,
    `yaw ${state.head.yaw.toFixed(3)} mouth ${state.mouth.open.toFixed(3)}`);
}

/* --- mic drives the mouth when selected ---------------------------------- */
{
  settings.reset();
  settings.set('mouth.source', 'mic');
  const rig = new Rig();
  rig.setMicLevel(0.12);
  const state = run(rig, 200, frame());
  check('mic loudness opens the mouth channel', state.mouth.open > 0.4,
    `open ${state.mouth.open.toFixed(3)}`);
}

/* --- a long stalled frame must not explode the springs ------------------- */
{
  settings.reset();
  const rig = new Rig();
  run(rig, 60, frame({ head: { yaw: 0.4 } }));
  const state = rig.update(frame({ head: { yaw: -0.4 } }), true, 3.0); // 3s stall
  const finite = Object.values(state.body).every(Number.isFinite) &&
                 Object.values(state.head).every(Number.isFinite);
  check('a multi-second frame stall keeps every channel finite', finite,
    `leanX ${state.body.leanX.toFixed(3)}`);
}

/* --- arm tracking ---------------------------------------------------------
 * Pose frames are synthetic here: a figure facing the camera, shoulders level,
 * hips below. Coordinates are MediaPipe's normalised image space, so +y is
 * *down* the picture.
 */
const posed = ({ lw, le, rw, re } = {}) => ({
  joints: {
    shoulderL: { x: 0.40, y: 0.40 }, shoulderR: { x: 0.60, y: 0.40 },
    elbowL: le ?? { x: 0.36, y: 0.58 }, elbowR: re ?? { x: 0.64, y: 0.58 },
    wristL: lw ?? { x: 0.38, y: 0.74 }, wristR: rw ?? { x: 0.62, y: 0.74 },
    hipL: { x: 0.44, y: 0.78 }, hipR: { x: 0.56, y: 0.78 },
  },
  time: 0,
});

const runPose = (rig, n, f, has = true) => {
  for (let i = 0; i < n; i++) rig.updatePose(f, has, DT);
  return rig.state;
};

{
  settings.reset();
  const rig = new Rig();
  // Hands on the keyboard is the rest pose, so it must read as no movement.
  const rest = runPose(rig, 120, posed());
  check('resting arms sit at zero', Math.abs(rest.arms.left.upper) < 0.02 &&
    Math.abs(rest.arms.left.raise) < 0.02,
    `upper ${rest.arms.left.upper.toFixed(3)} raise ${rest.arms.left.raise.toFixed(3)}`);

  // Both hands up beside the head: wrists above the shoulders.
  const up = runPose(rig, 240, posed({
    le: { x: 0.30, y: 0.36 }, re: { x: 0.70, y: 0.36 },
    lw: { x: 0.34, y: 0.18 }, rw: { x: 0.66, y: 0.18 },
  }));
  check('raising both hands drives raise positive',
    up.arms.left.raise > 0.4 && up.arms.right.raise > 0.4,
    `L ${up.arms.left.raise.toFixed(2)} R ${up.arms.right.raise.toFixed(2)}`);
  check('raising an arm swings the upper arm away from the torso',
    Math.abs(up.arms.left.upper) > 0.5 && Math.abs(up.arms.right.upper) > 0.5,
    `L ${up.arms.left.upper.toFixed(2)} R ${up.arms.right.upper.toFixed(2)}`);
  check('left and right swing in opposite directions',
    up.arms.left.upper * up.arms.right.upper < 0,
    `L ${up.arms.left.upper.toFixed(2)} R ${up.arms.right.upper.toFixed(2)}`);
}

/* --- leaning is not raising ----------------------------------------------
 * Angles are measured against the torso axis for exactly this reason: tip the
 * whole body sideways and the arms have not moved relative to it.
 */
{
  settings.reset();
  const rig = new Rig();
  runPose(rig, 120, posed());
  const lean = (dx) => ({
    joints: {
      shoulderL: { x: 0.40 + dx, y: 0.40 }, shoulderR: { x: 0.60 + dx, y: 0.40 },
      elbowL: { x: 0.36 + dx * 0.6, y: 0.58 }, elbowR: { x: 0.64 + dx * 0.6, y: 0.58 },
      wristL: { x: 0.38 + dx * 0.2, y: 0.74 }, wristR: { x: 0.62 + dx * 0.2, y: 0.74 },
      hipL: { x: 0.44, y: 0.78 }, hipR: { x: 0.56, y: 0.78 },
    },
    time: 0,
  });
  const tilted = runPose(rig, 240, lean(0.12));
  check('leaning the torso barely moves the arms',
    Math.abs(tilted.arms.left.upper) < 0.12 && Math.abs(tilted.arms.right.upper) < 0.12,
    `L ${tilted.arms.left.upper.toFixed(3)} R ${tilted.arms.right.upper.toFixed(3)}`);
}

/* --- losing the pose must return the arms to rest, not freeze them ------- */
{
  settings.reset();
  const rig = new Rig();
  runPose(rig, 120, posed());
  const up = runPose(rig, 240, posed({
    le: { x: 0.30, y: 0.36 }, re: { x: 0.70, y: 0.36 },
    lw: { x: 0.34, y: 0.18 }, rw: { x: 0.66, y: 0.18 },
  }));
  check('the arms are actually raised before the pose is dropped', up.arms.left.raise > 0.4,
    `raise ${up.arms.left.raise.toFixed(3)}`);
  const gone = runPose(rig, 240, null, false);
  const settled = Object.values(gone.arms.left).every((v) => Math.abs(v) < 0.02);
  check('arms relax when the pose is lost', settled,
    `raise ${gone.arms.left.raise.toFixed(3)} seen ${gone.arms.left.seen.toFixed(3)}`);
}

/* --- gain scales the result, and zero gain pins it ------------------------ */
{
  settings.reset();
  const raised = posed({
    le: { x: 0.30, y: 0.36 }, re: { x: 0.70, y: 0.36 },
    lw: { x: 0.34, y: 0.18 }, rw: { x: 0.66, y: 0.18 },
  });
  const at = (gain) => {
    settings.set('arms.gain', gain);
    const rig = new Rig();
    runPose(rig, 120, posed());
    return runPose(rig, 240, raised).arms.left.raise;
  };
  const one = at(1);
  const half = at(0.5);
  check('arm gain scales travel',
    one > 0.4 && Math.abs(half - one / 2) < 0.02 && Math.abs(at(0)) < 1e-9,
    `1x ${one.toFixed(3)} 0.5x ${half.toFixed(3)}`);
  settings.reset();
}

/* --- every channel stays finite through junk input ----------------------- */
{
  settings.reset();
  const rig = new Rig();
  const degenerate = {
    joints: {
      shoulderL: { x: 0.5, y: 0.5 }, shoulderR: { x: 0.5, y: 0.5 },
      elbowL: { x: 0.5, y: 0.5 }, elbowR: null,
      wristL: null, wristR: { x: 0.5, y: 0.5 },
      hipL: { x: 0.5, y: 0.5 }, hipR: { x: 0.5, y: 0.5 },
    },
    time: 0,
  };
  const state = runPose(rig, 120, degenerate);
  const finite = ['left', 'right'].every((side) =>
    Object.values(state.arms[side]).every(Number.isFinite));
  check('coincident landmarks keep the arm channels finite', finite,
    `L upper ${state.arms.left.upper}`);
}

/* --- a hand leaving the frame is not a hand at zero -----------------------
 * Measured on the recorded minute this project has, the wrists were out of
 * the picture in every frame and the elbows below its bottom edge in most. A
 * missing wrist used to be read as a wrist at zero, so an arm whose hand
 * drifted out of frame jumped to "zero minus the rest pose" and jumped back
 * when it returned — the twitch reported as arm tracking not working.
 */
{
  settings.reset();
  const rig = new Rig();
  runPose(rig, 120, posed());
  const up = posed({
    le: { x: 0.30, y: 0.36 }, re: { x: 0.70, y: 0.36 },
    lw: { x: 0.34, y: 0.18 }, rw: { x: 0.66, y: 0.18 },
  });
  const withWrist = runPose(rig, 240, up).arms.left.raise;
  const noWrist = { ...up, joints: { ...up.joints, wristL: null, wristR: null } };
  const lost = runPose(rig, 240, noWrist).arms.left;
  check('losing the wrists keeps a raised arm raised',
    lost.raise > 0.4 && lost.raise > withWrist * 0.5,
    `raise ${lost.raise.toFixed(2)} without wrists, ${withWrist.toFixed(2)} with`);
  check('the readout can tell a wrist is gone from an arm that is not',
    lost.wrist < 0.05 && lost.seen > 0.95,
    `wrist ${lost.wrist.toFixed(2)} seen ${lost.seen.toFixed(2)}`);

  // A rest pose captured with the hands out of frame must not push the arms
  // anywhere when the hands first show up, resting.
  const rig2 = new Rig();
  const restNoWrist = { ...posed(), joints: { ...posed().joints, wristL: null, wristR: null } };
  runPose(rig2, 120, restNoWrist);
  const appeared = runPose(rig2, 120, posed()).arms.left;
  check('wrists appearing at rest read as no movement',
    Math.abs(appeared.raise) < 0.05 && Math.abs(appeared.fore) < 0.05,
    `raise ${appeared.raise.toFixed(3)} fore ${appeared.fore.toFixed(3)}`);
}

/* --- the body's turn is measured against the shoulders at rest ------------
 * It used to be measured against the widest shoulder line ever seen, which is
 * a ratchet: lean toward the camera once and every later pose reads as turned.
 * Measured live, the body sat at a quarter turn all session with its owner
 * square to the camera.
 */
{
  settings.reset();
  const rig = new Rig();
  const shoulders = (w) => ({
    joints: {
      shoulderL: { x: 0.5 - w / 2, y: 0.40, z: 0 }, shoulderR: { x: 0.5 + w / 2, y: 0.40, z: 0 },
      elbowL: { x: 0.36, y: 0.58 }, elbowR: { x: 0.64, y: 0.58 },
      wristL: { x: 0.38, y: 0.74 }, wristR: { x: 0.62, y: 0.74 },
      hipL: { x: 0.44, y: 0.78 }, hipR: { x: 0.56, y: 0.78 },
    },
    time: 0,
  });
  runPose(rig, 120, shoulders(0.20));
  const rest = rig.state.torso.turn;
  runPose(rig, 240, shoulders(0.14));
  const turned = rig.state.torso.turn;
  runPose(rig, 240, shoulders(0.26));
  const leaned = rig.state.torso.turn;
  runPose(rig, 240, shoulders(0.20));
  const back = rig.state.torso.turn;
  check('narrower shoulders read as a turn',
    Math.abs(rest) < 0.02 && Math.abs(turned) > 0.3,
    `rest ${rest.toFixed(3)} turned ${turned.toFixed(3)}`);
  check('leaning in past the rest width is not a turn, and does not become one',
    Math.abs(leaned) < 0.05 && Math.abs(back) < 0.05,
    `leaned ${leaned.toFixed(3)} back at rest ${back.toFixed(3)}`);
}

/* --- which physical hand drives which side of the screen ------------------
 * This is the one thing a headless run cannot check by pointing a camera at a
 * person, and it is the easiest thing in the whole rig to get backwards. It is
 * decidable in code, though, because every step is known:
 */
{
  const raisedOnRawLeft = {
    joints: {
      // Physically: the right hand is up, the left hand rests on the keyboard.
      shoulderL: { x: 0.40, y: 0.40 }, shoulderR: { x: 0.60, y: 0.40 },
      elbowR: { x: 0.30, y: 0.36 }, wristR: { x: 0.34, y: 0.18 }, // small x, raised
      elbowL: { x: 0.64, y: 0.58 }, wristL: { x: 0.62, y: 0.74 }, // resting
      hipL: { x: 0.44, y: 0.78 }, hipR: { x: 0.56, y: 0.78 },
    },
    time: 0,
  };

  settings.reset();
  settings.set('camera.mirror', true);
  const mirrored = new Rig();
  runPose(mirrored, 120, posed());
  const m = runPose(mirrored, 240, raisedOnRawLeft);
  check('mirrored, the hand on the raw image\'s left drives the screen-right arm',
    m.arms.left.raise > 0.4 && m.arms.right.raise < 0.15,
    `arms.left ${m.arms.left.raise.toFixed(2)} (drives armRight), arms.right ${m.arms.right.raise.toFixed(2)}`);

  // Unmirrored, the avatar copies you rather than reflecting you, so the same
  // raised hand has to come out on the other side.
  settings.reset();
  settings.set('camera.mirror', false);
  const direct = new Rig();
  runPose(direct, 120, posed());
  const d = runPose(direct, 240, raisedOnRawLeft);
  check('unmirrored, the same hand drives the screen-left arm instead',
    d.arms.right.raise > 0.4 && d.arms.left.raise < 0.15,
    `arms.right ${d.arms.right.raise.toFixed(2)} (drives armLeft), arms.left ${d.arms.left.raise.toFixed(2)}`);
  settings.reset();
}

/* --- a face lost briefly is a face that moved, not a face that left --------
 * Someone in a cap loses tracking every time they look down, for a second or
 * two at a time. Decaying to neutral on the way would make the model look up
 * exactly when they look down, and snap back when tracking returns.
 */
{
  settings.reset();
  const rig = new Rig();
  const looking = frame({ head: { yaw: 0.5, pitch: -0.4 } });
  const held = run(rig, 200, looking);
  const yawWhileTracked = held.head.yaw;
  check('the head follows while tracked', Math.abs(yawWhileTracked) > 0.3,
    `yaw ${yawWhileTracked.toFixed(2)}`);

  // Under a second: the pose should barely move.
  let state;
  for (let i = 0; i < 50; i++) state = rig.update(null, false, DT);
  check('a short dropout holds the pose',
    Math.abs(state.head.yaw - yawWhileTracked) < 0.05 &&
    Math.abs(state.head.pitch) > 0.1,
    `yaw ${state.head.yaw.toFixed(2)} was ${yawWhileTracked.toFixed(2)}, pitch ${state.head.pitch.toFixed(2)}`);

  // Expressions are not held: a smile left on an empty chair is worse.
  const smiling = run(new Rig(), 120, frame({ shapes: { mouthSmileLeft: 0.9, mouthSmileRight: 0.9 } }));
  const smileWhileTracked = smiling.mouth.smile;
  const rig2 = new Rig();
  run(rig2, 120, frame({ shapes: { mouthSmileLeft: 0.9, mouthSmileRight: 0.9 } }));
  let after;
  for (let i = 0; i < 50; i++) after = rig2.update(null, false, DT);
  check('expressions let go even while the pose is held',
    after.mouth.smile < smileWhileTracked * 0.6,
    `smile ${after.mouth.smile.toFixed(2)} from ${smileWhileTracked.toFixed(2)}`);

  // Gone for good: it does return to neutral.
  for (let i = 0; i < 700; i++) state = rig.update(null, false, DT);
  check('a long absence still returns the head to neutral',
    Math.abs(state.head.yaw) < 0.05 && Math.abs(state.head.pitch) < 0.05,
    `yaw ${state.head.yaw.toFixed(3)} pitch ${state.head.pitch.toFixed(3)}`);
}

/* --- an off-axis camera is a normal setup, not a bad capture -------------- */
{
  settings.reset();
  const offAxis = new Rig();
  // The resting pose from a real session: twenty-six degrees off the lens,
  // twenty-two down at the screen. Driven through the real path rather than
  // written straight into storage, because a captured baseline is recorded
  // after the tracker's own mirroring and a hand-written one gets that wrong.
  const working = frame({ head: { yaw: -0.457, pitch: -0.39, roll: 0.11 } });
  run(offAxis, 120, working);
  offAxis.calibrate();
  const state = run(offAxis, 400, working);
  check('a camera off to one side keeps its whole baseline',
    Math.abs(offAxis.neutral.yaw) > 0.4,
    `baseline yaw ${(offAxis.neutral.yaw * 180 / Math.PI).toFixed(1)}°`);
  check('so sitting at that camera reads as facing it',
    Math.abs(state.head.yaw) < 0.05 && Math.abs(state.head.pitch) < 0.05,
    `yaw ${(state.head.yaw * 180 / Math.PI).toFixed(1)}° `
      + `pitch ${(state.head.pitch * 180 / Math.PI).toFixed(1)}°`);

  // A figure no camera placement explains is still refused.
  settings.set('camera.neutral', JSON.stringify(
    { yaw: 1.4, pitch: 0, roll: 0, x: 0, y: 0, z: -45 }));
  const absurd = new Rig();
  check('but a baseline no camera placement explains is still cut back',
    Math.abs(absurd.neutral.yaw) < 1.4 - 1e-6,
    `yaw ${(absurd.neutral.yaw * 180 / Math.PI).toFixed(1)}° from a saved 80.2°`);
  settings.set('camera.neutral', '');
}

/* --- a blink is a rise over the eye's own baseline --------------------- */
{
  const rest = (raw, look = 0) => frame({ shapes: {
    eyeBlinkLeft: raw, eyeBlinkRight: raw, eyeLookDownLeft: look, eyeLookDownRight: look,
  } });
  const peak = (rig, n, f) => {
    let top = 0;
    for (let i = 0; i < n; i++) top = Math.max(top, rig.update(f, true, DT).eyes.blinkL);
    return top;
  };

  settings.reset();
  settings.set('eyes.autoBlink', false);
  const plain = new Rig();
  run(plain, 60, rest(0.05));
  check('a face whose eyes read open blinks fully', peak(plain, 8, rest(0.9)) > 0.8);

  // The owner's face: lids read half down all day, and looking down reads
  // higher still, so the absolute reading alone never sees the blink.
  const droopy = new Rig();
  const atRest = run(droopy, 90, rest(0.55, 0.6));
  check('eyes that always read half shut are open at rest', atRest.eyes.blinkL < 0.15,
    `blink ${atRest.eyes.blinkL.toFixed(2)} at a raw score of 0.55`);
  const top = peak(droopy, 8, rest(0.88, 0.9));
  check('and a blink on that face still reads as a blink', top > 0.6, `peak ${top.toFixed(2)}`);
  const after = run(droopy, 60, rest(0.55, 0.6));
  check('and the eyes reopen afterwards', after.eyes.blinkL < 0.15, `blink ${after.eyes.blinkL.toFixed(2)}`);

  const shut = new Rig();
  run(shut, 60, rest(0.05));
  run(shut, 120, rest(0.9));
  let lowest = 1;
  for (let i = 0; i < 60; i++) lowest = Math.min(lowest, shut.update(rest(0.9), true, DT).eyes.blinkL);
  check('eyes held shut stay shut once the rise has passed into the baseline', lowest > 0.6,
    `lowest ${lowest.toFixed(2)} in the third second`);

  const droop = new Rig();
  let worst = 0;
  for (let i = 0; i < 300; i++) {
    worst = Math.max(worst, droop.update(rest(0.05 + 0.45 * (i / 300), 0.6), true, DT).eyes.blinkL);
  }
  check('a slow droop of the lids over five seconds never reads as a blink', worst < 0.3, `worst ${worst.toFixed(2)}`);
}

/* --- guided calibration: the capture, the guide, the pinned warning ----- */
{
  const { PoseCapture, NEEDED } = await import('../src/tracking/capture.js');
  const { Guide, TARGET_YAW, TARGET_PITCH } = await import('../src/tracking/guide.js');
  const D = Math.PI / 180;
  const head = (yaw = 0, pitch = 0, roll = 0) => ({ yaw, pitch, roll });
  const pos = { x: 0, y: 0, z: -45 };

  const cap = new PoseCapture();
  let got = null;
  for (let i = 0; i < NEEDED - 1; i++) got = cap.push(head(0.3 + (i % 2) * 0.01), pos);
  check('a capture says nothing before its run is complete', got === null);
  got = cap.push(head(0.3), pos);
  check('a steady run yields its median pose', got?.steady && Math.abs(got.pose.yaw - 0.3) < 0.011, JSON.stringify(got?.pose));
  for (let i = 0; i < NEEDED; i++) got = cap.push(head((i % 2) * 20 * D), pos);
  check('a run that wanders twenty degrees is not steady', got && !got.steady);

  const guide = new Guide(0);
  let clock = 0;
  const feed = (h, seconds) => {
    for (let i = 0; i < seconds * 30; i++) { clock += 1 / 30; guide.update(h, h && pos, clock); }
  };
  feed(head(0.3, -0.2), 1);
  const early = guide.status(clock);
  check('the guide counts down before it samples', early.key === 'neutral' && early.secondsLeft > 1.5 && early.secondsLeft < 2.1,
    `${early.secondsLeft.toFixed(2)}s left`);
  feed(head(0.3, -0.2), 4);
  check('sitting still gives the neutral and moves on to the left turn',
    guide.step?.key === 'left' && Math.abs(guide.neutral.yaw - 0.3) < 1e-9 && Math.abs(guide.neutral.pitch + 0.2) < 1e-9,
    `at ${guide.step?.key}`);
  feed(head(0.3 + 5 * D, -0.2), 4);
  check('a five-degree turn is not a turn', guide.step?.key === 'left', `at ${guide.step?.key}`);
  feed(head(0.3 - 35 * D, -0.2), 4);
  check('a held thirty-five-degree turn is taken', guide.step?.key === 'right' && Math.abs(guide.turns.left + 35 * D) < 1e-9,
    `at ${guide.step?.key}, left ${guide.turns.left}`);
  feed(head(0.3 + 29 * D, -0.2), 4);
  feed(head(0.3, -0.2 + 20 * D), 4);
  feed(null, 15);
  check('a step nobody performs times out as not measured', guide.done && guide.turns.down === null,
    `done ${guide.done}, down ${guide.turns.down}`);
  const { patch, report, range } = guide.result();
  const neutral = JSON.parse(patch['camera.neutral']);
  check('the guide\'s neutral is the first pose, marked guided', Math.abs(neutral.yaw - 0.3) < 1e-9 && neutral.from === 'guided');
  check('the turn gain maps the larger turn onto the model\'s target',
    Math.abs(patch['head.yawGain'] - Math.round((TARGET_YAW / (35 * D)) * 100) / 100) < 1e-9, `${patch['head.yawGain']}`);
  check('the nod gain comes from the one nod that was measured',
    Math.abs(patch['head.pitchGain'] - Math.round((TARGET_PITCH / (20 * D)) * 100) / 100) < 1e-9, `${patch['head.pitchGain']}`);
  check('the range is recorded in degrees per side, the missing one empty',
    range.left === 35 && range.right === 29 && range.up === 20 && range.down === null
      && JSON.parse(patch['camera.range']).down === null, JSON.stringify(range));
  check('the report names each pose', /Turn: left 35°, right 29°/.test(report[1]) && /down not measured/.test(report[1]),
    report.join(' | '));

  settings.reset();
  settings.set('camera.mirror', true);
  const rig = new Rig();
  rig.guide = new Guide(rig.clock);
  run(rig, 300, frame({ head: { yaw: 0.25 } }));
  check('through the rig the guide reads the mirrored head, the space the neutral is kept in',
    rig.guide.neutral && Math.abs(rig.guide.neutral.yaw + 0.25) < 1e-9, `${rig.guide.neutral?.yaw}`);

  settings.reset();
  const pinned = new Rig();
  pinned.neutral = { yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, z: -45 };
  run(pinned, 240, frame({ head: { yaw: 1.0 } }));
  check('a head held past the limit for seconds raises the pinned warning',
    /stuck at its limit/.test(pinned.pinnedWarning) && /57°/.test(pinned.pinnedWarning), pinned.pinnedWarning);
  run(pinned, 60, frame({ head: { yaw: 0 } }));
  check('coming back inside the limit clears it', pinned.pinnedWarning === '', pinned.pinnedWarning);
}

/* --- surprise comes from the mouth the app settled on --------------------- */
{
  settings.reset();
  settings.set('mouth.source', 'mic');
  const rig = new Rig();
  rig.setMicLevel(0.2);
  run(rig, 120, frame());
  const loud = rig.state.expression.surprise;
  rig.setMicLevel(0);
  run(rig, 240, frame());
  const quiet = rig.state.expression.surprise;
  check('a mouth held wide open reads as surprise', loud > 0.6, `surprise ${loud.toFixed(2)}`);
  check('and a shut mouth does not', quiet < 0.05, `surprise ${quiet.toFixed(2)}`);

  // The camera drives it the same way where it can see a jaw open.
  settings.reset();
  settings.set('mouth.source', 'camera');
  const seen = new Rig();
  const open = run(seen, 120, frame({ shapes: { jawOpen: 1 } })).expression.surprise;
  check('an open jaw the camera can see drives it too', open > 0.6, `surprise ${open.toFixed(2)}`);

  // Nothing to do with the brows: raising them alone must not fire it.
  settings.reset();
  const brows = new Rig();
  const raised = run(brows, 120, frame({ shapes: { browInnerUp: 1, browOuterUpLeft: 1, browOuterUpRight: 1 } }));
  check('raised eyebrows alone are not surprise', raised.expression.surprise < 0.05,
    `surprise ${raised.expression.surprise.toFixed(2)}`);

  settings.reset();
  settings.set('face.surpriseGain', 0);
  const off = new Rig();
  off.setMicLevel(0.2);
  settings.set('mouth.source', 'mic');
  check('and the gain at zero turns it off',
    run(off, 120, frame()).expression.surprise === 0);
}

console.log(`\n${failures ? `${failures} failing` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
