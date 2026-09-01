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

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install     # also fetches the tracking model, about 26 MB, once
npm run dev     # then open the address it prints, usually http://localhost:5173
```

Click **Start camera** and allow camera access when the browser asks.

If the download is blocked or interrupted, re-run it on its own with
`npm run assets`.

---

## First run

1. **Start camera.** The first start takes a few seconds while the tracking
   model loads.
2. **Sit how you normally stream** — straight on, head level — and press
   **Set neutral pose** (or `C`). Everything is measured relative to that
   pose, so this is what stops the model from sitting at a permanent angle.
3. Open **Head** and turn the gains up until the movement feels right. Most
   people want more than reality: `1.5×`–`2×` reads much better on stream than
   `1×`, which looks stiff.

Redo the neutral pose whenever you move your chair or camera.

---

## Putting it in OBS

1. Leave **Background** on `Transparent` (Output & OBS section).
2. In OBS, add a **Browser** source.
3. Set the URL to the address `npm run dev` printed.
4. Set the size to 1920×1080, then scale the source in your scene.
5. Press `H` in the browser window to hide the interface.

The page composites over whatever is beneath it, with real transparency — no
chroma keying needed. If your setup cannot do transparent browser sources,
switch **Background** to `Chroma key colour` and key out the green in OBS.

For a permanent install, `npm run build` writes a static site to `dist/` that
you can serve from anywhere.

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

### Hotkeys

| Key | Action |
| --- | --- |
| `1`–`5` | Hold for blush / angry / sparkle / nervous / shocked |
| `C` | Set neutral pose |
| `H` | Hide the interface (use before capturing in OBS) |
| `M` | Flip mirroring |

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

The quickest way to use your own character: **one PNG, no layers, no
redrawing.** Open **Your own artwork → Load my artwork…**, pick the file, and
mark up four things by dragging them onto the picture:

| Marker | Put it |
| --- | --- |
| **head** (blue circle) | Around the whole head. Drag the corner dot to resize |
| **neck** (pink dot) | Where the head should pivot when you tilt |
| **left / right eye** (yellow boxes) | Over each eye, with a little of the face around it |

Hit **Done** and it turns, nods, tilts, leans, breathes and blinks.

It works by laying a deformation mesh over your image and bending it —
the same idea Live2D is built on. Blinking re-samples the colour from just
above each eye box and paints it down over the eye, so it adapts to whatever
your art looks like without needing a separate closed-eye drawing. That is why
the eye box wants a little margin around the eye.

Tuning, all in the same panel:

- **Head turn / Head nod** — how far the head slides and squashes. Turn these
  up for a stylised look, down if the art starts to smear
- **Cloth ripple** — travelling wave on loose parts like scarves and hair
- **Mesh detail** — grid resolution; raise it if bending looks faceted
- **Cut white background** — for art saved without transparency
- **Blink the marked eyes** — switch off if your art has no visible eyes

Your image is remembered in the browser between sessions. Very large files may
not fit, in which case the panel says so and you re-pick it next time.

This is a warp, not real 3D, so extreme head turns will smear. It is at its
best in the ±30° range most people actually move in.

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
  laid over the artwork and bent in a vertex shader; each vertex carries a
  head weight (so it turns with the head) and a looseness weight (so cloth
  ripples). Blinking happens in the fragment shader by re-sampling the colour
  above each eye box and painting it down, which needs no closed-eye art.
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
npm run poses      # renders the character across 16 poses to preview.png
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
