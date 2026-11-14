# Offline rendered-table asset pipeline

This directory builds the baked sprites for the opt-in **rendered** table view
(see [`rendered-table-plan.md`](../../rendered-table-plan.md)). It is a
developer-only asset pipeline: nothing here is bundled, imported, or shipped by
the frontend. The runtime is a 2D sprite compositor, so all perspective,
lighting, bevel highlights, and shadows are baked here.

The pipeline builds two batches from one scene, spec, and script:

- **shipped batch** (default) — the table background, one **body** sprite per
  hand layout in both poses (the concealed row and, when the layout has one, the
  drawn tile baked together), and the manifest, written to
  `frontend/public/table/`. Task 2 delivered the first batch of per-slot sprites;
  Task 2.5 replaced them with group bodies and the ten hand layouts; Tasks 5–11
  add their own groups to the same scene.
- **spike batch** (`--spike`) — the Task 1/1.5 review artifact: one hand-slot
  body, its concealed pose, the carved face decal, the homography composite, and
  the contact sheet, written to `tools/render/spike/`. Never shipped.

Task 1 proved the pipeline end to end on one tile and one decal; Task 1.5
replaced its single studio key with a parlor strip rig; Task 2 added the table
and the hand row; Task 2.5 made the row a group body with a measured shadow
crop; Task 3 extends the decal batch to the full 38-code × 5-orientation set.

## Toolchain (pinned, outside the repo)

| Tool | Version | Location | Used for |
| --- | --- | --- | --- |
| Blender | **4.5.9 LTS** | `/home/kylehipke/.local/opt/blender-4.5.9/blender` | building and rendering the scene |
| Node | ≥ 18 | system `node` | the two offline scripts |
| `@resvg/resvg-js` | **2.6.2** | `tools/render/node_modules` (installed, gitignored) | rasterising the face SVG |

Blender is a portable Linux build installed outside every task worktree. The
pipeline ships no `.blend` file: `build_and_render.py` constructs the scene
from code on every run. Reinstall with the official portable archive:

```bash
curl -L -o /tmp/blender.tar.xz \
  https://download.blender.org/release/Blender4.5/blender-4.5.9-linux-x64.tar.xz
mkdir -p ~/.local/opt && tar -xf /tmp/blender.tar.xz -C ~/.local/opt
mv ~/.local/opt/blender-4.5.9-linux-x64 ~/.local/opt/blender-4.5.9
~/.local/opt/blender-4.5.9/blender --version   # must print "Blender 4.5.9 LTS"
```

The render script prints `bpy.app.version_string` and aborts on anything that
is not 4.5.9, so a stray Blender on `PATH` cannot silently produce new assets.

The scene is pinned to **CPU** Cycles (`scene.device`): the plan's determinism
rule assumes CPU sampling. A GPU device is much faster but samples differently,
so a GPU regeneration produces slightly different pixels and should be committed
as its own regeneration, not mixed with CPU output.

There is **no headless browser, no `sharp`, and no system `rsvg`** in the
pipeline. resvg-js is the only SVG rasteriser, matching §12.14 of the plan.

## Regenerate (one command)

```bash
bash tools/render/render.sh            # shipped batch -> frontend/public/table/
bash tools/render/render.sh --spike    # Task 1 review batch -> tools/render/spike/
```

The shipped batch:

1. builds the scene and renders with headless Blender (`build_and_render.py`,
   `--python-exit-code 1` so failures are loud): the background, then one body
   per hand layout in both poses (the concealed row and the drawn tile baked
   together), each cropped from its measured shadow contour plus a transparent
   taper, then a per-layout alignment reference frame;
2. verifies the result with `scripts/check-assets.mjs` (dependency-free, so the
   same command runs in CI): every referenced file exists at the size the
   manifest publishes, every body rect sits inside the scene, every slot's face
   and decal quad and tile rect sit inside the body that renders it, every body
   crop edge sits below its shadow-contour threshold, every `faceMatrix`
   reproduces its `decalQuad`, and the batch is inside the asset budget.

The spike batch additionally installs `tools/render`'s Node dependencies with
`npm ci` on the first run (the directory is gitignored, forever offline after
that), rasterises the vendored face SVG with resvg
(`scripts/rasterize-face.mjs`), and assembles the labelled contact sheet with
resvg (`scripts/contact-sheet.mjs`).

One shipped batch is a few minutes on a CPU-only machine: the 20 body sprites
are group border renders (the 13-tile row is the largest, a couple of minutes
per pass) and the background is the bulk of it. The scene's 256-sample setting
applies to the sprites; the background is a full frame of broad, low-frequency
lighting, so `assets.background.samples` (64) plus OIDN renders it in ~2 minutes
with no visible difference — that is a deliberate, recorded deviation from the
scene's 256, because a full 2880 × 1800 frame at 256 is several times the cost of
every sprite in the batch. The spike's carved decal is ~90 s. There is no manual
Blender interaction and no UI. The render is deterministic: the seed is fixed,
the samples are fixed, and repeated runs produce identical pixels (Blender's PNG
container bytes can differ, so compare decoded pixels, not file hashes).
Override the paths only for experiments:

```bash
BLENDER=/path/to/blender bash tools/render/render.sh [spec.json] [out-dir]
```

## Parameter tuner (local UI)

The carve and the paint red are the two things most worth fiddling with, so
there is a small local tuner:

```bash
node tools/render/tune.mjs     # or: npm run tune
# open http://localhost:7457
```

It serves a browser UI (no build step, local only) with:

- **Manzu red** — recolours the red fills only; the rasteriser preserves each
  fill's relative brightness, so the paint's internal shading and the black bar
  survive;
- **carve depth** as a fraction of the 16.5 mm tile thickness (mm shown), with
  fine 0.0001 steps over 0..0.02 so the shallow end has room;
- **transition width** (mm) — how far the curvature runs from the lip into the
  flat bottom;
- **top fillet spread** and **bottom fillet spread** — the two independent
  Bézier controls, drawn live as the exact cross-section the mesh uses;
- **mask blur** (mm), **paint edge** (fraction + mm inset) and **preview
  samples**;
- **lighting**: a **rig preset** switch (`studio` = the Task 1 softbox,
  `parlor` = ceiling strips), tube **count** (2–4), and per-tube **azimuth /
  elevation / roll / offset / length / width / power**, plus bounce power, one
  rim per rig and ambient strength. The compass draws every tube as a bar at its
  azimuth turned by its roll, so which fixture covers which wall is visible; the
  other rig keeps its numbers untouched while you tune one;
- a **preview image** switch: **full tile** (body + decal, shows the top-edge and
  side lighting) or **decal only** (fast). Full tile is roughly 2–3× slower but
  is what you want when tuning lights, and it is now the default.

