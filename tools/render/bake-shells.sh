#!/usr/bin/env bash
# Entry point for the 2.5D shell baker.
#
#   bash tools/render/bake-shells.sh            # dry run: build the tile in Blender, print the plan
#   bash tools/render/bake-shells.sh --check    # integrity check; needs no Blender
#   bash tools/render/bake-shells.sh --preview --only <id> [--only <id>...]  # fast partial bake
#   bash tools/render/bake-shells.sh --audition # render the standing-hand fan calibration + sheets
#   bash tools/render/bake-shells.sh --shadow-audition  # shadow strength/shape/falloff sheet
#   bash tools/render/bake-shells.sh --check-audition  # validate the candidate matrix; needs no Blender
#   bash tools/render/bake-shells.sh --bake     # bake 1x + 2x, build review sheets, then check
#
# --bake renders the 103 shells (eight base + 14 human-hand slots + 13 top-hand
# slots + 68 wall slots) as body + shadow sprites with the pinned Blender at the
# current base scale,
# writes frontend/public/table/shells/ (+ 2x/) and shells.json, regenerates the
# throwaway review sheets under tools/render/build/review/, then runs the
# dependency-free integrity check.
#
# --preview is the fast loop: --preview --only <id> [--only <id>...] renders just
# those shells under tools/render/build/preview/ (never the committed assets),
# writes a preview manifest and a preview sheet, and skips the full 103-shell
# check. Use it while tuning one shell; do a full --bake when the set is right.
#
# --shadow-audition renders the blob sigma/core-alpha/offset candidates on the flat,
# wall and hand shells under build/review/shadows/, then draws a labelled comparison
# sheet (each row unions its shadows before the bodies). It never touches the
# committed shells.
#
# --audition is the standing-hand fan calibration path: it renders every candidate in
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
only=()

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
    --shadow-audition)
      mode="shadow-audition"
      shift
      ;;
    --dry-run)
      mode="dry-run"
      shift
      ;;
    --preview)
      mode="preview"
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
  preview)
    if [ "${#only[@]}" -eq 0 ]; then
      echo "bake-shells.sh: --preview needs at least one --only SHELL_ID" >&2
      exit 2
    fi
    blender_args+=(--bake --preview "${verify[@]}")
    for id in "${only[@]}"; do
      blender_args+=(--only "$id")
    done
    ;;
  audition)
    blender_args+=(--audition "${verify[@]}")
    ;;
  shadow-audition)
    blender_args+=(--shadow-audition)
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
elif [ "$mode" = "preview" ]; then
  "$blender" "${blender_args[@]}"
  echo "[shells] preview sheet (gitignored, build/preview/preview-1x.png)"
  node "$here/scripts/review-shells.mjs" --preview --out "$here/build/preview"
elif [ "$mode" = "shadow-audition" ]; then
  "$blender" "${blender_args[@]}"
  echo "[shells] shadow comparison sheet (gitignored, build/review/shadow-candidates.png)"
  node "$here/scripts/review-shells.mjs" --shadow-audition
  echo "[shells] validating the shadow audition"
  node "$here/scripts/check-shells.mjs" --shadow-audition
elif [ "$mode" = "audition" ]; then
  "$blender" "${blender_args[@]}"
  echo "[shells] candidate sheets (gitignored, for the user's pick)"
  node "$here/scripts/review-shells.mjs" --audition
  echo "[shells] validating the candidate matrix and its sheets (gitignored)"
  node "$here/scripts/check-shells.mjs" --audition
else
  exec "$blender" "${blender_args[@]}"
fi
