# Vendored tile-face SVG source

`Regular-Man1-m.svg` is the public-domain full-face SVG for the 1-man tile, copied
verbatim from upstream. Task 1 vendors this single face to prove the
rasterise → texture → lit-decal path; the full 38-code set is vendored by Task 3.

| Field | Value |
| --- | --- |
| Upstream repo | https://github.com/SakaiTaka23/riichi-mahjong-tiles |
| Upstream path (face) | `Regular/regular-merged/Regular-Man1-m.svg` |
| Upstream path (symbol) | `Regular/regular/Regular-Man1.svg` |
| Pinned commit | `f37d6cc2557498d23f13eb3e955e0e44e5c863ff` ("ignored svg to be published") |
| License | Public domain (CC0 1.0), per the upstream README |
| Variants | `regular-merged` = white tile face plus symbol, 300 × 400 viewBox; `regular` = the symbol alone on transparent, same viewBox and alignment |

`Regular-Man1-m.svg` is the face texture (white plate + symbol). `Regular-Man1-symbol.svg`
is the same symbol with no plate, used as the **carve mask**: its alpha is the
engraved area, so the painted shape and the recess line up exactly (verified: the
red and black pixel bounds match the merged raster pixel-for-pixel within 1 px).

The npm package `riichi-mahjong-tiles` (which the frontend uses) only ships React
components, not raw SVG files, so the pipeline vendors the upstream SVG and
rasterises it with `@resvg/resvg-js`. Do not hand-edit these files: re-copy them
from the pinned commit and update this table if the pin moves.