Where the streak lands is a *placement* decision, not just brightness: a wall
normal tilted `θn` mirrors a light at `2 θn − θv` (`θv` = camera elevation), so
the tube elevation sets which ring of the fillet lights up. Low elevations
(~50°) put the highlight at the wall/floor junction, with painted wall above and
painted floor below it; high ones (~80°) push it against the paint edge, where
it reads as an unpainted rim. The paint's own diffuse falls with `cos θL`, so a
high elevation also needs a bigger front bounce, which desaturates the red.

The preview renders at 2× with a coarse carve grid (`gridScale 0.6`) and few AO
samples, so it is a little softer and flatter than the shipped 3× bake. Judge the
streak's placement and colour in the preview; judge its final crispness on the
regenerated spike.

"Render preview" writes a throwaway spec, rasterises the recoloured symbol and
renders the **full tile** at 2×, 48 samples, a 0.6 carve grid and 4 AO samples on
the first click (or only the **decal** in decal-only mode) — about 13 s full
tile, 5 s decal on this machine — then shows it. It does not touch the committed
assets. "Apply to spec" writes the values into `scene-spec.json`; run
`bash tools/render/render.sh` afterwards for the full-quality set. The tuner
re-reads the spec on every request, so editing it by hand while the server runs
is safe.

Preview intermediates go to `tune-spec.json` and `build/tune-out/`, both
gitignored.

## Files

| Path | Committed | Purpose |
| --- | --- | --- |
| `scene-spec.json` | yes | the single source of truth: tile proportions and bevel, melamine/paint/table materials, table plan dimensions, camera, `lightRig` + `lightPresets` (studio and parlor), colour management, hand layout and shadow-crop config, carve, decal rig, composite sampling, asset format/budget, checks, output names |
| `build_and_render.py` | yes | builds the whole scene from the spec with `bpy`, renders the table background and every group body sprite, carves the symbol, projects, warps the decal, checks alignment, measures, writes the manifest |
| `scripts/check-assets.mjs` | yes | dependency-free manifest/asset/budget validator (also the CI gate) |
| `scripts/rasterize-face.mjs` | yes | vendored symbol-only SVG → paint colour + carve mask PNG (resvg) |
| `scripts/contact-sheet.mjs` | yes | renders the spike review sheet SVG → PNG (resvg) |
| `tune.mjs`, `tune.html` | yes | local parameter tuner (dev only, never shipped) |
| `faces/` | yes | vendored public-domain symbol-only SVGs + provenance (`faces/SOURCE.md`) |
| `spike/` | yes | Task 1/1.5 review outputs: body sprite, concealed pose, decal, composite, zoom, contact sheet, review manifest |
| `../../frontend/public/table/` | yes | the shipped batch: `background.webp`, `bodies/hand-*.webp` (one per layout, plus its `-back`), `manifest.json` |
| `node_modules/`, `build/`, `tune-spec.json` | no | installed dependencies, intermediate renders, and the review composites (`build/review/<layout>-face-up.png`, `-face-down.png`) |

Generated sprites are never hand-edited. A regeneration commits the spec/script
change together with the regenerated assets under `frontend/public/table/` (or
`spike/` for the review batch).

## Scene and coordinate conventions

World units are tile units, and the tile follows the **jansou proportions**:
28 × 21 × 16.5 mm (height × width × thickness), including the backing. The spec
owns that ratio plus one world height (`heightUnits`), and the script derives
width and thickness, so the box can never drift from the ratio. At height 1.0 the
face is 0.75 × 1.0 and the thickness 0.58929. Bevel width 0.035 (= `faceInset`).
Tiles are modelled flat (face up +Z, symbol top +Y). The `hand-upright` pose
rotates the tile 90° about X so the face points at the player (−Y) and the tile
stands on the table; `hand-upright-back` turns the same slab 180° about Z so the
blue backing faces the camera (the concealed-hand pose). Both poses stand on the
same felt footprint.

The scene is one fixed perspective camera (65 mm on a 36 mm sensor, 2880 × 1800
device pixels = 1440 × 900 CSS at `pixelRatio: 2`), a preset area rig
(`parlor`: 2 tubes + bounce + rim), a shadow-catcher felt plane, and AgX colour
management with denoised Cycles.

**Manifest coordinates are rendered device pixels** (top-left origin, y down,
sprite-intrinsic). Divide by `pixelRatio` for CSS. A body's rect is exactly the
body sprite's destination: `x, y, width, height` are the crop's device-pixel
bounds, cropped from the **measured shadow contour**, so the runtime never
guesses an anchor. A layout's slots carry their own projected tile rect plus
`faceQuad`, `decalQuad` and `faceMatrix` in the same absolute space.
`faceMatrix` is a CSS `matrix3d` that maps the decal image's own pixel rect
(top-left origin, y down) onto `decalQuad`; the runtime applies it verbatim and
never projects a quad itself.

**Hand layouts.** A hand is a sealed unit, not 14 independent tiles:

- the human's concealed row is **centred on `hand.centerX`** and pitched at
  `hand.spacing`; the rest of this batch uses `"spacing": "touch"`, i.e. the tile
  width, so the row closes up into the Tenhou-style solid block;
- the row's position does **not** depend on the draw, so drawing a tile never
  shifts the row;
- each layout is **one body sprite**: the concealed row and, when the layout has
  one, the drawn tile are baked together, so no two sprites represent the same
  shadow and the paint order cannot matter;
- concealed counts are 13 / 10 / 7 / 4 / 1 (a kan removes three concealed tiles
  like a meld), each shipped with and without the draw: layouts `hand-13`,
  `hand-13-draw`, `hand-10`, `hand-10-draw`, … `hand-1`, `hand-1-draw`.

## Task 2 results: the table, the hand row, and the alignment check

> **Partly superseded by Task 2.5** (the next section): the 0.82 row spacing, the
> per-slot bodies, the 32 px shadow gutter, and manifest v2 were replaced by a
> touching group row and a measured shadow-contour crop. The table plan, camera
> framing, background bake, and the alignment-in-numbers method below are current.

### Table plan (tile units, 1 unit = the 28 mm tile height)

| Part | Extent | Notes |
| --- | --- | --- |
| felt | half-extent 12.9 (25.8 across = 722 mm) | the playing surface and the shadow catcher |
| wall-ring track | half-extents 6.3 … 7.3 (1.0 deep) | three flush bands: dark edge, track, dark edge |
| compass base | 4.7 square, 0.06 high, 0.07 bevel | static plate; winds/scores are DOM (Task 8) |
| hand apron | radial 10.6 … 12.55, 12.3 long | one flat, barely-lighter felt pad per seat |
| rail | 0.9 wide, 0.35 high, 1.4 skirt | closed wooden ring, bevel 0.09 |

