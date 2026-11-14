#!/usr/bin/env bash
# Entry point for the 2.5D shell baker.
#
#   bash tools/render/bake-shells.sh            # dry run: build the tile in Blender, print the plan
#   bash tools/render/bake-shells.sh --check    # integrity check; needs no Blender
#   bash tools/render/bake-shells.sh --bake     # bake 1x + 2x, then check and build review sheets
#
# --bake renders the six shells with the pinned Blender, writes
# frontend/public/table/shells/ (+ 2x/) and shells.json, then runs the
# dependency-free integrity check and regenerates the throwaway review sheets
# under tools/render/build/review/. Add --verify-determinism to render every
# shell twice and compare decoded RGBA.
#
# The Blender build is pinned to 4.5.9 LTS. Put it at the default location or
# point BLENDER at it. The Python baker re-checks bpy.app.version_string, so a
# stray Blender on PATH cannot silently produce shells.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
blender="${BLENDER:-$HOME/.local/opt/blender-4.5.9/blender}"
spec="$here/shell-spec.json"
mode="dry-run"
verify=()

while [ $# -gt 0 ]; do
  case "$1" in
    --check)
      mode="check"
      shift
      ;;
    --bake)
      mode="bake"
      shift
      ;;
    --dry-run)
      mode="dry-run"
      shift
      ;;
    --verify-determinism)
      verify+=(--verify-determinism)
      shift
      ;;
    --spec)
      spec="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "bake-shells.sh: unknown argument $1" >&2
      exit 2
      ;;
  esac
done

if [ "$mode" = "check" ]; then
  # Dependency-free: validates the spec, the felt raster and shells.json plus
  # every shell PNG. CI runs this without Blender.
  exec node "$here/scripts/check-shells.mjs"
fi

if [ ! -x "$blender" ]; then
  echo "bake-shells.sh: Blender not found at $blender" >&2
  echo "Install Blender 4.5.9 LTS or set BLENDER=/path/to/blender." >&2
  echo "The Blender-free check is: bash tools/render/bake-shells.sh --check" >&2
  exit 1
fi

echo "[shells] using $blender"
blender_args=(--background --python-exit-code 1 --python "$here/bake_shells.py" -- --spec "$spec")
if [ "$mode" = "bake" ]; then
  blender_args+=(--bake "${verify[@]}")
else
  blender_args+=(--dry-run)
fi

if [ "$mode" = "bake" ]; then
  "$blender" "${blender_args[@]}"
  echo "[shells] validating the committed assets"
  node "$here/scripts/check-shells.mjs"
  echo "[shells] review sheets (gitignored, for the user's visual sign-off)"
  node "$here/scripts/review-shells.mjs"
else
  exec "$blender" "${blender_args[@]}"
fi
