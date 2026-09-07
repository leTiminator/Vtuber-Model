/**
 * Real recordings through the rig: the committed ones and every one saved by
 * the app locally. Every channel stays finite, the head obeys its own speed
 * cap, the eyes stay open through a session where they were open, the
 * calibration read off the recording puts the head at rest and the blinks on
 * screen, and the face latch follows the recorded turns promptly.
 */
import './node-shim.mjs';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE = join(DIR, 'tracker-session.json');
const TILTS = join(DIR, 'tracker-session-2026-09-06.json');
const SESSIONS = join(DIR, 'sessions');
const committed = readdirSync(DIR).filter((f) => /^tracker-session.*\.json$/.test(f)).sort().map((f) => join(DIR, f));
const files = [...committed, ...(existsSync(SESSIONS)
  ? readdirSync(SESSIONS).filter((f) => f.endsWith('.json')).sort().map((f) => join(SESSIONS, f)) : [])]
  .filter((f) => existsSync(f));
if (!files.length) {
  console.log('  --   no recording yet: record one from the app (Camera & tracking -> Record 60 seconds).');
  console.log('\nnothing to replay');
  process.exit(0);
}

const settings = await import('../src/core/store.js');
const { Rig, MAX_HEAD_SLEW, MAX_TORSO_SLEW, BLINK_RISE, RollingMedian } = await import('../src/tracking/rig.js');
const { calibrate } = await import('../src/tracking/calibrate.js');
const { FaceLatch, BACK, BACK_AT, CROSS, LEAVE } = await import('../src/avatars/parts/latch.js');

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const quantile = (a, q) => { const v = [...a].sort((x, y) => x - y); return v[Math.min(v.length - 1, Math.floor(q * v.length))]; };

/** Drive a fresh Rig through a session under the current settings. */
function replay(session) {
  const rig = new Rig();
  let finite = true;
  let worstSlew = 0;
  let worstSlewAt = 0;
  const blink = [];
  const yaw = [];
  const head = [];
  const torso = [];
  let worstTorso = 0;
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
    const beforeTorso = { ...rig.state.torso };
    rig.update(frame, Boolean(s.face), dt);
    rig.updatePose(s.pose ? { joints: s.pose, time: s.t * 1000 } : null, Boolean(s.pose), dt);
    for (const k of ['turn', 'lean', 'rise']) {
      worstTorso = Math.max(worstTorso, Math.abs(rig.state.torso[k] - beforeTorso[k]) / dt);
    }
    torso.push(Math.abs(rig.state.torso.turn - beforeTorso.turn));
    for (const group of Object.values(rig.state)) {
      if (!group || typeof group !== 'object') continue;
      for (const v of Object.values(group)) {
        if (typeof v === 'number' && !Number.isFinite(v)) finite = false;
        if (v && typeof v === 'object') {
          for (const w of Object.values(v)) if (typeof w === 'number' && !Number.isFinite(w)) finite = false;
        }
      }
    }
    for (const k of ['yaw', 'pitch', 'roll']) {
      const slew = Math.abs(rig.state.head[k] - before[k]) / dt;
      if (slew > worstSlew) { worstSlew = slew; worstSlewAt = s.t; }
    }
    if (s.face) {
      blink.push(Math.max(rig.state.eyes.blinkL, rig.state.eyes.blinkR));
      yaw.push(rig.state.head.yaw * 180 / Math.PI);
    }
    head.push({ t: s.t, dt, yaw: rig.state.head.yaw, roll: rig.state.head.roll });
  }
  return { finite, worstSlew, worstSlewAt, blink, yaw, head, torso, worstTorso };
}

/**
 * The face latch driven by a recording's turns, beside the bare threshold
 * crossings it is meant to follow: when each happened, and how long after
 * the angle crossed the latch acted.
 */
function latchTrace(head, hold) {
  const latch = new FaceLatch();
  const crossings = [];
  const changes = [];
  /* The renderer's own rule for which way the turned face looks, so a stale
   * side shows up here as frames where the face and the head disagree. */
  let side = 1;
  let wrongWay = 0;
  let on = true;
  let over = false;
  let lastOver = -Infinity;
  let lastUnder = -Infinity;
  for (const { t, dt, yaw } of head) {
    const turn = Math.abs(yaw);
    if (turn > hold && !over) lastOver = t;
    if (turn < hold * BACK_AT && over) lastUnder = t;
    over = turn > hold ? true : turn < hold * BACK_AT ? false : over;
    const want = on ? turn < hold : turn < hold * BACK_AT;
    if (want !== on) { on = want; crossings.push({ t, on }); }
    const was = latch.on;
    const square = latch.update(yaw, dt, hold, BACK);
    if (square) side = yaw < 0 ? -1 : 1;
    if (latch.on !== was) changes.push({ t, on: latch.on, late: t - (latch.on ? lastUnder : lastOver) });
    if (!square && turn > hold * CROSS && Math.sign(yaw) !== side) wrongWay++;
  }
  return { crossings, changes, wrongWay };
}

