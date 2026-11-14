#!/usr/bin/env bash
# Regenerate the rendered-table assets from scratch.
#
#   bash tools/render/render.sh            # the shipped batch (default)
#   bash tools/render/render.sh --spike    # the Task 1 review batch
#
# Shipped batch: one command rebuilds the table background, every hand-slot
# body sprite (face-up and concealed), the manifest, and validates the result.
#   1. build the scene and render with headless Blender (pinned version)
#   2. verify the manifest, sprite sizes, slot/quad bounds, and the budget
#
# Spike batch (tools/render/spike/, a review artifact, never shipped): also
# rasterises the vendored face SVG with resvg, bakes the carved face decal and
# the homography composite, and assembles the labelled contact sheet.
#
# Optional overrides:
#   BLENDER=/path/to/blender      use a different pinned build
#   bash render.sh <spec> <out> [table|spike]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mode="table"
args=()
for arg in "$@"; do
  case "$arg" in
    --spike) mode="spike" ;;
    *) args+=("$arg") ;;
  esac
done

spec="${args[0]:-$here/scene-spec.json}"
if [[ "$mode" == "spike" ]]; then
  out="${args[1]:-$here/spike}"
else
  out="${args[1]:-$here/../../frontend/public/table}"
fi
blender="${BLENDER:-/home/kylehipke/.local/opt/blender-4.5.9/blender}"

if [[ ! -x "$blender" ]]; then
  echo "[render] Blender not found at $blender" >&2
  echo "[render] Install the pinned Blender 4.5.9 LTS build or set BLENDER=..." >&2
  exit 1
fi

if [[ "$mode" == "spike" ]]; then
  if [[ ! -d "$here/node_modules/@resvg/resvg-js" ]]; then
    echo "[render] installing offline Node dependencies (first run only)"
    (cd "$here" && npm ci --no-audit --no-fund)
  fi
  node "$here/scripts/rasterize-face.mjs" "$spec"
fi

"$blender" --background --python-exit-code 1 --python "$here/build_and_render.py" -- "$spec" "$out" "$mode"

if [[ "$mode" == "spike" ]]; then
  node "$here/scripts/contact-sheet.mjs" "$spec" "$out"
fi

# The integrity check is dependency-free, so it runs for both batches and in CI.
node "$here/scripts/check-assets.mjs" "$out"

echo "[render] done: $out"
