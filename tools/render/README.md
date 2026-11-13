# Offline rendered-table asset pipeline

This directory builds the baked sprites for the opt-in **rendered** table view
(see [`rendered-table-plan.md`](../../rendered-table-plan.md)). It is a
developer-only asset pipeline: nothing here is bundled, imported, or shipped by
the frontend. The runtime is a 2D sprite compositor, so all perspective,
lighting, bevel highlights, and shadows are baked here.

Task 1 (spike) proves the pipeline end to end on one tile: one hand-slot body
sprite and one lit face decal. Task 1.5 replaces its single studio key with a
parlor strip rig (see the lighting section below). Tasks 2 and 3 extend it to the
whole table and the full 38-code × 5-orientation decal set.

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

There is **no headless browser, no `sharp`, and no system `rsvg`** in the
pipeline. resvg-js is the only SVG rasteriser, matching §12.14 of the plan.

## Regenerate (one command)

```bash
bash tools/render/render.sh
```

That command:

1. installs `tools/render`'s Node dependencies with `npm ci` on the first run
   (the directory is gitignored, forever offline after that);
2. rasterises the vendored face SVG with resvg (`scripts/rasterize-face.mjs`);
3. builds the scene and renders with headless Blender
   (`build_and_render.py`, `--python-exit-code 1` so failures are loud);
4. assembles the labelled contact sheet with resvg
   (`scripts/contact-sheet.mjs`).

It takes about 1 m 40 s on this machine at 256 samples (the carved decal is
~67 s of that). There is no manual
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
| `scene-spec.json` | yes | the single source of truth: tile proportions and bevel, melamine/paint materials, camera, `lightRig` + `lightPresets` (studio and parlor), colour management, hand layout, carve, decal rig, composite sampling, output names |
| `build_and_render.py` | yes | builds the whole scene from the spec with `bpy`, renders, carves the symbol, projects, warps the decal, measures, writes the manifest |
| `scripts/rasterize-face.mjs` | yes | vendored symbol-only SVG → paint colour + carve mask PNG (resvg) |
| `scripts/contact-sheet.mjs` | yes | renders the review sheet SVG → PNG (resvg) |
| `tune.mjs`, `tune.html` | yes | local parameter tuner (dev only, never shipped) |
| `faces/` | yes | vendored public-domain symbol-only SVGs + provenance (`faces/SOURCE.md`) |
| `spike/` | yes | Task 1 spike outputs: body sprite, back diagnostic, decal, composite, zoom, contact sheet, starter manifest |
| `node_modules/`, `build/`, `tune-spec.json` | no | installed dependencies and intermediate preview files |

Generated sprites are never hand-edited. A regeneration commits the spec/script
change together with the regenerated `spike/` files (or, from Task 2 on, the
shipped assets under `frontend/public/table/`).

## Scene and coordinate conventions

World units are tile units, and the tile follows the **jansou proportions**:
28 × 21 × 16.5 mm (height × width × thickness), including the backing. The spec
owns that ratio plus one world height (`heightUnits`), and the script derives
width and thickness, so the box can never drift from the ratio. At height 1.0 the
face is 0.75 × 1.0 and the thickness 0.58929. Bevel width 0.035 (= `faceInset`).
Tiles are modelled flat (face up +Z, symbol top +Y). The `hand-upright` pose
rotates the tile 90° about X so the face points at the player (−Y) and the tile
stands on the table.

The scene is one fixed perspective camera (65 mm on a 36 mm sensor, 2880 × 1800
device pixels = 1440 × 900 CSS at `pixelRatio: 2`), a preset area rig
(`parlor`: 2 tubes + bounce + rim), a
shadow-catcher felt plane, and AgX colour management with denoised Cycles.

**Manifest coordinates are rendered device pixels** (top-left origin, y down,
sprite-intrinsic). Divide by `pixelRatio` for CSS. A slot rect is exactly the
body sprite's destination: `x, y, width, height` are the crop's device-pixel
bounds, *including* the 32 px shadow gutter, so the runtime never guesses an
anchor. `faceQuad` and `decalQuad` are in the same absolute space.
`faceMatrix` is a CSS `matrix3d` that maps the decal image's own pixel rect
(top-left origin, y down) onto `decalQuad`; the runtime applies it verbatim and
never projects a quad itself.

## Findings and decisions (Task 1, updated by Task 1.5)

Measured from `spike/` and the `measurements` block of `spike/manifest.json`.

### Body sprite: real slot, position-dependent shading

`hand-0` is the leftmost of the spec's 14 hand slots (spacing 0.82, row at
y = −4.4), so the sprite is baked where that tile will actually sit, not on a
neutral stage. The slot is left of the camera axis, which is what makes the
shading position-dependent: the near (left) bevel catches the key light, the
right bevel falls into the fill, and the right side of the body is visible at all
(the face quad is a true trapezoid: top edge 151.1 px, bottom edge 149.3 px,
centre sheared 14 px). A slot at the row centre would lose the side face and
flatten the bevel contrast. The crop is 271 × 315 device px including the 32 px
shadow gutter. On the visible side the white front band meets the blue rear
band at the backing line, which is what makes the wrap read as a physical
backing rather than a painted stripe.

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
visible side, and from behind the tile is solid blue (see the back diagnostic).

