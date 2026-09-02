# Alternate views

Drop new drawings of the character here. Anything in this folder is source
art — nothing reads it automatically yet; each view gets wired into the rig
deliberately, because each one changes what the model can do.

## What to draw, most valuable first

| File | What it is | Why it matters |
| --- | --- | --- |
| `head-front.png` | The head looking straight at the camera | The biggest gap. The rig has one three-quarter view, and mirroring it gives the opposite three-quarter for free — so the pose it cannot show is the one in between, which is the one you sit in most of the time. |
| `eyes-closed.png` | The eye shard closed | Blinks happen every few seconds and are currently faked by erasing the eye layer. Highest quality per hour of drawing. |
| `eyes-half.png` | Half closed | Makes a blink a movement rather than a switch. |
| `head-up.png` | Looking up about 25° | A nod is currently a rigid rotation of the cutout, which is a cheat: a real one shows more jaw. |
| `head-down.png` | Looking down about 25° | The same, showing more crown. |
| `eyes-narrow.png` `eyes-wide.png` `eyes-happy.png` | Expressions | This design is masked, so the eyes are the entire face. |
| `eyes-left.png` `eyes-right.png` | Gaze | Only worth it after the above. |
| `head-profile.png` | About 70° | For turning fully away. Lowest priority. |

## Requirements

These are not style preferences. A drawing can be beautiful and still be
unusable if it misses them.

- **630 × 630 canvas**, matching `../BA_Ninja_TPBG.png`, with the character in
  the same place. Do not crop, re-centre or resize — the rig aligns views by
  the canvas, so a re-centred drawing lands in the wrong place.
- **Transparent background**, PNG with a real alpha channel.
- **One connected shape.** The original is a single blob of 151,305 opaque
  pixels; several of the model's checks assume that, and a detached piece
  renders as debris floating beside the character.
- **The same neck and shoulder position** in every head view, so views can be
  swapped without re-registering them.
- **Eyes on their own layer**, exported as a separate file aligned to the head
  view it belongs to — the lid needs to erase the eye without touching the
  visor behind it.
- Match the original's line weight, flat cel shading and palette. The flip
  swaps two drawings within a single frame, so any drift in line weight, visor
  shape or the red reads as a glitch exactly when someone is looking at it.

For reference, in the original the head occupies roughly x 329–562, y 196–440,
centred near (0.71, 0.50) of the canvas.
