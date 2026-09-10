/**
 * Guided calibration: five poses read off the head, one prompt each. The
 * first is the neutral, where you look while you stream; the next four are
 * how far you turn, which set the turn and nod gains so your comfortable
 * extreme reaches the model's. Pure: it is fed the same head and position
 * the rig keeps its neutral in, and hands back a settings patch.
 */
import { clamp, DEG } from '../core/math.js';
import { PoseCapture } from './capture.js';

export const STEPS = [
  { key: 'neutral', arm: 3, timeout: 20,
    prompt: 'Sit as you do when you stream and look where you usually look: your screen, not the camera. Hold still.' },
  { key: 'left', arm: 1.5, timeout: 12, axis: 'yaw',
    prompt: 'Turn your head to the LEFT, as far as you would while streaming. Hold it there.' },
  { key: 'right', arm: 1.5, timeout: 12, axis: 'yaw', prompt: 'Now to the RIGHT. Hold it there.' },
  { key: 'up', arm: 1.5, timeout: 12, axis: 'pitch', prompt: 'Look UP. Hold it there.' },
  { key: 'down', arm: 1.5, timeout: 12, axis: 'pitch', prompt: 'Look DOWN. Hold it there.' },
  { key: 'mouth', arm: 2, hold: 2.5, timeout: 15,
    prompt: 'Now open your mouth WIDE, as if something surprised you. Hold it open.' },
];
/** Below this the mouth never read as open at all, and nothing is set from it. */
export const MOUTH_FLOOR = 0.12;
/** A turn smaller than this is not a turn, and the step keeps waiting. */
export const MIN_TURN = 8 * DEG;
/** Where a comfortable extreme lands on the model: a turn, and a nod. */
export const TARGET_YAW = 38 * DEG;
export const TARGET_PITCH = 28 * DEG;
const GAIN_RANGE = [0.5, 2.5];

export class Guide {
  constructor(clock = 0) {
    this.index = 0;
    this.stepStart = clock;
    this.capture = new PoseCapture();
    this.neutral = null;
    this.turns = {};
    this.mouthPeak = 0;
    this.done = false;
    this.cancelled = false;
  }

  get step() {
    return STEPS[this.index] ?? null;
  }

  /** How many prompts there are, for "3 of 6". */
  get total() {
    return STEPS.length;
  }

  /** What to show: the prompt, the seconds before sampling starts, and whether it is over. */
  status(clock) {
    const step = this.step;
    if (!step) return { key: 'done', prompt: '', secondsLeft: 0, done: true };
    return {
      key: step.key,
      prompt: step.prompt,
      secondsLeft: Math.max(0, this.stepStart + step.arm - clock),
      done: false,
    };
  }

  cancel() {
    this.cancelled = true;
    this.done = true;
    this.index = STEPS.length;
  }

  /** Feed one frame; `head` and `pos` are null when there is no face. */
  update(head, pos, clock, mouthOpen = 0) {
    const step = this.step;
    if (!step || this.done) return;
    const armAt = this.stepStart + step.arm;
    if (clock < armAt) return;
    const late = clock - armAt > step.timeout;
    if (step.key === 'mouth') {
      // The widest it got, however the mouth is being driven: a camera that
      // can see a jaw, or a microphone where a beard hides one.
      this.mouthPeak = Math.max(this.mouthPeak, mouthOpen);
      if (clock - armAt >= step.hold || late) this.advance(clock);
      return;
    }
    const got = head && pos ? this.capture.push(head, pos) : null;
    if (step.key === 'neutral') {
      if (!got || (!got.steady && !late)) return;
      this.neutral = got.pose;
      this.advance(clock);
      return;
    }
    if (got?.steady) {
      const delta = got.pose[step.axis] - this.neutral[step.axis];
      if (Math.abs(delta) >= MIN_TURN) {
        this.turns[step.key] = delta;
        this.advance(clock);
        return;
      }
    }
    if (late) {
      this.turns[step.key] = null;
      this.advance(clock);
    }
  }

  advance(clock) {
    this.index++;
    this.stepStart = clock;
    this.capture.reset();
    if (this.index >= STEPS.length) this.done = true;
  }

  /** The settings the five poses call for, and what was measured, in words. */
  result() {
    if (!this.neutral || this.cancelled) return { patch: null, report: ['Calibration was not completed.'], range: null };
    const deg = (r) => `${r >= 0 ? '+' : ''}${Math.round(r / DEG)}°`;
    const extent = (a, b) => Math.max(Math.abs(this.turns[a] ?? 0), Math.abs(this.turns[b] ?? 0));
    const range = Object.fromEntries(['left', 'right', 'up', 'down']
      .map((k) => [k, this.turns[k] == null ? null : Math.round(Math.abs(this.turns[k]) / DEG)]));
    const patch = { 'camera.neutral': JSON.stringify({ ...this.neutral, from: 'guided' }), 'camera.range': JSON.stringify(range) };
    const report = [`Neutral pose: yaw ${deg(this.neutral.yaw)} pitch ${deg(this.neutral.pitch)} roll ${deg(this.neutral.roll)}.`];
    const turned = (k) => (range[k] == null ? 'not measured' : `${range[k]}°`);
    report.push(`Turn: left ${turned('left')}, right ${turned('right')}. Nod: up ${turned('up')}, down ${turned('down')}.`);
    if (this.mouthPeak >= MOUTH_FLOOR) {
      // Surprise starts halfway to the widest it saw and is full just under it,
      // so the face the owner actually pulls reaches the top of the range.
      patch['face.surpriseAt'] = Math.round(this.mouthPeak * 0.5 * 100) / 100;
      patch['face.surpriseFull'] = Math.round(this.mouthPeak * 0.9 * 100) / 100;
      report.push(`Surprise: your mouth opened to ${Math.round(this.mouthPeak * 100)}%, so it `
        + `starts at ${Math.round(patch['face.surpriseAt'] * 100)}% and is full at `
        + `${Math.round(patch['face.surpriseFull'] * 100)}%.`);
    } else {
      report.push('Surprise: your mouth never read as open. With a beard the camera cannot see '
        + 'a jaw — set Speech → Driven by to Microphone and run this again.');
    }
    const yaw = extent('left', 'right');
    if (yaw > 0) {
      patch['head.yawGain'] = Math.round(clamp(TARGET_YAW / yaw, ...GAIN_RANGE) * 100) / 100;
      report.push(`Turn gain ${patch['head.yawGain']}: your ${Math.round(yaw / DEG)}° reaches the model's ${Math.round(TARGET_YAW / DEG)}°.`);
    }
    const pitch = extent('up', 'down');
    if (pitch > 0) {
      patch['head.pitchGain'] = Math.round(clamp(TARGET_PITCH / pitch, ...GAIN_RANGE) * 100) / 100;
      report.push(`Nod gain ${patch['head.pitchGain']}: your ${Math.round(pitch / DEG)}° reaches the model's ${Math.round(TARGET_PITCH / DEG)}°.`);
    }
    return { patch, report, range };
  }
}
