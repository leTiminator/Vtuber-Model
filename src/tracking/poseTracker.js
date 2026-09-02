/**
 * Upper-body tracking, for the arms.
 *
 * The face model has no shoulders — it knows where your head is and nothing
 * below it — so raising your hands off the keyboard needs a second model. This
 * one returns 33 body landmarks; only six matter here.
 *
 * It shares the face tracker's video element rather than opening its own
 * camera: two getUserMedia streams from one device is asking for trouble, and
 * there is no reason for the two models to see different frames.
 *
 * Inference runs on a stride, not every frame, and the stride adapts to what
 * the model actually costs on this machine. Arms move slowly; frame rate is
 * visible. So a weak laptop should update the arms less often rather than
 * stutter the whole avatar, and that trade only works if the cost is measured
 * instead of guessed — the same model is a few milliseconds on a GPU and
 * hundreds in software.
 */
import { PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const WASM_PATH = `${import.meta.env.BASE_URL}mediapipe/wasm`;
const MODEL_PATH = `${import.meta.env.BASE_URL}models/pose_landmarker.task`;

/** The only landmarks this rig cares about. */
export const JOINT = {
  shoulderL: 11, shoulderR: 12,
  elbowL: 13, elbowR: 14,
  wristL: 15, wristR: 16,
  hipL: 23, hipR: 24,
};

export class PoseTracker {
  constructor() {
    this.landmarker = null;
    this.enabled = false;
    this.loading = null;
    this.frame = null;
    this.hasPose = false;
    this.stride = 2; // frames between inferences; adapts to measured cost
    this.counter = 0;
    this.lastTimestamp = -1;
    this.error = null;
    /** Share of a 60 Hz frame pose is allowed to average, in ms. */
    this.budgetMs = 3.5;
    this.costMs = 0; // EMA of one inference
    this.maxStride = 12; // ~5 arm updates a second at worst; still smooth
    this.rate = 0; // measured inferences per second, for the panel readout
    this.recent = [];
  }

  async load() {
    if (this.landmarker) return this.landmarker;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
      for (const delegate of ['GPU', 'CPU']) {
        try {
          this.landmarker = await PoseLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: MODEL_PATH, delegate },
            runningMode: 'VIDEO',
            numPoses: 1,
            minPoseDetectionConfidence: 0.5,
            minPosePresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
          });
          return this.landmarker;
        } catch (err) {
          if (delegate === 'CPU') throw err;
          console.warn('pose GPU delegate unavailable, retrying on CPU:', err.message);
        }
      }
    })();

    try {
      return await this.loading;
    } catch (err) {
      this.error = err.message;
      this.loading = null;
      throw err;
    }
  }

  async setEnabled(on) {
    this.enabled = on;
    if (!on) {
      this.hasPose = false;
      this.frame = null;
      return;
    }
    await this.load();
  }

  /**
   * @param {HTMLVideoElement} video  the face tracker's element, already playing
   * @param {number} now              the same timestamp the face tracker used
   */
  detect(video, now) {
    if (!this.enabled || !this.landmarker || video.readyState < 2) return;
    if (this.counter++ % this.stride !== 0) return;

    let ts = Math.round(now);
    if (ts <= this.lastTimestamp) ts = this.lastTimestamp + 1;
    this.lastTimestamp = ts;

    let result;
    const started = performance.now();
    try {
      result = this.landmarker.detectForVideo(video, ts);
    } catch (err) {
      console.error('pose detection failed', err);
      return;
    }

    // Cheap machines get a wider stride, fast ones narrow it back. The EMA
    // keeps one slow frame — a garbage collection, a window resize — from
    // throwing the rate away.
    // Inference rate, over a short window — the honest answer to "are the
    // arms even being looked at", which a stride number alone does not give.
    this.recent.push(now);
    while (this.recent.length && now - this.recent[0] > 2000) this.recent.shift();
    this.rate = this.recent.length / 2;

    const elapsed = performance.now() - started;
    this.costMs = this.costMs === 0 ? elapsed : this.costMs * 0.85 + elapsed * 0.15;
    this.stride = Math.min(Math.max(Math.ceil(this.costMs / this.budgetMs), 1), this.maxStride);

    const points = result.landmarks?.[0];
    if (!points?.length) {
      this.hasPose = false;
      return;
    }

    // Only keep what the rig uses, and only when the model is actually
    // confident: a guessed elbow is worse than no elbow, because the arm will
    // twitch toward wherever it guessed.
    const pick = (index) => {
      const p = points[index];
      if (!p || (p.visibility !== undefined && p.visibility < 0.5)) return null;
      return { x: p.x, y: p.y, z: p.z ?? 0 };
    };

    const joints = {};
    for (const [name, index] of Object.entries(JOINT)) joints[name] = pick(index);

    this.hasPose = Boolean(joints.shoulderL && joints.shoulderR);
    this.frame = { joints, time: now };
  }
}
