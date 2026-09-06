/** Records what the trackers saw, so a real session can be replayed in tests. */

/** Keep the file small: three decimals is far below what any of this resolves. */
const round = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);

const roundAll = (obj) => {
  if (!obj) return null;
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = round(v);
  return out;
};

/** Capture rate. Faster than any of this moves; slower is a smaller file. */
const HZ = 30;

export class SessionRecorder {
  constructor() {
    this.frames = [];
    this.recording = false;
    this.startedAt = 0;
    this.seconds = 0;
    this.lastAt = -1;
    // Blendshape names are written once, at the top of the file, and each
    // frame carries bare numbers in that order. Repeating fifty-odd keys on
    // every frame is most of the file and none of the information.
    this.shapeKeys = null;
    this.onTick = () => {};
  }

  get elapsed() {
    return this.recording ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  start(seconds = 20) {
    this.frames = [];
    this.shapeKeys = null;
    this.lastAt = -1;
    this.seconds = seconds;
    this.startedAt = performance.now();
    this.recording = true;
  }

  stop() {
    this.recording = false;
  }

  /**
   * Called once per rendered frame with whatever the trackers currently hold.
   * Landmarks are deliberately dropped — the rig does not use them, and they
   * are the bulk of the data.
   */
  capture(faceFrame, hasFace, poseFrame, hasPose) {
    if (!this.recording) return;
    const t = this.elapsed;
    if (t >= this.seconds) {
      this.stop();
      this.onTick(this);
      return;
    }
    // Sample at a fixed rate rather than at whatever the renderer happens to
    // run at, so the file is the same size on a fast machine as a slow one.
    if (this.lastAt >= 0 && t - this.lastAt < 1 / HZ) return;
    this.lastAt = t;

    let face = null;
    if (hasFace && faceFrame) {
      if (!this.shapeKeys) this.shapeKeys = Object.keys(faceFrame.shapes ?? {}).sort();
      face = {
        shapes: this.shapeKeys.map((k) => round(faceFrame.shapes?.[k] ?? 0)),
        head: roundAll(faceFrame.head),
        position: roundAll(faceFrame.position),
      };
    }

    let pose = null;
    if (hasPose && poseFrame?.joints) {
      pose = {};
      for (const [name, p] of Object.entries(poseFrame.joints)) {
        pose[name] = p ? { x: round(p.x), y: round(p.y), z: round(p.z) } : null;
      }
    }

    this.frames.push({ t: Math.round(t * 1000) / 1000, face, pose });
    this.onTick(this);
  }

  /** The recording as a file the test suite can read back. */
  toJSON(extra = {}) {
    const withFace = this.frames.filter((f) => f.face).length;
    const withPose = this.frames.filter((f) => f.pose).length;
    return JSON.stringify({
      version: 1,
      recorded: new Date().toISOString().slice(0, 10),
      seconds: Math.round((this.frames.at(-1)?.t ?? 0) * 100) / 100,
      frames: this.frames.length,
      withFace,
      withPose,
      hz: HZ,
      note: 'Tracker output only — blendshape weights, head angles, body landmarks. No image data.',
      shapeKeys: this.shapeKeys ?? [],
      ...extra,
      samples: this.frames,
    });
  }

  save(extra) {
    const blob = new Blob([this.toJSON(extra)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'tracker-session.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  }
}
