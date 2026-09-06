# Recorded tracker sessions

`tracker-session.json` (2026-09-03) and `tracker-session-2026-09-06.json`
(turns, and deliberate tilts held for seconds) are recordings of the owner at
their desk. `npm run test:replay` drives the rig with every
`tracker-session*.json` here, and with every recording in `sessions/`, instead
of a synthetic sweep.

## Recording one

**☰ → Camera & tracking → Record 60 seconds**, with the camera running.

- Running locally (`start.sh`, `start.bat`, `npm run dev`) the recording is
  saved into `test/fixtures/sessions/` and the panel offers **Send to the
  developer**, which pushes it to the `recordings` branch on GitHub without
  touching your checkout. **Open GitHub upload page** does the same by hand
  from any machine.
- On the published site it downloads as `tracker-session.json`; the upload
  page takes it from there.

**Calibrate from this recording** sets your neutral pose, the blink threshold
and the gaze discount from the recording itself, and says what it cannot fix
from software: a jaw the camera never saw, elbows below the frame.

## What is in the file

Numbers only, the same values the rig works from: blendshape weights, head
yaw, pitch, roll and position, body landmark coordinates when arm tracking was
on, and the settings in force. No video, no frames, no image data. Plain JSON;
open it and read it.

## Why it is worth having

A sweep somebody wrote by hand encodes an assumption about what a camera
produces: smooth curves, one axis at a time, tidy extremes. Real tracking
jitters, drops out, holds still in ways that expose drift, and reaches
combinations no sweep tries. Most of the faults in this project lived in that
gap, and the fixes for blinks and the neutral pose were measured on this file.
