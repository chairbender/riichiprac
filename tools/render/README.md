# Offline 2.5D shell + felt pipeline

This directory is the **shell baker** for the opt-in rendered view. It is a
developer-only asset pipeline: nothing here is bundled, imported, or shipped by
the frontend. The runtime is 2D composition (images plus DOM), so every tile
shell, its separate blob shadow, and the felt background are baked offline.

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
bash tools/render/bake-shells.sh --bake    # bake 1x + 2x, build sheets, validate
bash tools/render/bake-shells.sh --preview --only <id> [--only <id>...]  # fast partial bake
bash tools/render/bake-shells.sh --preview-shadow --only <id>  # single-tile shadow, no Blender
bash tools/render/bake-shells.sh --audition # standing-hand fan calibration + sheets
bash tools/render/bake-shells.sh --shadow-audition  # REF + A/B/C shadow sheet
bash tools/render/bake-shells.sh --check   # shell + contact-shadow check; no Blender needed
bash tools/render/bake-overlays.sh --bake  # bake the Phase 3.5 contact decals + check
bash tools/render/bake-overlays.sh --check # contact decals + composed pixels; no Blender
bash tools/render/bake-hand-catches.sh        # production 3D hand catches + check
bash tools/render/bake-contact-shadow-experiment.sh  # 3D shadow-catch experiment; build-only
bash tools/render/bake-lying-samples.sh          # lying-family catch samples; build-only
bash tools/render/bake-lying-catches.sh          # production pond/meld catches + review
bash tools/render/bake-shells.sh --check-audition  # validate the calibration; no Blender
node tools/render/scripts/preview-group-shadow.mjs  # merged vs per-tile group shadows; no Blender
node tools/render/scripts/bake-faces.mjs   # bake the 37 face glyphs + faces.json (resvg)
node tools/render/scripts/check-faces.mjs  # face glyph + atlas budget gate; no Blender/resvg
bash tools/render/bake-decals.sh --spike   # carve/lit decal spike into build/decals (Blender)
bash tools/render/bake-decals.sh --check   # validate the build decal manifest; no Blender
cd frontend && npm run tune:carved         # lying-rig tuner at http://localhost:7458
cd frontend && npm run atlas:review:carved # flat vs carved review sheets
cd frontend && npm run atlas:review        # build the real atlas and write review sheets
bash tools/render/bake-shells.sh           # dry run: build the tile, print the shell plan
bash tools/render/bake-felt.sh             # regenerate frontend/public/table/felt.png
bash tools/render/bake-table-reference.sh  # dry run: build the whole-table reference scene, print camera metrics
bash tools/render/bake-table-reference.sh --bake  # whole-table reference: @2x render -> 1x board + 2x crops + manifest + check
bash tools/render/bake-table-reference.sh --rig   # 2.5D rig: default variant -> RGBA reference + record + acceptance check
bash tools/render/bake-table-reference.sh --rig --variant v2-compact   # one A/B variant
bash tools/render/bake-table-reference.sh --rig --variant v2-compact --rig-width 700 --samples 12  # fast tuning; never publishes
bash tools/render/bake-table-reference.sh --check # whole-table + rig integrity gates; no Blender
```

The group-shadow lab is a static page; serve the repo root and open it:

```bash
python3 -m http.server 8123
xdg-open http://localhost:8123/tools/render/scripts/group-shadow-lab.html
```

It renders the proposed UI recipe (one CSS `filter: blur()` per zone) next to
the per-tile-max reference, prints the browser blur's fidelity to the reference
Gaussian, and times a full-board rebuild. `preview-group-shadow.mjs` writes the
matching no-Blender sheets and the alpha/seam numbers under `build/preview/`.

`--shadow-audition` renders the committed shadow REF plus A/B/C on the flat,
wall and hand shells under `build/review/shadows/`, writes
`build/review/shadow-candidates.png` with the peak/floor/blur/padding and the
seam/drop luma printed, and validates the variant records and the sheet
(7,789 checks). It never touches the committed shells.

`--preview-shadow` is the fastest loop for the blob: it reads the committed body
PNG and its measured table-contact footprint, regenerates only that shell's
shadow from the current spec, and writes `shadow-<id>-1x.png`, a 3x zoom and the
shadow-only sprite under `build/preview/`. It never starts Blender and never
writes the committed assets.

`--preview` is the fast loop. It renders only the `--only` shells under
`tools/render/build/preview/` (never the committed paths), writes a partial
preview manifest, and draws `preview-1x.png` plus a 4x zoom per shell. It skips
the full 107-shell check, so a one- or two-shell change takes seconds instead of
the full bake. Use it while tuning a shell, then do a full `--bake` for the
committed manifest and the full review sheets.

`--bake` is the one command that regenerates the committed assets: it renders
all 107 shells (twelve base + 14 human-hand slots + 13 top-hand slots + 68
front/back wall slots) at @1x and @2x with the
pinned Blender at the current base scale, measures each render, writes
`frontend/public/table/shells/*.png`, `shells/2x/*.png` and
`frontend/public/table/shells.json`, regenerates the review sheets under
`tools/render/build/review/`, then runs the dependency-free integrity check.
The optional `--verify-determinism` diagnostic renders every shell a second time
and compares the decoded RGBA; it is not part of the standard bake.

`--audition` is the standing-hand fan calibration path. It renders every candidate in
`shell-spec.json`'s `audition` block into `build/review/candidates/{1x,2x}/`,
writes the candidate manifest `build/review/shell-candidates.json`, writes one
labelled sheet per auditioned shell
(`build/review/shell-candidates-<shell>.png`), then validates the candidates and
the sheets with `check-shells.mjs --audition`. It **never writes the committed
shells or `shells.json`**. `--check-audition` runs only the dependency-free validation, which is
what makes the calibration self-checking in an environment without Blender.

`--check` is the CI gate. It runs `check-shells.mjs` (the specs, the felt PNG,
`shells.json` and both texture scales) and then `check-overlays.mjs` (the Phase
3.5 decals and their composed pixels). It never invokes Blender. The standalone
overlay loop is `bash tools/render/bake-overlays.sh --check`.

The default `bake-shells.sh` run is a **dry run**: it starts the pinned Blender,
builds the tile, material and lights, prints the seventy-seven-shell plan, and exits
without writing an image.

The felt bake uses system `python3` only (stdlib; no NumPy, no Blender):

```bash
python3 tools/render/bake_felt.py --spec tools/render/felt-spec.json
```

Face glyphs are rasterised with the pinned resvg rasteriser:

```bash
node tools/render/scripts/bake-faces.mjs          # all 37 glyphs + faces.json
node tools/render/scripts/rasterize-face.mjs \
  tools/render/faces/Regular-Man1.svg build/faces/1m.png --width 300
```

`bake-faces.mjs` needs `npm ci` in `tools/render` once (the directory is
gitignored); `check-faces.mjs` needs nothing but Node. `check-decals.mjs` needs
`@napi-rs/canvas` to decode the committed AVIF/WebP decals. The 2.5D runtime
composites these 2D glyphs into each shell's `faceQuad` in a startup atlas; tile
art is never rasterised in the browser. See "Phase 2" below.

## Toolchain (pinned, outside the repo)

| Tool | Version | Location | Used for |
| --- | --- | --- | --- |
| Blender | **4.5.9 LTS** | `~/.local/opt/blender-4.5.9/blender` (or `BLENDER=...`) | tile mesh, lights, shell renders |
| Node | ≥ 18 | system `node` | the integrity check and resvg scripts |
| `@resvg/resvg-js` | **2.6.2** | `tools/render/node_modules` (installed, gitignored) | rasterising face SVGs |
| `@napi-rs/canvas` | **1.1.1** | `tools/render/node_modules` (installed, gitignored) | AVIF/WebP decal encoding and the decal integrity check |
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

## Whole-table model + slot anchors (not a runtime asset)

`bake-table-reference.sh` builds the complete table in Blender — a 700 mm
playable mat, a raised rim/frame, a recessed centre compass/score well, four
17-stack two-tier wall runs (132 tiles after the four draw ends; the left run
has the 7-stack dead wall with a break and a face-up dora), four full 6×3 ponds
(72, each with one riichi discard turned to the player's right), four 13-tile
hands (52) plus the human's drawn tile, and one open meld per seat **outside the
wall on the player's right** (12; the called tile's near edge is flush with the
uprights) — and renders it for placement review. It also
builds the **`SlotAnchors`** collection: 293 named `Empty`s (136 wall slots,
132 occupied, 88
rivers including overflow, 16 meld slots, 53 hand slots), each at the tile body
centre with the tile pose, a `{zone:seat:index}` custom-property set, and the
12-float local/world face quad that a later export projects with
`world_to_camera_view`. The machine-readable dump is
`reference/slot-anchors.json`.

Adjacent tiles carry a 0.2–0.5 mm clearance (0.3 mm target, pond columns 0.2 mm
so the four inner rows clear at the corners) and no tile bodies intersect; the
south hand is reclined 12°. The bake measures 346 adjacent pairs, reports
0.2–0.3 mm, and proves 0 intersections; the dead-wall break (14.3 mm) and the
turned riichi tile's far-side gap (7.3 mm) are recorded exceptions. The camera and sun are inherited from
the previous calibration reference; **perspective and lighting are a separate
Task 2**, so this render is for placement, not a lighting verdict. See
[`TABLE-REFERENCE.md`](TABLE-REFERENCE.md) for the naming scheme, the face-quad
contract, the resolved ambiguities and the full check list.

### The 2.5D rig (Task 2 of the implementation plan)

`--rig` runs the same scene and the same 269 placements through the new
pipeline's camera and light rig instead of the placement camera: perspective,
**75 mm** on a 36 mm sensor, pitched **50°**, centred on X = 0 behind the south
edge, **negative Shift Y**, no roll; one large soft **AREA key** slightly forward
of centre plus low AREA fills; a low ambient world; **film transparent** with the
room floor hidden.

The rig is **variant-based for A/B**. `table-reference-spec.json`'s `rig` blocks
are the saved `v1-baseline`; `rig.variants` holds experiments that may override
the table layout (hand/meld radius, hand tilt), the camera, the lights, the
render settings and the acceptance thresholds. `--variant NAME` picks one (a variant may `extends` another, so a small delta
sits on top of an earlier experiment); each publishes
`reference/rig/<variant>-1x.png` and `<variant>.json`, and
`reference/rig/index.html` is the A/B page. `scripts/check-table-rig.mjs` gates
**every committed variant**, recomputing the geometry from the camera and
placements and then measuring the rendered pixels (AGENTS.md §6):

- the +Y vanishing point of both side-wall runs is above the frame and the runs
  meet it within 1 px;
- both side walls' inner vertical faces are visible slivers and measure brighter
  than the felt;
- the south hand's centre slot is straight-on while the outer slots show an
  inner sliver, growing outward;
- no south-hand plate edge leans inward and the outward lean stays under 2.5 px;
- every tile is inside the frame, the hand sits at the variant's height, and the
  width margins meet the variant's floor;
- the blank pond face, blue wall back, blank hand face and side-face probes are
  lit as specified, and the PNG is RGBA with the declared transparency.

**v1-baseline** (saved 2026-11-17): 76 units, hands/melds at radius 10.6, the
player's hand reclined 12°, a 9000 W key; the whole mat+rim width framed, discard
face 217.2 luma. **v2-compact** (experiment): 59 units, hands/melds at 8.8 (1.3
units behind the wall), the player's hand reclined 40°, key 6000 W; framed to the
tile content, every tile inside, tiles 1.29× linear larger, discard face 203.3
luma. **v3-hand-shadow** (experiment): the player's hand alone moves back to 9.3
(half a tile height), the camera refits to 60.5 units, and the hand's own shadow
is replaced by a shadow-only caster at the 12° physical pose (the fills are
light-linked away from it), so there is nothing on the wall behind the hand.
**v4-shadow-decal** (experiment) keeps v3's spacing and replaces that caster with
a fake soft gradient decal: a strip whose hidden near edge sits under the tile so
the visible gradient emerges from the front edge, with no shadow rays at all.
**v5 / v6 / v7** are three longer, stronger takes on that gradient (0.55 / 0.65 /
0.42 units, 50 / 40 / 65 % max alpha) that lift the framing 19 px so the gradient
finishes on lit felt; they are for choosing a preference.
**v10-shadow-split-blobs** rebuilds the chosen take A as the retired UI shadow
recipe: one blurred contact rectangle per hand group, all four edges blurred
(σ 0.28 across the depth, 0.12 across x), each group widened only outward by
0.15 units and extended 0.5 units north under the tiles. The shadow therefore
extends past the outer ends, fades in every direction past the tiles (no hard
line), and the tsumogiri gap keeps the drawn tile's own blob separate.

The **hand cheat** in v2 reclines the player's hand further than is physical, so
the near bottom edge floats and the real cast shadow is not the production
shadow (the runtime uses a blob). To keep the light on it looking physical, the
hand bodies and decals shade with their normals rotated back by the extra 28°
about world X: the key and fills land exactly as on the 12° pose, and the gate
enforces hand/discard luma ≤ 0.7 (measured 0.589 in v2; without the correction the 40°
hand reads 178.8 instead of 119.8). v4 uses that shading plus a fake soft
gradient shadow (see above). The silhouette keeps the cheat; the shading and the
shadow do not.

The v1 rig reproduces the shipped shells' face `[223, 220, 216]` and blue
`[3, 68, 165]` within a few levels. See `TABLE-REFERENCE.md` for the parameter
tables, the variant workflow and the user sign-off questions.

This is development-only: nothing under `frontend/public` is written and the
runtime never reads it.

## Directory layout

| Path | Committed | Purpose |
| --- | --- | --- |
| `shell-spec.json` | yes | the shell-baker source of truth: Blender pin, CPU-Cycles/AgX settings, jansou tile proportions, bevel `0.055 / 6`, the one-material white/blue split, top-left key + ambient fill, the nine-shell base catalogue and the wallSlots fan, output paths, budgets |
| `bake_shells.py` | yes | Blender entry point: version check, tile mesh/material, lights, shell catalogue validation, dry-run plan, Phase 1 render loop |
| `bake-shells.sh` | yes | one command; resolves the pinned Blender, or runs `--check` with no Blender |
| `faces-spec.json` | yes | the 37 face glyphs: pinned upstream SVGs, 288 × 384 RGBA raster, red paint, output paths, byte budget |
| `bake-faces.mjs` / `face-raster.mjs` | yes | resvg glyph baker and its single shared rasteriser (also used by `rasterize-face.mjs`) |
| `check-faces.mjs` | yes | dependency-free face-glyph + committed-asset + atlas-budget gate (CI) |
| `decal-spec.json` | yes | the carved decal contract: pin, 158 × 216 @2x raster, carve parameters, separate upright/lying light rigs, surface rotations, outputs |
| `bake_decals.py` | yes | Blender 4.5.9 carve/paint/light decal baker (imports the shell baker's helpers) |
| `bake-decals.sh` | yes | one command for dry-run/spike/build/commit/check |
| `encode-decals.mjs` | yes | PNG → AVIF/WebP encoder for the committed decal set, with decoded measurements/hashes |
| `decal-image.mjs` | yes | Node Canvas decode + decal measurement shared by the encoder and checker |
| `check-decals.mjs` | yes | Node Canvas carved-decal (AVIF/WebP/PNG) + committed budget gate (CI) |
| `../../frontend/scripts/tune-carved.ts` | yes | the lying-rig preview/tuner server |
| `../../frontend/scripts/tune-carved.html` | yes | the tuner UI |
| `felt-spec.json` | yes | felt size/format, base colour, noise octaves, vignette curve, dither, runtime fit, byte budget |
| `bake_felt.py` | yes | deterministic stdlib PNG generator for the felt + vignette |
| `bake-felt.sh` | yes | one-command felt regeneration |
| `table-reference-spec.json` | yes | the whole-table calibration reference: table plan, camera candidates, sun rig, crop families, render sizes, thresholds |
| `bake_table_reference.py` | yes | Blender 4.5.9 whole-table scene builder, pinhole/visibility assertions and @2x master render |
| `bake-table-reference.sh` | yes | dry-run / audition / bake / check for the whole-table reference |
| `TABLE-REFERENCE.md` | yes | the reference's calibration note: scene, chosen perspective, metrics, how to compare |
| `scripts/table-camera.mjs` | yes | shared reference pinhole, tile-corner projection, metrics and crop rects |
| `scripts/table-reference.mjs` | yes | publishes the 1x board, 2x crops, manifest and contact page from the master |
| `scripts/check-table-reference.mjs` | yes | dependency-free reference spec/scene/render/hash/projection/lighting gate (CI) |
| `scripts/table-rig.mjs` | yes | publishes one rig variant (`<variant>-1x.png`, `<variant>.json`) and rebuilds the A/B `index.html` |
| `scripts/check-table-rig.mjs` | yes | dependency-free gate for every committed variant (contract, geometry, framing, pixel probes) |
| `scripts/table-rig-spec.mjs` | yes | the rig-variant merge/resolution shared by the publisher and checker |
| `scripts/table-rig-samples.mjs` | yes | point and projected-polygon sample measurement shared by the rig publisher and checker |
| `reference/` | yes | committed calibration renders (`full-board-1x.png`, `crops-2x/`, `table-reference.json`, `index.html`) |
| `reference/rig/<variant>-1x.png` | yes | each committed rig variant at 1920 × 1080 RGBA (v1-baseline, v2-compact, …) |
| `reference/rig/<variant>.json` | yes | each variant's record: resolved settings, layout, camera, lights, placements, acceptance numbers, measured probes |
| `reference/rig/index.html` | yes | the A/B page: every variant's image and numbers side by side |
| `scripts/check-shells.mjs` | yes | dependency-free spec + PNG + `shells.json` integrity check (CI gate); `--audition` validates the candidate matrix and its labelled sheets |
| `scripts/png.mjs` | yes | dependency-free PNG decode/encode + sprite compositor shared by the checker and the review sheets |
| `scripts/shadow-group.mjs` | yes | the hard shadow footprint per shell and the group field (`merged` union-then-blur vs `perTile` blur-then-max); browser-safe |
| `scripts/group-layouts.mjs` | yes | representative groups (hands, melds, ponds, walls) placed with the manifest's own face-centre steps; browser-safe |
| `scripts/preview-group-shadow.mjs` | yes | no-Blender group comparison: merged vs per-tile max, alpha/seam numbers and sheets |
| `scripts/group-shadow-lab.html` | yes | browser lab for the proposed UI recipe: one CSS `filter: blur()` per zone; reports timing and a canvas-blur fidelity number |
| `scripts/review-shells.mjs` | yes | lays the baked shells out with the manifest's own steps into review sheets; `--audition` writes the labelled candidate sheets |
| `scripts/label-font.mjs` | yes | dependency-free 5×7 bitmap font for the candidate sheets' printed parameters |
| `scripts/rasterize-face.mjs` | yes | vendored face SVG → PNG glyph (resvg) |
| `faces/` | yes | the 37 vendored public-domain symbol-only SVGs + provenance (`faces/SOURCE.md`) |
| `../../frontend/public/table/felt.png` | yes | the committed full-screen felt raster |
| `../../frontend/public/table/shells/` | yes | shell textures at @1x (`shell_*.png`) |
| `../../frontend/public/table/shells/2x/` | yes | all 107 body shells at @2x (no @2x shadow sprites) |
| `../../frontend/public/table/shells.json` | yes | the published shell contract |
| `../../frontend/public/table/faces/` | yes | the 37 committed face glyphs at 288 × 384 RGBA |
| `../../frontend/public/table/faces.json` | yes | the published face-glyph contract |
| `../../frontend/public/table/decals/` | yes | the 180 committed AVIF q60 carved decals |
| `../../frontend/public/table/decals.json` | yes | the published carved-decal contract |
| `../../frontend/src/table/` | yes | the runtime `TileAtlasBuilder` / `TileAtlas` / manifests, not part of this pipeline |
| `../../frontend/scripts/review-atlas.ts` | yes | builds the real atlas with Node Canvas and writes the review sheets |
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

## The committed bake (Phase 1c + the hand/wall fans)

**107 shells** are baked, measured and committed at the Phase 1b base (the
Phase 1 `@2x` size): the twelve-shell base below (including the four flat river
orientations and the two side-hand backs), the 14-slot standing-hand fan, and
the 68 front/back wall slot shells (17 slots × 2 walls × face-down/face-up).
`shell-spec.json` carries each base shell's pose (Euler degrees), camera
(azimuth/elevation + which local face is visible) and expected aspect, plus the
compact `handSlots` and `wallSlots` blocks the baker expands into the slot
catalogue. `bake_shells.py` renders each, measures the alpha silhouette, projects
the `faceQuad`, and writes both texture scales. The felt is unchanged.

| Id | Projection | Pose | Camera | Body (@1x) | Body tex / Shadow tex @1x | gridStepPx x / y | stackStepPx |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `shell_flat_upright` | low-angle top-down | — | az 0 / el 45 | 72 × 102 | 76 × 106 / 104 × 136 | (69.4, 0) / (0, 65.44) | — |
| `shell_flat_sideways` | low-angle top-down | rotZ 90° | az 0 / el 45 | 106 × 95 | 110 × 99 / 138 × 129 | (0, 55.15) / (104, 0) | — |
| `shell_flat_upright_180` | low-angle top-down | rotZ 180° | az 0 / el 45 | 72 × 102 | 76 × 106 / 160 × 162 | (69.41, 0) / (0, 65.44) | — |
| `shell_flat_sideways_270` | low-angle top-down | rotZ 270° | az 0 / el 45 | 106 × 95 | 110 × 99 / 194 × 155 | (0, 55.15) / (104, 0) | — |
| `shell_wall_horizontal` | low-angle top-down | rotX 180° | az 0 / el 45 | 72 × 102 | 76 × 106 / 104 × 136 | (69.4, 0) / (0, 65.44) | (0, −38.56) |
| `shell_wall_horizontal_faceup` | low-angle top-down | — | az 0 / el 45 | 72 × 102 | 76 × 106 / 104 × 136 | (69.4, 0) / (0, 65.44) | (0, −38.56) |
| `shell_wall_side_left` | off-axis perspective | rotX 180°, rotZ 90° | el 45, 2 units inside / d10 | 104 × 85 | 108 × 89 / 136 × 119 | (−6.91, 45.96) / (92.84, 0) | (−5.64, −39.87) |
| `shell_wall_side_left_faceup` | off-axis perspective | rotZ 90° | el 45, 2 units inside / d10 | 104 × 85 | 108 × 89 / 136 × 119 | (−6.91, 45.96) / (92.84, 0) | (−5.64, −39.87) |
| `shell_wall_side_right` | off-axis perspective | rotX 180°, rotZ 90° | el 45, 2 units inside / d10 | 104 × 85 | 108 × 89 / 136 × 119 | (6.91, 45.96) / (92.84, 0) | (5.64, −39.87) |
| `shell_wall_side_right_faceup` | off-axis perspective | rotZ 90° | el 45, 2 units inside / d10 | 104 × 85 | 108 × 89 / 136 × 119 | (6.91, 45.96) / (92.84, 0) | (5.64, −39.87) |
| `shell_hand_side_left` | off-axis perspective | rotX 90°, rotZ 270° | el 45, 2 units inside / d10 | 67 × 102 | 71 × 106 / 163 × 168 | (−6.7, 45) / (9.05, 64.01) | — |
| `shell_hand_side_right` | off-axis perspective | rotX 90°, rotZ 90° | el 45, 2 units inside / d10 | 67 × 102 | 71 × 106 / 163 × 168 | (6.2, 41.67) / (−9.05, 64.01) | — |

The two side-hand backs stand the tile up (`rotX 90`) and reuse the side-wall
camera, one shell per side. The pose and camera are both mirrored (left
`rotZ 270` / camera +2, right `rotZ 90` / camera −2) so both blue backs face the
human. Their
shadow is standing (σ 5) and needs a wider per-shell shadow box
(`shadowPadding1x`), because the yawed base strip is wider than a hand fan's.

All 107 shell bodies plus their @1x shadow references are **4,428,110 B**
(budget 6,291,456 B); the @2x body textures are included, the redundant @2x
shadow sprites were removed in Phase 2b. `shells.json` is **563,226 B** (budget
614,400 B). The hand
slots keep the 104 px body long axis (102 px measured); the human-hand centre
body is 75 × 106 and its shadow 119 × 142, the drawn body 89 × 106 and its
shadow 133 × 142. The budgets were raised for the fans; a board loads only the
slots it draws, so the initial load stays well under the 4 MiB limit.

**Why the projections are what they are.**

- The ponds and melds are *axis-aligned rectangles*: azimuth 0, no per-slot
  camera. A yaw of even 6° made the tile a parallelogram whose bounding box left
  felt gaps between neighbours, so the "slightly right" extrusion is carried by
  the baked shadow and AO instead of a sheared silhouette. The four seats are
  glyph orientations, not camera variants.
- The hand is a **per-slot fan** at 28°: the centre tile is straight on, the
  outer tiles and the drawn tile are seen from the player's eye, and the face
  stays a vertical front elevation with the top bevel and blue sliver. The
  measured face luma is still 94–107 (dim against the pond's ~220); brightening
  it is a deferred lighting decision.
- The ponds and the generic wall shell are at 45°: the face is foreshortened and
  the near thickness face is clearly visible. This was the "all shells are too
  top-down" fix.
- The walls are the non-orthographic shells. The side-wall tile is **square to
  the table**, not yawed: the camera sits 2 units inside the wall at distance 10
  with no yaw and no roll, looking along the wall's inward normal at el 45. That
  keeps the long edges parallel to the table edge (horizontal to 0.01 px) while
  the lateral offset reveals the near end face. Measured: near long edge
  84.0 px, far 81.3 px (3.3% keystone), and the far edge is 7.5 px toward the
  centre. The left and right are true mirrors (camera offset ±2).
- **The front/back walls are a per-slot fan**, not one shell (§ below): 17 slots
  per wall, the centre straight on and the outer slots seen from the human's
  eye. The side-wall offset is approved at 2 units; the open pick is the fan
  strength, not the side-wall camera.
- **One perspective is reused down the column**, even though the projection
  would physically change with depth; that is the Tenhou approach. The camera
  framing (lens and lens shift) is solved to hit the 104 px target and centre
  the tile. The off-axis camera makes the projected thickness drift 5.6 px
  sideways, so `stackStepPx` is `(∓5.64, −39.87)`, not straight up.
- **The side-wall offset is settled at 2 units** (the user approved the side
  walls). The open pick is the **front/back fan strength**: the outer slot at
  closer/farther eye distances, auditioned against the committed physical
  distance.
- **A wall is two tiles.** `stackStepPx` is the projected thickness (straight up,
  −38.6 px at 45°), not the face grid step; the layout draws the lower tier
  first, then the upper tier at `+stackStepPx`. `gridStepPx` steps between
  stacks. A revealed dora indicator is the face-up counterpart shell in the
  upper tier.
- **The shadow is a synthetic blob**: every tile — lying or standing — gets a
  **rounded rectangle** fitted to what it rests on. A lying tile's rectangle
  matches the body's long/short sides (`rectScale` 1.15, +8 px, corner radius
  0.3 of the short half-axis), with the top edge trimmed 40 px so nothing spills
  above the tile. A standing or tilted tile's rectangle is fitted to its
  projected base strip (`standingRectScale` 1.2, +3 px, corner radius 0.35) and
  rotated with the base's principal axes. Both are offset 5 px right / 7 px
  down, filled at core alpha 0.60, and blurred with a separable Gaussian
  (**sigma 12 px** for lying, **5 px** for standing). The shape is published as
  `shadowShape` so a group can be composed without the per-shell sprite:
  union every placed tile's hard rectangle at full alpha, blur the union once,
  then fill it at core alpha (see *Group shadows* below). The separate sprite is
  that same shape rendered alone; the checker rasterises `shadowShape` and
  asserts it matches the sprite. Blender renders only the body; there is no
  catcher pass. `--shadow-audition` renders the REF plus A/B/C on the flat, wall
  and hand shells to `build/review/shadow-candidates.png`.

### Group shadows: merged footprint, one blur

A group of tiles cannot be assembled from the per-shell sprites without either a
seam or a double-darkened overlap. A left/middle/right tile map is exact only
where every slot has the same shadow family (a uniform pond row); the hand fan,
the wall fan and a pond's row stack all vary per slot. The group recipe instead
uses the hard shape:

1. draw every placed tile's `shadowShape` into one layer per zone at **alpha 1**
   (overlaps merge into a union, they do not add),
2. blur that layer **once** at the zone's `sigmaPx1x`,
3. draw it over the felt at `coreAlpha`, then draw every body.

That is `blur(union of footprints)`, not `max(blur(footprint))`: no seams, no
lobes, and any length. Zones are the four walls (one layer; they meet at the
corners), each pond, and each seat's hand + melds (one layer; they touch). There
is no per-length asset and no per-frame work — rebuild a zone only when one of
its tiles moves (a discard, a call, a hover lift).

Runtime options, same geometry:

- **CSS** — a positioned `<div class="shadow-layer">` containing one rounded,
  rotated `<div>` per tile, with `filter: blur(σpx); opacity: coreAlpha` on the
  parent. A CSS filter applies to the element's rendered children as one group,
  so this is exact and needs no canvas. This is the recommended path.
- **Canvas** — draw the shapes into a **mask** canvas at alpha 1, then
  `target.ctx.filter = 'blur(σpx)'; target.ctx.drawImage(mask, 0, 0)`. Do **not**
  set `ctx.filter` before each shape: canvas filters each drawing operation, so
  that is the per-tile model with source-over darkening.
- **SVG** — one `<g>` of `<rect>`s under `feGaussianBlur`.

The lab and the numbers (no Blender):

```bash
node tools/render/scripts/preview-group-shadow.mjs
python3 -m http.server 8123          # from the repo root
xdg-open http://localhost:8123/tools/render/scripts/group-shadow-lab.html
```

`preview-group-shadow.mjs` composes each zone twice and prints the alpha delta
and the worst boundary kink; the lab renders the CSS recipe live. The
headless check reports the main-thread cost (17 zones, 253 shapes, 355 bodies:
about **10–12 ms** per rebuild on the dev box), the browser blur's fidelity to
the reference Gaussian (mean **0.0028**, max **0.0277** alpha) and a screenshot
pixel check of the CSS route against the merged field (mean **0.28**, max
**3.35/255** luma). The user reviewed the lab on 2026-11-14 and approved the
merged-footprint look; this is the runtime contract for the compositor. The
per-shell shadow sprites are now only a checker reference and review asset.

### The standing-hand fan

The human's hand is a **13-tile row plus a separate drawn tile**, and each slot
has its own camera offset from the player's eye. The row is centred on the
player, so slot 06 is straight on; slots 00/12 are the outer ends. The drawn
tile sits after the +0.35 advance gap and gets its own slot.

The spec's `handSlots` block is the source of truth:

```json
"handSlots": {
  "elevationDeg": 28, "distanceUnits": 24.0, "stepUnits": 0.75,
  "rowCount": 13, "centreIndex": 6, "drawOffsetUnits": 5.5125
}
```

For each row slot:

```text
offsetUnits        = (index - 6) * 0.75
lateralOffsetUnits = -offsetUnits          # the camera sits at the player's x
angleDeg           = atan(|offsetUnits| / 24.0)
```

The drawn tile uses +5.5125 units (the 13th tile's right edge at +4.875 plus the
+0.35 × 0.75 gap). The camera is the same off-axis perspective as the walls:
azimuth 0, elevation 28, no yaw or roll; the tile is never rotated (`rotX 90`
stands it up, `rotZ 0` keeps the row upright). The 24-unit distance is a
**stylised** eye distance, not the physical seat distance: the physical distance
would make the outer face skew much stronger than the hand should read.

| Slot | Offset | Angle at d24 | Body | Body tex / Shadow tex @1x | Bytes @1x + @2x |
| --- | --- | --- | --- | --- | --- |
| 06 (centre) | 0 | 0.00° | 71 × 102 | 75 × 106 / 103 × 136 | 11,570 + 33,058 |
| 00 / 12 | ∓4.50 | 10.62° | 82 × 102 | 86 × 106 / 114 × 136 | 13,400 + 38,229 / 13,628 + 39,170 |
| drawn | +5.5125 | 12.94° | 85 × 102 | 89 × 106 / 117 × 136 | 13,933 + 39,347 |

Measured on the committed bake:

- The hand row advances by `gridStepPx.x` = **67.96**, not the advance width, so
  the outer bodies overlap their inner neighbour and the visible inner side is
  hidden in a packed hand (same as the wall). The isolated/exploded sheet shows
  the fan; the packed sheet shows the real row.
- The drawn tile is **91.75 px** centre-to-centre from the 12th tile (1.35
  steps); its inner side face fills part of the gap.
- The face is **vertical**, so the perspective trapezoid is the other way round
  from the wall: the top edge is closer to the elevated camera and is the longer
  one (58.5 px top vs 57.5 px bottom at the centre), and the left/right edges
  converge. The checker takes a `verticalFace` flag for this.
- The blue resin sliver stays on the top edge for every slot (`[3, 69, 165]` on
  the drawn slot), and the face is still the el-28 dim read (`94, 100, 107`,
  luma 99). Brightening it is a deferred lighting decision.
- Each record carries `handSlot` (`kind`, `index`, `offsetUnits`,
  `lateralOffsetUnits`, `distanceUnits`, `angleDeg`, `faceUp`). The hand is
  face-up, so the 14 slots are 14 face-variant atlas keys, i.e. 14 × 37 = 518
  sprites in Phase 2.

**The top hand** is a dedicated **13-slot standing blue-back fan**, not the flat
back-wall shells. The pose is the human hand turned around: `rotX 90`,
`rotZ 180`, `faceLocalZ: bottom`, bare. The camera is the human's eye at
**60 units**, el 28, so the outer slot is **4.29°**; the row step is 67.55 px
and the centre is 70 × 102 (74 × 106 body + 102 × 136 blob). The back is a shadowed blue
(`[0, 13, 44]` at the face centre) because the vertical back is turned away from
the key's strongest axis; it is still blue, not the bright face-down blue. It
adds no face-up atlas keys.

**Open calibration.** `--audition` moves the outer row slot and the drawn slot
to 14 / 18 / 40 units, with the committed 24 as REF, so the amount of side
reveal and face skew can be picked without rotating a tile. The centre stays
straight on.

### Straight-on ponds and melds

The ponds and called melds are **not** per-slot. They stay straight-on (azimuth
0) with one shell per body orientation (`shell_flat_upright`,
`shell_flat_sideways`), and the four seats are glyph orientations handled by the
face variants, not camera variants. The 6 × 3 pond is the most-read face; a
per-slot pond would multiply 18 positions across up to four ponds and lose the
uniform grid read. The calls/melds follow the same rule for now; a future meld
perspective is a separate task, not a pond change.

### The front/back wall slot fan

The front (bottom, human-side) and back (top) walls are not one repeated shell.
The tile straight in front of the human is straight on; the tiles away from the
centre are seen from the human's eye, so the far-right tile shows its inner left
side and the far-left tile its inner right side. The dora-indicator blank gets
the same per-slot treatment.

The spec's `wallSlots` block is the source of truth:

```json
"wallSlots": {
  "count": 17, "centreIndex": 8, "stepUnits": 0.75, "elevationDeg": 45,
  "walls": {
    "front": { "distanceUnits": 40.8, "faceRotationDeg": 0 },
    "back":  { "distanceUnits": 54.8, "faceRotationDeg": 180 }
  }
}
```

The baker and checker expand it to the ids
`shell_wall_<wall>_slot_<nn>[_faceup]`. For each slot:

```text
offsetUnits        = (index - centreIndex) * stepUnits
lateralOffsetUnits = -offsetUnits          # the camera sits at the human's x
angleDeg           = atan(|offsetUnits| / wallDistanceUnits)
```

The camera is the same off-axis perspective as the side walls (el 45, no yaw,
no roll), with the lens and lens shift solved for the 104 px long axis. The tile
is never rotated: `rotX 180` face down, `rotX 0` face up, `rotZ 0`. The front
and back distances are the physical eye distances (eye y −47.8, wall centres
y ∓7.0 on the 28 mm tile scale), so the near wall's fan is stronger.

| Slot | Offset | Front angle | Back angle | Front body | Back body |
| --- | --- | --- | --- | --- | --- |
| 08 | 0 | 0.00° | 0.00° | 73 × 102 | 72 × 102 |
| 07 / 09 | ∓0.75 | 1.05° | 0.78° | 73 × 102 | 73 × 102 |
| 06 / 10 | ∓1.50 | 2.11° | 1.57° | 73 × 102 | 74 × 102 |
| 05 / 11 | ∓2.25 | 3.16° | 2.35° | 75 × 102 | 74 × 102 |
| 04 / 12 | ∓3.00 | 4.21° | 3.13° | 77 × 102 | 75 × 102 |
| 03 / 13 | ∓3.75 | 5.25° | 3.92° | 77 × 102 | 75 × 102 |
| 02 / 14 | ∓4.50 | 6.29° | 4.69° | 78 × 102 | 76 × 102 |
| 01 / 15 | ∓5.25 | 7.33° | 5.47° | 79 × 102 | 77 × 102 |
| 00 / 16 | ∓6.00 | 8.37° | 6.25° | 81 × 102 | 78 × 102 |

Measured on the committed bake:

- The face is a trapezoid: the top/bottom pair stays horizontal, the near edge
  is longer (front outer 59.8 vs 59.2 px; back outer 59.7 vs 59.2 px), and the
  depth edges converge.
- The row advances by the physical width axis, `gridStepPx.x` = **69.72**
  (front) / **69.64** (back), not by `advanceWidth`. The outer sprites are up to
  81 / 78 px wide, so they overlap the inner neighbour by up to 11 px and the
  visible side face is occluded in a packed run — exactly as real tiles hide it.
  The isolated/exploded review sheet shows the reveal; the packed sheet shows
  the realistic wall.
- The off-axis camera makes the projected thickness drift toward the outside:
  `stackStepPx` is `(±4.06, −39.02)` at the front outer slot and
  `(±3.01, −38.9)` at the back outer slot, zero at the centre. The top tier is
  drawn at its own slot's `stackStepPx`.
- `shell_wall_back_slot_<nn>_faceup` has `faceRotationDeg: 180` so the glyph
  reads for the far player; the body is still the human's-side view. The front
  dora shells use 0. The 34 face-up dora shells are 34 atlas keys in Phase 2
  (34 × 37 faces = 1,258 sprites), so the per-slot dora cost must be measured
  against the atlas budget before it is built.
- Each record carries `wallSlot` (`wall`, `index`, `offsetUnits`,
  `lateralOffsetUnits`, `distanceUnits`, `angleDeg`, `faceUp`), so the fan is
  auditable without re-deriving it from the id.

The open calibration is the **fan strength**: `--audition` moves the outer
slot's eye to 24 / 32 / 56 units (front) and 36 / 46 / 72 (back), keeping the
lateral offset, so the amount of side reveal can be picked without rotating any
tile. The committed values are the physical distances.

### Phase 2: face glyphs and the startup atlas (landed 2026-11-15)

The runtime is `frontend/src/table/`: `tiles.ts` (face ids, the 18-shell
face-up catalogue and the `(shell, faceVariant, face)` key), `shellManifest.ts`
and `faceManifest.ts` (validating parsers), `TileAtlasBuilder.ts` (the startup
compositor) and `TileAtlas.ts` (the `Map<TileRenderKey, BakedTileSprite>` and
the single `blitTileSprite` draw call). Nothing in this directory is bundled;
the pipeline only produces the committed PNGs and manifests.

**The glyph masters.** 37 RGBA PNGs at 288 × 384 (34 standard faces + the three
red fives; blank has no asset) are rasterised from the vendored public-domain
symbol-only SVGs at pinned commit
`f37d6cc2557498d23f13eb3e955e0e44e5c863ff`. The masters are
**perspective-neutral**: one flat glyph per face, not one per shell. They total
**576,938 B** against a 1,310,720 B budget; `faces.json` records each glyph's
decoded-RGBA sha256, ink bbox/counts and upstream provenance. 288 px is 2.07x
the longest @2x face axis (185.1 px), so the atlas only ever downsamples the
master. Haku (`5z`) bakes with zero ink by design (a white dragon is a blank
face) and shares the shell's bare atlas slot.

**No carved/lit decal.** The carve → paint → light process belonged to the
retired full-scene pipeline (`rendered-table-plan.md`, retired 2026-11-13): it
recessed the symbol into a subdivided face plate, lit it once per orientation
and composited a baked decal. The active architecture replaced that with
**flat, perspective-neutral glyph masters**: the shell already carries the baked
lighting and bevel, and the glyph is colour-on-transparent ink mapped into
`faceQuad`. There is no carve geometry, no per-orientation decal render and no
specular line on the paint in Phase 2. Adding a carved or embossed treatment
later is a visual decision that needs its own spec; it is not a leftover step in
this pipeline.

**The face variants.** A variant names a perspective slot, not a camera angle:
`standing-front-00..12` + `standing-front-draw` for the 14 `shell_hand_slot_*`
shells, `flat-topdown` for `shell_flat_upright`, and `flat-rot90` for
`shell_flat_sideways` plus the 180/270 river shells. That is **18 face-up shells**,
38 face ids each, so the atlas resolves **684 keys**: 648 glyph keys + 36 bare
keys (blank and haku share
one bare slot per page). The face-down wall shells (`shell_wall_horizontal`,
`shell_wall_side_left`, `shell_wall_side_right`) are bare: no glyph, no variant,
no atlas entry.

**The startup atlas.** `TileAtlasBuilder` composes one offscreen Canvas 2D page
per face-up shell, once at init: every shell body first, then each glyph clipped
to the published `faceQuad`. A page holds 37 slots (36 inked + 1 bare) at
2048 px maximum width. Numbers from `check-faces.mjs` and the Node Canvas
review run:

| | @1x (runtime default) | @2x (opt-in) |
| :--- | :--- | :--- |
| Pages | 18 | 18 |
| Pixels | 7,929,168 | 27,575,784 |
| RGBA | **30.25 MiB** | **105.19 MiB** |
| Build (Node Canvas) | ~33–44 ms for all 16 | ~12 ms for one hand page |

The loader defaults to @1x and refuses an @2x atlas above `maxRgbaBytes`
(48 MiB), because an all-@2x atlas costs 105 MiB of decoded canvas. @2x remains
available (`pixelRatio: 2`) for a single-shell preview or a device with the
memory headroom. The 34 per-slot dora shells are the next face-variant family
(§10.5 of the architecture); they would add 14,424,056 px / 55.02 MiB at @1x
and are deliberately **not** built by this task.

**Glyph rotation.** `faceQuad` is published in face-local corner order, so
mapping the glyph's corners onto it already applies the shell's rotation:
`shell_flat_sideways`'s first edge points up the screen, which is the 90°
counter-clockwise read. `faceRotationDeg` is the *desired on-screen* rotation,
and `glyphRotationDegFor` subtracts the quad's own rotation to get the extra
in-plate rotation. It is 0 for every Phase 2 shell; the follow-up dora families
need 180 (back wall) and 270 (side wall) and the builder already implements
that path. The builder clips to the quad and fits an affine to three corners,
so the small trapezoid keystone on the perspective hand faces is clipped inside
the plate rather than spilling onto the bevel.

**Budgets (measured).** Committed table assets are **7,500,843 B** of the 8 MiB
total limit (shells 5,765,417 + `shells.json` 571,609 + felt 559,465 + glyphs
576,938 + `faces.json` 27,414), leaving ~1.0 MB. A full board's @1x bodies +
felt + both manifests + glyphs is **2,658,858 B** of the 4 MiB initial-load
limit; the atlas is composed locally from those requests, not downloaded.

**Review.** `cd frontend && npm run atlas:review` builds the real atlas with
Node Canvas and writes under `tools/render/build/review/`:
`atlas-variants-1x.png` (the three variants, every face, at discard size),
`atlas-all-faces-1x.png`, one sheet per shell, `atlas-hand-06-2x.png` (the
crispness check), and `atlas-numbers.json`. Those are evidence for the user;
the agent does not sign off its own render (AGENTS.md §6).
`node tools/render/scripts/check-faces.mjs` is the CI gate: glyph hashes and
ink, red fives, haku zero ink, transparent corners, the byte budgets and the
atlas page plan.

### Phase 2b: carved face decals (spike + lying tuner, 2026-11-15)

The picked direction is **option A**: restore only the retired pipeline's
carve → paint → light decal, as a **transparent carve/paint overlay** pasted
into the current shells' `faceQuad`. The shell keeps its own lighting and face
colour outside the recessed lip. The **full upstream 300 × 400 glyph canvas** is
mapped onto the inset face plate, matching the flat glyph's sizing; the earlier
faceInset UV crop enlarged every symbol and cut the pinzu/manzu strokes that
reach the canvas edge. The symbol stays upright in face-local space;
the four images per face are four baked **light rotations** (`0/90/180/270`),
chosen so the light lands top-left on screen after the shell's quad rotation.
There is no per-slot fanning: a decal is shared by every slot with the same
light rotation.

**Two light rigs.** `decal-spec.json` has separate `lighting.upright` (the
approved parlour rig for the standing hand) and `lighting.lying` (the tunable
rig for flat/pond tiles). `surfaceRotations` bakes one upright rotation (`0`)
and four lying rotations (`0/90/180/270`). The upright rig is not touched by the
lying tuner.

**The lying tuner.** `cd frontend && npm run tune:carved` starts a local app at
`http://localhost:7458` (set `HOST=0.0.0.0` to use it from a phone on the
tailnet). It writes a temporary decal spec, runs the real Blender baker for the
`1m` face with the lying rig at four light rotations, and composites each result
onto the real, properly rotated river shell at @2x. A preview takes about
**3 s** (48 samples, carve grid 0.6, AO 4). "Apply lying params" writes only
`lighting.lying` (and the shared carve controls) back to `decal-spec.json`.

The four previews are the four discard rivers, one shell each:

| Panel | Shell | Tile |
| --- | --- | --- |
| bottom river · 0° | `shell_flat_upright` | 0° |
| right river · 90° | `shell_flat_sideways` | 90° |
| top river · 180° | `shell_flat_upright_180` | 180° |
| left river · 270° | `shell_flat_sideways_270` | 270° |

The shell bodies are rendered once by the existing shell baker with the
existing shell/table lighting; the sliders never touch them. The decal rig is
defined in the **face-normal frame** (`frame: "face-normal"`): `aroundDeg`
rotates the light around the tile's face normal (0 = tile-up, 90 = right,
180 = down, 270 = left) and `tiltDeg` is the angle from the normal (0 =
head-on, 90 = grazing, 180 = behind). The atlas adds `-quadRotation` so the
room light stays fixed while the tile turns. Rotating around the face normal
(not world Z) is what keeps all four orientations equally lit; a world-Z
rotation sends the key behind the vertical decal face at 90/180 and makes those
carvings read flat.

The baker is `bake_decals.py` + `decal-spec.json`; it imports the current shell
baker's tile/material/render helpers and ports the retired carve math
(`alpha_to_distance`, `bezier_profile`, `build_carved_face`). The carve
parameters are unchanged from the retired pipeline (commit `e39d92e`). The
upright parlour rig is translated from its original hand slot at y=-11.7 to the
canonical face; the lying rig is expressed in the face-normal frame so it reads
as room light on a horizontal tile.

```bash
bash tools/render/bake-decals.sh --dry-run   # print the plan
bash tools/render/bake-decals.sh --spike     # 4 faces x upright 1 + lying 4 -> build/decals
bash tools/render/bake-decals.sh --build     # every inked face, both surfaces -> build/decals
bash tools/render/bake-decals.sh --bake      # PNG bake, encode AVIF, commit decals.json, check
bash tools/render/bake-decals.sh --check     # validate build/decals.json (needs Node Canvas)
bash tools/render/bake-decals.sh --check-committed
cd tools/render && npm run decals:encode     # re-encode the PNG bake to AVIF q60
cd frontend && npm run tune:carved           # lying-rig tuner
cd frontend && npm run atlas:review:carved   # flat vs carved review sheets
```

**Spike (measured).** 4 faces (`1m`, `5p`, `7z`, `5mr`) × (1 upright + 4 lying)
= **20 decals at 158 × 216** (150 × 208 face plate + a 4 px transparent safety
ring), **926,272 B** PNG, ~1 min wall on the dev box. Each decal is 34–62 KB
PNG, 18–66% transparent, with its four corners transparent.
`check-decals.mjs` reports 410 checks on the spike.

**Full set (committed).** `5z` (haku) has no ink and is skipped: 36 faces × 5
surface rotations = **180 decals** (36 upright + 144 lying). The full PNG bake
is **8,319,064 B**; the shipped set is **AVIF q60 with alpha**, **1,581,494 B**
across 180 files, plus `decals.json` (189,282 B). The manifest keeps the decode
measurements and decoded-RGBA sha256 for every encoded image. AVIF q60 was
chosen over WebP (2.4 MB) to fit the budget without touching the decal size or
the flat fallback.

The redundant **@2x shadow sprites** were removed to make room: the runtime
already draws group shadows from `shadowShape` (§10.12), and the @1x shadow
sprites remain the checker/review reference. Committed table assets are
**7,839,428 B (7.48 MiB)** of the 8 MiB limit; a decal-based initial @1x board
is **3,834,658 B (3.66 MiB)** of the 4 MiB limit (the flat glyph PNGs remain
build/fallback assets and are not fetched when decals cover every inked face).
Byte budgets are **advisory during active development** (AGENTS.md §1c); they
are measured, not a reason to shrink the art.

**Runtime.** `frontend/src/table/decalManifest.ts` parses `decals.json` with a
key of `${face}:${surface}:l${light}:s${symbol}`. `TileAtlasBuilder` selects the
surface from the shell (`upright` for the 14 hand slots, `lying` for
`shell_flat_upright`, `shell_flat_sideways`, `shell_flat_upright_180` and
`shell_flat_sideways_270`), picks
`lightRotationDeg = -screenRotationOfQuad(faceQuad)` and
`symbolRotationDeg = faceRotationDeg - quadRotation`, loads the decal instead of
the flat glyph, and still composites one `BakedTileSprite` per
`(shell, variant, face)`. Missing decals fall back to the flat glyph (tests and
the spike); `requireDecals: true` makes a missing decal a hard error. No
per-frame compositing.

**Review.** `cd frontend && npm run atlas:review:carved` writes under
`tools/render/build/review/`:
`carved-compare-4x.png` (four faces, flat vs carved, 4×),
`carved-variants-1x.png`, `carved-hand-fan-1x.png`, and
`carved-numbers.json`. The lying tuner writes its four previews under
`tools/render/build/tune/preview/`. These are evidence for the user, not for the
agent to sign off (AGENTS.md §6).

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
      "shadowTextureFile": "shells/shell_flat_upright-shadow.png",
      "shadowTexWidth": 160,
      "shadowTexHeight": 162,
      "shadowAnchorX": 38,
      "shadowAnchorY": 6,
      "shadowOffsetPx": [0, 0],
      "shadowPadding": { "top": 6, "right": 50, "bottom": 54, "left": 38 },
      "texWidth": 76,
      "texHeight": 106,
      "anchorX": 2,
      "anchorY": 2,
      "advanceWidth": 72,
      "advanceHeight": 102,
      "padding": { "top": 2, "right": 2, "bottom": 2, "left": 2 },
      "shadowBlob": { "model": "blob", "shape": "rounded-rect", "sigmaPx1x": 12, "standingSigmaPx1x": 5, "coreAlpha": 0.6, "offsetPx1x": [5, 7], "rectScale": 1.15, "rectPaddingPx1x": 8, "cornerRadiusFraction": 0.3, "topTrimPx1x": 40, "colorHex": "#0b1418", "lying": true },
      "shadowShape": {
        "model": "hard-rounded-rect",
        "space": "centrePx/halfPx/radiusPx are @1x px relative to the tile's grid anchor (the body-box left/top); rotate by angleDeg about centrePx",
        "centrePx": [41, 78],
        "halfPx": [49.4, 46.65],
        "radiusPx": 13.995,
        "angleDeg": 0,
        "sigmaPx1x": 12,
        "coreAlpha": 0.6,
        "colorHex": "#0b1418",
        "lying": true
      },
      "faceRotationDeg": 0,
      "faceQuad": [[8.39, 4.6], [67.61, 4.6], [67.61, 62.84], [8.39, 62.84]],
      "faceQuadOrder": "face-local [top-left, top-right, bottom-right, bottom-left]",
      "gridStepPx": { "x": [69.4, 0], "y": [0, 65.44] },
      "projection": "low-angle-top-down",
      "pose": { "rotateXDeg": 0, "rotateYDeg": 0, "rotateZDeg": 0 },
      "camera": { "azimuthDeg": 0, "elevationDeg": 45, "projection": "orthographic", "orthoScale": 1.642469, "pixelsPerUnit2x": 185.087201, "resolution1x": [118, 152], "resolution2x": [236, 304] },
      "measured": {
        "alphaExtent1x": { "left": 33, "top": 0, "right": 43, "bottom": 48 },
        "alphaPeak1x": { "left": 0.4392, "top": 0.0, "right": 0.5569, "bottom": 0.5843 },
        "alphaMass1x": { "left": 398.114, "top": 0.0, "right": 755.722, "bottom": 956.984 },
        "shadowMaxAlpha": 0.6,
        "contactQuadPx": [[39.3, 109.0], [39.3, 43.56], [108.7, 109.0], [108.7, 43.56]],
        "solidInset1x": [1, 1, 1, 1],
        "faceSampleRgb": [223, 220, 216],
        "edgeSamplesRgb": { "top": [223, 220, 217], "bottom": [0, 8, 31] },
        "bytes1x": 14242,
        "bytes2x": 37739
      },
      "sha256": { "decodedRgba1x": "…", "decodedRgba2x": "…" },
      "shadowSha256": { "decodedRgba1x": "…", "decodedRgba2x": "…" }
    }
  }
}
```

Fields the runtime and the checker rely on:

- `textureFile` / `textureFile2x` — the @1x and @2x **body** PNGs, both under `shells/`.
- `shadowTextureFile` — the @1x **blob** reference sprite (the @2x shadow sprite
  was removed; the runtime uses `shadowShape`). It has its own, larger box and
  anchor (`shadowTexWidth/Height`,
  `shadowAnchorX/Y`, `shadowPadding`). `shadowOffsetPx` is `[0,0]`;
  `shadowBlob` records the model, sigma, core alpha, offset and whether the tile
  is lying (rounded rect covers the body, top edge trimmed) or standing (rounded
  rect fitted to the base strip). `shadowShape` is the derived **hard** shape for
  the group recipe: a rotated rounded rectangle in @1x px relative to the tile's
  grid anchor (`centrePx`, `halfPx`, `radiusPx`, `angleDeg`) plus the blur and
  fill (`sigmaPx1x`, `coreAlpha`, `colorHex`). Draw every placed tile's shape at
  full alpha into one layer per zone, blur the layer once at `sigmaPx1x`, draw it
  at `coreAlpha`, then draw the bodies. That is `blur(union)`, so it is exact for
  a fan, a shrinking wall and a ragged pond; the per-shell sprite is the same
  shape rendered alone. The checker rasterises `shadowShape` and asserts it
  matches `shadowTextureFile` (max alpha delta ≤ 0.02).
- `texWidth`/`texHeight` — the @1x PNG size. The @2x PNG is exactly twice that.
- `anchorX`/`anchorY` — the top-left of the opaque body box in @1x px. They are
  equal to `padding.left`/`padding.top`, and `anchor + advance + padding` equals
  the texture size on both axes.
- `advanceWidth`/`advanceHeight` — the opaque body box used for spacing and
  hit-testing. It *includes a one-pixel anti-aliased edge ledge* on each side;
  `measured.solidInset1x` is `[1,1,1,1]`, i.e. the alpha ≥ 0.5 silhouette is
  exactly 1 px inside the declared box. Without that ledge an anti-aliased
  0.4-alpha silhouette pixel would be indistinguishable from the blob's soft
  fringe and the body box could not be measured.
- `gridStepPx.x` / `gridStepPx.y` — **use these for a tight grid**, not the
  advance box. They are the projected tile width/height axes (face-local X and
  Y) in @1x px, each oriented so a vector points right when that axis is more
  horizontal or down when it is more vertical. A pond row steps by the axis that
  points right; a vertical run (a hand, a pond row of rows, a wall column) steps
  by the axis that points down. For the side walls the short *width* axis is the
  column step, so it is `gridStepPx.x`, not `.y`; always pick the axis whose
  published vector points down the screen. For the front/back wall row, step by
  `gridStepPx.x` (the 69.7 px width axis), **not** `advanceWidth`: the outer
  slots' bodies are wider because they include the visible inner side. The hand
  row is the same: step by `gridStepPx.x` (67.96 px), not the 71–85 px advance
  width, and add the drawn tile at its own +5.5125-unit offset.
- `stackCount` / `stackStepPx` — wall shells only. A wall column is two tiles;
  `stackCount` is 2 and `stackStepPx` is the vector from the lower tier's body
  top-left to the upper tier's, i.e. the projected tile **thickness** (straight
  up on screen). It is not the face grid step. Draw the lower tier first, then
  the upper tier at `+stackStepPx`; the upper tier is the same face-down shell,
  or the face-up dora counterpart when the indicator is revealed.
- `faceQuad` — the visible face plate inset by `faceInset`, four corners in
  `faceQuadOrder` (the tile face's own top-left, top-right, bottom-right,
  bottom-left). The runtime rotates the glyph by `faceRotationDeg` (90 for
  `shell_flat_sideways`, 180 for the back-wall dora slots) and maps the glyph's
  corners onto these. Orthographic quads are parallelograms; perspective quads
  are trapezoids, so the compositor maps the glyph projectively. A horizontal
  wall face has its lower edge longer; the vertical standing-hand face has its
  top edge longer.
- `measured` — the numbers the checker re-derives from the committed PNG:
  nonzero-alpha extent/peak/mass per padded side, the three structural colour
  samples, the body inset, and the byte counts.
- `sha256.decodedRgba1x/2x` — the sha256 of the *decoded* RGBA buffer, not the
  PNG container bytes. Re-baking the same spec must reproduce them; a
  hand-edited PNG fails the check.
- `camera.projection` — `"orthographic"` for the grid shells, or
  `"perspective"` for the four side-wall shells, the 68 front/back wall slots,
  the 14 human-hand slots and the 13 top-hand slots. A perspective record also carries `lensMm`, `shiftX`,
  `shiftY`, `lateralOffsetUnits` and `distanceUnits`; an orthographic one carries
  `orthoScale`. The tile is never yawed: the camera sits inside the wall (or at
  the human's x for a wall/hand slot), so the projected face is a trapezoid.
  The table-parallel edge pair stays horizontal and the near edge is longer (the
  lower edge for a horizontal wall face, the upper edge for the vertical hand
  face); the depth-direction pair converges.
- `wallSlot` — present only on the front/back slot shells. It records `wall`
  (`front`/`back`), the 0–16 `index`, `offsetUnits`, `lateralOffsetUnits`,
  `distanceUnits`, `angleDeg` and `faceUp`. It is the audit trail for the fan and
  lets the checker prove the slot and camera cannot drift from `wallSlots`.
- `handSlot` — present only on the 14 human-hand slots. It records `kind`
  (`row`/`draw`), `index`, `offsetUnits`, `lateralOffsetUnits`, `distanceUnits`,
  `angleDeg` and `faceUp`; it does the same for `handSlots`.
- `topHandSlot` — present only on the 13 top-hand slots. It records the same
  fields with `kind: "top"` and `faceUp: false`; the shells are standing blue
  backs (`rotX 90`, `rotZ 180`, `faceLocalZ: bottom`) and bare.
- `faceUp` — a boolean on every record (`camera.faceLocalZ === "top"`). It is
  the authoritative glyph/blue-back switch; the top-hand and wall slot records
  are face down.
- The body + shadow pair is the draw contract: place the shadow at
  `grid - shadowAnchor` into the union layer, place the body at `grid - anchor`,
  and draw the union layer before the bodies. The atlas composites glyphs into
  the body only.
- `rig` — Blender version, engine/device/samples/seed, colour management, the
  key's screen-space direction, the blob contract, the 2-tile stack, the
  target long-axis size, and each shell's framing. It is the audit trail for a
  bake.

The check enforces: every body and shadow path exists and decodes as 8-bit RGBA;
the PNG sizes match (with the @2x exactly twice the @1x); the declared padding matches the
spec and the anchor; the opaque body is inset exactly 1 px; the faceQuad is a
convex quad inside the body with an oblique-plausible aspect (a parallelogram
for the orthographic shells, a trapezoid for the perspective ones, with one
table-parallel edge pair, a longer near edge and converging depth edges);
`gridStepPx` follows from the faceQuad; `stackStepPx` is present on exactly the
wall shells and matches the projected thickness within 1.5 px (2.5 px on the
perspective shells); the slot metadata follows `wallSlots`; the blob extents and
peaks stay in the contract, its outer shadow ring has no light moat at the
contact, its maximum adjacent alpha step is <= 0.12, and the shadow points
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

## Review history, the side walls and the front/back fan

The Phase 1b review doubled the base scale — the Phase 1 `@2x` output is the new
`@1x` base, `bake.targetLongAxisPx1x` is **104** (was 52) and the new `@2x` is
**208**, so the board coordinate space doubles and every consumer reads the new
`shells.json`. It also picked the cameras: the hand at 28°, the upright pond and
the top/bottom wall at 45°, the sideways shell at 45°, and the side walls at 45°
with the camera slightly inside the wall. The pick added the 2-tile stack, the
face-up dora shells and the diffuse contact shadow; all of that is in the
committed bake above and in §10 of the architecture doc.

The side-wall camera is **settled**: the tile stays parallel to the table edge,
and the camera sits 2 units inside the wall at distance 10 (11.3°), with no yaw
and no roll. Measured on the committed shell the near long edge is 84.0 px
against the far 81.3 px, and the far edge sits 7.5 px toward the centre. The
user approved keeping the side walls as they are.

The **front/back wall fan is approved**: the tile straight in front of the human
is straight on; the outer slots show their inner side as the human's eye sees
them. The committed fan uses the physical eye distances (front 40.8, back 54.8
units; outer angles 8.37° / 6.25°). The ponds and melds are confirmed
straight-on.

The **standing-hand fan is approved** at the committed 24-unit eye distance
(outer row 10.62°, drawn 12.94°); the 14 / 18 / 40-unit audition is kept for
reference. The remaining visual is the **shadow shape/falloff**. `--audition`
still renders the hand candidates if needed:

```bash
bash tools/render/bake-shells.sh --audition                    # + sheets + validation
bash tools/render/bake-shells.sh --check-audition              # no Blender
```

Each candidate is the outer row slot or drawn slot with its lateral offset fixed
and the eye distance varied; the sheet shows a packed six-tile row plus an
isolated tile (the isolated tile shows the full side reveal and face skew). The
committed reference is 24 units. The output is gitignored:

| Path | Contents |
| --- | --- |
| `build/review/candidates/{1x,2x}/` | candidate textures |
| `build/review/shell-candidates.json` | candidate records (same shape as `shells.json`, plus `candidate`) |
| `build/review/shell-candidates-shell_wall_front_slot_16.png` | 3 eye distances + REF, front outer slot |
| `build/review/shell-candidates-shell_wall_back_slot_16.png` | 3 eye distances + REF, back outer slot |
| `build/review/shell-candidates-shell_hand_slot_12.png` | 3 hand eye distances + REF, outer row slot |
| `build/review/shell-candidates-shell_hand_slot_draw.png` | 3 hand eye distances + REF, drawn slot |
| `build/review/wall-stack-1x.png` | packed front/back 17-stack runs + side-wall columns |
| `build/review/wall-fan-1x.png` | exploded front/back fans, both halves, every slot numbered |
| `build/review/hand-stack-1x.png` | packed 13-tile hand + drawn tile + top hand |
| `build/review/hand-fan-1x.png` | exploded hand fan + top hand, every slot numbered |
| `build/review/hand-right-zoom3x.png` | 3x zoom of the hand right end |
| `build/review/hand-fan-right-zoom3x.png` | 3x zoom of the exploded right end |
| `build/review/wall-fan-front-right-zoom3x.png` | 3x zoom of the front right end |
| `build/review/wall-fan-back-right-zoom3x.png` | 3x zoom of the back right end |

`check-shells.mjs --audition` keeps the committed checks and adds the candidate
ones (both scales, the base long axis, the blob contract, the perspective
trapezoid, `faceQuad` and `gridStepPx`, `stackStepPx`, hashes) plus the sheets'
printed-text and composited-tile pixel checks; the full run reports **8,057
checks**. The committed bake alone reports **7,592** (including the review-sheet
pixels when the sheets are present and the `shadowShape` raster check on every
shell).

## The Blender shell rules

The shell scene follows the architecture, not the retired pipeline:

- **Orthographic cameras for the grid shells**, so parallel edges stay parallel.
  The walls and the standing hand are the exception: the side walls, every
  front/back slot and every hand slot use an off-axis **perspective** camera
  with no yaw and no roll. The side-wall camera sits inside the wall (§10.4); the
  wall/hand slots sit at the human's x for that slot (§10.8, §10.9). The tile
  stays square to the table while the near face shows; the hand's vertical face
  has its top edge longer, the wall's horizontal face its lower edge.
- **One locked key at top-left-front plus a weak ambient fill.** The key's
  authored azimuth/elevation (315° / 55°) is decomposed once in a
  front-elevation camera's basis; every shell then re-expresses the same
  `(−0.406, +0.819, +0.406)` screen-space direction in its own camera basis. That
  is why a top-down shell and a front-elevation shell both get their highlights
  top-left and their shadow bottom-right. The tuned values are 3200 W for the
  key and a `#3b4a5c` world at strength 1.0 (the Phase 0 numbers were a starting
  point that produced a near-black shadow side).
- **Blob shadow generated in Python, not Blender**: one render per shell per
  scale (the tile on transparent film). The shadow is the projected
  table-contact footprint, fitted to a rounded rectangle (the body box when lying,
  the base strip when standing), offset down-right, Gaussian-blurred and written to
  its own sprite plus the hard `shadowShape`. A 1 px frame
  ramp guarantees nothing clips at the texture border. There is no
  shadow-catcher plane and no AO fringe.
- **Two-tone resin seam** visible along the top and side bevels: a white
  melamine face plate on a blue melamine backing, one material, split on local
  Z. This is what reads as a physical tile rather than a flat card.
- **Blank faces.** Shells carry no symbol. The runtime composites the 2D face
  glyph into `faceQuad`.
- **Integrity**: CPU Cycles, fixed seed 0, fixed adaptive threshold, OIDN. The
  committed manifest records the sha256 of each texture's decoded RGBA. A
  re-render comparison is available as the optional `--verify-determinism`
  diagnostic; it is not required for a bake.

## What the check prints

`scripts/check-shells.mjs` is the scripted verification. It prints per-fact
`PASS`/`FAIL` lines and numeric `INFO` lines. On the committed bake:

```text
INFO felt luma centre 68.79, corners 24.29, ratio 2.831, stdDev 0.49
INFO felt edges L/R 35.61/35.52 T/B 41.66/40.44
PASS felt is 559465 B (budget 1572864 B)
PASS vignette centre/corner luma ratio is 2.831 (>= 1.5)
PASS left/right edge symmetry is 0.272% (<= 6%)
PASS shell_hand_slot_12 perspective keystone has the near edge longer (58.5 > 57.5 px)
PASS shell_hand_slot_12 handSlot offset 4.5 follows from handSlots (4.5)
PASS shell_hand_slot_draw handSlot kind is row/draw (draw)
PASS shell_hand_slot_draw top edge carries the blue resin sliver (3,69,165)
PASS shell_wall_front_slot_16 camera sits at the human's x (lateral -6.0 = -offset)
PASS hand-fan-1x.png composites its tiles (284486 px)
INFO shell textures total 4425492 B across 107 shells and 2 scales
OK 7710 checks passed
```

`--audition` additionally validates the hand fan calibration and its sheets; on
the current output it reports `OK 8,057 checks passed` on the last candidate
matrix (the committed checks plus the candidate and sheet checks; a re-run adds
the `shadowShape` checks). The committed-only run is 7,592.


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
xdg-open tools/render/build/review/shells-row-1x.png      # the twelve base shells, catalogue order
xdg-open tools/render/build/review/discard-row-1x.png     # 6-tile row + isolated + riichi
xdg-open tools/render/build/review/hand-stack-1x.png      # packed hand row + drawn tile + top hand
xdg-open tools/render/build/review/hand-fan-1x.png        # exploded hand fan + top hand, numbered
xdg-open tools/render/build/review/hand-fan-right-zoom3x.png
xdg-open tools/render/build/review/wall-stack-1x.png      # packed 17-stack front/back walls + side walls
xdg-open tools/render/build/review/wall-fan-1x.png        # exploded front/back fans, every slot numbered
xdg-open tools/render/build/review/wall-fan-front-right-zoom3x.png  # front right-end reveal
xdg-open tools/render/build/review/wall-fan-back-right-zoom3x.png   # back right-end reveal
xdg-open tools/render/build/review/shell-candidates-shell_wall_front_slot_16.png
xdg-open tools/render/build/review/shell-candidates-shell_wall_back_slot_16.png
xdg-open tools/render/build/review/each-4x-shell_flat_upright.png
ls tools/render/build/review/each-4x-*.png                # the nine base shells at 4x
```

The review sheets are throwaway: `build/` is gitignored. They are drawn on the
felt's base colour (`#1a5038`) so shadow contrast is easy to see, with the
manifest's own `gridStepPx` and draw order (uniform pond rows right-to-left;
per-slot hand/wall fans outermost-to-innermost, centre last; wall bottom tier
before the top tier). The script prints the seam numbers too: on the committed
bake the neighbour's face edge reads 210.1 against its interior 220.3 (that
difference is the body's own bevel shading; the shadow union sits under the
bodies and does not touch the neighbour's face), and the isolated tile's shadow
reads 54.6 against bare felt 66.8. The blob strength is still a visual call for
the user.

To review the Phase 2 glyphs and the startup atlas, build the real atlas and
open the sheets (they are gitignored review output):

```bash
cd frontend && npm run atlas:review
xdg-open ../tools/render/build/review/atlas-variants-1x.png   # the three variants at discard size
xdg-open ../tools/render/build/review/atlas-all-faces-1x.png  # all 16 shells
xdg-open ../tools/render/build/review/atlas-shell_hand_slot_06-2x.png
node ../tools/render/scripts/check-faces.mjs                  # the numbers
```

`atlas-numbers.json` in the same directory has every page's pixels and RGBA
bytes. The question for the user is whether the glyphs are crisp and legible at
discard size on each variant, whether the sideways `flat-rot90` read is right,
and whether the hand glyphs sit correctly inside the face plate. Compare against
the stacked/top-down views, not against another agent-generated screenshot.

To review the blob softness/opacity/offset, run `--shadow-audition` (above) and
open `build/review/shadow-candidates.png`. It shows the REF row plus A/B/C, each
with a flat discard run and an isolated tile, a wall stack and a hand run; the
labels print sigma/core alpha/offset and the seam/drop luma, and every row unions
its shadows under the bodies. The committed REF is sigma 12 px / core 0.60 /
offset 5,7 for the rounded rect (standing sigma 5).

To review the approved hand fan, run `--audition` (above) and open the two
sheets:

```bash
xdg-open tools/render/build/review/shell-candidates-shell_hand_slot_12.png
xdg-open tools/render/build/review/shell-candidates-shell_hand_slot_draw.png
xdg-open tools/render/build/review/shadow-candidates.png
```

Each sheet has a header with the shell id, the base size and the question it
asks, then one row per candidate (14 / 18 / 40 units) plus a `REF COMMITTED`
row at 24 units. Every row is a packed six-tile run plus an isolated tile, so
the isolated tile shows the full side reveal and face skew; the labels print the
camera, texture, body, projected face, eye distance and byte numbers. The sheet
is a review artefact: it is not the layout engine.

The runtime layout engine is `frontend/src/table/zoneLayout.ts` (Phase 3). Its
test imports `group-layouts.mjs` and asserts that the engine reproduces the
reference placements exactly, so the two cannot drift. To build the layout
review sheet and its numbers:

```bash
cd frontend && npm run layout:review
xdg-open ../tools/render/build/review/zone-layouts-1x.png
xdg-open ../tools/render/build/review/pond-layout-bodies-1x.png
cat ../tools/render/build/review/zone-layout-numbers.json
```

The **Phase 3.5 contact shadows** have their own composed review:

```bash
cd frontend && npm run overlays:review
xdg-open ../tools/render/build/review/pond-layouts-1x.png        # the sign-off sheet
xdg-open ../tools/render/build/review/overlay-zones-1x.png
xdg-open ../tools/render/build/review/overlay-decals-1x.png
cat ../tools/render/build/review/overlay-numbers.json
```

The sheet is real art (the @1x atlas and the face-down shell PNGs) at 1:1, with
the zones normalised to `(0, 0)`. It is evidence for the user's eyes; the script
prints the facts: fractional draw positions (must be 0), the face-anchor error,
and hit boxes that are not the published advance box (must be 0).
`pond-layout-bodies-1x.png` is the bodies-only four-seat pond sheet: the same 24
discards and the row-2/column-4 riichi as the bottom, right, top and left ponds,
each with its own normal/turned shells and frame. The bodies are drawn furthest
depth line first and right-to-left within a line; a turned riichi tile stays
centred on its discard-row line. The left/right ponds also carry the 1°
whole-zone lean (right −1°, left +1°) about the near body edge, drawn as one
group transform; the JSON `ponds` block records every seat's size, step deltas,
first/last body, lean pivot and rotation, and riichi body. The **composed**
four-pond sheet with the group shadow and the contact decals is
`pond-layouts-1x.png`, written by `npm run overlays:review` (below).

State the numbers the check already verified, then ask the user the questions
only they can answer: does the hand fan read at 24 units, or does it need the
14/18/40 alternatives; is the drawn tile still the same tile type; is the
standing hand's dimmer face acceptable next to the pond; is the packed hand row
with the drawn gap the right read? Compare decoded pixels, not PNG container
bytes: zlib can change the container while the image is identical.

## Phase 3.5: contact shadows (tile-to-tile)

The group shadow is one blur per zone **under** the bodies (§10.12), so it cannot
darken a neighbour's face where two tiles touch. Phase 3.5 adds a per-shell,
per-screen-side **contact-shadow decal**. It is 2D (PNG plus draw order), no
WebGL and no per-frame lighting, and the group recipe is unchanged.

- **What is baked:** `frontend/public/table/overlays/<shell>--<side>.png` and
  `overlays/2x/`, plus `frontend/public/table/overlays.json`. A decal is an
  outward half-Gaussian from the caster body's opaque contour
  (`alpha(d) = coreAlpha * exp(-0.5 (d/sigma)^2)`), zero inside the body and
  beyond `3σ`, faded at both tangential ends. The contour is fitted to a smooth
  line along the tangent (local smoothing fallback for a curved edge), because a
  per-row band on the bevel staircase produced horizontal steps on the
  neighbouring face; the fill still starts at the true contour. Committed: `coreAlpha 0.35`,
  `σ 6 px lying / 4 px standing`, fade 16 px, ink `#0b1418`. It is baked from
  the committed shell PNG alpha, **not** from `shadowShape` (the blob is 1.15×
  the body with a 40 px top trim and a 5/7 offset, so it would smear).
- **Which decals exist:** `cd frontend && npm run overlays:export -- --sides`
  runs every supported composition (5,877 zones) and writes
  `build/overlays-sides.json`; `bake_overlays.mjs` bakes exactly that
  `(shell, side)` set, filtered by `overlay.enabledFamilies`. The synthetic
  bands are now only the fallback for a pair without a 3-D catch: the human
  hand, top hand, side hands, ponds, melds and walls all use the catches below.
  The 13 synthetic hand bands (35,780 B) keep their `right` side override
  (σ 2.5 px / α 0.50).
- **Where they go:** `frontend/src/table/contactOverlays.ts` derives contacts
  from the Phase 3 painter order. For each earlier body A and later caster B,
  each B edge inside A's advance box with at least 4 px of overlap is a
  contact. The decal is drawn after A's body and before B's body, inside the
  zone's one transform, so the side ponds' 1° lean carries it automatically.
- **How it stays off the felt:** the compositor clips each decal to the
  neighbour's `bodyQuads` polygon (an inset hull in `overlays.json`), not to the
  advance box: an oblique side-wall or standing-hand body does not fill its box.
- **Checks:** `node tools/render/scripts/check-overlays.mjs` runs **1,116**
  dependency-free checks (synthetic asset alpha/hash/shape, 3D catch size/hash/
  alpha/zero-outside-target, tangential visible-band smoothness for the
  fallback, clip coverage, and a decoded-pixel composition over the real felt).
  Every zone changes **0 felt pixels**; the four ponds stay unshadowed (0
  overlays, 0 changes); the human hand's 12 catches are drawn with mean Δluma
  15.41, the top hand 5.75 and the side hands 6.83/1.77. The §10.12 seam kink
  stays below 0.05.
- **Fixture:** `tools/render/overlay-zones.json` is committed and regenerated by
  `npm run overlays:export -- --fixture`; `contactOverlays.test.ts` asserts the
  layout reproduces it and that every contact in the full stress matrix has a
  catch or a fallback decal.
- **3D catches:** `bash tools/render/bake-hand-catches.sh` bakes one
  **target-space** catch per covered **standing** hand slot: 12 human-hand
  slots, 12 top-hand slots (all excluding the centre 06), and one per side hand
  (the same shell reused down its row; the catch is reused for every interior
  position, and the row direction is verified against the committed
  `gridStepPx`). The target is at the origin, the adjacent caster one 0.75-unit
  step away and the target's published camera. The reference crop is
  byte-identical to the committed target body, so the pair geometry is exact.
  It combines the physical key/world shadow and a contact-AO pass
  (`physical+ao`); the current bake is **26 catches, 109,321 B** at 1x/2x.
  The hidden caster is then translated so its **projected contact edge** lands
  on the committed caster sprite's body edge. The per-slot caster sprite is
  normalised for its own camera; under the target camera its physical edge sat
  up to ~3 px inside the drawn edge and left a bright unshadowed sliver on the
  target's visible side (most visible on the right half of the hand). This is
  a catch alignment fix, not a layout-spacing change.
  `frontend/public/table/catches.json` publishes `target:caster` records; the
  compositor draws one at the target's `drawX/drawY`, after the target body and
  before the caster body, clipped to the target's **full advance box**. Do not
  use the synthetic bands' inset `bodyQuads` hull for a catch: its alpha is
  already masked to the target's opaque body, and the inset clips the bevel at
  the body edge, leaving a bright sliver on the target's bottom/side face.
  `contactOverlays.ts` prefers a catch, skips farther same-shell contacts (the
  side hand's L) and falls back to a synthetic band only when no catch exists.
- **Review:** `npm run overlays:review` writes `hand-layouts-1x.png` (the
  active sign-off: 1:1 hand plus left/centre/right seam crops with and without
  the catches), `overlay-decals-1x.png` (the 12 catches), `pond-layouts-1x.png`
  (the disabled baseline) and `overlay-zones-1x.png`. Visual sign-off is the
  user's (AGENTS.md §6).

## Lying-family catch samples (build-only)

The hand catches are proven; the lying families are sampled before a mass bake.
`bash tools/render/bake-lying-samples.sh` builds two samples from the real
layout (`frontend/scripts/export-lying-samples.ts`) and renders them with the
target's published camera:

- **bottom pond** — target `6p` at row 2 col 2 with the **below (`3s`) and left
  (`5p`)** casters;
- **front wall** — target lower slot `08` with its **own upper** and the
  **adjacent uppers** slots 07/09.

Each sample gets physical, contact-AO and combined target-space overlays; the
hidden casters are edge-aligned to the drawn caster sprites. The sheet is
`tools/render/build/lying-samples/lying-samples-sheet.png` (3× on the target plus
casters); the report is `lying-samples-report.json`. Nothing here is committed;
the target reference must be byte-identical to the committed body. This sample
is the sign-off gate for the pond/meld and wall catch matrix.

## Experiment: a 3D contact-shadow catch (build-only)

The synthetic contact bands are a per-shell stamp. A physically caught shadow is
a better fit for the fan, where every target/caster pair differs. The experiment
was approved and productionized as the committed catches above; this two-pair
harness remains for A/B exploration and its outputs stay under `build/`.

```bash
bash tools/render/bake-contact-shadow-experiment.sh
xdg-open tools/render/build/contact-shadow-experiment/contact-shadow-experiment-sheet.png
cat tools/render/build/contact-shadow-experiment/contact-shadow-experiment-numbers.json
```

- **Geometry:** the hand shells are the same eye at the row centre with the tile
  at its true row offset (`lateralOffsetUnits = -offsetUnits`). The experiment
  places the target at the origin, the caster one 0.75-unit step along the row,
  and uses the target's published shell camera. The target reference crop comes
  out **byte-identical to the committed target body** (mean/max Δ 0), so the
  pair scene, framing and crop are exact.
- **Variants:** target-only vs target+caster with the caster invisible to the
  camera but still casting → the physical overlay; and a separate emission
  target with a Cycles AO node (distance 0.12) and no key/world → the contact AO
  overlay. The sheet shows no overlay, the committed synthetic decal, the
  physical catch, and physical+AO for the right pair (slot 11 from 10) and the
  left pair (slot 2 from 3) at 3×.
- **Outputs** are target-space straight-alpha ink (`#0b1418`) at 1x/2x, the same
  size and anchor as the target shell texture, so a future compositor can draw
  one after the target body. No committed assets or manifests change.
- **Status:** the experiment was approved on the right/left pairs and is now
  productionized as the 12 target-space catches above (`bake-hand-catches.sh`).
  This two-pair script remains the exploration/A-B harness; its outputs are
  gitignored. Current numbers: physical peak 1.0 / mean 0.50 (right) and 1.0 /
  0.62 (left); AO peak 1.0 / mean 0.52 and 0.48; the right pair's synthetic
  peak is 0.5.

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
