# Decisions

One entry per decision that shapes the code, with the measurement that made
it. Comments in the code say what it does now; this file says why, and keeps
the numbers. Dates are when the decision was made. Add an entry when you
change one; do not argue with one in a comment.

## The model

**2026-09-01 — A parts puppet, not a mesh warp.** A single warped sheet can
never tear a hole, but nothing on it can move on its own: the head and arms
inherited the scarf's motion because they shared its sheet. The drawing is cut
into parts, each its own texture on a joint hierarchy, and every part keeps
image-space coordinates so the stack reassembles to the drawing at rest. The
reassembly is a check (`test/model.mjs`, under 0.5% of opaque pixels wrong;
0.034% today).

**2026-09-02 — The cut is by connectivity, not by distance from a marker.**
The head marker is derived from eye spacing, and on this drawing the visor
shards are small next to the helmet: the estimated radius came out at 54 px
against a helmet 280 px across, and every distance rule inherited the error
(the tufts held the back of the helmet). Three facts about the drawing carry
the cut instead: the scarf wraps the neck and separates the head from
everything below; the gloves are the scarf's red but not joined to it; an arm
is whatever is joined to a glove. A glove must be a real piece (the real ones
are 9.4% and 4.6% of the head's area; the anti-aliasing sliver that once stole
a sleeve was 1.0%). Specks are dropped before the second pass, but only
specks: a threshold of 139 px took reassembly from 0.03% wrong to 6.3%.

**2026-09-02 — Margins are painted under the part in front, and only there.**
Every part is dilated 28 px past its edge by flooding its own colours outward,
so a part that moves reveals paint rather than a hole. Neighbours are
averaged, not copied (copying drew stripes into the eye socket). A byte per
texel records how invented each pixel is, so the renderer can cap how much of
the margin a part draws (`parts.clothMargin` for the scarf, 8 px; 32 px for
everything else).

**2026-09-06 — Margins are solid, and a hood stands behind each head.** The
margin used to fade over its last fifteen pixels so a large move would show a
soft edge rather than a slab; on the owner's screen that fade was "a blurry
section revealed when the head stretches out of its socket", and the head-on
hair's margin, grown under the head-on drawing's own scarf (4,041 of the
piece's 9,339 pixels), showed as streaks beside the hair once placed over the
turned drawing. Now every margin is solid through its 28 px; the head-on
pieces' margins grow only under each other (`cutParts` takes `keep`); and two
synthesized parts, `hood` and `hoodOn`, hold each head's own footprint (eye
sockets included, eroded a pixel) in one flat colour, the head's median
surface darkened to 60%, still on the hips behind it. Nothing shows at rest;
a head that slides or rolls reveals a dark crescent of hood. The hood sits
between the collar and the hair (tufts moved above the collar, 2026-09-06):
drawn over the hair it cut the tufts wherever a moved head exposed it.

**2026-09-02 — Enclosed holes are filled with a fitted quadratic.** The eye
is cut out of the head, and what fills the hole is what shows through a shut
lid. A plane matched the average and missed the visor's curvature; six terms
follow the highlight. Boundary pixels that disagree with a first fit are
dropped (a robust pass), because the ring around a cut slit carries a few
pixels of ink and of shard.

**2026-09-03 — The head-on view is a second drawing, not a synthesis.** The
first version slid the near eye shard onto the head's centre line and mirrored
it into the far eye's place, and that is what read as "the eyes slide on the
face". `public/art/views/pose-front-arms-out.png` draws the character facing
the camera; its head is registered onto this one's (scaled 1.25x) and swapped
in when the head is square. The two faces swap rather than fade: halfway
through a fade there were plainly two visor rims and two chins.

**2026-09-03 — The alternate views arrive with their eyes keyed out.** Every
view rendered on white and keyed lost its near-white eye shards: about 300 px
of transparent hole each, plus thinned edges and speckles at a third alpha.
`scripts/bake/repair.js` fills transparency the outside cannot reach when it
is under 4,000 px (the scarf's loop encloses 12,997 px of genuine background;
the eye holes are at most about 1,300). Partial alpha counts as damage; the
fit fills only what the key removed, in proportion.

**2026-09-04 — The head is a rigid cutout.** A cylinder bend and then a
rounded shell both tried to show the face from an angle it was never drawn
at, and both read as distortion, with a nod whose direction nobody could
read. A nod rotates the cutout about its centre; a turn slides it. Both were
deleted on 2026-09-05 with their six settings; every golden was unchanged to
within seven pixels of 102,400, and putting the deleted twelve-row grid back
under the head returned those to zero, so the difference is rasterisation at
former internal triangle edges.

