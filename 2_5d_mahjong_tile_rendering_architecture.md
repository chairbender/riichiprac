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

You will render **5–6 blank, face-less 3D tile shells** from Blender using orthographic/oblique cameras and locked top-left lighting, bake tight contact shadows directly into each shell's transparent margin, and composite crisp 2D orthographic face glyphs on top at runtime using a strict **Painter's Algorithm** draw order.

---

## 2. Core Rendering Concepts

### A. Multi-Projection Compositing ("Impossible" Geometry)
Rather than forcing one camera onto the whole board, each table zone uses the 2D projection that maximizes readability while sharing a single virtual light source at **top-left** (`-X, -Y`):

| Table Zone | Projection Type | Visual Construction | Gameplay Purpose |
| :--- | :--- | :--- | :--- |
| **Bottom Player Hand** | Front elevation + top bevel | Upright front-on rectangle with a white top bevel and a $2\text{--}3\text{ px}$ sliver of colored resin backing. | Zero glyph distortion; maximum reading speed. |
| **Discard Ponds (`kawa`) & Open Melds** | Top-down orthographic + downward extrusion | Flat face-up rectangle extruded $4\text{--}6\text{ px}$ downward (and slightly right) to show tile thickness. | Uniform tile size across all 4 seats; instant pattern scanning. |
| **Side Walls (`yama`)** | Fixed-angle oblique (cabinet) | Parallel sheared sprites angled inward toward the top center with zero distance scaling. | Frames the board with strong 3D depth without wasting horizontal screen width. |
| **Top Hand & Top/Bottom Walls** | Top-down orthographic | Colored resin top face stacked above a white front thickness strip and bottom contact shadow. | Preserves consistent back-to-front vertical layering. |

### B. Decoupled Layout Bounds vs. Sprite Texture Bounds (Single-Sprite Neighbor Shadows)
You do **not** need separate sprites for isolated tiles vs. adjacent tiles, nor do you need neighbor-adjacency logic. Every tile orientation uses **one single shell sprite** whose texture dimensions are slightly larger than its opaque plastic body:

* **Logical Advance Box (`advanceW`, `advanceH`):** The exact pixel width and height of the solid tile body used by the layout engine to position tiles on a grid.
* **Sprite Texture Bounds (`texW`, `texH`):** Includes transparent padding around the solid body:
  * **Right & Bottom Overhang ($+3\text{ to }+4\text{ px}$):** Contains a soft, semi-transparent directional drop shadow (`alpha` $\approx 0.25\text{--}0.35$).
  * **Top & Left Rim ($+1\text{ to }+2\text{ px}$):** Contains a subtle dark ambient-occlusion (AO) fringe (`alpha` $\approx 0.25\text{--}0.30$) hugging the outer edge.

**How this handles both touching and isolated tiles automatically:**
1. **Horizontal Rows (Drawn Right-to-Left):** Because the light source is at top-left, drawing tiles **right-to-left** places the left tile *on top of* its right neighbor. The left tile's $+4\text{ px}$ right shadow overhang bleeds directly onto the right neighbor's rounded left bevel—creating a realistic cast shadow between touching tiles. On the rightmost tile (or an isolated *tsumo* tile), that same overhang blends onto the table felt as a normal drop shadow.
2. **Vertical Discard Rows (Drawn Top-to-Bottom):** Row 2 sits below Row 1 and is drawn *after* Row 1. Row 2's $1\text{--}2\text{ px}$ dark top AO rim sits directly on top of Row 1's bright bottom white extrusion, preventing two bright white surfaces from merging into a flat white blob.

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
**Never rotate a pre-shaded upright tile sprite by $90^\circ$.** Rotating an upright sprite moves its bottom extrusion thickness and drop shadow to the left or right side, breaking the global top-left lighting illusion. Always bake a dedicated **Flat Sideways** shell in Blender (wider than it is tall, with extrusion thickness and drop shadow on the bottom edge) and rotate only the **2D face glyph** $90^\circ$ before compositing it onto the sideways shell.

---

## 3. Blender Offline Baking Pipeline

Configure an automated Blender script to render the canonical blank tile shells from your existing beveled R-tile 3D mesh (colored urea-resin back + white face body).

### Required Canonical Shells
1. `shell_hand_standing`: Upright player hand tile (front elevation with slight top bevel & resin sliver).
2. `shell_flat_upright`: Flat face-up tile for normal discards and unrotated meld tiles.
3. `shell_flat_sideways`: Flat face-up tile oriented horizontally for *riichi* declarations and sideways meld calls.
4. `shell_wall_horizontal`: Face-down flat tile for top/bottom walls (`yama`) and top player's concealed hand.
5. `shell_wall_side_left` & `shell_wall_side_right`: Oblique/sheared face-down tiles angled inward for the left and right walls.