/**
 * Which tracked frames are calm: the raw blink score is not rising over its
 * own recent baseline, so whatever the rig shows there is lid droop, not a
 * blink. Same window as the rig's own detector.
 */
function calmFrames(session) {
  const idx = Object.fromEntries(session.shapeKeys.map((k, i) => [k, i]));
  const base = new RollingMedian(0.7);
  const calm = [];
  for (const s of session.samples) {
    if (!s.face) continue;
    const raw = Math.max(s.face.shapes[idx.eyeBlinkLeft] ?? 0, s.face.shapes[idx.eyeBlinkRight] ?? 0);
    calm.push(raw - base.push(raw, s.t) <= BLINK_RISE[0]);
  }
  return calm;
}

/** Blink events: the driven blink crossing up through 0.6, reset below 0.3. */
function blinkEvents(blink) {
  let events = 0;
  let shut = false;
  for (const b of blink) {
    if (b > 0.6 && !shut) { events++; shut = true; }
    if (b < 0.3) shut = false;
  }
  return events;
}

for (const file of files) {
  const session = JSON.parse(readFileSync(file, 'utf8'));
  console.log(`\n=== ${basename(file)}: ${session.seconds}s, ${session.samples?.length} frames, recorded ${session.recorded}`);
  check('the recording has frames', Array.isArray(session.samples) && session.samples.length > 30,
    `${session.samples?.length ?? 0} frames over ${session.seconds ?? '?'}s`);
  check('the recording saw a face', (session.withFace ?? 0) > session.samples.length * 0.5,
    `${session.withFace} of ${session.samples.length} frames`);

  settings.reset();
  settings.set('camera.neutral', '');
  const plain = replay(session);
  check('every rig channel stays finite through the session', plain.finite);
  check('the head never turns faster than the rig\'s own speed cap', plain.worstSlew <= MAX_HEAD_SLEW * 1.01,
    `fastest ${plain.worstSlew.toFixed(2)} rad/s at ${plain.worstSlewAt.toFixed(1)}s, cap ${MAX_HEAD_SLEW}`);
  const calm = calmFrames(session);
  const atRest = (blink) => blink.filter((_, i) => calm[i]);
  const shutPct = (100 * atRest(plain.blink).filter((b) => b > 0.5).length) / Math.max(atRest(plain.blink).length, 1);
  check('the eyes stay open through the frames where they were open', shutPct < 10,
    `shut in ${shutPct.toFixed(1)}% of the ${atRest(plain.blink).length} calm frames`);

  // --- what the recording calibrates ----------------------------------------
  const mirror = session.settings?.['camera.mirror'] ?? true;
  const { patch, report } = calibrate(session, { mirror, settings: settings.snapshot() });
  if (!patch) {
    check('a recording with a face calibrates', false, report.join(' '));
    continue;
  }
  const neutral = JSON.parse(patch['camera.neutral']);
  check('the calibration gives a finite neutral and settings inside their slider ranges',
    ['yaw', 'pitch', 'roll', 'x', 'y', 'z'].every((k) => Number.isFinite(neutral[k]))
      && (patch['eyes.blinkThreshold'] === undefined || (patch['eyes.blinkThreshold'] >= 0.05 && patch['eyes.blinkThreshold'] <= 0.85))
      && (patch['eyes.gazeLid'] === undefined || (patch['eyes.gazeLid'] >= 0 && patch['eyes.gazeLid'] <= 1)),
    Object.entries(patch).filter(([k]) => k !== 'camera.neutral').map(([k, v]) => `${k} ${v}`).join(', ') || 'neutral only');

  settings.set('eyes.autoBlink', false);
  const defaults = replay(session);
  settings.patch(patch);
  const tuned = replay(session);
  settings.set('eyes.autoBlink', true);
  const yawMedian = quantile(tuned.yaw, 0.5);
  check('with its own neutral applied the head rests within 2° of forward', Math.abs(yawMedian) < 2,
    `driven yaw median ${yawMedian.toFixed(1)}° (was ${quantile(defaults.yaw, 0.5).toFixed(1)}° with no neutral)`);
  const rest = atRest(tuned.blink);
  check('calibrated, the eyes read open on the calm frames', quantile(rest, 0.5) < 0.1 && quantile(rest, 0.9) < 0.25,
    `blink median ${quantile(rest, 0.5).toFixed(2)}, p90 ${quantile(rest, 0.9).toFixed(2)} over ${rest.length} calm frames `
      + `(defaults: median ${quantile(atRest(defaults.blink), 0.5).toFixed(2)}, p90 ${quantile(atRest(defaults.blink), 0.9).toFixed(2)})`);
  const events = blinkEvents(tuned.blink);
  console.log(`       blinks on screen with auto-blink off: ${events} calibrated, ${blinkEvents(defaults.blink)} with defaults`);

  // --- the body ---------------------------------------------------------------
  // The pose model puts out the odd frame with the shoulders somewhere else
  // entirely; the body follows at a body's pace or not at all.
  check('the body never moves faster than a body can', tuned.worstTorso <= MAX_TORSO_SLEW * 1.01,
    `fastest ${tuned.worstTorso.toFixed(2)} a second, cap ${MAX_TORSO_SLEW}`);

  // --- the face latch on these turns ------------------------------------------
  const hold = settings.get('parts.headOnHold');
  const trace = latchTrace(tuned.head, hold);
  const leaves = trace.changes.filter((c) => !c.on);
  const returns = trace.changes.filter((c) => c.on);
  const slowest = (list) => list.reduce((m, c) => Math.max(m, c.late), 0);
  console.log(`       face latch: ${trace.changes.length} changes for ${trace.crossings.length} threshold crossings; `
    + `slowest leave ${slowest(leaves).toFixed(2)}s, slowest return ${slowest(returns).toFixed(2)}s after the crossing`);
  check('the face gives way within a few frames of a real turn', leaves.every((c) => c.late <= LEAVE + 0.1),
    `slowest ${slowest(leaves).toFixed(2)}s, allowed ${(LEAVE + 0.1).toFixed(2)}s`);
  check('the face comes back once the head has sat square', returns.every((c) => c.late <= BACK + 0.1),
    `slowest ${slowest(returns).toFixed(2)}s, allowed ${(BACK + 0.1).toFixed(2)}s`);
  check('the turned face never looks the way the head is not', trace.wrongWay === 0,
    `${trace.wrongWay} frames of ${tuned.head.length} facing the wrong way`);
  check('the latch follows the turns without flickering',
    trace.changes.length <= trace.crossings.length && trace.changes.length * 2 >= trace.crossings.length,
    `${trace.changes.length} changes, ${trace.crossings.length} crossings`);

  // --- tilt ---------------------------------------------------------------------
  const rollLimit = settings.get('head.rollLimitDeg') * Math.PI / 180;
  const rollMax = tuned.head.reduce((m, h) => Math.max(m, Math.abs(h.roll)), 0);
  check('the head never tilts past its own limit', rollMax <= rollLimit + 1e-6,
    `furthest ${(rollMax * 180 / Math.PI).toFixed(1)}°, limit ${settings.get('head.rollLimitDeg')}°`);
  if (file === TILTS) {
    // The owner tilted their head on purpose in this minute: -44° for twelve
    // seconds and +29° for six, steady to a degree or two, shoulders leaning
    // with them. The rig reports the tilt and stops at its limit.
    check('the recorded tilts reach the tilt limit and hold there', rollMax >= rollLimit * 0.98
      && tuned.head.filter((h) => Math.abs(h.roll) >= rollLimit * 0.98).length > tuned.head.length * 0.15,
      `at the limit in ${(100 * tuned.head.filter((h) => Math.abs(h.roll) >= rollLimit * 0.98).length / tuned.head.length).toFixed(0)}% of frames`);
  }
  if (file === FIXTURE) {
    // Measured on this recording: 34 rises of the raw score in the minute, 17
    // of them as large as this face's full blinks; the rest read as partial.
    // The fixed threshold alone showed one.
    check('the blinks in the owner\'s recording reach the screen', events >= 20, `${events} of 34 rises read as blinks`);
    check('the report says what the camera could not see',
      report.some((l) => /elbow/i.test(l)) && report.some((l) => /Microphone/.test(l)), report.join(' | '));
  }
}

// --- degenerate recordings ---------------------------------------------------
{
  const empty = calibrate({ version: 1, hz: 30, shapeKeys: [], samples: [] });
  check('a recording with no face gives no patch and says why', empty.patch === null && /face/i.test(empty.report.join(' ')));
  const keys = ['eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookDownLeft', 'eyeLookDownRight', 'jawOpen'];
  const flat = calibrate({ version: 1, hz: 30, shapeKeys: keys, recorded: 'test',
    samples: Array.from({ length: 120 }, (_, i) => ({ t: i / 30,
      face: { shapes: [0.5, 0.5, 0.3, 0.3, 0], head: { yaw: 0.1, pitch: 0, roll: 0 }, position: { x: 0, y: 0, z: -50 } },
      pose: null })) });
  check('a recording with no blinks leaves the blink settings alone',
    flat.patch && flat.patch['eyes.blinkThreshold'] === undefined && /No blinks/.test(flat.report.join(' ')));
}

console.log(`\n${failures ? `${failures} failing` : 'replay clean'}`);
process.exit(failures ? 1 : 0);
