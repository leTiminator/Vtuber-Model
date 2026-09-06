/**
 * Application entry point: wires capture -> rig -> avatar -> screen, and hands
 * the control panel the handful of callbacks it needs.
 */
import './styles.css';
import * as store from './core/store.js';
import { ZOOM_MAX, ZOOM_MIN, fitTo, zoomAbout } from './core/framing.js';
import { applyBackground as paintStage, fitToWindow } from './core/stage.js';
import { openRigLink } from './core/rigLink.js';
import { startTicker } from './core/ticker.js';
import { FaceTracker } from './tracking/faceTracker.js';
import { PoseTracker } from './tracking/poseTracker.js';
import { MicLevel } from './tracking/audio.js';
import { SessionRecorder } from './tracking/recorder.js';
import { Rig, emptyRig } from './tracking/rig.js';
import { Parts2D } from './avatars/parts/index.js';
import { buildPanel } from './ui/panel.js';
import { installHotkeys } from './ui/hotkeys.js';
import { buildId, readoutText, stampText } from './ui/readout.js';

const dom = {
  body: document.body,
  stage: document.getElementById('stage'),
  host: document.getElementById('avatar-host'),
  status: document.getElementById('status'),
  fps: document.getElementById('fps'),
  preview: document.getElementById('camera-preview'),
  firstRun: document.getElementById('first-run'),
  panelBody: document.getElementById('panel-body'),
  start: document.getElementById('start'),
  calibrate: document.getElementById('calibrate'),
  togglePanel: document.getElementById('toggle-panel'),
  closePanel: document.getElementById('close-panel'),
  exportBtn: document.getElementById('export'),
  importBtn: document.getElementById('import'),
  resetBtn: document.getElementById('reset'),
};

const tracker = new FaceTracker();
const pose = new PoseTracker();
const mic = new MicLevel();
const rig = new Rig();
const recorder = new SessionRecorder();

const avatar = new Parts2D();
// Why the stage cannot draw, when it cannot. Wired before the mount, because a
// missing WebGL2 context is reported from inside it.
let avatarError = null;
avatar.onStatus = (text) => {
  avatarError = text;
  console.error(text);
  updateStatus();
};

/* ------------------------------------------------------------- rendering */

// Sizing and the stage's background live in core/stage.js, because the page
// OBS opens has to do both exactly as this one does or the shot you framed is
// not the shot that goes out.
function resize() {
  fitToWindow(avatar);
}

/* The window OBS opens, if one is listening. */
let outputs = 0;
// What the OBS page reported it could not do, while it is attached.
let outputError = null;
const link = openRigLink({
  role: 'tracker',
  onState: ({ outputs: n }) => {
    const had = outputs;
    outputs = n;
    if (n === 0) outputError = null;
    // Newly attached: catch it up before the next frame, in case the relay
    // was restarted and lost the snapshot it replays to late arrivals.
    if (n > had) link.send({ t: 'settings', values: store.snapshot() });
    updateStatus();
  },
  onPeerStatus: ({ text }) => {
    outputError = text || null;
    updateStatus();
  },
});
// One snapshot per frame at most: a drag writes the store hundreds of times.
let settingsDirty = false;
let stateSeq = 0;
store.subscribe(() => { settingsDirty = true; });

let lastFrameTime = performance.now();
function frame(now) {
  step(now);
  requestAnimationFrame(frame);
}
// One step of the pipeline: track, solve, draw, send. Driven by the animation
// frame while the window is visible and by a Worker timer while it is hidden,
// when animation frames and video frame callbacks slow to about one a second.
function step(now) {
  const dt = Math.min((now - lastFrameTime) / 1000, 0.1);
  lastFrameTime = now;

  if (mic.active) rig.setMicLevel(mic.sample());
  rig.update(tracker.frame, tracker.hasFace, dt);
  if (pose.enabled && tracker.running) pose.detect(tracker.video, now);
  rig.updatePose(pose.frame, pose.enabled && pose.hasPose, dt);
  recorder.capture(tracker.frame, tracker.hasFace, pose.frame, pose.enabled && pose.hasPose);
  avatar.render(rig.state, dt);

  // Only when somebody is drawing it. A kilobyte a frame is nothing over
  // loopback, but sending it to no one is still sending it.
  if (link.wanted && settingsDirty) {
    settingsDirty = false;
    link.send({ t: 'settings', values: store.snapshot() });
  }
  if (link.wanted) link.send({ t: 'state', seq: ++stateSeq, at: now, state: rig.state });

  /* The readout stays up while the camera runs, which is the whole point. */
  if (!selfcheckDue) selfcheckDue = now + 1000;
  if (now >= selfcheckDue) {
    selfcheckDue = 0;
    runSelfCheck();
  }

  if (tracker.running) {
    dom.fps.hidden = false;
    dom.fps.textContent = `${Math.round(tracker.fps)} fps`;
  } else {
    dom.fps.hidden = true;
  }
  updateStatus();
}
const HIDDEN_HZ = 30;
startTicker(HIDDEN_HZ, (now) => {
  if (!document.hidden) return;
  if (tracker.running) tracker.detect(now);
  step(now);
});

