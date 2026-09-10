#!/bin/bash
# Everything a fresh cloud session needs before it can run the suites or open
# Blender. The container is snapshotted once this finishes, so the downloads
# here are paid on a cold start and not on every session.
set -euo pipefail

# Local checkouts set their own machines up; this is only for the web.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# The app's dependencies, plus the ~31 MB of MediaPipe wasm and model weights
# that postinstall fetches. `install` rather than `ci` so a warm cache counts.
npm install

# Blender as a Python module: headless, no viewport, for the 3D side of the
# project. Nothing the browser app ships imports it. Delete this line to drop
# it. pip is idempotent, so a warm container skips straight past it.
pip3 install --no-cache-dir --quiet 'bpy==5.0.1'
