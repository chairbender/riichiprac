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
  were declared in Phase 0; **Phase 1 (below) bakes them**. This section records
  the starting point, not the current state.
- The retired table model, fixed perspective camera, body sprites, baked face
  decals, 32 px shadow gutter, scene spec, batch budgets, contact sheet, tuner,
  and their shipped assets are gone. See [Legacy](#legacy) for the removed
  paths; their history remains in git.

## Commands

```bash
bash tools/render/bake-shells.sh --bake    # bake 1x + 2x, validate, build review sheets
bash tools/render/bake-shells.sh --check   # integrity check; no Blender needed
bash tools/render/bake-shells.sh           # dry run: build the tile, print the shell plan
bash tools/render/bake-felt.sh             # regenerate frontend/public/table/felt.png
```

`--bake` is the one command that regenerates everything: it renders the six
shells at @1x and @2x with the pinned Blender, measures each render, writes
`frontend/public/table/shells/*.png`, `shells/2x/*.png` and
`frontend/public/table/shells.json`, then runs the dependency-free integrity
check and regenerates the review sheets under `tools/render/build/review/`.
`--bake --verify-determinism` additionally renders every shell a second time and
compares the decoded RGBA.

`--check` is the CI gate (`node tools/render/scripts/check-shells.mjs`). It
validates the specs, the felt PNG, `shells.json` and both texture scales. It
never invokes Blender.

The default `bake-shells.sh` run is a **dry run**: it starts the pinned Blender,
builds the tile, material and lights, prints the six-shell plan, and exits
without writing an image.

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
| `scripts/png.mjs` | yes | dependency-free PNG decode/encode + sprite compositor shared by the checker and the review sheets |
| `scripts/review-shells.mjs` | yes | lays the baked shells out with the manifest's own steps into review sheets |
| `scripts/rasterize-face.mjs` | yes | vendored face SVG → PNG glyph (resvg) |
| `faces/` | yes | vendored public-domain symbol-only SVG + provenance (`faces/SOURCE.md`) |
| `../../frontend/public/table/felt.png` | yes | the committed full-screen felt raster |
| `../../frontend/public/table/shells/` | yes | shell textures at @1x (`shell_*.png`) |
| `../../frontend/public/table/shells/2x/` | yes | the same six shells at @2x |
| `../../frontend/public/table/shells.json` | yes | the published shell contract |
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

All six shells are baked, measured and committed. `shell-spec.json` carries each
shell's pose (Euler degrees), camera (azimuth/elevation + which local face is
visible) and expected aspect; `bake_shells.py` renders it, measures the alpha
silhouette, projects the `faceQuad`, and writes both texture scales.

| Id | Projection | Pose | Camera | Advance (@1x) | Texture @1x / @2x | gridStepPx.x / .y |
| --- | --- | --- | --- | --- | --- | --- |
| `shell_hand_standing` | front elevation | rotX +90° | az 0° / el 12° | 38 × 54 | 44 × 60 / 88 × 120 | (35.44, 0) / (0, 46.21) |
| `shell_flat_upright` | near-top-down | — | az 0° / el 80° | 38 × 53 | 44 × 59 / 88 × 118 | (35.88, 0) / (0, 47.10) |
| `shell_flat_sideways` | near-top-down | rotZ 90° | az 0° / el 80° | 54 × 44 | 60 × 50 / 120 × 100 | (0, 38.41) / (52, 0) |
| `shell_wall_horizontal` | near-top-down | rotX 180° | az 0° / el 80° | 38 × 54 | 44 × 60 / 88 × 120 | (35.88, 0) / (0, 47.10) |
| `shell_wall_side_left` | fixed oblique | rotX 180°, rotY −35° | az 0° / el 75° | 42 × 52 | 48 × 58 / 96 × 116 | (26.58, −4.80) / (0, 41.78) |
| `shell_wall_side_right` | fixed oblique | rotX 180°, rotY +35° | az 0° / el 75° | 42 × 52 | 48 × 58 / 96 × 116 | (26.58, 4.80) / (0, 41.79) |

All six PNGs together are **76,360 B** (budget 2,097,152 B); the largest single
shell is 10,147 B (ceiling 262,144 B). `shells.json` is ~18 KB
(budget 65,536 B).