/* ---------------------------------------------------------------- status */

function setStatus(text, kind) {
  if (dom.status.textContent === text && dom.status.dataset.kind === kind) return;
  dom.status.textContent = text;
  dom.status.dataset.kind = kind;
  dom.status.className = `status status--${kind}`;
}

/* The window was hidden, and for how long. */
let hiddenSince = 0;
let starvedFor = 0;
let starvedUntil = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenSince = performance.now();
  } else if (hiddenSince) {
    starvedFor = (performance.now() - hiddenSince) / 1000;
    starvedUntil = performance.now() + 8000;
    hiddenSince = 0;
  }
  updateStatus();
});

function updateStatus() {
  // Faults first: a stage that cannot draw makes every other state moot.
  if (avatarError) return setStatus(avatarError, 'error');
  if (outputError && outputs > 0) return setStatus(`OBS page: ${outputError}`, 'error');
  if (outputs > 0 && starvedFor > 2 && performance.now() < starvedUntil) {
    return setStatus(`This window was hidden for ${Math.round(starvedFor)} s; tracking ran on a `
      + 'background timer meanwhile. If OBS stuttered, keep this window visible.', 'busy');
  }
  /* Whether the output window is listening, said here rather than there. */
  const out = outputs > 0 ? ` · to OBS ×${outputs}` : '';
  switch (tracker.status) {
    case 'requesting-camera': return setStatus('Asking for the camera…', 'busy');
    case 'loading-model': return setStatus('Loading tracking model…', 'busy');
    case 'error': return setStatus(tracker.error ?? 'Camera error', 'error');
    case 'running':
      return tracker.hasFace
        ? setStatus(`Tracking${out}`, 'live')
        : setStatus(`No face detected${out}`, 'lost');
    default: return setStatus(`Camera off${out}`, 'idle');
  }
}

/* ------------------------------------------------------------ background */

function applyBackground() {
  paintStage(dom.stage);
}

function applyPreview() {
  const show = store.get('stage.showPreview') && tracker.running;
  dom.preview.hidden = !show;
  if (show && !dom.preview.contains(tracker.video)) {
    dom.preview.prepend(tracker.video);
    tracker.video.style.transform = store.get('camera.mirror') ? 'scaleX(-1)' : 'none';
  }
  if (show) {
    tracker.video.style.transform = store.get('camera.mirror') ? 'scaleX(-1)' : 'none';
  }
}

/* ----------------------------------------------------------------- arms */

/**
 * The pose model is a second 6 MB download and roughly a third of a frame, so
 * it only loads once the camera is live and arm tracking is actually wanted.
 */
async function applyPoseSource() {
  const wants = store.get('arms.track') && tracker.running;
  if (wants === pose.enabled) return;
  try {
    await pose.setEnabled(wants);
  } catch (err) {
    pose.enabled = false;
    setStatus('Arm tracking could not start — face tracking still works', 'error');
    console.warn('pose model failed to load', err);
  }
}

/* ------------------------------------------------------------------ mic */

async function applyMicSource() {
  const wants = store.get('mouth.source') !== 'camera';
  if (wants && !mic.active) {
    try {
      await mic.start();
    } catch (err) {
      setStatus('Microphone blocked — using the camera for speech', 'error');
      store.set('mouth.source', 'camera');
    }
  } else if (!wants && mic.active) {
    await mic.stop();
  }
}

/* ------------------------------------------------------------------ boot */

const cameraListeners = new Set();

