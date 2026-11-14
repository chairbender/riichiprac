# Vendored tile-symbol SVG source

`faces/` holds the **symbol-only** SVGs for the 38 face codes used by the 2.5D
rendered view. They carry no tile body: the alpha is the engraving paint and the
tile face is the baked shell's melamine material. All files are copied verbatim
from upstream; `Regular-Man1.svg` is the one Phase 0 already vendored.

| Field | Value |
| --- | --- |
| Upstream repo | https://github.com/SakaiTaka23/riichi-mahjong-tiles |
| Upstream path | `Regular/regular/` |
| Pinned commit | `f37d6cc2557498d23f13eb3e955e0e44e5c863ff` ("ignored svg to be published") |
| License | CC0 1.0 public domain (upstream README: "All assets are in the public domain") |
| Variant | `regular` = the symbol alone on transparent, 300 × 400 viewBox |
| Rasteriser | `@resvg/resvg-js` 2.6.2, `scripts/bake-faces.mjs`, 192 × 256 RGBA PNG |

The npm package `riichi-mahjong-tiles` (which the frontend uses for the stacked
and top-down views) only ships React components, not raw SVG files, so this
pipeline vendors the upstream SVGs and rasterises them offline. Do not hand-edit
these files or the generated PNGs: re-copy them from the pinned commit and
update this table if the pin moves.

## The 38 codes

| Face id | Upstream file | Face id | Upstream file |
| --- | --- | --- | --- |
| `1m`–`9m` | `Regular-Man1.svg` … `Regular-Man9.svg` | `1p`–`9p` | `Regular-Pin1.svg` … `Regular-Pin9.svg` |
| `1s`–`9s` | `Regular-Sou1.svg` … `Regular-Sou9.svg` | `5mr` | `Regular-Man5-Dora.svg` |
| `5pr` | `Regular-Pin5-Dora.svg` | `5sr` | `Regular-Sou5-Dora.svg` |
| `1z` | `Regular-Ton.svg` (east) | `2z` | `Regular-Nan.svg` (south) |
| `3z` | `Regular-Shaa.svg` (west) | `4z` | `Regular-Pei.svg` (north) |
| `5z` | `Regular-Haku.svg` (haku) | `6z` | `Regular-Hatsu.svg` (hatsu) |
| `7z` | `Regular-Chun.svg` (chun) | `blank` | — no asset (bare shell) |

`faces-spec.json` is the machine-readable form of this table and is the source
of truth for `scripts/bake-faces.mjs`.

## Two deliberate omissions

- **`Regular-Blank.svg` is not vendored.** In this upstream fork it is a red
  question mark, not an empty tile face. A blank tile is the bare ivory shell,
  so `blank` has `textureFile: null` and the atlas draws no glyph for it.
- **`Regular-Haku.svg` rasterises to zero ink.** Haku is the blank white dragon;
  the upstream symbol-only file has no visible marks. It is vendored and
  measured like every other face, but the atlas treats it the same as `blank`
  (one shared bare slot) instead of storing an identical transparent copy.

## Regenerating

```bash
cd tools/render
npm ci
node scripts/bake-faces.mjs --verify-determinism
node scripts/check-shells.mjs
```

`bake-faces.mjs` records each PNG's decoded-RGBA sha256, byte count and
measured ink statistics in `frontend/public/table/faces.json`.
