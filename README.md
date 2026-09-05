# VTuber Model

A webcam-driven VTuber avatar that runs in your browser. Point a camera at
yourself and the model moves with you — head turns, nods and tilts, blinks,
eye darting, brow slant, and speech. Built to drop straight into OBS.

The built-in character is a masked ninja: charcoal helmet, glowing visor eyes,
spiky tufts, and a red scarf that flies on its own physics.

**Everything runs on your machine.** No video, no audio, and no tracking data
leaves the browser. The only server is the local one that serves the page and
carries the pose to OBS; there is no account.

---

## Setup

### 1. Install Node.js

Get the **LTS** installer from [nodejs.org](https://nodejs.org) and run it.
Accept the defaults. This is the only thing you have to install.

### 2. Get the code

On the repository page, click the green **Code** button → **Download ZIP**, then
unzip it somewhere you can find again. (Or `git clone` it if you already use git.)

### 3. Start it

- **Windows** — double-click **`start.bat`**
- **macOS / Linux** — run **`./start.sh`** in a terminal

The first run installs dependencies and downloads the tracking model, about
30 MB. That takes a few minutes and happens once. After that it starts in
seconds and your browser opens at `http://127.0.0.1:5173`.

**Leave that terminal window open while you stream.** Closing it stops the model.

<details>
<summary>Doing it by hand instead</summary>

```bash
npm install     # also fetches the tracking model, about 26 MB, once
npm run dev     # then open the address it prints
```

If the model download is blocked or interrupted, re-run it on its own with
`npm run assets`.
</details>

---

## First run

1. **Start camera**, and allow access when the browser asks. The first start
   takes a few seconds while the tracking model loads.
2. **Sit how you normally stream** — straight on, head level — and press
   **Set neutral pose** (or `C`). Everything is measured relative to that pose,
   so this is what stops the model sitting at a permanent angle.
3. Open **Head** and turn the gains up until it feels right. Most people want
   more than reality: `1.5x`–`2x` reads far better on stream than `1x`, which
   looks stiff.

Redo the neutral pose whenever you move your chair or camera.

---

## Desktop only

This runs on a computer, in a desktop browser, next to OBS. It used to have a
phone route as well — a local HTTPS server, a certificate to accept, a
bottom-sheet layout — and that has been taken out: it was effort spent on a
screen this is never streamed from, and every one of its checks was a check
the desktop did not need.

The deployed build is at

```
https://letiminator.github.io/Vtuber-Model/
```

Pushing to `main` publishes it; the commit it was built from is stamped in
the corner of the stage, so you can see at a glance that you are on the
current one.

---

## Putting it in OBS

The model goes into OBS as a **Browser source**, which composites real
transparency — no green screen to key, no window to capture, and so no title
bar to crop out of shot.

The catch that used to make this awkward is that OBS's built-in browser cannot
reliably open a webcam. So it is not asked to. The app has **two pages**:

- the one you already use, which does the camera and the tracking, and
- **`/output.html`** — the model and nothing else. No camera, no controls, no
  tracking model. OBS opens this one.

They talk over the server that is already running, so tracking happens in your
real browser with a real GPU, and OBS just draws.

### Setting it up

1. Start the app as usual and leave that browser window open. **Do not
   minimise it** — browsers slow a hidden tab down to about one frame a second,
   and the model would stutter. A second monitor, or a small window beside OBS,
   is fine.
2. In the app, leave **Background** on `Transparent` (Output & OBS section).
3. In OBS: **+** → **Browser**, URL `http://127.0.0.1:5173/output.html`.
4. Set the size to 1920x1080, then scale the source in your scene.
5. Untick **Shutdown source when not visible**.

The status pill in the app then reads **"Tracking · to OBS ×1"**. If it does
not say `to OBS`, the browser source is not connected and nothing you do in
OBS will help — check the URL and that the app's terminal is still running.

Frame the shot in the app window; the output follows. Set the Browser source to
the aspect ratio you want, because the framing is applied to whatever shape the
canvas is.

### If you would rather capture a window

You can, and it is worth knowing which capture: **Game Capture with "Allow
transparency"** carries an alpha channel, and **Window Capture does not**. So
with Game Capture you can leave the background transparent; with Window
Capture you have to set **Background** to `Chroma key colour` and add a Chroma
Key filter in OBS.

Either way press `F11` for fullscreen and `H` to hide the interface first —
that is what keeps the browser's own top bar out of the shot.

The browser source is still the better route: it needs no keying, no
fullscreen, and no second monitor.

Keep the terminal window from step 3 of Setup running throughout.

For a permanent install, `npm run build` writes a static site to `dist/` you
can serve from anywhere — though the two-page arrangement needs the local
server, since that is what carries tracking between them.

---

## Hotkeys

| Key | Does |
| --- | --- |
| `C` | Set neutral pose — press this after sitting down |
| `H` | Hide or show the interface |
| `M` | Mirror the camera |

---

## Tuning

Every control saves as you change it and persists across restarts. **Export
settings** writes a JSON file worth keeping once you have it dialled in.

| Problem | Fix |
| --- | --- |
| Model jitters when you sit still | Lower **Steadiness** |
| Model lags behind fast movement | Raise **Snappiness** |
| Looks permanently sleepy | Raise **Blink threshold** |
| Blinks get missed | Lower **Blink threshold**, or raise **Blink strength** |
| Winks when you didn't wink | Turn on **Blink both eyes together** |
| Head sits turned or tilted at rest | Press **C** sitting the way you stream. It counts down three seconds so you can look where you mean to — forward is wherever you are looking when it captures, and the readout (`D`) says how far that is from the camera |
| Movement feels stiff | Raise the **Head** gains |
| It moves the wrong way | Toggle **Mirror me** (`M`) |
| Speech is unreliable in low light | Set **Speech → Driven by** to `Microphone` |
| Background noise triggers the mouth | Raise **Mic noise gate** |

---

## How it works

```
camera ─> FaceTracker / PoseTracker ─> Rig ─> Parts2D ─> canvas
                                        └─ rig state over the relay ─> output.html in OBS
```

- **`src/tracking/faceTracker.js`** — webcam capture plus MediaPipe
  FaceLandmarker, cropped to your face so sitting back from the camera costs
  nothing. Produces 52 blendshape scores and a head pose per frame.
  `poseTracker.js` runs the pose model on a stride for shoulders, elbows and
  wrists.
- **`src/tracking/rig.js`** — mirrors the signal so the model reads as your
  reflection, subtracts your neutral pose, shapes and filters each channel
  (`src/core/oneEuro.js`), and adds the motion you never perform yourself:
  breathing, idle sway and auto-blink.
- **`scripts/bake/`** — the cut. Run once by `npm run bake`, in headless
  Chromium: it finds the head, neck and eyes in the drawing, cuts it into
  thirteen parts by connectivity and colour, paints an invented margin under
  every seam, traces the scarf's centreline into sixteen bones, repairs the
  head-on drawing's keyed-out eyes and cuts that too, and writes
  `public/model/ninja/`: a PNG and a margin PNG per part and a manifest that
  says how they fit.
- **`src/avatars/parts/`** — the renderer. It loads the manifest and draws the
  parts in WebGL2: a rigid head cutout that slides for a turn and rotates for a
  nod, swapped for the head-on drawing when you face the camera; eyes with
  lids, glow and gaze in the fragment shader; a contact shadow behind each
  part; the scarf skinned to a chain of rigid links (`cloth.js`) that bends and
  does not stretch.
- **`src/main.js`** and **`src/output.js`** — the tracker page and the page OBS
  opens. The tracker sends the solved rig, about a kilobyte a frame, over the
  WebSocket relay in `scripts/rig-relay.mjs`; the OBS page has no camera and no
  rig of its own, draws the last state it received, and holds it when the
  tracker goes quiet.

Libraries are vendored from npm and the tracking model is downloaded once at
install time, so the app has no CDN dependency and works offline.

---

## Tests

```bash
npm test                  # every suite, with a pass/fail table
npm run test:rig          # rig maths in Node, no browser
npm run test:cloth        # the scarf's link chain in Node
npm run test:replay       # the recorded tracker session through the rig, in Node
npm run test:model        # the baked model: manifest, reassembly, and a fresh bake reproducing it
npm run test:invariants   # properties any correct renderer has, in Chromium
npm run test:golden       # the canonical poses against test/golden/*.png
npm run test:smoke        # the app boots against a fake webcam
npm run test:output       # the OBS page and the relay
```

The model is cut once, offline: `npm run bake` regenerates `public/model/ninja/`
from the drawings in `public/art/`, and `npm run bake:check` fails if what is
committed no longer matches a fresh bake.

The golden run also writes a contact sheet of every pose to `test/out/golden/`,
which is the quickest way to look at the model in all its poses after a change.

`test/rig.mjs` feeds synthetic frames straight into the rig and checks
mirroring, calibration, clamping, blink behaviour, arm angles and recovery from
a stalled frame. `test/smoke.mjs` boots the real app in Chromium against a fake
webcam and checks the whole pipeline comes up.

`test/replay.mjs` drives the rig with a **recorded tracker session** instead of
a synthetic sweep. A sweep somebody wrote by hand encodes an assumption about
what a camera produces — smooth curves, one axis at a time, tidy extremes.
Real tracking jitters, drops out, and reaches combinations no sweep tries.

To record one: start the camera, then **☰ → Camera & tracking → Record 60
seconds**. Move the way you normally would. It saves `tracker-session.json`;
put that in `test/fixtures/` and the suite picks it up.

The file holds numbers only — blendshape weights, head angles, body landmark
coordinates, the same values the rig already works from. No video is captured
and no image data is written. It is plain JSON, and you can read it.

`test/model.mjs` guards the cut. Every baked part keeps image-space
coordinates, so stacking the committed PNGs back at their stored positions has
to reproduce the artwork — that catches a part growing into its neighbour or a
margin leaking into open space. It also asserts each part *is* what it claims,
because a cut can reassemble perfectly and still have the helmet in the hair
layer, and it re-runs the bake to prove the committed files are what the cut
produces today.

The fake camera shows a test pattern rather than a face, so the smoke test
proves the pipeline runs — it cannot prove tracking accuracy. That part needs
a real face in front of a real camera.

---

## Known limits

- Tracking needs reasonable light on your face. Backlighting is the usual
  culprit when it feels unreliable.
- The **cut into parts** is written for the bundled ninja. It leans on facts
  about that drawing — a scarf whose colour separates the head from the body,
  gloves that are the scarf's colour but not joined to it. Other artwork is
  out of scope for now: the bake would run, but it may hand you one big part
  instead of thirteen.
- Arm tracking needs your shoulders in frame. Hips are not required — it falls
  back to measuring against the screen when you are sitting at a desk.
- Winks need good light; they are linked by default because half-detected
  winks look worse than no winks.
- The head pitch and yaw directions are what I believe correct for MediaPipe's
  convention, but I could not verify them against a real face here. If nodding
  or turning goes the wrong way, flip **Mirror me**, and tell me if that does
  not fix it — the sign is a one-line change in `src/tracking/rig.js`.