buildPanel(dom.panelBody, {
  // The rig's own numbers, so "it is backwards" can be pinned to the half of
  // the pipeline that is actually backwards.
  headStatus: () => ({
    camera: tracker.running,
    tracked: rig.state.tracked,
    yaw: rig.state.head.yaw,
    pitch: rig.state.head.pitch,
    roll: rig.state.head.roll,
  }),
  listCameras: () => FaceTracker.listCameras(),
  onCamerasChanged: (fn) => cameraListeners.add(fn),
  selectCamera: async (deviceId) => {
    store.set('camera.deviceId', deviceId);
    if (tracker.running) await startCamera();
  },
  fitFraming,
  recorder,
  startRecording: (seconds) => {
    if (!tracker.running) return false;
    recorder.start(seconds);
    return true;
  },
  armStatus: () => ({
    camera: tracker.running,
    model: pose.error ? 'failed' : pose.landmarker ? 'ready' : pose.enabled ? 'loading' : 'off',
    pose: pose.hasPose ? 'found' : 'none',
    shoulders: pose.frame?.joints?.shoulderL && pose.frame?.joints?.shoulderR ? 'both'
      : pose.frame?.joints?.shoulderL || pose.frame?.joints?.shoulderR ? 'one' : 'none',
    rate: pose.rate.toFixed(1),
    left: rig.state.arms.left,
    right: rig.state.arms.right,
  }),
});

async function startCamera() {
  try {
    dom.start.disabled = true;
    await tracker.start(store.get('camera.deviceId'));
    dom.firstRun.hidden = true;
    dom.start.textContent = 'Restart camera';
    // Device labels are only exposed once permission has been granted.
    for (const fn of cameraListeners) fn();
    applyPreview();
    await applyMicSource();
    await applyPoseSource();
    /* A fresh start deserves a fresh neutral pose — but not this instant. */
    rig.calibrate(true);
  } catch {
    /* status line already carries the reason */
  } finally {
    dom.start.disabled = false;
  }
}

dom.start.addEventListener('click', startCamera);
dom.calibrate.addEventListener('click', () => rig.calibrate());

const toggleUI = () => dom.body.classList.toggle('panel-hidden');
dom.togglePanel.addEventListener('click', toggleUI);
dom.closePanel.addEventListener('click', toggleUI);

dom.exportBtn.addEventListener('click', () => {
  const blob = new Blob([store.exportJSON()], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'vtuber-settings.json';
  link.click();
  URL.revokeObjectURL(link.href);
});

dom.importBtn.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      store.importJSON(await file.text());
    } catch (err) {
      setStatus(`Could not import: ${err.message}`, 'error');
    }
  });
  input.click();
});

dom.resetBtn.addEventListener('click', () => {
  if (confirm('Reset every setting to its default?')) store.reset();
});

// Which build is on screen and which settings differ from default, on the
// stage, so both can be read off a screenshot.
const stamp = document.getElementById('build-stamp');
function showStamp() {
  if (stamp) stamp.textContent = stampText();
}
showStamp();
{
  const el = document.getElementById('hud-build');
  if (el) el.textContent = buildId(true);
}

// The D readout: what the renderer drew, what the tracker sees, where forward
// is. Read inside the frame, because pixels read from a timer may be gone.
const selfcheckEl = document.getElementById('selfcheck');
let selfcheckDue = 0;
let selfcheckOff = false;
function runSelfCheck() {
  if (!selfcheckEl || selfcheckOff) return;
  const r = readoutText({ avatar, rig, tracker, pose });
  if (!r) { selfcheckEl.hidden = true; selfcheckDue = performance.now() + 700; return; }
  selfcheckEl.classList.toggle('selfcheck--torn', r.torn);
  selfcheckEl.textContent = r.text;
  selfcheckEl.hidden = false;
}

/* Due at a time, read inside the frame. */
function scheduleSelfCheck() {
  selfcheckDue = performance.now() + 700;
}
selfcheckEl?.addEventListener('click', () => {
  selfcheckOff = true;
  selfcheckEl.hidden = true;
});
window.addEventListener('resize', scheduleSelfCheck);
window.addEventListener('orientationchange', scheduleSelfCheck);
scheduleSelfCheck();

installHotkeys({
  onCalibrate: () => rig.calibrate(),
  onToggleUI: toggleUI,
  onToggleMirror: () => store.set('camera.mirror', !store.get('camera.mirror')),
  // Put the readout away, or bring it back. It is the only place a live
  // session says anything about itself, so it has to be recoverable — tapping
  // it used to switch it off for good.
  onToggleReadout: () => {
    selfcheckOff = !selfcheckOff;
    if (selfcheckOff) selfcheckEl.hidden = true;
    else scheduleSelfCheck();
  },
});

store.subscribe((key) => {
  if (key.startsWith('stage.background') || key === 'stage.chroma' || key === 'stage.color') applyBackground();
  if (key === 'stage.showPreview' || key === 'camera.mirror') applyPreview();
  if (key === 'mouth.source') applyMicSource();
  if (key === 'arms.track') applyPoseSource();
  showStamp();
  scheduleSelfCheck();
});

