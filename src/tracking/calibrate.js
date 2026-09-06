/**
 * Settings read off a recording of the person in front of the camera: where
 * their head rests, how much their lids droop when they look down, and where
 * their eyes read as open. Pure: the panel runs it on the recorder's frames,
 * the suite runs it on a file. Returns a patch for the store and a report in
 * words, or no patch and the reason.
 */
import { BLINK_RISE, REST_LIMIT, shapeBlink } from './rig.js';

const DEG = Math.PI / 180;
/** Frames with a face before a recording says anything; the rig's own bar. */
const NEEDED = 45;

/** The recorder's shape, from its in-memory frames. */
export function sessionFromRecorder(recorder, extra = {}) {
  return JSON.parse(recorder.toJSON(extra));
}

/** Frames with named blendshapes instead of the file's positional arrays. */
export function decodeFrames(session) {
  const keys = session.shapeKeys ?? [];
  return (session.samples ?? []).map((s) => ({
    t: s.t,
    face: s.face ? {
      shapes: Object.fromEntries(keys.map((k, i) => [k, s.face.shapes[i] ?? 0])),
      head: s.face.head,
      position: s.face.position,
    } : null,
    pose: s.pose ?? null,
  }));
}

const sorted = (a) => [...a].sort((x, y) => x - y);
const quantile = (a, q) => { const v = sorted(a); return v[Math.min(v.length - 1, Math.floor(q * v.length))]; };
const median = (a) => quantile(a, 0.5);
const round = (v, d = 2) => Number(v.toFixed(d));

/** Median of the last `size` values at each index. */
function rollingMedian(values, size) {
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = median(values.slice(Math.max(0, i - size + 1), i + 1));
  return out;
}

/**
 * @param {object} session  the recorder's JSON
 * @param {{mirror?: boolean, settings?: object}} [opts]  the mirror the rig
 *   ran with (the neutral is stored in mirrored space) and the current
 *   settings, for the blink gain the threshold is set against
 * @returns {{patch: object|null, report: string[], neutral?: object}}
 */