### Blender Scene & Shader Rules
* **Camera:** Use an **Orthographic Camera** (`type = 'ORTHO'`) for all shells so parallel edges stay strictly parallel and scale identically across the board. (For side walls, angle/shear the tile mesh or orthographic camera along a fixed cabinet projection angle).
* **Lighting:** Place a primary soft area light at **Top-Left-Front** (`-X, +Y, +Z`) and a weak ambient fill light so bevels show crisp highlights on top/left edges and cool grey-blue shading on bottom/right thickness faces.
* **Two-Tone Resin Seam:** Ensure the sharp boundary between the colored tile back (*senaka*) and white front body is clearly visible along the top and side bevels—this is the primary visual cue distinguishing a mahjong tile from a flat card.
* **Shadow Catcher & Cropping:**
  * Enable `Film -> Transparent` in Blender Cycles/Eevee.
  * Place a shadow-catcher plane directly underneath the tile mesh.
  * Clamp/fade the shadow catcher alpha via a compositing mask or UV gradient so the cast shadow extends no more than **$3\text{--}4\text{ px}$** past the bottom and right edges, and adds a **$1\text{--}2\text{ px}$** soft dark AO fringe on the top and left edges.
* **Output Manifest (`shells.json`):** Export a JSON metadata file alongside the PNGs recording for each shell:
  * `textureFile`: Path to PNG
  * `texWidth`, `texHeight`: Full PNG dimensions in pixels
  * `anchorX`, `anchorY`: Pixel offset from top-left of PNG to the top-left corner of the solid tile body
  * `advanceWidth`, `advanceHeight`: Opaque body dimensions used for grid layout
  * `faceQuad`: 4 corner coordinates (`[x, y]`) on the shell where the 2D face glyph should be mapped

---

## 4. Implementation Breakdown (Step-by-Step)

### Phase 1: Blender Shell Baker & Manifest Exporter
- [x] **Task 1.1:** Create a headless Blender Python script (`bake_shells.py`) that loads the existing 3D R-tile mesh, applies the two-tone resin/ivory materials, and sets up the orthographic camera and top-left key light. Landed in section 8.
- [x] **Task 1.2:** Configure the shadow catcher plane and Blender Compositor node tree to produce a tight $+3\text{--}4\text{ px}$ bottom-right drop shadow and $1\text{--}2\text{ px}$ top-left AO border on a transparent background. Done in Python over the Cycles shadow-catcher alpha rather than a compositor mask, so the clamp is exact and measurable; see section 8.
- [x] **Task 1.3:** Render all 6 canonical blank shells at target DPI (plus `@2x` retina scale) and auto-generate `shells.json` containing `anchorX`, `anchorY`, `advanceWidth`, `advanceHeight`, and `faceQuad` coordinates. All numbers are measured from the render; see section 8.

### Phase 2: Runtime Texture Atlas & Face Glyph Compositor
- [x] **Task 2.1:** Prepare high-contrast, crisp 2D vector/SVG or high-DPI PNG assets for all 34 tile faces (plus red fives *akadora*). Avoid thin hairlines that blur at small discard sizes. Landed: 37 committed 192 × 256 RGBA PNGs, see §9.
- [x] **Task 2.2:** Build a startup **Tile Atlas Generator** (`TileAtlasBuilder`) that composites every `(shellType, tileFace)` pair onto an offscreen canvas/texture atlas once at initialization:
  - Draw the pre-baked Blender shell PNG.
  - Transform and draw the 2D face glyph into the shell's `faceQuad` (applying a $90^\circ$ counter-clockwise rotation to the glyph when compositing onto `shell_flat_sideways`).
- [x] **Task 2.3:** Store UV rects and layout metrics in a fast lookup map (`Map<TileRenderKey, BakedTileSprite>`) so runtime frame rendering requires zero dynamic shadows, blurs, or multi-pass shaders. Landed: `frontend/src/table/`, see §9.

### Phase 3: Coordinate System & Zone Layout Engine
- [x] **Task 3.1:** Implement the table layout engine strictly using `advanceWidth` and `advanceHeight` from `shells.json` (never `texWidth`/`texHeight`). Landed as `frontend/src/table/boardLayout.ts`; see §10. Tight rows and wall runs use the Phase 1 `gridStepPx` instead, with `advanceWidth/Height` for hit-testing and the hand/spacing rules.
- [x] **Task 3.2:** When positioning a tile at logical board coordinate `(gridX, gridY)`, compute its actual draw position as:
  ```text
  drawX = gridX - shell.anchorX
  drawY = gridY - shell.anchorY
  ```
