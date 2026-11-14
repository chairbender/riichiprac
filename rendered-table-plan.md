# Rendered Table View: Design and Offline Asset Pipeline

Status: design finalised by Task 0 (architecture, asset split, and section 12
decisions). Tasks 1–12 are open; the experimental SVG isometric view has been
removed.

This document is the reference for the offline-rendered table view. It supersedes the
deleted SVG isometric chain (the old `IsometricTable` / `iso.ts` / `Iso…` tasks). Any
session working on the rendered table should read this first, then its own `TASK.md`.

## 1. Goal

Add an opt-in, Tenhou-style table view with real perspective and lighting, while keeping
the app a fully client-side, thin React client:

- fixed camera, real perspective, visible tile sides and position-dependent highlights;
- lit tile faces, including the symbol, baked per orientation;
- smooth, soft shadows and a white melamine/blue melamine tile material that reads as physical;
- no runtime 3D, WebGL, or 3D library;
- the stacked layout stays the default and the flat top-down plan view stays available;
- keyboard and screen-reader parity with the existing table views.

## 2. Why this approach

Tenhou's client is effectively a fixed-camera 2.5D scene: the tile bodies are pre-rendered
sprites whose lighting reflects where they sit, while the tile face/symbol is a lit raster
that depends only on its orientation, not its position. We follow that split:

- **Body sprites are per group.** A hand layout is baked as one body, not one sprite per tile
  (Task 2.5): the bevel highlights, sides, top edge, cast shadow, and the blue back change
  with the camera angle at those positions, and inter-tile occlusion and shadow-on-neighbour
  only exist in a render that contains the whole group. The drawn tile is part of the same
  bake, so no two sprites ever carry the same shadow.
- **Face decals are per tile code × orientation.** The white melamine face and symbol are lit once
  for each orientation class and reused at every position.

Alternatives considered:

- **CSS 3D transforms** give real perspective but no lighting model. Every face is a flat
  card, so bevel highlights cannot shift correctly with position.
- **Browser 3D (Three.js/WebGL)** can light the tiles, but adds a runtime 3D stack, a
  texture pipeline in the browser, a separate accessibility overlay, and a large dependency.
- **Offline Blender rendering** gives physical materials, soft shadows, denoising, and
  deterministic assets, at zero runtime cost. The frontend only positions images and DOM.
- **Headless Chrome** is not used. Blender builds the 3D scene; an offline SVG rasteriser
  (resvg) produces the face textures.

## 3. Runtime architecture

The runtime is a sprite compositor, not a 3D renderer.

- Assets are baked in a fixed **scene pixel space** for one fixed camera.
- The whole scene is uniformly scaled and centred into the stage (`contain`), so the table
  is never distorted. v1 ships one landscape scene; a portrait bake is a Task 10
  contingency only if the phone check fails (section 12).
- A `manifest.json` from the offline pipeline lists every slot: body sprite, pixel rect,
  face quad, orientation class, and draw order.
- Rendering order: table background → body sprites (back to front) → face decals → answer,
  focus, and highlight overlays.
- DOM buttons sit over the tiles for hit testing, keyboard focus, and ARIA labels. The
  sprites themselves are decorative images.
- The existing stacked and top-down views remain the no-asset/accessible fallback.

No 3D math, no WebGL, no canvas rendering, and no runtime SVG rasterisation are required.

## 4. Asset split

### Body sprite (one per group and pose)

- Beveled tile box: white melamine front/sides, blue melamine backing.
- Position-dependent lighting: bevel highlights, side faces, top edge, contact shadow.
- Face-up and face-down variants as needed.
- Baked at the group's actual slots, cropped to the **measured shadow contour**
  plus a transparent taper.
- A hand layout is one group: the concealed row (which abuts into the Tenhou
  solid block) and, when the layout has one, the drawn tile are baked together,
  so one render carries the inter-tile occlusion, the shadow each tile throws on
  its neighbour, one continuous cast shadow, and no sprite whose shadow another
  sprite must overlay.

### Face decal (one per tile code × orientation)

- The full tile face: the white melamine background, the engraved painted
  symbol, and face shading, rendered lit. The symbol is real geometry: a
  symbol-only SVG mask recesses the face plate before the paint texture is
  applied, so the carve catches the light.
- Orientation-dependent, **not** position-dependent.
- Composited over the body's flat face and clipped to the inner face, so the body's bevel
  ring and position lighting remain visible.
- The source is the `riichi-mahjong-tiles` **symbol-only** SVG. Its alpha is the carve mask
  and its colour is the paint; the face itself is the melamine material colour, which
  matches the body underlay. The npm package ships React components rather than raw SVG
  files, so Task 3 vendors the public-domain upstream SVGs into `tools/render/faces/` at a
  pinned upstream commit and rasterises those; no new npm dependency enters the frontend
  for this.

### Overlays

- Last-discard/call-target highlight, correct/incorrect marks, focus rings, tsumogiri dim
  and dot, and any other state cue are runtime overlays, not baked.

## 5. Orientation classes

There are five orientation classes (finalised in section 12). A class is the
combination of face plane and reading direction; it is not a position:

| Class | Used by | Face plane | Symbol |
| --- | --- | --- | --- |
| `upright` | the human's hand (vertical tiles), any upright revealed hand | vertical | upright |
| `flat-upright` | the human's own river, melds, wall/dora tiles at their edge | flat | upright |
| `left` | left-seat discards, melds, wall/dora (and a revealed left hand) | flat | turned 90° |
| `right` | right-seat discards, melds, wall/dora (and a revealed right hand) | flat | turned 270° |
| `opposite` | across-seat discards, melds, wall/dora (and a revealed across hand) | flat | turned 180° |