The dimensions are a real jansou read back into tile units: the wall is 17
stacks of 21 mm tiles, so its ring is 12.6 units on the inside (357 mm) and one
tile deep (1.0) on the outside; a 3-unit river band sits outside it (Task 6
fills it); the standing hand row sits outside that; the rail is the table's edge.
The whole outer square is 27.6 units (773 mm).

The track and the aprons are flat bands 0.002 units above the felt, not modelled
recesses: the felt is the shadow catcher every body sprite is baked against, so
keeping those surfaces coplanar keeps every tile's contact shadow exactly on the
surface the sprite was baked against. There is no depth to get out of step.

Lighting the felt was new work. The old felt colour was only ever a shadow
catcher and rendered far too bright (`#12533a` read as pale mint), so the table
palette was tuned against a render: felt `#093021`, apron `#0a3323` (a ~5%
difference, just enough to read as a bed), track `#052316`, rail `#2a1a10`,
compass plate `#08090a` at roughness 0.7. Felt is matte cloth (specular 0.12);
only the rail and the compass plate are glossy. AgX lifts dark albedos a lot, so
the palette is deliberately much darker than the target screen colour.

### Camera framing

The Task 1 camera framed one hand slot at ~100 CSS px per unit. The rendered
view has to show the whole table, so Task 2 re-framed it: position
`(0, −47.8, 32.2)`, target `(0, 0, 0.35)`, 65 mm, elevation **33.7°**, 57.4
units (1.6 m) from the table centre. The near rail's corners land just outside
the frame (±110 device px) so the near edge reads as the screen edge, the far
rail sits at ~18% height, and the converging side rails are both visible. The
hand row is 1280 device px (640 CSS) wide; a face is 74.3 × 77.0 device px
(37 × 38.5 CSS), and the projected top edge is 42.2 device px, of which the rear
30% blue backing is ~10 device px.

At this elevation a standing tile shows a real top surface and a visible blue
band along it, which is the physical truth for a 16.5 mm tile seen from 34°, and
it is what makes the hand row read as physical tiles rather than cards. The plan
keeps one framing (§12.9); Task 10 revisits it only if the phone check fails.

### Hand slots (Task 2 model, superseded by group layouts)

The human's row was 13 concealed slots at 0.82 spacing plus **the separated
draw**: `hand-draw` sat 0.55 units past the last concealed slot, which is the
gap the app's dock already shows between `player.hand` and `player.draw`. The
row *including* the draw was centred on `hand.centerX`. Every slot was baked in
both poses. Task 2.5 replaced this with the layout model above: the row abuts,
is centred on its own, and is baked as one group body per layout.

### Background bake

