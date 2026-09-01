# VTuber Model

A webcam-driven VTuber avatar that runs in your browser. Point a camera at
yourself and the model moves with you — head turns, nods and tilts, blinks,
eye darting, brow slant, and speech. Built to drop straight into OBS.

The built-in character is a masked ninja: charcoal helmet, glowing visor eyes,
spiky tufts, and a red scarf that flies on its own physics.

**Everything runs on your machine.** No video, no audio, and no tracking data
leaves the browser. There is no server and no account.

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
2. **Load your character.** Open **Your own artwork → Load my artwork…** and pick
   your PNG. It places the markers for you; check them, then hit **Done**. See
   [Rigging one flat image](#rigging-one-flat-image) for what each marker does.
   Skip this if you are happy with the built-in ninja.
3. **Sit how you normally stream** — straight on, head level — and press
   **Set neutral pose** (or `C`). Everything is measured relative to that pose,
   so this is what stops the model sitting at a permanent angle.
4. Open **Head** and turn the gains up until it feels right. Most people want
   more than reality: `1.5x`–`2x` reads far better on stream than `1x`, which
   looks stiff.

Redo the neutral pose whenever you move your chair or camera.

---

## Putting it in OBS

There are two ways in. **Read this bit** — the obvious one has a catch.

### The reliable way: window capture + chroma key

OBS's built-in browser cannot always get at a webcam, and when it fails it does
so silently. Capturing a real browser window sidesteps that entirely.

1. In the app, set **Background** to `Chroma key colour` (Output & OBS section).
2. Put the browser window on your second monitor and press `F11` for fullscreen,
   then `H` to hide the interface.
3. In OBS add a **Window Capture** source and pick the browser window.
4. Right-click the source → **Filters** → add a **Chroma Key** filter, key type
   Green.

### The clean way: browser source

Real transparency, no keying, but only if OBS's browser will open your camera.

1. Leave **Background** on `Transparent`.
2. Add a **Browser** source with the URL `http://127.0.0.1:5173`.
3. Set the size to 1920x1080, then scale the source in your scene.
4. Untick **Shutdown source when not visible**.

If the model appears but never tracks — no face detected, no fps counter — OBS
did not get camera permission. Use the window-capture method instead; it is not
worth fighting.

Either way, keep the terminal window from step 3 of Setup running.

For a permanent install, `npm run build` writes a static site to `dist/` you can
serve from anywhere.

---

## Hotkeys

| Key | Does |
| --- | --- |
| `C` | Set neutral pose — press this after sitting down |
| `H` | Hide or show the interface |
| `M` | Mirror the camera |
| `1`-`5` | Hold for blush / angry / sparkle / nervous / shocked (built-in character) |

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
| Head sits at an angle | Press **Set neutral pose** |
| Movement feels stiff | Raise the **Head** gains |
| It moves the wrong way | Toggle **Mirror me** (`M`) |
| Speech is unreliable in low light | Set **Speech → Driven by** to `Microphone` |
| Background noise triggers the mouth | Raise **Mic noise gate** |

---

## Changing how it looks

Everything under **Look** is live — colours, visor eye shape, and accessories.
There are four colour presets to start from. Scarf length and how hard the
tails billow live under **Body & scarf**.

Since the design is masked, there is no mouth. Expression is carried entirely
by the visor eyes: they narrow, slant with your brows, flare when you are
surprised and burn red when angry. Your speech drives the glowing vent along
the bottom of the visor instead.

### Rigging one flat image

The quickest way to use your own character: **one PNG, no layers, no redrawing.**
Open **Your own artwork → Load my artwork…**, pick the file, and check the five
markers it places for you:

| Marker | Where it goes |
| --- | --- |
| **head** (blue circle) | Around the whole head. Drag the corner dot to resize |
| **neck** (pink dot) | Where the head pivots when you tilt |
| **waist** (green line) | Below this, the body barely moves — for when you crop to a bust |
| **left / right eye** (yellow boxes) | Over each eye, with a little face around it |

Tick **Show regions** to see what it worked out — cloth in red, hair in blue,
face plate in yellow, torso in green, legs in purple. If something is in the
wrong region, move the head circle or the waist line until it isn't.

Hit **Done**. It then turns, nods, tilts, leans, breathes, blinks and squints,
and the cloth and hair trail behind the motion.

**What it does, and how**

- **Turn and nod** — the head is rotated on a cylinder, so the side turning away
  compresses and the side turning toward you spreads. On top of that the face
  plate is treated as sitting in front of the skull, so it slides across as you
  turn. That parallax is what sells the rotation.
- **Tilt** — a real rotation about the neck marker.
- **Overshoot** — head angles run through a spring, so the head settles instead
  of stopping dead.
- **Cloth and hair** — solved as a displacement field along each piece: nodes
  pull toward the one before them, which sends a wave outward, and back toward
  the drawn pose, which returns them home. Driven by the head's own inertia plus
  a little wind, so the scarf still moves when you hold still.
- **Blink and squint** — lids sweep across each eye box in a flat colour sampled
  from the face around the socket. They bow, travelling further at the middle
  than the corners, and they follow the eyes' own angle — drawings rarely have
  level eyes.
- **Glow** — rides on whatever is bright inside each socket, pulsing slowly and
  flaring when you move sharply.

**Tuning**, all in the same panel: head turn/nod, face depth, overshoot, scarf
travel and stiffness, tuft travel and stiffness, idle drift, squint, glow,
waist-down movement, mesh detail, and a white-background key for art saved
without transparency.

Your image is remembered in the browser between sessions. Very large files may
not fit, in which case the panel says so and you re-pick it next time.

**Limits worth knowing**

- Past roughly ±30° the turn starts to smear. There is no hidden far side of a
  flat drawing. It is at its best in the range people actually move in.
- Nothing can pass in front of anything else — it is one continuous sheet, which
  is also why it can never tear a hole.
- Hair sticking off a hood is usually the same colour as the hood and sits inside
  the head's own radius, so the split between them is approximate. Tufts get
  their own lag layered on top of the head's motion rather than being cleanly
  separated.
- A neutral, front-facing bust rigs better than a dynamic full-body pose.

### Using layered artwork

If your art is already cut into layers, you get sharper results. Name the
files as below, put them in one folder, and use
**Your own artwork → Choose a folder of PNGs**.

| File | What it does |
| --- | --- |
| `body.png` | Torso — leans, twists and breathes |
| `head.png` | Head — turns, nods, tilts |
| `hair-back.png`, `hair-front.png` | Swing behind and in front, with lag |
| `eyes-open.png`, `eyes-closed.png` | Swapped on blink |
| `eyes-half.png` | Optional mid-blink frame |
| `brows.png` | Rides the brow channel |
| `mouth-rest.png` | Fallback mouth |
| `mouth-a/e/i/o/u.png` | Viseme set, chosen from your speech |
| `mouth-smile.png` | Used while smiling |
| `blush.png` | Fades in with the blush expression |

Only `body.png` and `head.png` are required; anything missing simply will not
animate. Add a `manifest.json` beside them to override pivots and draw order.

---

## How it works

```
camera ─> FaceTracker ─> Rig ─> avatar backend ─> canvas ─> OBS
```

- **`src/tracking/faceTracker.js`** — webcam capture plus MediaPipe
  FaceLandmarker. Produces 52 ARKit-style blendshape scores and a head
  transformation matrix per frame. Tries the GPU delegate, falls back to CPU.
- **`src/tracking/rig.js`** — the interesting part. Mirrors the signal so the
  model reads as your reflection, subtracts your calibrated neutral pose,
  shapes and filters each channel, then adds the motion you never perform
  yourself: breathing, idle sway, tuft lag and auto-blink.
- **`src/core/oneEuro.js`** — a One Euro filter. Face tracking has to be dead
  still when you hold still and instant when you move; a fixed low-pass can
  only do one of those, so this widens its own cutoff as the signal speeds up.
- **`src/avatars/procedural2d/`** — the built-in character, drawn entirely in
  code so it needs no art and recolours live. Head turn is faked by rotating
  each feature rigidly about the helmet's axis, so features crowd together the
  way a real face does rather than just sliding sideways.
- **`src/avatars/procedural2d/ribbon.js`** — the scarf. A Verlet chain with
  hard length constraints, which stays stable however fast you whip your head.
- **`src/avatars/warp2d/`** — rigs a single flat image. A deformation mesh is
  laid over the artwork and bent in a vertex shader, each vertex carrying six
  region weights so parts move independently without ever tearing a hole.
  `segment.js` works out those regions from the picture; `cloth.js` solves the
  scarf and hair as a displacement field rather than as geometry, so the rest
  state is exactly the drawing; `shader.js` owns the cylindrical head turn and
  the eyelids.
- **`src/avatars/layered2d/`** — drives your own PNG artwork from the same rig,
  when it is already cut into layers.

Libraries are vendored from npm and the tracking model is downloaded once at
install time, so the app has no CDN dependency and works offline.

---

## Tests

```bash
npm test           # all three suites
npm run test:rig   # rig maths, headless, no camera needed
npm run test:warp  # mesh warp: head motion, blink, background key
npm run poses      # renders the built-in character across 16 poses
npm run warp-demo  # drives real artwork through the rig, with a control cell
```

`test/rig.mjs` feeds synthetic frames straight into the rig and checks
mirroring, calibration, clamping, blink behaviour and recovery from a stalled
frame. `test/smoke.mjs` boots the real app in Chromium against a fake webcam
and checks the whole pipeline comes up.

The fake camera shows a test pattern rather than a face, so the smoke test
proves the pipeline runs — it cannot prove tracking accuracy. That part needs
a real face in front of a real camera.

---

## Known limits

- Tracking needs reasonable light on your face. Backlighting is the usual
  culprit when it feels unreliable.
- Winks need good light; they are linked by default because half-detected
  winks look worse than no winks.
- The head pitch and yaw directions are what I believe correct for MediaPipe's
  convention, but I could not verify them against a real face here. If nodding
  or turning goes the wrong way, flip **Mirror me**, and tell me if that does
  not fix it — the sign is a one-line change in `src/tracking/rig.js`.