**2026-09-04 — No mirror flip.** Swapping the head for its mirror image past
about 35° gave the opposite three-quarter view, at the cost of a 40 px jump
of the whole head in one frame, a hysteresis latch, and a margin cap for the
flipped parts. With the mirror off, the slide that compensated the flip still
fired past yaw -0.70 rad, which the rig reaches at its 42° limit: the head,
hair and eyes jumped about 80 px sideways. Removed 2026-09-05. The drawn
three-quarter view plus the head-on drawing cover the range.

**2026-09-06 — The turned face has two sides, chosen behind the head-on
face.** The drawing looks to the right, so a turn to the left slid the head
left with a face still looking right: the owner saw "no left view". The four
turned-face parts are reflected about the head's centre line before their
joint moves them (eye channels swapped, gaze x and the shadow offset negated;
the shader is untouched). The side is decided only as the head-on face gives
way, while it still hides the turned face, so unlike the 2026-09-04 mirror
the swap is never seen; with the head-on face off the side never changes.

**2026-09-05 — The cut runs once, offline.** `cutParts` is deterministic in
its inputs and ran on both pages at every load, twice each (the artwork and
the head-on view): about 45 full-image sweeps and nine per-part dilation
floods, and any change to a `warp.*` setting re-ran it. `npm run bake` writes
`public/model/ninja/`; `npm run bake:check` proves a re-bake reproduces every
committed byte and that the browser decodes the PNGs to the bytes the bake
produced (createImageBitmap with no premultiply and no colour conversion).
The production bundle dropped 38 KB.

## The rig

**2026-09-06 — Smoothing was costing a fifth of every turn.** The one-euro
filter shipped at 1.2 Hz with a speed coefficient of 0.06. Measured against
the owner's own recording for rest wobble and a synthetic shake for
responsiveness: a step to 30° reached 90% after 360 ms, and a 0.8 Hz shake ran
120 ms behind at 82% of its size (61% at 1.5 Hz), so a quick turn could miss
the latch's hold entirely. At 2.5 Hz and 0.20 the same shake is 40 ms behind at
94% (84% at 1.5 Hz) and the median frame-to-frame wobble at rest rises from
0.208° to 0.238° — three hundredths of a degree, well under a pixel on the
head.

**2026-09-03 — The nod sign is fixed in code, from photographs.** Two
photographs of the running app, one looking up and one looking down, with the
head found by connected components: looking down put the head 77 px higher
on screen than looking up. `PITCH_SIGN` in `rig.js` corrects it; `head.flipNod`
is a preference on top. The setting was renamed from `head.invertNod`, because
a saved value outlives a change of default.

**2026-09-03 — A neutral is bounded per axis and earned, never guessed.**
Measured on a session at a desk: resting yaw has a median of 1.3°, pitch 17°
down (that is where the screen is), roll 0.5°. A second session, at the
camera position its owner uses, rests at 26° of yaw because the lens is
beside the screen. So the bound is a backstop against a figure no camera
placement explains, and steadiness is what tells a rest from a glance: a pose
has to hold for a stretch before it is believed, and an automatic capture
that finds none gives up rather than saving a guess. A requested capture
counts down three seconds so the person can look where they mean to; taken
from the button it read 38° from the camera, because the button is on the
screen. An automatic capture never replaces a neutral somebody already set.

**2026-09-03 — Head speed is capped.** A real session found the face at yaw
-0.29, lost it for one frame and found it at +1.14: 82° in a tenth of a
second, a bad estimate on reacquisition. The One Euro filter passes a jump
like that almost untouched, because a large derivative is what widens its
cutoff. `MAX_HEAD_SLEW` (6 rad/s) and `MAX_HEAD_DRIFT` (5 head-widths/s) sit
well above a brisk human turn (about 5 rad/s for a quick 45° glance) and turn
a teleport into a short lean.

**2026-09-03 — Losing the face holds the pose, then lets go.** Nine of
eleven dropouts in a recorded session began from a downward pitch (a cap
brim), four lasting over a second. Decaying to neutral made the model look
up when the person looked down. The pose is held for a short absence and
released gradually after; expressions are not held.

**2026-09-04 — The lid the gaze accounts for is not a blink.** Looking down
pulls the upper lid down. On a recorded session the blink weight correlated
+0.79 with the eyes looking down and shut the model's eyes in 105 of 247
frames with nobody blinking. `eyes.gazeLid` takes that part back out; the
strongest genuine blink still clears the shut threshold. Squint tracks the
blink weight at +0.71 and is corrected the same way.

**2026-09-04 — The body comes from the shoulders where they are seen.** Turn
from foreshortening against the shoulder width captured at rest (the
widest-ever was a ratchet: one lean toward the camera held the body at a
quarter turn for a session), lean from where the shoulder line sits, rise
from its height. Blended by how confidently the pose model has the shoulders.

