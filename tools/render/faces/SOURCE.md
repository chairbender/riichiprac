# Vendored tile-symbol SVG source

The 37 `Regular-*.svg` files are the public-domain **symbol-only** SVGs for the
34 standard tile faces plus the three red fives (akadora), copied verbatim from
upstream. `scripts/bake-faces.mjs` rasterises them into the committed 300 × 400
masters under `frontend/public/table/faces/`, whose alpha is the ink coverage and
whose colour is the flat face paint. The **3D** carve bake
(`frontend/tools/relief3d/bake-relief3d.mjs`) samples those masters for its
albedo, normal/height and AO/roughness atlases and does the carving itself, so
this source stays flat. The 300 × 400 canvas aligns pixel-for-pixel with the
upstream full-face (`-m`) variant.

The upstream `Regular-Blank.svg` is **not** vendored: it draws a red question
mark, not an empty tile face. An empty face is the bare ivory tile surface, so no
glyph is drawn for it. Haku (`5z`) is a real face but its symbol-only SVG
rasterises to zero ink; it is kept because the game needs the face id.

| Field | Value |
| --- | --- |
| Upstream repo | https://github.com/SakaiTaka23/riichi-mahjong-tiles |
| Upstream path | `Regular/regular/Regular-<name>.svg` |
| Pinned commit | `f37d6cc2557498d23f13eb3e955e0e44e5c863ff` ("ignored svg to be published") |
| License | Public domain (CC0 1.0), per the upstream README |
| Variant | `regular` = the symbol alone on transparent, 300 × 400 viewBox |
| Faces | Man 1–9, Pin 1–9, Sou 1–9, Man/Pin/Sou 5 Dora, Ton, Nan, Shaa, Pei, Haku, Hatsu, Chun |

The npm package `riichi-mahjong-tiles` (which the frontend uses for the stacked
and top-down views) only ships React components, not raw SVG files, so this
directory vendors the upstream SVGs and rasterises them with
`@resvg/resvg-js`.

Do not hand-edit these files: re-copy them from the pinned commit and update
this table if the pin moves. `tools/render/faces-spec.json` is the bake's source
of truth and `tools/render/scripts/bake-faces.mjs` writes
`frontend/public/table/faces/*.png` plus `faces.json`.
