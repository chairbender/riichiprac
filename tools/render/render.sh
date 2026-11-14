#!/usr/bin/env bash
# Regenerate the rendered-table assets from scratch.
#
#   bash tools/render/render.sh            # ONE tile on the table (default, fast)
#   bash tools/render/render.sh --full     # the shipped batch: all ten hand layouts
#   bash tools/render/render.sh --spike    # the Task 1 review batch: one tile + face decal
#
# While the tile geometry and the table's light rig are still being reviewed the
# default batch is a **single tile**, so an iteration is a couple of minutes
# instead of half an hour. It writes to tools/render/build/single/ (gitignored):
# one body in both poses, the table background, a 1:1 device-pixel crop and a
# full-scene composite for each pose, and a manifest. Nothing there is shipped.
#
# `--full` is the shipped batch: it rebuilds the table background, one body per
# hand layout in both poses, the manifest, and validates the result into
# frontend/public/table/. Run it once the single-tile look is signed off.
#
# `--spike` is the Task 1/1.5 review artifact in tools/render/spike/ (never
# shipped): it additionally rasterises the vendored face SVG with resvg, bakes
# the carved face decal, and assembles the labelled contact sheet.
#
# Optional overrides:
#   BLENDER=/path/to/blender      use a different pinned build
#   bash render.sh <spec> <out> [full|single|spike]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mode="single"
args=()
for arg in "$@"; do
  case "$arg" in
    --full) mode="full" ;;
    --single) mode="single" ;;
    --spike) mode="spike" ;;
    *) args+=("$arg") ;;
  esac
done

spec="${args[0]:-$here/scene-spec.json}"
case "$mode" in
  full) out="${args[1]:-$here/../../frontend/public/table}" ;;
  spike) out="${args[1]:-$here/spike}" ;;
  *) out="${args[1]:-$here/build/single}" ;;
esac
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

# The integrity check is dependency-free, so it runs for every batch and in CI.
node "$here/scripts/check-assets.mjs" "$out"

echo "[render] done: $out"
