# Recorded tracker sessions

Drop a `tracker-session.json` here and `npm run test:replay` will drive the rig
and the renderer with it instead of a synthetic sweep.

Record one from the app: **☰ → Camera & tracking → Record 60 seconds**, with the
camera running. It saves a file to your downloads.

## What is in the file

Numbers only — the same values the rig already works from:

- blendshape weights (how open the jaw is, how closed each eye is, …)
- head yaw, pitch, roll and position
- body landmark coordinates, if arm tracking was on

**No image data.** No video is captured, no frames are stored, and nothing is
written out beyond those numbers. The file is plain JSON; open it and read it.

## Why it is worth having

Every other motion check in this suite is a sweep somebody wrote by hand, which
means it reflects an assumption about what a camera produces: smooth curves,
one axis at a time, tidy extremes. Real tracking jitters, drops out, holds
still in ways that expose drift, and reaches combinations no sweep tries. Most
of the faults in this project lived in exactly that gap.