`flat-upright` is separate from `upright` because the face lighting differs
between a vertical hand tile and a flat table tile. Every flat tile reads in its
owner's direction, so the human's flat tiles are the only ones that need the
upright symbol on a horizontal face. The blue tile backs are not decals and
carry no orientation class.

Revealed opponent hands use the class of the seat that owns them, exactly like
that seat's river; there is no sixth class. A dora indicator uses the class of
its wall position: bottom wall `flat-upright`, side walls `left` / `right`, far
wall `opposite`. All of them are flat, face-up tiles.

## 6. Offline pipeline

### Toolchain

- **Blender 4.5.9 LTS**, run headless, installed at `/home/kylehipke/.local/opt/blender-4.5.9/blender` (outside any task worktree). Build the scene from Python (`bpy`); do not hand-model a `.blend`. Record the exact path and version in `tools/render/README.md`; the render script must print and check `bpy.app.version_string` and fail on a mismatch.
- **`@resvg/resvg-js` 2.6.2** (the Rust `resvg` engine with prebuilt Node bindings), pinned in `tools/render/package.json`, for turning the tile face SVGs into textures. It is the chosen offline SVG rasteriser; do not use `sharp`, `rsvg-convert`, or a headless browser. No headless browser is installed or required.
- **Node** only for the offline scripts; the frontend gains no new runtime dependency.
- The rasteriser lives in `tools/render/node_modules`, not in `frontend/`; it is never bundled or shipped.

### Shared scene spec

One committed JSON (or TS module) is the source of truth for:

- tile box dimensions and bevel;
- materials and colours;
- camera position/target/lens;
- light rig and colour management;
- table dimensions and surface colours;
- the slot inventory and orientation class of every slot;
- render resolution and sprite output paths.

Both the Blender script and the runtime manifest derive from this spec, so slot geometry
cannot drift.

### Scene construction

The Blender script constructs everything procedurally:

1. Reset the scene and build the table: felt plane, rail, wall ring, hand apron, compass
   base as needed.
2. Build the tile body: a cube scaled to the tile dimensions, a bevel modifier with 3–4
   segments, weighted normals, white and blue melamine materials.
3. Add the camera and area-light rig, tone mapping, denoise, and transparent film.
4. For each body group, place its tiles at their slots, render a transparent body sprite
   over the whole table as a shadow catcher, crop it to the measured shadow contour, and
   record its scene-pixel rect and draw order.
5. For each tile code × orientation class, place the tile on a canonical face-on rig
   (section 12), carve the inset face plate from the symbol-only mask and paint it, render
   the lit face orthographically, crop it to the inner face, and record the face quad.
6. Render the static table background from the same camera.
7. Compute, for every slot and orientation, the CSS `matrix3d` that maps the decal's
   local pixel rectangle onto that slot's face quad, and write it into the manifest.

Illustrative command:

```bash
blender --background --python tools/render/build_and_render.py -- \
  tools/render/scene-spec.json backend/table table
```

`render.sh` wraps that call, adds the batch's own manifest/asset validation, and
is the command to use (`bash tools/render/render.sh`).

No manual Blender interaction is required. Parameters are edited in the spec/script and the
batch is rerun.

### Reproducibility

- Commit the generator, the spec, the manifest, and the generated sprites.
- Regeneration is a manual developer step; Blender is not required in CI and not required to
  run the app.
- Pin the Blender version and record render settings (engine, samples, denoise, colour
  management) so assets can be reproduced.
- The Cycles *pixels* are deterministic (fixed seed, fixed samples, CPU). Blender's PNG
  container bytes can still differ between runs, so compare decoded pixels when checking
  reproducibility, not file hashes.
- Never hand-edit a generated sprite.

## 7. Initial scene spec

These are the starting scene values for Task 1. Section 12 fixes the architecture
and output rules; Task 1 may tune the numeric material/camera values against its
first renders, but it does not reopen the section 12 decisions.

- Tile proportions follow jansou tiles: 28 × 21 × 16.5 mm (height × width ×
  thickness), including the backing. The spec stores that ratio plus one world
  height, so at height 1.0 the face is 0.75 × 1.0 and the thickness 0.58929.
  The backing is the rear 30% of the thickness.
- Small bevel, 3–4 segments; white melamine body with a glossy specular response; blue melamine backing.
- Fixed perspective camera with a long lens (subtle convergence and peripheral side faces,
  close to Tenhou).
- A preset area rig from above/front-left; a soft contact shadow. The shipped
  `parlor` preset (Task 1.5) is two ceiling tubes + a green bounce + a rim; the
  `studio` preset keeps Task 1's key/fill/rim for comparison
  ([`rendered-table-strip-lights-plan.md`](rendered-table-strip-lights-plan.md)).
- AgX colour management; denoised Cycles render.
- Hand tiles stay vertical; the blue backing (the back face plus the rear 30% of
  every side edge) gives the blue rim on the top and side edges (section 12,
  item 6).
- Face decals are rendered on the canonical face-on orthographic rig (section 12, item 3).

## 8. Manifest shape

