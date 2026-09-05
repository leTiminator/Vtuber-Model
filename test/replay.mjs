/**
 * Replays a recorded tracker session through the rig, in Node.
 *
 * Every other check feeds the rig a sweep somebody wrote by hand, so each one
 * encodes an assumption about what a camera produces. This one has no
 * assumptions in it: it is what a camera actually produced, sixty seconds of
 * it. Skips, loudly, when no recording has been added.
 *
 *   node test/replay.mjs
 */
import './node-shim.mjs';
import { readFileSync, existsSync } from 'node:fs';

const FIXTURE = new URL('./fixtures/tracker-session.json', import.meta.url);
if (!existsSync(FIXTURE)) {
  console.log('  --   no recording yet: test/fixtures/tracker-session.json is missing.');
  console.log('       Record one from the app: Camera & tracking -> Record 60 seconds.');
  console.log('\nnothing to replay');
  process.exit(0);
}

const settings = await import('../src/core/store.js');
const { Rig, MAX_HEAD_SLEW } = await import('../src/tracking/rig.js');
const session = JSON.parse(readFileSync(FIXTURE, 'utf8'));

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

check('the recording has frames', Array.isArray(session.samples) && session.samples.length > 30,
  `${session.samples?.length ?? 0} frames over ${session.seconds ?? '?'}s`);
check('the recording saw a face', (session.withFace ?? 0) > session.samples.length * 0.5,
  `${session.withFace} of ${session.samples.length} frames`);

settings.reset();
const rig = new Rig();
rig.clearCalibration();

let finite = true;
let tracked = 0;
let shutFrames = 0;
let worstSlew = 0;
let worstSlewAt = 0;
let prevT = session.samples[0]?.t ?? 0;
for (const s of session.samples) {
  const dt = clamp(s.t - prevT, 1 / 240, 1 / 15);
  prevT = s.t;
  const frame = s.face ? {
    shapes: Object.fromEntries(session.shapeKeys.map((k, i) => [k, s.face.shapes[i] ?? 0])),
    head: s.face.head,
    position: s.face.position,
    time: s.t * 1000,
  } : null;
  const before = { ...rig.state.head };
  rig.update(frame, Boolean(s.face), dt);
  rig.updatePose(s.pose ? { joints: s.pose, time: s.t * 1000 } : null, Boolean(s.pose), dt);

  for (const group of Object.values(rig.state)) {
    if (!group || typeof group !== 'object') continue;
    for (const v of Object.values(group)) {
      if (typeof v === 'number' && !Number.isFinite(v)) finite = false;
      if (v && typeof v === 'object') {
        for (const w of Object.values(v)) if (typeof w === 'number' && !Number.isFinite(w)) finite = false;
      }
    }
  }
  // The rig's own speed cap, in the units it applies it: radians per second.
  for (const k of ['yaw', 'pitch', 'roll']) {
    const slew = Math.abs(rig.state.head[k] - before[k]) / dt;
    if (slew > worstSlew) { worstSlew = slew; worstSlewAt = s.t; }
  }
  if (s.face) {
    tracked++;
    if (Math.max(rig.state.eyes.blinkL, rig.state.eyes.blinkR) > 0.5) shutFrames++;
  }
}

check('every rig channel stays finite through the session', finite);
check('the head never turns faster than the rig\'s own speed cap', worstSlew <= MAX_HEAD_SLEW * 1.01,
  `fastest ${worstSlew.toFixed(2)} rad/s at ${worstSlewAt.toFixed(1)}s, cap ${MAX_HEAD_SLEW}`);
/* Eyes open, because they were open. The lid follows the gaze and the tracker
 * reports that as a blink; the rig discounts it. Nobody blinks for a tenth of
 * a minute, so a tenth is the line. */
const shutPct = (100 * shutFrames) / Math.max(tracked, 1);
check('the eyes stay open through a session where they were open', shutPct < 10,
  `shut in ${shutFrames} of ${tracked} tracked frames (${shutPct.toFixed(1)}%)`);

console.log(`\n${failures ? `${failures} failing` : 'replay clean'}`);
process.exit(failures ? 1 : 0);
