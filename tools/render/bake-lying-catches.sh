#!/usr/bin/env bash
# Production bake: lying-family (pond/meld) 3D target-space catches.
#
#   bash tools/render/bake-lying-catches.sh
#
# Exports the distinct pond/meld signatures from the full stress matrix, bakes
# one combined physical+AO catch per signature with the target camera and
# aligned casters, publishes lying-catches.json, runs the checker and refreshes
# the review sheets. Walls are not part of this bake yet.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
blender="${BLENDER:-$HOME/.local/opt/blender-4.5.9/blender}"
if [ ! -x "$blender" ]; then
  echo "bake-lying-catches.sh: Blender not found at $blender" >&2
  exit 1
fi
(
  cd "$repo/frontend"
  npm run --silent lying:export
)
"$blender" --background --python-exit-code 1 \
  --python "$here/bake_lying_catches.py"
node "$here/scripts/commit-lying-catches.mjs"
node "$here/scripts/check-overlays.mjs"
(
  cd "$repo/frontend"
  npm run --silent overlays:review
)