- [x] **Task 3.3:** Implement zone-specific spacing rules:
  - **Player Hand:** Sequential `advanceWidth` steps, plus a $+\text{0.35} \times \text{advanceWidth}$ gap before the newly drawn *tsumo* tile.
  - **Discard Ponds:** 6 columns per row; advance X by `advanceWidth` and Y by `advanceHeight` (the lower tile's top AO rim will sit flush against the upper tile's bottom extrusion). When a *riichi* tile appears, advance X by the sideways shell's `advanceWidth` so subsequent tiles shift right cleanly.
  - **Two-Tier Walls (`yama`):** Position the upper stack tile at `dx = 0` (or `-1px`), `dy = -wallStepY` relative to the bottom stack tile.
  - **Landed deltas:** ponds use `gridStepPx` for both axes, a sideways tile advances by 52 px (its long axis) / 38.41 px on a vertical row, and `wallStepY` is 0.1 × the projected long axis. See §10.

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
  - **Horizontal rows (hands, discard rows, top/bottom walls):** Iterate **Right-to-Left** (`index = length - 1` down to `0`) so each tile's right shadow overhang casts onto its right neighbor's left bevel.
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

## 8. Phase 1 baseline (landed 2026-11-13)

Phase 1 baked the six canonical blank shells, both texture scales and the
manifest. The authoritative numbers and the field-by-field contract are in
[`tools/render/README.md`](tools/render/README.md); this section records the
decisions that narrow the architecture above.

**One command.** `bash tools/render/bake-shells.sh --bake` renders, measures and
writes everything, then runs `scripts/check-shells.mjs` (323 checks, no Blender)
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
   3–4 px / 1–2 px margin contract can be measured from the PNG without a
   0.4-alpha silhouette pixel masquerading as a shadow. Phase 3 must use the
   published `gridStepPx.x/y` (the projected tile axes) for tight rows and wall
   runs; `advanceWidth` is for hit-testing and spacing.
5. **The clamp is arithmetic, not a compositor mask.** The Cycles
   shadow-catcher alpha supplies the physical shape; Python clamps it to the
   padding, normalises each side to `shadow.peakAlpha` 0.33, adds the analytic
   1–2 px AO fringe at 0.28, and ramps the outer texture ring to zero. Every
   number the check reports is therefore a property of the committed PNG, not
   of a Blender node graph.
6. **Rig tuning changed two numbers.** The Phase 0 key was 350 W and the world
   0.35 of `#20262b`, which rendered the shadow side near black; the bake uses
   3200 W and a `#3b4a5c` world at 1.0. The face samples are ivory
   (`207, 204, 199` flat, `169, 166, 163` standing — the standing face is more
   grazing, which is inherent to one screen-locked key).

Phase 2 owns the atlas and the glyph compositor: it maps each glyph's corners
onto `faceQuad` after rotating it by `faceRotationDeg`, and never rotates a
shell sprite.


## 9. Phase 2 baseline (landed 2026-11-14)

Phase 2 baked the 38 face glyphs and implemented the startup atlas. The
authoritative pipeline numbers and asset contract are in
[`tools/render/README.md`](tools/render/README.md) §"Phase 2"; this section
records the decisions that narrow the architecture above.

**Assets.** 37 glyph PNGs (34 standard + 3 red fives; `blank` has no asset),
192 × 256 RGBA, 377,248 B total against a 1,048,576 B budget. They are the
upstream public-domain symbol-only SVGs at commit
`f37d6cc2557498d23f13eb3e955e0e44e5c863ff`, rasterised offline by
`tools/render/scripts/bake-faces.mjs` with `@resvg/resvg-js` 2.6.2.
`frontend/public/table/faces.json` records every glyph's decoded-RGBA sha256,
ink bbox/counts and provenance. No tile art is rasterised in the browser.

**Runtime.** `frontend/src/table/TileAtlasBuilder.ts` composes one offscreen
Canvas 2D page per shell at startup, clips to the published `faceQuad` and maps
the glyph's own corners onto it. `frontend/src/table/TileAtlas.ts` exposes the
`Map<TileRenderKey, BakedTileSprite>` and a lazy `warm(shells)`; the first board
warms all six shells. Frame code only blits `page.canvas` at `sprite.uv`.

**Numbers.** 228 keys across 6 pages: 1,608,256 px / 6,433,024 B RGBA at @2x
(402,064 px / 1,608,256 B at @1x), 108 glyph keys and 120 bare keys. Build time
in Node Canvas is 14–27 ms. Review sheets and `atlas-numbers.json` are written
by `frontend/scripts/review-atlas.ts` under `tools/render/build/review/`.

