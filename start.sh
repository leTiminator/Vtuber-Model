#!/usr/bin/env bash
# One-click launcher for macOS and Linux:  ./start.sh
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed."
  echo "  Get the LTS installer from https://nodejs.org, then run this again."
  echo
  exit 1
fi

if [ ! -d node_modules ]; then
  echo
  echo "  First run: installing. This downloads about 30 MB of tracking"
  echo "  model and takes a few minutes. It only happens once."
  echo
  npm install
fi

if [ ! -f public/models/face_landmarker.task ]; then
  echo "  Fetching the face tracking model..."
  npm run assets
fi

echo
echo "  Starting at http://127.0.0.1:5173"
echo "  Leave this window open while you stream."
echo
( sleep 2; (command -v open >/dev/null && open http://127.0.0.1:5173) \
  || (command -v xdg-open >/dev/null && xdg-open http://127.0.0.1:5173) || true ) &
npm run dev
