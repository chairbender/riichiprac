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
* **Shadow Texture Bounds (`shadowTexW`, `shadowTexH`):** A separate, larger transparent box holding the blob. It has its own `shadowAnchorX/Y`; draw it at `grid - shadowAnchor`. A lying tile's blob is an ellipse covering the body box, fading ~10–21 px past the right/bottom edges; a standing or tilted tile's blob is a capsule at its base. The blob is translucent black (`#0b1418`), a Gaussian-blurred shape (σ 4 px @1x) offset 5 px right / 7 px down.

The shadow is specified in **pixels at the @1x base**, not as a percentage of
the tile, and it is never baked into the body.

**How this handles both touching and isolated tiles automatically:**
1. **Shadow union first, then bodies:** For each zone, draw every shadow sprite into one transparent layer with a per-pixel max (the union), draw that layer over the felt, then draw every body. Two adjacent blobs that overlap stay at the single-blob darkness instead of double-darkening, and a shadow can never darken a neighbouring tile's face.
2. **Uniform Horizontal Rows (Drawn Right-to-Left):** Body painter order for the pond/discard rows, so the left tile's bevel sits over the right tile's where they touch. The shadows are already unioned below both bodies.
3. **Per-Slot Fan Rows (Drawn Outermost-to-Innermost):** The standing hand, the top hand and the front/back walls are baked as a camera fan whose centre is straight on, so the **inner** tile is nearer the camera than the outer tile. A uniform right-to-left order is wrong on the left half: it puts the outer left tile on top of the inner right tile, but the inner tile should overlap the outer tile's visible inner side. Draw the **outermost slots first on both halves**, then inward, with the centre slot last.
4. **Vertical Discard Rows (Drawn Top-to-Bottom):** Row 2 sits below Row 1 and is drawn *after* Row 1, so the bodies stack in depth order.

**Deferred: tile-to-tile overlay shadows.** The blob pass deliberately cannot
darken a neighbour's face. The next step is a separate per-shell overlay that is
drawn onto the *next* tile before that tile's body, so a tile can cast contact
shading onto the neighbour drawn above it; it has to be generated per shell
variation. It is recorded in §10.11 and `TASK.md`, not part of Phase 1d.

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
  * Generate the shadow in Python: project the tile's table-contact footprint, fit an ellipse (lying tile) or a capsule (standing tile), offset it down-right, and apply a separable Gaussian. There is no shadow-catcher pass; §10.11 has the committed contract.