**Why the projections are what they are.**

- The ponds and hands are *axis-aligned rectangles*: azimuth 0, elevation 80°.
  A yaw of even 6° made the tile a parallelogram whose bounding box left felt
  gaps between neighbours, so the "slightly right" extrusion is carried by the
  baked shadow and AO margin instead of a sheared silhouette. The face is a
  rectangle and adjacent tiles abut exactly.
- The side walls are the only oblique shells. They keep their long axis
  **vertical on screen** (so a wall column steps straight down) and get their
  cabinet lean by rolling the tile about its own long axis (rotY ∓35°), not by
  yawing the camera; yawing would rotate the tile diagonally and no longer read
  as a wall. The lean shows up as the small horizontal component of
  `gridStepPx.x`.
- `shell_wall_side_right` is the mirror of the left: same pose mirrored, same
  camera basis, so the screen-space key still lands top-left on both.

### `shells.json` contract

`frontend/public/table/shells.json` holds one record per shell id. This is a
real record (values from the committed bake):

```json
{
  "version": 1,
  "generatedBy": "tools/render/bake_shells.py",
  "pixelRatio": 2,
  "coordinateSpace": "anchorX/anchorY, advanceWidth/advanceHeight, padding and faceQuad are CSS px of the @1x texture, with a top-left origin. textureFile2x is the same shell at pixelRatio times the resolution; divide its pixels by pixelRatio to get the same coordinates.",
  "rig": { "blender": "4.5.9 LTS", "engine": "CYCLES", "device": "CPU", "samples": 256, "seed": 0, "...": "..." },
  "shells": {
    "shell_flat_upright": {
      "textureFile": "shells/shell_flat_upright.png",
      "textureFile2x": "shells/2x/shell_flat_upright.png",
      "texWidth": 44,
      "texHeight": 59,
      "anchorX": 2,
      "anchorY": 2,
      "advanceWidth": 38,
      "advanceHeight": 53,
      "padding": { "top": 2, "right": 4, "bottom": 4, "left": 2 },
      "faceRotationDeg": 0,
      "faceQuad": [[5.69, 5.09], [36.31, 5.09], [36.31, 47.01], [5.69, 47.01]],
      "faceQuadOrder": "face-local [top-left, top-right, bottom-right, bottom-left]",
      "gridStepPx": { "x": [35.88, 0], "y": [0, 47.1] },
      "projection": "top-down",
      "pose": { "rotateXDeg": 0, "rotateYDeg": 0, "rotateZDeg": 0 },
      "camera": { "azimuthDeg": 0, "elevationDeg": 80, "orthoScale": 1.609798, "pixelsPerUnit2x": 95.664201, "resolution1x": [60, 77], "resolution2x": [120, 154] },
      "measured": {
        "alphaExtent1x": { "left": 1, "top": 1, "right": 3, "bottom": 3 },
        "alphaPeak1x": { "left": 0.2784, "top": 0.2784, "right": 0.3216, "bottom": 0.3216 },
        "alphaMass1x": { "left": 14.757, "top": 10.58, "right": 22.329, "bottom": 17.216 },
        "shadowCatcherPeak": 0.4403,
        "solidInset1x": [1, 1, 1, 1],
        "faceSampleRgb": [207, 204, 200],
        "edgeSamplesRgb": { "top": [220, 217, 213], "bottom": [24, 40, 59] },
        "bytes1x": 2966,
        "bytes2x": 8543
      },
      "sha256": { "decodedRgba1x": "…", "decodedRgba2x": "…" }
    }
  }
}
```

Fields the runtime and the checker rely on:

- `textureFile` / `textureFile2x` — the @1x and @2x PNGs, both under `shells/`.
- `texWidth`/`texHeight` — the @1x PNG size. The @2x PNG is exactly twice that.
- `anchorX`/`anchorY` — the top-left of the opaque body box in @1x px. They are
  equal to `padding.left`/`padding.top`, and `anchor + advance + padding` equals
  the texture size on both axes.
