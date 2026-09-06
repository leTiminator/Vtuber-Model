/**
 * A pose read off a live head: the median of a run of frames, steady when yaw
 * and pitch stay inside STILL. One definition of steady for C and the guide.
 */
import { DEG } from '../core/math.js';

/** Frames in a run: a second and a half at thirty, so a blink is a minority of it. */
export const NEEDED = 45;
/** The most yaw or pitch may wander within a run that still counts as steady. */
export const STILL = 12 * DEG;

export class PoseCapture {
  constructor({ needed = NEEDED, still = STILL } = {}) {
    this.needed = needed;
    this.still = still;
    this.samples = [];
  }

  reset() {
    this.samples = [];
  }

  /** One tracked frame in; null until the run is complete, then its median pose and steadiness. */
  push(head, pos) {
    this.samples.push({ yaw: head.yaw, pitch: head.pitch, roll: head.roll, x: pos.x, y: pos.y, z: pos.z });
    if (this.samples.length < this.needed) return null;
    const column = (k) => this.samples.map((s) => s[k]);
    const spread = (k) => { const v = column(k); return Math.max(...v) - Math.min(...v); };
    const mid = (k) => { const v = column(k).sort((a, b) => a - b); return v[v.length >> 1]; };
    const pose = { yaw: mid('yaw'), pitch: mid('pitch'), roll: mid('roll'), x: mid('x'), y: mid('y'), z: mid('z') };
    const steady = spread('yaw') < this.still && spread('pitch') < this.still;
    this.samples = [];
    return { pose, steady };
  }
}
