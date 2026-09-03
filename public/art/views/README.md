# Alternate views

Drop new drawings of the character here. Nothing reads this folder
automatically; each view gets wired into the rig deliberately, because each one
changes what the model can do.

**Filenames do not matter.** Upload whatever they are called; they get
identified and renamed on arrival.

## What is worth drawing, most valuable first

| Ends up as | What it is | Why it matters |
| --- | --- | --- |
| `head-front.png` | The head looking straight at the camera | The biggest gap. The rig has one three-quarter view, and mirroring it gives the opposite three-quarter for free — so the pose it cannot show is the one in between, which is the one you sit in most of the time. |
| `eyes-closed.png` | The eye shard closed | Blinks happen every few seconds and are currently faked by erasing the eye layer. Most quality per drawing. |
| `eyes-half.png` | Half closed | Makes a blink a movement rather than a switch. |
| `head-up.png` | Looking up about 25° | A nod is currently a rigid rotation of the cutout, which is a cheat: a real one shows more jaw. |
| `head-down.png` | Looking down about 25° | The same, showing more crown. |
| `eyes-narrow.png` `eyes-wide.png` `eyes-happy.png` | Expressions | This design is masked, so the eyes are the entire face. |
| `eyes-left.png` `eyes-right.png` | Gaze | Only worth it after the above. |
| `head-profile.png` | About 70° | For turning fully away. Lowest priority. |

## Do not fight the file format

Upload what comes out. The mechanical problems are cheap to fix in code and
get fixed on arrival rather than sent back:

- **Wrong canvas size, or the character sitting in the wrong place.** Padded,
  cropped and aligned against the original by its own silhouette.
- **A background instead of transparency.** Keyed out, if it is a flat one.
- **Stray specks and detached fragments.** Dropped — the original is a single
  connected shape and the model's checks assume that.
- **Eyes not on their own layer.** The cut already finds the eye shards by
  brightness and lifts them onto their own layer at load time, so a head with
  its eyes attached is fine.

## What cannot be fixed after the fact

These are about the drawing itself, and no amount of code repairs them:

- **Style drift.** Line weight, the flatness of the shading, the exact red. The
  flip swaps two drawings inside a single frame, so a visor rim that is a
  little thicker or a red that is a little warmer reads as a glitch at the
  precise moment somebody is looking at the head.
- **A different design.** A hood that is a slightly different shape, a visor
  with a different silhouette, extra detail that was not there before.
- **The wrong view.** A three-quarter view when what was needed was head-on.

So: generate freely, upload whatever comes out, and expect an honest answer
about which of those three the result has landed in.

For reference, in the original the head occupies roughly x 329–562, y 196–440,
centred near (0.71, 0.50) of a 630 × 630 canvas.
