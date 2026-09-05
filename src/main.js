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
import { Parts2D } from './avatars/parts/index.js';
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

/* The window OBS opens, if one is listening.
 *
 * This tab keeps the camera and the tracking; the other one only draws. It is
 * told the settings — including the neutral pose, which lives in the store —
 * whenever they change and once on connect, and then a frame at a time. See
 * core/rigLink.js.
 */
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

  /* The readout stays up while the camera runs, which is the whole point.
   *
   * It used to hide itself the instant tracking started, because everything on
   * this canvas went out to OBS. OBS reads its own page now, so that reason is
   * gone — and the time it was hidden was exactly the time it had anything to
   * say. A day went into arguing about a head that sat turned, with the line
   * naming the neutral pose sitting one keypress away and switched off.
   *
   * Refreshed a few times a second while live, so the numbers move; and in the
   * same turn as the draw, because reading pixels from a timer returns
   * whatever survived compositing. Press D to put it away.
   */
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

  requestAnimationFrame(frame);
}

/* ---------------------------------------------------------------- status */

function setStatus(text, kind) {
  if (dom.status.textContent === text && dom.status.dataset.kind === kind) return;
  dom.status.textContent = text;
  dom.status.dataset.kind = kind;
  dom.status.className = `status status--${kind}`;
}

/* The window was hidden, and for how long.
 *
 * A hidden or fully covered tab gets about one animation frame a second, so
 * OBS is starved for exactly as long as the tracker sits behind a game. The
 * pill says so for a few seconds after the window comes back, which is the
 * only time anyone is looking at it.
 */
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
    return setStatus(`This window was hidden for ${Math.round(starvedFor)} s, and OBS gets about `
      + 'one frame a second while it is. Keep it visible while streaming.', 'error');
  }
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
const MACHINE_SET = /^camera\.(deviceId|neutral)$/;

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
{
  // On the stage, not in the panel. Set once: it cannot change while running.
  const el = document.getElementById('hud-build');
  if (el) el.textContent = typeof __BUILD__ === 'string' ? __BUILD__.slice(0, 7) : 'dev';
}
let selfcheckDue = 0;
let selfcheckOff = false;
const deg = (rad) => `${rad >= 0 ? '+' : ''}${Math.round((rad * 180) / Math.PI)}\u00b0`;

/* What the tracker is reading, right now, while it is reading it.
 *
 * Everything above this line describes a still model. None of it can answer
 * the questions that actually cost days: why the head sits turned when you are
 * square, whether a neutral was captured or quietly refused, whether the pose
 * model is running at all, whether it can see both arms. Those are properties
 * of a live session, and a live session was the one thing there was no way to
 * look at — this readout used to switch itself off the moment the camera
 * started.
 *
 * Raw and corrected are both here on purpose. Raw is what your camera sees;
 * corrected is what the model is driven by; the neutral is the difference. If
 * corrected is large while you are looking down the lens, the neutral is
 * wrong, and that one line says so in a way no amount of describing the
 * symptom over chat can.
 */
/* Where "forward" is, in words.
 *
 * The number alone was read for a week as the model being broken. A neutral
 * taken from the button is taken looking at the screen, and a camera beside
 * the screen makes that a permanent turn — thirty-eight degrees, measured
 * live — so looking at the camera afterwards read as a hard turn away and the
 * head sat at its limit. Nothing was broken; forward was the screen. Which is
 * right for streaming, and needs saying.
 */
function neutralLine() {
  const n = rig.neutral;
  const cal = rig.pendingCalibration;
  const wait = cal ? Math.max(0, cal.armAt - rig.clock) : 0;
  const capturing = !cal ? ''
    : wait > 0 ? ` · setting neutral in ${Math.ceil(wait)}… look where you stream`
      : ' · capturing — hold still';
  if (!n) {
    return (cal ? 'neutral: not set yet' : 'NEUTRAL NOT SET — press C sitting how you stream')
      + capturing;
  }
  const off = Math.abs(n.yaw) * 180 / Math.PI;
  const where = off > 8
    ? `forward is where you looked when you set the pose, ${Math.round(off)}° from the camera`
    : 'forward is the camera';
  return `${where} · neutral ${deg(n.yaw)} ${deg(n.pitch)} ${deg(n.roll)}`
    + (off > 8 && !cal ? ' — C resets it, 3-second countdown' : '') + capturing;
}

