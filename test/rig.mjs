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

console.log(`\n${failures ? `${failures} failing` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