The schema is versioned. **Task 2 shipped version 2** (per-slot bodies) and
**Task 2.5 shipped version 3** (group bodies and hand layouts). Coordinates are
rendered device pixels at the manifest's `pixelRatio`; `faceMatrix` maps the
decal image's local pixel rectangle onto the slot's `decalQuad`, so the runtime
never projects or inverts a quad.

```json
{
  "version": 3,
  "scene": { "width": 1440, "height": 900, "widthDevicePx": 2880,
             "heightDevicePx": 1800, "camera": "fixed" },
  "camera": { "position": [0, -47.8, 32.2], "target": [0, 0, 0.35],
              "lensMm": 65, "elevationDeg": 33.68, "distanceUnits": 57.439 },
  "pixelRatio": 2,
  "facePixels": [360, 480],
  "background": "background.webp",
  "backgroundPixels": [1440, 900],
  "table": { "plan": { "feltHalfExtent": 12.9, "railWidth": 0.9, … },
             "seats": ["bottom", "right", "top", "left"],
             "handRow": { "seat": "bottom", "y": -11.7, "centerX": 0,
                          "concealedCounts": [13, 10, 7, 4, 1],
                          "spacingUnits": 0.75, "spacingMode": "touch",
                          "drawGapUnits": 0.55,
                          "layoutIds": ["hand-13", "hand-13-draw", …],
                          "shadow": { "searchPadDevicePx": 160, …
                                      "alphaThreshold": 0.02 } } },
  "layouts": [
    {
      "id": "hand-13",
      "seat": "bottom", "count": 13, "hasDraw": false,
      "orientation": "upright",
      "body": {
        "pose": "hand-upright", "drawOrder": 40,
        "body": "bodies/hand-13.webp",
        "x": 800, "y": 1478, "width": 1246, "height": 255,
        "shadow": { "alphaThreshold": 0.02, "cropMarginPx": 32,
                    "taperPx": 32,
                    "contour": [832, 1512, 2014, 1701],
                    "reach": { "left": 72.5, "top": -1, "right": 38.5,
                               "bottom": 65 },
                    "maxAlphaAtCropEdge": 0.0196,
                    "maxAlphaAtCropEdgeSide": "right",
                    "maxAlphaAtCropEdgePx": [2014, 1620],
                    "visibleAlphaAtSpriteEdge": 0,
                    "sceneEdgeClips": [] },
        "back": { "pose": "hand-upright-back",
                  "body": "bodies/hand-13-back.webp",
                  "x": 798, "y": 1478, "width": 1247, "height": 263, … }
      },
      "slots": [
        {
          "id": "hand-0", "index": 0, "role": "concealed",
          "orientation": "upright", "drawOrder": 40,
          "x": 907, "y": 1512, "width": 90, "height": 122,
          "faceQuad": [[x, y], [x, y], [x, y], [x, y]],
          "decalQuad": [[x, y], [x, y], [x, y], [x, y]],
          "faceMatrix": "matrix3d(…16 values…)",
          "measurements": { "faceWidthPx": 71.55, "faceHeightPx": 73.68 }
        }
      ],
      "measurements": { "seamContrast": { "seams": 12, "dipMedian": 0.0592 } }
    },
    {
      "id": "hand-13-draw", "count": 13, "hasDraw": true,
      "body": { "body": "bodies/hand-13-draw.webp", … },
      "slots": [ … 13 concealed slots and "hand-draw" … ]
    }
  ],
  "faces": {
    "1m": {
      "upright": "faces/1m-upright.webp",
      "flat-upright": "faces/1m-flat-upright.webp",
      "left": "faces/1m-left.webp",
      "right": "faces/1m-right.webp",
      "opposite": "faces/1m-opposite.webp"
    }
  },
  "assets": { "bodyFormat": "WEBP", "bodyQuality": 90, "spriteCount": 20,
              "bodyBytes": 225814, "backgroundSamples": 64,
              "backgroundBytes": 19018, "totalBytes": 244832,
              "budgetBytes": { "total": 8388608, "bodies": 2097152,
                               "background": 157286, "manifest": 153600 } },
  "checks": { "layoutBodiesInsideScene": true, "slotQuadsInsideGroup": true,
              "uniqueDrawOrders": true,
              "alignment": { "shiftedPixels": 0, "layouts": [ … ] } }
}
```

Layouts carry geometry; faces carry only the tile code × orientation mapping. The
runtime picks a layout by `(count, hasDraw)`, draws its **one** `body` at the
published rect, then composites each slot's chosen tile code decal with that
slot's `faceMatrix`; it never reads `faceQuad` or `decalQuad` (they exist for the
pipeline's own consistency tests). The drawn tile is a slot with `role: "draw"`,
not a second sprite, so a layout is always exactly one image plus decals. All
paths are relative to the manifest's directory. `drawOrder` orders the layout's
body and its decals (40 + index); lower numbers are painted first. A body's
`back` is the concealed-pose sprite of the *same* layout (no face quad, no
decal). `checks` and `assets` are the bake's own audit trail: the validator in
`tools/render/scripts/check-assets.mjs` re-derives them from the committed
files.

## 9. Asset budget

- Tile codes: 34 standard + 3 red fives + 1 blank = 38.
- Face decals: 38 codes × 5 orientation classes = 190 files. Render at 3× and
  ship 2× lossy WebP with alpha at 360 × 480, quality 90. Budget ≈ 6 MB.
