# Architecture & Implementation Spec: Tenhou-Style 2.5D Mahjong Renderer

## 1. Executive Summary & Architectural Pivot

### The Problem with Full-Scene 3D Perspective
Attempting to render a full Riichi Mahjong table through a single 3D perspective camera with physically accurate scene-wide lighting creates four major usability and engineering bottlenecks:
1. **Foreshortening & Legibility Loss:** Perspective cameras shrink tiles on the opposite side of the table and skew complex *kanji* (*manzu*) and bamboo (*souzu*) strokes at oblique angles.
2. **Shadow Occlusion:** Realistic directional shadows cast by standing hands or two-tier walls fall directly across the nearest discard rows, darkening faces players must scan quickly.
3. **Specular Glare:** Glossy plastic shaders create bright highlights that wash out pale tiles (*haku*, *pinzu*).
4. **Dynamic Visual Noise:** Calling *pon*/*kan* or rotating a sideways *riichi* tile shifts real-time cast shadows across neighboring tiles, creating peripheral motion that distracts from gameplay cues (*tedashi* vs. *tsumogiri*).

### The Solution: Blender-Baked 2.5D Shells + Runtime Glyph Compositing
Instead of rendering whole scenes or wrestling with real-time 3D lighting, **repurpose your existing Blender pipeline as an offline sprite-shell baker**. 

You will render **5–6 blank, face-less 3D tile shells** from Blender using orthographic/oblique cameras and locked top-left lighting, bake a synthetic soft blob shadow as a separate per-shell sprite, and composite crisp 2D orthographic face glyphs on top at runtime using a strict **Painter's Algorithm** draw order.

---

## 2. Core Rendering Concepts

### A. Multi-Projection Compositing ("Impossible" Geometry)
Rather than forcing one camera onto the whole board, each table zone uses the 2D projection that maximizes readability while sharing a single virtual light source at **top-left** (`-X, -Y`):

| Table Zone | Projection Type | Visual Construction | Gameplay Purpose |
| :--- | :--- | :--- | :--- |
| **Bottom Player Hand** | Per-slot front elevation at 28° | Fourteen slots (a 13-tile row + the drawn tile): the tile straight in front of the player is straight on, and the outer hand tiles show their inner side and a slight face skew as the player's eye sees them. The top bevel and blue resin edge are kept. §10.9 has the geometry. | The player's own hand reads as a physical row rather than a repeated flat stamp; the face stays readable. |
| **Discard Ponds (`kawa`) & Open Melds** | Straight-on low-angle top-down at 45° | One face-up shell per body orientation, azimuth 0, no per-slot camera. The face plate is foreshortened and the near thickness face is clearly visible. The four seats are four glyph orientations, not four camera variants. Phase 1's 80° was rejected as too top-down. | Uniform tile size across all 4 seats; instant pattern scanning with a seated-player read. |
| **Side Walls (`yama`)** | Off-axis perspective at 45° | Face-down stacks of two tiles, long edge parallel to the table edge. The camera sits slightly inside the wall, so the near end face is revealed and the far long edge converges toward the table centre. The tile itself is never rotated; one shell perspective is reused down the column (Tenhou-style). §10 has the geometry. | Frames the board with strong 3D depth without wasting horizontal screen width. |
| **Top/Bottom Walls (`yama`)** | Per-slot off-axis perspective at 45° | Seventeen slots per wall, each baked with its own camera offset: the tile straight in front of the human is straight on, and the outer slots reveal their inner side as the human's eye sees them. Each column is two tiles; a revealed dora indicator is the face-up top tile at its own slot. §10.8 has the geometry and the slot table. | The wall reads as a real ring around the table instead of a repeated flat stamp, without a shared scene camera. |
| **Top Hand** | Per-slot standing back fan | The top player's 13 concealed tiles are **standing upright with their blue backs to the human**, the human hand turned around (`rotX 90`, `rotZ 180`, face away). Each slot has its own camera offset at the top-hand distance; the shells are bare. | The opponent's hand reads as a hand, not as a row of flat wall tiles. |

Phase 1b (2026-11-14) also doubles the base sprite resolution: the Phase 1
`@2x` output is the new `@1x` base (long axis 104 CSS px, was 52; the new `@2x`
is 208 px). Every shell and every board coordinate is therefore twice the Phase
1 size, and the perspective rework above is baked at that size. See §10.

### B. Decoupled Layout Bounds vs. Sprite Texture Bounds (Blob Shadows)
You do **not** need separate sprites for isolated tiles vs. adjacent tiles, nor do you need neighbor-adjacency logic. Every tile orientation uses **one body shell sprite and one separate blob-shadow sprite**:

* **Logical Advance Box (`advanceW`, `advanceH`):** The exact pixel width and height of the solid tile body used by the layout engine to position tiles on a grid.
* **Body Texture Bounds (`texW`, `texH`):** The body plus a 1–3 px anti-aliased ledge. There are no shadow pixels in the body sprite.
* **Shadow Texture Bounds (`shadowTexW`, `shadowTexH`):** A separate, larger transparent box holding the blob. It has its own `shadowAnchorX/Y`; draw it at `grid - shadowAnchor`. A lying tile's blob is a rounded rectangle covering the body box (top edge trimmed), fading ~10–21 px past the right/bottom edges; a standing tile's blob is the same rounded rectangle fitted to its base strip, rotated with the base. The blob is translucent black (`#0b1418`), a Gaussian-blurred hard shape (σ 12 px lying, 5 px standing) offset 5 px right / 7 px down. `shadowShape` publishes the hard rectangle so a group can be blurred once as a union (§10.12).

The shadow is specified in **pixels at the @1x base**, not as a percentage of
the tile, and it is never baked into the body.

**How this handles both touching and isolated tiles automatically:**
1. **Shadow group first, then bodies:** For each zone, take the hard `shadowShape` of every placed tile, draw them all at alpha 1 into one layer (overlaps merge), blur that layer **once** at the zone's sigma, draw it over the felt at core alpha, then draw every body. This is `blur(union of footprints)`; it is exact for a fan, a shrinking wall and a ragged pond, with no per-length asset. A shadow can never darken a neighbouring tile's face.
2. **Uniform Horizontal Rows (Drawn Right-to-Left):** Body painter order for the pond/discard rows, so the left tile's bevel sits over the right tile's where they touch. The shadows are already unioned below both bodies.
3. **Per-Slot Fan Rows (Drawn Outermost-to-Innermost):** The standing hand, the top hand and the front/back walls are baked as a camera fan whose centre is straight on, so the **inner** tile is nearer the camera than the outer tile. A uniform right-to-left order is wrong on the left half: it puts the outer left tile on top of the inner right tile, but the inner tile should overlap the outer tile's visible inner side. Draw the **outermost slots first on both halves**, then inward, with the centre slot last.
4. **Vertical Discard Rows (Drawn Top-to-Bottom):** Row 2 sits below Row 1 and is drawn *after* Row 1, so the bodies stack in depth order.

**Contact-shadow decals (Phase 3.5, §15).** The blob pass deliberately cannot
darken a neighbour's face, so Phase 3.5 adds one small per-shell decal per
contact side. It is drawn after the neighbour body and before the caster body,
clipped to the neighbour's published body polygon; the group recipe above is
unchanged.

```text
Horizontal Row (Drawn Right-to-Left: Tile 2 -> Tile 1 -> Tile 0)
Layout X positions advance strictly by opaque body width (advanceW = 40px):

Tile 0 (drawn 3rd): [2px AO][======= 40px body =======][4px shadow]
Tile 1 (drawn 2nd):                     [2px AO][======= 40px body =======][4px shadow]
Tile 2 (drawn 1st):                                         [2px AO][======= 40px body =======][4px shadow]
                                             ^                                           ^
                             Tile 0's shadow falls onto                  Tile 2's shadow falls onto
                             Tile 1's left bevel                         empty table felt
```

### C. Sideways Tiles (*Riichi* & Called Melds)
**Never rotate a pre-shaded upright tile sprite by $90^\circ$.** Rotating an upright sprite moves its bottom extrusion thickness and drop shadow to the left or right side, breaking the global top-left lighting illusion. Always bake a dedicated **Flat Sideways** shell in Blender (wider than it is tall, with extrusion thickness and drop shadow on the bottom edge) and rotate only the **2D face glyph** $90^\circ$ before compositing it onto the sideways shell. Phase 1b lowers the camera for this shell so the long side (not just the top) is what the player sees (§9.2).

---

## 3. Blender Offline Baking Pipeline

Configure an automated Blender script to render the canonical blank tile shells from your existing beveled R-tile 3D mesh (colored urea-resin back + white face body).

### Required Canonical Shells
1. `shell_hand_slot_00..12` + `shell_hand_slot_draw`: the standing-hand fan. Thirteen concealed slots are centred on the player (slot 06 is straight on); the drawn tile has its own slot after the +0.35 advance gap. Each slot has its own camera offset from the player's eye at el 28 (§10.9).
2. `shell_flat_upright`: straight-on face-up tile for the ponds and unrotated melds (45°, azimuth 0). The four seats are glyph orientations, not camera variants.
3. `shell_flat_sideways`: straight-on face-up tile whose body is horizontal, for *riichi* declarations and sideways meld calls (45°, azimuth 0).
4. `shell_wall_horizontal` / `shell_wall_horizontal_faceup`: the generic face-down / face-up wall tile at 45°, kept as the straight-on fallback.
5. `shell_hand_top_slot_00..12`: the top player's concealed hand, a 13-slot standing fan with the blue back toward the human (`rotX 90`, `rotZ 180`, `faceLocalZ: bottom`). It is the human hand turned around, not the flat back-wall shells; the shells are bare and face-down.
6. `shell_wall_front_slot_00..16` / `shell_wall_back_slot_00..16`: the front (bottom) and back (top) wall fans, one face-down shell per slot, each with its own lateral camera offset from the human's eye; `_faceup` counterparts carry the dora-indicator face plate at the same slot (§10.8). The back dora shells rotate the 2D glyph 180° so it reads for the far player.
7. `shell_wall_side_left` & `shell_wall_side_right`: off-axis perspective face-down tiles for the left and right walls, long edge parallel to the table edge, plus `shell_wall_side_left_faceup` / `shell_wall_side_right_faceup` dora counterparts (§10.4).

### Blender Scene & Shader Rules
* **Camera:** Use an **Orthographic Camera** (`type = 'ORTHO'`) for the grid shells so parallel edges stay strictly parallel and scale identically across the board. The walls and the standing hand are the exception: the side walls (§10.4), every front/back wall slot (§10.8) and every hand slot (§10.9) use an **off-axis perspective camera** with no yaw and no roll. Only a lateral perspective reveals the near face while keeping the tile square to the table; yawing the tile or the camera slopes the edges instead. The wall and hand slots reuse the same solver, with the camera placed at the human's x for that slot. The hand's face is vertical, so its top edge (closer to the elevated camera) is the longer one; the wall's horizontal face has the lower edge longer.
* **Lighting:** Place a primary soft area light at **Top-Left-Front** (`-X, +Y, +Z`) and a weak ambient fill light so bevels show crisp highlights on top/left edges and cool grey-blue shading on bottom/right thickness faces.
* **Two-Tone Resin Seam:** Ensure the sharp boundary between the colored tile back (*senaka*) and white front body is clearly visible along the top and side bevels—this is the primary visual cue distinguishing a mahjong tile from a flat card.
* **Blob shadow (no catcher):**
  * Enable `Film -> Transparent` in Blender Cycles/Eevee and render only the tile body.
  * Generate the shadow in Python: project the tile's table-contact footprint, fit a rounded rectangle (lying tile: the body box; standing tile: the base strip, rotated with it), offset it down-right, and apply a separable Gaussian. There is no shadow-catcher pass; §10.11 has the committed contract and `shadowShape`.
* **Output Manifest (`shells.json`):** Export a JSON metadata file alongside the PNGs recording for each shell:
  * `textureFile`: Path to PNG
  * `texWidth`, `texHeight`: Full PNG dimensions in pixels
  * `anchorX`, `anchorY`: Pixel offset from top-left of PNG to the top-left corner of the solid tile body
  * `advanceWidth`, `advanceHeight`: Opaque body dimensions used for grid layout
  * `gridStepPx`: the physical tile-axis step for a tight grid
  * `shadowTextureFile` / `shadowTextureFile2x` + `shadowTexWidth/Height`, `shadowAnchorX/Y`, `shadowOffsetPx`: the separate single-tile shadow sprite. It has its own larger box and anchor; draw it at `grid - shadowAnchor` when rendering one tile (the group recipe does not use it).
  * `shadowPadding` (the shadow box's padding) and `shadowBlob` (`model`, `shape`, `sigmaPx1x`, `coreAlpha`, `offsetPx1x`, `lying`).
  * `shadowShape`: the hard rotated rounded rectangle a tile's shadow is cast from, in @1x px relative to the grid anchor (`centrePx`, `halfPx`, `radiusPx`, `angleDeg`) plus `sigmaPx1x`, `coreAlpha`, `colorHex`, `lying`. The group renderer draws every placed tile's shape at alpha 1, blurs the union once, then fills it; that is exact for any row length, fan or grid.
  * `stackStepPx` + `stackCount` (wall shells): the projected thickness vector from the lower tier's body top-left to the upper tier's, plus the 2-tile stack count
  * `wallSlot` (front/back wall shells): `wall`, `index`, `offsetUnits`, `lateralOffsetUnits`, `distanceUnits`, `angleDeg` and `faceUp`, so the per-slot fan is auditable
  * `faceQuad`: 4 corner coordinates (`[x, y]`) on the shell where the 2D face glyph should be mapped

---

## 4. Implementation Breakdown (Step-by-Step)

### Phase 1: Blender Shell Baker & Manifest Exporter
- [x] **Task 1.1:** Create a headless Blender Python script (`bake_shells.py`) that loads the existing 3D R-tile mesh, applies the two-tone resin/ivory materials, and sets up the orthographic camera and top-left key light. Landed in section 8.
- [x] **Task 1.2:** Generate a synthetic blob shadow per shell (Phase 1d): a Gaussian-blurred rounded rectangle under the tile's projected table-contact footprint, exported as a separate sprite plus the hard `shadowShape`. The Blender shadow-catcher pass was removed; see §10.11 and §10.12.
- [x] **Task 1.3:** Render all 6 canonical blank shells at target DPI (plus `@2x` retina scale) and auto-generate `shells.json` containing `anchorX`, `anchorY`, `advanceWidth`, `advanceHeight`, and `faceQuad` coordinates. All numbers are measured from the render; see section 8.

### Phase 2: Runtime Texture Atlas & Face Glyph Compositor
- [x] **Task 2.1:** Prepare high-contrast, crisp 2D vector/SVG or high-DPI PNG assets for all 34 tile faces (plus red fives *akadora*). Avoid thin hairlines that blur at small discard sizes. The master glyphs stay perspective-neutral; the per-perspective treatment is the face variant in Task 2.2. Landed 2026-11-15: 37 committed 288 × 384 RGBA PNGs, see §11.
- [x] **Task 2.2:** Build a startup **Tile Atlas Generator** (`TileAtlasBuilder`) that composites every **`(shellType, faceVariant, tileFace)`** triple onto an offscreen canvas/texture atlas once at initialization:
  - Draw the pre-baked Blender shell PNG.
  - Transform and draw the 2D face glyph into the shell's `faceQuad` (applying a $90^\circ$ counter-clockwise rotation to the glyph when compositing onto `shell_flat_sideways`).
  - Generate a **face variant per perspective a face-up shell appears in** instead of reusing one glyph for every shell: `standing-front-{slot}` for the 14 `shell_hand_slot_*` shells, `flat-topdown` for `shell_flat_upright`, `flat-rot90` for `shell_flat_sideways`. A variant id names a perspective slot, not a camera angle; the Phase 1b pick fixes the angle behind it.
  - The face-down wall shells (`shell_wall_horizontal`, `shell_wall_side_left`, `shell_wall_side_right`) are **bare**: no glyph, no face variant, no atlas entry.
  - Landed 2026-11-15: `frontend/src/table/TileAtlasBuilder.ts`, see §11.
- [x] **Task 2.3:** Store UV rects and layout metrics in a fast lookup map (`Map<TileRenderKey, BakedTileSprite>`, keyed by the same triple) so runtime frame rendering requires no dynamic face compositing or multi-pass shaders. The one dynamic pass is the shadow **group layer** (§10.12): one blur per zone over the hard shapes, rebuilt only when a tile in that zone moves. The atlas key is part of the shipped contract; adding a later variant (for example a lifted/hovered hand decal) is a new `faceVariant` entry, never a glyph swapped at draw time. Budget note: the variant dimension multiplies the composited sprites by the number of face-up shells rather than by the 37 raw glyphs; measure the packed atlas in Phase 2 against the committed-asset budget. Landed 2026-11-15: 684 keys, 18 pages, 30.25 MiB @1x, see §11.

### Phase 3: Coordinate System & Zone Layout Engine
- [x] **Task 3.1:** Implement the table layout engine using the published tile axes: `gridStepPx` for tight rows and wall runs, `advanceWidth`/`advanceHeight` for the logical hit box (never `texWidth`/`texHeight`). Landed 2026-11-16 in `frontend/src/table/zoneLayout.ts`; see §13.
- [x] **Task 3.2:** When positioning a tile, anchor the shell on its projected **face centre**, not its body-box left:
  ```text
  gridX = faceX - (faceQuadCentreX - anchorX)
  gridY = faceY - (faceQuadCentreY - anchorY)
  drawX = round(gridX - shell.anchorX)
  drawY = round(gridY - shell.anchorY)
  ```
  Body-box anchoring spreads a fan's right half because the outer slots carry a visible side reveal.
- [x] **Task 3.3:** Implement zone-specific spacing rules:
  - **Player Hand:** 13 face-centred slots at the centre slot's `gridStepPx.x`; the drawn *tsumo* tile is a separate shell at `handSlot.offsetUnits` +5.5125 (1.35 row steps).
  - **Discard Ponds:** 6 columns; normal tiles advance by the normal shell's short axis (`gridStepPx.x`), rows by its long axis (`gridStepPx.y`). A *riichi* tile lies sideways and advances the row by the sideways shell's `gridStepPx.y` (104 px).
  - **Two-Tier Walls (`yama`):** 17 stacks at the centre slot's `gridStepPx.x`; the upper tier is the lower tier's grid + `stackStepPx`, and the dora indicator is the face-up shell at its slot. Side-wall columns step down the published axis whose vector points down.


### Phase 4: Painter's Algorithm Renderer (Strict Draw Order)
Because there is no Z-buffer, enforce a deterministic back-to-front draw order across and within every table zone:

- [x] **Task 4.1 — Global Zone Order (landed 2026-11-16, §16):** Render zones in this exact order:
  1. Table felt background (use a subtle, low-contrast mottled felt noise texture so semi-transparent tile shadows ground naturally instead of looking like flat stickers).
  2. Top wall (`yama`) & Top player's hand/melds.
  3. Left and Right side walls (`yama`) — draw from top-of-screen (back) to bottom-of-screen (front).
  4. Center scoring/dora indicator box & all 4 Discard Ponds (`kawa`).
  5. Bottom wall (`yama`).
  6. Left and Right player open melds & concealed hands.
  7. Bottom player's open melds & standing hand (always drawn last so lifted/hovered tiles never clip behind the bottom wall).
- [x] **Task 4.2 — Intra-Zone Draw Order (landed 2026-11-16, §16):**
  - **Shadow group first, then bodies:** every shell publishes its hard `shadowShape`. For each zone, draw every placed tile's shape into one layer at alpha 1 (overlaps merge), blur that layer once at the zone's `sigmaPx1x`, draw it over the felt at `coreAlpha`, then draw every body in the zone's back-to-front order. A shadow is never baked into a body, so it cannot land on top of a neighbouring tile; `blur(union)` has no seam and no double-darkening. In DOM use `filter: blur(σpx)` on the layer; in canvas draw the shapes into a mask surface first and apply `ctx.filter` to one `drawImage`, never per shape. Zones: all four walls together, each pond, each seat's hand + melds.
  - **Uniform horizontal rows (ponds, discards):** Iterate **Right-to-Left** (`index = length - 1` down to `0`) for the body painter order.
  - **Per-slot fan rows (standing hand, top hand, front/back walls):** Draw **outermost-to-innermost on both halves, centre last** (slots 0 and N, then 1 and N-1, …, then the centre), because the camera is at the row centre and the inner tile is nearer. Do not use the uniform right-to-left order here; it puts the left half's outer tile on top of its inner neighbour, which is the wrong overlap.
  - **Multi-row grids (discard rows):** Iterate **Top-to-Bottom** (`row = 0` to `2`), drawing each row Right-to-Left.
  - **Stacked walls:** Draw the **bottom tier** completely before drawing the **top tier** at its upward `dy` offset.

### Phase 5: Interactive States, Hitboxes & Visual Polish
- [ ] **Task 5.1 — Hover & Selection Lift (Fake 3D Motion):** When the player hovers over or selects a tile in their hand, translate the tile upward (`drawY -= 12px`) but leave its hard shadow shape at the baseline, so the lift reads and the shadow stays on the felt. Only that seat's group layer rebuilds.
- [ ] **Task 5.2 — Hit-Testing:** Perform pointer hit-testing against the logical bounding box `[gridX, gridY, advanceWidth, advanceHeight]` (accounting for any hover `dy` lift) rather than the transparent shadow padding.
- [ ] **Task 5.3 — Gameplay State Overlays:**
  - *Tsumogiri* (discard drawn immediately) or dimmed hover highlights: Composite a flat tint quad clipped strictly to the tile's `faceQuad` or opaque silhouette—never tint the transparent shadow margin.
  - *Dora* / *Akadora* shimmer: Render an additive specular sweep masked to the `faceQuad`.

---

## 5. Verification Checklist for the Agent
1. **Shadow Continuity Test:** Place 6 tiles in a horizontal row and separate the 6th tile by `15px`. Confirm the first 5 tiles cast subtle shadows onto their right neighbors' left bevels, while the 6th tile casts its shadow onto the felt—using the exact same sprite.
2. **Row Seam Test:** Stack 3 rows of discards vertically. Confirm there is a crisp $1\text{--}2\text{ px}$ dark crease separating Row 1's bottom thickness from Row 2's top edge.
3. **Riichi Rotation Test:** Place a sideways *riichi* tile in a discard row. Confirm its 3D extrusion thickness and drop shadow still point **down and right** (matching upright tiles), not left or up.
4. **Wall Overlap Test:** Inspect a 2-high stacked wall (`yama`). Confirm the top tile's bottom shadow and white body cleanly overlap the bottom tile's colored resin top surface.
---

## 6. Project Addendum: Riichiprac Decisions (2026-11-13)

These are the project-specific decisions that narrow the architecture above for
this repository. They override any implication in sections 1–5.

1. **No table model at all.** Do not bake or model table edges, rails, aprons,
   the wall-ring track, a compass plate, or a room floor. The rendered view's
   background is a single **full-screen felt raster** with a baked vignette at
   the screen edges, Tenhou-style. Everything else (walls, ponds, hands, melds,
   the compass later) is overlaid on that felt in screen space.
2. **Multiple projections are the point.** Because there is no table geometry,
   no zone is constrained by a shared perspective camera. The bottom hand is a
   front elevation, the ponds are top-down, the side walls use a fixed oblique,
   and the top hand/walls are top-down, exactly as section 2.A describes.
3. **Compass is deferred.** The centre compartment can be a reserved screen
   region now; its scoring/dora/wind UI comes later. Do not model it as a 3D
   table part.
4. **The felt is a raster asset.** Generate it offline (procedural noise is
   fine) and commit it; do not paint a felt texture with runtime shaders or a
   browser 3D context. The vignette should read as darkening toward the screen
   edges, not as a literal table border.
5. **Reuse, do not rebuild, the tile mesh.** The existing Blender tile mesh,
   jansou proportions, bevel, melamine and two-tone resin/ivory split are the
   starting point for the shell baker. The retired full-scene pipeline's table
   model, fixed perspective camera, hand/body sprites, baked decals, and
   scene manifest are not reused.

## 7. Phase 0 Baseline (landed 2026-11-13)

Phase 0 reset `tools/render/` to this document and left a runnable starting
point for Phase 1. The authoritative pipeline doc is
[`tools/render/README.md`](tools/render/README.md).

| Path | State after Phase 0 |
| :--- | :--- |
| `tools/render/shell-spec.json` | active: Blender 4.5.9 pin, CPU-Cycles/AgX settings, jansou proportions, bevel `0.055 / 6`, one-material white/blue split, top-left key + ambient fill, the six-shell catalogue, output paths, budgets |
| `tools/render/bake_shells.py` | active skeleton: version check, tile mesh/material, lights, catalogue validation, dry-run plan; `build_shell_camera` / `bake_shell` are the Phase 1 extension points |
| `tools/render/bake-shells.sh` | active entry point; `--check` needs no Blender, the default run is a dry run |
| `tools/render/felt-spec.json`, `bake_felt.py`, `bake-felt.sh` | active procedural felt generator (stdlib Python) |
| `tools/render/scripts/check-shells.mjs` | active dependency-free integrity check; the CI gate |
| `files under tools/render/faces/`, `scripts/rasterize-face.mjs` | kept: vendored face SVGs + provenance and the resvg glyph rasteriser |
| `frontend/public/table/felt.png` | committed full-screen felt + vignette |
| `frontend/public/table/shells/`, `shells.json` | Phase 1 output, not baked yet |

**Felt decisions.** The raster is 2048 × 1280, 8-bit RGB PNG, 559,465 B, with a
baked elliptical vignette (centre luma 68.79, corner mean 24.29, ratio 2.83 on
the committed bake, measured by `check-shells.mjs`). It has no table edge, rail,
apron, wall ring, compass plate or room floor. The runtime stretches it with
`background-size: 100% 100%` rather than `cover`, so the vignette hugs the actual
screen edges at every aspect ratio; `cover` would crop the left/right vignette
away in portrait. The noise is isotropic and low-frequency, so the non-uniform
stretch does not read as a stretched pattern. This is recorded in
`felt-spec.json` under `runtime`.

**Removed.** The retired full-scene table model, fixed perspective camera, body
sprites, 32 px shadow gutter, baked face decals, `scene-spec.json` hand/table/
decals sections, old batch budgets, `scripts/check-assets.mjs` in its old shape,
the contact sheet, the tuner, `frontend/public/table/bodies/`, the old
`background.webp` and the old `manifest.json`. Their history is in git;
`rendered-table-plan.md` and `rendered-table-strip-lights-plan.md` are retired
design records, not instructions.

**Phase 1 handoff.** Implement `build_shell_camera` and `bake_shell`, flip
`bakeImplemented` in `shell-spec.json`, and write
`frontend/public/table/shells/*.png` plus `shells.json`. The manifest contract
(texture size, anchor, advance, padding, `faceQuad`, per-shell and total byte
budgets) is documented in `tools/render/README.md` and enforced by
`scripts/check-shells.mjs`.

## 8. Phase 1 baseline (landed 2026-11-13; superseded by §10)

Phase 1 baked the six canonical blank shells, both texture scales and the
manifest. The authoritative numbers and the field-by-field contract are in
[`tools/render/README.md`](tools/render/README.md); this section records the
decisions that narrow the architecture above.

**One command.** `bash tools/render/bake-shells.sh --bake` renders, measures and
writes everything, then runs `scripts/check-shells.mjs` (323 checks at the Phase 1 bake; 327 today, no Blender)
and regenerates the review sheets under `tools/render/build/review/`.
The re-render determinism check is optional: `--verify-determinism` exists as a
diagnostic, but the standard bake renders once. The manifest records the
decoded-RGBA hash of every texture for integrity.

**Six shells, measured.**

| Id | Projection | Advance @1x | Texture @1x / @2x | Bytes @1x + @2x |
| :--- | :--- | :--- | :--- | :--- |
| `shell_hand_standing` | front elevation, el 12° | 38 × 54 | 44 × 60 / 88 × 120 | 3,315 + 8,790 |
| `shell_flat_upright` | near-top-down, el 80° | 38 × 53 | 44 × 59 / 88 × 118 | 2,966 + 8,543 |
| `shell_flat_sideways` | near-top-down, rotated 90° | 54 × 44 | 60 × 50 / 120 × 100 | 3,269 + 9,594 |
| `shell_wall_horizontal` | near-top-down, face-down | 38 × 54 | 44 × 60 / 88 × 120 | 3,217 + 8,723 |
| `shell_wall_side_left` | fixed oblique, roll −35° | 42 × 52 | 48 × 58 / 96 × 116 | 3,893 + 10,147 |
| `shell_wall_side_right` | fixed oblique, roll +35° | 42 × 52 | 48 × 58 / 96 × 116 | 3,803 + 10,100 |

Total 76,360 B against a 2,097,152 B budget. The felt is unchanged
(559,465 B).

**Decisions that narrow the architecture above.**

1. **The screen-space key is derived from the camera basis, not the world.**
   The authored azimuth/elevation is decomposed once in a front-elevation
   camera's frame into `(−0.406, +0.819, +0.406)` = (screen left, screen up,
   toward viewer) and re-expressed in each shell's own basis. Without that, a
   top-down shell would be lit from the horizon and its top bevel would go dark.
2. **Axis-aligned faces for every grid shell.** A yaw of even 6° turns the tile
   into a parallelogram whose bbox leaves felt gaps between neighbours. The
   ponds, hands and top/bottom walls therefore use azimuth 0, and the "slightly
   right" extrusion that §2.A describes is carried by the baked shadow instead.
3. **Side walls get their cabinet lean by rolling the tile about its own long
   axis (±35°), not by yawing the camera.** Yawing rotates the tile diagonally
   (≈47° on screen) and stops reading as a wall; the roll keeps the long axis
   vertical so a wall column steps straight down while the thickness face leans
   inward.
4. **`advanceWidth/Height` is the sprite's opaque box, not the grid step.** The
   box contains a one-pixel anti-aliased edge ledge (`solidInset1x` is
   `[1,1,1,1]`), so `anchor + advance + padding = texture` stays exact and the
   body box can be measured from the PNG without a
   0.4-alpha edge pixel masquerading as opaque body. Phase 3 must use the
   published `gridStepPx.x/y` (the projected tile axes) for tight rows and wall
   runs; `advanceWidth` is for hit-testing and spacing.
5. **The blob is arithmetic, not a compositor mask.** Python projects the
   table-contact footprint, fits a rounded rectangle (lying tile: the body box;
   standing tile: the base strip, rotated with it), offsets it down-right,
   Gaussian-blurs it and ramps the outer texture ring to zero. Every number the
   check reports is a property of the committed PNG, not of a Blender node
   graph. There is no catcher pass (§10.11); the hard shape is published as
   `shadowShape` for the group layer (§10.12).
6. **Rig tuning changed two numbers.** The Phase 0 key was 350 W and the world
   0.35 of `#20262b`, which rendered the shadow side near black; the bake uses
   3200 W and a `#3b4a5c` world at 1.0. The face samples are ivory
   (`207, 204, 199` flat, `169, 166, 163` standing — the standing face is more
   grazing, which is inherent to one screen-locked key).

Phase 2 owns the atlas and the glyph compositor: it maps each glyph's corners
onto `faceQuad` after rotating it by `faceRotationDeg`, and never rotates a
shell sprite. **§9 records the Phase 1b review that supersedes the base scale and
camera angles above once the user picks**; until then the numbers here are the
committed checkpoint.

## 9. Phase 1b: base scale and the perspective review (superseded by §10)

The Phase 1 checkpoint (main `68a1b60`, tree `92d37d5`) was reviewed. The felt
was approved; the six shells were not. Phase 1b recorded the new decisions,
doubled the base resolution and produced a labelled candidate matrix at that
resolution. **The user then picked the candidates; the picks and the resulting
bake are §10.** The candidate table below is the review record, not the current
catalogue.

### 9.1 Base size: the Phase 1 `@2x` is the new `@1x`

| | Phase 1 | Phase 1b |
| :--- | :--- | :--- |
| `bake.targetLongAxisPx1x` | 52 | **104** |
| Long axis at `@2x` | 104 | **208** |
| Standing hand texture | 44 × 60 / 88 × 120 | ~78 × 110 / 156 × 220 (pose-dependent) |
| Board coordinate space | 1× | **2×** in both axes |

- `shells.json` is in `@1x` px, so every later consumer reads the new manifest
  and the whole board coordinate space doubles. There is no second coordinate
  system and no compat alias.
- The "44 × 60 → 88 × 120" shorthand doubles the *whole texture*, but the base
  is the projected **long axis** (52 → 104 px). Only the body doubles; the fixed
  1 px AA ledge and 6 px padding do not, and the higher hand camera shortens the
  projected width at the same long axis. The achieved standing-hand candidate is
  therefore 78 × 110 @1x / 156 × 220 @2x, not 88 × 120.
- Render **real pixels** at the new size. Never upscale the Phase 1 textures;
  the candidate textures are measured Blender renders (alpha silhouette,
  `faceQuad`, `gridStepPx`), not resized sprites.
- The **shadow/AO contract is unchanged in pixels**: 3–4 px right/bottom and
  1–2 px top/left at the new `@1x` (`padding1x` is still 2/4/4/2). It is
  therefore half its Phase 1 *relative* width. The checker enforces the pixel
  contract and the 1 px AA ledge on every candidate.
- Until the user picks, the committed shells and `shells.json` stay the Phase 1
  bake (52 px target), and `--check` keeps passing for that checkpoint while
  printing the committed-vs-spec base.

### 9.2 Perspective rules

Phase 1's cameras read too top-down. The auditions encode the review:

- `shell_hand_standing` is the exception: **slightly higher** than 12° so a
  little more of the tile top shows (candidates 16/20/24/28°).
- `shell_flat_upright` is **much lower** than ~80° so the bottom thickness edge
  is clearly visible (candidates 65/55/45/35°).
- `shell_flat_sideways` is **much more side-on**: the lower the camera, the more
  the long side of the shell turns toward the viewer (same 65/55/45/35°).
- `shell_wall_horizontal` gets the **same low-angle treatment** as the upright
  flat shell (65/55/45/35°).
- `shell_wall_side_left/right` lie **face down with the long edge reading to the
  player**. The ±35° roll is rejected (§9.3).
- Azimuth stays 0 for the axis-aligned grid shells: a yaw makes the tile a
  parallelogram whose bounding box leaves felt gaps between neighbours (§8,
  decision 2). Only the side walls get a camera azimuth, because they are not
  grid-aligned.

### 9.3 Side-wall orientation

The tile lies face down (blue back up); the long edge is what the player should
read. Two readings are auditioned, because the phrase admits both:

1. **Long axis down the board, camera leaned inward** (candidates A/B/C).
   The wall's *inner long face* is visible, like looking along a wall of bricks:
   the same read as a real wall's inner side. The camera azimuth (22°/35°) does
   the lean, so the screen-locked key still lands top-left; the projected long
   axis leans 26–48° on screen and a wall column therefore steps diagonally. A
   wall column must use the long axis **forced downward** even when the
   published axis points up (candidate C; see the review script), because the
   column always runs toward the viewer.
2. **Long axis across the view** (candidates D/E, rotZ ±90, el 45/30).
   Each tile shows its long side edge toward the viewer and the column steps by
   the short axis. The front tile covers part of the previous tile's near long
   side, so the elevation is exactly "how much of that edge the player sees".

No candidate rolls the tile. The mirror for the right wall is the pose and the
camera azimuth, not a second art style.

### 9.4 The candidate matrix (measured)

26 candidates at the new base, 4–5 per shell. Every number is measured from the
render; `tools/render/build/review/shell-candidates.json` has the full records
(including `faceQuad`, `gridStepPx`, alpha extents/peaks and decoded-RGBA
hashes). One labelled sheet per shell composes the candidates on the felt base
at each candidate's own `gridStepPx`:

| Shell | Cand | Camera | Texture @1x | Body | Face long×short | Bytes @1x + @2x |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `hand_standing` | A EL 16 (+4) | az 0 / el 16 | 78x110 | 72x104 | 79.2x59.2 | 8,742 + 25,570 |
| `hand_standing` | B EL 20 (+8) | az 0 / el 20 | 77x110 | 71x104 | 76.2x58.3 | 8,655 + 24,694 |
| `hand_standing` | C EL 24 (+12) | az 0 / el 24 | 76x108 | 70x102 | 73.3x57.7 | 8,439 + 25,387 |
| `hand_standing` | D EL 28 (+16) | az 0 / el 28 | 76x108 | 70x102 | 70.5x57.4 | 8,382 + 24,430 |
| `flat_upright` | A EL 65 | az 0 / el 65 | 76x108 | 70x102 | 72.6x57.6 | 7,661 + 23,811 |
| `flat_upright` | B EL 55 | az 0 / el 55 | 76x108 | 70x102 | 65.5x57.5 | 7,504 + 22,329 |
| `flat_upright` | C EL 45 | az 0 / el 45 | 78x108 | 72x102 | 59.2x58.2 | 7,385 + 22,248 |
| `flat_upright` | D EL 35 | az 0 / el 35 | 82x108 | 76x102 | 63.0x50.3 | 7,743 + 23,196 |
| `flat_sideways` | A EL 65 | az 0 / el 65 | 112x101 | 106x95 | 92.6x60.3 | 9,565 + 29,322 |
| `flat_sideways` | B EL 55 | az 0 / el 55 | 112x102 | 106x96 | 92.6x54.5 | 9,349 + 29,357 |
| `flat_sideways` | C EL 45 | az 0 / el 45 | 112x101 | 106x95 | 92.6x47.1 | 8,989 + 28,276 |
| `flat_sideways` | D EL 35 | az 0 / el 35 | 112x99 | 106x93 | 92.6x38.2 | 9,485 + 28,754 |
| `wall_horizontal` | A EL 65 | az 0 / el 65 | 76x108 | 70x102 | 72.6x57.6 | 9,544 + 28,618 |
| `wall_horizontal` | B EL 55 | az 0 / el 55 | 76x108 | 70x102 | 65.5x57.5 | 10,820 + 30,924 |
| `wall_horizontal` | C EL 45 | az 0 / el 45 | 78x108 | 72x102 | 59.2x58.2 | 8,343 + 24,768 |
| `wall_horizontal` | D EL 35 | az 0 / el 35 | 82x108 | 76x102 | 63.0x50.3 | 8,405 + 25,438 |
| `wall_side_left` | A AZ 22 EL 55 | az 22 / el 55 | 90x106 | 84x100 | 59.0x49.0 | 11,459 + 32,352 |
| `wall_side_left` | B AZ 35 EL 55 | az 35 / el 55 | 95x106 | 89x100 | 60.0x46.2 | 11,681 + 33,073 |
| `wall_side_left` | C AZ 35 EL 40 | az 35 / el 40 | 103x106 | 97x100 | 57.5x47.7 | 10,089 + 28,873 |
| `wall_side_left` | D ROT90 EL 45 | az 0 / el 45 | 112x101 | 106x95 | 92.6x47.1 | 10,321 + 31,896 |
| `wall_side_left` | E ROT90 EL 30 | az 0 / el 30 | 112x95 | 106x89 | 92.6x33.3 | 9,860 + 30,335 |
| `wall_side_right` | A AZ -22 EL 55 | az -22 / el 55 | 90x106 | 84x100 | 59.0x49.0 | 11,260 + 32,195 |
| `wall_side_right` | B AZ -35 EL 55 | az -35 / el 55 | 95x106 | 89x100 | 60.0x46.2 | 11,787 + 33,202 |
| `wall_side_right` | C AZ -35 EL 40 | az -35 / el 40 | 103x106 | 97x100 | 57.5x47.7 | 10,020 + 29,151 |
| `wall_side_right` | D ROT90 EL 45 | az 0 / el 45 | 112x101 | 106x95 | 92.6x47.1 | 10,320 + 31,910 |
| `wall_side_right` | E ROT90 EL 30 | az 0 / el 30 | 112x95 | 106x89 | 92.6x33.3 | 9,858 + 30,340 |

Totals: **245,666 B @1x + 730,449 B @2x = 976,115 B** for 26 candidates
(gitignored review output, not committed). Every candidate is inside the
per-shell ceiling, the 1 px AA ledge, and the 3–4 px / 1–2 px shadow/AO
contract: alpha extents are exactly L1/T1/R3/B3 px on all 26, with right/bottom
peaks 0.314–0.329 and top/left AO peaks 0.278–0.286.

Two measured consequences worth knowing before the pick:

- **The standing hand dims as the camera rises.** With one screen-locked key, the
  vertical face becomes more grazing: mean face RGB is (155,153,151) at 16°,
  (138,137,138) at 20°, (117,120,123) at 24° and (94,100,107) at 28°, against
  the Phase 1 12° bake's 169 luma. The blue resin sliver stays on the top edge in
  every candidate (rgb ~(6,67,150)). If the hand pick is above ~20°, the lighting
  lever is the key or a second hand lighting variant, not the angle.
- **The ponds' face plate foreshortens.** The face's long edge in the image is
  79 px at 16°/65° and 70 px at 28°, and the upright pond face goes from 72.6 px
  at 65° to 63.0 px at 35°, so glyph rasterisation sizing (Phase 2) follows the
  picked elevation, which is why the face variant is explicit.

### 9.5 Face variants (Phase 2 plan, not implemented)

The runtime will generate a few variants of each tile-face decal for the
perspectives a face-up shell appears in, instead of reusing one glyph for every
shell. Recorded in `shell-spec.json` under `faceVariants` and in Phase 2 above:

- Atlas key: **`(shellType, faceVariant, tileFace)`**.
- Variant ids per face-up shell: `standing-front`
  (`shell_hand_standing`), `flat-topdown` (`shell_flat_upright`),
  `flat-rot90` (`shell_flat_sideways`).
- A variant id names a **perspective slot**, not a camera angle; the Phase 1b
  pick fixes the angle behind the slot, so the id survives a later angle nudge.
- The face-down wall shells are **bare**: `shell_wall_horizontal`,
  `shell_wall_side_left`, `shell_wall_side_right` have `bare` and contribute no
  glyph or atlas entry.
- Budget: the atlas is keyed by the triple, so the composited sprite count is
  `face-up shells × tile faces` (3 × 37 at Phase 1b), not the 37 raw glyphs.
  The packed atlas size is a Phase 2 measurement against the committed-asset
  budget; nothing is baked here.

### 9.6 Validation and stop point

`bash tools/render/bake-shells.sh --audition` renders the matrix, writes the
candidate textures and `shell-candidates.json` under `build/review/`, writes one
labelled sheet per shell, then runs `check-shells.mjs --audition` (1,448 checks:
candidate + committed checkpoint, sizes, ledgers, shadow/AO contract, quad and
`gridStepPx` consistency, decoded-RGBA hashes, and the sheets' text/tile pixel
budgets). The optional `--verify-determinism` diagnostic re-renders every candidate; it is
not part of the standard run. The committed felt is untouched.

**Stop point.** The angles are **not** chosen, and nothing downstream is
started: no catalogue change, no face variants, no atlas, no layout engine, no
renderer, no app view. The user picks one candidate per shell (or names a
different angle) before the next task, and the pick is then baked into the
catalogue at the new base.

## 10. Phase 1c: the picked perspectives, the wall stack and the diffuse shadow (landed 2026-11-14)

The Phase 1b review picked the cameras and added the requirements: the side
walls need a small inward lean and a visible side edge, a wall column is two
tiles high, the dora indicators need face-up counterparts, and the contact
shadow is too tight. This section records the result. It supersedes the Phase 1
base/angle numbers in §8 and the Phase 1b review in §9.

### 10.1 The picked cameras

| Shell | Phase 1 | Phase 1c (committed) |
| :--- | :--- | :--- |
| `shell_hand_slot_00..12` + `_draw` | one el-12° shell | **el 28°**, per-slot camera fan from the player's eye (§10.9) |
| `shell_flat_upright` | el 80° | **el 45°** (candidate C) |
| `shell_flat_sideways` | el 80° | **el 45°** (candidate C) |
| `shell_wall_horizontal` | el 80° | **el 45°** (candidate C) |
| `shell_wall_side_left/right` | el 75°, rotY ∓35° | **el 45°**, face down, off-axis perspective with the camera 2 units inside the wall (§10.4) |

The six original shells became **103** in Phase 1c: the three wall shells each gained a
face-up counterpart for revealed dora indicators; the front/back walls split
into a 68-shell per-slot fan (§10.8); the human hand split into a 14-slot fan
(§10.9); and the top hand is a dedicated 13-slot standing blue-back fan. The
ponds/melds stay straight-on and the side walls are approved. Phase 2b later
adds two flat river shells (`shell_flat_upright_180`, `shell_flat_sideways_270`),
for **105** committed shells; see §12.

### 10.2 The committed bake, measured

`bake.targetLongAxisPx1x` is 104 (the Phase 1 `@2x` size); the new `@2x` is 208.
All numbers are measured from the render and live in
`frontend/public/table/shells.json`.

| Shell | Camera | Body tex @1x / @2x | Shadow tex @1x / @2x | Body | gridStepPx x / y | stackStepPx | Bytes @1x + @2x |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `shell_flat_upright` | el 45° | 76 × 106 / 152 × 212 | 160 × 162 / 320 × 324 | 72 × 102 | (69.4, 0) / (0, 65.44) | — | 14,242 + 37,739 |
| `shell_flat_sideways` | el 45° | 110 × 99 / 220 × 198 | 194 × 155 / 388 × 310 | 106 × 95 | (0, 55.15) / (104, 0) | — | 16,042 + 43,801 |
| `shell_wall_horizontal` | el 45° | 76 × 106 / 152 × 212 | 160 × 162 / 320 × 324 | 72 × 102 | (69.4, 0) / (0, 65.44) | (0, −38.56) | 15,163 + 40,409 |
| `shell_wall_horizontal_faceup` | el 45° | 76 × 106 / 152 × 212 | 160 × 162 / 320 × 324 | 72 × 102 | (69.4, 0) / (0, 65.44) | (0, −38.56) | 14,242 + 37,739 |
| `shell_wall_side_left` | off-axis persp, +2 / d10 | 108 × 89 / 216 × 178 | 192 × 145 / 384 × 290 | 104 × 85 | (−6.91, 45.96) / (92.84, 0) | (−5.64, −39.87) | 16,981 + 46,885 |
| `shell_wall_side_left_faceup` | off-axis persp, +2 / d10 | 108 × 89 / 216 × 178 | 192 × 145 / 384 × 290 | 104 × 85 | (−6.91, 45.96) / (92.84, 0) | (−5.64, −39.87) | 15,482 + 42,601 |
| `shell_wall_side_right` | off-axis persp, −2 / d10 | 108 × 89 / 216 × 178 | 192 × 145 / 384 × 290 | 104 × 85 | (6.91, 45.96) / (92.84, 0) | (5.64, −39.87) | 16,039 + 44,437 |
| `shell_wall_side_right_faceup` | off-axis persp, −2 / d10 | 108 × 89 / 216 × 178 | 192 × 145 / 384 × 290 | 104 × 85 | (6.91, 45.96) / (92.84, 0) | (5.64, −39.87) | 15,427 + 42,742 |

The eight base shells above total **459,971 B** (123,618 @1x + 336,353 @2x).
The 14 human-hand slots add **695,439 B**, the 13 top-hand slots **568,700 B**
and the 68 front/back wall slots **3,929,429 B**, for **5,653,539 B**
(1,515,854 @1x + 4,137,685 @2x) against the raised 6,291,456 B budget.
`shells.json` is **561,793 B** against the 614,400 B budget (raised from 512 KiB
when `shadowShape` was added). The felt is
unchanged (559,465 B). The body keeps the 104 px projected long axis (102 px
measured, minus the anti-aliased crop); the shadow adds its own box
(human-hand centre 119 × 142, drawn 133 × 142, top-hand centre 118 × 142).

Representative top-hand slots (all 13 are in `shells.json`):

| Shell | Camera | Body tex @1x / @2x | Shadow tex @1x / @2x | Body | gridStepPx x / y | Bytes @1x + @2x |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `shell_hand_top_slot_06` | 0° / d60 | 74 × 106 / 148 × 212 | 102 × 136 / 204 × 272 | 70 × 102 | (67.55, 0) / (0, 80.35) | 10,884 + 30,718 |
| `shell_hand_top_slot_00` | 4.29° / d60 | 78 × 106 / 156 × 212 | 106 × 136 / 212 × 272 | 74 × 102 | (67.55, 0) / (2.83, 80.35) | 12,032 + 33,865 |
| `shell_hand_top_slot_12` | 4.29° / d60 | 78 × 106 / 156 × 212 | 106 × 136 / 212 × 272 | 74 × 102 | (67.55, 0) / (−2.83, 80.35) | 11,999 + 33,734 |

Representative hand slots (all 14 are in `shells.json`):

| Shell | Camera | Body tex @1x / @2x | Shadow tex @1x / @2x | Body | gridStepPx x / y | Bytes @1x + @2x |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `shell_hand_slot_06` | 0° / d24 | 75 × 106 / 150 × 212 | 103 × 136 / 206 × 272 | 71 × 102 | (67.96, 0) / (0, 81.72) | 11,570 + 33,058 |
| `shell_hand_slot_00` | 10.62° / d24 | 86 × 106 / 172 × 212 | 114 × 136 / 228 × 272 | 82 × 102 | (67.96, 0) / (7.37, 81.72) | 13,400 + 38,229 |
| `shell_hand_slot_12` | 10.62° / d24 | 86 × 106 / 172 × 212 | 114 × 136 / 228 × 272 | 82 × 102 | (67.96, 0) / (−7.37, 81.72) | 13,628 + 39,170 |
| `shell_hand_slot_draw` | 12.94° / d24 | 89 × 106 / 178 × 212 | 117 × 136 / 234 × 272 | 85 × 102 | (67.96, 0) / (−9.03, 81.72) | 13,933 + 39,347 |

Representative wall slots (all 17 per wall are in `shells.json`):

| Shell | Camera | Body tex @1x / @2x | Shadow tex @1x / @2x | Body | gridStepPx x / y | stackStepPx | Bytes @1x + @2x |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `shell_wall_front_slot_08` | 0° / d40.8 | 77 × 106 / 154 × 212 | 161 × 162 / 322 × 324 | 73 × 102 | (69.72, 0) / (0, 66.07) | (0, −39.02) | 14,881 + 41,093 |
| `shell_wall_front_slot_04` | 4.21° / d40.8 | 81 × 106 / 162 × 212 | 165 × 162 / 330 × 324 | 77 × 102 | (69.72, 0) / (−3.49, 66.07) | (−2.03, −39.02) | 16,360 + 43,945 |
| `shell_wall_front_slot_16` | 8.37° / d40.8 | 85 × 106 / 170 × 212 | 169 × 162 / 338 × 324 | 81 × 102 | (69.72, 0) / (6.97, 66.07) | (4.06, −39.02) | 16,702 + 44,631 |
| `shell_wall_back_slot_08` | 0° / d54.8 | 76 × 106 / 152 × 212 | 160 × 162 / 320 × 324 | 72 × 102 | (69.64, 0) / (0, 65.91) | (0, −38.9) | 15,204 + 40,913 |
| `shell_wall_back_slot_04` | 3.13° / d54.8 | 79 × 106 / 158 × 212 | 163 × 162 / 326 × 324 | 75 × 102 | (69.64, 0) / (−2.58, 65.91) | (−1.51, −38.9) | 16,055 + 43,698 |
| `shell_wall_back_slot_16` | 6.25° / d54.8 | 82 × 106 / 164 × 212 | 166 × 162 / 332 × 324 | 78 × 102 | (69.64, 0) / (5.16, 65.91) | (3.01, −38.9) | 16,608 + 44,219 |
| `shell_wall_front_slot_16_faceup` | 8.37° / d40.8 | 85 × 106 / 170 × 212 | 169 × 162 / 338 × 324 | 81 × 102 | (69.72, 0) / (6.8, 64.46) | (4.06, −39.02) | 15,891 + 42,280 |
| `shell_wall_back_slot_16_faceup` | 6.25° / d54.8 | 82 × 106 / 164 × 212 | 166 × 162 / 332 × 324 | 78 × 102 | (69.64, 0) / (5.06, 64.71) | (3.01, −38.9) | 15,879 + 41,802 |

### 10.3 The 2-tile wall stack

A wall column is **two tiles**. `shells.json` publishes `stackCount: 2` and
`stackStepPx` on each wall shell — the projected vector from the lower tier's
body top-left to the upper tier's. It is the projected **thickness** (straight
up on screen, −38.6 px at 45°), not the face grid step. The layout draws the
lower tier first, then the upper tier at `+stackStepPx`; a revealed dora
indicator is the **face-up** counterpart shell in the upper tier. `gridStepPx`
still steps between stacks.

### 10.4 The side-wall perspective

The side-wall tile lies face down with its long edge **parallel to the table
edge**. The tile is **not rotated**: the whole shell is square to the table
(`rotZ 90`, i.e. the long axis across the view). What reveals the end face is
the camera, not the tile. It sits `lateralOffsetUnits` (2 units) inside the wall
at distance 10, with **no yaw and no roll**, looking along the wall's inward
normal at el 45. A perspective camera looking along the normal keeps lines of
constant depth horizontal, so the tile's long edges stay parallel to the table
edge on screen; the lateral offset makes the near end face visible.

Measured on the committed bake (left wall):

- near (viewer-side) long edge **84.0 px**, far long edge **81.3 px**: a 3.3%
  keystone, and the far edge is **7.5 px toward the table centre**.
- the two long edges stay horizontal to within 0.01 px.
- the tile is exactly the same on the right wall with the camera offset
  mirrored (−2 units), so the two sprites are mirror images of each other.

The camera framing is solved, not hand-placed: the lens is adjusted until the
projected long axis is the 104 px target (lens ≈ 301.8 mm at this framing), and
`shift_x`/`shift_y` centre the tile in the frame. Because the camera is off-axis,
the projected thickness is not exactly vertical: `stackStepPx` is
`(∓5.64, −39.87)` rather than `(0, −38.9)`. That 5.6 px horizontal drift is the
perspective, and the stack sheet uses it.

**One perspective, reused down the column.** The projection would physically
change as the stack recedes; the build deliberately does not recompute it. The
wall column is a stack of the same shell sprite, exactly as Tenhou does. The
per-tile column step is still the published `gridStepPx` (the centre-line depth
step), so the column converges slightly toward the centre.

The open calibration is how far inside the wall the camera sits: 1, 3 and 4
units are auditioned against the committed 2 (§10.7). The tile never rotates.

### 10.5 Face variants (updated plan, still not built)

> **Status 2026-11-15:** Phase 2 landed the three face-variant families the
> task enumerated: `standing-front-{slot}` for the 14 hand slots,
> `flat-topdown` and `flat-rot90`. The 34 per-slot dora families below are still
> the open follow-up; see §11 for the landed numbers and the measured dora
> cost.

Face-up shells are the **14 hand slots**, the upright pond shell, the sideways
shell, the three base face-up dora shells and the **34 per-slot front/back dora
shells** (§10.8). The top hand is a dedicated 13-slot standing blue-back family
(bare), and the ponds/melds stay straight-on with four glyph orientations. The atlas plan in
§4 and `shell-spec.json` (`faceVariants`) therefore defines:

| Face-up shell | faceVariant id |
| :--- | :--- |
| `shell_hand_slot_00..12` + `_draw` | `standing-front-00..12` + `-draw` |
| `shell_flat_upright` | `flat-topdown` |
| `shell_flat_sideways` | `flat-rot90` |
| `shell_wall_horizontal_faceup` | `wall-topdown-dora` |
| `shell_wall_side_left_faceup` | `wall-left-dora` |
| `shell_wall_side_right_faceup` | `wall-right-dora` |
| `shell_wall_front_slot_00..16_faceup` | `wall-front-dora-slot-00..16` |
| `shell_wall_back_slot_00..16_faceup` | `wall-back-dora-slot-00..16` |

The atlas key stays `(shellType, faceVariant, tileFace)`; the face-down wall
shells are bare and contribute no glyph entries. A dora shell's decal is its own
perspective slot even where the projection matches a pond shell, because it is a
different shell type in the key. `shell_wall_horizontal_faceup` is pixel-
identical to `shell_flat_upright` in this bake (same pose, camera and light); it
is still a separate catalogue id because its role and atlas key differ, and its
bytes are duplicated deliberately rather than aliased.

**The per-slot atlas cost.** There are **53 face-up shells**: 14 hand slots,
flat upright, flat sideways, wall-horizontal dora, side-left dora, side-right
dora, 17 front dora slots and 17 back dora slots. At 37 faces each that is
**1,961 sprites**. The two per-slot families are the expensive part: the 14 hand
slots are 14 × 37 = **518** sprites, and the 34 dora slots are **1,258**. That is
the price of matching the player's-eye perspective, and it must be measured
against the committed-asset budget before the atlas is built. If the packed
atlas cannot hold it, the dora blank and the hand are the places to trade slots
(for example, bake only the dead-wall dora slots the layout actually uses, or a
subset of hand slots with nearest-slot reuse), not the wall/hand bodies. The
top hand adds no face-up keys: its 13 shells are bare blue backs.

### 10.6 The contact shadow: darker, still diffuse (superseded by §10.11)

> **Superseded.** Phase 1d replaced the Cycles catcher and the AO fringe with a
> synthetic blob shadow and the shadow-union draw pass. The measurements below
> are kept as the Phase 1c record; §10.11 is the active contract.

The Phase 1/1b shadow was a 3–4 px band at alpha 0.33: the review called it too
tight. The first Phase 1c pass went deliberately diffuse and subtle at 0.12.
The review then called it too faint and found **unshadowed notches at the tile
corners**: the shadow window was a rectangle around the body box, so the
beveled corners of the tile (outside the silhouette but inside the box) were
zeroed.

The committed revision is **darker and still diffuse**, with the shadow window
following the silhouette inside the body box:

| Property | Phase 1/1b | Committed revision |
| :--- | :--- | :--- |
| Right/bottom extent | 3–4 px | **16 px** (contract 10–16) |
| Right/bottom peak alpha | 0.33 | **0.30** (contract 0.18–0.34) |
| Blur | 1 px @1x | **10 px @1x** |
| Falloff | 4 px | **20 px** |
| Top/left AO | 1–2 px at 0.28 | **1 px at 0.20** |

The shadow is darkest at the tile and fades with the 16 px falloff; the
`contactFloor` is 0.12 so the physical gradient dominates instead of a flat
band. `padding1x` stays 2/16/16/2, and the checker enforces the ranges in
`bake.shadowContract`. The texture grows, not the body: the board coordinates
are unchanged.

**The corner fix.** `compose_shell` now uses the tile's **silhouette** for the
shadow/AO inside the body box: an outside-silhouette pixel inside the box keeps
the full contact shadow instead of being zeroed by the rectangular window. The
top-left beveled corner also gets the AO fringe. The bottom-right corner of a
flat tile now measures ~56/255 alpha instead of 0, so the beveled corners are
no longer unshadowed notches.

**The separate shadow sprite.** The drop shadow/AO are **not baked into the body
sprite**. Each shell exports a body PNG (`<id>.png`) and a shadow PNG
(`<id>-shadow.png`) with the same dimensions and anchor. The runtime draws every
shadow first, then every body, so the painter's order can never put one tile's
shadow on top of another tile. The body PNG contains only the tile; the shadow
PNG contains only the shadow/AO. Both are published in `shells.json` and both
are checked.

**The shadow audition.** `bash tools/render/bake-shells.sh --shadow-audition`
renders the committed REF (variant C: 0.30 / floor 0.08 / blur 10 / pad 20)
plus A/B/C on the flat, wall and hand shells and writes
`build/review/shadow-candidates.png` with the peak/floor/blur/padding and the
seam/drop luma printed. A is lighter (0.18 / 16 px), B is tighter (0.24 / 12 px),
C is the committed darkest/widest (0.30 / 20 px). The audition never touches the
committed shells.

### 10.7 Validation and the open calibration

`bash tools/render/bake-shells.sh --bake` renders the 103 shells once, writes
both scales and `shells.json`, regenerates the review sheets and runs **7,878
checks**: catalogue and the 14 human-hand + 13 top-hand + 68 wall
slot fans, the top-hand standing mapping,
the straight-on ponds, felt, both texture scales, the 1 px AA ledge, the blob
contract (no moat, smooth Gaussian, extents and union), the faceQuad and `gridStepPx`, the 2-tile `stackStepPx`
(within 1.5 px of the projected thickness on the orthographic shells, 2.5 px on
the perspective ones), the perspective trapezoid (one table-parallel edge pair,
the near edge longer — the lower edge for a horizontal face, the upper edge for
the vertical hand face — and the depth edges converging), the slot metadata
(`handSlot` / `wallSlot`, camera offset, distance, face rotation), the
review-sheet pixel budgets, ivory/blue face sides, the decoded RGBA hashes and
the budgets.

`bash tools/render/bake-shells.sh --audition` renders
the **hand fan-strength calibration**: the outer row slot and the drawn-tile slot
at 14, 18 and 40 units, with the committed 24 units as the REF. It validates
**8,057 checks** in total. The shadow audition validates **7,789 checks** (the committed checks plus the variant records and the `shadow-candidates.png` sheet). The hand sheets are
`build/review/shell-candidates-shell_hand_slot_12.png` and
`build/review/shell-candidates-shell_hand_slot_draw.png`.

The **shadow is now a synthetic blob** (§10.11): σ 12 px lying / 5 px standing,
core 0.60, offset 5/7, with a separate shadow box; §10.12 replaces the per-tile
union with the merged-footprint group layer. The audition sheet keeps REF
plus A (σ 3), B (σ 5) and C (σ 7). The hand fan and the standing top hand are
approved; the wall fan and side walls are approved; the ponds/melds are confirmed
straight-on. The deferred item is the hand face brightness (the el-28 hand face
is still ~94–107 luma against the pond's ~220) and the tile-to-tile overlay
shadow (§10.11). Nothing downstream starts: no atlas, layout engine, board
renderer or app view, and the felt raster is untouched.

### 10.8 The front/back wall slot fan

The front (bottom, human-side) and back (top) walls are **not one repeated
shell**. The tile straight in front of the human is seen end-on; the tiles
further from the centre are seen from the human's eye, so the far-right tile
shows its inner (left) side and the far-left tile shows its inner (right) side.
The user's example: the furthest-right front-wall tile would show more of its
left side if the other tiles were removed. The fan is therefore baked per slot,
and the dora-indicator blank gets the same per-slot treatment.

**The model.** A wall is 17 stacks (`count` = 17, `centreIndex` = 8) spaced by
one tile width (`stepUnits` = 0.75) along the table edge. The camera is the
human's eye at the centre line:

```text
offsetUnits        = (index - 8) * 0.75
lateralOffsetUnits = -offsetUnits
angleDeg           = atan(|offsetUnits| / wallDistanceUnits)
```

The camera is the same off-axis perspective as the side walls: elevation 45, no
yaw, no roll, looking along the wall's inward normal. It is translated to the
human's x for the slot and re-centred with the solved lens shift. The tile is
never rotated: `rotX 180` (face down) or `rotX 0` (face up), `rotZ 0`. The front
distance is **40.8 units** and the back distance **54.8 units**, taken from the
physical table plan (eye at y −47.8, wall centres at y ∓7.0 on the 28 mm tile
scale). The nearer wall therefore has the stronger fan.

| Slot | Offset (units) | Front angle | Back angle |
| :--- | :--- | :--- | :--- |
| 08 (centre) | 0 | 0.00° | 0.00° |
| 07 / 09 | ∓0.75 | 1.05° | 0.78° |
| 06 / 10 | ∓1.50 | 2.11° | 1.57° |
| 05 / 11 | ∓2.25 | 3.16° | 2.35° |
| 04 / 12 | ∓3.00 | 4.21° | 3.13° |
| 03 / 13 | ∓3.75 | 5.25° | 3.92° |
| 02 / 14 | ∓4.50 | 6.29° | 4.69° |
| 01 / 15 | ∓5.25 | 7.33° | 5.47° |
| 00 / 16 | ∓6.00 | 8.37° | 6.25° |

**Measured.** The centre slot is straight on (front 73 × 102 body, back
72 × 102); the outer slot adds the visible inner side (front **81 × 102**,
back **78 × 102**). The front outer texture is 99 × 120 @1x and the back 96 ×
120 @1x. The projected face is a trapezoid: the top/bottom edge pair stays
horizontal, the near edge is longer (front outer 59.8 vs 59.2 px, back 59.7 vs
59.2 px — a 0.49 px keystone at the far wall), and the depth edges converge.
That is why the perspective check accepts a 0.25 px near-edge margin, not the
0.5 px used when this check only covered the side walls.

**The side face is occluded in a packed run.** The row advances by the physical
width axis (`gridStepPx.x` = 69.72 front / 69.64 back), not by `advanceWidth`,
so the outer sprites overlap their inner neighbour by up to 11 px. The visible
side face tucks under that neighbour, exactly as it would with real tiles. It
appears when the stack is exposed at the end of a drawn-down wall or when the
neighbour is removed (the user's example). `build/review/wall-fan-1x.png` is the
exploded row that shows every slot's side; `wall-stack-1x.png` is the packed,
realistic read.

**The stack drift.** The off-axis camera makes the projected thickness drift
toward the outside of the table: `stackStepPx` is `(±4.06, −39.02)` at the front
outer slot and `(±3.01, −38.9)` at the back outer slot, zero at the centre. The
layout draws the bottom tier first, then the top tier at that slot's own
`stackStepPx`, so the top tile is correctly staggered. The dora indicator is the
face-up shell at the same slot.

**Face-up dora.** `shell_wall_front_slot_<nn>_faceup` uses the same slot camera
and `faceRotationDeg` 0; `shell_wall_back_slot_<nn>_faceup` uses 180 so the
glyph reads for the far player, while the body is still seen from the human's
side. The four new dora families are 17 slots × 2 walls = **34 face-up shells**.
Each is a separate atlas key (a dora blank's decal is its own perspective slot),
so Phase 2 composites 34 × 37 faces = **1,258** dora sprites in addition to the
hand/pond/sideway variants; that is the per-slot dora cost and must be measured
against the atlas budget before the atlas is built.

**Ids.** `shell_wall_front_slot_00` … `shell_wall_front_slot_16` and
`shell_wall_back_slot_00` … `_16`, each with a `_faceup` counterpart. The id
names the slot, not the angle, so a later angle nudge keeps the id stable. The
spec stores a compact `wallSlots` block (count, centre, step, distances, one
entry per wall); the baker and checker expand it to the 68 ids, so the catalogue
cannot drift. Each manifest record carries `wallSlot` with `wall`, `index`,
`offsetUnits`, `lateralOffsetUnits`, `distanceUnits`, `angleDeg` and `faceUp`.

**Budgets.** The 68 wall slots are **3,929,429 B** of the 103-shell
**5,653,539 B** total; `shells.json` is **561,793 B**. The self-imposed Phase 1
budgets are **6,291,456 B** (textures) and **614,400 B** (manifest); the standing
AGENTS limits (total assets ≤ 8 MiB, initial hand + board load < 4 MiB) still
hold, because a board loads only the slots it draws. A board with the 14 hand
slots, 17 front + 17 back wall slots, 4 side walls and the pond/hand base shells
is ~2.2 MB at @1x+@2x, plus the felt.

**Status.** The wall fan is approved. The hand fan is the new open calibration
(§10.9); the side walls are approved; the ponds/melds are confirmed straight-on
(§10.10).


### 10.9 The standing-hand fan

The human's standing hand is the same idea as the front/back walls, on a
vertical face. It is a **13-tile row plus a separate drawn tile**: the row is
centred on the player, so slot 06 is straight on; slots 00/12 are the outer
ends. The drawn tile sits after the +0.35 advance gap and gets its own slot.
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

The drawn tile uses `offsetUnits = +5.5125` (the 13th tile's right edge at
+4.875 plus the +0.35 × 0.75 gap). The camera is the same off-axis perspective
as the walls: azimuth 0, elevation 28, no yaw or roll, translated to the
player's x and re-centred with the solved lens shift. The tile is never rotated:
`rotX 90` stands it up, `rotZ 0` keeps the row upright. The distance is a
**stylised 24 units**, not the physical seat distance: the hand must stay
readable, and the physical eye distance would make the outer face skew much
stronger.

| Slot | Offset | Angle at d24 |
| :--- | :--- | :--- |
| 06 (centre) | 0 | 0.00° |
| 05 / 07 | ∓0.75 | 1.79° |
| 04 / 08 | ∓1.50 | 3.58° |
| 03 / 09 | ∓2.25 | 5.36° |
| 02 / 10 | ∓3.00 | 7.13° |
| 01 / 11 | ∓3.75 | 8.88° |
| 00 / 12 | ∓4.50 | 10.62° |
| drawn | +5.5125 | 12.94° |

**Measured.** The centre body is 71 × 102 (texture 89 × 120); the outer row
slot 82 × 102 (texture 100 × 120); the drawn slot 85 × 102 (texture 103 × 120).
The hand row advances by the physical width axis `gridStepPx.x` = **67.96**,
not the advance width, so the outer bodies overlap their inner neighbour and the
visible inner side is hidden in a packed hand, exactly as with the wall. The
drawn tile is 91.75 px centre-to-centre from the 12th tile (1.35 steps); its
inner side face fills part of the gap. The exploded review sheet shows the fan;
the packed sheet shows the real row.

The face is **vertical**, so the perspective trapezoid is the other way round
from the wall: the top edge is closer to the elevated camera and is the longer
one (the 58.5 px top against the 57.5 px bottom at the centre), while the left
and right edges converge. The checker's `checkPerspectiveQuad` takes a
`verticalFace` flag for this. The blue resin sliver stays on the top edge for
every slot (`[3, 69, 165]` on the drawn slot), and the face is still the el-28
dim read (`94, 100, 107`, luma 99): the brightness is a lighting decision that is
still deferred.

**Ids and metadata.** `shell_hand_slot_00` … `_12` and `shell_hand_slot_draw`.
Each manifest record carries `handSlot` with `kind`, `index`, `offsetUnits`,
`lateralOffsetUnits`, `distanceUnits`, `angleDeg` and `faceUp`. The hand is
face-up, so the 14 slots are 14 face-variant atlas keys (`standing-front-{slot}`,
14 × 37 = 518 sprites) and the glyph stays upright (`faceRotationDeg 0`).

**The top hand.** The top player's concealed hand is a **13-slot standing fan
with the blue backs to the human**, not the flat back-wall shells. The pose is
the human hand turned around: `rotX 90`, `rotZ 180`, `faceLocalZ: bottom` (the
blue backing), no glyph. The camera is the human's eye at **60 units**, el 28,
so the outer slot is **4.29°**; the row step is 67.55 px and the centre is
70 × 102 (88 × 120 texture). Each record carries `topHandSlot` (`kind: top`,
`index`, offsets, distance, angle, `faceUp: false`); the manifest also carries
the generic `faceUp` boolean. The back is a shadowed blue (`[0, 13, 44]` at the
face centre) because the vertical back is turned away from the key's strongest
axis; it is still blue, not the bright face-down blue. The 13 shells are
face-down and bare, so they add no face-up atlas keys.

**Approved.** The hand fan is approved at the 24-unit eye distance (outer row
10.62°, drawn 12.94°). The 14 / 18 / 40-unit audition is kept for reference; the
open calibration is now the shadow (§10.6). The centre stays straight on.

### 10.10 Straight-on ponds and melds

The ponds and called melds are **not** per-slot. They stay straight-on (azimuth
0) with one shell per body orientation, `shell_flat_upright` and
`shell_flat_sideways`, and the four seats are four **glyph orientations** handled
by the face variants / glyph rotation, not four camera variants. This is
confirmed as the desired read: the 6 × 3 pond grid is the most-read face, a
per-slot pond would multiply 18 positions across up to four ponds, and the
uniform tile size is what makes the four seats scan as one grid. The calls and
melds follow the same rule for now; if the meld read needs its own perspective
later, it is a separate task, not a pond change.

The two shells are unchanged from the approved el-45 bake. Their face variants
are `flat-topdown` and `flat-rot90`; the runtime rotates the glyph for the
left/top/right seats into the same faceQuad. The four seat orientations do not
add shells.

### 10.11 Phase 1d: the synthetic blob shadow (landed 2026-11-14)

The Phase 1c contact shadow was a Cycles shadow-catcher alpha. The review found a
structural problem: a shadow baked into a tile's own margin cannot survive the
painter's order, because the shadow of the tile drawn earlier lands on top of the
neighbour. The separate shadow sprite fixed that overlap, but the catcher-derived
field still left a light moat where the rectangular body-box window excluded the
shadow. The user asked for a simpler blob: **a Gaussian-blurred translucent black
shape under the tile's contact point**, with a correction for two adjacent blobs
adding together.

**Generation.** Blender now renders only the tile body; there is no catcher pass.
For each shell the baker projects the mesh's lowest corners (the table-contact
footprint) to pixels. A lying tile (the contact footprint is comparable to the
body box: the flat ponds, the sideways shell, the front/back wall tiles) gets a
**rounded rectangle** matching the body's long/short sides: `rectScale` 1.15 x
the body box plus 8 px, with a corner radius of 0.3 x the short half-axis. Its top
edge is trimmed 40 px while the bottom/left/right edges stay fixed, so the shadow
does not spill above the object (the light is above and behind). A standing or
tilted tile (the human hand, the top hand, the side walls) gets the same rounded
rectangle **fitted to its projected base strip** (`standingRectScale` 1.2, +3 px,
corner radius 0.35) and rotated with the base's principal axes — not a capsule,
which read as an oval. The shape is offset 5 px right / 7 px down, filled at
`coreAlpha` 0.60, and blurred with a separable Gaussian: **sigma 12 px** for
lying tiles and **5 px** for standing ones. The body sprite is the tile only.

**The contract.** `shells.json` publishes a separate `shadowTextureFile` /
`shadowTextureFile2x` with its own `shadowTexWidth/Height`, `shadowAnchorX/Y`,
`shadowOffsetPx` `[0,0]`, `shadowPadding` and `shadowBlob` (`model: blob`,
`shape: rounded-rect`, `sigmaPx1x: 12`, `standingSigmaPx1x: 5`,
`coreAlpha: 0.60`, `offsetPx1x: [5,7]`, `rectScale: 1.15`,
`rectPaddingPx1x: 8`, `cornerRadiusFraction: 0.3`, `topTrimPx1x: 40`, `lying`).
It also publishes `shadowShape`: the derived **hard** rotated rounded rectangle
in @1x px relative to the tile's grid anchor (`centrePx`, `halfPx`, `radiusPx`,
`angleDeg`) plus `sigmaPx1x`, `coreAlpha`, `colorHex` and `lying`. That is the
input to the group recipe (§10.12); the sprite is the same shape rendered alone,
and the checker rasterises it and asserts the two agree (max alpha delta ≤ 0.02).
Lying tiles use the 30/40/46/32 box; standing tiles use 8/30/32/18. A lying tile
must have a real shadow 3-49 px right, 3-53 px below and 0-37 px left, with
**no shadow above the body top** (top extent 0); a standing tile must have one at
the bottom. Every sprite is smooth (max adjacent alpha step <= 0.12), its outer
ring is transparent, and its maximum alpha is the core alpha.

**The union pass (Phase 1d).** The review sheets draw every shadow into one
transparent layer with a per-pixel max, then draw that layer over the felt, then
every body. Two blobs that overlap stay at the single-blob value instead of the
`1 - (1-a)^2` darkening of independent alpha blending. This is the correction for
adjacent tiles, and it is a per-zone pass over whatever tiles are placed: **a wall
that changes length needs no new assets**. It is now the comparison reference;
§10.12 supersedes it with the merged-footprint group recipe.

**The audition.** `--shadow-audition` calibrates the blob: REF (sigma 12, core
0.60, offset 5/7) plus A (sigma 3, 0.55, 4/6), B (sigma 5, 0.60, 6/8) and C
(sigma 7, 0.50, 8/10) on the flat, wall and hand shells.
`build/review/shadow-candidates.png` shows each row with the union pass.

**Validation.** The committed bake runs **7,878 checks** (including the
`shadowShape` raster check), the hand audition **8,057** and the shadow audition
**7,789** on their last matrices (a re-run adds the shape checks). The manifest
records a decoded-RGBA hash per texture for integrity; the optional
`--verify-determinism` diagnostic is not part of the standard run. Textures are
**5,653,539 B** (1,515,854 @1x + 4,137,685 @2x) against the 6,291,456 B budget;
`shells.json` is **561,793 B** against 614,400 B.

**Resolved in Phase 3.5 (§15): contact-shadow decals.** The blob still cannot
darken a neighbour's face; the separate per-shell overlay is now baked and
composed between the bodies. The derivation stays per shell variation, as
predicted; the group recipe above is untouched.

### 10.12 Group shadows: merged footprint, one blur (2026-11-14)

The tile-map idea from the first cut turned out to be exact only for **uniform**
rows. A left / middle / right slice needs every slot in the row to have the same
shadow family; the hand fan, the top hand, the front/back wall fan and the side
wall columns all vary per slot (the camera is at the row centre, so each slot's
base strip and side reveal differ). A pond is not one row either: the lying
shadow is 162 px tall at a 65 px row step, so adjacent rows overlap by roughly
97 px, and a discard row can end on a sideways riichi tile, which changes the
step. The prototype measured the hand as **48.2 / 50.7** at the left transition
and **50.7 / 52.4** at the right one against a smooth true union, plus a 0.2471
alpha error with the drawn tile — that is the seam the user saw.

The runtime recipe is therefore **blur the union, once**:

1. Take each placed tile's `shadowShape` (a rotated rounded rectangle; §10.11).
2. Draw every shape at **alpha 1** into one layer per zone. Overlaps merge; they
   do not add.
3. Blur the whole layer once at the zone's `sigmaPx1x`.
4. Draw it over the felt at `coreAlpha`, then draw every body.

This is `blur(union of footprints)`, not `max(blur(footprint))`. It is exact for
a fan, a shrinking wall and a ragged pond, because it reads the tile placements,
not an asset family; no per-length asset exists. A zone is: all four walls
together (they meet at the corners, so separate layers would double-darken the
corner), each pond, and each seat's hand + melds. Zones do not overlap on screen.
A zone is rebuilt only when one of its tiles moves.

**Runtime paths.** In DOM, a positioned shadow layer containing one rounded,
rotated `<div>` per tile with `filter: blur(σpx); opacity: coreAlpha` on the
parent is exact: a CSS filter applies to the element's rendered children as one
group. In canvas, draw the hard shapes into a **mask** surface at alpha 1, then
`target.ctx.filter = 'blur(σpx)'; target.ctx.drawImage(mask, 0, 0)` — setting
`ctx.filter` before each shape filters each drawing operation, which is the
per-tile model with source-over darkening. SVG can use one `<g>` under
`feGaussianBlur`. The DOM path is the recommended one.

**Validation.** `node tools/render/scripts/preview-group-shadow.mjs` composes
every representative zone twice (`merged` vs `perTile`), writes the sheets under
`build/preview/` and prints the alpha delta and the worst horizontal step. The
derived shape reproduces the committed single-tile sprites (mean 0.0004–0.0009,
max 0.002 alpha). The browser lab,
`group-shadow-lab.html`, renders the CSS recipe live and reports that the
browser's blur matches the reference Gaussian (mean 0.0028, max 0.0277 alpha),
that a screenshot of the CSS route matches the merged field (mean 0.28, max
3.35/255 luma), and that a full-board rebuild (17 zones, 253 shapes, 355 bodies)
costs about 10–12 ms of main-thread work. **The user reviewed the lab on
2026-11-14 and approved the merged-footprint look**, so this is the runtime
contract for the compositor when Phase 3/4 lands. The per-shell shadow sprites
are now redundant for rendering (they remain the checker's reference and the
review sheets). Phase 2b removed the **@2x shadow sprites** to make room for the
carved decals; the @1x shadow sprite remains the checker/review reference.

The uniform pond row is the one place the old tile map is still exact: its
middle is one period of `max_k S(x - k * cell)`, and the test shows a naive crop
leaves a 5.7 luma step while the union period is byte-identical to the true max.
That result stands, but it is no longer the runtime plan; it is the fallback if a
group layer ever proves too expensive on a target device.

## 11. Phase 2: the face glyphs and the startup atlas (landed 2026-11-15)

Phase 2 baked the 37 face glyphs and implemented the startup atlas on the
Phase 1c/1d base. The authoritative pipeline numbers and asset contract are in
[`tools/render/README.md`](tools/render/README.md) §"Phase 2"; this section
records the decisions that narrow the architecture above.

**Assets.** 37 RGBA PNGs at **288 × 384** (34 standard faces + 3 red fives;
blank has no asset), **576,938 B** total against a 1,310,720 B budget. They are
the upstream public-domain symbol-only SVGs at pinned commit
`f37d6cc2557498d23f13eb3e955e0e44e5c863ff`, rasterised offline by
`tools/render/scripts/bake-faces.mjs` with `@resvg/resvg-js` 2.6.2. The masters
are perspective-neutral: the atlas maps one glyph into each face-up shell's
`faceQuad` at startup, so there is no per-shell glyph art. 288 px is 2.07× the
longest @2x face axis (185.1 px). `frontend/public/table/faces.json` records
every glyph's decoded-RGBA sha256, ink bbox/counts and provenance; haku (`5z`)
has zero ink by design and shares the bare slot. No tile art is rasterised in
the browser.

**Runtime.** `frontend/src/table/TileAtlasBuilder.ts` composes one offscreen
Canvas 2D page per **face-up shell**, clips the glyph to the published
`faceQuad` and maps the glyph's own corners onto it. The catalogue is the 16
face-up shells the task enumerated: `standing-front-00..12` + `-draw` for the
14 hand slots, `flat-topdown` for `shell_flat_upright`, `flat-rot90` for
`shell_flat_sideways`. `frontend/src/table/TileAtlas.ts` exposes the
`Map<TileRenderKey, BakedTileSprite>` (key = `shell:faceVariant:face`) and a
lazy `warm(shells)`; the first board warms all 16. Frame code only blits
`page.canvas` at `sprite.uv`. The face-down wall shells are bare and have no
atlas entry: the board draws their PNGs directly.

**Numbers.** 684 keys across 18 pages (648 glyph keys + 36 bare keys; each page
holds 37 slots: 36 inked + 1 shared bare). At **@1x** the atlas is
**7,929,168 px / 30.25 MiB RGBA** and builds in ~33–44 ms in Node Canvas; at
**@2x** it would be **27,575,784 px / 105.19 MiB**, so the loader defaults to
@1x and demotes a requested @2x atlas above `maxRgbaBytes` (48 MiB). A single
hand page at @2x is 1,240,200 px / 4.73 MiB and ~12 ms, so @2x remains available
for a focused preview or a device with the headroom. The review sheets and
`atlas-numbers.json` come from `frontend/scripts/review-atlas.ts`.

**Budgets.** Committed table assets are **7,839,428 B** of the 8 MiB total limit
(shells 4,351,264 + `shells.json` 553,571 + felt 559,465 + flat glyphs 576,938
+ `faces.json` 27,414 + carved decals 1,581,494 + `decals.json` 189,282),
leaving ~0.55 MB. A decal-based initial @1x board is **3,834,658 B** of the 4
MiB initial-load limit; the flat glyph PNGs are build/fallback assets and are
not fetched when every inked face has a carved decal. The atlas is composed
locally, not downloaded. Byte budgets are advisory during active development
(AGENTS.md §1c); they are measured, not a reason to shrink the art.

**Carved decals (Phase 2b).** The flat glyphs above remain the Phase 2
baseline and the fallback. Phase 2b restores the retired pipeline's carved,
painted, separately lit face decal as a transparent overlay; it adds the
`decalManifest` and a second source path in `TileAtlasBuilder` without changing
the key contract. See §12 for the separate upright/lying light rigs, the four
flat river shells and the lying tuner.

**Decisions that narrow the architecture above.**

1. **The atlas is composed at startup, not offline.** The shell and glyph PNGs
   are committed and resvg is a build tool, not a runtime dependency. Composing
   on an offscreen 2D canvas keeps `shells.json` authoritative and lets the
   atlas page scale follow `devicePixelRatio` where the memory allows.
2. **One page per face-up shell.** It keeps lazy warming and the review sheets
   simple, and it lets the key's shell choose the page without a global packer.
   The cost is 30.25 MiB at @1x; a future global shelf packer could recover the
   row-end waste (about 6.8 MiB) if a device needs it.
3. **`faceQuad` carries the shell's rotation; `faceRotationDeg` is the desired
   screen rotation.** For `shell_flat_sideways` the first edge points up the
   screen, which is the 90° CCW glyph rotation; the builder does not rotate the
   glyph again. `glyphRotationDegFor` subtracts the quad's rotation to get the
   extra in-plate rotation (0 for every Phase 2 shell, 180 for the back-wall
   dora slots and 270 for the side-wall dora slots when those land). Mapping the
   glyph's three corners affinely and clipping to the quad keeps the small
   trapezoid keystone inside the plate.
4. **`blank` and `5z` share a bare slot.** A blank tile and a haku are both a
   plain ivory face. The upstream haku SVG rasterises to zero ink; both keys map
   to the shell's shared bare slot instead of two transparent copies. The atlas
   still resolves all 38 face ids per shell, so frame code never special-cases
   a missing key.
5. **No 3D, no WebGL, no per-frame art.** The atlas is an offscreen 2D canvas;
   the only runtime work per tile is `drawImage` from the page. The tests scan
   the atlas modules for WebGL/3D imports and assert draw order (all shell
   bodies before any glyph, clip then transform then glyph) on a recording
   context, plus decoded-pixel proofs for the sideways orientation, the glyph
   margins and the red fives.
6. **The 34 per-slot dora shells are deferred.** They are the next face-variant
   family (§10.5): 34 face-up shells × 37 = 1,258 sprites, 14,424,056 px /
   55.02 MiB at @1x, which would nearly quadruple the atlas. The task's
   deliverable enumerated the three land families; a revealed dora indicator is
   a separate variant-family task, not a glyph swapped at draw time.

## 12. Phase 2b: the carved face decals (2026-11-15)

The user asked to keep the retired pipeline's **carve → paint → light** face
decal, separate from the current shell/board lighting, and paste it onto the
current shells. The other retired pieces (table model, fixed scene camera, body
sprites, scene manifest) are **not** restored. The chosen treatment is
**option A**: a transparent carve/paint overlay, so the shell's own lighting and
face colour remain outside the recessed lip.

**Two light rigs.** The decal is the inset face plate at **150 × 208** (@2x)
plus a 4 px transparent safety ring, so the PNG is **158 × 216**, written with
straight alpha. `facePlateRect` maps the inner 150 × 208 rect to the faceQuad.
It contains the painted symbol, the recessed lip/fillet and cavity AO;
everything outside the carve is transparent (four corners alpha 0, 18–66% of the
image transparent in the spike). The **full upstream 300 × 400 glyph canvas** is mapped to the inset face plate,
matching the flat glyph's sizing; the earlier faceInset UV crop enlarged every
symbol and cut the pinzu/manzu strokes at the canvas edge. The symbol stays
upright in face-local space.
`decal-spec.json` has separate **`lighting.upright`** (the approved parlour rig
for the standing hand) and **`lighting.lying`** (the tunable rig for flat/pond
tiles). `surfaceRotations` bakes one upright light rotation (`0`) and four lying
rotations (`0/90/180/270`); the four lying images are the same tile under four
light directions so the carve highlights change. There is no per-slot fan.

**Lying tuner.** `cd frontend && npm run tune:carved` starts a local app at
`http://localhost:7458` (`HOST=0.0.0.0` for a phone on the tailnet). It writes a
temporary decal spec, runs the real Blender baker for the `1m` face with the
lying rig at four light rotations, and composites each result onto the real,
properly rotated river shell at @2x. A preview takes about **3 s** (48 samples,
carve grid 0.6, AO 4). "Apply lying params" writes only `lighting.lying` (and the
shared carve controls) back to `decal-spec.json`; the upright rig is never
touched. The four previews are the four discard rivers:

| Panel | Shell |
| --- | --- |
| bottom river · 0° | `shell_flat_upright` |
| right river · 90° | `shell_flat_sideways` |
| top river · 180° | `shell_flat_upright_180` |
| left river · 270° | `shell_flat_sideways_270` |

The shell bodies are rendered once by the existing shell baker with the existing
shell/table lighting; the sliders only change the decal. The lying rig is in the
**face-normal frame** (`frame: "face-normal"`): `aroundDeg` turns around the
tile's face normal (0 = tile-up, 90 = right, 180 = down, 270 = left) and
`tiltDeg` is the angle from the normal (0 = head-on, 90 = grazing, 180 =
behind). The atlas adds `-quadRotation` so the room light is fixed while the
tile turns. Rotating around the face normal, not world Z, keeps all four
orientations equally lit; a world-Z rotation sends the key behind the vertical
decal face at 90/180 and makes those carvings read flat.

**Baker.** `tools/render/bake_decals.py` + `decal-spec.json`, Blender 4.5.9,
Cycles CPU, 256 samples for a full bake. It imports the current shell baker's
tile/material/render helpers and ports the retired carve functions
(`alpha_to_distance`, `bezier_profile`, `build_carved_face`) and parameters
(depth 0.0121 × thickness, Bézier 0.6/0.8, transition 0.0107, paint edge 0.18,
cavity AO). The upright parlour rig is translated from its original hand slot
(y=-11.7) to the canonical face; the lying rig is expressed in the face-normal
frame (`aroundDeg` around the tile, `tiltDeg` from the normal) so it reads as
room light on a horizontal tile. `alphaRamp` (0.08) feathers the outer lip into
the shell face.

**Numbers (committed).** The spike is 4 faces × (1 upright + 4 lying) = 20
decals, 926,272 B PNG, ~1 min; `check-decals.mjs` reports 2,991 checks on the
full committed set. The full set is 36 inked faces × 5 surface rotations =
**180 decals** (5z is skipped): the PNG bake is 8,319,064 B, shipped as **AVIF
q60 + alpha, 1,581,494 B**, plus `decals.json` 189,282 B. The redundant **@2x
shadow sprites** were removed (the runtime uses `shadowShape` group layers; the
@1x shadow sprite remains the checker/review reference), so committed table
assets are **7,839,428 B (7.48 MiB)** of 8 MiB and a decal-based initial @1x
board is **3,834,658 B (3.66 MiB)** of 4 MiB. The flat glyph PNGs remain
build/fallback assets and are not fetched by a decal board.

**Runtime.** `frontend/src/table/decalManifest.ts` parses `decals.json` with a
key of `${face}:${surface}:l${light}:s${symbol}`. `TileAtlasBuilder` selects the
surface from the shell (`upright` for the 14 hand slots, `lying` for
`shell_flat_upright`, `shell_flat_sideways`, `shell_flat_upright_180` and
`shell_flat_sideways_270`), picks
`lightRotationDeg = -screenRotationOfQuad(faceQuad)` and
`symbolRotationDeg = faceRotationDeg - quadRotation`, loads the decal instead of
the flat glyph, and still composites one `BakedTileSprite` per
`(shell, variant, face)`. Missing decals fall back to the flat glyph;
`requireDecals: true` makes a missing decal a hard error. No per-frame
compositing is added.

**Review.** `cd frontend && npm run atlas:review:carved` writes
`carved-compare-4x.png` (flat vs carved), `carved-variants-1x.png`,
`carved-hand-fan-1x.png` and `carved-numbers.json` under
`tools/render/build/review/`; the lying tuner writes
`tools/render/build/tune/preview/flat-{0,90,180,270}.png`. The user signs off
the look; the agent does not (AGENTS.md §6).

## 13. Phase 3: the zone layout engine (landed 2026-11-16)

Phase 3 turned the approved reference layouts in
`tools/render/scripts/group-layouts.mjs` into the app's layout module,
`frontend/src/table/zoneLayout.ts`. It is a pure geometry layer: it places
shells and returns body/shadow lists in painter order, but it draws nothing.
Phase 4 owns the compositor and the screen-space placement of the zones.

**What the module publishes.** `layoutHand` (13 slots + drawn tile),
`layoutTopHand`, `layoutMeld` (called tile turned sideways), `layoutPond`
(6 columns, any number of rows, riichi tiles, all four seats), `layoutWall`
(front/back, 17 stacks or a remaining run, per-slot dora) and `layoutSideWall`.
Each returns a `LayoutZone` with:

- `bodies` in painter order and `shadows` as the footprints to union (a wall
  casts one per stack, from its lower tier);
- `width`/`height` from the body + hard `shadowShape` bounds, normalised to
  `(0, 0)`, plus `sigmaPx1x` and `blurPad = ceil(3σ)`;
- a Task 4.1 `layer` (`1` top wall/hand, `2` side walls, `3` ponds, `4` bottom
  wall, `5` side hands/melds, `6` bottom hand/melds) and a `shadowGroup`.

**Decisions.**

1. **Face-centre anchoring, not body-box left.** `gridX = faceX -
   (faceQuadCentreX - anchorX)`. The outer fan slots carry a visible side
   reveal, so body-box placement spreads the right half. The formula is tested
   on every hand body and is the reference's own `faceAnchored`.
2. **`gridStepPx` is the row and wall step; the advance box is the hit box.**
   The task's original "advance width" wording is superseded by §8 decision 4.
   `hitBox` is exactly `[gridX, gridY, advanceWidth, advanceHeight]`.
3. **Draw positions are whole @1x px.** `drawX/drawY` are rounded after the
   zone is normalised; `gridX/gridY` and the hit box stay fractional.
4. **The hand's gap comes from the manifest.** The slot positions use each
   shell's `handSlot.offsetUnits` over the 0.75-unit slot pitch, so the drawn
   tile is 5.5125 units (1.35 × 67.96 = 91.75 px) after the 13th slot. The top
   hand uses its own 67.55 px step and 13 bare blue-back shells.
5. **Pond frames are per seat.** Columns step by the normal shell's short axis
   (`gridStepPx.x`), rows by its long axis (`gridStepPx.y`). A turned tile (a
   riichi discard or a called meld tile) advances by its long axis
   (`gridStepPx.y`, 104 px on the bottom row) and shifts along the row toward
   the player so the near body edge stays on the line: +7 px at the bottom. It
   is also placed after the **previous face** with the row's normal face gap,
   because a sideways face is 92.56 px wide against the normal 59.22 px; without
   that 16.67 px face shift the tile to the left clipped the riichi's face. The
   next tile keeps its nominal slot.
6. **Walls.** Front/back steps come from the centre slot (`slot_08`,
   `gridStepPx.x` = 69.72/69.64); the upper tier is the lower tier's grid +
   `stackStepPx`; the dora indicator selects the `_faceup` shell. Side walls
   step down whichever published axis has the positive y component
   (`(-6.91, 45.96)` left, `(6.91, 45.96)` right) and draw all bottom tiers
   before the top tiers (Task 4.2).
7. **Shadow groups follow the sigma, not just the seat.** All four walls share
   `walls`; each pond is its own group. A hand (standing σ 5) and its melds
   (lying σ 12) stay separate `seat-<side>-hand` / `seat-<side>-melds` groups:
   one blur per group cannot apply both sigmas. Phase 4 can still choose to
   treat them as one seat group if it picks a single sigma.
8. **Dora shells stay bare.** The 34 per-slot dora shells are not in the Phase 2
   atlas, so a dora tile has `face: null` even though the layout already selects
   `shell_wall_*_faceup` / `shell_wall_side_*_faceup`. The deferred dora
   variant family changes no position.

**Verification.** `frontend/src/table/zoneLayout.test.ts` has 33 tests. The
reference parity test imports `group-layouts.mjs` itself and compares all eight
representative zones: identical width/height/sigma/pad, identical body ids and
normalised grid positions in painter order, and identical shadow-footprint
positions (the side wall's tiers are compared as a set because Task 4.2 orders
all bottom tiers first).

`cd frontend && npm run layout:review` writes
`tools/render/build/review/zone-layouts-1x.png` and
`zone-layout-numbers.json`, plus `pond-layouts-1x.png`, which draws the same 24
discards and row-2/column-4 riichi as the bottom, right, top and left ponds with
each seat’s normal/turned shells and frame. The committed run reports **10 zones
/ 300 tiles, 0 fractional draw positions, max face-anchor error 1.14e-13 px, 0
hit boxes off the advance box**:

| Zone | Size @1x | Bodies | Shadows |
| :--- | :--- | ---: | ---: |
| human hand, 13 | 902 × 122 | 13 | 13 |
| human hand, 13 + draw | 994 × 123 | 14 | 14 |
| top hand, 13 | 897 × 120 | 13 | 13 |
| left side hand, 13 | 194 × 684 | 13 | 13 |
| right side hand, 13 | 188 × 644 | 13 | 13 |
| open meld, 3 | 238 × 127 | 3 | 3 |
| pond row, 6 | 446 × 127 | 6 | 6 |
| pond, 4 × 6 with riichi | 481 × 323 | 24 | 24 |
| front wall, 17 stacks | 1222 × 166 | 34 | 17 |
| left wall, 17 stacks | 247 × 884 | 34 | 17 |

**Stop point.** No app view is wired and no zone is placed on screen yet. The
felt, the shell/atlas assets and the shadow lab are unchanged. Phase 4 consumes
these zones; Phase 5 adds the hover lift and hit-testing against `hitBox`.

## 14. Phase 3b: the side-hand backs and the riichi face clearance (landed 2026-11-16)

The Phase 3 review found two gaps, both closed in the same session.

### 14.1 The left/right concealed hand shells

The catalogue had no shell for the left or right player's concealed hand. They
are the side-wall read applied to a standing tile: one shell per side reused
down a single 13-tile row, not a per-slot fan. The pose is `rotX 90` with `rotZ 270` on the left and `rotZ 90` on the right
(standing, blue back to the human), with the side wall's off-axis perspective
(`el 45`, lateral ±2 units inside, distance 10). The poses are mirrored like the
side walls' cameras, so both blue backs face the human while each keeps its own
side-wall read.

| Shell | Body | Texture | gridStepPx x / y | Shadow |
| :--- | :--- | :--- | :--- | :--- |
| `shell_hand_side_left` | 67 × 102 | 71 × 106 / 142 × 212 @2x | (−6.7, 45) / (9.05, 64.01) | 163 × 168, standing σ 5 |
| `shell_hand_side_right` | 67 × 102 | 71 × 106 / 142 × 212 @2x | (6.2, 41.67) / (−9.05, 64.01) | 163 × 168, standing σ 5 |

The standing shadow is a rounded rectangle fitted to the yawed base strip; a
vertical face is forced to `lying: false` rather than trusting the footprint
heuristic (the side hands' projected strip is wide enough to fool it). The yawed
shape needs a wider shadow box than the hand fan, so the two shells publish a
per-shell `shadowPadding1x` (8/52/58/44) and the baker uses it. Their backs are
the shadowed blue family, like the top hand, not the bright face-down wall blue.
They are bare and add no atlas key; `FACE_DOWN_SHELL_IDS` now lists them.

The layout engine gets `layoutSideHand(manifest, { side, count })`: the row
reuses the shell from the far tile to the near one and reports a standing shadow
group (`seat-left-hand` / `seat-right-hand`, layer 5). The committed rows step
by the published camera axis, `(−6.7, 45)` on the left and `(6.2, 41.67)` on the
right; the representative sizes are 194 × 684 (left) and 188 × 644 (right).
The row's visible staircase came from the axis-aligned shadow, not the body
positions; the shadow shape now turns with the row normal.

**Catalogue counts.** Two base shells were added, so the committed catalogue is
**107 shells**: twelve base + 14 human-hand slots + 13 top-hand slots + 68 wall
slots. Textures total **4,428,110 B** (budget 6,291,456 B); `shells.json` is
**563,226 B** (budget 614,400 B); `check-shells.mjs` reports **7,710 checks
passed**.

### 14.2 The pond riichi face clearance

The reference pond advanced the row by the sideways shell's long axis but placed
the turned face's *centre* at the next cursor. A sideways face is 92.56 px wide
against the normal 59.22 px, so its left edge started 16.67 px inside the tile
to its left's face and the left tile (drawn last) clipped it.

The row now places every tile by its **face plate**, not by a bare cursor:
the turned tile starts after the previous face plus the row's normal face gap
(`normalStep − normalFaceExtent`), and the next normal tile keeps the nominal
slot. On the bottom pond that is a **+16.67 px** shift of the riichi tile, which
leaves the normal **10.19 px** face gap on both sides while the bodies still
tuck under the neighbours' bevels (the expected adjacent-tile read). The same
rule is applied to the called tile in a meld and to every seat's pond frame
(right +5.59 px along its column, top/left mirrored). The reference
`group-layouts.mjs` applies the same rule, so the parity test still compares the
two implementations exactly; the test also asserts the riichi face gap directly.

On a side pond the turned tile also stays on its discard-row line: the
horizontal near-edge nudge (+7 px on the bottom row) is not applied to a vertical
row, where it would push the narrower turned body into the next discard row. The
right pond riichi is therefore centred on its row, while the column face gap
still shifts it 5.59 px along the column.

**Pond body order is a depth sort, not the logical row order.** The bottom and
top ponds draw the logical row furthest from the viewer first (bottom row 0,
top row 3); the side ponds draw the highest screen column first (right column 5,
left column 0); inside one depth line the bodies are drawn right-to-left. This
matters because a side pond's logical rows are horizontal but its tiles are
stacked into vertical columns on screen, so walking the logical rows would draw
the near column before the far one. `layoutPond` assigns each placement its
logical row and column and sorts on the seat's depth key (`row` for front/back,
`-row` for top, `-column` for right, `column` for left), then descending screen
x. A vertical meld row follows the same far-to-near rule (top tile first).

**Side-pond lean (retired).** The side ponds are **perfectly straight** in the
production board (`SIDE_POND_LEAN_DEG = 0`). The review tried whole-zone Z
rotations at 1°, 3° and 5° and a centred pivot; every value read as tipping the
pond off the table, so the lean is dropped. `layoutPond` still accepts
`leanDeg` for the isolated lab and a future revisit. When a lean is requested it
is a group transform of
the composed pond (shadow layer + bodies), not a per-tile reposition or a new
sprite; every tile, face and shadow stays the baked asset. `layoutPond` publishes
`rotationDeg`/`pivotX`/`pivotY`; the grid positions and hit boxes remain in the
unrotated local space, so Phase 4 applies the transform to the zone group and
Phase 5 applies the same transform when hit-testing. `leanDeg` overrides the
angle, and `0` disables it.

**Contact shadows.** The few visible slivers where two tiles touch were not
shadowed because the group blob is unioned under both bodies. Phase 3.5 closed
that gap with per-shell decals; see §15.


## 15. Phase 3.5: contact-shadow decals (landed 2026-11-16)

The group layer (§10.12) is one blurred union **under** every body. It is correct
for the felt, but where two tiles touch the neighbour's exposed sliver is not
darkened: the bodies cover the union. Phase 3.5 adds a **contact-shadow decal**
per shell and per screen side. It is still 2D: no WebGL, no per-frame lighting,
and the group recipe remains one blur per zone.

**Scope follow-up (2026-11-16 review).** The lying face-up ponds and melds read
as smudges with contact bands over tiles that already look right, so those
families are deliberately unshadowed; the top hand, side hands and walls are
also off. The human hand was first narrowed to synthetic per-caster-side bands,
then approved as **target-space 3D catches**. `overlay.enabledFamilies` in
`shell-spec.json` is the synthetic fallback switch; the catches are a separate
`catches.json` and take precedence in `contactOverlays.ts`.

**3D catch (active standing-hand path).** `tools/render/bake_hand_catches.py`
renders the target tile with its adjacent caster at the target's published shell
camera. It covers the human hand (12), the top hand (12) and one catch per side
hand (the shell is reused down the row; its row sign is verified against the
committed `gridStepPx`). The hidden caster is translated until its **projected
contact edge** matches the committed caster sprite's body edge: the per-slot
caster sprite is normalised for its own camera, and under the target camera its
physical edge can sit ~3 px inside the drawn edge, leaving a bright unshadowed
sliver on the target's visible side (worst on the right half of the hand). That
is a catch alignment fix, not a layout-spacing change.
The per-slot cameras are one eye at the row centre (`lateralOffsetUnits =
-offsetUnits`), so the pair is just the target at the origin, the caster one
0.75-unit row step away, and the same eye; the target's reference crop is
**byte-identical to the committed target body**. Each pair combines the physical
key/world shadow (reference vs caster-present, caster invisible to camera) with
a **contact AO** term (an emission target with a Cycles ambient-occlusion node,
distance 0.12 units, no key/world; the caster occludes the AO rays). The result
is a straight-alpha ink overlay in the target's own texture coordinates, one per
covered slot (12 hand + 12 top + 2 side = 26), published in `catches.json`; the
compositor draws it at the target's `drawX/drawY`, after the target body and
before the caster body, clipped to the target's **full advance box**, not the
synthetic bands' inset `bodyQuads` hull. The lying ponds and melds extend the
same method with multiple primary casters: the distinct
`target | zone side | nearest caster per side` signatures from the full
pond/meld stress matrix are published in `lying-catches.json` (**107 catches**, 671,367 B). The turned Riichi/called tile is excluded as a target and as a caster: its 3-D cell does not line up with the face-centred turn and produced a black-square shadow; those tiles stay unshadowed. Walls use one full 17-slot run per wall/side; run-edge and dora-faceup variants are dropped, and the dora shells alias to their face-down twin. Wall visible means: front 13.21, back 13.23, side 1.98/1.93; the checker is 3,065 checks. The resolver selects a lying catch by that signature before falling
back to the standing `target:caster` catch or a synthetic band. Walls remain
disabled. The catch is already masked to the
target's opaque body; the inset hull clips the bevel at the body edge and leaves
a bright sliver on the target's bottom/side face (the small light line at the
bottom of the right-half hand's left face). The synthetic bands (including the σ 2.5/α 0.50
right-side override) remain a fallback for any pair without a catch. The lying
ponds/melds/walls are active through `lying-catches.json`; the turned Riichi/called
tile is deliberately unshadowed, and the walls use the trimmed full-run matrix.

### 15.1 What the decal is, and why it is not `shadowShape`

A decal is a small straight-alpha PNG of a soft band that hugs one edge of the
caster's *own body silhouette*, baked from the committed shell PNG alpha:

```
alpha(d) = coreAlpha * exp(-0.5 * (d / sigma)^2)
```

`d` is the distance outward from the silhouette's opaque contour in @1x px; the
band is zero inside the body and beyond `supportSigma * sigma`, and fades to zero
over `tangentFadePx1x` at both ends. The contour is **fit to a smooth line along
the tangent** (with a local smoothing fallback for a genuinely curved edge), so
the silhouette's 1–3 px bevel staircase cannot become horizontal steps on the
neighbour; the fill still starts at the true contour so no bright strip is left
under the body edge. The committed values are `coreAlpha 0.35`,
`sigmaPx1x` 6 lying / 4 standing, tangent fade 16 px, support 3σ, ink `#0b1418`;
the hand's `right` side overrides those with σ 2.5 / α 0.50.
The band is not the cast blob: `shadowShape` is 1.15× the body box with a 40 px
top trim and a 5/7 offset, so using it here would smear across the neighbour
instead of hugging the contact. Only its `lying/standing` classification, ink
and sigma family are reused.

A decal belongs to the **caster** (the later body) but is drawn **after the
neighbour body it lands on** and before the caster's body. The caster covers the
overlap; only the neighbour's exposed sliver darkens. The compositor clips the
decal to the neighbour's published **body polygon** (`bodyQuads`), an inset
convex hull of its opaque silhouette. The advance box is not enough: an oblique
side-wall or standing-hand body does not fill its box, and a box clip would let
the band show through the empty corners onto the felt.

### 15.2 Contact detection and painter order

`frontend/src/table/contactOverlays.ts` derives the contacts from the **Phase 3
painter order**, not from a per-zone special case. For each earlier body A and
later caster B whose drawn advance boxes overlap, each B edge that lies strictly
inside A's box with at least 4 px of edge overlap is a contact. A decal whose
strongest point is already covered by a later body is pruned. The same pair can
qualify on two sides, which is what the side hand's L-shaped sliver needs.

This is the complete matrix; the four ponds differ exactly as §10.10 predicted:

| Family | Later body is | Sides used |
| :--- | :--- | :--- |
| Bottom / top pond | below (row seam), left/right (column seam) | `up`, `left`, `right` |
| Right / left pond | below in a column, across the logical rows | `up`, `left`, `right` |
| Turned riichi / called tile | sideways family; the near-edge nudge | inherits its shell's sides |
| Human hand fan | the inner neighbour (left or right half) | `left` / `right`; centre both |
| Top hand | the same fan rule on blue backs | `left` / `right` |
| Side hands | the next tile down-left | `up` + `right` (or `left`) |
| Melds | the pond row rule; called tile sideways | `left` / `right` / `up` |
| Front / back wall fans | inner slot horizontally; upper tier down | `left` / `right` / `down` |
| Side wall columns | next stack down; upper tier down | `up`, `down` |

The **side-pond 3° lean** is a single group transform around
`rotationDeg/pivotX/pivotY`; the decals are baked and drawn in the same local
unrotated frame as the bodies, inside that transform. The grid positions and hit
boxes stay in local space, exactly as Phase 3 publishes them.

### 15.3 Asset and manifest contract

`tools/render/bake_overlays.mjs` bakes
`frontend/public/table/overlays/<shell>--<side>.png` and the `2x/` twin, plus
`frontend/public/table/overlays.json`:

- `model`: `contact-ao-band`, `coreAlpha`, `sigmaPx1x`, `tangentFadePx1x`,
  `supportSigma`, `colorHex`, and the anchor/clip rules;
- `aliases`: the `_faceup` wall dora shells share their face-down twin's decal
  (the drawn body geometry is identical);
- `bodyQuads`: one inset convex clip polygon per shell, in drawn-body-box
  coordinates;
- `decals`: keyed `${shell}:${side}`, with the texture files, @1x size,
  `bodyAnchorX/Y`, support rectangle, peak alpha, decoded-RGBA sha256 and bytes.

The `(shell, side)` set is not hand-written. `frontend/scripts/export-overlays.ts
--sides` runs the real layout over **5,877 supported compositions** (every pond
length and Riichi position × 4 seats, hands 1–14, side hands, melds with every
called index, every wall run/start/dora) and writes the side histogram; the
baker bakes exactly that set. The `--fixture` mode writes the committed
`tools/render/overlay-zones.json` for the dependency-free checker, and
`contactOverlays.test.ts` rejects fixture drift.

The current bakes produce **13 synthetic hand decals** (fallback; 35,780 B across
both scales) and **26 target-space 3D catches** (12 human + 12 top hand + 2 side
hands; active; 109,321 B across both scales). The catches publish `target:caster`, the target texture size, peak/mean
alpha, support, decoded-RGBA sha and bytes.

### 15.4 Verification

`node tools/render/scripts/check-overlays.mjs` runs **1,116 dependency-free
checks**:

- **assets**: the synthetic fallback bands still pass their size/bytes/hash,
  outer-ring, peak, contour-staircase and inside-body checks. Each **catch** is
  exactly the target shell texture size, hashes to its published decoded RGBA,
  has its published peak/mean/support, is transparent on the outer ring and is
  **zero outside the target's opaque body**;
- **layout**: every contact in the fixture resolves to a catch or a fallback
  decal, every overlay is attached to an earlier body, every draw position is
  whole-pixel, and every clip polygon is convex and inside the body box;
- **pixels**: the group shadow + bodies + overlays are composed over the real
  felt at 1:1 and compared with the same composition without them. Every zone
  changes **zero felt pixels**; the group field is identical (it is the same
  object) and the §10.12 seam kink stays below 0.05. The **four ponds are
  asserted to stay unshadowed** (0 overlays, 0 changed pixels); the human hand
  uses the 12 catches, with mean Δluma **17.96** on 7,637 changed body pixels
  and zero felt change. The top hand's 12 catches are drawn with mean Δluma
  **7.70**; the side hands' catches with **3.41 / 1.69**. The disabled families
  are byte-identical to the no-overlay baseline.

The review script (`cd frontend && npm run overlays:review`) writes
`build/review/hand-layouts-1x.png` (the hand at 1:1 plus left/centre/right seam
crops with and without the catches — the active sign-off sheet),
`overlay-decals-1x.png` (the 12 catches), `pond-layouts-1x.png` (the disabled
baseline), and `overlay-zones-1x.png`. The layout script's bodies-only pond sheet
is `pond-layout-bodies-1x.png`. The build-only experiment sheet
(`build/contact-shadow-experiment/contact-shadow-experiment-sheet.png`) remains
the A/B record. Visual sign-off is the user's (AGENTS.md §6).

### 15.5 Known limits

- The **turned Riichi/called tile is unshadowed by policy**: its 3-D cell does
  not line up with the face-centred 2-D turn and the catch produced a black
  square at its far end. It is excluded as a target and as a caster; a normal
  target's catch simply omits it.
- **Walls use one full 17-slot run per wall/side.** Run-edge and dora-faceup
  variants are dropped; the dora shells alias to their face-down twin. A missing
  run-end neighbour can still contribute a faint full-run shadow, and the wall
  upper centre (no later caster) has no catch.
- The synthetic bands remain a fallback for a family without a catch. A catch
  is already target-masked and uses the full advance box; the synthetic bands
  use the neighbour's inset `bodyQuads` hull.
- The multi-caster lying catches are one combined bake per target, so they do
  not stack multiple bands; the catch's shared-body alpha is the review sheet's
  gate. The decoded-pixel check asserts zero felt change for every zone.
- The decals are baked per committed shell silhouette, so a future shell or a
  change to a body texture must re-run `bake-overlays.sh --bake` (the side
  histogram and the fixture are regenerated by the same command).
- The **3D catch** is the committed active hand path
  (`bake-hand-catches.sh`); the two-pair experiment
  (`bake-contact-shadow-experiment.sh`) is kept as the A/B exploration harness.
  The catches are target-space, so they carry the target's own bevel and edge
  exactly; the synthetic per-caster stamp remains the fallback.

## 16. Phase 4: the painter's-order compositor (landed 2026-11-16)

Phase 4 makes the rendered table visible. It consumes Phase 3's `LayoutZone`s
and the Phase 2/2b atlas and implements Tasks 4.1-4.2 plus the §10.12 group
shadow contract. There is still no table model, no browser 3D context and no
per-frame lighting: one 2D canvas over the committed felt.

**Canvas, not DOM, for the runtime path.** The startup atlas is a set of
canvas pages (§11), so bodies are already canvas blits; drawing them as DOM
images would need a second copy of every composited sprite. The §10.12 canvas
route is therefore the runtime: hard shapes into a mask, one filtered
`drawImage`, and the DOM only for the accessible hit layer. The DOM lab remains
the reference for the CSS-filter route.

**Modules.**

- `frontend/src/table/boardLayout.ts` — pure board composition. `buildBoard`
  turns a `GameState` into the zones it needs, places them around the reserved
  centre square, normalises the result to `(0, 0) + 28 px` felt, and publishes
  the Task 4.1 painter order plus one `BoardShadowGroup` per blurred
  union.
- `frontend/src/table/TableCompositor.ts` — the strict painter. One offscreen
  layer per shadow group (hard shapes at alpha 1, one `ctx.filter = blur(σ)`
  draw of the mask at `coreAlpha`) and one per body zone (bodies in the
  published order, contact decals between them). It caches every layer by a
  content signature and rebuilds only what changed.
- `frontend/src/table/boardOverlay.ts` + `frontend/src/components/RenderedTable.tsx`
  — the view and its transparent hit layer. The board is a `<canvas>`; over it
  are absolutely positioned seat/zone/tile elements carrying the top-down
  view's names and the published advance box of every tile.
- `frontend/src/table/boardAssets.ts` — loads the atlas, `overlays.json`,
  `catches.json`, `lying-catches.json`, and the bare-shell/contact textures the
  current board actually uses.

**Placement (not a shared camera).** The four ponds grow away from a 180 px
centre square; each wall sits between its pond and its hand; the four walls
share one `walls` shadow group. Hands sit outside the wall ring; the bottom hand
is drawn last (Task 4.1 layer 6). Melds sit beside their seat's hand on that
player's right, outside the ring: the compact ring has no inside lane wide
enough for a lying meld, and a player's calls read correctly next to their own
hand. A side pond keeps its approved 3° whole-zone lean; `buildBoard` rotates
its shadow shapes and publishes a `rotationPad`, and the compositor rotates the
body layer by the same transform.

**Wall ring.** The riichi wall is a full ring for the whole hand: **17 stacks
on each of the four sides**, meeting at the corners from the first draw. The
engine payload's `tiles_remaining` is the live wall and does not change the
physical ring. (The first Phase 4 cut drew a shrinking nine-stack run from the
live count; the 2026-11-16 review corrected that.)

**Group shadows.** The §10.12 recipe is the runtime path, not the lab path:
every hard `shadowShape` is filled into a mask at alpha 1, the mask is blurred
once per group, and exactly one `drawImage` composites it at `coreAlpha`.
`TableCompositor.test.ts` compares the resulting alpha field to
`tools/render/scripts/shadow-group.mjs` (the same reference the lab uses):
mean error below 0.01 and max below 0.05, with the overlap measuring one union
rather than a source-over stack. A per-shape recipe would have assigned the
filter 144 times for the fixture board; the compositor assigns it once for each
of the 11 groups.

**Contact decals.** Phase 3.5 landed the decals and their resolver but had no
compositor. Phase 4 resolves them per board and draws each one after the body it
shades and before the caster body, clipped to the published polygon. The loader
therefore preloads exactly the catch/band textures the current board names. The
atlas in this path is the carved-decal atlas: the fixture board resolves **648
decal sprites and 0 flat glyph sprites**, and a `1p` sprite differs from its
flat-glyph twin by a mean 17.3 luma (max ~200) inside the face plate. If a tile
looks flat, it is the display size, not a flat-glyph fallback.

**Review follow-ups (2026-11-16).** The rendered pass exposed five layout
issues, fixed here:

1. The wall is a full 17-stack ring on every side. The side walls tuck **80 px
   under the front/back wall ends** at the corners, and their bottom tile edges
   sit **exactly on the front wall's bottom edge**. The front wall is painted
   after the side walls and covers the join. The **back wall is scaled to 0.95**
   as a distance cue; the front wall stays at 1.0.
2. The side-pond lean is **removed**; every pond is straight
   (`SIDE_POND_LEAN_DEG = 0`). Z rotations at 1/3/5° all read as tipping.
3. The side hands use the published per-side camera axis: left `(−6.7, 45)`,
   right `(6.2, 41.67)`. Zeroing or flipping the drift made the left row worse.
   The apparent staircase is the shadow, not the bodies: the side-hand shadow
   shapes now turn with the row normal.
4. The side-wall and side-hand hard shapes are turned with their rows (side
   walls: the column normal, ±8.55°; side hands: the row normal, about −8.5°),
   so `blur(union)` is a long smooth band. The scripted edge scan requires a max
   step below 2.5 px away from the rounded caps.
5. The shared `walls` group uses a **20 px** blur override rather than the
   published lying sigma of 12; on a 1200 px run the 12 px tail read as a hard
   edge. The **side-hand groups also use 20 px** (the second review's request;
   their published standing sigma is 5). The bottom/top hand groups stay at 5.

**Distance scaling.** The human's bottom pond is the reference at 1.0. The
three far ponds (top, left, right) draw at **0.9**, and the back wall at
**0.95**; their bodies, shadow footprints and hit boxes use the same scale.
The side walls and front wall stay at 1.0. This is a presentation scale on the
composed zone, not a new shell or a per-tile reposition.

The face-up tiles use the carved decal atlas (648 decal sprites, 0 flat glyphs;
a `1p` sprite differs from its flat twin by a mean 17.3 luma). The review still
found the relief too flat at the board's display scale, especially the pinzu
dots; that is the follow-up task **261116-2115, "2.5D polish: stronger carved
lighting for face-up decals"**, not a runtime fallback.

The blue-back side hands' **per-shell 3D catches** still use the pre-alignment
row offset; re-baking them is a Blender follow-up. The group shadow, which is
what the rendered view actually draws under the hand, is aligned.

**Pond lean.** Production is straight: no rotation, no lean. `cd frontend &&
npm run pond:review` keeps the isolated lab (`build/review/pond-lean-lab-4x.png`)
with the straight production panel plus the Z-centre, Z-near,
shear-with-upright-sprites and opposite-sign experiments; it is a historical
record now that the lean is dropped.

The left/right hand rows still reuse one shell down 13 tiles. The stronger
side-hand perspective makes the far end of each face narrower, so identical
shells cannot make the fronts line up; the backs only look aligned. That needs a
new shell capture with a weaker (closer to isometric) perspective and a re-bake
of the two side-hand shadows/catches: task **261116-2217, "2.5D polish: re-bake
left/right hand shells with weaker perspective"**, is **started** in its own
worktree/session.

The front/back wall runs measure **1201.35 px** (front, bottom) at 1.0 and
**1136.0 px** (back, top) at 0.95 after the distance scale: the back is now
about 65 px (5.4%) smaller, which is the requested cue.

**Caching.** `update()` returns the zone/group ids it rebuilt. A second update
with the same board rebuilds nothing; changing one pond body rebuilds that pond
zone only, and changing a shadow union rebuilds that group only. A real discard
that makes a pond grow to a new row also moves the wall and hand below it (the
board must make room), so those moved zones rebuild as well; unchanged zones and
groups are still reused, and no shadow union is re-blurred unless its shapes
changed. A Phase 5 hover lift touches one seat's hand zone and its standing
shadow group is unchanged, so exactly one body layer redraws.

**Accessibility.** The hit layer is the accessible table: four seat sections use
`TABLE_SIDE_LABELS`, each pond/meld/hand keeps the top-down name, every placed
tile is a labelled `role="img"` with `data-hit-box="x,y,width,height"`, and the
centre carries the same wind/score/Riichi/round/wall-count information as the
top-down compass. The stacked and top-down views remain the fallback. The
centre scoreboard is a DOM overlay, not a table part; the addendum's "compass
deferred" note is narrowed to the dora-indicator wall slot, which the payload
still does not map.

**The dock stays.** The human's standing hand is drawn on the board because
Task 4.1/4.2 require it; the hand dock stays the primary tap target and keeps
its toggles, probabilities and answer summary. Phase 5 will wire the board's
hit boxes (lift, selection and hover) and can then choose whether the dock's
tile row is still needed in this view.

**View switch.** `TableView` is now `stacked | topdown | rendered`; the header
select offers Rendered and the persisted setting keeps the same hand, answer and
grade when it changes. No game logic moved into React: the view only reads
`GameState` and the committed manifests.

**Verification.**

- `cd frontend && npx vitest run` — **21 files / 265 tests**, including 33
  board-layout tests (global layer order, fan/pond/wall tier order, advance-box
  hit boxes, non-overlapping shadow-group bounds, compass geometry, group
  sigmas) and 8 compositor tests (composite order, one blur per group, cache
  granularity, a reference-alpha pixel comparison, and the side-wall edge scan) and 7 rendered-table
  DOM/ARIA tests (seat and zone names, one hit box per body, the claim
  marker, compass labels, the Rendered option).
- `npx tsc --noEmit -p tsconfig.app.json`, `npm run lint`, `npm run build` all
  pass.
- `node tools/render/scripts/preview-group-shadow.mjs` — the group recipe's
  seam numbers are unchanged: worst boundary kink ≤ 0.0072 on every
  representative zone; merged vs per-tile mean alpha 0.0054-0.0173 for the wall
  and pond families.
- `cd frontend && npm run pond:review` writes the isolated side-pond lean lab
  (`build/review/pond-lean-lab-4x.png`) for the open visual pick.
- `cd frontend && npm run board:review` writes
  `tools/render/build/review/rendered-board-1x.png` and
  `rendered-board-numbers.json`. The committed fixture reports **2257 × 1377 px
  @1x, 14 zones, 11 shadow groups (walls and side hands at sigma 20), 212
  bodies, 144 hard shapes, 193 contact decals, 153 preloaded textures, 648
  decal sprites, 892,275 opaque body pixels and 613,992 shadow pixels, with 0 non-transparent pixels on the outer 4 px
  edge**; the painter order is the 11 group layers
  then `wall-back`, `hand-top`, `wall-side-left`, `wall-side-right`,
  `pond-bottom`, `pond-right`, `pond-top`, `pond-left`, `wall-front`,
  `hand-left`, `melds-right-0`, `hand-right`, `melds-bottom-0`,
  `hand-bottom`; the second update rebuilds 0 zones and 0 groups. The
  textures are dominated by the per-slot wall shells (four sides × 17 stacks ×
  two tiers); a
  board loads only the slots it draws. Byte budgets are advisory (AGENTS.md
  §1c).
- **Visual sign-off is the user's** (AGENTS.md §6). Open
  `tools/render/build/review/rendered-board-1x.png`, then
  `cd frontend && npm run dev` → View → Rendered. What needs the user's verdict
  is the look of the composed board (zone spacing, whether the wall ring reads
  as a ring, whether the centre scoreboard is legible at the app's width), not
  the shadow alpha, which the tests and the lab measure.

**Stop point.** No hover lift, selection, tint or shimmer yet: the hit boxes are
published but `pointer-events` is still off. Phase 5 owns those interactions.
