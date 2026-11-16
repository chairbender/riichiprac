#!/usr/bin/env bash
# Phase 3.5 contact-shadow decals (tile-to-tile overlay shadows).
#
#   bash tools/render/bake-overlays.sh            # bake, regenerate the fixture, check
#   bash tools/render/bake-overlays.sh --bake     # same
#   bash tools/render/bake-overlays.sh --check    # dependency-free asset + pixel checks
#   bash tools/render/bake-overlays.sh --dry-run  # print the plan, write nothing
#
# No Blender, no canvas: the decals are baked from the committed shell PNG
# alpha with tools/render/scripts/bake_overlays.mjs (node + png.mjs only). The
# `(shell, side)` set comes from the real layout over every supported
# composition (`frontend/scripts/export-overlays.ts --sides`), so the assets
# cannot drift from zoneLayout.ts. The representative fixture
# (`tools/render/overlay-zones.json`) is regenerated after the bake and checked
# by the vitest parity test and by check-overlays.mjs.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
mode="bake"

while [ $# -gt 0 ]; do
  case "$1" in
    --bake)
      mode="bake"
      shift
      ;;
    --check)
      mode="check"
      shift
      ;;
    --dry-run)
      mode="dry-run"
      shift
      ;;
    -h|--help)
      sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "bake-overlays.sh: unknown argument $1" >&2
      exit 2
      ;;
  esac
done

if [ "$mode" = "check" ]; then
  exec node "$here/scripts/check-overlays.mjs"
fi

if [ "$mode" = "dry-run" ]; then
  node "$here/scripts/bake_overlays.mjs" --dry-run
  exit 0
fi

echo "[overlays] laying out every supported composition for the decal set"
(
  cd "$repo/frontend"
  npm run --silent overlays:export -- --sides
)

echo "[overlays] baking the contact decals from the committed shell alpha"
node "$here/scripts/bake_overlays.mjs"

echo "[overlays] resolving the representative fixture from the baked manifest"
(
  cd "$repo/frontend"
  npm run --silent overlays:export -- --fixture
)

echo "[overlays] validating the assets, the clips and the composed pixels"
node "$here/scripts/check-overlays.mjs"