- Body sprites: the ten hand layouts (concealed 13/10/7/4/1, each with and without
  the drawn tile; the draw is baked into the layout's body, not as a second
  sprite) in both poses = 20 sprites at 2×, lossy WebP with alpha, quality 90.
  Task 2.5 re-baselined the sub-budget to **2 MB** (the shipped batch is
  ~0.3 MB); the group sprites are larger than per-tile ones because each carries
  a whole row's shadow plus a 32 px transparent taper, but WebP's alpha
  compression keeps them at 7–35 KB each.
- Background: 1440 × 900 WebP quality 90, ≈ 150 KB.
- Manifest: **150 KB** (Task 2.5 re-baseline; version 3 carries ten layouts and
  75 slot records, so the shipped file is ~125 KB).
- **Total committed asset budget: 8 MB**; **initial network for one hand and the
  board: 4 MB**. Ship 2× only (the runtime scales down with CSS); keep the 3×
  renders out of the repo.
- **No atlas in v1**: one file per sprite keeps the pipeline and debugging
  simple, and a handful of requests per view is fine over HTTP/2 with immutable
  caching. Revisit only if the budget is exceeded or the request count becomes
  the bottleneck.
- Load the background and the body sprites with the view; load only the face
  decals the current hand and board use. If the weight exceeds the budget, add
  per-orientation lazy loading before considering an atlas.

## 10. Fitting, compatibility, and accessibility

- The baked scene uses one fixed camera and a scene-pixel coordinate space. The runtime
  scales the whole scene uniformly (`contain`) and centres it.
- If one framing is poor on portrait phones, the pipeline can emit a second camera framing
  in the same batch (section 12 decides when; v1 ships one framing).
- Keep the stacked and top-down views; they are the accessible fallback and the reference
  for what information must be shown.
- The rendered view must expose the same interactions and ARIA labels as the top-down view:
  discard buttons, keyboard order, focus rings, call prompts, answer/verdict marks.
- If assets fail to load, fall back to the top-down view rather than showing an empty table.

## 11. Verification

- Tile-for-tile parity with the top-down/stacked views for every scenario shape.
- Red fives, honours, sideways Riichi discards, tsumogiri markers, and called meld tiles.
- Screenshot checks at desktop and phone sizes.
- Manifest/spec consistency tests (slot count, face quads inside bodies, orientation
  classes).
- No new runtime 3D/WebGL dependency.

## 12. Decisions (finalised by Task 0)

These are final for the chain. A later task that needs to change one records the
change here and in its own report; it does not silently drift.

Pipeline prerequisites confirmed: Blender 4.5.9 LTS is installed at
`/home/kylehipke/.local/opt/blender-4.5.9/blender`, outside every task
worktree, and `@resvg/resvg-js` is the chosen offline SVG rasteriser (no
headless browser).

1. **Orientation classes: five** — `upright`, `flat-upright`, `left`, `right`,
   `opposite`, exactly as section 5 defines them. Revealed opponent hands use
   their own seat's class; dora indicators use their wall position's class.
   There is no sixth class.
2. **Decal crop and inset.** The decal is the flat face inset by
   `faceInset` on every edge (0.035 tile-width units at Task 0, about 4.7% of the
   0.75-wide face, equal to the bevel radius; **Task 2.5 raised both to 0.055**
   after the group bake showed the abutting tiles reading as one slab — the wider
   roundover makes the groove between them read). It is cropped to that
   rectangle plus a 1 px transparent gutter so resampling cannot show a seam. The
   body's face underlay uses the same face base colour, so the decal edge blends
   without a runtime mask, feather, or blend mode.
3. **Canonical slots and face projection.** Every face is rendered on a
   canonical face-on orthographic rig, never from the scene camera, so a decal
   is position-independent. `upright` stands the tile vertically facing the
   camera; the four flat classes lay it horizontally with the symbol at
   0/90/180/270°. The scene light rig and melamine material are reused, so vertical
   and horizontal lighting still differ. Ortho scale is one tile width and the
   render is transparent outside the face.
4. **Decal placement.** The pipeline computes a per-slot CSS `matrix3d`
   homography from the decal's pixel rectangle to that slot's projected face
   quad and writes it into the manifest. The runtime applies it verbatim: no
   affine approximation and no runtime projection maths.
5. **Body underlay and layering.** Every body sprite has an opaque face
   underlay. Paint order is background → bodies by ascending `drawOrder` → face
   decals → runtime overlays. Decals stay inside the bevel and never cover it.
6. **Blue backing and sliver.** No forward lean and no separate sliver sprite.
   The tile is a white melamine face plate on a solid blue melamine backing: the back face and
   the rear 30% of **every** side edge are blue (`backEdgeFraction = 0.3`), so
   the fixed raised camera sees a thin blue line above the white face of a
   vertical hand tile *and* a blue band down the visible side. Task 1 corrected
   this from "top edge only": the first render had an all-white side, which is
   wrong for a backed tile, and then tuned the backing from 40% to 30%. Task 1
   checks the visible width at final resolution.
