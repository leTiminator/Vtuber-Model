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
import { emptyRig } from './tracking/rig.js';
import { Parts2D } from './avatars/parts/index.js';

store.setPersistence(false);

const stage = document.getElementById('stage');
const host = document.getElementById('avatar-host');

const avatar = new Parts2D();

/* The one thing this page may say: that it could not draw. It cannot say it
 * here — everything on this page is on the stream — so it goes back over the
 * link to the tracker's status line, once the link is up. */
let drawError = null;
let reportDrawError = () => {}; // replaced once the link exists
avatar.onStatus = (text) => {
  drawError = text;
  console.error(text);
  reportDrawError();
};

// The baked model, written by `npm run bake` into public/model/ninja.
avatar.load(`${import.meta.env.BASE_URL}model/ninja/`).catch((err) => {
  console.error(err);
  avatar.onStatus(`The model could not be loaded: ${err.message}`);
});

avatar.mount(host);
fitToWindow(avatar);
applyBackground(stage);
window.addEventListener('resize', () => fitToWindow(avatar));

store.subscribe((key) => {
  if (key.startsWith('stage.background') || key === 'stage.chroma' || key === 'stage.color') {
    applyBackground(stage);
  }
});

/* What the tracker last said, held rather than consumed.
 *
 * Frames arrive at whatever rate the other tab is running at and this page
 * draws at its own, so the two do not line up — and when they stop arriving
 * altogether, because the tab was minimised or the server restarted, the last
 * pose is the right thing to keep showing. Falling back to neutral would put a
 * lurch on stream every time the link hiccupped.
 */
// The last solved rig the tracker sent. Held as-is when messages stop, so
// a stalled tracker leaves the model where it was rather than snapping back.
let latest = null;
let lastSeq = -1;
let received = 0;
const rest = emptyRig();

const link = openRigLink({
  role: 'output',
  onState: ({ connected }) => {
    if (connected) reportDrawError();
  },
  onSettings: (values) => {
    store.patch(values);
    applyBackground(stage);
    fitToWindow(avatar);
  },
  onRigState: (msg) => {
    // Out-of-order delivery is dropped; a small sequence number is a tracker
    // that restarted, and its first frames are wanted.
    if (msg.seq <= lastSeq && msg.seq >= 100) return;
    lastSeq = msg.seq;
    latest = msg.state;
    received++;
  },
});

reportDrawError = () => {
  if (drawError && link.connected) link.send({ t: 'status', text: drawError });
};

let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  avatar.render(latest ?? rest, dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

if (import.meta.env.DEV) {
  window.__vtuberOutput = { avatar, avatars: { parts2d: avatar }, store, link, seen: () => ({ received, lastSeq, latest }) };
}
