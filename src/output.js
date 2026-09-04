/**
 * The page OBS opens: the model, and nothing else.
 *
 * It has no camera, no controls and no tracking model. It is driven entirely
 * by the ordinary browser tab, which keeps the camera permission it already
 * has and a runtime current enough to run the tracker properly. See
 * core/rigLink.js for why the work is divided that way rather than pointing
 * OBS at the whole app.
 *
 * Two rules follow from what this page is, and both matter more than they
 * look:
 *
 *   - **It never draws anything but the model.** No status, no error text, no
 *     self-check. There is no corner of this page that is not on stream. What
 *     went wrong is reported on the other page, where somebody can read it.
 *   - **It never saves a setting.** OBS's browser keeps its own storage, so a
 *     snapshot written here would be read back on the next launch and win
 *     until the first message arrived — showing a shot nobody framed for a
 *     second or two at the top of every stream.
 */
import * as store from './core/store.js';
import { applyBackground, fitToWindow } from './core/stage.js';
import { openRigLink } from './core/rigLink.js';
import { Rig } from './tracking/rig.js';
import { Layered2D } from './avatars/layered2d/index.js';
import { Warp2D } from './avatars/warp2d/index.js';
import { Parts2D } from './avatars/parts/index.js';
import * as artwork from './avatars/warp2d/artwork.js';

store.setPersistence(false);

const stage = document.getElementById('stage');
const host = document.getElementById('avatar-host');

const rig = new Rig();
const avatars = {
  layered2d: new Layered2D(),
  warp2d: new Warp2D(),
  parts2d: new Parts2D(),
};
let current = null;

function mountAvatar(id) {
  const next = avatars[id] ?? avatars.parts2d;
  if (next === current) return;
  host.replaceChildren();
  current = next;
  current.mount(host);
  fitToWindow(current);
}

/* The artwork, the same way the main page loads it — including the drawing of
 * this character facing the camera, which is a second file and not something
 * the cut can invent. Anything the user loaded themselves comes back from
 * storage; reading it is fine, it is only writing that is off. */
artwork.recall().then(async (saved) => {
  if (saved) {
    avatars.warp2d.setImage(saved.image, false);
    avatars.parts2d.setImage(saved.image, false);
  } else {
    try {
      const base = import.meta.env.BASE_URL;
      const image = await artwork.loadImage(`${base}art/BA_Ninja_TPBG.png`);
      try {
        avatars.parts2d.setHeadOnImage(
          await artwork.loadImage(`${base}art/views/pose-front-arms-out.png`));
      } catch { /* the turned-away face still works without it */ }
      avatars.warp2d.setImage(image, false);
      avatars.parts2d.setImage(image, false);
    } catch { /* nothing to draw; the link may still bring settings */ }
  }
  mountAvatar(store.get('stage.avatar'));
});

mountAvatar(store.get('stage.avatar'));
applyBackground(stage);
window.addEventListener('resize', () => fitToWindow(current));

store.subscribe((key) => {
  if (key.startsWith('stage.background') || key === 'stage.chroma' || key === 'stage.color') {
    applyBackground(stage);
  }
  if (key === 'stage.avatar') mountAvatar(store.get('stage.avatar'));
});

/* What the tracker last said, held rather than consumed.
 *
 * Frames arrive at whatever rate the other tab is running at and this page
 * draws at its own, so the two do not line up — and when they stop arriving
 * altogether, because the tab was minimised or the server restarted, the last
 * pose is the right thing to keep showing. Falling back to neutral would put a
 * lurch on stream every time the link hiccupped.
 */
let latest = { face: null, hasFace: false, pose: null, hasPose: false };
let received = 0;

const link = openRigLink({
  role: 'output',
  onSettings: (values) => {
    store.patch(values);
    applyBackground(stage);
    mountAvatar(store.get('stage.avatar'));
    fitToWindow(current);
  },
  onFrame: (msg) => {
    received++;
    latest = {
      face: msg.face ?? null,
      hasFace: Boolean(msg.hasFace),
      pose: msg.pose ?? null,
      hasPose: Boolean(msg.hasPose),
    };
  },
});

let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  rig.update(latest.face, latest.hasFace, dt);
  rig.updatePose(latest.pose, latest.hasPose, dt);
  current?.render(rig.state, dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

if (import.meta.env.DEV) {
  window.__vtuberOutput = { rig, avatars, store, link, seen: () => ({ ...latest, received }) };
}