* **Output Manifest (`shells.json`):** Export a JSON metadata file alongside the PNGs recording for each shell:
  * `textureFile`: Path to PNG
  * `texWidth`, `texHeight`: Full PNG dimensions in pixels
  * `anchorX`, `anchorY`: Pixel offset from top-left of PNG to the top-left corner of the solid tile body
  * `advanceWidth`, `advanceHeight`: Opaque body dimensions used for grid layout
  * `gridStepPx`: the physical tile-axis step for a tight grid
  * `shadowTextureFile` / `shadowTextureFile2x` + `shadowTexWidth/Height`, `shadowAnchorX/Y`, `shadowOffsetPx`: the separate blob sprite. It has its own larger box and anchor; draw it at `grid - shadowAnchor` into the shadow-union layer, then draw the body.
  * `shadowPadding` (the shadow box's padding) and `shadowBlob` (`model`, `shape`, `sigmaPx1x`, `coreAlpha`, `offsetPx1x`, `lying`).
  * `stackStepPx` + `stackCount` (wall shells): the projected thickness vector from the lower tier's body top-left to the upper tier's, plus the 2-tile stack count
  * `wallSlot` (front/back wall shells): `wall`, `index`, `offsetUnits`, `lateralOffsetUnits`, `distanceUnits`, `angleDeg` and `faceUp`, so the per-slot fan is auditable
  * `faceQuad`: 4 corner coordinates (`[x, y]`) on the shell where the 2D face glyph should be mapped

---

## 4. Implementation Breakdown (Step-by-Step)

### Phase 1: Blender Shell Baker & Manifest Exporter
- [x] **Task 1.1:** Create a headless Blender Python script (`bake_shells.py`) that loads the existing 3D R-tile mesh, applies the two-tone resin/ivory materials, and sets up the orthographic camera and top-left key light. Landed in section 8.
- [x] **Task 1.2:** Generate a synthetic blob shadow per shell (Phase 1d): a Gaussian-blurred ellipse/capsule under the tile's projected table-contact footprint, exported as a separate sprite. The Blender shadow-catcher pass was removed; see §10.11.
- [x] **Task 1.3:** Render all 6 canonical blank shells at target DPI (plus `@2x` retina scale) and auto-generate `shells.json` containing `anchorX`, `anchorY`, `advanceWidth`, `advanceHeight`, and `faceQuad` coordinates. All numbers are measured from the render; see section 8.

### Phase 2: Runtime Texture Atlas & Face Glyph Compositor
- [ ] **Task 2.1:** Prepare high-contrast, crisp 2D vector/SVG or high-DPI PNG assets for all 34 tile faces (plus red fives *akadora*). Avoid thin hairlines that blur at small discard sizes. The master glyphs stay perspective-neutral; the per-perspective treatment is the face variant in Task 2.2.
- [ ] **Task 2.2:** Build a startup **Tile Atlas Generator** (`TileAtlasBuilder`) that composites every **`(shellType, faceVariant, tileFace)`** triple onto an offscreen canvas/texture atlas once at initialization:
  - Draw the pre-baked Blender shell PNG.
  - Transform and draw the 2D face glyph into the shell's `faceQuad` (applying a $90^\circ$ counter-clockwise rotation to the glyph when compositing onto `shell_flat_sideways`).
  - Generate a **face variant per perspective a face-up shell appears in** instead of reusing one glyph for every shell: `standing-front-{slot}` for the 14 `shell_hand_slot_*` shells, `flat-topdown` for `shell_flat_upright`, `flat-rot90` for `shell_flat_sideways`. A variant id names a perspective slot, not a camera angle; the Phase 1b pick fixes the angle behind it.
  - The face-down wall shells (`shell_wall_horizontal`, `shell_wall_side_left`, `shell_wall_side_right`) are **bare**: no glyph, no face variant, no atlas entry.
- [ ] **Task 2.3:** Store UV rects and layout metrics in a fast lookup map (`Map<TileRenderKey, BakedTileSprite>`, keyed by the same triple) so runtime frame rendering requires zero dynamic shadows, blurs, or multi-pass shaders. The atlas key is part of the shipped contract; adding a later variant (for example a lifted/hovered hand decal) is a new `faceVariant` entry, never a glyph swapped at draw time. Budget note: the variant dimension multiplies the composited sprites by the number of face-up shells (3 at Phase 1b) rather than by the 37 raw glyphs; measure the packed atlas in Phase 2 against the committed-asset budget.

### Phase 3: Coordinate System & Zone Layout Engine
- [ ] **Task 3.1:** Implement the table layout engine strictly using `advanceWidth` and `advanceHeight` from `shells.json` (never `texWidth`/`texHeight`).
- [ ] **Task 3.2:** When positioning a tile at logical board coordinate `(gridX, gridY)`, compute its actual draw position as:
  ```text
  drawX = gridX - shell.anchorX
  drawY = gridY - shell.anchorY
  ```
- [ ] **Task 3.3:** Implement zone-specific spacing rules:
  - **Player Hand:** Sequential `advanceWidth` steps, plus a $+\text{0.35} \times \text{advanceWidth}$ gap before the newly drawn *tsumo* tile.
  - **Discard Ponds:** 6 columns per row; advance X by `advanceWidth` and Y by `advanceHeight` (the lower tile's top AO rim will sit flush against the upper tile's bottom extrusion). When a *riichi* tile appears, advance X by the sideways shell's `advanceWidth` so subsequent tiles shift right cleanly.
  - **Two-Tier Walls (`yama`):** Position the upper stack tile at `dx = 0` (or `-1px`), `dy = -wallStepY` relative to the bottom stack tile.

### Phase 4: Painter's Algorithm Renderer (Strict Draw Order)
Because there is no Z-buffer, enforce a deterministic back-to-front draw order across and within every table zone:

- [ ] **Task 4.1 — Global Zone Order:** Render zones in this exact order:
  1. Table felt background (use a subtle, low-contrast mottled felt noise texture so semi-transparent tile shadows ground naturally instead of looking like flat stickers).
  2. Top wall (`yama`) & Top player's hand/melds.
  3. Left and Right side walls (`yama`) — draw from top-of-screen (back) to bottom-of-screen (front).
  4. Center scoring/dora indicator box & all 4 Discard Ponds (`kawa`).
  5. Bottom wall (`yama`).
  6. Left and Right player open melds & concealed hands.
  7. Bottom player's open melds & standing hand (always drawn last so lifted/hovered tiles never clip behind the bottom wall).
- [ ] **Task 4.2 — Intra-Zone Draw Order:**
  - **Shadow union first, then bodies:** every shell has a separate blob sprite with its own larger box and anchor. For each zone, draw every shadow sprite into one transparent layer with a per-pixel max (the union), draw that layer over the felt, then draw every body in the zone's back-to-front order. A shadow is never baked into a body, so it cannot land on top of a neighbouring tile, and overlapping blobs do not double-darken.
  - **Uniform horizontal rows (ponds, discards):** Iterate **Right-to-Left** (`index = length - 1` down to `0`) for the body painter order.
  - **Per-slot fan rows (standing hand, top hand, front/back walls):** Draw **outermost-to-innermost on both halves, centre last** (slots 0 and N, then 1 and N-1, …, then the centre), because the camera is at the row centre and the inner tile is nearer. Do not use the uniform right-to-left order here; it puts the left half's outer tile on top of its inner neighbour, which is the wrong overlap.
  - **Multi-row grids (discard rows):** Iterate **Top-to-Bottom** (`row = 0` to `2`), drawing each row Right-to-Left.
  - **Stacked walls:** Draw the **bottom tier** completely before drawing the **top tier** at its upward `dy` offset.

### Phase 5: Interactive States, Hitboxes & Visual Polish
- [ ] **Task 5.1 — Hover & Selection Lift (Fake 3D Motion):** When the player hovers over or selects a tile in their hand, translate the tile upward (`drawY -= 12px`) and optionally draw a slightly softer/wider secondary shadow underneath at the baseline `gridY` to sell the illusion of lifting off the felt.
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
`--bake --verify-determinism` re-renders every shell and compares decoded RGBA;
all six were byte-identical across two renders.

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
   table-contact footprint, fits an ellipse (lying tile) or a capsule (standing
   tile), offsets it down-right, Gaussian-blurs it and ramps the outer texture
   ring to zero. Every number the check reports is a property of the committed
   PNG, not of a Blender node graph. There is no catcher pass (§10.11).
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
budgets). `--audition --verify-determinism` re-renders every candidate and
compares decoded RGBA. The committed felt is untouched.

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

