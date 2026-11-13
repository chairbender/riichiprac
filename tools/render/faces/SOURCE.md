# Vendored tile-face SVG source

`Regular-Man1-m.svg` is the public-domain full-face SVG for the 1-man tile, copied
verbatim from upstream. Task 1 vendors this single face to prove the
rasterise → texture → lit-decal path; the full 38-code set is vendored by Task 3.

| Field | Value |
| --- | --- |
| Upstream repo | https://github.com/SakaiTaka23/riichi-mahjong-tiles |
| Upstream path | `Regular/regular-merged/Regular-Man1-m.svg` |
| Pinned commit | `f37d6cc2557498d23f13eb3e955e0e44e5c863ff` ("ignored svg to be published") |
| License | Public domain (CC0 1.0), per the upstream README |
| Variant | `regular-merged` = ivory tile face plus symbol, 300 × 400 viewBox |

The npm package `riichi-mahjong-tiles` (which the frontend uses) only ships React
components, not raw SVG files, so the pipeline vendors the upstream SVG and
rasterises it with `@resvg/resvg-js`. Do not hand-edit these files: re-copy them
from the pinned commit and update this table if the pin moves.
