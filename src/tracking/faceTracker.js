/**
 * Webcam capture + MediaPipe FaceLandmarker.
 *
 * Emits a raw frame object per detection: 52 ARKit-style blendshape scores,
 * plus head rotation and position decoded from the facial transformation
 * matrix. Everything downstream reads that object and never touches MediaPipe.
 */
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { eulerFromMatrix, translationFromMatrix } from '../core/math.js';

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
          minFaceDetectionConfidence: 0.5,
          minFacePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
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

    let result;
    try {
      result = this.landmarker.detectForVideo(this.video, ts);
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

      this.hasFace = true;
      this.frame = { shapes: raw, head, position, landmarks: result.faceLandmarks?.[0], time: now };
      this.onFrame(this.frame);
    } else {
      if (this.hasFace) this.lostSince = now;
      this.hasFace = false;
    }

    this.loop();
  };
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
