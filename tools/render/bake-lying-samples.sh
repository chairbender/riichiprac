#!/usr/bin/env bash
# Build-only experiment: lying-family catch samples (bottom pond + front wall).
#
#   bash tools/render/bake-lying-samples.sh
#
# Exports the sample target/caster draw positions from the real layout, renders
# the target + adjacent casters with the target camera, aligns the hidden
# casters' contact edges, writes physical/AO/combined target-space overlays and
# a 3x review sheet. Nothing is committed to the table assets.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
blender="${BLENDER:-$HOME/.local/opt/blender-4.5.9/blender}"
if [ ! -x "$blender" ]; then
  echo "bake-lying-samples.sh: Blender not found at $blender" >&2
  exit 1
fi
(
  cd "$repo/frontend"
  npm run --silent lying:samples
)
"$blender" --background --python-exit-code 1 \
  --python "$here/contact_shadow_lying_samples.py"
(
  cd "$repo/frontend"
  npm run --silent lying:review
)
