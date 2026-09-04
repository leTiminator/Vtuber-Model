# Roadmap

Where this project is, what it has cost to get here, and what is left — in the
order it should be done. Written after a week of daily reports that the same
faults persisted, so the first section is about how work here gets verified,
not about features.

## How work gets verified now

Every fault reported this week turned out to be measurable, and every one was
first "fixed" by a change that a harness said was fine and a person could see
was not. The rule from here:

1. **A complaint becomes a measurement before it becomes a change.** The
   scarf's stretch was reported for a week as a feel; measured, it was an edge
   of cloth growing to 116% of its drawn length. That number is now a check
   that fails if it comes back.
2. **The live readout is the shared instrument.** Press `D` on the tracker
   page. It shows the raw angles beside the driven ones, the neutral pose
   between them, which face is showing, whether the pose model is running and
   how often, whether each arm is seen, and how far the face zoom is in. A
   report that quotes it can be acted on the same day; one that does not
   starts another round of guessing.
3. **The build stamp is on the stage.** The corner shows the commit. If it
   does not match the link, the browser is holding an old build.
4. **Green is eight suites, locally and in CI**, and nothing ships red. The
   suites run on every push; the deployed link always carries the commit.

## Where we are

Done and live (`main` deploys to `https://letiminator.github.io/Vtuber-Model/`):

- **Tracking** — MediaPipe face landmarks with blendshapes and a solved head
  pose; the pose model for shoulders, elbows and wrists on a stride; one-euro
  filtering; a captured neutral pose; the camera cropped to the face before
  the tracker sees it, so sitting back from the webcam no longer costs the
  tracker its input; the body driven by the shoulders where they are seen,
  so it can sit turned while the head looks at the camera.
- **The model** — the original drawing cut into thirteen parts by
  connectivity and colour, reassembled exactly at rest. A rigid head cutout
  that slides for a turn and turns for a nod; a mirrored view past about
  thirty-five degrees; the frontal drawing's head swapped in when you face
  the camera, with its keyed-out eyes repaired on the way in. Eyes with lids,
  glow, gaze and blink; contact shadows; invented margins under every seam.
  Hair that lags. Breathing and idle sway.
- **The scarf** — as of this commit, a chain of rigid links pinned to a neck
  scarf that is one rigid piece. It bends and it does not stretch: 5% at
  worst held, against 116%; both seams at 0px through a tour of every axis;
  one piece at every extreme including the mirror. The lag down the ribbon is
  the chain-like movement that was asked for.
- **Output** — a model-only page for OBS as a Browser Source, with real
  transparency and no window to crop; the tracker page feeds it over the dev
  server; settings and pose cross, nothing persists on the OBS side, the last
  pose holds when frames stop.
- **Testing** — eight suites covering the rig, the cut, motion over the whole
  range, a replay of a real minute of tracking, boot, a phone-sized run, the
  warp backend and the OBS link; visual harnesses for the scarf, the faces,
  the dynamics; all of it in CI on push.

## What is still in the way, in order

### 1. Ship the scarf and have you look at it — now

The rebuild is committed and measured. Three checks want small adjustments
before it goes out (settling time in two, a displacement ceiling at the
extreme settings in the third), then the full run, then `main`.

Then the one thing no harness can do: **you run it with the readout up** and
say what you see, quoting the readout for anything wrong. Specifically:
does the ribbon lag and settle when you move; does the chin stay in the
scarf when you turn and nod; does the head-on face show when you face the
camera, and if not what do the *raw* and *driven* yaw lines read while you
do; does the body turn with your shoulders.

### 2. Arms — the evidence is already in

Your own recording answers "arm tracking is still not working". In sixty
seconds and 1,379 frames, **the wrists are never in the picture** — one is
absent in every frame, the other appears in 85 — and the elbows fall below
the bottom edge of the frame more than half the time. Your shoulders sit at
75–84% of the frame's height. The camera is framed at the chest, and the pose
model cannot track an arm it cannot see.

Two fixes, both needed:

- **Framing.** Move the camera back or down until the readout says both
  elbows are seen while your hands are at the keyboard. The face zoom now
  keeps the tracker sharp when you do, which is why it exists.
- **A rig that degrades honestly.** Today a missing wrist zeroes the raise
  and a missing elbow decays the arm to rest, so an arm at the edge of the
  frame flickers between moving and not. With the wrist gone the raise should
  come from the elbow's height; with a joint lost for a moment the last value
  should hold; and the readout should say *wrists out of frame* in those
  words, because that is the fix and it is not in the code.

### 3. Edges for streaming

The blend writes premultiplied colour into a canvas declared straight, so
soft edges composite toward black. Against this character's own ink outline
it is hard to see; on a light OBS scene it is a dark fringe round the whole
figure. It touches the blend, the shader and the shadow pass across three
backends, and needs a check against a light background rather than the
transparent one the suite uses.

### 4. The sash over the hip

The scarf's waist piece is drawn behind the body, and nothing is painted
under it, so any movement of the body shows a slice of background through the
sash. It no longer swings with the ribbon (connectivity keeps it with the
body), so this is now purely a draw-order and margin question.

### 5. Golden images

A handful of canonical poses rendered and diffed in CI, so a change that
alters the look without breaking a measurement is caught. Cheap now that the
harnesses exist; it would have caught two of this week's regressions early.

### 6. Blinks from drawings

`public/art/views/head-front-closed.png` is the three-quarter head with the
eyes genuinely shut; the frontal pose has no shut-eye drawing yet. Both faces
still blink by erasing the shard. With shut-eye drawings for both, a blink
becomes a swap plus a half-state rather than an erase, and reads as a lid.

### 7. Speaking

The mouth is under the scarf, so there is nothing to lip-sync — but the
tracker's jaw-open weight is there, and a small bob of the head and neck scarf
on speech would read as talking where a still face reads as a recording.

### 8. Views for a real nod

A nod is a rigid turn of the cutout, which is a cheat that works up to about
thirty degrees. A frontal head drawn looking up and one looking down would
make it a swap between real views. Low priority until everything above holds.

## What is deliberately not on this list

- Warping the drawing to invent views that were never drawn. Tried twice
  (cylinder, shell); both read as distortion. The model swaps drawings now.
- Capturing a desktop window into OBS. Window capture has no alpha channel
  and a frameless window may not be listed; the Browser Source route is what
  the tools that do this for a living use, and it is in.
