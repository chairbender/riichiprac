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
bash tools/render/bake-shells.sh --bake    # bake 1x + 2x, build sheets, validate
bash tools/render/bake-shells.sh --preview --only <id> [--only <id>...]  # fast partial bake
bash tools/render/bake-shells.sh --audition # standing-hand fan calibration + sheets
bash tools/render/bake-shells.sh --check   # integrity check; no Blender needed
bash tools/render/bake-shells.sh --check-audition  # validate the calibration; no Blender
bash tools/render/bake-shells.sh           # dry run: build the tile, print the shell plan
bash tools/render/bake-felt.sh             # regenerate frontend/public/table/felt.png
```

`--preview` is the fast loop. It renders only the `--only` shells under
`tools/render/build/preview/` (never the committed paths), writes a partial
preview manifest, and draws `preview-1x.png` plus a 4x zoom per shell. It skips
the full 103-shell check, so a one- or two-shell change takes seconds instead of
the full bake. Use it while tuning a shell, then do a full `--bake` for the
committed manifest and the full review sheets.

`--bake` is the one command that regenerates the committed assets: it renders
all 103 shells (eight base + 14 human-hand slots + 13 top-hand slots + 68
front/back wall slots) at @1x and @2x with the
pinned Blender at the current base scale, measures each render, writes
`frontend/public/table/shells/*.png`, `shells/2x/*.png` and
`frontend/public/table/shells.json`, regenerates the review sheets under
`tools/render/build/review/`, then runs the dependency-free integrity check.
`--bake --verify-determinism` additionally renders every shell a second time and
compares the decoded RGBA.

`--audition` is the standing-hand fan calibration path. It renders every candidate in
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
builds the tile, material and lights, prints the seventy-seven-shell plan, and exits
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
| `shell-spec.json` | yes | the shell-baker source of truth: Blender pin, CPU-Cycles/AgX settings, jansou tile proportions, bevel `0.055 / 6`, the one-material white/blue split, top-left key + ambient fill, the nine-shell base catalogue and the wallSlots fan, output paths, budgets |
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
| `../../frontend/public/table/shells/2x/` | yes | all 77 shells at @2x |
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

## The committed bake (Phase 1c + the hand/wall fans)

Ninety shells are baked, measured and committed at the Phase 1b base (the Phase 1
`@2x` size): the eight-shell base below, the 14-slot standing-hand fan, and the
68 front/back wall slot shells (17 slots × 2 walls × face-down/face-up).
`shell-spec.json` carries each base shell's pose (Euler degrees), camera
(azimuth/elevation + which local face is visible) and expected aspect, plus the
compact `handSlots` and `wallSlots` blocks the baker expands into the slot
catalogue. `bake_shells.py` renders each, measures the alpha silhouette, projects
the `faceQuad`, and writes both texture scales. The felt is unchanged.

| Id | Projection | Pose | Camera | Body (@1x) | Texture @1x / @2x | gridStepPx x / y | stackStepPx |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `shell_flat_upright` | low-angle top-down | — | az 0 / el 45 | 72 × 102 | 90 × 120 / 180 × 240 | (69.4, 0) / (0, 65.44) | — |
| `shell_flat_sideways` | low-angle top-down | rotZ 90° | az 0 / el 45 | 106 × 95 | 124 × 113 / 248 × 226 | (0, 55.15) / (104, 0) | — |
| `shell_wall_horizontal` | low-angle top-down | rotX 180° | az 0 / el 45 | 72 × 102 | 90 × 120 / 180 × 240 | (69.4, 0) / (0, 65.44) | (0, −38.56) |
| `shell_wall_horizontal_faceup` | low-angle top-down | — | az 0 / el 45 | 72 × 102 | 90 × 120 / 180 × 240 | (69.4, 0) / (0, 65.44) | (0, −38.56) |
| `shell_wall_side_left` | off-axis perspective | rotX 180°, rotZ 90° | el 45, 2 units inside / d10 | 104 × 85 | 122 × 103 / 244 × 206 | (−6.91, 45.96) / (92.84, 0) | (−5.64, −39.87) |
| `shell_wall_side_left_faceup` | off-axis perspective | rotZ 90° | el 45, 2 units inside / d10 | 104 × 85 | 122 × 103 / 244 × 206 | (−6.91, 45.96) / (92.84, 0) | (−5.64, −39.87) |
| `shell_wall_side_right` | off-axis perspective | rotX 180°, rotZ 90° | el 45, 2 units inside / d10 | 104 × 85 | 122 × 103 / 244 × 206 | (6.91, 45.96) / (92.84, 0) | (5.64, −39.87) |
| `shell_wall_side_right_faceup` | off-axis perspective | rotZ 90° | el 45, 2 units inside / d10 | 104 × 85 | 122 × 103 / 244 × 206 | (6.91, 45.96) / (92.84, 0) | (5.64, −39.87) |

The eight base PNGs are **297,564 B** (75,440 @1x + 222,124 @2x). The 14 hand
slots add **558,566 B**, the 13 top-hand slots **454,687 B** and the 68 wall
slots **2,539,608 B**, so all 103 are **3,850,425 B** (972,893 @1x +
2,877,532 @2x; budget 4,194,304 B); the largest
single shell is 43,721 B (@1x + @2x, ceiling 262,144 B). `shells.json` is
**357,606 B** (budget 524,288 B). The hand slots keep the 104 px body long axis
(102 px measured); the centre is 89 × 120 @1x and the drawn slot 103 × 120. The
budgets were raised for the fans; a board loads only the slots it draws, so the
initial load stays well under the 4 MiB limit.

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
- **The contact shadow is diffuse and subtle**: 11–12 px right/bottom at peak
  alpha 0.12 with an 8 px blur and a 16 px falloff, plus a 1 px / 0.20 AO
  fringe. Phase 1/1b's 3–4 px band at 0.33 was the "too tight" review note.

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

| Slot | Offset | Angle at d24 | Body | Texture @1x / @2x | Bytes @1x + @2x |
| --- | --- | --- | --- | --- | --- |
| 06 (centre) | 0 | 0.00° | 71 × 102 | 89 × 120 / 178 × 240 | 9,043 + 26,629 |
| 00 / 12 | ∓4.50 | 10.62° | 82 × 102 | 100 × 120 / 200 × 240 | 10,569 + 30,941 / 10,801 + 32,013 |
| drawn | +5.5125 | 12.94° | 85 × 102 | 103 × 120 / 206 × 240 | 11,015 + 32,125 |

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
and the centre is 70 × 102 (88 × 120 texture). The back is a shadowed blue
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
      "camera": { "azimuthDeg": 0, "elevationDeg": 45, "projection": "orthographic", "orthoScale": 1.642469, "pixelsPerUnit2x": 185.087201, "resolution1x": [118, 152], "resolution2x": [236, 304] },
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
- `rig` — Blender version, engine/device/samples/seed, colour management, the
  key's screen-space direction, the shadow/AO contract, the 2-tile stack, the
  target long-axis size, and each shell's framing. It is the audit trail for a
  bake.

The check enforces: every path exists and decodes as 8-bit RGBA; the PNG sizes
match (with the @2x exactly twice the @1x); the declared padding matches the
spec and the anchor; the opaque body is inset exactly 1 px; the faceQuad is a
convex quad inside the body with an oblique-plausible aspect (a parallelogram
for the orthographic shells, a trapezoid for the perspective ones, with one
table-parallel edge pair, a longer near edge and converging depth edges);
`gridStepPx` follows from the faceQuad; `stackStepPx` is present on exactly the
wall shells and matches the projected thickness within 1.5 px (2.5 px on the
perspective shells); the slot metadata follows `wallSlots`; the shadow/AO
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

The remaining visual is the **standing-hand fan**: the 13-tile row plus the
drawn tile, each with its own camera offset from the player's eye. The centre
slot is straight on; the outer row is 10.62° and the drawn tile 12.94° at the
committed stylised 24-unit eye distance. `--audition` moves the **outer row slot
and the drawn slot** to 14 / 18 / 40 units, keeping the lateral offset, so the
fan strength can be picked without rotating a tile:

```bash
bash tools/render/bake-shells.sh --audition                    # + sheets + validation
bash tools/render/bake-shells.sh --audition --verify-determinism  # + re-render
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
ones (both scales, the base long axis, the shadow/AO contract, the perspective
trapezoid, `faceQuad` and `gridStepPx`, `stackStepPx`, hashes) plus the sheets'
printed-text and composited-tile pixel checks; the full run reports **6,147
checks**. The committed bake alone reports **5,822** (including the review-sheet
pixels when the sheets are present).

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
PASS shell_hand_slot_12 perspective keystone has the near edge longer (58.5 > 57.5 px)
PASS shell_hand_slot_12 handSlot offset 4.5 follows from handSlots (4.5)
PASS shell_hand_slot_draw handSlot kind is row/draw (draw)
PASS shell_hand_slot_draw top edge carries the blue resin sliver (3,69,165)
PASS shell_wall_front_slot_16 camera sits at the human's x (lateral -6.0 = -offset)
PASS hand-fan-1x.png composites its tiles (271951 px)
INFO shell textures total 3850425 B across 103 shells and 2 scales
OK 5822 checks passed
```

`--audition` additionally validates the hand fan calibration and its sheets; on
the current output it reports `OK 6,147 checks passed` (the committed checks plus
the candidate and sheet checks). The committed-only run stays at 5,822.


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
xdg-open tools/render/build/review/shells-row-1x.png      # the eight base shells, catalogue order
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
bake the neighbour's face edge darkens from luma 218.3 to 210.1 where the
previous tile's shadow lands on it, and the isolated tile's shadow reads 61.1
against bare felt 66.8. The diffuse band is deliberately subtle in these
numbers; the strength is a visual call for the user.

To review the open hand fan strength, run `--audition` (above) and open the
two sheets:

```bash
xdg-open tools/render/build/review/shell-candidates-shell_hand_slot_12.png
xdg-open tools/render/build/review/shell-candidates-shell_hand_slot_draw.png
```

Each sheet has a header with the shell id, the base size and the question it
asks, then one row per candidate (14 / 18 / 40 units) plus a `REF COMMITTED`
row at 24 units. Every row is a packed six-tile run plus an isolated tile, so
the isolated tile shows the full side reveal and face skew; the labels print the
camera, texture, body, projected face, eye distance and byte numbers. The sheet
is a review artefact: it is not the layout engine.

State the numbers the check already verified, then ask the user the questions
only they can answer: does the hand fan read at 24 units, or does it need the
14/18/40 alternatives; is the drawn tile still the same tile type; is the
standing hand's dimmer face acceptable next to the pond; is the packed hand row
with the drawn gap the right read? Compare decoded pixels, not PNG container
bytes: zlib can change the container while the image is identical.

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
