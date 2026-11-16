#!/usr/bin/env bash
# Entry point for the carved face decal baker.
#
#   bash tools/render/bake-decals.sh --dry-run   # print the plan, no render
#   bash tools/render/bake-decals.sh --spike     # 4 faces x 4 light rotations into build/decals
#   bash tools/render/bake-decals.sh --build     # all inked faces x 4 rotations into build/decals
#   bash tools/render/bake-decals.sh --bake      # commit the full set + decals.json, then check
#   bash tools/render/bake-decals.sh --check     # validate build/decals.json (no Blender)
#   bash tools/render/bake-decals.sh --check-committed  # validate frontend/public/table/decals.json
#
# The decals are the transparent carve/paint overlays that get pasted into the
# current shells' faceQuad. The symbol stays upright in face-local space; the
# four images per face are four baked light rotations, chosen so the light lands
# top-left on screen after the shell's quad rotation.
#
# --spike and --build never touch the committed assets. --bake writes
# frontend/public/table/decals/ (+ decals.json) and then runs check-decals.mjs.
# The Blender build is pinned to 4.5.9 LTS; set BLENDER to override the path.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
blender="${BLENDER:-$HOME/.local/opt/blender-4.5.9/blender}"
mode="build"
args=()

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run | --spike | --build | --bake | --check | --check-committed)
      mode="${1#--}"
      shift
      ;;
    --only | --rotations)
      args+=("$1" "$2")
      shift 2
      ;;
    --verify-determinism)
      args+=("$1")
      shift
      ;;
    *)
      echo "usage: $0 [--dry-run|--spike|--build|--bake|--check|--check-committed] [--only FACE] [--rotations N,N] [--verify-determinism]" >&2
      exit 2
      ;;
  esac
done

if [ "$mode" = "check" ]; then
  node "$here/scripts/check-decals.mjs"
  exit $?
fi
if [ "$mode" = "check-committed" ]; then
  node "$here/scripts/check-decals.mjs" --committed
  exit $?
fi

if [ ! -x "$blender" ]; then
  echo "Blender 4.5.9 not found at $blender; set BLENDER" >&2
  exit 1
fi

bake_args=()
case "$mode" in
  dry-run) bake_args+=(--dry-run) ;;
  spike) bake_args+=(--spike) ;;
  build) bake_args+=(--build) ;;
  bake) bake_args+=(--build) ;;
  *)
    echo "unknown mode $mode" >&2
    exit 2
    ;;
esac

# --bake is the only mode that writes the committed assets; every other mode
# uses build/decals. The baker's --build flag writes build/decals, so --bake
# invokes it without --build.
if [ "$mode" = "bake" ]; then
  bake_args=()
fi

"$blender" --background --python "$here/bake_decals.py" -- "${bake_args[@]}" "${args[@]}"

if [ "$mode" = "bake" ]; then
  node "$here/scripts/check-decals.mjs" --committed
fi
