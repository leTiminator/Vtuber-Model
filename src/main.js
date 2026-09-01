/**
 * Application entry point: wires capture -> rig -> avatar -> screen, and hands
 * the control panel the handful of callbacks it needs.
 */
import './styles.css';
import * as store from './core/store.js';
import { FaceTracker } from './tracking/faceTracker.js';
import { MicLevel } from './tracking/audio.js';
import { Rig, emptyRig } from './tracking/rig.js';
import { Layered2D } from './avatars/layered2d/index.js';
import { Warp2D } from './avatars/warp2d/index.js';
import { RigEditor } from './avatars/warp2d/editor.js';
import * as artwork from './avatars/warp2d/artwork.js';
import { buildPanel } from './ui/panel.js';
import { installHotkeys } from './ui/hotkeys.js';

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
const mic = new MicLevel();
const rig = new Rig();

const avatars = {
  layered2d: new Layered2D(),
  warp2d: new Warp2D(),
};
let current = null;
const rigEditor = new RigEditor();
// The overlay draws whatever the backend actually segmented, not a re-guess.
rigEditor.setMaskSource(() => avatars.warp2d.masks);

/* ------------------------------------------------------------- rendering */

function mountAvatar(id) {
  const next = avatars[id] ?? avatars.warp2d;
  if (next === current) return;
  dom.host.replaceChildren();
  current = next;
  current.mount(dom.host);
  resize();
}

function resize() {
  if (!current) return;
  current.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
}

let lastFrameTime = performance.now();
function frame(now) {
  const dt = Math.min((now - lastFrameTime) / 1000, 0.1);
  lastFrameTime = now;

  if (mic.active) rig.setMicLevel(mic.sample());
  rig.update(tracker.frame, tracker.hasFace, dt);
  current?.render(rig.state, dt);

  if (tracker.running) {
    dom.fps.hidden = false;
    dom.fps.textContent = `${Math.round(tracker.fps)} fps`;
  } else {
    dom.fps.hidden = true;
  }
  updateStatus();

  requestAnimationFrame(frame);
}

/* ---------------------------------------------------------------- status */

function setStatus(text, kind) {
  if (dom.status.textContent === text && dom.status.dataset.kind === kind) return;
  dom.status.textContent = text;
  dom.status.dataset.kind = kind;
  dom.status.className = `status status--${kind}`;
}

function updateStatus() {
  switch (tracker.status) {
    case 'requesting-camera': return setStatus('Asking for the camera…', 'busy');
    case 'loading-model': return setStatus('Loading tracking model…', 'busy');
    case 'error': return setStatus(tracker.error ?? 'Camera error', 'error');
    case 'running':
      return tracker.hasFace
        ? setStatus('Tracking', 'live')
        : setStatus('No face detected', 'lost');
    default: return setStatus('Camera off', 'idle');
  }
}

/* ------------------------------------------------------------ background */

function applyBackground() {
  const mode = store.get('stage.background');
  dom.stage.style.background =
    mode === 'chroma' ? store.get('stage.chroma')
    : mode === 'color' ? store.get('stage.color')
    : 'transparent';
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
  listCameras: () => FaceTracker.listCameras(),
  onCamerasChanged: (fn) => cameraListeners.add(fn),
  selectCamera: async (deviceId) => {
    store.set('camera.deviceId', deviceId);
    if (tracker.running) await startCamera();
  },
  loadLayers: (files) => avatars.layered2d.loadFiles(files),
  loadArtwork: async (file) => {
    const { image, dataURL } = await artwork.readFile(file);
    mountAvatar('warp2d');
    avatars.warp2d.setImage(image, true); // fresh art: re-place the markers
    store.set('stage.avatar', 'warp2d');
    const saved = artwork.remember(dataURL);
    rigEditor.open(image);
    return { saved, found: { head: true, eyes: avatars.warp2d.markerConfidence === true } };
  },
  openRigEditor: () => {
    const image = avatars.warp2d.image;
    if (!image) return false;
    rigEditor.open(image);
    return true;
  },
  hasArtwork: () => Boolean(avatars.warp2d.image),
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
    // A fresh start deserves a fresh neutral pose.
    rig.calibrate();
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

installHotkeys({
  rig,
  onCalibrate: () => rig.calibrate(),
  onToggleUI: toggleUI,
  onToggleMirror: () => store.set('camera.mirror', !store.get('camera.mirror')),
});

store.subscribe((key) => {
  if (key === 'stage.avatar') mountAvatar(store.get(key));
  if (key.startsWith('stage.background') || key === 'stage.chroma' || key === 'stage.color') applyBackground();
  if (key === 'stage.showPreview' || key === 'camera.mirror') applyPreview();
  if (key === 'mouth.source') applyMicSource();
});

window.addEventListener('resize', resize);

mountAvatar(store.get('stage.avatar'));
applyBackground();
// Bring back artwork rigged in a previous session before the first frame, so
// the model does not flash the built-in character on the way in.
// The model ships with its artwork. Anything saved locally wins, but a fresh
// browser — including the separate one inside OBS, which keeps its own storage —
// falls back to the bundled art rather than to an empty stage.
artwork.recall().then(async (saved) => {
  if (saved) {
    // Restoring a save: keep whatever markers the user already adjusted.
    avatars.warp2d.setImage(saved.image, false);
  } else {
    try {
      const image = await artwork.loadImage(`${import.meta.env.BASE_URL}art/BA_Ninja_TPBG.png`);
      avatars.warp2d.setImage(image, true);
    } catch (err) {
      console.warn('bundled artwork could not be loaded', err);
    }
  }
  if (store.get('stage.avatar') === 'warp2d') mountAvatar('warp2d');
});

// Dev-only handle, so the test suite can render a chosen pose and read the
// pixels back without going through the camera.
if (import.meta.env.DEV) {
  window.__vtuber = { rig, avatars, tracker, store, emptyRig, get current() { return current; } };
}

requestAnimationFrame(frame);
