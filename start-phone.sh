#!/usr/bin/env bash
# Test on your phone:  ./start-phone.sh    Leave it running.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed."
  echo "  Get the LTS installer from https://nodejs.org, then run this again."
  echo
  exit 1
fi

[ -d node_modules ] || npm install
[ -f public/models/face_landmarker.task ] || npm run assets

npm run phone
