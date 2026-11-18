#!/usr/bin/env bash
# Entry point for the Task 4B orthographic carved-relief map bake.
#
#   bash tools/render/bake-relief.sh                  # dry run: build the plate, print the plan
#   bash tools/render/bake-relief.sh --masks          # re-rasterise the high-res carve artwork only
#   bash tools/render/bake-relief.sh --preview --only 8s [--only ...]   # fast partial bake into build/
#   bash tools/render/bake-relief.sh --bake           # bake all 37 faces, write the committed atlases
#   bash tools/render/bake-relief.sh --check          # validate the committed atlases; needs no Blender
#
# --bake is the only mode that writes frontend/public/table/relief/ and
# frontend/public/table/relief.json. It first re-runs the Node artwork pass
# (scripts/bake-relief-masks.mjs) so the high-res masks and signed-distance
# fields match the current SVGs, then renders the four Cycles passes per face in
# the pinned Blender (4.5.9 LTS), packs the three 1536 x 2380 atlases and runs
# the dependency-free integrity check.
#
# --preview renders only the requested --only faces into build/relief/preview/
# and never touches the committed assets. --masks only re-runs the Node pass.
# --check runs scripts/check-relief.mjs and needs neither Blender nor resvg.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
blender="${BLENDER:-$HOME/.local/opt/blender-4.5.9/blender}"
mode="dry-run"
only=()
verify=()

while [ $# -gt 0 ]; do
  case "$1" in
    --bake)
      mode="bake"
      shift
      ;;
    --preview)
      mode="preview"
      shift
      ;;
    --masks)
      mode="masks"
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
    --only)
      only+=("$2")
      shift 2
      ;;
    --verify-determinism)
      verify+=(--verify-determinism)
      shift
      ;;
    -h | --help)
      sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "bake-relief.sh: unknown argument $1" >&2
      exit 2
      ;;
  esac
done

if [ "$mode" = "check" ]; then
  exec node "$here/scripts/check-relief.mjs"
fi

node "$here/scripts/bake-relief-masks.mjs"

if [ "$mode" = "masks" ]; then
  exit 0
fi

if [ ! -x "$blender" ]; then
  echo "bake-relief.sh: Blender not found at $blender" >&2
  echo "Install Blender 4.5.9 LTS or set BLENDER=/path/to/blender." >&2
  echo "The Blender-free check is: bash tools/render/bake-relief.sh --check" >&2
  exit 1
fi

echo "[relief] using $blender"
blender_args=(--background --python-exit-code 1 --python "$here/bake_relief.py" --)

case "$mode" in
  bake)
    blender_args+=(--bake "${verify[@]}")
    ;;
  preview)
    if [ "${#only[@]}" -eq 0 ]; then
      echo "bake-relief.sh: --preview needs at least one --only FACE" >&2
      exit 2
    fi
    blender_args+=(--preview --only "$(IFS=,; echo "${only[*]}")" "${verify[@]}")
    ;;
  *)
    blender_args+=(--dry-run)
    ;;
esac

if [ "$mode" = "bake" ]; then
  "$blender" "${blender_args[@]}"
  echo "[relief] contact sheet (gitignored, for the user's visual sign-off)"
  node "$here/scripts/review-relief.mjs"
  echo "[relief] validating the committed atlases"
  node "$here/scripts/check-relief.mjs"
elif [ "$mode" = "preview" ]; then
  "$blender" "${blender_args[@]}"
  node "$here/scripts/review-relief.mjs" --preview
else
  exec "$blender" "${blender_args[@]}"
fi
