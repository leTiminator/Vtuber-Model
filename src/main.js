/**
 * Application entry point: wires capture -> rig -> avatar -> screen, and hands
 * the control panel the handful of callbacks it needs.
 */
import './styles.css';
import * as store from './core/store.js';
import { ZOOM_MAX, ZOOM_MIN, fitTo, zoomAbout } from './core/framing.js';
import { applyBackground as paintStage, fitToWindow } from './core/stage.js';
import { openRigLink } from './core/rigLink.js';
import { FaceTracker } from './tracking/faceTracker.js';
import { PoseTracker } from './tracking/poseTracker.js';
import { MicLevel } from './tracking/audio.js';
import { SessionRecorder } from './tracking/recorder.js';
import { Rig, emptyRig } from './tracking/rig.js';
import { Layered2D } from './avatars/layered2d/index.js';
import { Warp2D } from './avatars/warp2d/index.js';
import { Parts2D } from './avatars/parts/index.js';
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
const pose = new PoseTracker();
const mic = new MicLevel();
const rig = new Rig();
const recorder = new SessionRecorder();

const avatars = {
  layered2d: new Layered2D(),
  warp2d: new Warp2D(),
  parts2d: new Parts2D(),
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

// Sizing and the stage's background live in core/stage.js, because the page
// OBS opens has to do both exactly as this one does or the shot you framed is
// not the shot that goes out.
function resize() {
  fitToWindow(current);
}

/* The window OBS opens, if one is listening.
 *
 * This tab keeps the camera and the tracking; the other one only draws. It is
 * told the settings — including the neutral pose, which lives in the store —
 * whenever they change and once on connect, and then a frame at a time. See
 * core/rigLink.js.
 */
let outputs = 0;
const link = openRigLink({
  role: 'tracker',
  onState: ({ outputs: n }) => {
    const had = outputs;
    outputs = n;
    // Newly attached: catch it up before the next frame, in case the relay
    // was restarted and lost the snapshot it replays to late arrivals.
    if (n > had) link.send({ t: 'settings', values: store.snapshot() });
    updateStatus();
  },
});
store.subscribe(() => {
  if (link.wanted) link.send({ t: 'settings', values: store.snapshot() });
});

let lastFrameTime = performance.now();
function frame(now) {
  const dt = Math.min((now - lastFrameTime) / 1000, 0.1);
  lastFrameTime = now;

  if (mic.active) rig.setMicLevel(mic.sample());
  rig.update(tracker.frame, tracker.hasFace, dt);
  if (pose.enabled && tracker.running) pose.detect(tracker.video, now);
  rig.updatePose(pose.frame, pose.enabled && pose.hasPose, dt);
  recorder.capture(tracker.frame, tracker.hasFace, pose.frame, pose.enabled && pose.hasPose);
  current?.render(rig.state, dt);

  // Only when somebody is drawing it. A kilobyte a frame is nothing over
  // loopback, but sending it to no one is still sending it.
  if (link.wanted) {
    link.send({
      t: 'frame',
      face: tracker.frame ?? null,
      hasFace: tracker.hasFace,
      pose: pose.enabled && pose.hasPose ? pose.frame ?? null : null,
      hasPose: pose.enabled && pose.hasPose,
    });
  }

  /* The readout is for setting up, not for streaming.
   *
   * It exists because a phone has no console, and it has already earned its
   * place twice. But whatever is on this canvas is what goes out to OBS, so it
   * hides itself the moment the camera starts and comes back when it stops —
   * which is also when it is worth reading, since it describes a model nobody
   * is looking at yet.
   */
  if (tracker.running !== selfcheckHidden) {
    selfcheckHidden = tracker.running;
    if (tracker.running) { if (selfcheckEl) selfcheckEl.hidden = true; }
    else scheduleSelfCheck();
  }

  // Same turn as the draw it is asking about — see scheduleSelfCheck.
  if (selfcheckDue && now >= selfcheckDue && !tracker.running) {
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
  /* Whether the output window is listening, said here rather than there.
   *
   * That page is what OBS captures, so it has nowhere to put a message —
   * anything drawn on it is on the stream. This is the only screen where
   * "OBS is not actually receiving anything" can be read, and not knowing
   * that is the failure people spend an evening on.
   */
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
  loadLayers: (files) => avatars.layered2d.loadFiles(files),
  fitFraming,
  loadArtwork: async (file) => {
    const { image, dataURL } = await artwork.readFile(file);
    mountAvatar('warp2d');
    avatars.warp2d.setImage(image, true); // fresh art: re-place the markers
    avatars.parts2d.setImage(image, true);
    // The parts model is the one this project is built around, so new art gets
    // it too. Its rules are tuned to the bundled ninja and degrade to one big
    // part on artwork they do not fit; the whole-image warp stays in the panel
    // for exactly that case.
    store.set('stage.avatar', 'parts2d');
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
    /* A fresh start deserves a fresh neutral pose — but not this instant.
     *
     * Taken straight away it captures whoever is still looking at the button
     * they just pressed, and that pose then becomes "facing forward" for the
     * whole session. See rig.calibrate: an automatic capture waits, wants the
     * head still and roughly square, and declines rather than saving a guess.
     */
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

/* Which build is on screen, and what it is running with.
 *
 * Without the build, "the fix is not there" and "the fix is there and did not
 * work" look identical from a photograph. Without the settings, so do "the
 * model is broken" and "the model is doing what these sliders ask of it" —
 * settings persist across every visit, so a session tuned weeks ago is still
 * in force, and the one fault that reached the user needed three of them away
 * from their defaults at once. A phone has no console; this line is the only
 * way that state can be read off a screenshot.
 */
/* Settings nobody chose: the marker geometry the rig places for itself when
 * artwork loads, and the camera it happened to pick. They differ from their
 * defaults on every machine, and listing them buries the handful that were
 * actually tuned — which is the only thing this line is for.
 */
const MACHINE_SET = /^(warp\.(head|pivot|waist|eye)|camera\.(deviceId|neutral)|stage\.avatarChosen)/;

const stamp = document.getElementById('build-stamp');
function showStamp() {
  if (!stamp) return;
  const build = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';
  const now = store.snapshot();
  const changed = Object.keys(store.DEFAULTS)
    .filter((k) => now[k] !== store.DEFAULTS[k] && !MACHINE_SET.test(k))
    .map((k) => `${k} ${now[k]}`);
  const shown = changed.slice(0, 6).join(', ');
  const rest = changed.length > 6 ? ` +${changed.length - 6} more` : '';
  stamp.textContent = changed.length
    ? `build ${build} · changed: ${shown}${rest}`
    : `build ${build} · all settings default`;
}
showStamp();

/* The on-device readout.
 *
 * The suite runs on a software renderer on a build server; the phone has a
 * different driver and a different compiler, and every fault that actually
 * reached the user was visible on the phone and nowhere else. So the model
 * measures itself where it is being looked at, and says so on screen: the
 * artwork is a single connected shape, and anything other than one piece is
 * it coming apart. Tap to dismiss.
 */
const selfcheckEl = document.getElementById('selfcheck');
let selfcheckDue = 0;
let selfcheckOff = false;
let selfcheckHidden = false;
const deg = (rad) => `${rad >= 0 ? '+' : ''}${Math.round((rad * 180) / Math.PI)}\u00b0`;

function runSelfCheck() {
  if (!selfcheckEl || selfcheckOff) return;
  const r = current?.selfCheck?.();
  // Not cut yet, or a backend with nothing to measure. Ask again shortly.
  if (!r) { selfcheckEl.hidden = true; selfcheckDue = performance.now() + 700; return; }
  const build = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';
  const now = store.snapshot();
  const changed = Object.keys(store.DEFAULTS)
    .filter((k) => now[k] !== store.DEFAULTS[k] && !MACHINE_SET.test(k))
    .map((k) => `${k.split('.').pop()} ${now[k]}`);
  const torn = r.pieces !== 1;
  selfcheckEl.classList.toggle('selfcheck--torn', torn);
  selfcheckEl.textContent = [
    `${build} · ${r.pieces} piece${r.pieces === 1 ? '' : 's'}` +
      (torn ? ` (stray ${r.strays.join(', ')})` : ''),
    `${r.buffer} buffer · dpr ${r.dpr} · skinning ${r.skinning}`,
    // Where "facing forward" is. Sitting off to one side reads as a permanent
    // yaw, so this is the difference between a model at rest and one parked
    // in the worst part of its range.
    rig.neutral
      ? `neutral yaw ${deg(rig.neutral.yaw)} pitch ${deg(rig.neutral.pitch)} roll ${deg(rig.neutral.roll)}`
        + (rig.neutralWarning ? `\n  ⚠ ${rig.neutralWarning}` : '')
      : `neutral not set — press "Set neutral pose" sitting how you stream`
        + (rig.neutralWarning ? `\n  ⚠ ${rig.neutralWarning}` : ''),
    r.drawn,
    // Which face is showing, and whether the head-on drawing loaded at all.
    r.headOn ? `head-on: ${r.headOn}` : null,
    changed.length
      ? `changed: ${changed.slice(0, 6).join(', ')}${changed.length > 6 ? ` +${changed.length - 6}` : ''}`
      : 'all settings default',
  ].filter(Boolean).join('\n');
  selfcheckEl.hidden = false;
}
/* Due at a time, read inside the frame.
 *
 * Reading pixels from a timer returns whatever is in the drawing buffer after
 * compositing, which the browser is free to have cleared — so the check has to
 * happen in the same turn as the draw that it is asking about.
 */
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
  if (key === 'arms.track') applyPoseSource();
  showStamp();
  scheduleSelfCheck();
});

/* ---------------------------------------------------------------- framing */

/**
 * Drag the character around and scroll to zoom, right on the stage.
 *
 * Sliders alone are not control — composing a shot means pushing the model
 * where you want it and watching it land. Zoom anchors on the pointer, so you
 * magnify what you are aiming at rather than chasing it away from the centre.
 */
function installFraming() {
  const stage = dom.stage;
  const artAspect = () => current?.aspect ?? 1;
  const size = () => [current?.canvas?.width ?? 1, current?.canvas?.height ?? 1];
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
  const [w, h] = [current?.canvas?.width ?? 1, current?.canvas?.height ?? 1];
  const aspect = current?.aspect ?? 1;

  let box = { x0: 0, y0: 0, x1: 1, y1: 1 };
  if (mode === 'head') {
    const cx = store.get('warp.headX');
    const cy = store.get('warp.headY');
    const r = store.get('warp.headR') * 1.9;
    box = { x0: cx - r / aspect, y0: cy - r, x1: cx + r / aspect, y1: cy + r * 1.5 };
  } else if (current?.contentBox) {
    box = current.contentBox();
  }

  const next = fitTo(aspect, w, h, box, mode === 'head' ? 0.94 : 0.9);
  store.patch({ 'stage.zoom': next.zoom, 'stage.offsetX': next.offX, 'stage.offsetY': next.offY });
}

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
    avatars.parts2d.setImage(saved.image, false);
  } else {
    try {
      const image = await artwork.loadImage(`${import.meta.env.BASE_URL}art/BA_Ninja_TPBG.png`);
      /* The second drawing: the same character, drawn facing the camera.
       *
       * Handed over before the artwork, so the model is cut once with both in
       * hand rather than cut for the artwork and then cut again to take this.
       *
       * Only alongside the bundled art. It is a drawing of this character's
       * face and belongs to it — laid over somebody else's uploaded artwork it
       * would cut two eyes out of a picture it has never seen and paste them
       * wherever they happened to land.
       *
       * Its failure is not the model's failure, so it is loaded separately and
       * a missing or unreadable file leaves the turned-away face working
       * exactly as before. What went wrong shows up in the self-check readout
       * rather than only in the console.
       */
      try {
        avatars.parts2d.setHeadOnImage(
          await artwork.loadImage(`${import.meta.env.BASE_URL}art/views/pose-front-arms-out.png`));
      } catch (err) {
        console.warn('head-on view could not be loaded', err);
      }
      avatars.warp2d.setImage(image, true);
      avatars.parts2d.setImage(image, false);
    } catch (err) {
      console.warn('bundled artwork could not be loaded', err);
    }
  }
  mountAvatar(store.get('stage.avatar'));
});

// Dev-only handle, so the test suite can render a chosen pose and read the
// pixels back without going through the camera.
if (import.meta.env.DEV) {
  window.__vtuber = { rig, avatars, tracker, pose, recorder, store, emptyRig, link,
    get current() { return current; } };
}

requestAnimationFrame(frame);
