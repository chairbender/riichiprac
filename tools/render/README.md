# Offline rendered-table asset pipeline

This directory builds the baked sprites for the opt-in **rendered** table view
(see [`rendered-table-plan.md`](../../rendered-table-plan.md)). It is a
developer-only asset pipeline: nothing here is bundled, imported, or shipped by
the frontend. The runtime is a 2D sprite compositor, so all perspective,
lighting, bevel highlights, and shadows are baked here.

The pipeline builds two batches from one scene, spec, and script:

- **shipped batch** (default) — the table background, one body sprite per hand
  slot in both poses (the concealed row closed up flush, with a separated
  draw), and the manifest, written to `frontend/public/table/`. Task 2 delivered
  this batch; Tasks 5–11 add their own slots to the same scene.
- **spike batch** (`--spike`) — the Task 1/1.5 review artifact: one hand-slot
  body, its concealed pose, the carved face decal, the homography composite, and
  the contact sheet, written to `tools/render/spike/`. Never shipped.

Two light rigs are baked from the same scene. Bodies, the table, and the
background use the **body rig** (`lightRig`, the `keyfill` preset: a front-left
key plus a front-right fill). The carved face decal uses its **own** rig
(`decals.lightRig`, the `parlor` strips), because the strip-light streak is what
the engraving was tuned against. The bake swaps the lights around the decal
pass; the manifest records both rigs.

Task 1 proved the pipeline end to end on one tile and one decal; Task 1.5
replaced its single studio key with a parlor strip rig; Task 2 added the table
and the whole hand row. Task 3 extends the decal batch to the full 38-code ×
5-orientation set.

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
   `--python-exit-code 1` so failures are loud): the background, then every body
   sprite, then the alignment reference frame;
2. composites the hand row over the background exactly as the runtime will and
   writes the review images to `build/review/`: `hand-face-up.png`,
   `hand-face-down.png`, their `-closeup.png` 1:1 device-pixel rows, and
   `hand-face-up-seam-zoom.png`, a 4× nearest zoom of the first concealed seam;
3. verifies the result with `scripts/check-assets.mjs` (dependency-free, so the
   same command runs in CI): every referenced file exists at the size the
   manifest publishes, every slot rect sits inside the scene, every face and
   decal quad sits inside its body sprite, every `faceMatrix` reproduces its
   `decalQuad`, both rigs are recorded, and the batch is inside the asset
   budget.

The spike batch additionally installs `tools/render`'s Node dependencies with
`npm ci` on the first run (the directory is gitignored, forever offline after
that), rasterises the vendored face SVG with resvg
(`scripts/rasterize-face.mjs`), and assembles the labelled contact sheet with
resvg (`scripts/contact-sheet.mjs`).