function liveLines() {
  if (!tracker.running) return [];
  const out = [];
  const head = tracker.frame?.head;
  if (head && tracker.hasFace) {
    /* In the rig's own terms — mirrored, when the camera is — so this line,
     * the neutral and the driven angles can be read against each other. The
     * camera's raw reading has the opposite sign on yaw and roll, and a line
     * that printed it beside a mirrored neutral could not be subtracted by
     * eye, which is what it was there for.
     */
    const mirror = store.get('camera.mirror');
    const seen = mirror ? { yaw: -head.yaw, pitch: head.pitch, roll: -head.roll } : head;
    const s = rig.state.head;
    out.push(`seen yaw ${deg(seen.yaw)} pitch ${deg(seen.pitch)} roll ${deg(seen.roll)}`
      + `  →  driven ${deg(s.yaw)} ${deg(s.pitch)} ${deg(s.roll)}`);
  } else {
    out.push('no face in frame');
  }

  // The pose model is a separate model on a separate stride, and "the arms do
  // not move" has three different causes that look identical from outside:
  // not running, running too rarely, or running and not seeing a wrist.
  const a = rig.state.arms;
  const z = tracker.crop;
  out.push(z
    ? `face zoom ${(1 / Math.max(z.w, 1e-3)).toFixed(1)}× on the camera`
    : `face zoom off — whole frame${store.get('camera.faceZoom') === 'off' ? '' : ' (looking for a face)'}`);
  out.push(store.get('arms.track')
    ? `pose ${pose.enabled ? `${pose.rate.toFixed(0)}/s stride ${pose.stride}` : 'loading…'}`
      + ` · arms L ${a.left.seen.toFixed(2)} R ${a.right.seen.toFixed(2)}`
      + ` · wrists L ${a.left.wrist.toFixed(2)} R ${a.right.wrist.toFixed(2)}`
      + ` · lift L ${a.left.raise.toFixed(2)} R ${a.right.raise.toFixed(2)}`
      + `\nbody from shoulders ${rig.state.torso.seen.toFixed(2)}`
      + ` · turn ${rig.state.torso.turn.toFixed(2)}`
      + ` lean ${rig.state.torso.lean.toFixed(2)}`
    : 'arm tracking off');
  /* Framing, said in words, because it is the fix and it is not in the code.
   *
   * On the recorded minute this project has, the wrists were out of the
   * picture in every frame and the elbows below its bottom edge in most, with
   * the shoulders sitting at eighty per cent of the frame's height. No rig
   * tracks an arm the camera cannot see, and nothing on screen said so.
   */
  const j = pose.frame?.joints;
  if (store.get('arms.track') && pose.enabled && j?.shoulderL && j?.shoulderR) {
    const shoulderY = (j.shoulderL.y + j.shoulderR.y) / 2;
    const where = `shoulders at ${Math.round(shoulderY * 100)}% of the frame's height`;
    // Per arm. A desk camera crops one side long before it crops both, and a
    // warning that waited for both was silent exactly when it was needed.
    const gone = [];
    for (const [side, arm] of [['left', a.left], ['right', a.right]]) {
      if (arm.seen < 0.3) gone.push(`${side} elbow`);
      else if (arm.wrist < 0.3) gone.push(`${side} wrist`);
    }
    if (gone.length) {
      const joint = (g) => g.split(' ')[1];
      const what = gone.length === 2 && joint(gone[0]) === joint(gone[1])
        ? `both ${joint(gone[0])}s` : gone.join(' and ');
      const why = gone.some((g) => g.endsWith('elbow'))
        ? 'move the camera back or down' : 'lift is read off the elbow';
      out.push(`  ⚠ ${what} out of frame — ${why}; ${where}`);
    }
  }
  return out;
}

function runSelfCheck() {
  if (!selfcheckEl || selfcheckOff) return;
  const r = avatar.selfCheck();
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
    neutralLine() + (rig.neutralWarning ? `\n  ⚠ ${rig.neutralWarning}` : ''),
    r.drawn,
    // Which face is showing, and whether the head-on drawing loaded at all.
    r.headOn ? `head-on: ${r.headOn}` : null,
    ...liveLines(),
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

/**
 * Drag the character around and scroll to zoom, right on the stage.
 *
 * Sliders alone are not control — composing a shot means pushing the model
 * where you want it and watching it land. Zoom anchors on the pointer, so you
 * magnify what you are aiming at rather than chasing it away from the centre.
 */
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