**Decisions that narrow the architecture above.**

1. **The atlas is composed at startup, not offline.** The shell and glyph PNGs
   are already committed and resvg is a build tool, not a runtime dependency.
   Composing on an offscreen 2D canvas keeps `shells.json` authoritative and
   lets the atlas page scale follow `devicePixelRatio` (@2x on retina, @1x
   otherwise). It is deterministic: the same manifests and PNGs produce the
   same decoded RGBA, verified by a test and by `--verify-determinism` for the
   glyph sources.
2. **`faceQuad` carries `faceRotationDeg`; the builder does not rotate twice.**
   The manifest publishes the quad in face-local corner order (top-left,
   top-right, bottom-right, bottom-left) after the shell's pose. For
   `shell_flat_sideways` the first edge therefore points up the screen, which is
   the 90° counter-clockwise glyph rotation. Mapping the glyph's corners onto
   the quad implements it; rotating the glyph again would cancel the rotation.
   The builder re-derives the rotation from the quad and throws on a mismatch.
3. **Face-down shells resolve every face key to one bare slot.** A
   `shell_wall_*` sprite shows the blue resin back; compositing a glyph on it
   would be wrong and would duplicate five megabytes of atlas. The 114 back keys
   therefore share three bare slots (one per shell), and frame code can still
   look up any `(shell, face)` without special-casing.
4. **`blank` and `5z` share a bare slot.** A blank tile and a haku are both a
   plain ivory face. The upstream haku symbol-only SVG rasterises to zero ink;
   both keys map to the shell's shared bare slot instead of two transparent
   copies.
5. **No 3D, no WebGL, no per-frame art.** The atlas is an offscreen 2D canvas;
   the only runtime work per tile is `drawImage` from the page. The tests scan
   the atlas modules for WebGL/3D imports and assert draw order (all shells
   before any glyph, clip then transform then glyph) on a recording context.

## 10. Phase 3 baseline (landed 2026-11-14)

Phase 3 is the pure zone layout engine in
[`frontend/src/table/boardLayout.ts`](frontend/src/table/boardLayout.ts), with
the `GameState` adapter in
[`frontend/src/table/boardFromState.ts`](frontend/src/table/boardFromState.ts).
It draws nothing: Phase 4 consumes `TilePlacement[]` (shell, grid, draw, advance
rect, body rect, `drawOrder`). The dump gate is
`cd frontend && npm run layout:dump`; the artifacts are written under
`tools/render/build/review/` (gitignored).

**Board space and the viewport.** Layout is one fixed 2D board, CSS px at the
manifest's @1x scale, top-left origin, x right, y down. The current bake derives
a **612 × 642 board** from the shell metrics (not a hand-authored constant).
There is no table model, shared camera or perspective. Fitting is a contain +
centre transform:

```text
scale   = min(viewportW / 612, viewportH / 642)
offsetX = (viewportW - 612 * scale) / 2
offsetY = (viewportH - 642 * scale) / 2
cssX    = offsetX + boardX * scale
cssY    = offsetY + boardY * scale
```

The felt is **not** affected by that transform. It is a separate full-screen
raster with `background-size: 100% 100%` (not `cover`), so its baked vignette
hugs the real screen edges at every aspect ratio; the board layer above it is
transparent and has no border, rail or apron. `cover` would crop the left/right
vignette in portrait.

**Zones (board px).** Every zone includes the maximum extent of a full pond
(18 discards, one of them sideways) and of a ten-stack wall with both tiers.

| Zone | x | y | w × h | Projection / shell |
| :--- | ---: | ---: | ---: | :--- |
| human hand | 8 | 579.11 | 596 × 54 | front elevation, `shell_hand_standing` |
| compass reserve | 194 | 231.91 | 224 × 120 | reserved, nothing drawn |
| bottom pond | 189.24 | 361.91 | 233.52 × 147.2 | top-down, `shell_flat_upright` |
| top pond | 189.24 | 74.71 | 233.52 × 147.2 | top-down, `shell_flat_upright` |
| left pond | 58.24 | 147.66 | 125.76 × 288.5 | top-down, `shell_flat_upright` |
| right pond | 428 | 147.66 | 125.76 × 288.5 | top-down, `shell_flat_upright` |
| top/bottom walls | 125.54 | 8 / 512.4 | 360.92 × 58.71 | `shell_wall_horizontal` |
| side walls | 8.24 / 562 | 73.72 | 42 × 432.2 | `shell_wall_side_left` / `_right` |