- `advanceWidth`/`advanceHeight` — the opaque body box used for spacing and
  hit-testing. It *includes a one-pixel anti-aliased edge ledge* on each side;
  `measured.solidInset1x` is `[1,1,1,1]`, i.e. the alpha ≥ 0.5 silhouette is
  exactly 1 px inside the declared box. Without that ledge a 0.4-alpha
  silhouette pixel would be indistinguishable from a 0.33-alpha shadow pixel and
  the shadow/AO contract could not be measured from the exported PNG.
- `gridStepPx.x` / `gridStepPx.y` — **use these for a tight grid**, not the
  advance box. They are the projected tile width/height axes in @1x px, oriented
  so a vector points right (horizontal axes) or down (vertical axes). A pond row
  steps by `gridStepPx.x`; a pond row of rows, a hand, or a wall run of the
  *same* shell steps by `gridStepPx.y`. The two differ because the sprite box
  also contains the AA ledge and the baked thickness extrusion. A sideways tile
  advances *horizontally* by its `gridStepPx.y` (its long axis is horizontal).
- `faceQuad` — the visible face plate inset by `faceInset`, four corners in
  `faceQuadOrder` (the tile face's own top-left, top-right, bottom-right,
  bottom-left). The runtime rotates the glyph by `faceRotationDeg` (90 for
  `shell_flat_sideways`, 0 elsewhere) and maps the glyph's corners onto these.
  The quad is a projected rectangle, so the compositor can treat it as a
  parallelogram.
- `measured` — the numbers the checker re-derives from the committed PNG:
  nonzero-alpha extent/peak/mass per padded side, the three structural colour
  samples, the body inset, and the byte counts.
- `sha256.decodedRgba1x/2x` — the sha256 of the *decoded* RGBA buffer, not the
  PNG container bytes. Re-baking the same spec must reproduce them; a
  hand-edited PNG fails the check.
- `rig` — Blender version, engine/device/samples/seed, colour management, the
  key's screen-space direction, the shadow/AO contract, the target long-axis
  size, and each shell's framing. It is the audit trail for a bake.

The check enforces: every path exists and decodes as 8-bit RGBA; the PNG sizes
match (with the @2x exactly twice the @1x); the declared padding matches the
spec and the anchor; the opaque body is inset exactly 1 px; the faceQuad is a
convex projected rectangle inside the body with a plausible aspect;
`gridStepPx` follows from the faceQuad; the shadow/AO extents and peaks stay in
the 3-4 px / 1-2 px contract; the shadow points down-right; the outer texture
ring is transparent; the light reads top-left (top edge brighter and bottom
thickness cool/dark); face-up shells are ivory and face-down shells are blue; the
@1x and @2x agree within a mean channel delta of 8; the decoded-RGBA hashes and
byte counts match the manifest; and the per-shell/total byte budgets hold.

### The two-tone resin seam and the light

The tile body is one material whose white/blue split is gated on local Z at
`backEdgeFraction` (0.3 of the thickness), so the seam wraps the bevel instead
of stopping at a face boundary. What that produces per shell:

- standing hand: white face plate, white top bevel, a **blue resin sliver at the
  very top** (`edgeSamplesRgb.top` = `[13, 65, 138]`);
- face-up flat: white plate, white top bevel `[220, 217, 213]`, the unlit cool
  thickness strip at the bottom `[24, 40, 59]`;
- face-down wall: **blue plate** (`faceSampleRgb` `[0, 50, 130]`) with the cool
  band below it.

The measured face samples are ivory (`207, 204, 200`) on the flat shells and
`169, 166, 163` on the standing hand. The two side walls differ in brightness
because one leans toward the key and the other away from it (`[1, 60, 152]` vs
`[0, 31, 87]`), which is what a single top-left key does to mirrored geometry. The standing face is dimmer because the
screen-locked key is more grazing on a vertical face — that is what one light
locked in screen space means. If the user wants the hand as bright as the pond,
the lever is `lighting.key` (or two lighting variants), not a per-shell hack.

## The Blender shell rules

The shell scene follows the architecture, not the retired pipeline:

- **Orthographic cameras only**, so parallel edges stay parallel. The side walls
  use a fixed cabinet lean (tile rolled ±35° about its own long axis).
