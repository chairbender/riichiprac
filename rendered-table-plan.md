# Rendered Table View: Design and Offline Asset Pipeline

Status: planned. Tasks 0–12 are open in the command center; none are started yet.

This document is the reference for the offline-rendered table view. It supersedes the
deleted SVG isometric chain (the old `IsometricTable` / `iso.ts` / `Iso…` tasks). Any
session working on the rendered table should read this first, then its own `TASK.md`.

## 1. Goal

Add an opt-in, Tenhou-style table view with real perspective and lighting, while keeping
the app a fully client-side, thin React client:

- fixed camera, real perspective, visible tile sides and position-dependent highlights;
- lit tile faces, including the symbol, baked per orientation;
- smooth, soft shadows and an ivory/blue tile material that reads as physical;
- no runtime 3D, WebGL, or 3D library;
- the stacked layout stays the default and the flat top-down plan view stays available;
- keyboard and screen-reader parity with the existing table views.

## 2. Why this approach

Tenhou's client is effectively a fixed-camera 2.5D scene: the tile bodies are pre-rendered
sprites whose lighting reflects where they sit, while the tile face/symbol is a lit raster
that depends only on its orientation, not its position. We follow that split:

- **Body sprites are per slot.** The bevel highlights, sides, top edge, shadow, and blue
  back change with the camera angle at that position.
- **Face decals are per tile code × orientation.** The ivory face and symbol are lit once
  for each orientation class and reused at every position.

Alternatives considered:

- **CSS 3D transforms** give real perspective but no lighting model. Every face is a flat
  card, so bevel highlights cannot shift correctly with position.
- **Browser 3D (Three.js/WebGL)** can light the tiles, but adds a runtime 3D stack, a
  texture pipeline in the browser, a separate accessibility overlay, and a large dependency.
- **Offline Blender rendering** gives physical materials, soft shadows, denoising, and
  deterministic assets, at zero runtime cost. The frontend only positions images and DOM.
- **Headless Chrome** is not used. Blender builds the 3D scene; an offline SVG rasteriser
  (resvg/sharp) produces the face textures.

## 3. Runtime architecture

The runtime is a sprite compositor, not a 3D renderer.

- Assets are baked in a fixed **scene pixel space** for one fixed camera.
- The whole scene is uniformly scaled and centred into the stage (`contain`), so the table
  is never distorted. Portrait/landscape framing variants are possible if one framing is
  not acceptable on phones.
- A `manifest.json` from the offline pipeline lists every slot: body sprite, pixel rect,
  face quad, orientation class, and draw order.
- Rendering order: table background → body sprites (back to front) → face decals → answer,
  focus, and highlight overlays.
- DOM buttons sit over the tiles for hit testing, keyboard focus, and ARIA labels. The
  sprites themselves are decorative images.
- The existing stacked and top-down views remain the no-asset/accessible fallback.

No 3D math, no WebGL, no canvas rendering, and no runtime SVG rasterisation are required.

## 4. Asset split

### Body sprite (one per slot and pose)

- Beveled tile box: ivory front/sides, blue back.
- Position-dependent lighting: bevel highlights, side faces, top edge, contact shadow.
- Face-up and face-down variants as needed.
- Rendered at the tile's actual slot, cropped to the slot's scene-pixel bounds.

### Face decal (one per tile code × orientation)

- The full tile face: ivory background, symbol, and face shading, rendered lit.
- Orientation-dependent, **not** position-dependent.
- Composited over the body's flat face and clipped to the inner face, so the body's bevel
  ring and position lighting remain visible.
- The source is the existing `riichi-mahjong-tiles` full-face SVG. We do not need icon-only
  extraction; the full face is the texture.

### Overlays

- Last-discard/call-target highlight, correct/incorrect marks, focus rings, tsumogiri dim
  and dot, and any other state cue are runtime overlays, not baked.

## 5. Orientation classes

Start with four, matching the four ways a tile reads on the table:

| Class | Used by | Face plane | Symbol |
| --- | --- | --- | --- |
| `upright` | human hand; provisionally the human's own river/melds | vertical (hand) or flat (own river) | upright |
| `left` | left-seat discards/dora | flat | turned 90° |
| `right` | right-seat discards/dora | flat | turned 270° |
| `opposite` | across-seat discards | flat | turned 180° |

Open verification: the human's own river/melds are flat while the hand is vertical. If the
upright decal's face lighting looks wrong there, add a fifth class, `flat-upright`, for the
human's flat face-up tiles. Revealed opponent hands may also need a dedicated class.

## 6. Offline pipeline

### Toolchain

- **Blender**, pinned version, run headless. Build the scene from Python (`bpy`); do not
  hand-model a `.blend`. The renderer must be installed outside task worktrees (for
  example `~/.local/opt/blender-<version>`) so later tasks can use it; record the path and
  version in `tools/render/README.md`.
- **An offline SVG rasteriser** (`resvg` or `sharp`) for turning the tile face SVGs into
  textures. No headless browser.
- **Node** only for the offline scripts; the frontend gains no new runtime dependency.

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
   segments, weighted normals, ivory and blue materials.
3. Add the camera and area-light rig, tone mapping, denoise, and transparent film.
4. For each body slot, place the tile at its slot transform, set the render crop, render a
   transparent body sprite, and record its scene-pixel rect.
5. For each orientation class, place the tile at its canonical slot (or an orthographic
   face-on rig), apply the rasterised full-face texture, render the lit face, crop it to the
   inner face, and record the face quad.
