#!/usr/bin/env bash
# Build-only experiment: catch an adjacent hand tile's shadow on a target tile.
#
#   bash tools/render/bake-contact-shadow-experiment.sh
#
# Renders the right pair (slot 11 from slot 10) and the left pair (slot 2 from
# slot 3) with the target's published shell camera, then writes the review sheet
# via `npm run experiment:review`. It never touches the committed shells, decals
# or manifest; everything lands under tools/render/build/contact-shadow-experiment/.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
blender="${BLENDER:-$HOME/.local/opt/blender-4.5.9/blender}"

if [ ! -x "$blender" ]; then
  echo "bake-contact-shadow-experiment.sh: Blender not found at $blender" >&2
  echo "Install Blender 4.5.9 LTS or set BLENDER=/path/to/blender." >&2
  exit 1
fi

run_pair() {
  local target="$1"
  local caster="$2"
  echo "[contact-shadow] $target <- $caster"
  "$blender" --background --python-exit-code 1 \
    --python "$here/contact_shadow_experiment.py" -- \
    --target "$target" --caster "$caster" \
    --out "build/contact-shadow-experiment"
}

run_pair shell_hand_slot_11 shell_hand_slot_10
run_pair shell_hand_slot_02 shell_hand_slot_03

echo "[contact-shadow] review sheet"
(
  cd "$repo/frontend"
  npm run --silent experiment:review
)