7. **Shadows.** Contact shadows and felt ambient occlusion are baked into the
   body sprites and the background. Each body is cropped from its **measured
   shadow contour** (the composited alpha above `hand.shadow.alphaThreshold`,
   2 %), plus a `cropMarginDevicePx` margin whose outer `taperDevicePx` is faded
   to zero on shadow-only pixels, so the sprite boundary is exactly transparent.
   The bake fails if the contour reaches the search pad's edge inside the scene;
   only the scene frame's own edge may cut a shadow. There is no runtime shadow
   layer and no CSS shadow on tiles. **Task 2.5 amendments:** this item replaces
   Task 2's "32 px shadow gutter per slot", because a standing tile's cast shadow
   reaches ~75 px and the fixed gutter cut it on all four edges; it adds the
   taper, because the contour alone still ended on a ~2 % step where the shadow
   is longest; and it makes a hand layout **one** body, because two sprites (row
   + draw) each carry a tail that ends inside the gap and whichever is painted
   second darkens the other's. The whole table (felt, apron, wall-ring track,
   compass plate, rail) is the Cycles shadow catcher in the shadow pass, with the
   catchers' own `visible_shadow` off so the rail's shadow on the felt is not
   baked twice. Kans and overlapping melds still get dedicated stacked body
   poses, so their overlap shadow is baked in the same render.
8. **Formats, resolution, budget.** 2× lossy WebP with alpha, quality 90, one
   file per sprite, no atlas. Total committed assets ≤ 8 MB and the initial
   hand + board load ≤ 4 MB, with face decals loaded per hand. Section 9 has the
   breakdown. **Task 2.5 amendment:** the body sub-budget is 2 MB (was 1 MB) and
   the manifest sub-budget 150 KB (was 50 KB), because group bodies carry a whole
   row's shadow and manifest v3 carries ten layouts; the 8 MB total and 4 MB
   initial load are unchanged.
9. **Camera framing.** v1 ships one fixed perspective camera and one 1440 × 900
   scene, uniformly `contain`-fitted and centred; there is no portrait bake.
   Task 10 adds a second framing only if the phone screenshot check fails, and
   selects it with a media query without changing the runtime compositor.
10. **Shell.** Keep the full-screen shell and decision popup, neutralised.
    `IsometricShell` is now `TableStage` (`table-stage-*` classes) and
    `DecisionPopup` uses generic `stage-decision-*` classes; both are unmounted
    until Task 4 mounts the rendered compositor inside `TableStage`. The
    stacked/top-down shell is unchanged, and no isometric code remains.
11. **View name and default.** The view is `rendered` and stays opt-in.
    `stacked` remains the permanent default, because the app must work with no
    assets and the stacked/top-down views are the accessible fallback. An old
    stored value, including the removed `isometric`, falls back to `stacked`.
12. **Blender path and version.** Blender 4.5.9 LTS at
    `/home/kylehipke/.local/opt/blender-4.5.9/blender`, outside task worktrees.
    `tools/render/README.md` records the path, and the render script checks
    `bpy.app.version_string` and fails on anything but 4.5.9. Render settings:
    Cycles, 256 samples, OpenImageDenoise, AgX, transparent film. Assets are
    generated only by the script and are never hand-edited.
13. **CI and regeneration.** CI never runs Blender or the offline tools. It runs
    a manifest/asset integrity test instead: every referenced path exists, every
    tile code has all five orientations, every slot's face/decal quad and tile
    rect lies inside the body that renders it, every body crop edge sits below
    its shadow-contour threshold, draw orders are unique per layout, every
    `faceMatrix` reproduces its `decalQuad`, and total asset bytes stay
    under budget. Regeneration is a manual developer step documented in
    `tools/render/README.md`:
    `bash tools/render/render.sh`, which runs
    `blender --background --python tools/render/build_and_render.py -- tools/render/scene-spec.json frontend/public/table table`
    and then the manifest/asset validator.
    A regeneration commits the script/spec, manifest, and sprites together.
    **Task 2 amendment:** the *background* pass uses
    `assets.background.samples` (64) rather than the scene's 256. It is a full
    2880 × 1800 frame of broad, low-frequency lighting, so 64 + OIDN is
    indistinguishable and costs a fraction of a 256-sample frame; the 256 setting
    still governs every sprite (bevel highlights need it). The manifest records
    the count it used as `assets.backgroundSamples`.
14. **SVG rasteriser and source.** `@resvg/resvg-js` 2.6.2, pinned, run from the
    offline `tools/render` package. No `sharp`, no system `rsvg`, and no headless
    browser. Raw symbol-only SVGs are vendored from the public-domain
    `riichi-mahjong-tiles` upstream at a pinned commit under
    `tools/render/faces/` (the npm package only ships React components).

### Task 1 spike results

The Task 1 spike ([`tools/render/README.md`](tools/render/README.md)) proves the
body/decal split and confirms items 2, 3, 6, and 7 above. One constraint it adds
for Tasks 2–3:

- **The light rig must be distant.** Decals are lit once per orientation but
  composite onto bodies at many positions. A close area rig made the face
  24–30% brighter at one hand slot than at the canonical upright rig, which
  showed as a visible rectangle around the decal. The spec now uses a large,
  distant rig (key ≈ 66 units away) so illumination varies only a few percent
  across the hand row. Do not move the lights closer without re-checking the
  decal/body seam.
- Measured at `hand-0`: the 0.58929-unit top edge projects to 43.75 device px,
  of which the rear 30% blue is an 11 px run above a 191.92 px face (≈ 5.5 CSS
  px of blue at 2×). The backing reads as a sliver; no lean or extra sprite. The
  same 30% band wraps the visible side, and the blue is a deep royal base
  (`#132986`) that renders as ≈ RGB(4, 69, 166) on the back face and
  ≈ RGB(71, 109, 196) on the key-lit top edge. (Task 2's framing is lower
  resolution and a higher camera angle, so the same geometry measures 42.22 px
  top edge / 10 px blue / 76.99 px face there; see the Task 2 results below.
  Task 2.5's wider 0.055 bevel takes the flat face to 73.68 px and still leaves
  an 11 px blue run, so the band survives the roundover.)
