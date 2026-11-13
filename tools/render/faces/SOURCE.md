# Vendored tile-symbol SVG source

`Regular-Man1-symbol.svg` is the public-domain **symbol-only** SVG for the 1-man
tile, copied verbatim from upstream. Its alpha is the carve mask and its colour
is the engraving paint; the tile face itself is the melamine material colour.
The same canvas aligns pixel-for-pixel with the upstream full-face (`-m`) variant,
which the spike no longer needs. Task 1 vendors this single symbol to prove the
rasterise → carve → paint → lit-decal path; the full 38-code set is vendored by
Task 3.

| Field | Value |
| --- | --- |
| Upstream repo | https://github.com/SakaiTaka23/riichi-mahjong-tiles |
| Upstream path | `Regular/regular/Regular-Man1.svg` |
| Pinned commit | `f37d6cc2557498d23f13eb3e955e0e44e5c863ff` ("ignored svg to be published") |
| License | Public domain (CC0 1.0), per the upstream README |
| Variant | `regular` = the symbol alone on transparent, 300 × 400 viewBox |

The npm package `riichi-mahjong-tiles` (which the frontend uses) only ships React
components, not raw SVG files, so the pipeline vendors the upstream SVG and
rasterises it with `@resvg/resvg-js`. Do not hand-edit these files: re-copy them
from the pinned commit and update this table if the pin moves.