The background is one Cycles render from the same camera with the film made
opaque and the felt's shadow catcher turned off, so the felt, track, aprons,
compass plate, rail, and the room floor outside the rail are all lit normally.
It renders at the scene resolution (2880 × 1800) and is box-filtered ×2 down to
**1440 × 900 WebP q90** (§9's background size), which is also `backgroundPixels`
in the manifest. Body sprites stay at 2× device pixels.

### Alignment check: sprites really do land on the background (method; numbers re-baselined in Task 2.5)

The batch is checked, not just eyeballed. After the bodies are baked, the script
renders one 8-sample reference frame with **every tile of one layout** in the
scene at once, and pastes that layout's body tile-only alpha at its manifest
rect. The two are compared with a one-pixel dilation so anti-aliasing
and denoiser softness are ignored: any disagreement left is a real shift. Task 2
reported **0 shifted pixels** for the per-slot row; Task 2.5 reports **0 shifted
pixels for every one of the ten layouts** (see its section below) — a crop or a
rect off by one pixel fails the bake.

A second, human-readable artifact proves the same thing over the real
background: `build/review/<layout>-face-up.png` / `-face-down.png` composite each
layout exactly as the runtime will (device pixels, then box-filtered for
viewing). They are gitignored review images, not assets.

### Format, budget, and what the batch weighs (Task 2 batch; Task 2.5 below)

| Asset | Format | Size |
| --- | --- | --- |
| background | WebP q90, 1440 × 900, 64 samples | 19,018 B |
| body sprites | WebP q90 with alpha, 2× device px | 141,804 B (28 files, ~5 KB each) |
| manifest | JSON (v2) | 24,620 B |

The Task 2 batch was 186 KB against the plan's 8 MB total / 1 MB body budgets,
and the `body`, `background` and `manifest` byte budgets are enforced by both the
bake and `scripts/check-assets.mjs` (Task 2's manifest budget was 50 KB, with the
manifest then ~24 KB of that). The manifest is deliberately verbose —
per-slot measurements, the full rig, and the check results — because it is the
pipeline's audit trail; Task 4 can strip a runtime projection of it if the load
weight ever matters. Task 2.5 re-baselined the body and manifest sub-budgets to
2 MB and 150 KB (see its section).

## Task 2.5 results: hand rows as whole-group bodies

Task 2 baked **one body per slot**, each cropped to a fixed 32 px shadow gutter.
A standing hand tile's cast shadow is several times that: the composited alpha
was still ~20 % at the old crop edge, so every sprite cut its own shadow on all
four edges, and a row of them clipped each other's copies. A per-tile body also
cannot carry inter-tile occlusion or the shadow one tile throws on its
neighbour, which is why the row read as loose isolated tiles. Task 2.5 makes the
whole layout the body unit.

### The layout model

A hand is ten layouts — the five concealed lengths a jansou hand can have (a kan
removes three concealed tiles like a meld) with and without the drawn tile:

| Layout | Concealed | Draw | Body sprite |
| --- | --- | --- | --- |
| `hand-13` | 13 | no | `bodies/hand-13.webp` |
| `hand-13-draw` | 13 | yes | `bodies/hand-13-draw.webp` |
| `hand-10`, `hand-10-draw` | 10 | no / yes | `bodies/hand-10.webp`, `bodies/hand-10-draw.webp` |
| `hand-7`, `hand-7-draw` | 7 | no / yes | `bodies/hand-7.webp`, `bodies/hand-7-draw.webp` |
| `hand-4`, `hand-4-draw` | 4 | no / yes | `bodies/hand-4.webp`, `bodies/hand-4-draw.webp` |
| `hand-1`, `hand-1-draw` | 1 | no / yes | `bodies/hand-1.webp`, `bodies/hand-1-draw.webp` |

- **One body per layout, draw included.** The draw is *in* the layout's body,
  not a separate sprite. Two sprites would each carry a shadow tail that ends
  inside the 47 px gap between the row and the draw — the measured 2 % contours
  overlap there — and whichever is painted second darkens the other's tail. One
  bake of both means no two sprites ever represent the same shadow, and drawing
  order cannot matter. (The planning conversation had assumed a per-row-length
  draw body on the grounds that the gap keeps the shadows apart; the measured
  contours say otherwise, so the task's decision 2 is superseded here.)
- **The row abuts.** `hand.spacing` is `"touch"`, resolved to the tile width
  (0.75 units), so the concealed row is the Tenhou-style solid block. The 13-tile
  row spans 1072 device px (536 CSS), x = 904…1976 with its centre at the scene's
  1440.
- **The row is centred without the draw**, so drawing a tile never shifts the
  row: `hand-13` and `hand-13-draw` differ only by the drawn tile in the body and
  one more slot.
- Both poses are still baked: each layout carries a `body` record and a nested
  `back` sprite + rect in the concealed (`hand-upright-back`) pose.
- **Tile edges got rounder.** The feedback on the first group bake was that the
  closed-up row reads "too solid": the bevel was only 0.035 units (≈1 mm) so the
  groove between two tiles was too shallow to separate them. `tile.bevel.width`
  is now **0.055** units (≈1.5 mm) with 6 segments, and `tile.faceInset` moved
  with it (0.055) so the decal still sits on the flat face. The seam dip rose
  from ~4 % to ~6 % (see the numbers below) and the bare-bevel band between
  decals from ~7 px to ~11 px.

### The group bake

`bake_group()` replaces `bake_body()`:

1. **Pass 1** — the layout's posed tile copies alone, transparent film.
2. **Pass 2** — the **whole table** (felt, apron, wall-ring track, compass
   plate, rail) as Cycles shadow catchers with the tiles invisible to the camera
   but still occluding the lights. The catchers do not cast: the rail's own
   shadow on the felt is already in the background and must not be baked twice.
3. **Crop** — the measured shadow contour: the composited alpha above
   `hand.shadow.alphaThreshold` (2 %), plus `cropMarginDevicePx` (32 px), united
   with the tiles' own integer bounds so a tile's sub-2 % anti-aliased top edge
   can never be shaved.
4. **Taper** — the outer `taperDevicePx` (32 px) of that margin is faded to
   zero, on shadow-only pixels. The shadow's alpha only *asymptotes* to zero, so
   a bare contour crop still ends on a ~2 % step: that was the straight cut the
   first bake showed along the bottom-left, where the shadow is longest. After
   the taper the sprite boundary is exactly transparent
   (`shadow.visibleAlphaAtSpriteEdge` = 0 on every body) and the fade is over a
   region whose true alpha is under 2 %, so nothing visible is lost.
5. The render region is `searchPadDevicePx` (160) plus the crop margin and guard
   around the tiles, and the bake **fails** if the contour reaches the search
   pad's edge while that edge is inside the scene. Only the scene frame may cut a
   shadow (`shadow.sceneEdgeClips` — empty in the shipped batch).

### Measured results

Every body's `shadow` block is the audit trail. Measured reach is how far the 2 %
contour extends past the tiles' own bounds:

| Layout | Body crop (device px) | Reach L / T / R / B (px) | Bytes face-up / back |
| --- | --- | --- | --- |
| `hand-13` | 1248 × 236 | 72.5 / −1 / 40.5 / 46 | 23,986 / 34,992 |
| `hand-13-draw` | 1389 × 236 | 72.5 / −1 / 38.7 / 46 | 28,864 / 41,470 |
| `hand-10` | 998 × 235 | 70.1 / −1 / 40.1 / 45 | 19,498 / 28,488 |
| `hand-7` | 750 × 235 | 68.7 / −1 / 40.7 / 45 | 14,920 / 21,916 |
| `hand-4` | 502 × 235 | 66.2 / −1 / 42.2 / 45 | 10,842 / 15,028 |
| `hand-1` | 254 × 254 | 64.8 / −1 / 42.8 / 64 | 5,798 / 7,588 |

Each `-draw` body is the same row plus the drawn tile: about 141 px wider and
4–6.5 KB heavier.

Four things are worth recording:

- `visibleAlphaAtSpriteEdge` is **0** on every body (after the taper) and
  `maxAlphaAtCropEdge` is at most **0.0078** (2/255) before it: no sprite edge
  ends on a shadow boundary, at any zoom, and the crop's own raw alpha is well
  under the 2 % threshold. That is the numeric form of "the shadow is uncut".
- The crop now reaches 32 px past the 2 % contour and fades the last 32 px, so
  the shadow's whole visible tail is in the sprite. The earlier 2 % + 1 px crop
  is what made the cut visible on the bottom-left.
- A one-tile row's 2 % contour reaches **64 px** below the tile foot, while a
  multi-tile row reaches **45–46 px**. That is not a bug: the shadow catcher's
  alpha is the *relative* darkening, and a row of white melamine tiles bounces
  more light onto the felt than one tile does, which cancels part of the faint
  tail. The blue `-back` pose keeps a longer tail (72 px) for the same reason:
  it reflects less light.
- The seam is measured, not eyeballed. `seamContrast` on each layout's body takes
  a horizontal scan through the face centres and records the deepest luminance
  dip within ±4 px of each interior seam against the face luminance 20 px inside
  the tile: **dip median 5.25–5.62 %**, 12 seams on the 13-tile row. That is up
  from 4.1 % with the old 0.035 bevel — the wider roundover is what does it, and
  the decals (Task 3) add a ~11 px band of bare bevel between faces on top.

### Alignment per layout

Each layout is checked against its own reference: one 8-sample frame rendered
with **all of that layout's tiles** present (a layout without the draw must not
see one). The body's tile-only alpha is pasted at its manifest rect and compared
with a one-pixel dilation. The shipped batch reports **0 shifted pixels for all
ten layouts** over 737,786 tile pixels, with a soft-edge fraction of **0.0000 %**
(the 256-sample bake and the reference agree to the stored 8-bit alpha).

### Weight and budgets

| Asset | Format | Size |
| --- | --- | --- |
| background | WebP q90, 1440 × 900, 64 samples | 19,018 B |
| body sprites | WebP q90 with alpha, 2× device px | 419,334 B (20 files, 5,798–41,470 B) |
| manifest | JSON (v3), ten layouts, 75 slots | 124,155 B |

The batch is **438 KB**, 20 sprites, against the re-baselined 8 MB total / 2 MB
body / 150 KB manifest budgets. Group sprites are several times a per-tile body
because each carries a layout's shadow plus the 32 px transparent taper, but
WebP's alpha compression keeps even the 13-tile concealed pose at 41,470 B.
`render.sh` prunes any `bodies/` file the new manifest does not reference, so a
regeneration cannot leave a stale per-slot sprite behind to be counted or served.

### What Tasks 4–7 and 11 consume

- **Task 4 (runtime compositor):** pick a layout by `(count, hasDraw)`, draw its
  single `body` at the published rect, then each slot's decal with that slot's
  `faceMatrix`. There is no per-slot body and nothing to project; the drawn tile
  is a slot with `role: "draw"` in the same layout, not a second image, so paint
  order inside the hand cannot matter.
- **Task 5 (opponent hands):** call `bake_group()` with the seat's slot
  positions and the `hand-upright-back` pose; it bakes one concealed row per
  layout length, exactly as this batch does for the human.
- **Tasks 6/7/11 (rivers, melds, wall):** reuse `bake_group()` where a group is
  static. Where a group grows (a river that gains a tile, a hand that gains the
  draw), decide per group between a full re-bake and per-tile bodies plus one
  group shadow layer; the measured-contour crop, the taper, and the whole-table
  catcher are the pieces to keep. If two sprites' shadows can meet, prefer one
  bake: separate sprites cannot share a shadow without one darkening the other.
- Re-read `manifest.rig`, `manifest.table.plan`, and `manifest.camera`; the
  parlor rig and the Task 2 camera are baked into every sprite.

### Review artifacts

`tools/render/build/review/` holds a gitignored composite for every layout over
the real background, in both poses:
`<layout>-face-up.png` and `<layout>-face-down.png` (ten of each). They are
assembled exactly as the runtime will, at device pixels, then box-filtered to
CSS resolution for viewing. A 1:1 device-pixel crop of the 13-tile row
(`hand-13-row-device.png`) is there too for judging the seam and the shadow
tail at full resolution. `bash tools/render/render.sh` is the only command
needed to rebuild and re-validate the whole batch (~25 minutes on this machine,
dominated by the shadow passes and the background).

## Findings and decisions (Task 1, updated by Tasks 1.5, 2, and 2.5)

Measured from `spike/` and the `measurements` block of `spike/manifest.json`.

### Body sprite: real slot, position-dependent shading

`hand-0` is the leftmost of the hand row (13 concealed slots, row at y = −11.7),
so the sprite is baked where that tile will actually sit, not on a neutral stage.
The slot is left of the camera axis, which is what makes the shading
position-dependent: the near (left) bevel catches the key light, the right bevel
falls into the fill, and the right side of the body is visible at all (the face
quad is a true trapezoid: top edge 74.66 px, bottom edge 73.86 px, centre sheared
~6.9 px). A slot at the row centre would lose the side face and flatten the bevel
contrast. (The Task 1 crop was 159 × 190 device px including a 32 px shadow
gutter; Task 2.5 crops from the measured shadow contour, so the same tile's crop
is ~207 × 192 px.) On the visible side the white front band meets the blue rear band
at the backing line, which is what makes the wrap read as a physical backing
rather than a painted stripe. (The Task 1 numbers in this section were measured
on the 100 px/unit spike camera; the geometry and the material behaviour are
unchanged, the tile is simply smaller on screen now.)

Bevel: width 0.035, 4 segments, miter arc, `harden_normals`, weighted normals,
shade smooth. Four segments is enough to hold a clean highlight at 2× without
looking faceted.

### Material: white melamine, not ivory

Jansou tiles are white **melamine** with a coloured melamine backing, not ivory.
The spec's material keys are `materials.face`, `materials.backing` and
`materials.paint`; the face is an off-white `#f5f0eb` and the backing royal blue
`#132986`. Melamine is an opaque, hard thermoset with a glossy surface, so the
Principled material uses low roughness (0.16 face, 0.18 backing) plus a clear
coat (0.40 / 0.35, coat roughness 0.10) rather than the matte plastic of the
earlier passes.

The engraved paint is its **own material** (`materials.paint`: roughness 0.16,
coat 0.35, specular 0.5), glossier than the melamine around it. Gloss is what
puts a bright specular line along the bottom fillet of every groove, i.e. where
the well wall curves into the floor; that highlight is the main "glossy carved
paint" cue. (A satin paint hid it and made the carve read flat. The shallow
depth plus wide, smooth fillets keep the gloss from looking like a domed inlay.)
The symbol-only SVG supplies the paint colour and the mask, so the paint
boundary and the carve can be placed independently.