**2026-09-04 — What is not seen is not measured.** On a recorded minute at a
desk one wrist was absent in every frame, the other present in 6%, and the
elbows below the frame more than half the time (shoulders at 75-84% of the
frame's height). A missing wrist used to read as a wrist at zero. Now the
raise comes from the elbow's height when the wrist is gone, a joint lost for
a moment holds its last value, and the readout says which joint is out of
frame.

**2026-09-03 — The face is cropped before the tracker sees it.** Sitting back
from the camera leaves the detector a face a few dozen pixels across. The
crop follows the face, padded, eased, never faster than the face moves, and
opens out when the face is lost. The head position is un-cropped with the
crop the detection was made through, not the crop aimed for the next frame.
Finding a face takes real evidence; keeping one takes much less (the face was
present 71% of a minute with 28 gaps, the longest 1.5 s).

**2026-09-06 — A blink is a rise over the eye's own baseline.** On the
owner's recording the raw blink score rests at a median of 0.52 (glasses, a
beard, a camera above eye level) and never exceeds 0.83, and at each of its 35
real blinks the eyes-looking-down score jumps too, so the static gaze-lid
subtraction cancelled the blink: through the rig with defaults and auto-blink
off, the whole minute produced one blink event. No threshold can separate
that. The rig now takes the larger of the absolute reading and a transient
one: the raw score's rise over its own rolling median of the last 0.7 s,
mapped from 0.12 to 0.28 (this face's full blinks rise about 0.33), and faded
out when the rise lasts past a quarter second, because a blink is a pulse and
a glance down is a step. Eyes held shut stay shut through the absolute path.
On the recording, 24 of 34 rises now reach the screen as blinks.

**2026-09-06 — The app calibrates from its own recording.** Resting yaw of
-26° and pitch of -22° on the same recording, and a fixed threshold that could
not fit the face: `src/tracking/calibrate.js` reads the neutral (medians, in
the rig's mirrored space), the gaze-lid slope and the open threshold off a
recording, and reports what software cannot fix (a jaw the camera never saw,
elbows below the frame in 98% of frames). Recordings are saved into the
project by the dev server and pushed to the `recordings` branch with git
plumbing, so nothing is uploaded by hand and the checkout is never touched.

**2026-09-06 — Tracking is checked against a recording before the model is
blamed.** "Tracking still doesn't work" came with a readout of `seen roll
+43° → driven +25°`. The recording behind it holds a tilt of -44° for twelve
seconds and +29° for six, steady to a degree or two within each second, with
the shoulder line leaning 8° the same way: a real tilt, pinned at the rig's
25° limit. MediaPipe's transformation matrix is column-major (the bundle
copies the proto's packed data, filled from an Eigen matrix), which is how
`eulerFromMatrix` reads it. What failed was the model's answer: the latch,
the missing left view and the margin, above.

**2026-09-06 — The neutral is where you look while streaming, and a guided
calibration reads it.** The owner's readout showed a neutral 49° from where
they sat: set with C looking straight at the camera, which they then
suggested as the calibration's first step. On this desk the camera is 49°
from the screen, so a camera neutral leaves the model pinned at its 42°
limit whenever they look at their screen, and nothing the head does reaches
it. The guided calibration (`guide.js`, driven by G) therefore asks for the
streaming gaze first, then left, right, up and down; each pose is a steady
run (`capture.js`, the same definition C uses), a turn counts from 8° and
times out as "not measured" after 12 s. The larger turn is mapped onto 38°
and the larger nod onto 28° through `head.yawGain` and `head.pitchGain`
(0.5 to 2.5), the range is kept in `camera.range` for the readout, and the
neutral records where it came from. A driven yaw or roll within half a degree
of its limit for three seconds raises a warning naming how far the head reads
from the neutral, because a pinned model is the one symptom the owner sees as
"not moving with my head".

## The renderer

**2026-09-06 — A sweep across centre brings the face back at once, and the
side follows the head.** The turned face's side was chosen once, as the
head-on face gave way. Shaking the head left and right never dwells at centre
long enough for the 0.35 s return, so the latch stayed off and the side stayed
where it was: on the owner's two recordings the face pointed the way the head
was not for 5.0 s and 18.5 s of a minute, in 2 and 8 runs, and the left-facing
view appeared twice a minute against the right's six. Now the side follows the
head whenever the head-on face is up to hide the change, and a sweep past 35%
of the hold on the far side brings that face straight back — quicker than the
0.18 s ramp, so the ramp is completed rather than started. Both recordings now
show 0 wrong-way frames, and a 0.8 Hz shake shows all three views.

**2026-09-06 — The head-on latch leaves quickly and comes back slowly.**
The first latch (2026-09-04) averaged the angle over about a second and held
each view for 1.1 s after a change, because a bare threshold changed hands
33 times in a real minute; on the owner's second recording it changed 9 times
for 19 crossings, each 0.4 to 2.0 s late, and skipped a 3.2 s turn: "it
seems to be on a timer". `latch.js` gives way once the turn has stayed past
the hold for 0.08 s and comes back once the head has stayed inside the hold
for `parts.headOnReturn` (0.35 s) and is inside three quarters of it: 15
changes, the slowest leave 0.08 s and the slowest return 0.28 s after the
crossing (22 of 28 and 0.34 s on the first recording). The swap still sits
halfway through an eased ramp: an exponential decay moved 14 px (measured 19)
between one frame and the next.

**2026-09-04 — The scarf is a chain of rigid links rooted on the shoulder.**
A displacement field stretched the ribbon to 116% of its drawn length. Every
link keeps its drawn length after each step, root outward; what moves is the
angle at each joint, pulled toward the drawn direction. The first version was
a follower chain and ran away (the tip a thousand pixels out); a joint that
pulls both its nodes is conservative. A hard angle stop jammed a folded spiral
for good, so the fold limit is soft. Friction between neighbours and a
per-step travel ceiling exist because a 19 px yank once put the tip 600 px
out. Only cloth the chain runs through is carried by it (decided by
connectivity); the sash at the waist stays with the body. The chain is
skinned on the CPU because per-vertex indexing of a uniform array put the
middle of the ribbon somewhere else on a phone.

**2026-09-04 — The neck wrap is drawn behind the head.** In front, it
covered the visor when the head rolled, and following the chin sheared it
(more than twice an edge's drawn length). Behind, the head slides over a
still collar as a cutout, and the hood behind it shows wherever the head
moves away.

**2026-09-04 — Contact shadows multiply by destination alpha.** A soft dark
copy of each part is drawn just before it, so it lands on everything behind
and nothing in front. Multiplying by the destination alpha keeps it off the
empty background; otherwise a transparent OBS source gets a black halo. The
shadow's blur is kept tight: spread out, it reached the glowing slit.

**2026-09-05 — The canvas is declared premultiplied.** The blend already
wrote colour times alpha into a canvas declared straight, so the compositor
multiplied again and soft edges went dark on a light scene. The attribute is
the whole fix; the shadow pass writes rgb = 0 and is unaffected. A page
screenshot over white is a golden (`composited-on-white`), because the
drawing buffer cannot see the compositor.

**2026-09-04 — Offsets are a fraction of the shorter side.** In pixels, the
same setting framed differently at 1280 and 1920 wide, so the shot composed in
the browser was not the shot OBS rendered. One module (`src/core/framing.js`)
is shared by the renderer, the pointer handling and the fit presets.

**2026-09-05 — Speech lifts the visor glow and bobs the head.** The mouth is
under the scarf. `mouth.open` adds 0.35 to the glow's pulse target and drops
the head 0.0065 of the drawing's height, both zero at a closed mouth.

## The two pages

**2026-09-04 — OBS opens a page of its own.** OBS's browser cannot reliably
open a webcam, and running the tracker beside the encoder in an older
Chromium is the wrong place for it. Tracking stays in a real tab; the OBS page
draws and nothing else, never shows a message (everything on it is on
stream), and never saves a setting (its storage would win over the tracker's
for a second or two at the top of every stream).

**2026-09-05 — The solved rig crosses the wire, not raw frames.** Raw
frames carried 478 landmarks nothing read (30-40 KB a frame), and the OBS page
ran a second Rig over them, so the two pages could disagree. Now
`{ t: 'state', seq, at, state }` crosses once a frame (about 900 bytes), the
OBS page holds the last state through silence, and the relay replays the last
settings and state to a window that opens late.

**2026-09-05 — A hidden tracker window keeps tracking from a Worker timer.**
A hidden or covered tab gets about one animation frame and one video frame
callback a second, so OBS was starved for as long as the tracker sat behind
a game. `src/core/ticker.js` ticks at 30 Hz from a Worker, whose timers are
not slowed, and while the document is hidden each tick runs one detection
and one step of the pipeline. Headless Chromium cannot hide a page, so the
suite proves only that the timer runs at its rate without animation frames;
whether MediaPipe keeps delivering from a covered window is for the owner to
confirm at a desk, and the status pill still reports how long the window was
hidden.

## The process

**2026-09-05 — Goldens plus invariants replace pinned thresholds.** The
motion suite held 42 checks, 20 of them thresholds tuned to the current
renderer; 28 of the last 50 commits touched it, and it ran 18 minutes in CI.
Eighteen golden poses at 320 px with one tolerance (a pixel differs past 16
on any channel, a pose fails past 0.1% of pixels) and sixteen invariants
replace it. Every job runs in under three minutes.

**2026-09-05 — Delete, do not demote.** Off used to mean a store key that a
runtime lookup could apply to half a feature: the mirror was gated on its
setting, its slide on its latch. Twenty-three store keys, two abandoned
renderers, the artwork flow and the expression channel are gone rather than
switched off; git history keeps them.
