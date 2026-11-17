#!/usr/bin/env bash
# Whole-table 3D calibration reference.
#
#   bash tools/render/bake-table-reference.sh                 # dry run: build the scene, print the camera metrics
#   bash tools/render/bake-table-reference.sh --bake          # render the @2x master, then publish the 1x board + 2x crops + manifest
#   bash tools/render/bake-table-reference.sh --audition      # render the ortho/weak/physical camera candidates at 1x
#   bash tools/render/bake-table-reference.sh --check         # integrity + projection check; needs no Blender
#
# --bake renders only the transient @2x master under tools/render/build/reference/.
# scripts/table-reference.mjs derives the committed @1x full board, the @2x
# element-family crops and tools/render/reference/table-reference.json from it
# (decoded-RGBA hashes for every published render). --check re-verifies the spec,
# the manifest, every file/hash, the camera projection and the calibration
# thresholds without Blender.
#
# The reference is a calibration target only: it writes nothing under
# frontend/public and the runtime never reads it.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
blender="${BLENDER:-$HOME/.local/opt/blender-4.5.9/blender}"
mode="dry-run"
args=()

while [ $# -gt 0 ]; do
  case "$1" in
    --bake) mode="bake"; shift ;;
    --audition) mode="audition"; shift ;;
    --check) mode="check"; shift ;;
    --dry-run) mode="dry-run"; shift ;;
    --camera|--samples)
      [ $# -ge 2 ] || { echo "bake-table-reference: $1 needs a value" >&2; exit 2; }
      args+=("$1" "$2")
      shift 2
      ;;
    *)
      echo "bake-table-reference: unknown option $1" >&2
      exit 2
      ;;
  esac
done

if [ "$mode" = "check" ]; then
  node "$here/scripts/check-table-reference.mjs"
  exit 0
fi

if [ ! -x "$blender" ]; then
  echo "bake-table-reference: Blender 4.5.9 not found at $blender" >&2
  echo "  install it with the command in tools/render/README.md (Toolchain)" >&2
  echo "  or point BLENDER at it; --check works without Blender" >&2
  exit 1
fi

declare -a blender_args
case "$mode" in
  dry-run) blender_args=(--dry-run) ;;
  audition) blender_args=(--audition) ;;
  bake) blender_args=(--bake) ;;
esac

"$blender" --background --python "$here/bake_table_reference.py" -- \
  "${blender_args[@]}" "${args[@]}"

if [ "$mode" = "bake" ]; then
  node "$here/scripts/table-reference.mjs"
  node "$here/scripts/check-table-reference.mjs"
fi

if [ "$mode" = "audition" ]; then
  echo
  echo "camera auditions: $here/build/reference/audition/"
  echo "  ortho-1440.png / weak-1440.png / physical-1440.png, plus cameras.json"
  echo "  compare against the committed reference at $here/reference/full-board-1x.png"
  echo "  the committed camera is table-reference-spec.json camera.chosen"
fi