### Carved symbol, not a decal print

The symbol is physically recessed and painted, not printed flat. The pipeline
rasterises the **symbol-only** upstream SVG (`Regular-Man1-symbol.svg`, the same
300 × 400 viewBox as the upstream full-face variant, so it aligns
pixel-for-pixel) and uses it twice: its alpha is the **carve mask**, its colour
is the **paint**. The face itself is the flat melamine material colour, which
also matches the body's face underlay exactly.

The mask is blurred, converted to an **approximate signed distance** (inverting
the Gaussian erf: `alpha = 0.5 (1 + erf(d / (sigma sqrt 2)))`), and normalised by
`transitionUnits` into a 0..1 **carve field**: 0 at the lip, 1 at the floor. The
field drives both the mesh height and the paint boundary.

The field is shaped by a **cubic Bézier** from the lip `(0, 0)` to the floor
`(1, 1)` with control points `(topSpread, 0)` and `(1 - bottomSpread, 1)`:

- `topSpread` and `bottomSpread` are **independent** controls for the two edges.
  0 gives a straight diagonal (no fillet); 1 gives the widest, softest ease. The
  tangent at each end is what spreads that fillet, so the lip and the
  wall-to-floor shoulder can be shaped separately.
- `transitionUnits` is the **distance** from the lip to the flat floor (0.0107
  units ≈ 0.30 mm as tuned in Task 1.5). Raising it lets the
  curvature run further into the bottom; it is capped by the distance the blur
  can resolve (~4 sigma), so widen `blurUnits` first if you need more. A wider
  transition also *softens* the streak (the same angular highlight spread over
  more surface), which is why the strips did not need one.
- `blurUnits` smooths the symbol edge and sets that resolvable distance
  (0.0043 units ≈ 0.12 mm as tuned).
- depth is `depthFractionOfThickness = 0.0121` of the tile thickness — 0.0071
  units, about 0.20 mm at jansou scale. Task 1.5's target was 0.1–0.15 mm with
  the streak carrying the highlight; the shipped value is 0.20 mm because the
  chosen look reads better with the wall a touch deeper, and the plan's
  "do not silently deepen the carve again" rule does not apply to an explicit,
  visually checked tuning. Revisit it once the final display resolution is
  settled (see the composite note below).
- spreads are `0.6` / `0.8`: enough lip and floor fillet to hold a specular
  line without the near-vertical mid-wall the Task 1 values (0.92 / 0.92)
  produced.