- The decal is 492 × 672 px at 3× CSS (inset 0.68 × 0.93 plus a 1 px gutter).
  Its face colour matches the body face within ~1.4% at the seam (canonical rig
  vs an off-centre hand slot), which is invisible at 2×; treat ~2% as the
  tolerance. No runtime mask or blend mode is needed.
- **Material:** jansou tiles are white **melamine** with a coloured melamine
  backing, not ivory. The spec keys are `materials.face` / `materials.backing`
  (both tagged `melamine`), tuned as a glossy thermoset: roughness 0.16 / 0.18
  plus a clear coat, not matte plastic. The engraved paint has its own glossy
  material (`materials.paint`, roughness 0.16, coat 0.35); its specular line on
  the bottom fillet is the cue that sells the engraving.
- **The symbol is carved, not printed.** A symbol-only SVG supplies the carve
  mask and the paint. A distance field across an explicit `transitionUnits`
  (from the lip to the flat floor), shaped by a cubic Bézier with independent
  top/bottom fillet controls (`topSpread` / `bottomSpread`), recesses a
  subdivided face plate by 0.5% of the thickness (≈ 0.08 mm at jansou scale).
  The paint boundary is a fraction of that transition (`paintEdge`), so it can
  sit inside the lip and leave a bare melamine bevel. The paint red is a spec override.
- **Parameter tuner.** `node tools/render/tune.mjs` serves a local UI at
  `localhost:7457` with the red, depth, both Bézier spreads, blur and paint
  edge; it draws the exact cross-section and renders a decal-only preview in
  ~4–6 s. "Apply to spec" writes back to `scene-spec.json`. Dev-only, not shipped. Glossy paint catches a bright
  specular line on each bottom fillet (where the well wall curves into the
  floor), and a little cavity occlusion keeps the red from reading flat. The carve
  is baked into the lit decal, so it is orientation-lit like the rest of the
  face. Consequence for Task 3: each code needs its symbol-only SVG and a
  ~330k-vertex face at `gridScale: 1.0`; expect ~80 s per decal render with AO
  and cut `gridScale`/AO samples for the 190-decal set.
- **Lighting is top-heavy, key-dominant.** The rig is spherical
  (azimuth/elevation/distance around each target): the key sits at 0° / 77°
  over the hand row, the fill off-axis at 45° / 11° and the rim behind at
  170° / 45°; ambient 0.5. The key is the dominant light on the up-facing edge,
  so the edge is the brightest surface with no left/right bias. A bright or
  frontal fill sits near the face's specular mirror, owns the flat face's sheen
  and desaturates the glossy paint, so the fill stays off-axis. Exact powers are
  tuned in `tools/render/scene-spec.json`; the angles do the work and the rig
  stays distant for decals.

## 13. Task chain

| # | ID | Task | Depends on |
| --- | --- | --- | --- |
| 0 | 261113-0703 | Remove the experimental view; finalise architecture and pipeline | — |
| 1 | 261113-070303 | Blender spike: one body sprite and one lit face decal | 0 |
| 1.5 | 261113-1238 | Parlor strip-light rig and carve re-tune | 1 |
| 2 | 261113-070305 | Bake hand slots, table background, and manifest **(done)** | 1.5 |
| 2.5 | 261113-1543 | Bake hand rows as whole-group bodies **(done)** | 2 |
| 3 | 261113-070307 | Bake lit face decals for every code × orientation | 1.5 |
| 4 | 261113-070308 | Runtime compositor and human hand | 2, 3 |
| 5 | 261113-070309 | Opponent concealed hands | 2, 4 |
| 6 | 261113-070311 | Discard rivers | 2, 4 |
| 7 | 261113-070312 | Open melds and kans | 2, 4 |
| 8 | 261113-070313 | Centre compass | 2, 4 |
| 9 | 261113-070314 | Interaction and accessibility parity | 4, incrementally with 5–8 |
| 10 | 261113-070316 | Phone framing, asset loading, performance | 4 |
| 11 | 261113-070317 | Wall tiles and dora/ura indicators | 2, 4 |
| 12 | 261113-070318 | Polish and cutover | all |

Tasks 2 and 3 can run in parallel after Task 1. Tasks 5–8 can run in parallel after Task 4.

**Task 1.5 (done, 261113-1238): parlor strip-light rig.** Task 1 shipped a
single large studio key; the target look is a mahjong parlor with linear
fluorescents, whose reflections read as long white streaks on the bevels and
inside the engraving. Task 1.5 replaced the key with two enabled 40 × 2.5-unit
tubes plus a dim green bounce and a rim, exposed the rig (count, length, width,
elevation, azimuth, roll, power) in the tuner behind a `studio` / `parlor`
preset switch, and retuned the carve. The studio rig is kept verbatim in the
spec for comparison. Plan and outcome:
[`rendered-table-strip-lights-plan.md`](rendered-table-strip-lights-plan.md),
[`tools/render/README.md`](tools/render/README.md).

### Task 2 results (done, 261113-070305): table, hand row, manifest, checks

Task 2 turned the one-tile spike into the shipped batch. The decisions it adds to
the chain (all recorded in `scene-spec.json` and the manifest so later tasks read
them rather than guessing):

