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
averaged, not copied (copying drew stripes into the eye socket). The margin
is solid near the art and fades toward its edge, so a large move shows a soft
edge rather than a slab. A byte per texel records how invented each pixel is,
so the renderer can cap how much of the margin a part draws (`parts.clothMargin`
for the scarf, 8 px; 32 px for everything else).

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

**2026-09-05 — The cut runs once, offline.** `cutParts` is deterministic in
its inputs and ran on both pages at every load, twice each (the artwork and
the head-on view): about 45 full-image sweeps and nine per-part dilation
floods, and any change to a `warp.*` setting re-ran it. `npm run bake` writes
`public/model/ninja/`; `npm run bake:check` proves a re-bake reproduces every
committed byte and that the browser decodes the PNGs to the bytes the bake
produced (createImageBitmap with no premultiply and no colour conversion).
The production bundle dropped 38 KB.

## The rig

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

## The renderer

**2026-09-04 — The head-on latch decides on where the head has been.** A
threshold on the live angle changed hands 33 times in a real minute; a wider
band moved that to 19. Averaging the angle over about a second, holding the
view for `parts.headOnDwell` after a change, and ramping the swap over a fixed
time brought it to 3. The swap sits halfway through an eased ramp: an
exponential decay moved 14 px (measured 19) between one frame and the next.

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
still collar as a cutout, and the collar's painted margin shows wherever the
head moves away.

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

**2026-09-05 — A hidden tracker tab is reported, not fixed.** A hidden or
covered tab gets about one animation frame a second, and OBS is starved for
exactly that long. The status pill says so when the window comes back. A
Worker-timer loop that keeps tracking while hidden is the one change on this
branch only the owner can verify at a desk.

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