The six original shells are now **103**: the three wall shells each gained a
face-up counterpart for revealed dora indicators; the front/back walls split
into a 68-shell per-slot fan (§10.8); the human hand split into a 14-slot fan
(§10.9); and the top hand is a dedicated 13-slot standing blue-back fan. The
ponds/melds stay straight-on and the side walls are approved.

### 10.2 The committed bake, measured

`bake.targetLongAxisPx1x` is 104 (the Phase 1 `@2x` size); the new `@2x` is 208.
All numbers are measured from the render and live in
`frontend/public/table/shells.json`.

| Shell | Camera | Body tex @1x / @2x | Shadow tex @1x / @2x | Body | gridStepPx x / y | stackStepPx | Bytes @1x + @2x |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `shell_flat_upright` | el 45° | 76 × 106 / 152 × 212 | 104 × 136 / 208 × 272 | 72 × 102 | (69.4, 0) / (0, 65.44) | — | 11,208 + 33,278 |
| `shell_flat_sideways` | el 45° | 110 × 99 / 220 × 198 | 138 × 129 / 276 × 258 | 106 × 95 | (0, 55.15) / (104, 0) | — | 14,076 + 41,043 |
| `shell_wall_horizontal` | el 45° | 76 × 106 / 152 × 212 | 104 × 136 / 208 × 272 | 72 × 102 | (69.4, 0) / (0, 65.44) | (0, −38.56) | 12,129 + 35,948 |
| `shell_wall_horizontal_faceup` | el 45° | 76 × 106 / 152 × 212 | 104 × 136 / 208 × 272 | 72 × 102 | (69.4, 0) / (0, 65.44) | (0, −38.56) | 11,208 + 33,278 |
| `shell_wall_side_left` | off-axis persp, +2 / d10 | 108 × 89 / 216 × 178 | 136 × 119 / 272 × 238 | 104 × 85 | (−6.91, 45.96) / (92.84, 0) | (−5.64, −39.87) | 16,085 + 44,007 |
| `shell_wall_side_left_faceup` | off-axis persp, +2 / d10 | 108 × 89 / 216 × 178 | 136 × 119 / 272 × 238 | 104 × 85 | (−6.91, 45.96) / (92.84, 0) | (−5.64, −39.87) | 14,586 + 39,723 |
| `shell_wall_side_right` | off-axis persp, −2 / d10 | 108 × 89 / 216 × 178 | 136 × 119 / 272 × 238 | 104 × 85 | (6.91, 45.96) / (92.84, 0) | (5.64, −39.87) | 15,149 + 41,557 |
| `shell_wall_side_right_faceup` | off-axis persp, −2 / d10 | 108 × 89 / 216 × 178 | 136 × 119 / 272 × 238 | 104 × 85 | (6.91, 45.96) / (92.84, 0) | (5.64, −39.87) | 14,537 + 39,862 |