/* ---------------------------------------------------------------- framing */

/** Drag the character around and scroll to zoom, right on the stage. */
function installFraming() {
  const stage = dom.stage;
  const artAspect = () => avatar.aspect ?? 1;
  const size = () => [avatar.canvas.width ?? 1, avatar.canvas.height ?? 1];
  const locked = () => store.get('stage.lockFraming');

  let dragging = null;

  // The HUD and the overlays live inside the stage, so a press on the menu
  // button starts here too. Capturing the pointer for a drag then swallows the
  // click that button was waiting for — on a phone that leaves no way to close
  // the panel at all. Chrome is not the canvas; let those presses through.
  const onChrome = (event) => Boolean(event.target?.closest?.(
    '#hud, #camera-preview, #first-run, button, input, select, a, label'));

  stage.addEventListener('pointerdown', (event) => {
    if (locked() || event.button !== 0 || onChrome(event)) return;
    dragging = { id: event.pointerId, x: event.clientX, y: event.clientY };
    stage.setPointerCapture(event.pointerId);
    stage.classList.add('stage--grabbing');
  });

  stage.addEventListener('pointermove', (event) => {
    if (!dragging || event.pointerId !== dragging.id) return;
    const box = stage.getBoundingClientRect();
    // Offsets are a fraction of the shorter side, so convert the drag the same
    // way rather than assuming square pixels.
    const minSide = Math.min(box.width, box.height) || 1;
    store.set('stage.offsetX', store.get('stage.offsetX') + (event.clientX - dragging.x) / minSide);
    store.set('stage.offsetY', store.get('stage.offsetY') + (event.clientY - dragging.y) / minSide);
    dragging.x = event.clientX;
    dragging.y = event.clientY;
  });

  const endDrag = (event) => {
    if (!dragging || event.pointerId !== dragging.id) return;
    stage.releasePointerCapture(dragging.id);
    dragging = null;
    stage.classList.remove('stage--grabbing');
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  stage.addEventListener('wheel', (event) => {
    if (locked() || onChrome(event)) return;
    event.preventDefault();
    const box = stage.getBoundingClientRect();
    const [w, h] = size();
    const next = zoomAbout(
      artAspect(), w, h,
      { zoom: store.get('stage.zoom'), offX: store.get('stage.offsetX'), offY: store.get('stage.offsetY') },
      store.get('stage.zoom') * Math.exp(-event.deltaY * 0.0015),
      (event.clientX - box.left) / (box.width || 1),
      (event.clientY - box.top) / (box.height || 1),
    );
    store.patch({ 'stage.zoom': next.zoom, 'stage.offsetX': next.offX, 'stage.offsetY': next.offY });
  }, { passive: false });
}
installFraming();

/**
 * Frame on a region of the artwork. `whole` uses everything the artist drew;
 * otherwise it frames the head from the marker already placed on it.
 */
function fitFraming(mode) {
  const [w, h] = [avatar.canvas.width ?? 1, avatar.canvas.height ?? 1];
  const aspect = avatar.aspect ?? 1;

  let box = { x0: 0, y0: 0, x1: 1, y1: 1 };
  if (mode === 'head') {
    const m = avatar.model?.markers ?? { headX: 0.5, headY: 0.3, headR: 0.2 };
    const cx = m.headX;
    const cy = m.headY;
    const r = m.headR * 1.9;
    box = { x0: cx - r / aspect, y0: cy - r, x1: cx + r / aspect, y1: cy + r * 1.5 };
  } else {
    box = avatar.contentBox();
  }

  const next = fitTo(aspect, w, h, box, mode === 'head' ? 0.94 : 0.9);
  store.patch({ 'stage.zoom': next.zoom, 'stage.offsetX': next.offX, 'stage.offsetY': next.offY });
}

window.addEventListener('resize', resize);

avatar.mount(dom.host);
resize();
applyBackground();
// The baked model, written by `npm run bake` into public/model/ninja.
avatar.load(`${import.meta.env.BASE_URL}model/ninja/`).catch((err) => {
  console.error(err);
  avatar.onStatus(`The model could not be loaded: ${err.message}`);
});

// Dev-only handle, so the test suite can render a chosen pose and read the
// pixels back without going through the camera.
if (import.meta.env.DEV) {
  window.__vtuber = { rig, avatar, avatars: { parts2d: avatar }, tracker, pose, recorder, store,
    emptyRig, link, get current() { return avatar; } };
}

requestAnimationFrame(frame);
