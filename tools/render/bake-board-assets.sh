#!/usr/bin/env bash
# Task 4 / Task 4A of the 2.5D implementation plan: bake the static board
# assets and the decoupled shadow assets from the Task 3 runtime layout.
#
#   bash tools/render/bake-board-assets.sh            # dry run: print the bucket/representative plan
#   bash tools/render/bake-board-assets.sh --bake     # render board_bg + 16 blanks + the shadow set,
#                                                     # bake the face atlas and run both gates
#   bash tools/render/bake-board-assets.sh --atlas    # re-rasterise only tile_faces.png/json (no Blender)
#   bash tools/render/bake-board-assets.sh --shadows  # Task 4A: mat shadows + wall stack (Blender),
#                                                     # seam masks (Node), both gates
#   bash tools/render/bake-board-assets.sh --seams    # re-author only the crevice masks (no Blender)
#   bash tools/render/bake-board-assets.sh --review   # compose the Task 4A contact sheet (no Blender)
#   bash tools/render/bake-board-assets.sh --check    # validate the committed assets; needs no Blender
#
# --bake writes:
#   frontend/public/table/board_bg.png                   empty table at 1920 x 1080
#   frontend/public/table/blanks/*.png                   one blank per bucket (16 files)
#   frontend/public/table/blanks.json                    pivots, crops, face quads, hashes
#   frontend/public/table/tile_faces.png                 37-face flat atlas (6 x 7 cells)
#   frontend/public/table/tile_faces.json                stable region map
#   frontend/public/table/shadows/shadow_mat_*.png       Task 4A: per-bucket cast mat shadows
#   frontend/public/table/shadows/shadow_wall_stack_*.png  Task 4A: wall-stack contact decals
#   frontend/public/table/shadows/ao_seam_*.png          Task 4A: crevice masks (normalized UV)
#   frontend/public/table/shadows.json                   Task 4A: shadow manifest
#   frontend/public/table/ao_seams.json                  Task 4A: crevice mask manifest
#
# The bake always uses the spec's default rig variant: table_layout.json is that
# variant's contract, so a blank or shadow posed elsewhere would not match the
# layout.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
blender="${BLENDER:-$HOME/.local/opt/blender-4.5.9/blender}"
mode="dry"
args=()

while [ $# -gt 0 ]; do
  case "$1" in
    --bake) mode="bake"; shift ;;
    --check) mode="check"; shift ;;
    --atlas) mode="atlas"; shift ;;
    --shadows) mode="shadows"; shift ;;
    --seams) mode="seams"; shift ;;
    --review) mode="review"; shift ;;
    --dry-run) mode="dry"; shift ;;
    --samples)
      [ $# -ge 2 ] || { echo "bake-board-assets: $1 needs a value" >&2; exit 2; }
      args+=("$1" "$2")
      shift 2
      ;;    *)
      echo "bake-board-assets: unknown option $1" >&2
      exit 2
      ;;
  esac
done

if [ "$mode" = "check" ]; then
  node "$here/scripts/check-board-assets.mjs"
  node "$here/scripts/check-shadow-assets.mjs"
  exit 0
fi

if [ "$mode" = "atlas" ]; then
  node "$here/scripts/bake-tile-faces-atlas.mjs"
  node "$here/scripts/check-board-assets.mjs"
  exit 0
fi

if [ "$mode" = "seams" ]; then
  node "$here/scripts/bake-shadow-seams.mjs"
  node "$here/scripts/check-shadow-assets.mjs"
  exit 0
fi

if [ "$mode" = "review" ]; then
  node "$here/scripts/review-shadow-assets.mjs"
  exit 0
fi

if [ ! -x "$blender" ]; then
  echo "bake-board-assets: Blender 4.5.9 not found at $blender" >&2
  echo "  install it with the command in tools/render/README.md (Toolchain)" >&2
  echo "  or point BLENDER at it; --check works without Blender" >&2
  exit 1
fi

if [ "$mode" = "shadows" ]; then
  "$blender" --background --python-exit-code 1 --python "$here/bake_shadow_assets.py" -- \
    --bake "${args[@]}"
  node "$here/scripts/bake-shadow-seams.mjs"
  node "$here/scripts/check-shadow-assets.mjs"
  exit 0
fi

declare -a blender_args=()
if [ "$mode" = "dry" ]; then
  blender_args+=(--dry-run)
else
  blender_args+=(--bake)
fi

"$blender" --background --python-exit-code 1 --python "$here/bake_board_assets.py" -- \
  "${blender_args[@]}" "${args[@]}"

if [ "$mode" = "bake" ]; then
  node "$here/scripts/bake-tile-faces-atlas.mjs"
  node "$here/scripts/check-board-assets.mjs"
  "$blender" --background --python-exit-code 1 --python "$here/bake_shadow_assets.py" -- \
    --bake "${args[@]}"
  node "$here/scripts/bake-shadow-seams.mjs"
  node "$here/scripts/check-shadow-assets.mjs"
fi