The eight base shells above total **417,674 B** (108,978 @1x + 308,696 @2x).
The 14 human-hand slots add **688,686 B**, the 13 top-hand slots **569,950 B**
and the 68 front/back wall slots **3,523,611 B**, for **5,199,921 B**
(1,365,185 @1x + 3,834,736 @2x) against the raised 5,242,880 B budget.
`shells.json` is **479,585 B** against the raised 524,288 B budget. The felt is
unchanged (559,465 B). The body keeps the 104 px projected long axis (102 px
measured, minus the anti-aliased crop); the blob shadow adds its own box
(human-hand centre 103 × 136, drawn 117 × 136, top-hand centre 102 × 136).

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
| `shell_wall_front_slot_08` | 0° / d40.8 | 77 × 106 / 154 × 212 | 105 × 136 / 210 × 272 | 73 × 102 | (69.72, 0) / (0, 66.07) | (0, −39.02) | 12,009 + 36,479 |
| `shell_wall_front_slot_04` | 4.21° / d40.8 | 81 × 106 / 162 × 212 | 109 × 136 / 218 × 272 | 77 × 102 | (69.72, 0) / (−3.49, 66.07) | (−2.03, −39.02) | 14,527 + 40,049 |
| `shell_wall_front_slot_16` | 8.37° / d40.8 | 85 × 106 / 170 × 212 | 113 × 136 / 226 × 272 | 81 × 102 | (69.72, 0) / (6.97, 66.07) | (4.06, −39.02) | 14,882 + 41,060 |
| `shell_wall_back_slot_08` | 0° / d54.8 | 76 × 106 / 152 × 212 | 104 × 136 / 208 × 272 | 72 × 102 | (69.64, 0) / (0, 65.91) | (0, −38.9) | 12,170 + 36,452 |
| `shell_wall_back_slot_04` | 3.13° / d54.8 | 79 × 106 / 158 × 212 | 107 × 136 / 214 × 272 | 75 × 102 | (69.64, 0) / (−2.58, 65.91) | (−1.51, −38.9) | 14,160 + 39,595 |
| `shell_wall_back_slot_16` | 6.25° / d54.8 | 82 × 106 / 164 × 212 | 110 × 136 / 220 × 272 | 78 × 102 | (69.64, 0) / (5.16, 65.91) | (3.01, −38.9) | 14,447 + 40,651 |
| `shell_wall_front_slot_16_faceup` | 8.37° / d40.8 | 85 × 106 / 170 × 212 | 113 × 136 / 226 × 272 | 81 × 102 | (69.72, 0) / (6.8, 64.46) | (4.06, −39.02) | 14,071 + 38,709 |
| `shell_wall_back_slot_16_faceup` | 6.25° / d54.8 | 82 × 106 / 164 × 212 | 110 × 136 / 220 × 272 | 78 × 102 | (69.64, 0) / (5.06, 64.71) | (3.01, −38.9) | 13,718 + 38,234 |

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

