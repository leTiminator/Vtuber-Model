/**
 * Unit tests for the rig's signal handling. These run headless, with no
 * camera and no browser, by feeding synthetic tracker frames straight in.
 *
 *   node test/rig.mjs
 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

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

/* --- calibration zeroes a resting offset --------------------------------- */
{
  settings.reset();
  const rig = new Rig();
  const offset = frame({ head: { yaw: 0.30, pitch: 0.12 } });
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

/* --- which physical hand drives which side of the screen ------------------
 * This is the one thing a headless run cannot check by pointing a camera at a
 * person, and it is the easiest thing in the whole rig to get backwards. It is
 * decidable in code, though, because every step is known:
 *
 *   - A camera faces you, so your physical RIGHT hand lands on the LEFT of the
 *     raw image: a small x. MediaPipe labels that same hand `wristR` (16).
 *   - "Mirror me" means the avatar behaves like a reflection, and a reflection
 *     raises the hand on the same side of the image as the hand you raised.
 *     Raise your right hand at a mirror and the hand that goes up is on your
 *     right as you look at it.
 *   - So a raised wrist at small x must end up on the RIGHT of the screen.
 *
 * The renderer drives the screen-right arm (`armRight`, at x 0.87 in the
 * artwork) from `rig.arms.left`, because after mirroring `left` means the
 * character's own left — and a character facing you wears its left on your
 * right. So the assertion is: small x raised => arms.left.raise goes positive.
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

console.log(`\n${failures ? `${failures} failing` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
