#!/usr/bin/env bash
# Entry point for the 2.5D shell baker.
#
#   bash tools/render/bake-shells.sh            # dry run: build the tile in Blender, print the plan
#   bash tools/render/bake-shells.sh --check    # integrity check; needs no Blender
#   bash tools/render/bake-shells.sh --bake     # Phase 1 only; fails until implemented
#
# The Blender build is pinned to 4.5.9 LTS. Put it at the default location or
# point BLENDER at it. The Python baker re-checks bpy.app.version_string, so a
# stray Blender on PATH cannot silently produce shells.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
blender="${BLENDER:-$HOME/.local/opt/blender-4.5.9/blender}"
spec="$here/shell-spec.json"
mode="dry-run"

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
    --spec)
      spec="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "bake-shells.sh: unknown argument $1" >&2
      exit 2
      ;;
  esac
done

if [ "$mode" = "check" ]; then
  # Dependency-free: validates the spec, the felt raster and (when present)
  # shells.json and every shell PNG. CI runs this without Blender.
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
  blender_args+=(--bake)
else
  blender_args+=(--dry-run)
fi
exec "$blender" "${blender_args[@]}"