- **One locked key at top-left-front plus a weak ambient fill.** The key's
  authored azimuth/elevation (315° / 55°) is decomposed once in a
  front-elevation camera's basis; every shell then re-expresses the same
  `(−0.406, +0.819, +0.406)` screen-space direction in its own camera basis. That
  is why a top-down shell and a front-elevation shell both get their highlights
  top-left and their shadow bottom-right. The tuned values are 3200 W for the
  key and a `#3b4a5c` world at strength 1.0 (the Phase 0 numbers were a starting
  point that produced a near-black shadow side).
- **Tight contact shadow/AO baked into the transparent margin**: two renders per
  shell per scale — the tile on transparent film, and a Cycles **shadow-catcher**
  plane under it. The catcher alpha is blurred, clamped to the declared padding
  (3–4 px right/bottom), divided by its own peak and pinned to
  `shadow.peakAlpha` 0.33 per side. The top/left ambient-occlusion fringe
  (1–2 px, peak 0.28) is analytic and bounded by `padding.top/left`. A 1 px
  frame ramp guarantees nothing clips at the texture border.
- **Two-tone resin seam** visible along the top and side bevels: a white
  melamine face plate on a blue melamine backing, one material, split on local
  Z. This is what reads as a physical tile rather than a flat card.
- **Blank faces.** Shells carry no symbol. The runtime composites the 2D face
  glyph into `faceQuad`.
- **Determinism**: CPU Cycles, fixed seed 0, fixed adaptive threshold, OIDN.
  `--bake --verify-determinism` renders each shell twice and compares the
  decoded RGBA; the committed manifest records the sha256 of each texture's
  decoded RGBA.

## What the check prints

`scripts/check-shells.mjs` is the scripted verification. It prints per-fact
`PASS`/`FAIL` lines and numeric `INFO` lines. On the committed bake:

```text
INFO felt luma centre 68.79, corners 24.29, ratio 2.831, stdDev 0.49
INFO felt edges L/R 35.61/35.52 T/B 41.66/40.44
PASS felt is 559465 B (budget 1572864 B)
PASS vignette centre/corner luma ratio is 2.831 (>= 1.5)
PASS left/right edge symmetry is 0.272% (<= 6%)
PASS shell_flat_upright shadow reaches 3 px right (contract 3-4)
PASS shell_flat_upright AO reaches 1 px left (contract 1-2)
PASS shell_flat_upright right shadow peaks at alpha 0.322 (0.24-0.36)
PASS shell_flat_upright bottom thickness strip is cool and dark (24,40,59, luma 38.2)
PASS shell_flat_upright face is ivory (luma 203.6 >= 150)
PASS shell_wall_horizontal face is blue resin (0,50,130)
INFO shell_flat_upright margin mass L14.76 T10.58 R22.33 B17.22
PASS shell_flat_upright decoded-RGBA sha256 matches the committed PNGs
INFO shell textures total 76360 B across 6 shells and 2 scales
OK 323 checks passed
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

To review the shells, bake (or just regenerate the sheets) and open them:

```bash
node tools/render/scripts/review-shells.mjs
xdg-open tools/render/build/review/shells-row-1x.png      # all six, catalogue order
xdg-open tools/render/build/review/discard-row-1x.png     # 6-tile row + isolated + riichi
xdg-open tools/render/build/review/discard-row-zoom4x.png # nearest 4x of the seams
xdg-open tools/render/build/review/wall-stack-1x.png      # two-tier stack + side walls
xdg-open tools/render/build/review/each-4x-shell_flat_upright.png
```

The review sheets are throwaway: `build/` is gitignored. They are drawn on the
felt's base colour (`#1a5038`) so shadow contrast is easy to see, with the
manifest's own `gridStepPx` and draw order (rows right-to-left, wall bottom tier
before the top tier). The script prints the seam numbers too: on the committed
bake the neighbour's face edge darkens from luma 204.3 to 159.1 where the
previous tile's shadow lands on it, and the isolated tile's shadow reads 57.8
against bare felt 66.8.

State the numbers the check already verified, then ask the user the questions
only they can answer: are the tile proportions and bevel right; does the resin
seam read as a physical tile on the standing hand and the discards; is the
shadow band the right strength; do the side walls read as angled inward without
looking like a separate art style; is the standing hand's dimmer face acceptable
(next to the pond)? Compare decoded pixels, not PNG container bytes: zlib can
change the container while the image is identical.

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
