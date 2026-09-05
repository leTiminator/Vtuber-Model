# Working rules for this repository

This file is for whoever works on the code next, human or AI session. The
project is five days old and has already been rebuilt three times; these rules
exist so that improvements stop undoing each other.

## What the product is

The bundled ninja character (`public/art/BA_Ninja_TPBG.png` plus the head-on
view in `public/art/views/`), tracked by MediaPipe in a desktop browser tab
(`index.html`), rendered as a parts puppet in WebGL2 (`src/avatars/parts`),
and shown in OBS through a second camera-free page (`output.html`) fed over the
dev server's WebSocket relay (`scripts/rig-relay.mjs`). Nothing else is in
scope unless the owner says so.

## The guard is goldens plus invariants

- `npm run test:golden` renders the poses in `test/harness.mjs` `POSES` and
  compares them with `test/golden/*.png`. One tolerance for every pose, never
  tuned per pose. A failing golden means the look changed: either it was a
  mistake, or it was on purpose. On purpose means one commit that runs
  `npm run test:golden -- --update`, names the pose, says why, and attaches the
  diff sheet from `test/out/golden/`. Never in the same commit as a Playwright
  or Chromium bump.
- Invariants are properties any correct implementation has: the parts
  reassemble to the drawing, the character is one connected piece, cel art has
  no translucent pixels, a nod moves the head in the direction the owner
  confirmed, turning on the glow changes pixels. Differentials (on versus off)
  beat absolute pixel counts. If a check needs a number tuned to the current
  renderer, it is a golden, not a check.
- A complaint becomes a pose in `POSES` or a fixture in `test/fixtures/` before
  it becomes a change. Quote the `D` readout in every bug report; the build
  stamp on the stage says which commit is running.

## Delete, do not demote

- No "kept for comparison" flags. No settings that exist so a test can turn
  something off. Off means the code is gone; git history keeps it.
- Every store key has a control or a reader. When a key goes, grep
  `src test scripts` for it in the same commit: `store.set` throws on unknown
  keys and the panel skips them, so a stale reference is a red run.

## Tests

- Every check block starts from `__t.resetStore()` (defaults plus the markers
  the app detected at boot) and, for renders, a fresh `__t.makeAvatar()` or
  `avatar.reset()`. Never rely on state a previous block left behind.
- Render checks use their own `Parts2D` from `__t.makeAvatar()`, never the
  app's, whose animation loop advances between `page.evaluate` calls.
- `npm test` runs every suite and reports all of them. It must be green
  locally and every CI job green before a push. CI wall clock stays under five
  minutes per job. Never push red.
- One harness: `test/harness.mjs`. A new suite imports `boot()` and
  `makeCheck()`; it does not start its own server or browser.

## Comments

- Say what the code does now, in the present tense. History, measurements and
  what was tried belong in commit messages and `docs/DECISIONS.md`.
- No file over 25% comment lines (`npm run lint:comments`).

## The model

- `npm run bake` regenerates `public/model/ninja/` whenever the artwork or the
  cut changes; `npm run bake:check` must pass. The runtime never cuts.