> **Superseded in part by Task 2.5.** The per-slot body model, the 0.82 row
> spacing, and the 32 px shadow gutter below were replaced by group bodies, a
> touching row, and a measured shadow-contour crop. The table plan, camera
> framing, background, and alignment-in-numbers method are unchanged.

1. **Table plan.** New `table.plan` block, in tile units (1 unit = 28 mm), built
   as a real jansou read back from its tiles: felt half-extent 12.9 (25.8 across),
   a wall-ring track from 6.3 to 7.3 half-extents (12.6 inner side = 17 × 21 mm
   stacks, 1.0 deep = one tile), a compass plate 4.7 square and 0.06 high, one
   hand apron per seat at radial 10.6…12.55, and a 0.9 × 0.35 wooden rail with a
   1.4 skirt. Outer square 27.6 units (773 mm). Track and aprons are flat bands
   0.002 above the felt — the felt is the shadow catcher, so the surface a tile's
   contact shadow is baked against must not step.
2. **Camera re-frame.** The Task 1 camera framed one slot at ~100 px/unit and
   cannot show a table. v1 is now `(0, −47.8, 32.2)` looking at `(0, 0, 0.35)`,
   65 mm, **elevation 33.7°**, 57.4 units out, one 1440 × 900 landscape framing
   (§12.9 unchanged). The near rail's corners sit just outside the frame, the far
   rail at ~18% height, the side rails converge, and a tile face is 74 × 77
   device px (37 × 38.5 CSS) with the hand row 640 CSS px wide. The 33.7°
   elevation shows a real top surface and a ~10 px blue backing band above each
   face, which is the physical read for a 16.5 mm tile.
3. **Slot inventory.** The human's row is 13 concealed slots at 0.82 spacing plus
   the **separated draw** 0.55 units further out; ids `hand-0`…`hand-12` and
   `hand-draw`, `role` `concealed`/`draw`, `drawOrder` 40…53. Every slot is baked
   face-up *and* face-down (`hand-upright-back`) with a nested `back` record, so
   Tasks 5 and 11 reuse the concealed pose at their own seat transforms. Bands:
   0–39 wall/river/meld, 40–53 hands, 60+ overlays.
4. **Background.** One Cycles render from the same camera with opaque film and the
   felt no longer a shadow catcher (felt, track, aprons, compass plate, rail, room
   floor), rendered at 2880 × 1800 and box-filtered to **1440 × 900 WebP q90**.
   The felt palette had to be re-tuned for camera-visible rendering (AgX lifts
   dark albedos, so the table is much darker than it looks): `#093021` felt,
   `#0a3323` apron, `#052316` track, `#2a1a10` rail, `#08090a` compass plate.
5. **Alignment is checked, not assumed.** After the sprites are baked, the script
   renders one reference frame with every slot's tile present and compares it with
   the sprites pasted at their manifest rects, with a one-pixel dilation to absorb
   anti-aliasing. Any whole-pixel disagreement fails the bake; the shipped batch
   reports **0 shifted pixels**. Gitignored review composites
   (`tools/render/build/review/`) show the row on the real background in both
   poses.
6. **Manifest v2 + validator.** Version 2 (§8) adds `backgroundPixels`, `camera`,
   `table`, per-slot `seat`/`role`/`back`/`measurements`, `assets` (format, byte
   counts, budget) and `checks` (bounds, unique draw orders, alignment). The
   dependency-free `tools/render/scripts/check-assets.mjs` re-derives all of it
   from the committed files, verifies real image dimensions from the file
   headers, re-applies each `faceMatrix`, and enforces the budget — it is the
   §12.13 CI gate, and `render.sh` runs it after every batch.
7. **Regeneration and weight.** `bash tools/render/render.sh` rebuilds and
   validates the shipped batch into `frontend/public/table/`; `--spike` rebuilds
   the Task 1 review batch. The committed batch is 186 KB: 28 body sprites
   (141,804 B), the background (19,018 B) and the manifest (24,620 B), against
   the 8 MB / 1 MB / 150 KB budgets the bake and the validator both enforce.
8. **Task 3 consequence.** At this framing a face is 74 × 77 device px while the
   canonical decal frame still renders at 492 × 672, an ~8.7× minification that
   would erase a 1 px fillet highlight. Task 3 must size the shipped decals
   against this framing (~175 × 180 px at 2×) instead of the spike's 3× render.
9. **Lighting uniformity was measured, not assumed.** The face underlay of a
   standing tile reads RGB(228, 226, 224) at the left end of the hand row and
   RGB(229, 228, 226) at the right — under 1% variation across the `upright`
   class, well inside the seam tolerance. The side seats' *faces* sit at
   RGB(204, 208, 215) / RGB(207, 210, 215) because of their grazing angle; that
   is a per-class difference, which is what the five orientation classes exist
   for. Tasks 3 and 6 must re-check flat classes across the whole table: the rig
   is distant (56-unit throw, 40-unit tubes) but its targets are near the
   human's side, so a flat tile at the far wall sees a different exposure than
   one in the human's river.

### Task 2.5 results (done, 261113-1543): hand rows as whole-group bodies

Task 2's per-slot bodies each carried a fixed 32 px shadow gutter, which a
standing tile's cast shadow overran by a wide margin: the alpha was still ~20 %
at the crop edge, every tile's shadow was cut by its own rectangle, and a row of
sprites clipped each other's copies. A per-tile body also cannot bake inter-tile
occlusion or shadow-on-neighbour, so the row read as separate tiles. Task 2.5
makes the layout the body unit. All of this is recorded in `scene-spec.json`,
`manifest.json`, and `tools/render/README.md`'s "Task 2.5 results".

