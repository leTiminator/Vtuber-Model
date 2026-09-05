/**
 * Webcam capture + MediaPipe FaceLandmarker.
 *
 * Emits a raw frame object per detection: 52 ARKit-style blendshape scores,
 * plus head rotation and position decoded from the facial transformation
 * matrix. Everything downstream reads that object and never touches MediaPipe.
 */
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { clamp, eulerFromMatrix, translationFromMatrix } from '../core/math.js';
import * as store from '../core/store.js';

const WASM_PATH = `${import.meta.env.BASE_URL}mediapipe/wasm`;
const MODEL_PATH = `${import.meta.env.BASE_URL}models/face_landmarker.task`;

export class FaceTracker {
  constructor() {
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;

    this.landmarker = null;
    this.stream = null;
    this.running = false;
    this.lastTimestamp = -1;
    this.frame = null;
    this.hasFace = false;
    this.lostSince = 0;
    this.fps = 0;
    this._fpsEma = 0;
    this._lastFrameAt = 0;
    this.status = 'idle';
    this.error = null;
    this.onFrame = () => {};
    this.onStatus = () => {};
  }

  setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    this.onStatus(status, error);
  }

  async loadModel() {
    if (this.landmarker) return this.landmarker;
    this.setStatus('loading-model');
    const vision = await FilesetResolver.forVisionTasks(WASM_PATH);

    // GPU is much faster but is not available everywhere (some Linux setups,
    // remote desktops, locked-down GPU drivers). Fall back rather than fail.
    for (const delegate of ['GPU', 'CPU']) {
      try {
        this.landmarker = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_PATH, delegate },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
          /* Hard to find, easy to keep.
           *
           * Measured on a recorded session at the camera position its owner
           * actually uses: the face was there for seventy-one per cent of a
           * minute, and the gaps were not flickers — twenty-eight of them, the
           * longest a second and a half. Losing the lock for that long is the
           * model freezing and then drifting back to its rest pose, over and
           * over, which is far more visible than a slightly noisy landmark.
           *
           * The reason it is hard here is the geometry, not the distance: a
           * lens off to one side of the screen and a head looking down at the
           * screen is a compound angle of about thirty-five degrees, and that
           * is where a face detector gets least confident.
           *
           * So finding a face still takes real evidence, and keeping one takes
           * much less. The failure that costs is the second kind.
           */
          minFaceDetectionConfidence: 0.5,
          minFacePresenceConfidence: 0.3,
          minTrackingConfidence: 0.3,
        });
        this.delegate = delegate;
        return this.landmarker;
      } catch (err) {
        if (delegate === 'CPU') throw err;
        console.warn('GPU delegate unavailable, retrying on CPU:', err.message);
      }
    }
  }

  static async listCameras() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  }

  /**
   * Open the camera, relaxing the constraints until something works.
   *
   * Every resolution and frame-rate hint here is `ideal`, never `min`: a hard
   * minimum makes getUserMedia throw OverconstrainedError outright on cameras
   * that cannot promise it, which plenty cannot in dim light. Better a lower
   * frame rate than no camera at all. A device the user explicitly picked
   * stays `exact` throughout, so we never silently open the wrong camera.
   */
  async openStream(deviceId) {
    // Without a chosen device, prefer the front camera: a phone would
    // otherwise open the rear one and track whatever the desk is facing.
    // `ideal` keeps it a preference, so a webcam that reports no facing mode
    // is still opened rather than rejected.
    const base = deviceId
      ? { deviceId: { exact: deviceId } }
      : { facingMode: { ideal: 'user' } };
    const attempts = [
      { ...base, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
      { ...base, width: { ideal: 640 }, height: { ideal: 480 } },
      deviceId ? base : true,
    ];

    let lastError;
    for (const video of attempts) {
      try {
        return await navigator.mediaDevices.getUserMedia({ video, audio: false });
      } catch (err) {
        lastError = err;
        // Permission and in-use failures will not improve on a retry.
        if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError' ||
            err?.name === 'NotReadableError') throw err;
      }
    }
    throw lastError ?? new Error('No camera available.');
  }

  async start(deviceId = '') {
    await this.stop();
    try {
      this.setStatus('requesting-camera');
      this.stream = await this.openStream(deviceId);

      this.video.srcObject = this.stream;
      await this.video.play();
      await this.loadModel();

      this.running = true;
      this.lastTimestamp = -1;
      this.setStatus('running');
      this.loop();
    } catch (err) {
      await this.stop();
      this.setStatus('error', describeCameraError(err));
      throw err;
    }
  }

  async stop() {
    this.running = false;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.video.srcObject = null;
    this.hasFace = false;
    if (this.status === 'running') this.setStatus('idle');
  }

  loop = () => {
    if (!this.running) return;
    this.video.requestVideoFrameCallback
      ? this.video.requestVideoFrameCallback(this.tick)
      : requestAnimationFrame(() => this.tick(performance.now()));
  };

  tick = (now) => {
    if (!this.running || !this.landmarker) return;
    if (this.video.readyState < 2) return this.loop();

    // MediaPipe rejects a timestamp that does not strictly advance, which can
    // happen when the same camera frame is delivered twice.
    let ts = Math.round(now);
    if (ts <= this.lastTimestamp) ts = this.lastTimestamp + 1;
    this.lastTimestamp = ts;

    /* Give the model a close-up, not the whole room.
     *
     * MediaPipe finds a face by looking over a downscaled copy of whatever it
     * is handed. Sitting back from the camera, a face is a small patch of a
     * wide frame, so what the detector actually gets to work with is a face a
     * few dozen pixels across — and everything downstream, the blendshapes
     * especially, is only as good as that. It reads as a model that will not
     * quite track, and no amount of tuning at this end fixes it, because the
     * information was thrown away before the tuning.
     *
     * So the frame is cropped to a box around the face and the crop is handed
     * over instead. The box comes from where the face was last seen, padded
     * and eased, and it opens out to the whole frame whenever the face is lost
     * so it can be found again.
     */
    const source = this.zoomed(now) ?? this.video;

    let result;
    try {
      result = this.landmarker.detectForVideo(source, ts);
    } catch (err) {
      console.error('detection failed', err);
      return this.loop();
    }

    if (this._lastFrameAt) {
      const inst = 1000 / Math.max(1, now - this._lastFrameAt);
      this._fpsEma = this._fpsEma ? this._fpsEma * 0.9 + inst * 0.1 : inst;
      this.fps = this._fpsEma;
    }
    this._lastFrameAt = now;

    const shapes = result.faceBlendshapes?.[0]?.categories;
    const matrix = result.facialTransformationMatrixes?.[0]?.data;

    if (shapes?.length) {
      const raw = Object.create(null);
      for (const c of shapes) raw[c.categoryName] = c.score;

      let head = { yaw: 0, pitch: 0, roll: 0 };
      let position = { x: 0, y: 0, z: 0 };
      if (matrix?.length === 16) {
        head = eulerFromMatrix(matrix);
        position = translationFromMatrix(matrix);
      }

      // Where the face is in the WHOLE frame, whatever was handed over — so
      // the next crop follows it and the position below can be put back.
      const marks = result.faceLandmarks?.[0];
      // The crop this detection was made through, taken before aimCrop moves
      // it for the next one.
      const used = this.crop;
      this.aimCrop(marks, now);
      if (used) position = this.uncrop(position, used);

      this.hasFace = true;
      this.frame = { shapes: raw, head, position, landmarks: marks, time: now };
      this.onFrame(this.frame);
    } else {
      if (this.hasFace) this.lostSince = now;
      this.hasFace = false;
      // Lost. Open the crop back out, or it hunts inside a box the face has
      // already left and never finds it again.
      this.missed = (this.missed ?? 0) + 1;
      if (this.missed > 8) this.crop = null;
    }

    this.loop();
  };

  /**
   * The cropped frame to hand the model, or null for the whole thing.
   *
   * Drawn into a canvas the size of the crop rather than a fixed one, so no
   * resampling happens beyond what the crop itself is: the pixels the model
   * sees are the camera's own.
   */
  zoomed() {
    const mode = store.get('camera.faceZoom');
    if (mode === 'off' || !this.crop) return null;
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return null;
    const c = this.crop;
    const sx = Math.round(c.x * vw);
    const sy = Math.round(c.y * vh);
    const sw = Math.max(64, Math.round(c.w * vw));
    const sh = Math.max(64, Math.round(c.h * vh));
    const canvas = this.cropCanvas ?? (this.cropCanvas = document.createElement('canvas'));
    if (canvas.width !== sw || canvas.height !== sh) {
      canvas.width = sw;
      canvas.height = sh;
      this.cropCtx = canvas.getContext('2d', { willReadFrequently: false });
    }
    this.cropCtx.drawImage(this.video, sx, sy, sw, sh, 0, 0, sw, sh);
    return canvas;
  }

  /** Move the crop box onto where the face actually is, smoothly. */
  aimCrop(marks, now) {
    if (!marks?.length) return;
    this.missed = 0;
    if (store.get('camera.faceZoom') === 'off') { this.crop = null; return; }

    let x0 = 1; let y0 = 1; let x1 = 0; let y1 = 0;
    for (const p of marks) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
    // Landmarks come back in the coordinates of whatever was handed over, so
    // a box measured inside a crop has to be put back into the whole frame
    // before it can say where to crop next.
    const c = this.crop;
    if (c) {
      x0 = c.x + x0 * c.w; x1 = c.x + x1 * c.w;
      y0 = c.y + y0 * c.h; y1 = c.y + y1 * c.h;
    }

    /* Padded well past the face. The model wants room around it, a head turns
     * out of a tight box faster than the box can follow, and a crop that
     * clips an ear costs more than one that includes some wall. */
    const PAD = 1.9;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const half = Math.max((x1 - x0) * PAD, (y1 - y0) * PAD, 0.22) / 2;
    const want = {
      x: clamp(cx - half, 0, 1), y: clamp(cy - half, 0, 1),
      w: Math.min(half * 2, 1), h: Math.min(half * 2, 1),
    };
    want.x = Math.min(want.x, 1 - want.w);
    want.y = Math.min(want.y, 1 - want.h);

    /* Eased, and never faster than the face moves.
     *
     * A crop that snaps is worse than no crop: the model sees a different
     * framing every frame and the landmarks jitter against it, which is read
     * downstream as the head shaking. */
    const k = this.crop ? 1 - Math.exp(-6 * Math.max((now - (this.cropAt ?? now)) / 1000, 0)) : 1;
    this.cropAt = now;
    this.crop = this.crop ? {
      x: this.crop.x + (want.x - this.crop.x) * k,
      y: this.crop.y + (want.y - this.crop.y) * k,
      w: this.crop.w + (want.w - this.crop.w) * k,
      h: this.crop.h + (want.h - this.crop.h) * k,
    } : want;
  }

  /**
   * Put the head's position back into the whole frame's terms.
   *
   * Without this, zooming would quietly switch off leaning altogether: the
   * crop follows the face, so inside it the face is always in the middle, and
   * a head that is always in the middle has not moved. The model would sit
   * dead centre however far you leaned.
   *
   * Two corrections. Cropping to a fraction of the width makes the model
   * believe in a longer lens, which scales what it reports; and the crop's own
   * offset from the middle of the frame is displacement the model can no
   * longer see. The second needs centimetres per unit of frame, which is depth
   * times the lens's half-angle — a webcam is around fifty degrees, so half a
   * unit of frame is about half the distance to the face.
   */
  uncrop(position, c = this.crop) {
    if (!c) return position;
    const depth = Math.abs(position.z) || 45;
    return {
      x: position.x * c.w + (c.x + c.w / 2 - 0.5) * depth,
      y: position.y * c.h + (c.y + c.h / 2 - 0.5) * depth,
      z: position.z,
    };
  }
}

function describeCameraError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission was denied. Allow camera access for this page and try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera matched. Pick a different device in the Camera list.';
    case 'NotReadableError':
      return 'The camera is in use by another app. Close OBS virtual camera, Zoom, Discord, etc. and retry.';
    default:
      return err?.message || 'Could not start the camera.';
  }
}