`bash tools/render/bake-shells.sh --bake --verify-determinism` renders the 103
shells, writes both scales and `shells.json`, regenerates the review sheets and
runs **7,487 checks**: catalogue and the 14 human-hand + 13 top-hand + 68 wall
slot fans, the top-hand standing mapping,
the straight-on ponds, felt, both texture scales, the 1 px AA ledge, the blob
contract (no moat, smooth Gaussian, extents and union), the faceQuad and `gridStepPx`, the 2-tile `stackStepPx`
(within 1.5 px of the projected thickness on the orthographic shells, 2.5 px on
the perspective ones), the perspective trapezoid (one table-parallel edge pair,
the near edge longer — the lower edge for a horizontal face, the upper edge for
the vertical hand face — and the depth edges converging), the slot metadata
(`handSlot` / `wallSlot`, camera offset, distance, face rotation), the
review-sheet pixel budgets, ivory/blue face sides, the decoded RGBA hashes and
the budgets. `--verify-determinism` re-renders every shell and compares decoded
RGBA; all 103 were identical.

`bash tools/render/bake-shells.sh --audition --verify-determinism` now renders
the **hand fan-strength calibration**: the outer row slot and the drawn-tile slot
at 14, 18 and 40 units, with the committed 24 units as the REF. It validates
**7,866 checks** in total. The shadow audition validates **7,604 checks** (the committed checks plus the variant records and the `shadow-candidates.png` sheet). The hand sheets are
`build/review/shell-candidates-shell_hand_slot_12.png` and
`build/review/shell-candidates-shell_hand_slot_draw.png`.

The **shadow is now a synthetic blob** (§10.11): σ 4 px, core 0.60, offset 5/7,
with a separate shadow box and a union draw pass. The audition sheet keeps REF
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

**Budgets.** The 68 wall slots are **3,523,611 B** of the 103-shell
**5,199,921 B** total; `shells.json` is **479,585 B**. The self-imposed Phase 1
budgets are **5,242,880 B** (textures) and **524,288 B** (manifest); the standing
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
body box: the flat ponds, the sideways shell, the front/back wall tiles) gets an
ellipse covering the body box; a standing or tilted tile (the human hand, the top
hand, the side walls) gets a capsule at its base. The shape is offset 5 px right
/ 7 px down, filled at `coreAlpha` 0.60, and blurred with a separable Gaussian
(sigma 4 px @1x, 3-sigma truncation). The visible fringe peaks near half the core
alpha at the contact, so the tile edge is not a light moat. The body sprite is
the tile only.

**The contract.** `shells.json` publishes a separate `shadowTextureFile` /
`shadowTextureFile2x` with its own `shadowTexWidth/Height`, `shadowAnchorX/Y`
(12/20/22/12 padding), `shadowOffsetPx` `[0,0]`, `shadowPadding` and `shadowBlob`
(`model: blob`, `shape: ellipse`, `sigmaPx1x: 4`, `coreAlpha: 0.60`,
`offsetPx1x: [5,7]`, `lying`). A lying tile must have a real shadow 3–19 px to
the right and 3–21 px below; a standing tile must have one at the bottom. Every
sprite is smooth (max adjacent alpha step <= 0.12), its outer ring is transparent,
and its maximum alpha is the core alpha.

**The union pass.** The review sheets and the runtime contract draw every shadow
into one transparent layer with a per-pixel max, then draw that layer over the
felt, then every body. Two blobs that overlap stay at the single-blob value
instead of the `1 - (1-a)^2` darkening of independent alpha blending. This is the
correction for adjacent tiles, and it is a per-zone pass over whatever tiles are
placed: **a wall that changes length needs no new assets**, because the runtime
unions the slots it actually draws.

**The audition.** `--shadow-audition` now calibrates the blob: REF (sigma 4, core
0.60, offset 5/7) plus A (sigma 3, 0.55, 4/6), B (sigma 5, 0.60, 6/8) and C
(sigma 7, 0.50, 8/10) on the flat, wall and hand shells.
`build/review/shadow-candidates.png` shows each row with the union pass.

**Validation.** The committed bake runs **7,487 checks**, the hand audition
**7,866** and the shadow audition **7,604**; all 103 body and shadow sprites are
deterministic. Textures are **5,199,921 B** (1,365,185 @1x + 3,834,736 @2x)
against the 5,242,880 B budget; `shells.json` is **479,585 B** against 524,288 B.

**Deferred: tile-to-tile overlay shadows.** The blob pass cannot darken a
neighbour's face by design. The agreed next step is a separate per-shell overlay
shadow, drawn onto the tile that will be above it before that tile's body: the
next tile's body covers the overlap, so the shading sits on the neighbour's face
rather than on the felt. It must be generated per shell variation (each slot's
geometry differs), so it is a follow-up task, not part of Phase 1d.
