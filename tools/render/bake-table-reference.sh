#!/usr/bin/env bash
# Whole-table 3D calibration reference.
#
#   bash tools/render/bake-table-reference.sh                 # dry run: build the scene, print the camera metrics
#   bash tools/render/bake-table-reference.sh --bake          # render the @2x master, then publish the 1x board + 2x crops + manifest
#   bash tools/render/bake-table-reference.sh --audition      # render the ortho/weak/physical camera candidates at 1x
#   bash tools/render/bake-table-reference.sh --rig           # Task 2 rig: render the 16:9 1920x1080 RGBA reference, publish + check
#   bash tools/render/bake-table-reference.sh --check         # integrity + projection check; needs no Blender
#
# --bake renders only the transient @2x master under tools/render/build/reference/.
# scripts/table-reference.mjs derives the committed @1x full board, the @2x
# element-family crops and tools/render/reference/table-reference.json from it
# (decoded-RGBA hashes for every published render). --check re-verifies the spec,
# the manifest, every file/hash, the camera projection and the calibration
# thresholds without Blender.
#
# --rig builds the same scene with the Task 2 2.5D camera and light rig, hides the
# room floor, renders the 16:9 1920x1080 RGBA reference into
# tools/render/build/reference/rig/, then scripts/table-rig.mjs publishes
# tools/render/reference/rig-1x.png + rig.json and check-table-rig.mjs gates the
# acceptance numbers. Add --rig-width N (and --samples N) for a fast tuning render;
# a tuning render never publishes or checks.
#
# The reference is a calibration target only: it writes nothing under
# frontend/public and the runtime never reads it.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
blender="${BLENDER:-$HOME/.local/opt/blender-4.5.9/blender}"
mode="bake"
mode_set=0
dry_run=0
args=()

while [ $# -gt 0 ]; do
  case "$1" in
    --bake) mode_set=1; mode="bake"; shift ;;
    --audition) mode_set=1; mode="audition"; shift ;;
    --rig) mode_set=1; mode="rig"; shift ;;
    --check) mode_set=1; mode="check"; shift ;;
    --dry-run) dry_run=1; shift ;;
    --camera|--samples|--rig-width)
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

if [ "$mode_set" = "0" ] && [ "$dry_run" = "0" ]; then
  # The default run builds the scene and prints the plan; it never renders.
  dry_run=1
fi

if [ "$mode" = "check" ]; then
  node "$here/scripts/check-table-reference.mjs"
  node "$here/scripts/check-table-rig.mjs"
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
  audition) blender_args=(--audition) ;;
  rig) blender_args=(--rig) ;;
  bake) blender_args=(--bake) ;;
esac
if [ "$dry_run" = "1" ]; then
  blender_args+=(--dry-run)
fi

"$blender" --background --python "$here/bake_table_reference.py" -- \
  "${blender_args[@]}" "${args[@]}"

if [ "$mode" = "bake" ] && [ "$dry_run" = "0" ]; then
  node "$here/scripts/table-reference.mjs"
  node "$here/scripts/check-table-reference.mjs"
fi

if [ "$mode" = "rig" ] && [ "$dry_run" = "0" ] && [ ${#args[@]} -eq 0 ]; then
  node "$here/scripts/table-rig.mjs"
  node "$here/scripts/check-table-rig.mjs"
fi

if [ "$mode" = "audition" ]; then
  echo
  echo "camera auditions: $here/build/reference/audition/"
  echo "  ortho-1440.png / weak-1440.png / physical-1440.png, plus cameras.json"
  echo "  compare against the committed reference at $here/reference/full-board-1x.png"
  echo "  the committed camera is table-reference-spec.json camera.chosen"
fi
