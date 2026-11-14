# Offline 2.5D shell + felt pipeline

This directory is the **shell baker** for the opt-in rendered view. It is a
developer-only asset pipeline: nothing here is bundled, imported, or shipped by
the frontend. The runtime is 2D composition (images plus DOM), so every tile
shell, its shadow/AO margin, and the felt background are baked offline.

The active architecture is
[`2_5d_mahjong_tile_rendering_architecture.md`](../../2_5d_mahjong_tile_rendering_architecture.md),
including its **Project Addendum: Riichiprac Decisions**. Read it before
touching shells, layouts, faces, or the compositor.

## Phase 0 baseline

Phase 0 reset this directory from the retired full-scene pipeline to a clean
starting point for Phase 1, with **no table model**:

- The reusable tile mesh and materials are here: jansou proportions, the
  **0.055 / 6-segment bevel**, and the tile body as **one material** whose
  white/blue melamine split is gated on the object's local Z at
  `backEdgeFraction`. The split is ported from the unmerged 2.5 branch
  (commit `919e9fd`); it cuts through the bevel so the blue wraps the corners
  instead of stopping at a per-face boundary.
- The full-screen **felt raster** is baked and committed; it is the only
  background the rendered view has.
- The six canonical shells, their projections, and the `shells.json` contract
  are declared, but **Phase 1 owns the shell bake**. Phase 0 does not write a
  shell texture.