At the hand slot the raised camera projects the 0.58929-unit top edge to
**43.75 device px**, of which the blue run measures **11 device px** (expected
13.12; the top bevel arc eats the difference) on a **191.92 device px** face.
That is ~5.5 CSS px of blue above a ~96 CSS px face — a visible line, not a
stripe, and it survives at the shipped 2× size.

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
while `hand-0` sits 5.3 units to its left, not a base-colour mismatch. It is
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

The decal is baked at 3× CSS and lands on a ~192 device px face, so the review
composite is a **~3.75× minification**. `warp_onto` takes one bilinear sample
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

The real lesson for Task 3: a 1 px highlight cannot survive a 3.75×
minification whatever the filter, so the streak has to be resolved by shipping a
decal closer to its display size (or a display-sized companion), not by relying
on filtering.

### Seam tolerance after the rig change (Task 1.5)

Re-checked at the shipped 2× size on the regenerated spike: sampling the
composite either side of the decal's left edge at mid-face, the body's face
reads ≈ RGB(221, 221, 219) and the decal's flat face ≈ RGB(225, 223, 220) — about
1.7% brighter, the same difference as Task 1 (the canonical rig sits at the hand
row's centre while `hand-0` sits 5.3 units left of it), and it remains invisible
in the contact-sheet zoom.

The parlor rig is still distant and large (56-unit throw, 40-unit tubes), so the
position-independence constraint above holds unchanged; the tube targets span
0.6…3 units along Y, which is small against that throw.

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

Measured on the regenerated spike: body peak **250/255**, decal peak
**242/255**, zero clipped pixels in either; the decal bake is **~67 s** at 256
samples (Task 1: ~82 s), so adding fixtures did not cost bake time. At the
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

### Shadows: two-pass shadow catcher, baked into the body sprite (§12.7 confirmed)

Each body render is two passes:

1. the tile alone with transparent film (straight alpha);
2. the felt as a Cycles **shadow catcher** with the tile set
   `visible_camera = False`, so it is invisible to the camera but still
   occludes the lights. This pass returns the contact shadow as a black colour
   with **alpha = shadow coverage** (not an opaque grey patch).

The two are combined in `numpy` (tile over shadow) and written as one RGBA PNG,
with the crop grown by the 32 px gutter. The measured crop is
`271 × 315` device px with the whole shadow inside it (`clipped: false`).
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
the orthographic frame exactly the inset + gutter (492 × 672 px at 3× CSS). The
scene light rig and melamine material are reused, so the face is genuinely lit,
and because the camera is face-on (`θv = 0`) a tube at elevation `θL` puts its
streak where the wall normal is `θL / 2` — the parlor band on the stroke walls.
The AgX transform keeps the white warm. Flat classes will differ in brightness
because they meet the tubes at a different angle; Task 3 bakes them the same way
with the symbol rotated 0/90/180/270°.

## Spike assets

`spike/` is a review artifact, not a shipped asset. It is lossless PNG so the
bevel and alpha can be inspected; Task 2/3 ship 2× lossy WebP under
`frontend/public/table/` per the asset budget (§9).

| File | What it is |
| --- | --- |
| `hand-0.body.png` | 271 × 315 device px body sprite for the leftmost hand slot, alpha + baked shadow |
| `1m-upright.decal.png` | 492 × 672 px lit 1-man face decal (inset + 1 px gutter), rendered at 3× CSS |
| `1m-upright.composite.png` | body sprite with the decal homography-warped onto its face quad — the 2D composite the runtime will do |
| `hand-0.back.png` | face-down diagnostic of the same slot (blue backing toward the camera); proves the wrap, not a shipped pose |
| `contact-zoom.png` | 4× nearest zoom of the composite's top-left corner (blue rim, bevel streak, decal edge) |
| `contact-sheet.png` | body, composite, composite at shipped 2× (1:1), decal, back diagnostic, the 4× zoom, the rig, the peak/clipping numbers and the manifest figures |
| `manifest.json` | starter manifest (version 1) with the rig, slot rect, face quad, `faceMatrix`, orientation, draw order, decal size and carve, and the measurements (blue sliver, peaks, clipping, bake time) |

## Scope: back / face-down poses

Task 1's acceptance is one face-up hand-slot body sprite and one lit decal, so
only the `hand-0` face-up body is a real deliverable here (Task 1.5 re-baked the
same slot with the parlor rig). The `hand-0.back.png`
render is a **diagnostic**: it exists to prove the blue backing wraps the whole
body, and it is not referenced by the manifest.

Real face-down bodies belong with the full body-pose bake in Task 2 (the slot
inventory, including concealed hands) and are consumed by Task 5 (opponent
concealed hands) and Task 11 (wall/dora tiles). They use the same
`hand-upright-back` pose and `bake_body` call; there is nothing new to design,
just more slots and the draw order of a stacked back row. Task 2 should drop this
diagnostic from `spike/` once the real back poses exist.

## Next tasks

- Task 2: add the rest of the hand slots, rivers, melds, wall, and the table
  background to the spec; render the background from the same camera and write
  the full slot inventory and draw order. Keep the shipped `parlor` rig: it is
  baked into every body sprite and decal, so changing it re-bakes everything.
  Re-read `manifest.rig` rather than assuming light positions.
- Task 3: vendor all 38 symbol-only SVGs at the pinned commit, rasterise each, and
  render all five orientation classes per code; downsample 3× → 2× WebP. Decide
  the shipped decal resolution here: a 1 px fillet highlight is lost at the
  current ~3.75× minification, and `compositeSupersample` only changes the review
  composite, not the runtime texture.
- Keep `node_modules/` and `build/` out of git; keep the spec as the only place
  numbers live.