The paint boundary sits `paintEdge` into the transition (0.18 as tuned), so a
ring of bare melamine remains on the bevel. That ring catches the key and is what
makes the carve read as a bevelled recess rather than a flat print. Because the
gate reads the distance field rather than the hard symbol alpha, this control
actually moves the paint edge.

`materials.paint.red` recolours the symbol's red fills at raster time (the
rasteriser keeps each fill's relative brightness, so the paint's internal
shading and the black bar are preserved). `materials.paint.redBase` is the main
upstream red; the two are equal at the committed defaults.

A groove floor has the same normal as the face, so its diffuse response is
identical and a wide stroke would still look flat. The decal material therefore
adds **cavity occlusion** (Cycles AO, distance 0.2 units, strength 0.75), which
darkens the inside of the engraving. At 0.24 mm depth the cavity is still shallow,
so the diffuse darkening is small (the face measures ≈ RGB(221, 220, 220); the
floor is within a few levels); the read comes from the bare bevel ring, the wall
shading, and the gloss highlight on the bottom fillet. If the carve needs to
read stronger without more depth, raise `occlusionStrength`, widen the bevel, or
raise the paint gloss; all are decal shading, not geometry.

The carve is baked into the **lit face decal**, so it is orientation-lit and
position-independent like the rest of the decal. At spike resolution the grid is
492 × 672 (about 330k vertices, `gridScale: 1.0`) and the decal render alone
takes ~82 s at 256 samples with AO; Task 3 should reduce `gridScale`, AO
samples, or bake the occlusion into a texture for the 190-decal set. The body
sprite is unaffected: its face underlay is flat and the carve lives entirely
inside the inset decal.

### Blue backing: wraps every edge, no forward lean (§12.6, corrected)