6. Render the static table background from the same camera.
7. Write the manifest.

Illustrative command:

```bash
blender --background --python tools/render/build_and_render.py -- \
  tools/render/scene-spec.json out/table/
```

No manual Blender interaction is required. Parameters are edited in the spec/script and the
batch is rerun.

### Reproducibility

- Commit the generator, the spec, the manifest, and the generated sprites.
- Regeneration is a manual developer step; Blender is not required in CI and not required to
  run the app.
- Pin the Blender version and record render settings (engine, samples, denoise, colour
  management) so assets can be reproduced.
- Never hand-edit a generated sprite.

## 7. Initial scene spec

These are starting values for Task 1; Task 0/1 finalise them.

- Tile face 0.75 × 1.0 units, body thickness 0.5 units.
- Small bevel, 3–4 segments; ivory body with a soft specular response; blue back.
- Fixed perspective camera with a long lens (subtle convergence and peripheral side faces,
  close to Tenhou).
- Key/fill/rim area lights from above/front-left; a soft contact shadow.
- AgX or Filmic colour management; denoised Cycles render.
- Hand tiles may lean slightly forward to reveal a thin blue back sliver, or the sliver may
  be modelled as a top strip. Decide from the Task 1 render.
- Face decals rendered from a canonical slot per orientation (or orthographic face-on) and
  cropped to the inner face.

## 8. Manifest shape

The exact schema is decided in Task 0; it must carry at least:

```json
{
  "version": 1,
  "scene": { "width": 1440, "height": 900, "camera": "fixed" },
  "background": "background.webp",
  "slots": [
    {
      "id": "hand-0",
      "body": "bodies/hand-0.webp",
      "x": 120,
      "y": 640,
      "faceQuad": [[x, y], [x, y], [x, y], [x, y]],
      "orientation": "upright",
      "drawOrder": 10
    }
  ],
  "faces": {
    "1m": {
      "upright": "faces/1m-upright.webp",
      "left": "faces/1m-left.webp",
      "right": "faces/1m-right.webp",
      "opposite": "faces/1m-opposite.webp"
    }
  }
}
```

Slots carry positions; faces carry only the orientation mapping. The runtime pairs a slot
with the selected tile code's face decal.

## 9. Asset budget

- About 40 tile codes (34 standard + 3 red fives + maybe a blank) × 4 orientation classes =
  about 160 face decals.
- Body sprites: 14 hand slots initially; later river/meld/compass/wall slots.
- Format: WebP with alpha or PNG; 2×/3× target size; consider a sprite atlas and 1×/2× sets
  if asset weight becomes a problem.
- Decide a total budget in Task 0; load lazily if needed.

## 10. Fitting, compatibility, and accessibility

- The baked scene uses one fixed camera and a scene-pixel coordinate space. The runtime
  scales the whole scene uniformly (`contain`) and centres it.
- If one framing is poor on portrait phones, the pipeline can emit a second camera framing
  in the same batch.
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

## 12. Open decisions for Task 0

1. Four orientation classes or five (`flat-upright` for the human's own river/melds)?
2. Exact decal crop/inset relative to the bevel; how the decal edge blends into the body.
3. Canonical slot per orientation class, and whether the face is rendered from the scene
   camera or orthographically face-on.
4. Eyeball/revealed opponent hand face class.
5. Dora indicator orientation class.
6. Body face underlay colour and layer ordering.
7. Blue sliver: physical forward lean vs. a blue top strip.
8. Shadow strategy: baked contact shadow per body sprite vs. runtime shadow layer.
9. Sprite format/resolution and total asset budget; atlas vs. individual files.
10. One camera framing or separate portrait/landscape bakes.
11. Keep and neuter the existing full-screen shell, or remove it with the old view.
12. Rendered view name (`rendered`?) and when it becomes the default.
13. Blender install location/version pinning and regeneration documentation.
14. CI: do not require Blender for builds; decide whether a manual regeneration check is
    documented.

## 13. Task chain

| # | Task | Depends on |
| --- | --- | --- |
| 0 | Remove the experimental view; finalise architecture and pipeline | — |
| 1 | Blender spike: one body sprite and one lit face decal | 0 |
| 2 | Bake hand slots, table background, and manifest | 1 |
| 3 | Bake lit face decals for every code × orientation | 1 |
| 4 | Runtime compositor and human hand | 2, 3 |
| 5 | Opponent concealed hands | 2, 4 |
| 6 | Discard rivers | 2, 4 |
| 7 | Open melds and kans | 2, 4 |
| 8 | Centre compass | 2, 4 |
| 9 | Interaction and accessibility parity | 4, incrementally with 5–8 |
| 10 | Phone framing, asset loading, performance | 4 |
| 11 | Wall tiles and dora/ura indicators | 2, 4 |
| 12 | Polish and cutover | all |

Tasks 2 and 3 can run in parallel after Task 1. Tasks 5–8 can run in parallel after Task 4.

## 14. Risks

- Blender becomes an external build prerequisite; pin it and document regeneration.
- The face decal is mapped affinely to each slot's face quad; strong perspective could show
  warping. Keep the lens long enough, or add a homography if needed.
- Asset weight on mobile; budget and lazy-load.
- Dynamic compass text and scores need DOM overlays mapped onto the baked plane.
- Layering/occlusion for stacked kans and overlapping tiles; the manifest's draw order must
  be right.
- Keep the accessible top-down view working even if the rendered assets are missing.