One shipped batch is a few minutes on a CPU-only machine: the 28 body sprites are
small border renders (a couple of seconds each) and the background is the bulk of
it. The scene's 256-sample setting applies to the sprites; the background is a
full frame of broad, low-frequency lighting, so `assets.background.samples` (64)
plus OIDN renders it in ~2 minutes with no visible difference — that is a
deliberate, recorded deviation from the scene's 256, because a full 2880 × 1800
frame at 256 is several times the cost of every sprite in the batch. The spike's
carved decal is ~90 s. There is no manual
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
- **lighting**: a **decal-rig preset** switch (`studio` = the Task 1 softbox,
  `parlor` = ceiling strips), tube **count** (2–4), and per-tube **azimuth /
  elevation / roll / offset / length / width / power**, plus bounce power, the
  parlor rim and ambient strength. The key / fill / rim controls always edit the
  **body rig** (`lightRig`, the `keyfill` preset), which is what the full-tile
  preview's body and bevels are lit by. The compass draws every tube as a bar at
  its azimuth turned by its roll, so which fixture covers which wall is visible;
  the other rig keeps its numbers untouched while you tune one;
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
| `scene-spec.json` | yes | the single source of truth: tile proportions and bevel, melamine/paint/table materials, table plan dimensions, camera, `lightRig` + `decals.lightRig` + `lightPresets` (keyfill, studio, parlor), colour management, hand layout, carve, decal rig, composite sampling, asset format/budget, checks, output names |
| `build_and_render.py` | yes | builds the whole scene from the spec with `bpy`, renders the table background and every body sprite, carves the symbol, projects, warps the decal, checks alignment, measures, writes the manifest |
| `scripts/check-assets.mjs` | yes | dependency-free manifest/asset/budget validator (also the CI gate) |
| `scripts/rasterize-face.mjs` | yes | vendored symbol-only SVG → paint colour + carve mask PNG (resvg) |
| `scripts/contact-sheet.mjs` | yes | renders the spike review sheet SVG → PNG (resvg) |
| `tune.mjs`, `tune.html` | yes | local parameter tuner (dev only, never shipped) |
| `faces/` | yes | vendored public-domain symbol-only SVGs + provenance (`faces/SOURCE.md`) |
| `spike/` | yes | Task 1/1.5 review outputs: body sprite, concealed pose, decal, composite, zoom, contact sheet, review manifest |
| `../../frontend/public/table/` | yes | the shipped batch: `background.webp`, `bodies/*.webp`, `manifest.json` |
| `node_modules/`, `build/`, `tune-spec.json` | no | installed dependencies, intermediate renders, and the review composites (`build/review/hand-face-up.png`, `hand-face-down.png`, their `-closeup.png` crops, `hand-face-up-seam-zoom.png`) |

Generated sprites are never hand-edited. A regeneration commits the spec/script
change together with the regenerated assets under `frontend/public/table/` (or
`spike/` for the review batch).

## Scene and coordinate conventions

