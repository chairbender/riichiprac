#!/usr/bin/env bash
# Regenerate the rendered-table spike assets from scratch.
#
# One command, no manual Blender interaction:
#   bash tools/render/render.sh
#
# Steps: rasterise the vendored face SVG (resvg) -> build and render the scene
# (headless Blender, pinned version) -> assemble the labelled contact sheet.
#
# Optional overrides:
#   BLENDER=/path/to/blender      use a different pinned build
#   bash render.sh <spec> <out>   use another spec / output directory
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
spec="${1:-$here/scene-spec.json}"
out="${2:-$here/spike}"
blender="${BLENDER:-/home/kylehipke/.local/opt/blender-4.5.9/blender}"

if [[ ! -x "$blender" ]]; then
  echo "[render] Blender not found at $blender" >&2
  echo "[render] Install the pinned Blender 4.5.9 LTS build or set BLENDER=..." >&2
  exit 1
fi

if [[ ! -d "$here/node_modules/@resvg/resvg-js" ]]; then
  echo "[render] installing offline Node dependencies (first run only)"
  (cd "$here" && npm ci --no-audit --no-fund)
fi

node "$here/scripts/rasterize-face.mjs" "$spec"
"$blender" --background --python-exit-code 1 --python "$here/build_and_render.py" -- "$spec" "$out"
node "$here/scripts/contact-sheet.mjs" "$spec" "$out"

echo "[render] done: $out"