- The retired table model, fixed perspective camera, body sprites, baked face
  decals, 32 px shadow gutter, scene spec, batch budgets, contact sheet, tuner,
  and their shipped assets are gone. See [Legacy](#legacy) for the removed
  paths; their history remains in git.

## Commands

```bash
bash tools/render/bake-shells.sh --check   # integrity check; no Blender needed
bash tools/render/bake-shells.sh           # dry run: build the tile, print the shell plan
bash tools/render/bake-felt.sh             # regenerate frontend/public/table/felt.png
```

`--check` is the CI gate (`node tools/render/scripts/check-shells.mjs`). It
validates the specs, the felt PNG, and — once Phase 1 publishes it —
`shells.json` plus every shell texture. It never invokes Blender.

The default `bake-shells.sh` run is a **dry run**: it starts the pinned Blender,
builds the tile, material and lights, prints the six-shell plan, and exits
without writing an image. `--bake` is Phase 1 work and fails until
`bakeImplemented` is true in `shell-spec.json`.

The felt bake uses system `python3` only (stdlib; no NumPy, no Blender):

```bash
python3 tools/render/bake_felt.py --spec tools/render/felt-spec.json
```

Face glyphs are rasterised with the pinned resvg rasteriser:

```bash
node tools/render/scripts/rasterize-face.mjs \
  tools/render/faces/Regular-Man1-symbol.svg build/faces/1m.png --width 300
```

It needs `npm ci` in `tools/render` once (the directory is gitignored). The
2.5D runtime will composite these 2D glyphs into each shell's `faceQuad`; tile
art is never rasterised in the browser.

## Toolchain (pinned, outside the repo)

| Tool | Version | Location | Used for |
| --- | --- | --- | --- |
| Blender | **4.5.9 LTS** | `~/.local/opt/blender-4.5.9/blender` (or `BLENDER=...`) | tile mesh, lights, shell renders |
| Node | ≥ 18 | system `node` | the integrity check and resvg scripts |
| `@resvg/resvg-js` | **2.6.2** | `tools/render/node_modules` (installed, gitignored) | rasterising face SVGs |
| Python | 3.10+ | system `python3` | the procedural felt generator |

Blender is a portable Linux build installed outside every task worktree. The
pipeline ships no `.blend` file: `bake_shells.py` constructs the scene from
code on every run. Reinstall with the official portable archive:

```bash
curl -L -o /tmp/blender.tar.xz \
  https://download.blender.org/release/Blender4.5/blender-4.5.9-linux-x64.tar.xz
mkdir -p ~/.local/opt && tar -xf /tmp/blender.tar.xz -C ~/.local/opt
mv ~/.local/opt/blender-4.5.9-linux-x64 ~/.local/opt/blender-4.5.9
~/.local/opt/blender-4.5.9/blender --version   # must print "Blender 4.5.9 LTS"
```

`bake_shells.py` prints `bpy.app.version_string` and aborts on anything that is
not 4.5.9, so a stray Blender on `PATH` cannot silently produce assets. The
scene is pinned to **CPU Cycles** (`scene.device`): the determinism rule assumes
CPU sampling. A GPU device samples differently, so a GPU regeneration would be
its own regeneration, not mixed with CPU output.

## Directory layout

| Path | Committed | Purpose |
| --- | --- | --- |
| `shell-spec.json` | yes | the shell-baker source of truth: Blender pin, CPU-Cycles/AgX settings, jansou tile proportions, bevel `0.055 / 6`, the one-material white/blue split, top-left key + ambient fill, the six-shell catalogue, output paths, budgets |
| `bake_shells.py` | yes | Blender entry point: version check, tile mesh/material, lights, shell catalogue validation, dry-run plan, Phase 1 render loop |
| `bake-shells.sh` | yes | one command; resolves the pinned Blender, or runs `--check` with no Blender |
| `felt-spec.json` | yes | felt size/format, base colour, noise octaves, vignette curve, dither, runtime fit, byte budget |
| `bake_felt.py` | yes | deterministic stdlib PNG generator for the felt + vignette |
| `bake-felt.sh` | yes | one-command felt regeneration |
| `scripts/check-shells.mjs` | yes | dependency-free spec + PNG + `shells.json` integrity check (CI gate) |
| `scripts/rasterize-face.mjs` | yes | vendored face SVG → PNG glyph (resvg) |
| `faces/` | yes | vendored public-domain symbol-only SVG + provenance (`faces/SOURCE.md`) |
| `../../frontend/public/table/felt.png` | yes | the committed full-screen felt raster |
| `../../frontend/public/table/shells/` | Phase 1 | shell textures (`shell_*.png`) |
| `../../frontend/public/table/shells.json` | Phase 1 | the published shell contract |
| `node_modules/`, `build/` | no | installed dependencies and throwaway review output |

Generated assets are never hand-edited. A regeneration commits the spec/script
change together with the regenerated felt or shells.

## The felt raster

There is no table model. The rendered view's background is one full-screen felt
raster with a vignette baked into it: no felt plane in perspective, no table
edges, rails, hand aprons, wall-ring track, compass plate, or room floor.

| Property | Value |
| --- | --- |
| File | `frontend/public/table/felt.png` |
| Size | **2048 × 1280** (16:10 source) |
| Format | **8-bit RGB PNG, no alpha** (stretched by the runtime) |
| Committed bytes | **559,465 B** |
| Budget | 1,572,864 B |
| Bake time | ~30 s on this machine (pure Python) |
| Determinism | seed + octaves + vignette + dither are all in `felt-spec.json` |

PNG rather than WebP: the pipeline has no WebP encoder without adding another
dependency, and a lossless dark gradient avoids WebP chroma banding. 559 KB is
inside the felt budget and the browser decodes it natively. The runtime should
let the browser scale it; never draw the vignette with a CSS gradient or a
canvas at runtime.

### What is baked into it

- A low-contrast green cloth base (sRGB `#1a5038`) modulated by four octaves
  of bilinear value noise, cells 320/120/40/14 px. The noise is isotropic and
  intentionally subtle: standard deviation in the centre is ≈0.49 luma levels.
  It exists so semi-transparent tile shadows land on a surface with some
  structure instead of a flat sticker background.
- An elliptical vignette that darkens toward the screen edges. It is **not** a
  table border: there is no straight edge, rail, or ring in the raster.
  Measured by `check-shells.mjs` on the committed bake: centre luma **68.79**,
  corner mean **24.29**, centre/corner ratio **2.83**; left/right edge means
  **35.61 / 35.52** and top/bottom **41.66 / 40.44**. The vertical vignette is
  deliberately a little stronger than the horizontal one (`radiusY 0.86` vs
  `radiusX 0.94`), which suits a portrait phone.
- An 8×8 ordered dither so the long vignette gradient does not band at 8 bits.

### Viewport aspect

The runtime must draw the felt with `background-size: 100% 100%`, not `cover`.
`cover` scales by the long axis, so on a portrait phone it crops the left and
right vignette away and the screen edges stop being dark. Stretching keeps the
baked vignette on all four screen edges at every aspect ratio. The felt noise is
isotropic and low-frequency, so the non-uniform stretch does not read as a
stretched pattern. This decision is recorded in `felt-spec.json` under
`runtime`.

## Phase 1: the six shells

`shell-spec.json` catalogs the canonical shells and the output paths; it does
**not** contain baked textures yet. Phase 1 implements `build_shell_camera` and
`bake_shell` in `bake_shells.py` and flips `bakeImplemented`.

The six shells are:

| Id | Projection | Face rotation | Use |
| --- | --- | --- | --- |
| `shell_hand_standing` | front elevation + top bevel | 0° | bottom player's standing hand |
| `shell_flat_upright` | top-down + downward extrusion | 0° | face-up discards and unrotated melds |
| `shell_flat_sideways` | top-down | 90° | sideways riichi discards / called tiles |
| `shell_wall_horizontal` | top-down | 0° | face-down top/bottom wall and top hand |
| `shell_wall_side_left` | fixed oblique | 0° | face-down left side wall |
| `shell_wall_side_right` | fixed oblique | 0° | face-down right side wall |

### `shells.json` contract

Phase 1 writes `frontend/public/table/shells.json` next to the textures. One
record per shell id:

```json
{
  "version": 1,
  "generatedBy": "tools/render/bake_shells.py",
  "pixelRatio": 2,
  "shells": {
    "shell_flat_upright": {
      "textureFile": "shells/shell_flat_upright.png",
      "texWidth": 120,
      "texHeight": 138,
      "anchorX": 2,
      "anchorY": 2,
      "advanceWidth": 114,
      "advanceHeight": 132,
      "padding": { "top": 2, "right": 4, "bottom": 4, "left": 2 },
      "faceRotationDeg": 0,
      "faceQuad": [[6, 6], [110, 6], [110, 126], [6, 126]]
    }
  }
}
```

(The numbers above are illustrative shape only; Phase 1 measures the real ones
from the renders.) `anchorX/Y` is the top-left of the opaque body in the PNG,
`advanceWidth/Height` is the body size the layout engine steps by, and the
padding is the transparent shadow/AO margin. The check enforces:

- every path exists, is a PNG under `shells/`, and decodes as an 8-bit RGBA
  image;
- the PNG size equals `texWidth × texHeight`;
- the declared `faceRotationDeg` matches the shell catalogue (90 for
  `shell_flat_sideways`, 0 elsewhere);
- `anchorX === padding.left`, `anchorY === padding.top`,
  `anchorX + advanceWidth + padding.right === texWidth`, and the same for the
  vertical axis;
- every `faceQuad` corner lies inside the opaque body and the quad has non-zero
  area;
- per-shell and total byte budgets.

`shell_flat_sideways` carries `faceRotationDeg: 90`: only the **2D glyph**
rotates, never the pre-shaded shell sprite. See the architecture doc, §2.C.

## The Blender shell rules

The shell scene follows the architecture, not the retired pipeline:

- **Orthographic cameras only**, so parallel edges stay parallel. The side
  walls use a fixed oblique/cabinet angle.
- **One locked key at top-left-front plus a weak ambient fill.** The key is
  locked in *screen* space, so it is placed relative to each shell's camera
  basis: every projection gets highlights on its top/left edges and shadows on
  the bottom/right. The starting numbers are in `shell-spec.json`; they are a
  Phase 1 tuning starting point, not a verified bake.
- **Tight contact shadow/AO baked into the transparent margin**, roughly 3–4 px
  on the right/bottom and 1–2 px on the top/left. There is no 32 px gutter and
  no scene-wide shadow catcher.
- **Two-tone resin seam** visible along the top and side bevels: a white
  melamine face plate on a blue melamine backing, one material, split on local
  Z. This is what reads as a physical tile rather than a flat card.
- **Blank faces.** Shells carry no symbol. The runtime composites the 2D face
  glyph into `faceQuad`.

## What the check prints

`scripts/check-shells.mjs` is the scripted verification. It prints per-fact
`PASS`/`FAIL` lines and numeric `INFO` lines, for example:

```text
INFO felt luma centre 68.79, corners 24.29, ratio 2.831, stdDev 0.49
INFO felt edges L/R 35.61/35.52 T/B 41.66/40.44
PASS felt is 559465 B (budget 1572864 B)
PASS vignette centre/corner luma ratio is 2.831 (>= 1.5)
PASS left/right edge symmetry is 0.272% (<= 6%)
INFO shells.json not present yet; Phase 1 owns the six-shell bake
OK 31 checks passed
```

The symmetry tolerance is 6%, not 2%: the vignette is geometrically symmetric,
but the mottled noise is not mirrored. The check is for a broken or off-centre
vignette, not pixel equality. The felt's byte budget and decoded dimensions are
hard facts; whether the green, contrast, or mottling level is *right* is a
visual decision for the user (AGENTS.md §6).

## Visual review

Per AGENTS.md §6, do not sign off a render, shell, or felt from your own
inspection. To review the felt:

```bash
xdg-open frontend/public/table/felt.png
# or compare a fresh bake against the committed one:
bash tools/render/bake-felt.sh
git diff --stat -- frontend/public/table/felt.png
```

State the numbers the check already verified, then ask the user the question
only they can answer: is the green/contrast/weave right, and does the vignette
read as screen-edge darkening rather than a table border? Compare decoded
pixels, not PNG container bytes: zlib can change the container while the image
is identical.

Phase 1 artifacts will be the shell PNGs under
`frontend/public/table/shells/` and `shells.json`. Any review sheet or contact
image is a throwaway under the gitignored `build/`, not a committed asset.

## Legacy

The retired full-scene pipeline and its shipped assets were deleted in Phase 0.
Do **not** recreate or extend them; the history is in git and the design is
recorded as a retired document in `rendered-table-plan.md`.

Removed from this directory:

| Path | Was |
| --- | --- |
| `build_and_render.py` | the full-scene Blender scene builder and batch baker |
| `scene-spec.json` | table plan, fixed perspective camera, hand/body/decal batches, rigs, budgets |
| `render.sh` | the retired batch command |
| `tune.mjs`, `tune.html` | the carve/lighting parameter tuner |
| `scripts/check-assets.mjs` | the old manifest/body/decal validator |
| `scripts/contact-sheet.mjs` | the old review contact sheet |
| `spike/` | the Task 1/1.5/2 review renders |

Removed from the frontend's public assets:

| Path | Was |
| --- | --- |
| `frontend/public/table/background.webp` | the baked perspective table background |
| `frontend/public/table/manifest.json` | the v2 body/decal manifest |
| `frontend/public/table/bodies/` | 28 per-slot hand body sprites |

The reusable parts kept: the tile proportions/bevel, the one-material
white/blue melamine split, the pinned Blender/CPU-Cycles rules, the vendored
`faces/` SVGs and their provenance, and the resvg rasteriser.

`rendered-table-plan.md` and `rendered-table-strip-lights-plan.md` are
**retired design records** with banners. They are history, not instructions.