The tile is a **white melamine face plate** on a **solid blue melamine backing**. The blue is not a
single stripe on the top: the back face and the **rear 30% of every side edge**
are blue (`backEdgeFraction: 0.3`), so the colour wraps the whole body. On a
standing hand tile that gives a blue line along the top and a blue band down the
visible side, and from behind the tile is solid blue (see the concealed-hand
pose on the spike's contact sheet).

At the hand slot the raised camera projects the 0.58929-unit top edge to
**42.22 device px**, of which the blue run measures **10 device px** (expected
12.67; the top bevel arc eats the difference) on a **76.99 device px** face.
That is ~5 device px of blue above a ~38.5 CSS px face — a visible band, not a
stripe, and it survives at the shipped 2× size. The band is proportionally wider
than in the Task 1 spike (≈13% of the face height rather than 5.5%) because the
camera now looks down at 33.7° instead of 17.8°, so more of the tile's top
surface is visible; the backing fraction itself is unchanged.

Colour: base `#132986` at roughness 0.34, which reads as a deep royal blue after
AgX — ≈ RGB(4, 69, 166) on the back face and ≈ RGB(71, 109, 196) on the
tube-lit top edge. A brighter royal base (e.g. `#4169e1`) renders as a pastel
periwinkle under this key and AgX; keep the base dark to keep the blue deep.

No forward lean and no separate sliver sprite are needed: the blue rim is the
same geometry as the body, so it moves with the tile and its contact shading.
The white front band reads as the face plate's edge and blends into the face; do
not add a third material for it. If a fully blue side is wanted instead of a
backed plate, set `backEdgeFraction` to 1.0 — no script change.

### Decal inset and blending (§12.2 confirmed)

The decal is the inner face inset by `faceInset = 0.035` on every edge, cropped
to that rectangle plus a **1 px transparent gutter**. The Blender decal plane
takes the inset sub-rect of the symbol canvas as its UVs, so the symbol is not
stretched.

The decal's face is the same flat melamine base colour as the body's face
underlay (`#f5f0eb`). Measured at the seam under the Task 1 rig, the body face is
`rgb(221, 220, 220)` sRGB and the decal's flat face is `rgb(224, 224, 224)`,
about 1.3% brighter. That is the canonical rig sitting at the hand-row centre
while `hand-0` sits 5.6 units to its left, not a base-colour mismatch. It is
invisible at 2×; treat ~2% as the tolerance and re-check the seam zoom before
adding any runtime blend. The decal edge needs **no runtime mask, feather, or
blend mode**: it composites straight over the body's face, and the body's bevel
ring and position lighting stay visible outside the inset. (The parlor rig's
numbers are re-measured under "Seam tolerance after the rig change" below.)

A double-premultiply bug in the first composite looked like a dashed seam at the
decal edge. The fix (unpremultiply the bilinearly sampled decal before the
straight-alpha `over`) is in `warp_onto`; if a seam ever returns, check alpha
handling there before touching the inset.

### Composite sampling: the "sparkle" is an aliasing choice

The decal is baked at 3× CSS and lands on a ~77 device px face at the Task 2
framing, so the review composite is a **~8.7× minification**. `warp_onto` takes one bilinear sample
per output pixel by default (`decals.compositeSupersample: 1`). A fillet
highlight is barely one texel wide, so the sample hits or misses it along the
stroke and the line breaks into bright dashes — the "sparkle" in the 1:1
composite panel. The *decal* is continuous; the dashes exist only in the
composited panel.

Raise `decals.compositeSupersample` to box-filter each output pixel with an N × N
grid (unset derives N ≈ 1.25× the texel ratio, 4×4 here). That resolves the
streak as one continuous, dimmer line and is closer to what the browser's own
image filtering does. The current look keeps the sparkle deliberately: the final
on-screen decal resolution is still open (Task 3 downsamples 3× → 2× WebP), and
the highlight should be re-judged once that is settled rather than fixed against
a 2× review artifact. The manifest records the factor as
`decals.compositeSupersample` so a sheet is self-describing.

The real lesson for Task 3: a 1 px highlight cannot survive an 8.7×
minification whatever the filter, so the streak has to be resolved by shipping a
decal closer to its display size (or a display-sized companion), not by relying
on filtering. Task 3 should therefore re-size the decal batch against the Task 2
framing: the canonical frame is 0.68 × 0.93 units and a face is 74 × 77 device
px, so a 2× decal is ~175 × 180 px, not the 492 × 672 px spike render.

### Seam tolerance after the rig change (Task 1.5, re-checked by Task 2)

Re-checked on the Task 2 spike, whose decal rig now stands at the hand row's real
y (−11.7): sampling the composite either side of the decal's left edge at
mid-face, the body's face reads ≈ RGB(221, 219, 217) and the decal's flat face
≈ RGB(225, 223, 221) — about 1.8% brighter, the same difference as Task 1 (the
canonical rig sits at the hand row's centre while `hand-0` sits 5.6 units left of
it), and it remains invisible at the shipped size.

The parlor rig is still distant and large (56-unit throw, 40-unit tubes), so the
position-independence constraint above holds unchanged; the tube targets span
0.6…3 units along Y, which is small against that throw. The Task 2 camera looks
down at 33.7° rather than 18°, so a tube's bevel streak sits at
`θn = (θL + 33.7°) / 2` on the body and `θL / 2` on the face-on decal rig; both
still land on the up-facing fillets and the seam stays clean.

Measured across the whole Task 2 hand row, the upright face underlay reads
RGB(228, 226, 224) at the left end and RGB(229, 228, 226) at the right: under 1%
variation, so the once-lit `upright` decal sits flush at every hand slot. The
side seats' faces read RGB(204, 208, 215) / RGB(207, 210, 215) — a real
per-class difference, which is why flat tiles get their own orientation-class
rigs in Task 3. Re-check that the flat classes are as even across the table as
the hand row is: the rig's targets are near the human's edge, and a far-wall
flat tile sees a different exposure than one in the human's river.

### Lighting: parlor strip rig (Task 1.5), studio rig kept for comparison

The reference is a **mahjong parlor**: long, narrow fluorescents overhead,
mirrored in the glossy melamine as thin streaks along the up-facing bevels and
the lower wall of every engraved stroke. Task 1 shipped one huge 26 × 20 area
key, which is a studio softbox: a broad sheen that needed a deep carve and a
near-clipping key just to show an edge. Task 1.5 replaces it with strips.

The spec keeps **both rigs** and selects one with `lightRig`:

```json
"lightRig": "parlor",
"lightPresets": { "studio": { ...Task 1 rig verbatim... },
                  "parlor": { ...tubes + bounce + rim... } }
```

`build_lights` resolves the active preset, skips entries with `enabled: false`
and honours `rollDeg`, so a strip is just a very elongated `RECTANGLE` area
light turned about its own aim axis. `group` (`tube` / `bounce` / `rim`) lets
the tuner and the manifest address lights without positional assumptions; the
manifest's `rig` block records the preset and every light that was actually
built, so later tasks never guess the placement.

#### Where the streak lands (and why the numbers are what they are)

For a surface normal tilted `θn` from the face and a light at elevation `θL`,
the mirror is at `2 θn`; with the camera at elevation `θv` it is at
`2 θn − θv`, so **`θn = (θL + θv) / 2`**. The plan's simpler `θn = θL / 2` is
the eye-level case (`θv = 0`), which is exactly the decal rig: it is
face-on orthographic. The body camera sits ~18° above the tile, so the same
tube lands ~9° higher on the bevel there.

- A ceiling light (`θL` 78–84°) reflects on the **lower wall** of the groove
  (`θn ≈ 39–42°` on the decal), which is the authentic parlor band.
- The floor junction itself (`θn → 0`) needs a light at the eye's height; only a
  frontal light can do that. In a parlor that band is **bounce**, not a fixture,
  so it is dim and low-contrast (`bounce`, ~2.5 kW, slightly green `#cfe4d3`,
  azimuth 30 / elevation 10).

`θL` therefore controls *where* the highlight sits, not just how bright it is.
Lower elevations (≈50°) walk the highlight down to the wall/floor junction and
leave paint visible on both sides of it; high elevations (≈80°) put it near the
paint edge, where it reads as a bright rim and can look "unpainted". A lower
`θL` also lifts the paint's own diffuse (`cos θL`) — at 80°+ the red goes dull
and needs a big front bounce, which desaturates it instead.

#### The shipped parlor numbers

| Light | Placement | Size | Power | Role |
| --- | --- | --- | --- | --- |
| `tube-0` | azimuth 0, elevation 50, 56 units out | 40 × 2.5 | 85 kW | lights up-facing walls; the body's top-bevel streak |
| `tube-1` | azimuth 90, elevation 58, 56 units out | 40 × 2.5 | 65 kW | a second fixture; lights the other wall azimuth |
| `bounce` | azimuth 30, elevation 10, 34 units out | 42 × 27 | 2.5 kW | green frontal bounce; owns the flat face and the junction band |
| `rim` | azimuth 170, elevation 45, 40 units out | 28 × 20 | 6 kW | rear separation |

`tube-2` (azimuth 270) and `tube-3` (azimuth 8, roll) are present but
`enabled: false`: the spec carries up to four tubes so the tuner's count control
never has to invent numbers. Scale reminder: 1 world unit = 28 mm, so a 40-unit
tube is 1120 mm and a 2.5-unit one is 70 mm.

**Why strips read as strips.** The visible specular footprint is the source
shape projected through the fillet's normal sweep. Width sets the streak's
cross-section: 2.5 units at ~56 units subtends ~2.6°, narrow and graphic rather
than a blot. Length sets how far the highlight wraps around stroke ends and
corners (a straight run is uniformly lit whatever the tube length). Azimuth and
roll decide which walls catch it: roll rotates the rectangle about its aim axis,
so 0 lies along X and 90 along Y.

Measured on the regenerated spike: body peak **246/255**, decal peak
**244/255**, zero clipped pixels in either; the decal bake is **~87 s** at 256
samples, so adding fixtures did not cost bake time. At the
shipped 2× size the parlor read holds: a bright streak runs the whole top bevel
of the body (see the contact-sheet zoom), and every stroke fillet carries its own
streak on the decal (see the 1:1 composite panel — where the sub-pixel highlight
reads as the deliberate "sparkle" described below).

**Parlor vs studio.** Pick `lightRig: "studio"` (or the tuner's rig switch) to
reproduce Task 1 exactly: key azimuth 0 / elevation 77 / 56 units / 200 kW,
fill 45 / 11 / 34 / 23 kW, rim 170 / 45 / 40 / 22 kW, ambient 0.5. That is the
softbox look the strips replace.

**Key/fill practice still applies.** The key is the dominant light; the fill is
soft, dim and near the camera axis and must not own a highlight. Watch the fill
direction: at azimuth 0 / elevation 32 (or 25° / 12°) a frontal light sits near
the face's specular mirror and puts a broad white sheen on the glossy paint that
desaturates the red. The parlor bounce is deliberately dim and off-axis for the
same reason.

### Lighting must be position-independent for decals (§5/§12.3 consequence)

The decal is lit once per orientation, but it is composited onto body sprites at
many positions. A close area rig made the face 24–30% brighter at `hand-0` than
at the hand-row centre (where the canonical upright rig sits), which showed as a
visible rectangle around the decal.

The rig is therefore **distant and large** (key at ~66 units, fill/rim at ~50
units, 3× the sizes), so the illumination varies by only a few percent across
the hand row. The decal still gets a soft key gradient (its left/top side is
slightly brighter) and vertical-vs-flat lighting still differs strongly, which is
what the orientation classes need. **Tasks 2 and 3 must keep the rig distances
in this range** or decals will no longer sit flush on distant slots.

### Shadows: two-pass shadow catcher, baked into the body sprite (§12.7, amended by Task 2.5)

Each body render is two passes:

1. the tiles alone with transparent film (straight alpha);
2. the **whole table** — felt, hand apron, wall-ring track, compass plate, rail
   — as Cycles **shadow catchers** with the tiles set `visible_camera = False`,
   so they are invisible to the camera but still occlude the lights. This pass
   returns the cast shadow as a black colour with **alpha = shadow coverage**
   (not an opaque grey patch).

The catchers do **not cast** (`visible_shadow = False`): the rail's own shadow on
the felt is already in the background, so a catcher that also cast would bake
that shadow twice. Only the tiles cast, because only their shadow is new. The
room floor is not a catcher at all (it is outside the rail and out of frame).

The two passes are combined in `numpy` (tiles over shadow) and written as one
RGBA sprite, cropped to the **measured shadow contour**: the composited alpha
above `hand.shadow.alphaThreshold` (2 %) plus 1 px. The bake renders
`hand.shadow.searchPadDevicePx` (160 px) around the tiles plus a small guard
band, and fails outright if the contour reaches the search pad's edge while that
edge is inside the scene: a crop that ends inside the scene must end on
transparent felt, never on a shadow boundary. Only the scene frame's own edge
may cut a shadow (`shadow.sceneEdgeClips`, empty in the shipped batch). The
measured `maxAlphaAtCropEdge` is the largest alpha on the crop's boundary ring
and it is below the threshold in every shipped body — the numeric proof that no
sprite edge shows a shadow boundary.

This replaces Task 2's fixed 32 px gutter, which cut the cast shadow on all four
edges of every body. `hand.shadow.alphaScale` is the weight knob: 1.0 is the
physical render, and it exists so the shadow can be lightened without touching
the light rig. The shadow is neutral black alpha, i.e. a multiply-like
darkening; over the green felt this reads correctly, and it is the same
approximation §12.7 specifies (no runtime shadow layer, no CSS shadow).

The body sprite has no felt underlay, so it composites over the baked background
without a mask. Bounce light from the felt is not included (the felt is invisible
in pass 1); the green bounce is negligible on white melamine at this exposure and
keeps body and decal lighting consistent. The tiles' own *indirect* bounce does
reach the catcher, which is why a row's concealed (blue) pose measures a
slightly larger contour than its face-up pose: the blue backing reflects less
light onto the felt than white melamine does.

### Orientation-lit decal

The decal is rendered on the canonical face-on **orthographic** rig (§12.3):
`upright` stands the tile at the hand-row centre facing the ortho camera, with
the orthographic frame exactly the inset + gutter (492 × 672 px at 3× CSS). The
scene light rig and melamine material are reused, so the face is genuinely lit,
and because the camera is face-on (`θv = 0`) a tube at elevation `θL` puts its
streak where the wall normal is `θL / 2` — the parlor band on the stroke walls.
The AgX transform keeps the white warm. Flat classes will differ in brightness
because they meet the tubes at a different angle; Task 3 bakes them the same way
with the symbol rotated 0/90/180/270°.

## Spike assets

`spike/` is a review artifact, not a shipped asset. It is lossless PNG so the
bevel and alpha can be inspected; the shipped batch is 2× lossy WebP under
`frontend/public/table/` per the asset budget (§9). Both are regenerated by
`render.sh` (the shipped batch by default, this one with `--spike`).

| File | What it is |
| --- | --- |
| `bodies/hand-0.png` | body sprite of the leftmost concealed hand slot, alpha + baked shadow, cropped from its measured shadow contour |
| `bodies/hand-0-back.png` | the same slot in the concealed pose (blue backing toward the camera) |
| `1m-upright.decal.png` | 492 × 672 px lit 1-man face decal (inset + 1 px gutter), rendered at 3× CSS |
| `1m-upright.composite.png` | body sprite with the decal homography-warped onto its face quad — the 2D composite the runtime will do |
| `contact-zoom.png` | 4× nearest zoom of the composite's top-left corner (blue rim, bevel streak, decal edge) |
| `contact-sheet.png` | body, composite, decal, concealed pose, the 4× zoom, the rig, the peak/clipping numbers and the manifest figures |
| `bodies/` | the spike batch's two body sprites (PNG, lossless review) |
| `manifest.json` | review manifest (version 3) for the one slot: rect, shadow contour, face quad, `faceMatrix`, orientation, draw order, the rig, decal size and carve, measurements (blue sliver, peaks, clipping, bake time) |

## Scope: back / face-down poses

Task 1 shipped only the face-up `hand-0` body plus a face-down diagnostic. Task 2
replaced that diagnostic with a real deliverable: every hand slot baked in both
poses. Task 2.5 carries that into the group model: each layout's `group` and
`draw` records have a nested `back` record, baked with the same
`hand-upright-back` pose and the same `bake_group` call, so a whole concealed row
is available at any seat transform. Tasks 5 and 11 call `bake_group` with their
own slots and their own seat transform, so nothing about the pose has to be
invented there.

## Next tasks

- Task 3: vendor all 38 symbol-only SVGs at the pinned commit, rasterise each, and
  render all five orientation classes per code; ship 2× WebP. Decide the decal
  resolution against this framing: a face is 74 × 77 device px, so the spike's
  492 × 672 render is an ~8.7× minification and a 1 px fillet highlight cannot
  survive it. `compositeSupersample` only changes the review composite, not the
  runtime texture. Fill the manifest's `faces` map.
- Task 4: the runtime reads `background`, `backgroundPixels`, `pixelRatio`, picks a
  layout from `(count, hasDraw)`, draws `group` and `draw` at their published
  rects, then composites each slot's decal with that slot's `faceMatrix`; it never
  projects a quad and never draws a body per slot. Fall back to the top-down view
  if the assets fail to load.
- Tasks 5–8, 11: add their groups to the same spec/scene and bake with the same
  `bake_group`/`build_table` helpers. A static group (an opponent's concealed row,
  a wall segment) is one bake; a group that grows per call or per draw needs
  per-tile bodies *plus* one group shadow layer — decide per group and record it.
  Pass the seat transform as the slots' `x`/`y`, and reuse the `hand-upright-back`
  pose for concealed rows. Re-read `manifest.rig`, `manifest.table.plan` and
  `manifest.camera` rather than assuming light or table positions, and pick
  draw-order bands (0–39 wall/river/meld, 40–53 the hand's bodies and decals,
  60+ overlays) so a stacked row can never overdraw the wrong tile. Keep the
  shipped `parlor` rig and the Task 2 camera: both are baked into every sprite.
- Keep `node_modules/` and `build/` out of git; keep the spec as the only place
  numbers live.