World units are tile units, and the tile follows the **jansou proportions**:
28 × 21 × 16.5 mm (height × width × thickness), including the backing. The spec
owns that ratio plus one world height (`heightUnits`), and the script derives
width and thickness, so the box can never drift from the ratio. At height 1.0 the
face is 0.75 × 1.0 and the thickness 0.58929. Bevel width 0.055 (= `faceInset`;
Task 2.5 raised both from 0.035 so the abutting row's groove reads).
**With the 0.055 inset the flat face measures 69.89 × 73.68 device px and the
spike decal 463 × 643**; the 74.3 × 77.0 face and 492 × 672 decal quoted in the
Task 2/1 sections below are the pre-Task-2.5 measurements of the same framing.
Tiles are modelled flat (face up +Z, symbol top +Y). The `hand-upright` pose
rotates the tile 90° about X so the face points at the player (−Y) and the tile
stands on the table; `hand-upright-back` turns the same slab 180° about Z so the
blue backing faces the camera (the concealed-hand pose). Both poses stand on the
same felt footprint.

The scene is one fixed perspective camera (65 mm on a 36 mm sensor, 2880 × 1800
device pixels = 1440 × 900 CSS at `pixelRatio: 2`), a shadow-catcher felt plane,
AgX colour management with denoised Cycles, and **two area rigs baked from that
one scene**: the body/table rig (`lightRig`, `keyfill`: front-left key +
front-right fill) and the decal rig (`decals.lightRig`, `parlor`: 2 tubes +
bounce + rim). The manifest records both as `rig` and `decals.rig`.

**Manifest coordinates are rendered device pixels** (top-left origin, y down,
sprite-intrinsic). Divide by `pixelRatio` for CSS. A slot rect is exactly the
body sprite's destination: `x, y, width, height` are the crop's device-pixel
bounds, *including* the 32 px shadow gutter, so the runtime never guesses an
anchor. `faceQuad` and `decalQuad` are in the same absolute space.
`faceMatrix` is a CSS `matrix3d` that maps the decal image's own pixel rect
(top-left origin, y down) onto `decalQuad`; the runtime applies it verbatim and
never projects a quad itself.

## Task 2 results: the table, the hand row, and the alignment check

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

### Hand slots

The human's row is 13 concealed slots **flush at one tile width** (`spacing:
"touch"`, 0.75 units) plus **the separated draw**: `hand-draw` sits 0.55 units
past the last concealed slot, which is the gap the app's dock already shows
between `player.hand` and `player.draw`. The row *including* the draw is centred
on `hand.centerX`, so the runtime can append the drawn tile by index without
re-centring anything. Ids are `hand-0` … `hand-12` and `hand-draw`; `role` is
`concealed` or `draw`. `hand.spacing` may also be an explicit number; the
manifest records `spacingUnits`, `spacingMode`, and the measured composite numbers
under `measurements.hand`.

Every slot is baked in both poses (`hand-upright` and `hand-upright-back`), so a
concealed row can be drawn at these slots today and Tasks 5/11 reuse the same
pose at their own seat transforms. The back pose is a separate file (`<id>-back`)
and a nested `back` record with its own rect; it has no face quad. Draw order is
`40 + index` (13 concealed + draw = 40…53), which reserves 0–39 for the wall,
rivers, and melds and leaves 54+ for later overlay bands. Nothing overlaps inside
the row itself, but a per-slot order keeps the manifest's "unique draw order"
check meaningful. At the flush pitch the *body rects* (tile plus 32 px shadow
gutter) overlap heavily even though the tiles abut; that is the per-tile shadow
model, not a tile overlap.

### Background bake

The background is one Cycles render from the same camera with the film made
opaque and the felt's shadow catcher turned off, so the felt, track, aprons,
compass plate, rail, and the room floor outside the rail are all lit normally.
It renders at the scene resolution (2880 × 1800) and is box-filtered ×2 down to
**1440 × 900 WebP q90** (§9's background size), which is also `backgroundPixels`
in the manifest. Body sprites stay at 2× device pixels.

### Alignment check: sprites really do land on the background

The batch is checked, not just eyeballed. After all 28 sprites are baked, the
script renders one 8-sample reference frame with **every** slot's tile in the
scene at once, and pastes every sprite's tile-only alpha at its manifest rect
(draw order applied). The two are compared with a one-pixel dilation so
anti-aliasing and denoiser softness are ignored: any disagreement left is a real
shift. The shipped batch reports **0 shifted pixels** out of 137,914 tile pixels,
which is what "sprites align with the background" means here — a crop or a rect
off by one pixel fails the bake.

A second, human-readable artifact proves the same thing over the real
background: `build/review/hand-face-up.png` and `hand-face-down.png` composite
the whole row exactly as the runtime will (device pixels, then box-filtered for
viewing). The Task 2.5 batch adds the 1:1 device-pixel `-closeup.png` crops and
`hand-face-up-seam-zoom.png` (4× nearest) so the flush pitch can be inspected
without rescaling the table. They are gitignored review images, not assets.

### Format, budget, and what the batch weighs

Task 2.5 values (the Task 2 numbers in the plan are the pre-flush batch):

| Asset | Format | Size |
| --- | --- | --- |
| background | WebP q90, 1440 × 900, 64 samples | 16,572 B |
| body sprites | WebP q90 with alpha, 2× device px | 120,590 B (28 files, ~4.3 KB each) |
| manifest | JSON (v2) | 26,245 B |

The sprites and background are 137 KB, 160 KB with the manifest, against the
plan's 8 MB total / 1 MB body budgets, and the
`table` and `manifest` byte budgets are enforced by both the bake and
`scripts/check-assets.mjs` (the manifest budget is set to 50 KB, with the
manifest currently ~26 KB of that). The manifest is deliberately verbose —
per-slot measurements, both rigs, and the check results — because it is the
pipeline's audit trail; Task 4 can strip a runtime projection of it if the load
weight ever matters.

## Task 2.5 results: the flush per-tile hand and the split rigs

The hand is one body sprite per slot again (the alternative, one body for the
whole row, cannot lift a single tile on hover). `hand.spacing` is `"touch"`, so
the concealed pitch is the tile width: **0.75 units, 81.9 device px between face
centres**. The face row including the separated draw is **1201 device px (600
CSS)** wide. Slot ids, poses, draw order, and the 32 px shadow gutter are
unchanged; the alignment check still reports **0 shifted pixels** of 137,914 and
**0% soft edge**, so the flush geometry lands exactly on the background.

The per-tile composite's cost is measured, not asserted:

| Measurement | Value |
| --- | --- |
| adjacent body rects overlap | 70.0 device px (median) |
| sprites whose baked shadow touches the crop border | 14 / 14 |
| border pixels above the 0.02 shadow threshold | 24.1% (mean) |

So every sprite's cast shadow is clipped by its own 32 px gutter (the standing
tile's shadow is much wider than the gutter), and at the flush pitch each
sprite's clipped shadow is pasted over its neighbour. The review artifacts are:

- `build/review/hand-face-up.png` / `hand-face-down.png` — the row over the baked
  background, downsampled for viewing;
- `build/review/hand-face-up-closeup.png` (1326 × 238) and
  `hand-face-down-closeup.png` — the same row at 1:1 device pixels;
- `build/review/hand-face-up-seam-zoom.png` (480 × 440) — 4× nearest zoom of the
  first concealed seam, where the abutting bevels and any shadow overdraw are
  visible at baked resolution.

The lighting split is also measured:
`manifest.rig` = `keyfill` (key + fill), `manifest.decals.rig` = `parlor`
(tubes + bounce + rim). The keyfill background has **no clipped pixels**; the
felt below the hand row reads about RGB(1, 88, 54) and the far felt
RGB(0, 46, 26), so the new key is directional and the far side is darker than
the old overhead parlor coverage. The spike's decal bake is byte-for-byte the same parlor rig as
before: decal peak 241/255, body peak 254/255, 0 clipped, seam step 1.2% on the
lit edge and ~10% on the key-shadowed bevel (see "Seam tolerance with split
rigs").

A human should judge the review images; the numbers above only say what the
model does.

## Findings and decisions (Task 1, updated by Task 1.5)

Measured from `spike/` and the `measurements` block of `spike/manifest.json`.

### Body sprite: real slot, position-dependent shading

`hand-0` is the leftmost of the hand row (13 concealed slots flush at one tile
width since Task 2.5, row at y = −11.7), so the sprite is baked where that tile
will actually sit, not on a neutral stage. The slot is left of the camera axis,
which is what makes the shading position-dependent: the near (left) bevel catches
the key light, the right bevel falls into the fill, and the right side of the
body is visible at all
(the face quad is a true trapezoid: top edge 74.66 px, bottom edge 73.86 px,
centre sheared ~6.9 px). A slot at the row centre would lose the side face and
flatten the bevel contrast. The crop is 159 × 190 device px including the 32 px
shadow gutter. On the visible side the white front band meets the blue rear band
at the backing line, which is what makes the wrap read as a physical backing
rather than a painted stripe. (The Task 1 numbers in this section were measured
on the 100 px/unit spike camera; the geometry and the material behaviour are
unchanged, the tile is simply smaller on screen now.)

Bevel: width 0.055, 6 segments, miter arc, `harden_normals`, weighted normals,
shade smooth. Task 2.5 widened it from 0.035 with 4 segments: at 0.035 the groove
between two abutting tiles was too shallow to read, and six segments keep the
wider arc from looking faceted at 2×.

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

The decal is the inner face inset by `faceInset = 0.055` on every edge, cropped
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

### Seam tolerance with split rigs (Task 2.5)

The decal is lit by the **parlor** rig and the body by **keyfill**, so the seam
is a real material boundary, not a matched pair: the flat carved face is lit
face-on and uniformly, while the body bevel beside it turns away from the
front-left key. Measured on the Task 2.5 spike, sampling 3 device px either side
of the decal's edge at mid-face:

| Sample | sRGB |
| --- | --- |
| decal face, inside left | RGB(225, 224, 221) |
| body, outside left | RGB(225, 222, 218) → **1.2%** max-channel step |
| decal face, inside right | RGB(225, 223, 221) |
| body, outside right | RGB(200, 201, 203) → **~10%** step |

The left edge is effectively seamless because the bevel there faces the key; the
right edge is darker because that bevel turns away, and the old all-parlor
composite showed the same left-bright / right-dark fall-off (≈0.87 vs ≈0.76 in
the same sample space). It is the bevel model, not a split-rig regression. If a
more symmetric seam is wanted, move the body key toward azimuth 0 in the tuner;
the decal bake is unaffected.

The body's flat face under keyfill reads RGB(197, 195, 194) at every hand slot —
0.9% spread across the row — but it is covered by the decal and is not the seam
surface. The exposed surfaces are the decal face and the bevel, above.

The decal rig is still distant and large (56-unit throw, 40-unit tubes), so the
position-independence constraint above holds unchanged. The Task 2 camera looks
down at 33.7° rather than 18°, so a tube's bevel streak sits at
`θn = (θL + 33.7°) / 2` on a body bevel and `θL / 2` on the face-on decal rig;
the decal's streak still lands on the up-facing fillets.

Across the whole Task 2 hand row under the parlor rig, the upright body face
underlay read RGB(228, 226, 224) at the left end and RGB(229, 228, 226) at the
right: under 1% variation, so a once-lit `upright` decal sits at every hand slot.
The side seats' decal faces read RGB(204, 208, 215) / RGB(207, 210, 215) — a real
per-class difference, which is why flat tiles get their own orientation-class
decal rigs in Task 3. Re-check that the flat classes are as even across the table
as the hand row is: the rig's targets are near the human's edge, and a far-wall
flat tile sees a different exposure than one in the human's river.

### Lighting: two rigs from one scene (Task 2.5), parlor kept for the decal

Task 1.5 established the **mahjong parlor** look for the carved face: long,
narrow fluorescents overhead, mirrored in the glossy melamine as thin streaks
along the up-facing bevels and the lower wall of every engraved stroke. Task 1
shipped one huge 26 × 20 area key, which is a studio softbox: a broad sheen that
needed a deep carve and a near-clipping key just to show an edge. Task 1.5
replaced it with strips.

Task 2.5 splits the lighting by what is being baked. **Bodies, the table and the
background** use a conventional, predictable **key + fill** (`lightRig =
"keyfill"`). **The carved face decal** keeps the parlor strips
(`decals.lightRig = "parlor"`), because those strips are the look the engraving
was tuned against. The bake builds the body rig, bakes the bodies and the
background, then swaps the scene lights to the decal rig for the decal pass and
restores the body rig afterwards. The manifest records both:
`rig` (body/table) and `decals.rig` (decal).

```json
"lightRig": "keyfill",
"decals": { "lightRig": "parlor" },
"lightPresets": { "keyfill": { ...key + fill... },
                  "studio": { ...Task 1 rig verbatim... },
                  "parlor": { ...tubes + bounce + rim... } }
```

`build_lights(scene, spec, rig)` resolves the named preset, skips entries with
`enabled: false` and honours `rollDeg`, so a strip is just a very elongated
`RECTANGLE` area light turned about its own aim axis. `group` (`key` / `fill` /
`tube` / `bounce` / `rim`) lets the tuner and the manifest address lights without
positional assumptions; the manifest's two `rig` blocks record each preset and
every light that was actually built, so later tasks never guess the placement.

#### The shipped keyfill body/table rig (Task 2.5)

| Light | Placement | Size | Power | Role |
| --- | --- | --- | --- | --- |
| `key` | azimuth 315, elevation 55, 45 units out, target y −6 | 18 × 18 | 90 kW | warm front-left key: tile face, bevels, near table |
| `fill` | azimuth 45, elevation 22, 38 units out, target y −4 | 22 × 22 | 10 kW | cool front-right fill; lifts the shadow side without owning a highlight |

The key/fill ratio is deliberately conventional (roughly 3:1 on the tile face):
predictable and easy to re-aim in the tuner. The felt/track/rail palette was
tuned under the old all-parlor rig, so the first keyfill background is a look to
re-judge, not a palette that must stay byte-identical.

#### The parlor decal rig: where the streak lands

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
| `tube-0` | azimuth 0, elevation 50, 56 units out | 40 × 2.5 | 85 kW | lights up-facing walls; the decal's top-wall streak |
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

Measured on the Task 2.5 spike: body peak **254/255** (the keyfill key on the
tile bevel), decal peak **241/255**, zero clipped pixels in either; the decal
bake is **80 s** at 256 samples. The parlor read is a decal property now: every
stroke fillet carries its own streak on the decal (see the 1:1 composite panel,
where the sub-pixel highlight reads as the deliberate "sparkle" described below).
The tile bodies no longer use the parlor strips, so their bevel is lit by the
keyfill key and fill.

**Parlor vs studio (the decal rig).** Pick `decals.lightRig: "studio"` (or the
tuner's preset switch) to reproduce Task 1's decal lighting exactly: key azimuth
0 / elevation 77 / 56 units / 200 kW, fill 45 / 11 / 34 / 23 kW, rim 170 / 45 /
40 / 22 kW, ambient 0.5. That is the softbox look the strips replace.

**Key/fill practice still applies to the body rig.** The key is the dominant
light; the fill is soft, dim and near the camera axis and must not own a
highlight. Watch the fill direction: at azimuth 0 / elevation 32 (or 25° / 12°) a
frontal light sits near the face's specular mirror and puts a broad white sheen
on the body's glossy melamine.

### The decal rig must be position-independent (§5/§12.3 consequence)

The decal is lit once per orientation, but it is composited onto body sprites at
many positions. A close area rig made the face 24–30% brighter at `hand-0` than
at the hand-row centre (where the canonical upright rig sits), which showed as a
visible rectangle around the decal.

The **decal rig** is therefore distant and large (parlor tubes at 56 units), so
the illumination varies by only a few percent across the hand row. It still gets
a soft gradient and vertical-vs-flat lighting still differs strongly, which is
what the orientation classes need. **Task 3 must keep the decal rig distances in
this range** or decals will no longer sit flush on distant slots. The body rig
does not share this constraint: each body sprite is baked in place, so its
position-dependent shading is correct by construction.

### Shadows: two-pass shadow catcher, baked into the body sprite (§12.7 confirmed)

Each body render is two passes:

1. the tile alone with transparent film (straight alpha);
2. the felt as a Cycles **shadow catcher** with the tile set
   `visible_camera = False`, so it is invisible to the camera but still
   occludes the lights. This pass returns the contact shadow as a black colour
   with **alpha = shadow coverage** (not an opaque grey patch).

The two are combined in `numpy` (tile over shadow) and written as one RGBA
sprite, with the crop grown by the 32 px gutter. Every other table part (rail,
track, aprons, compass plate, room floor) is hidden in both passes: the
background already carries their shading, and their shadows must not be counted
twice. The measured `hand-0` crop is `158 × 190` device px; a crop that touches
the *scene* frame edge fails the bake. The cast shadow is much wider than the
32 px gutter, so at the flush pitch **14 / 14 sprites have shadow on their crop
border** (24.1% of border pixels above the 0.02 alpha threshold): each sprite's
shadow is cut off at its own rectangle and pasted over its neighbour. That is a
property of the per-tile model, measured in `measurements.hand` and visible in
the review composites, not something the contract can hide.
The shadow is neutral black alpha, i.e. a multiply-like darkening; over the green
felt this reads correctly, and it is the same approximation §12.7 specifies
(no runtime shadow layer, no CSS shadow).

The body sprite has no felt underlay, so it composites over the baked background
without a mask. Bounce light from the felt is not included (the felt is invisible
in pass 1); the green bounce is negligible on white melamine at this exposure and keeps
body and decal lighting consistent.

### Orientation-lit decal

The decal is rendered on the canonical face-on **orthographic** rig (§12.3):
`upright` stands the tile at the hand-row centre facing the ortho camera, with
the orthographic frame exactly the inset + gutter (463 × 643 px at 3× CSS with
the 0.055 inset). The
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
| `bodies/hand-0.png` | 158 × 190 device px body sprite for the leftmost hand slot, alpha + baked shadow (Task 2.5 crop) |
| `bodies/hand-0-back.png` | the same slot in the concealed pose (blue backing toward the camera) |
| `1m-upright.decal.png` | 463 × 643 px lit 1-man face decal (inset + 1 px gutter), rendered at 3× CSS |
| `1m-upright.composite.png` | body sprite with the decal homography-warped onto its face quad — the 2D composite the runtime will do |
| `contact-zoom.png` | 4× nearest zoom of the composite's top-left corner (blue rim, bevel streak, decal edge) |
| `contact-sheet.png` | body, composite, decal, concealed pose, the 4× zoom, the rig, the peak/clipping numbers and the manifest figures |
| `bodies/` | the spike batch's two body sprites (PNG, lossless review) |
| `manifest.json` | review manifest (version 2) for the one slot: rect, face quad, `faceMatrix`, orientation, draw order, the rig, decal size and carve, measurements (blue sliver, peaks, clipping, bake time) |

## Scope: back / face-down poses

Task 1 shipped only the face-up `hand-0` body plus a face-down diagnostic. Task 2
replaced that diagnostic with a real deliverable: **every** hand slot is baked in
both poses, and the shipped manifest gives each slot a nested `back` record with
its own sprite and rect. The concealed pose uses the same `hand-upright-back`
pose and `bake_body` call; Tasks 5 and 11 bake their own slots at their own seat
transforms, so nothing about the pose has to be invented there.

## Next tasks

- Task 3: vendor all 38 symbol-only SVGs at the pinned commit, rasterise each, and
  render all five orientation classes per code; ship 2× WebP. Bake every decal
  under `decals.lightRig` (the parlor strips), not the body/table rig. Decide the
  decal resolution against this framing: a face is 74 × 77 device px, so the
  spike's 492 × 672 render is an ~8.7× minification and a 1 px fillet highlight
  cannot survive it. `compositeSupersample` only changes the review composite,
  not the runtime texture. Fill the manifest's `faces` map.
- Tasks 5–8, 11: add their slots to the same spec/scene and bake with the same
  `bake_body`/`build_table` helpers. Re-read `manifest.rig`, `manifest.table.plan`
  and `manifest.camera` rather than assuming light or table positions, and pick
  draw-order bands (0–39 wall/river/meld, 40–53 the hand row as shipped, 60+
  overlays) so a stacked row can never overdraw the wrong tile. Bodies use
  `manifest.rig` (`keyfill`); decals use `manifest.decals.rig` (`parlor`). Keep
  the Task 2 camera: it is baked into every sprite. Opponent hand rows reuse the
  same flush pitch unless their seat transform needs a different one.
- Task 4: the runtime reads `background`, `backgroundPixels`, `pixelRatio`, and
  each slot's `body`/rect/`faceMatrix`; it never projects a quad. Fall back to the
  top-down view if the assets fail to load.
- Keep `node_modules/` and `build/` out of git; keep the spec as the only place
  numbers live.