The zones are pairwise disjoint for the worst case and every tile body stays
inside its zone; the tests and the dump both assert this.

**Per-seat pond frames.** Each pond is laid out in its seat's frame: six tiles
run `along` (parallel to the player's edge) and up to three rows step `away`
toward the compass. Top/bottom rows are horizontal; left/right rows are
vertical. Row 0 is the seat's nearest row. Every pond uses the same upright
shell and advance box, so a tile is exactly 38 × 53 px in all four ponds; only
its position changes. Within a row every pond advances on screen left→right
(horizontal) or top→bottom (vertical): the sprites are never rotated, because
rotating a pre-shaded shell would move its baked light and extrusion.

**Spacing rules.**

* Hand: 38 px steps (the standing shell's `advanceWidth`), centred; the drawn
  tile sits after a 13.3 px (0.35 × 38) tsumo gap. `advanceRect`/`bodyRect` is
  the logical hit box the Phase 5 lift will move.
* Pond rows: 35.88 px along a horizontal row, 47.10 px to the next row; on a
  vertical row, 47.10 px along and 35.88 px across. These are the Phase 1
  `gridStepPx` tight axes, not the advance box.
* Riichi: the dedicated sideways shell, horizontal on screen in every pond. It
  advances along the row by 52 px (horizontal) or 38.41 px (vertical); the rest
  of the row shifts by the difference. On a vertical row the 54 px-wide body
  overhangs its 35.88 px row slot by 18.12 px, of which 16.12 px is beyond the
  neighbour's body; the pond zone is widened by that overhang and the sideways
  tile paints last so its face stays visible. The visual review is the user's.
* Walls: ten two-tile stacks a side (the live wall after a deal is ≤ 69 tiles,
  i.e. ≤ 9 stack layers; the dead wall is not drawn). The upper tile is at
  `dx = 0`, `dy = -0.1 × projected long axis` — 4.71 px for the horizontal
  wall, 4.18 px for the side walls, from the 0.589-unit tile thickness at the
  75–80° bake elevation. Horizontal runs paint right-to-left, side runs
  top-to-bottom; the whole lower tier paints before the upper tier.

**Draw order.** Placements come back sorted with a contiguous `drawOrder`:
top wall → left/right side walls → all four ponds → bottom wall → human hand.
Within a pond, rows paint in increasing screen y (horizontal ponds) or x
(vertical ponds), and each row paints against the shadow direction. A sideways
Riichi tile paints after its neighbours: its 54 px body is wider than a vertical
row is deep, so otherwise the next row would cover its face. The hand paints the
drawn tile first, then the concealed tiles right-to-left.

**Decisions that narrow the architecture above.**

1. **The Phase 3 wording "advance X by advanceWidth" for Riichi is superseded
   by the Phase 1 contract.** `advanceWidth` is 54 px while the sideways plate
   advances 52 px, so using it would open a 2 px felt gap in a tight row. The
   engine uses `gridStepPx` (52 / 38.41) and keeps `advanceWidth/Height` for
   the hit box. This is recorded in `layout-dump.json`.
2. **The human hand is the only hand in Phase 3.** Opponent concealed hands and
   open melds are Phase 4; the board reserves no empty band for them, so the
   layout can be extended without a visual placeholder. The compass region is
   reserved but empty, as instructed.
3. **Wall count is an input.** `wallPairsPerSide` defaults to and is clamped at
   10; the adapter derives `ceil(tiles_remaining / 8)`. The board is sized for
   that worst case so a live wall never leaves the board.
4. **The board size is derived, not hand-tuned.** `boardMetrics(shells)`
   computes the zones from the manifest's anchors, advances and tight steps, so
   a re-bake moves the board with it. Tests pin the current 612 × 642 numbers
   to catch a drift.

**Verification.** `frontend/src/table/boardLayout.test.ts` has 31 tests: anchor
mapping, hand pitch/tsumo gap/centring, 6-column wrap on all four seats,
Riichi advance in both row orientations, wall tiers and clamp, zone
containment/disjointness, paint order, viewport fit at six aspect ratios,
texture-size independence (a mutated `texWidth`/`texHeight` leaves placements
unchanged, and the source is scanned for texture reads), and the `GameState`
adapter. `npm run layout:dump` lays out a 166-placement worst-case board and
runs 1379 geometry checks, writing `layout-dump.json` and
`layout-preview.svg`. Per AGENTS.md §6 the SVG is a labelled geometry diagram
for the user to open (`xdg-open tools/render/build/review/layout-preview.svg`),
not agent visual evidence.
