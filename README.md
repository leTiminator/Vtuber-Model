# Recordings

Tracker recordings the app saved and pushed from a desk (Camera & tracking →
Record 60 seconds → Send to the developer). Numbers only: blendshape weights,
head angles, body landmarks, and the settings in force. No image data.

Nothing here is deployed or tested on its own. The developer copies the
recordings worth keeping into `test/fixtures/` on `main` with the change they
motivated, and `npm run test:replay` runs every recording it finds there.
