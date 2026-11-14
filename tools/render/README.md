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
- The canonical shells, their projections, and the `shells.json` contract
  were declared in Phase 0; **Phase 1 (below) bakes them**. This section records
  the starting point, not the current state.
- The retired table model, fixed perspective camera, body sprites, baked face
  decals, 32 px shadow gutter, scene spec, batch budgets, contact sheet, tuner,
  and their shipped assets are gone. See [Legacy](#legacy) for the removed
  paths; their history remains in git.

## Commands

```bash
bash tools/render/bake-shells.sh --bake    # bake 1x + 2x, validate, build review sheets
bash tools/render/bake-shells.sh --audition # wall-lean calibration + sheets under build/review
bash tools/render/bake-shells.sh --check   # integrity check; no Blender needed
bash tools/render/bake-shells.sh --check-audition  # validate the calibration; no Blender
bash tools/render/bake-shells.sh           # dry run: build the tile, print the shell plan
bash tools/render/bake-felt.sh             # regenerate frontend/public/table/felt.png
```

`--bake` is the one command that regenerates the committed assets: it renders
the nine shells at @1x and @2x with the pinned Blender at the current base
scale, measures each render, writes `frontend/public/table/shells/*.png`,
`shells/2x/*.png` and `frontend/public/table/shells.json`, then runs the
dependency-free integrity check and regenerates the review sheets under
`tools/render/build/review/`. `--bake --verify-determinism` additionally renders
every shell a second time and compares the decoded RGBA.

`--audition` is the wall-lean calibration path. It renders every candidate in
`shell-spec.json`'s `audition` block into `build/review/candidates/{1x,2x}/`,
writes the candidate manifest `build/review/shell-candidates.json`, writes one
labelled sheet per auditioned shell
(`build/review/shell-candidates-<shell>.png`), then validates the candidates and
the sheets with `check-shells.mjs --audition`. It **never writes the committed
shells or `shells.json`**. `--audition --verify-determinism` re-renders every
candidate. `--check-audition` runs only the dependency-free validation, which is
what makes the calibration self-checking in an environment without Blender.

`--check` is the CI gate (`node tools/render/scripts/check-shells.mjs`). It
validates the specs, the felt PNG, `shells.json` and both texture scales. It
never invokes Blender.

The default `bake-shells.sh` run is a **dry run**: it starts the pinned Blender,
builds the tile, material and lights, prints the nine-shell plan, and exits
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
| `shell-spec.json` | yes | the shell-baker source of truth: Blender pin, CPU-Cycles/AgX settings, jansou tile proportions, bevel `0.055 / 6`, the one-material white/blue split, top-left key + ambient fill, the nine-shell catalogue, output paths, budgets |
| `bake_shells.py` | yes | Blender entry point: version check, tile mesh/material, lights, shell catalogue validation, dry-run plan, Phase 1 render loop |
| `bake-shells.sh` | yes | one command; resolves the pinned Blender, or runs `--check` with no Blender |
| `felt-spec.json` | yes | felt size/format, base colour, noise octaves, vignette curve, dither, runtime fit, byte budget |
| `bake_felt.py` | yes | deterministic stdlib PNG generator for the felt + vignette |
| `bake-felt.sh` | yes | one-command felt regeneration |
| `scripts/check-shells.mjs` | yes | dependency-free spec + PNG + `shells.json` integrity check (CI gate); `--audition` validates the candidate matrix and its labelled sheets |
| `scripts/png.mjs` | yes | dependency-free PNG decode/encode + sprite compositor shared by the checker and the review sheets |
| `scripts/review-shells.mjs` | yes | lays the baked shells out with the manifest's own steps into review sheets; `--audition` writes the labelled candidate sheets |
| `scripts/label-font.mjs` | yes | dependency-free 5×7 bitmap font for the candidate sheets' printed parameters |
| `scripts/rasterize-face.mjs` | yes | vendored face SVG → PNG glyph (resvg) |
| `faces/` | yes | vendored public-domain symbol-only SVG + provenance (`faces/SOURCE.md`) |
| `../../frontend/public/table/felt.png` | yes | the committed full-screen felt raster |
| `../../frontend/public/table/shells/` | yes | shell textures at @1x (`shell_*.png`) |
| `../../frontend/public/table/shells/2x/` | yes | the same nine shells at @2x |
| `../../frontend/public/table/shells.json` | yes | the published shell contract |
| `node_modules/`, `build/` | no | installed dependencies and throwaway review output |
| `build/review/candidates/` | no | Phase 1b candidate textures at the new base (`1x/`, `2x/`) |
| `build/review/shell-candidates.json` | no | Phase 1b candidate manifest (same record shape as `shells.json`) |
| `build/review/shell-candidates-<shell>.png` | no | Phase 1b labelled candidate sheets |

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

## The committed bake (Phase 1c)

Nine shells are baked, measured and committed at the Phase 1b base (the Phase 1
`@2x` size). `shell-spec.json` carries each shell's pose (Euler degrees), camera
(azimuth/elevation + which local face is visible) and expected aspect;
`bake_shells.py` renders it, measures the alpha silhouette, projects the
`faceQuad`, and writes both texture scales. The felt is unchanged.

| Id | Projection | Pose | Camera | Body (@1x) | Texture @1x / @2x | gridStepPx x / y | stackStepPx |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `shell_hand_standing` | front elevation | rotX 90° | az 0 / el 28 | 70 × 102 | 88 × 120 / 176 × 240 | (67.27, 0) / (0, 79.18) | — |
| `shell_flat_upright` | low-angle top-down | — | az 0 / el 45 | 72 × 102 | 90 × 120 / 180 × 240 | (69.4, 0) / (0, 65.44) | — |
| `shell_flat_sideways` | low-angle top-down | rotZ 90° | az 0 / el 45 | 106 × 95 | 124 × 113 / 248 × 226 | (0, 55.15) / (104, 0) | — |
| `shell_wall_horizontal` | low-angle top-down | rotX 180° | az 0 / el 45 | 72 × 102 | 90 × 120 / 180 × 240 | (69.4, 0) / (0, 65.44) | (0, −38.56) |
| `shell_wall_horizontal_faceup` | low-angle top-down | — | az 0 / el 45 | 72 × 102 | 90 × 120 / 180 × 240 | (69.4, 0) / (0, 65.44) | (0, −38.56) |
| `shell_wall_side_left` | fixed oblique | rotX 180°, rotZ 80° | az 0 / el 45 | 104 × 96 | 122 × 114 / 244 × 228 | (−12.15, 48.71) / (91.85, 11.45) | (0, −38.86) |
| `shell_wall_side_left_faceup` | fixed oblique | rotZ 80° | az 0 / el 45 | 104 × 96 | 122 × 114 / 244 × 228 | (−12.15, 48.71) / (91.85, 11.45) | (0, −38.86) |
| `shell_wall_side_right` | fixed oblique | rotX 180°, rotZ −80° | az 0 / el 45 | 104 × 96 | 122 × 114 / 244 × 228 | (12.15, 48.71) / (91.85, −11.45) | (0, −38.86) |
| `shell_wall_side_right_faceup` | fixed oblique | rotZ −80° | az 0 / el 45 | 104 × 96 | 122 × 114 / 244 × 228 | (12.15, 48.71) / (91.85, −11.45) | (0, −38.86) |

All nine PNGs together are **345,508 B** (88,303 @1x + 257,205 @2x; budget
2,097,152 B); the largest single shell is 45,192 B (@1x + @2x, ceiling
262,144 B).
`shells.json` is 29,965 B (budget 65,536 B). The standing hand lands on the
asked-for 88 × 120 / 176 × 240 texture; the body long axis is 102 px (the 104 px
target minus the anti-aliased crop).

**Why the projections are what they are.**

- The ponds and the hand are *axis-aligned rectangles*: azimuth 0. A yaw of even
  6° made the tile a parallelogram whose bounding box left felt gaps between
  neighbours, so the "slightly right" extrusion is carried by the baked shadow
  and AO instead of a sheared silhouette.
- The hand is a front elevation at 28°: enough lift to see the top bevel and the
  blue resin sliver without the face becoming too grazing. The measured face
  luma is 61 (blue sliver on the top edge) against a 94–107 grey face, and the
  diffuse shadow stays out of the glyph area.
- The ponds and top/bottom walls are at 45°: the face is foreshortened and the
  near thickness face is clearly visible. This was the "all shells are too
  top-down" fix.
- The side walls are the only oblique shells: face down, long edge across the
  view, the column leaning inward at the far end (committed 10°). The lean is a
  pose yaw (`rotZ ±80°`), not a roll: it shows as the horizontal component of
  the column's `gridStepPx.x`. The left and right are true mirrors.
- **The geometric trade-off is open.** Leaning the far end inward exposes the
  *inner* end face; the *outer* end (the edge the player sitting on that side
  would see) needs the wall to lean outward. The committed bake uses IN 10; the
  audition keeps IN/OUT at 6° and 14° for the user's pick.
- **A wall is two tiles.** `stackStepPx` is the projected thickness (straight up,
  −38.6 px at 45°), not the face grid step; the layout draws the lower tier
  first, then the upper tier at `+stackStepPx`. `gridStepPx` steps between
  stacks. A revealed dora indicator is the face-up counterpart shell in the
  upper tier.
- **The contact shadow is diffuse and subtle**: 11–12 px right/bottom at peak
  alpha 0.12 with an 8 px blur and a 16 px falloff, plus a 1 px / 0.20 AO
  fringe. Phase 1/1b's 3–4 px band at 0.33 was the "too tight" review note.

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
      "texWidth": 90,
      "texHeight": 120,
      "anchorX": 2,
      "anchorY": 2,
      "advanceWidth": 72,
      "advanceHeight": 102,
      "padding": { "top": 2, "right": 16, "bottom": 16, "left": 2 },
      "faceRotationDeg": 0,
      "faceQuad": [[8.39, 4.6], [67.61, 4.6], [67.61, 62.84], [8.39, 62.84]],
      "faceQuadOrder": "face-local [top-left, top-right, bottom-right, bottom-left]",
      "gridStepPx": { "x": [69.4, 0], "y": [0, 65.44] },
      "projection": "low-angle-top-down",
      "pose": { "rotateXDeg": 0, "rotateYDeg": 0, "rotateZDeg": 0 },
      "camera": { "azimuthDeg": 0, "elevationDeg": 45, "orthoScale": 1.642469, "pixelsPerUnit2x": 185.087201, "resolution1x": [118, 152], "resolution2x": [236, 304] },
      "measured": {
        "alphaExtent1x": { "left": 1, "top": 1, "right": 11, "bottom": 11 },
        "alphaPeak1x": { "left": 0.2, "top": 0.2, "right": 0.1216, "bottom": 0.1216 },
        "alphaMass1x": { "left": 19.2, "top": 13.4, "right": 50.718, "bottom": 41.992 },
        "shadowCatcherPeak": 0.4966,
        "solidInset1x": [1, 1, 1, 1],
        "faceSampleRgb": [223, 220, 216],
        "edgeSamplesRgb": { "top": [223, 220, 217], "bottom": [0, 8, 31] },
        "bytes1x": 7990,
        "bytes2x": 23580
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
  exactly 1 px inside the declared box. Without that ledge an anti-aliased
  0.4-alpha silhouette pixel would be indistinguishable from the 0.12-alpha
  diffuse shadow and the shadow/AO contract could not be measured.
- `gridStepPx.x` / `gridStepPx.y` — **use these for a tight grid**, not the
  advance box. They are the projected tile width/height axes (face-local X and
  Y) in @1x px, each oriented so a vector points right when that axis is more
  horizontal or down when it is more vertical. A pond row steps by the axis that
  points right; a vertical run (a hand, a pond row of rows, a wall column) steps
  by the axis that points down. For the side walls the short *width* axis is the
  column step, so it is `gridStepPx.x`, not `.y`; always pick the axis whose
  published vector points down the screen.
- `stackCount` / `stackStepPx` — wall shells only. A wall column is two tiles;
  `stackCount` is 2 and `stackStepPx` is the vector from the lower tier's body
  top-left to the upper tier's, i.e. the projected tile **thickness** (straight
  up on screen). It is not the face grid step. Draw the lower tier first, then
  the upper tier at `+stackStepPx`; the upper tier is the same face-down shell,
  or the face-up dora counterpart when the indicator is revealed.
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
  key's screen-space direction, the shadow/AO contract, the 2-tile stack, the
  target long-axis size, and each shell's framing. It is the audit trail for a
  bake.

The check enforces: every path exists and decodes as 8-bit RGBA; the PNG sizes
match (with the @2x exactly twice the @1x); the declared padding matches the
spec and the anchor; the opaque body is inset exactly 1 px; the faceQuad is a
convex projected rectangle inside the body with an oblique-plausible aspect;
`gridStepPx` follows from the faceQuad; `stackStepPx` is present on exactly the
wall shells and matches the projected thickness within 1.5 px; the shadow/AO
extents and peaks stay in the 10–16 px / 1–2 px contract; the shadow points
down-right; the outer texture ring is transparent; the light reads top-left (on
the flat shells the top edge is brighter and the near thickness is cool/darker;
the standing hand is checked by its blue top sliver); face-up shells are ivory
and face-down shells are blue; the @1x and @2x agree within a mean channel delta
of 8; the decoded-RGBA hashes and byte counts match the manifest; and the
per-shell/total byte budgets hold.

### The two-tone resin seam and the light

The tile body is one material whose white/blue split is gated on local Z at
`backEdgeFraction` (0.3 of the thickness), so the seam wraps the bevel instead
of stopping at a face boundary. What that produces per shell:

- standing hand: white face plate, the **blue resin sliver at the very top**
  (`edgeSamplesRgb.top` = `[3, 70, 166]`) and the lit bottom bevel
  `[81, 89, 98]`;
- face-up flat: white plate, the far white bevel `[223, 220, 217]`, the unlit
  cool thickness strip at the near edge `[0, 8, 31]`;
- face-down wall: **blue plate** (`faceSampleRgb` `[3, 68, 165]`) with the cool
  near face `[41, 59, 75]` below it;
- face-up dora: the same projection with the ivory plate `[223, 220, 216]` and
  the cool near strip `[0, 8, 32]`.

The standing hand's face sample is `94, 100, 107` at el 28: the screen-locked key
is more grazing on a vertical face the higher the camera, which is the cost of
the extra tile top the review asked for. The committed check therefore treats
"ivory vs blue" as a hue fact for the hand (it is still grey-neutral, not blue)
and keeps the brightness assertion for the flat faces (`223, 220, 216`). If the
hand should be as bright as the pond, the lever is `lighting.key` (or two
lighting variants), not a per-shell hack.

## Review history and the wall-lean calibration

The Phase 1b review did two things. It doubled the base scale — the Phase 1
`@2x` output is the new `@1x` base, `bake.targetLongAxisPx1x` is **104** (was
52) and the new `@2x` is **208**, so the board coordinate space doubles and every
consumer reads the new `shells.json`. And it picked the cameras: the hand at
28°, the upright pond and the top/bottom wall at 45°, the sideways shell at 45°,
and the side walls at 45° with an inward lean. The pick also added the 2-tile
stack, the face-up dora shells and the diffuse contact shadow; all of that is in
the committed bake above and in §10 of the architecture doc.

The one visual still open is the **side-wall lean and visible edge**. A rigid
projection cannot both lean the far end inward and show the outer end face: the
leaning side is the end that becomes visible. The committed shell leans IN 10°
and therefore shows the inner end. `--audition` renders the calibration at the
current base:

```bash
bash tools/render/bake-shells.sh --audition                    # + sheets + validation
bash tools/render/bake-shells.sh --audition --verify-determinism  # + re-render
bash tools/render/bake-shells.sh --check-audition              # no Blender
```

Four candidates per side wall at el 45: **IN 6°**, **IN 14°**, **OUT 6°**,
**OUT 14°**, with the committed **IN 10°** as the `REF` column. Each candidate
is composed as a 2-high stack (bottom tier, then the top tier at its published
`stackStepPx`), so the sheet shows the actual wall read, not a single tile. The
output is gitignored:

| Path | Contents |
| --- | --- |
| `build/review/candidates/{1x,2x}/` | candidate textures |
| `build/review/shell-candidates.json` | candidate records (same shape as `shells.json`, plus `candidate`) |
| `build/review/shell-candidates-shell_wall_side_left.png` | 4 candidates + REF, left wall |
| `build/review/shell-candidates-shell_wall_side_right.png` | 4 candidates + REF, right wall |

`check-shells.mjs --audition` keeps the committed checks and adds the candidate
ones (both scales, the base long axis, the shadow/AO contract, `faceQuad` and
`gridStepPx`, `stackStepPx`, hashes) plus the sheets' printed-text and
composited-tile pixel checks; the full run reports **858 checks**. The committed
bake alone reports **485**.

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
PASS shell_flat_upright shadow reaches 11 px right (contract 10-16)
PASS shell_flat_upright AO reaches 1 px left (contract 1-2)
PASS shell_flat_upright right shadow peaks at alpha 0.122 (0.08-0.16)
PASS shell_flat_upright bottom thickness strip is cool and darker than the top
PASS shell_flat_upright face is ivory, not blue resin (223,220,216, luma 220.3)
PASS shell_wall_horizontal face is blue resin (3,68,165)
PASS shell_wall_horizontal declares a 2-tile stack (2)
PASS shell_wall_horizontal stackStepPx is the projected thickness (-38.56 vs -38.56 px)
INFO shell_flat_upright margin mass L19.20 T13.40 R49.03 B41.04
PASS shell_flat_upright decoded-RGBA sha256 matches the committed PNGs
INFO shell textures total 345508 B across 9 shells and 2 scales
OK 485 checks passed
```

`--audition` additionally validates the wall-lean calibration and its sheets; on
the current output it reports `OK 858 checks passed` (373 of them candidate and
sheet checks). The committed-only run stays at 485.


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
xdg-open tools/render/build/review/shells-row-1x.png      # all nine, catalogue order
xdg-open tools/render/build/review/discard-row-1x.png     # 6-tile row + isolated + riichi
xdg-open tools/render/build/review/discard-row-zoom4x.png # nearest 4x of the seams
xdg-open tools/render/build/review/wall-stack-1x.png      # 2-tile stacks + dora + side walls
xdg-open tools/render/build/review/wall-stack-zoom4x.png  # nearest 4x of a stack seam
xdg-open tools/render/build/review/each-4x-shell_flat_upright.png
ls tools/render/build/review/each-4x-*.png                # all nine shells at 4x
```

The review sheets are throwaway: `build/` is gitignored. They are drawn on the
felt's base colour (`#1a5038`) so shadow contrast is easy to see, with the
manifest's own `gridStepPx` and draw order (rows right-to-left, wall bottom tier
before the top tier). The script prints the seam numbers too: on the committed
bake the neighbour's face edge darkens from luma 218.3 to 210.1 where the
previous tile's shadow lands on it, and the isolated tile's shadow reads 61.1
against bare felt 66.8. The diffuse band is deliberately subtle in these
numbers; the strength is a visual call for the user.

To review the open side-wall lean, run `--audition` (above) and open the two
sheets:

```bash
xdg-open tools/render/build/review/shell-candidates-shell_wall_side_left.png
xdg-open tools/render/build/review/shell-candidates-shell_wall_side_right.png
```

Each sheet has a header with the shell id, the base size and the question it
asks, then one column per candidate (IN 6°, IN 14°, OUT 6°, OUT 14°) plus a
`REF COMMITTED` column with the committed IN 10° shell. Every column is a 2-high
stack built from that candidate's own `gridStepPx` and `stackStepPx`, and the
labels print the camera, texture, body, projected face, stack rise and byte
numbers. The sheet is a review artefact: it is not the layout engine.

State the numbers the check already verified, then ask the user the questions
only they can answer: is the diffuse shadow the right strength and softness;
does the 2-tile stack read as a wall; does the dora face-up top tile sit
correctly on its stack; is the inward lean the right read, or should the wall
lean outward so the outer end face shows; is the standing hand's dimmer face
acceptable next to the pond? Compare decoded pixels, not PNG container bytes:
zlib can change the container while the image is identical.

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