export function calibrate(session, { mirror = true, settings = {} } = {}) {
  const frames = decodeFrames(session);
  const faced = frames.filter((f) => f.face);
  const report = [];
  const hz = session.hz || 30;

  let dropouts = 0;
  let longest = 0;
  let run = 0;
  for (const f of frames) {
    if (f.face) { run = 0; continue; }
    if (run === 0) dropouts++;
    run++;
    longest = Math.max(longest, run);
  }
  report.push(`Face found in ${Math.round((100 * faced.length) / Math.max(frames.length, 1))}% of `
    + `${frames.length} frames, lost ${dropouts} times, longest ${(longest / hz).toFixed(1)} s.`);
  if (faced.length < NEEDED) {
    report.push(`Only ${faced.length} frames had a face; at least ${NEEDED} are needed. Record again with your face in view.`);
    return { patch: null, report };
  }

  // The neutral, in the space the rig keeps it: mirrored when the camera is.
  const sign = mirror ? -1 : 1;
  const neutral = {
    yaw: sign * median(faced.map((f) => f.face.head.yaw)),
    pitch: median(faced.map((f) => f.face.head.pitch)),
    roll: sign * median(faced.map((f) => f.face.head.roll)),
    x: sign * median(faced.map((f) => f.face.position.x)),
    y: median(faced.map((f) => f.face.position.y)),
    z: median(faced.map((f) => f.face.position.z)),
  };
  for (const [k, limit] of Object.entries(REST_LIMIT)) {
    if (Math.abs(neutral[k]) > limit) {
      report.push(`Resting ${k} of ${Math.round(neutral[k] / DEG)}° is past what a rest can be; held at ${Math.round(limit / DEG)}°.`);
      neutral[k] = Math.sign(neutral[k]) * limit;
    }
  }
  const deg = (r) => `${r >= 0 ? '+' : ''}${Math.round(r / DEG)}°`;
  neutral.from = `recording ${session.recorded ?? ''}`.trim();
  report.push(`Neutral pose: yaw ${deg(sign * neutral.yaw)} pitch ${deg(neutral.pitch)} roll ${deg(sign * neutral.roll)}, `
    + 'measured as you sat through the recording.');
  const patch = { 'camera.neutral': JSON.stringify(neutral) };

  // Blinks: a rise over the eye's own last second. Everything else is lid droop.
  const sh = (f, k) => f.face.shapes[k] ?? 0;
  const blink = faced.map((f) => Math.max(sh(f, 'eyeBlinkLeft'), sh(f, 'eyeBlinkRight')));
  const look = faced.map((f) => (sh(f, 'eyeLookDownLeft') + sh(f, 'eyeLookDownRight')) / 2);
  const base = rollingMedian(blink, hz);
  const rise = blink.map((b, i) => b - base[i]);
  const peaks = []; // the largest rise of each blink
  let inPeak = false;
  for (let i = 0; i < rise.length; i++) {
    if (rise[i] > BLINK_RISE[0]) {
      if (!inPeak) { peaks.push(rise[i]); inPeak = true; } else peaks[peaks.length - 1] = Math.max(peaks[peaks.length - 1], rise[i]);
    } else if (rise[i] < BLINK_RISE[0] / 2) inPeak = false;
  }
  const calm = rise.map((r, i) => (r <= BLINK_RISE[0] ? i : -1)).filter((i) => i >= 0);
  const mean = (a) => a.reduce((p, q) => p + q, 0) / Math.max(a.length, 1);
  const mb = mean(calm.map((i) => blink[i]));
  const ml = mean(calm.map((i) => look[i]));
  let sxy = 0;
  let sxx = 0;
  for (const i of calm) { sxy += (blink[i] - mb) * (look[i] - ml); sxx += (look[i] - ml) ** 2; }
  const gazeLid = sxx > 1e-6 ? Math.min(Math.max(sxy / sxx, 0), 1) : 0;
  const gain = settings['eyes.blinkGain'] ?? 1.35;
  const restP90 = quantile(calm.map((i) => Math.max(0, blink[i] - gazeLid * look[i])), 0.9);
  const threshold = Math.min(0.85, Math.max(0.05, restP90 * gain + 0.02));
  const full = peaks.filter((r) => r >= BLINK_RISE[1]).length;
  if (peaks.length) {
    patch['eyes.gazeLid'] = round(gazeLid);
    patch['eyes.blinkThreshold'] = round(threshold);
    report.push(`Eyes: your lids read ${Math.round(100 * median(blink))}% shut at rest, so the open threshold `
      + `moves to ${round(threshold)} and looking down is discounted by ${round(gazeLid)}. `
      + `${peaks.length} blinks in the recording; ${full} of them read as full blinks, the rest as partial.`);
  } else {
    report.push('No blinks found in the recording, so the blink settings are left as they are.');
  }
  void shapeBlink;

  // What software cannot fix, said plainly.
  const jaw = quantile(faced.map((f) => sh(f, 'jawOpen')), 0.99);
  if (jaw < 0.05) report.push('Speech: the camera never saw your jaw open. Set Speech → Driven by to Microphone.');
  const posed = frames.filter((f) => f.pose);
  if (posed.length) {
    const inFrame = (k) => posed.filter((f) => f.pose[k] && f.pose[k].y <= 1).length / posed.length;
    const elbows = (inFrame('elbowL') + inFrame('elbowR')) / 2;
    const wrists = (inFrame('wristL') + inFrame('wristR')) / 2;
    if (elbows < 0.5 || wrists < 0.5) {
      report.push(`Arms: elbows in frame ${Math.round(100 * elbows)}% of the time, wrists ${Math.round(100 * wrists)}%. `
        + 'Move the camera back or down until the readout stops saying out of frame; nothing tracks an arm it cannot see.');
    }
  }
  return { patch, report, neutral };
}
