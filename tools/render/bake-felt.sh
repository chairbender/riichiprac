#!/usr/bin/env bash
# Regenerate the committed full-screen felt raster.
#
#   bash tools/render/bake-felt.sh
#
# Pure system Python: no Blender, no third-party packages. The felt and its
# baked vignette are deterministic from felt-spec.json. The Blender-free
# integrity check is `bash tools/render/bake-shells.sh --check`.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$here/bake_felt.py" --spec "$here/felt-spec.json" "$@"