1. **The layout model.** The human's hand is ten layouts: concealed counts
   13 / 10 / 7 / 4 / 1 (a kan removes three concealed tiles like a meld) ×
   {no draw, draw}. `manifest.layouts[]` carries each one's single `body` + rect
   (plus its `back`) and its slots' tile rect / `faceQuad` / `decalQuad` /
   `faceMatrix`. The drawn tile is a slot with `role: "draw"` in the same layout.
2. **One body per layout, draw included.** The planning conversation assumed the
   draw could keep its own single-tile body because "its gap means its shadow
   never touches the row". The measured 2 % contours disagree: the draw's tail
   reaches 51 px into a 47 px gap, and the row's reaches 40 px back, so both tails
   end inside the gap and whichever sprite is painted second darkens the other's.
   The same applies to a 32 px capture margin, which would reach onto the
   neighbour's tile face. Task 2.5 therefore bakes the whole layout — row *and*
   drawn tile — as one body, so no two sprites ever represent the same shadow and
   no compositing order can matter. This supersedes Task 2.5's own earlier
   decision 2 (a per-row-length draw body), which is why no `hand-draw-*` files
   exist.
3. **The row abuts.** `hand.spacing` is `"touch"` (the tile width, 0.75 units)
   instead of an 0.82 pitch, so the concealed row closes into the Tenhou-style
   solid block. The 13-tile row spans 1072 device px (536 CSS), centred on the
   scene's x = 1440; the draw sits 0.55 units (47 px) past it. The row is centred
   *without* the draw, so drawing a tile never shifts the row.
4. **Rounder tile edges.** The first bake of the closed-up row read "too solid":
   the 0.035-unit bevel (≈1 mm) left too shallow a groove between two abutting
   tiles. `tile.bevel.width` is now **0.055** units (≈1.5 mm) with 6 segments, and
   `tile.faceInset` moved with it (0.055) so the decal still sits on the flat
   face. The measured seam dip rose from 4.1 % to **5.25–5.62 %**, and the
   bare-bevel band between decals from ~7 px to ~11 px. The face is 69.89 × 73.68
   device px and the blue top band still measures 10 px, so the backing survives
   the roundover.
5. **Group bake and measured crop.** `bake_body` became `bake_group`: pass 1 is
   the posed tile copies on transparent film, pass 2 makes the **whole table**
   the Cycles shadow catcher while the catchers themselves stop casting (the
   rail's shadow on the felt is already in the background). The crop is the
   measured shadow contour — composited alpha above 2 %, plus a 32 px margin whose
   outer 32 px is **faded to zero on shadow-only pixels** — united with the
   tiles' own integer bounds so a tile's sub-2 % anti-aliased edge cannot be
   shaved. The taper is there because the shadow's alpha only asymptotes to zero:
   the first bake's 2 % + 1 px crop still ended on a ~2 % step, which showed as a
   straight cut along the bottom-left where the shadow is longest. Every body now
   reports `visibleAlphaAtSpriteEdge` 0 and `maxAlphaAtCropEdge` ≤ 0.0078. The
   bake fails if the contour reaches the search pad's edge inside the scene; only
   the scene frame may cut a shadow (`sceneEdgeClips` is empty).
6. **Checks and numbers.** Alignment is per layout against a reference frame
   containing exactly that layout's tiles: **0 shifted pixels for all ten
   layouts** over 737,786 tile pixels, soft-edge fraction 0.0000 %. The row's 2 %
   contour reaches ~70 px left / 40 px right / 45 px below the tiles (a one-tile
   row reaches 64 px below: a row of white tiles bounces more light onto the felt
   and cancels part of the faint tail).
7. **Budget.** With the model change the sub-budgets moved: bodies 1 MB → **2 MB**
   and manifest 50 KB → **150 KB**; the 8 MB total and 4 MB initial load stand.
   The shipped batch is 438 KB — 20 body sprites (419,334 B, 5,798–41,470 B each),
   the background (19,018 B), and a 124,155 B manifest. `render.sh` prunes every
   `bodies/` file the new manifest does not reference, so a regeneration cannot
   leave a stale per-slot sprite behind.
8. **One command.** `bash tools/render/render.sh` bakes the ten layouts in both
   poses, the background, and a review composite per layout into gitignored
   `tools/render/build/review/`, then runs the validator. ~25 minutes on a
   CPU-only machine.
9. **What later tasks consume.** Task 4 picks a layout by `(count, hasDraw)` and
   draws its one body, then the slot decals by `faceMatrix`; there is no
   per-slot body and no second hand sprite. Task 5 calls `bake_group` with the
   seat's slots and the `hand-upright-back` pose. Tasks 6/7/11 reuse the group
   bake for static groups and must decide per *growing* group between a re-bake
   and per-tile bodies plus one group shadow layer — and where two sprites'
   shadows can meet, prefer one bake.

## 14. Risks

- Blender becomes an external build prerequisite; pin it and document regeneration.
- The face decal is mapped affinely to each slot's face quad; strong perspective could show
  warping. Keep the lens long enough, or add a homography if needed.
- Asset weight on mobile; budget and lazy-load.
- Dynamic compass text and scores need DOM overlays mapped onto the baked plane.
- Layering/occlusion for stacked kans and overlapping tiles; the manifest's draw order must
  be right.
- Keep the accessible top-down view working even if the rendered assets are missing.
