# Alternate views

Drop new drawings of the character here. Nothing reads this folder
automatically; each view gets wired into the rig deliberately, because each one
changes what the model can do.

**Filenames do not matter to the code, and cannot be trusted by a reader.**
Upload whatever they are called. What is in each file below was measured, not
inferred from its name — a name I gave one of these files by hand sent me to
the wrong drawing for a whole round of work.

## What is in this folder

| file | what it actually is | used for |
| --- | --- | --- |
| `pose-front-arms-out.png` | **The frontal view.** A different pose: rounder hood, symmetric visor, two matched eye shards, arms out. Its head is 145 × 150 at (326, 282), against the main artwork's 177 × 188 at (446, 318). | **The head-on face.** Its head, hair and eyes are cut, registered onto the main artwork's head, and swapped in when you face the camera. |
| `head-front-open.png` | The same three-quarter head as the original, with the eyes repainted looking forward. 789 pixels differ inside the head's whole box, and they are the eyes. | not wired in |
| `head-threequarter.png` | The same head again, with sharper, angrier eyes. | not wired in |
| `eyes-wide-pupils.png` | The same head, eyes wide with pupils. | not wired in |
| `head-front-closed.png` | The same head with the eyes genuinely shut — no bright shards anywhere. | not wired in; the best drawing here for real blinks |

## Every one of these arrived with its eyes missing

Not dim, not mis-detected — **gone**. The renders came out on a white
background, that background was keyed away, and this character's eyes are
white, so they were keyed away with it. In the frontal view that is two
transparent patches of about three hundred pixels each, exactly where the
shards belong.

Nothing downstream can see an eye that is not there, so this quietly disabled
the head-on face and looked from outside exactly like a bug in the rig.

`src/avatars/parts/repair.js` puts them back on the way in. The rule is about
shape rather than colour: anything not fully opaque that the background cannot
reach is damage, and damage small enough to be a feature is filled in from its
own boundary. A hole that is *meant* to be there survives on size — the frontal
drawing loops its scarf over itself around thirteen thousand pixels of real
background, forty times the size of an eye.

So this is fixed on arrival and is not worth avoiding when you generate.

## What is worth drawing next, most valuable first

| Ends up as | What it is | Why it matters |
| --- | --- | --- |
| `head-up.png` | The frontal head looking up about 25° | A nod is a rigid rotation of the cutout, which is a cheat: a real one shows more jaw. |
| `head-down.png` | The same, looking down | The same, showing more crown. |
| `eyes-half.png` | Half-closed eyes, in the frontal pose | Makes a blink a movement rather than a switch. `head-front-closed.png` already gives the shut end, but for the three-quarter head. |
| A frontal `eyes-closed` | The frontal pose with its eyes shut | The frontal face is what shows most of the time now, and its blink is still faked by erasing the shard. |
| `head-profile.png` | About 70° | For turning fully away. Lowest priority. |

## Do not fight the file format

Upload what comes out. The mechanical problems are cheap to fix in code and get
fixed on arrival rather than sent back:

- **Eyes keyed out with the background.** Repaired, as above.
- **Wrong canvas size, or the character sitting in the wrong place.** The head
  is found in each drawing on its own terms and registered onto the main
  artwork's head by its measured centre and radius, so a pose drawn at a
  different size or position lands correctly.
- **A background instead of transparency.** Keyed out, if it is a flat one.
- **Stray specks and detached fragments.** Dropped.
- **Eyes not on their own layer.** The cut finds the eye shards by brightness
  and lifts them onto their own layer, so a head with its eyes attached is fine.

## What cannot be fixed after the fact

These are about the drawing itself, and no amount of code repairs them:

- **Style drift.** Line weight, the flatness of the shading, the exact red. The
  model swaps two drawings inside a single frame, so a visor rim that is a
  little thicker or a red that is a little warmer reads as a glitch at the
  precise moment somebody is looking at the head.
- **A different design.** A hood that is a slightly different shape, a visor
  with a different silhouette, extra detail that was not there before.
- **The wrong view.** A three-quarter view when what was needed was head-on —
  which is what four of the five files above turned out to be.

So: generate freely, upload whatever comes out, and expect an honest answer
about which of those three the result has landed in.

For reference, in the original the head occupies roughly x 329–562, y 196–440,
centred near (0.71, 0.50) of a 630 × 630 canvas.
