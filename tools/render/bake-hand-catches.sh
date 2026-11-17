#!/usr/bin/env bash
# Production bake: the human hand's target-space 3D contact catches.
#
#   bash tools/render/bake-hand-catches.sh
#
# Renders one catch per covered hand slot (12 target/caster pairs) with the
# target's published camera, combines the physical key shadow with the contact
# AO term, writes the committed textures + catches.json, and runs the
# dependency-free checker. This is the active hand contact-shadow path; the
# synthetic bands in overlays.json remain the fallback for other families.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
blender="${BLENDER:-$HOME/.local/opt/blender-4.5.9/blender}"

if [ ! -x "$blender" ]; then
  echo "bake-hand-catches.sh: Blender not found at $blender" >&2
  echo "Install Blender 4.5.9 LTS or set BLENDER=/path/to/blender." >&2
  exit 1
fi

"$blender" --background --python-exit-code 1 \
  --python "$here/bake_hand_catches.py" -- --out build/hand-catches

node "$here/scripts/commit-catches.mjs"
node "$here/scripts/check-overlays.mjs"
