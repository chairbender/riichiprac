#!/usr/bin/env bash
# Task 3 of the 2.5D implementation plan: project the SlotAnchors collection
# through the rig camera into the runtime table layout.
#
#   bash tools/render/bake-table-layout.sh            # dry run: build the scene, print the bucket plan
#   bash tools/render/bake-table-layout.sh --bake     # export the layout + probe render, then measure and check
#   bash tools/render/bake-table-layout.sh --bake --variant v2-compact  # export an A/B variant (never publishes)
#   bash tools/render/bake-table-layout.sh --check    # layout + probe + overlay gate; needs no Blender
#
# --bake writes frontend/public/table/table_layout.json (the runtime contract),
# reference/layout/probes-1x.png (one emissive marker per anchor, rendered
# alone), then scripts/table-layout-proof.mjs measures every marker centroid
# against the export (the 1 px acceptance), writes
# reference/layout/layout-proof.json, reference/layout/overlay-1x.png and
# reference/layout/overlay-zoom-4x.png, and finally runs
# scripts/check-table-layout.mjs.
#
# A non-default --variant is calibration only: its layout is written to
# build/layout/<variant>/ instead of frontend/public, so the committed runtime
# contract always belongs to spec.rig.defaultVariant.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
blender="${BLENDER:-$HOME/.local/opt/blender-4.5.9/blender}"
mode="dry"
variant=""
args=()

while [ $# -gt 0 ]; do
  case "$1" in
    --bake) mode="bake"; shift ;;
    --check) mode="check"; shift ;;
    --dry-run) mode="dry"; shift ;;
    --no-probe) args+=("--no-probe"); shift ;;
    --variant|--samples)
      [ $# -ge 2 ] || { echo "bake-table-layout: $1 needs a value" >&2; exit 2; }
      args+=("$1" "$2")
      if [ "$1" = "--variant" ]; then variant="$2"; fi
      shift 2
      ;;
    *)
      echo "bake-table-layout: unknown option $1" >&2
      exit 2
      ;;
  esac
done

if [ "$mode" = "check" ]; then
  node "$here/scripts/check-table-layout.mjs"
  exit 0
fi

if [ ! -x "$blender" ]; then
  echo "bake-table-layout: Blender 4.5.9 not found at $blender" >&2
  echo "  install it with the command in tools/render/README.md (Toolchain)" >&2
  echo "  or point BLENDER at it; --check works without Blender" >&2
  exit 1
fi

declare -a blender_args=(--rig)
if [ "$mode" = "dry" ]; then
  blender_args+=(--dry-run)
fi

"$blender" --background --python-exit-code 1 --python "$here/bake_table_layout.py" -- \
  "${blender_args[@]}" "${args[@]}"

if [ "$mode" = "bake" ]; then
  if [ -n "$variant" ]; then
    echo "bake-table-layout: $variant layout written under tools/render/build/layout/$variant/"
    echo "  (A/B output only; the committed contract and its proof are the default variant's)"
  else
    node "$here/scripts/table-layout-proof.mjs"
    node "$here/scripts/check-table-layout.mjs"
  fi
fi
