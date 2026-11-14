#!/usr/bin/env bash
# Entry point for the 2.5D shell baker.
#
#   bash tools/render/bake-shells.sh            # dry run: build the tile in Blender, print the plan
#   bash tools/render/bake-shells.sh --check    # integrity check; needs no Blender
#   bash tools/render/bake-shells.sh --audition # render the front/back wall fan calibration + sheets
#   bash tools/render/bake-shells.sh --check-audition  # validate the candidate matrix; needs no Blender
#   bash tools/render/bake-shells.sh --bake     # bake 1x + 2x, build review sheets, then check
#
# --bake renders the 77 shells (nine base + 68 front/back wall slots) with the
# pinned Blender at the current base scale, writes
# frontend/public/table/shells/ (+ 2x/) and shells.json, regenerates the
# throwaway review sheets under tools/render/build/review/, then runs the
# dependency-free integrity check.
#
# --audition is the front/back wall fan calibration path: it renders every candidate in
# shell-spec.json's `audition` block at the new base scale into
# build/review/candidates/ (+ the candidate manifest at
# build/review/shell-candidates.json), then validates those outputs and writes
# one labelled sheet per auditioned shell. It never writes the committed shells or
# shells.json. Add --verify-determinism to render every candidate twice.
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
    --check-audition)
      mode="check-audition"
      shift
      ;;
    --bake)
      mode="bake"
      shift
      ;;
    --audition)
      mode="audition"
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
      sed -n '2,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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

if [ "$mode" = "check-audition" ]; then
  # Dependency-free: validates the candidate manifest and every candidate PNG.
  exec node "$here/scripts/check-shells.mjs" --audition
fi

if [ ! -x "$blender" ]; then
  echo "bake-shells.sh: Blender not found at $blender" >&2
  echo "Install Blender 4.5.9 LTS or set BLENDER=/path/to/blender." >&2
  echo "The Blender-free check is: bash tools/render/bake-shells.sh --check" >&2
  exit 1
fi

echo "[shells] using $blender"
blender_args=(--background --python-exit-code 1 --python "$here/bake_shells.py" -- --spec "$spec")

case "$mode" in
  bake)
    blender_args+=(--bake "${verify[@]}")
    ;;
  audition)
    blender_args+=(--audition "${verify[@]}")
    ;;
  *)
    blender_args+=(--dry-run)
    ;;
esac

if [ "$mode" = "bake" ]; then
  "$blender" "${blender_args[@]}"
  echo "[shells] review sheets (gitignored, for the user's visual sign-off)"
  node "$here/scripts/review-shells.mjs"
  echo "[shells] validating the committed assets and the review sheets"
  node "$here/scripts/check-shells.mjs"
elif [ "$mode" = "audition" ]; then
  "$blender" "${blender_args[@]}"
  echo "[shells] candidate sheets (gitignored, for the user's pick)"
  node "$here/scripts/review-shells.mjs" --audition
  echo "[shells] validating the candidate matrix and its sheets (gitignored)"
  node "$here/scripts/check-shells.mjs" --audition
else
  exec "$blender" "${blender_args[@]}"
fi
