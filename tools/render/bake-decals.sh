#!/usr/bin/env bash
# Entry point for the carved face decal baker.
#
#   bash tools/render/bake-decals.sh --dry-run   # print the plan, no render
#   bash tools/render/bake-decals.sh --spike     # 4 faces x 4 light rotations into build/decals
#   bash tools/render/bake-decals.sh --build     # all inked faces x 4 rotations into build/decals
#   bash tools/render/bake-decals.sh --bake      # PNG bake, encode AVIF, commit decals.json, check
#   bash tools/render/bake-decals.sh --check     # validate build/decals.json (no Blender)
#   bash tools/render/bake-decals.sh --check-committed  # validate frontend/public/table/decals.json
#
# The decals are the transparent carve/paint overlays that get pasted into the
# current shells' faceQuad. The symbol stays upright in face-local space; the
# four images per face are four baked light rotations, chosen so the light lands
# top-left on screen after the shell's quad rotation.
#
# --spike and --build never touch the committed assets. --bake writes the PNG
# bake to build/decals, encodes it to frontend/public/table/decals/ (AVIF by
# default, DECAL_FORMAT/DECAL_QUALITY to override), writes decals.json and runs
# check-decals.mjs --committed. The Blender build is pinned to 4.5.9 LTS; set
# BLENDER to override the path.
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
    --only | --rotations | --surface)
      args+=("$1" "$2")
      shift 2
      ;;
    --verify-determinism)
      args+=("$1")
      shift
      ;;
    *)
      echo "usage: $0 [--dry-run|--spike|--build|--bake|--check|--check-committed] [--only FACE] [--rotations N,N] [--surface upright|lying] [--verify-determinism]" >&2
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

# --bake is the only mode that writes the committed assets. The baker's
# --build flag writes the PNG bake into build/decals; the encoder then reads
# build/decals.json and writes the committed AVIF set + manifest. Baking
# straight into the committed folder would leave the encoder reading a stale
# preview manifest, so --bake always uses --build first.
if [ "$mode" = "bake" ]; then
  bake_args=(--build)
fi

"$blender" --background --python "$here/bake_decals.py" -- "${bake_args[@]}" "${args[@]}"

if [ "$mode" = "bake" ]; then
  node "$here/scripts/encode-decals.mjs" \
    --format "${DECAL_FORMAT:-avif}" \
    --quality "${DECAL_QUALITY:-60}"
  node "$here/scripts/check-decals.mjs" --committed
fi
