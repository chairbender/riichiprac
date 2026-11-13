# Offline rendered-table asset pipeline

This directory builds the baked sprites for the opt-in **rendered** table view
(see [`rendered-table-plan.md`](../../rendered-table-plan.md)). It is a
developer-only asset pipeline: nothing here is bundled, imported, or shipped by
the frontend. The runtime is a 2D sprite compositor, so all perspective,
lighting, bevel highlights, and shadows are baked here.

Task 1 (spike) proves the pipeline end to end on one tile: one hand-slot body
sprite and one lit face decal. Tasks 2 and 3 extend it to the whole table and
the full 38-code × 5-orientation decal set.

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

It takes about 50 seconds on this machine at 256 samples. There is no manual
Blender interaction and no UI. The render is deterministic: the seed is fixed,
the samples are fixed, and repeated runs produce identical pixels (Blender's PNG
container bytes can differ, so compare decoded pixels, not file hashes).
Override the paths only for experiments:

```bash
BLENDER=/path/to/blender bash tools/render/render.sh [spec.json] [out-dir]
```

## Files

| Path | Committed | Purpose |
| --- | --- | --- |
| `scene-spec.json` | yes | the single source of truth: tile box, bevel, materials, camera, lights, colour management, hand layout, decal rig, output names |
| `build_and_render.py` | yes | builds the whole scene from the spec with `bpy`, renders, projects, warps the decal, measures, writes the manifest |
| `scripts/rasterize-face.mjs` | yes | vendored SVG → face texture PNG (resvg) |
| `scripts/contact-sheet.mjs` | yes | renders the review sheet SVG → PNG (resvg) |
| `faces/` | yes | vendored public-domain full-face SVGs + provenance (`faces/SOURCE.md`) |
| `spike/` | yes | Task 1 spike outputs: body sprite, back diagnostic, decal, composite, zoom, contact sheet, starter manifest |
| `node_modules/`, `build/` | no | installed dependencies and intermediate face textures |

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
device pixels = 1440 × 900 CSS at `pixelRatio: 2`), a 3-light area rig, a
shadow-catcher felt plane, and AgX colour management with denoised Cycles.

**Manifest coordinates are rendered device pixels** (top-left origin, y down,
sprite-intrinsic). Divide by `pixelRatio` for CSS. A slot rect is exactly the
body sprite's destination: `x, y, width, height` are the crop's device-pixel
bounds, *including* the 32 px shadow gutter, so the runtime never guesses an
anchor. `faceQuad` and `decalQuad` are in the same absolute space.
`faceMatrix` is a CSS `matrix3d` that maps the decal image's own pixel rect
(top-left origin, y down) onto `decalQuad`; the runtime applies it verbatim and
never projects a quad itself.

## Task 1 findings and decisions

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
shadow gutter. On the visible side the ivory front band meets the blue rear
band at the backing line, which is what makes the wrap read as a physical
backing rather than a painted stripe.

Bevel: width 0.035, 4 segments, miter arc, `harden_normals`, weighted normals,
shade smooth. Four segments is enough to hold a clean highlight at 2× without
looking faceted.

### Blue backing: wraps every edge, no forward lean (§12.6, corrected)

The tile is an ivory face plate on a **solid blue backing**. The blue is not a
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
key-lit top edge. A brighter royal base (e.g. `#4169e1`) renders as a pastel
periwinkle under this key and AgX; keep the base dark to keep the blue deep.

No forward lean and no separate sliver sprite are needed: the blue rim is the
same geometry as the body, so it moves with the tile and its contact shading.
The ivory front band reads as the face plate's edge and blends into the face; do
not add a third material for it. If a fully blue side is wanted instead of a
backed plate, set `backEdgeFraction` to 1.0 — no script change.

### Decal inset and blending (§12.2 confirmed)

The decal is the inner face inset by `faceInset = 0.035` on every edge, cropped
to that rectangle plus a **1 px transparent gutter**. The Blender decal plane
takes the inset sub-rect of the full-face texture as its UVs, so the symbol is
not stretched.

The body's face underlay uses the same ivory base colour as the decal texture's
plate. Measured at the seam, the body face is
`rgb(214, 210, 207) = 0.839, 0.824, 0.812` sRGB and the decal's ivory is
`0.835–0.839, 0.823–0.827, 0.816` — within 1/255. The decal edge therefore needs
**no runtime mask, feather, or blend mode**: it composites straight over the
body's ivory, and the body's bevel ring and position lighting stay visible
outside the inset.

A double-premultiply bug in the first composite looked like a dashed seam at the
decal edge. The fix (unpremultiply the bilinearly sampled decal before the
straight-alpha `over`) is in `warp_onto`; if a seam ever returns, check alpha
handling there before touching the inset.

### Lighting must be position-independent for decals (§5/§12.3 consequence)

The decal is lit once per orientation, but it is composited onto body sprites at
many positions. A close area rig made the ivory 24–30% brighter at `hand-0` than
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
in pass 1); the green bounce is negligible on ivory at this exposure and keeps
body and decal lighting consistent.

### Orientation-lit decal

The decal is rendered on the canonical face-on **orthographic** rig (§12.3):
`upright` stands the tile at the hand-row centre facing the ortho camera, with
the orthographic frame exactly the inset + gutter (492 × 672 px at 3× CSS). The
scene light rig and ivory material are reused, so the face is genuinely lit: the
key leaves a soft top-left gradient and the AgX transform keeps the ivory warm.
Flat classes will differ in brightness because they face the key more directly;
Task 3 bakes them the same way with the symbol rotated 0/90/180/270°.

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
| `contact-zoom.png` | 4× nearest zoom of the composite's top-left corner (blue rim, bevel, decal edge) |
| `contact-sheet.png` | body, composite, decal, back diagnostic, the zoom, and the manifest numbers |
| `manifest.json` | starter manifest (version 1) with the slot rect, face quad, `faceMatrix`, orientation, draw order, decal size, and measurements |

## Scope: back / face-down poses

Task 1's acceptance is one face-up hand-slot body sprite and one lit decal, so
only the `hand-0` face-up body is a real deliverable here. The `hand-0.back.png`
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
  the full slot inventory and draw order.
- Task 3: vendor all 38 full-face SVGs at the pinned commit, rasterise each, and
  render all five orientation classes per code; downsample 3× → 2× WebP.
- Keep `node_modules/` and `build/` out of git; keep the spec as the only place
  numbers live.
