# 2.5D Riichi Mahjong Table — Agent Implementation Plan

## Architecture Overview

This specification defines a hybrid 2.5D sprite-based rendering pipeline for a Riichi Mahjong table. Rather than running a real-time 3D renderer or drawing flat top-down graphics, the pipeline uses a 3D Blender scene once to establish true perspective geometry, extract normalized 2D screen coordinates, and render a small set of perspective-angled blank tile bodies. At runtime, a 2D renderer composites flat tile face glyphs onto those angled blanks and draws the board back-to-front using a deterministic Painter's Algorithm.

### Core Technical Pillars
1. Medium-Telephoto Perspective + Lens Shift: a 65mm to 85mm perspective camera with negative vertical lens shift (Shift Y) to preserve subtle vanishing-point convergence and visible inner tile thickness without shrinking distant tiles or skewing vertical hand edges.
2. Two-Layer Tile Compositing: separates 3D beveled blank tile bodies (rendered from Blender) from flat 2D face decals (34 standard faces + red fives), avoiding hundreds of per-slot pre-rendered tile sprites.
3. Column-Bucketed Angle Sprites: groups adjacent board slots into discrete viewing-angle buckets (e.g. Far-Left, Mid-Left, Center, Mid-Right, Far-Right) so ~15-20 blank sprites cover the entire table.
4. Data-Driven Layout + Painter's Algorithm: exports 3D slot anchors from Blender to JSON and sorts draw calls from back-to-front and outer-to-inner so visible inner edges tuck cleanly behind center-ward neighbors.

## Task 1: Build the 3D Reference Table & Slot Anchors in Blender
(being implemented by task 261116-2320)

Objective: construct an accurately proportioned 3D table and populate every discrete tile position with a named `Empty` anchor object.

Steps:
1. Model tile geometry: base tile at standard Japanese proportions 28mm (height) x 21mm (width) x 16.5mm (thickness), with subtle edge bevels 0.8mm to 1.2mm; two materials, an ivory front/side body and a colored backing (yellow, blue or green).
2. Model table surface: playing mat 700mm x 700mm playable area, surrounded by a raised outer rim/frame and a center compass/score well.
3. Place tile slot anchors as `Empty` objects at the exact 3D center of every valid slot, using a strict naming convention (`{zone}_{seat}_{index}` or `{zone}_{seat}_{row}_{col}`):
   - Player standing hand `hand_south_00` .. `hand_south_13`: 14 slots along the bottom edge, pitched upright/slightly reclined (10 to 15 degrees backward tilt) facing the camera, with a small gap before slot 13 for the drawn tile (tsumo).
   - Walls `wall_{seat}_{stack}_{layer}`: 4 walls (north, east, south, west), each 17 stacks wide x 2 tiles high (`layer_0` bottom, `layer_1` top), arranged in a square around the center.
   - Discard rivers `river_{seat}_{row}_{col}`: 4 grids of 3 rows x 6 columns (plus overflow slots extending the third, nearest row - `row 0` in the geometric index - at columns 6+), oriented face-up toward each respective player.
   - Open melds `meld_{seat}_{slot}`: corner slots to the right of each player's hand/wall area for chii, pon, kan and kita declarations.
   - For every anchor, also record or define the 4 local 3D corner coordinates of the tile's face quad (where the 2D symbol sits).
4. Acceptance: all tile slots exist as named `Empty` objects in a dedicated `SlotAnchors` collection; adjacent tiles in walls, rivers and hands have realistic spacing (0.2mm to 0.5mm clearance) with zero mesh intersection.

## Task 2: Configure the 2.5D Perspective Camera & Lighting Rig

Objective: set up a fixed camera and lighting rig that produces clear perspective cues (vanishing point convergence and inner-edge visibility) while keeping vertical edges upright and back-row tiles legible.

Steps:
1. Camera projection and focal length: camera type Perspective (not Orthographic); focal length 75mm (acceptable range 65mm to 85mm).
2. Camera position, pitch and lens shift: center the camera on the X axis (X = 0) behind the south edge of the table; pitch downward 48 to 52 degrees from horizontal; adjust camera distance until the full table width fits comfortably in the 16:9 frame; use Camera Properties > Lens > Shift Y (negative) to frame the player's standing hand near the bottom of the viewport without tilting the camera further down, which keeps the vertical side edges of standing tiles parallel to the screen's vertical axis.
3. Lighting and render settings: enable Render Properties > Film > Transparent so renders output clean RGBA PNGs; place a large soft overhead area light slightly forward of table center plus low-intensity fill lights to define beveled edges and the inner vertical faces of side tiles; enable Ambient Occlusion or bake soft contact shadows directly beneath tile bases.
4. Acceptance: left and right wall inner vertical faces are clearly visible and converge toward a vanishing point above the top of the frame; the center tiles of the south standing hand appear straight-on (zero side thickness visible) while outer hand tiles reveal a clean sliver of their inner thickness edge; standing hand vertical edges do not lean inward trapezoidally.

## Task 3: Export 2D Screen Coordinates & Quad Offsets via Blender Python

Objective: write and run a Blender Python (bpy) script that projects all 3D slot anchors and tile face quads through the active camera into a normalized JSON layout file for the game engine.

Steps:
1. Project 3D coordinates to camera view: iterate all objects in the `SlotAnchors` collection; use `bpy_extras.object_utils.world_to_camera_view(scene, camera, world_pos)` for normalized (u, v, d) where u in [0,1] is left-to-right, v in [0,1] is bottom-to-top (invert to y = 1 - v for top-left 2D screen space) and d is depth distance from the camera.
2. Compute relative scale and angle buckets: perspective scale factor relative to a reference slot at table center, scale = d_ref / d_slot; assign each slot to a discrete sprite bucket by zone and horizontal X position:
   - `hand_south`: `hand_far_left`, `hand_mid_left`, `hand_center`, `hand_mid_right`, `hand_far_right`
   - `wall_west` / `wall_east`: `wall_left_side`, `wall_right_side`
   - `wall_north` / `wall_south`: `wall_horiz_left`, `wall_horiz_center`, `wall_horiz_right`
   - `river_*` / `meld_*`: `flat_left`, `flat_center`, `flat_right` (plus rotated variants for sideways riichi and called meld tiles)
3. Project face quad corners: project the 4 corners (top_left, top_right, bottom_right, bottom_left) of each slot's face quad into normalized 2D screen offsets relative to the slot anchor so the runtime compositor knows exactly where to map the 2D face glyph.
4. Emit `table_layout.json` with this schema:

```json
{
  "referenceResolution": { "width": 1920, "height": 1080 },
  "slots": [
    {
      "id": "hand_south_00",
      "zone": "hand",
      "seat": "south",
      "row": 0,
      "col": 0,
      "anchor": { "x": 0.2145, "y": 0.9120 },
      "depth": 1.382,
      "scale": 1.084,
      "bucket": "hand_far_left",
      "faceQuad": [
        { "x": -0.016, "y": -0.042 },
        { "x":  0.018, "y": -0.042 },
        { "x":  0.018, "y":  0.040 },
        { "x": -0.016, "y":  0.040 }
      ]
    }
  ]
}
```

5. Acceptance: running the script produces a valid `table_layout.json` containing every board slot; re-projecting the exported (x, y) coordinates over a test Blender render aligns with the rendered tile centers within 1 px.

## Task 3A: Export 3D Surface Basis Vectors & Light Rig to JSON

Objective: extend the Blender Python export so every slot carries the 3D world-space surface basis of its face quad and the file carries the scene lighting vectors, so carved grooves can be shaded correctly at any rotation.

Second opinion, recorded before choosing an approach. There are three ways to get carved, light-reactive tile faces, and this plan takes the third:
1. Brute-force Blender batch rendering (34 tiles x about 18 orientations = 612 sprites): physically exact, zero runtime shader math, but slow to iterate and multiplies atlas memory about 18x.
2. A 2D emboss/bevel filter on flat sprites: fast to prototype, but it breaks on rotated tiles — rivers and sideways riichi rotate the sprite 90 or 180 degrees, which turns the baked highlights upside-down and reveals the face as a flat sticker.
3. Orthographic PBR relief maps plus world-locked orientation lighting (chosen): bake three flat orthographic maps (albedo, normal + depth, cavity AO + gloss) once for the 34 tiles from true 3D carved geometry, then at runtime or startup transform the tangent-space normal and depth using the slot's exported basis (T, B, N) and light them against the fixed world key light and camera. Only 34 master faces to author, small texture memory, and a tile rotated for riichi or placed in an opponent's river automatically catches light on the newly exposed walls of its strokes.

Steps:
1. Export scene lighting and camera vectors into a top-level `lighting` block read from the actual scene: `keyLightDir` (normalized 3D vector pointing toward the primary overhead key light in world space), `keyLightColor` and `ambientColor` (linear RGB tints matching the blank tile render lighting), `cameraPos` (world-space position of the active camera).
2. Export the 3D tangent-space basis per slot from its face-quad corners: `tangent` (unit vector left-to-right across the face, top_left to top_right), `bitangent` (unit vector top-to-bottom, top_left to bottom_left), `normal` (outward unit normal, T cross B). Slots whose faceQuad is rotated already capture their exact table orientation this way, so east/west and north rivers and sideways riichi need no special case.
3. Schema stays additive: existing fields and the faceQuad corner order are unchanged; add `lighting` at the top level and `basis: {tangent, bitangent, normal}` per slot. Example slot: `{"id": "river_south_00_riichi", "bucket": "flat_center_rotated", "basis": {"tangent": [0,1,0], "bitangent": [-1,0,0], "normal": [0,0,1]}}`.
4. Acceptance: `table_layout.json` contains valid unit-length tangent, bitangent and normal vectors for every slot, accurately reflecting 0, plus/minus 90 and 180 degree rotations and the standing-hand tilt angles. Validate in the script (unit length, mutual orthogonality, right-handed) and fail loudly rather than exporting bad data.

## Task 4: Render the Table Background & Bucketed Blank Tile Sprites

Objective: generate the minimal set of static 2D image assets required to reconstruct the entire table at runtime.

Steps:
1. Render the static board background (`board_bg.png`): hide all tile meshes and render the empty table, mat, rim and center well at full target resolution (1920x1080 or 2560x1440).
2. Render perspective blank tile bodies: for each unique bucket from Task 3, place a single blank tile mesh at the representative anchor for that bucket, hide the table background (keeping a shadow-catcher plane if baking shadows), and render cropped RGBA sprites trimmed around the tile pivot/anchor:
   - standing hand blanks (5): `hand_far_left`, `hand_mid_left`, `hand_center`, `hand_mid_right`, `hand_far_right`
   - side wall blanks (2): `wall_left_side`, `wall_right_side` (top face plus inner vertical wall face)
   - horizontal wall blanks (3): `wall_horiz_left`, `wall_horiz_center`, `wall_horiz_right`
   - face-up flat blanks (6): `flat_left`, `flat_center`, `flat_right` in both upright and 90-degree rotated (riichi/meld) orientations
3. Prepare the 2D tile face atlas (`tile_faces.png` + `tile_faces.json`): pack flat, orthographic, high-contrast graphics for all 34 standard tiles (1m-9m, 1p-9p, 1s-9s, 1z-7z) plus red dora fives (0m, 0p, 0s) into one atlas.
4. Acceptance: total blank tile sprite count under 20 files; every blank sprite has clean alpha edges and a recorded pixel pivot matching its exported anchor coordinate.

## Task 4A: Render Decoupled Mat Shadows & Neighbor Crevice Masks

Objective: separate table-surface cast shadows and inter-tile bevel occlusion from the blank tile body renders, so shadows respond to live tile adjacency instead of being baked into sprites.

Steps:
1. Keep blank tile bodies shadow-free: the Task 4 sprites must contain no external drop shadows in their alpha channel; retain only subtle self-shading within each tile's own beveled edges.
2. Render table-cast shadow sprites (`shadow_mat_{bucket}.png`): place a flat Shadow Catcher plane at table surface height (Z = 0), hide the visible table mesh, and for each bucket (`hand_*`, `wall_left_side`, `wall_right_side`, `wall_horiz_*`, `flat_*`, `flat_rotated_*`) place one isolated blank tile at that bucket's representative anchor and render the directional + ambient shadow on the catcher. Export each as a trimmed RGBA PNG sharing the exact pivot/anchor of its blank sprite.
3. Render the stacked wall shadow decal (`shadow_wall_stack.png`): a `layer_0` / `layer_1` pair in a wall stack, with `layer_0` as Shadow Catcher, rendered to show the soft contact shadow `layer_1` casts on `layer_0`'s top face.
4. Generate bevel crevice AO overlays (`ao_seam_left.png`, `ao_seam_right.png`, `ao_seam_top.png`, `ao_seam_bottom.png`) authored in normalized UV space ([0,1] x [0,1]): the narrow occlusion that forms in the beveled valley when another tile sits flush against that edge.
5. Acceptance: blank sprites have crisp edges and zero external halo; every bucket has a matching shadow sprite at the same pivot; seam masks fade from about 35% black at the outer bevel edge to 0% within 8% to 12% of the tile width.

**Landed (2026-11-18, task 261117-0041).** The delivered set and its contract are recorded in `tools/render/README.md` (§"Task 4A"). Two decisions came from the bake's own measurements rather than the letter of the steps above:

* **A wall bucket's mat shadow is grounded.** The representatives of `wall_horiz_center`, `wall_horiz_left`, `wall_horiz_right` and `wall_left_side` are *top-tier* tiles, and the rig's key light is nearly overhead (az 315 deg, el 55 deg, 22 units up), so a shadow rendered at that pose is a floating tile's shadow: the felt under a raised tile is barely occluded (measured peak alpha 0.05, against 1.00 for a grounded tile). The bake drops the same body onto `z = 0`, asserts the drop equals the spec's tier step, and publishes the shadow at the stack's **bottom-tier** anchor; the gate proves the shadow anchor differs from the blank's top-tier anchor. Consequence for Task 6A: pass 1 draws one mat shadow per wall *stack*, at `layer_0`; `layer_1` gets none, and its occlusion of the tile below is the stack decal.
* **The wall-stack decal is per seat.** `shadows.json`'s `wallStack.seatAgreement` compares the four seats in frame space and the measured worst-case alpha difference is 1.0: a wall run's tiles face a different way, so both the projected footprint and the contact band differ. Four decals ship as `shadow_wall_stack_<seat>.png` and each is drawn at its stack's `layer_0` anchor; the gate fails if a future change makes the seats agree (one shared `shadow_wall_stack.png` would be valid then).
* The crevice masks measure a 9.6 %-of-tile-width fade on all four edges (acceptance 8-12 %), authored per axis (0.10 of width along u, 0.075 of height along v) so the physical band matches the 1.54 mm bevel on both axes.
* Signed off by the user on 2026-11-18 after reviewing `tools/render/build/review/shadows/task4a-contact-sheet.png`, including the wall-stack crevice band.

## Task 4B: Bake Orthographic Carved Relief Maps from 3D Tile Faces

Objective: generate physically accurate normal, depth, cavity ambient occlusion and enamel paint masks for all 34 tiles plus red fives, using an orthographic bake from true 3D carved geometry.

Steps:
1. Model true 3D carved glyph geometry: convert high-resolution vector glyphs of the 34 faces into 3D curves/meshes (or high-resolution 1024x1024 displacement maps) and boolean-subtract (or displace inward) them into a flat face slab at an engraving depth of 0.45mm to 0.65mm, with a 35 to 45 degree V-carve wall bevel so the inner stroke walls catch directional highlights.
2. Bake three synchronized orthographic atlases at 256x340 px per tile, sharing identical UV coordinates:
   - `face_albedo.png` (RGB + paint mask alpha): RGB is pure pigment inside the carved strokes (deep crimson, cobalt/prussian blue, emerald green, carbon black) and neutral white (#FFFFFF) on un-carved ivory so it multiplies cleanly onto the lit blank body; alpha is 0.0 on un-carved resin and 1.0 inside painted enamel grooves.
   - `face_normal_depth.png` (tangent normal RGB + depth alpha): RGB is the tangent-space normal (X right, Y down, Z outward) capturing sloped V-carve walls and subtle hand-carved rounding at stroke junctions; alpha is normalized surface height h in [0,1], 1.0 at the un-carved surface and 0.0 at the deepest engraving.
   - `face_ao_roughness.png` (cavity AO + specular gloss): R is baked AO inside the narrow crevices (about 0.45 in tight stroke intersections up to 1.0 on the open face); G is specular roughness, about 0.45 semi-matte resin on the un-carved face versus 0.12 glossy lacquer inside the painted grooves.
3. Acceptance: all three atlases align pixel-for-pixel across all 34 tiles and red dora variants; un-carved areas in `face_albedo.png` have alpha 0 so the blank tile's own surface shading shows through undisturbed.

## Task 5: Implement the Runtime Two-Layer Tile Compositor

Objective: build the runtime sprite assembly module that maps flat 2D tile face decals onto perspective-angled blank tile bodies.

Steps:
1. Quad warping / perspective mapping: given a tile's `bucket` (blank body sprite) and `tileId` (face atlas region), map the 4 corners of the 2D face graphic onto the `faceQuad` coordinates for that slot/bucket:
   - WebGL / PixiJS / Three.js 2D: render a 2-triangle textured quad using the 4 faceQuad vertices (with homogeneous w perspective correction if strongly foreshortened, or a subdivided 2x2 grid for an affine approximation).
   - HTML5 Canvas 2D: subdivide the face quad into a 4x4 mesh of triangles and draw affine-mapped slices via ctx.setTransform(...) to eliminate affine diagonal warping on strongly angled wall and river tiles.
2. Lighting and tint matching: apply a subtle per-bucket brightness/tint multiplier (0.92 to 1.0) to the 2D face decal so tiles on shadowed side walls or steeper angles blend naturally with the shaded 3D blank body.
3. Runtime texture caching: pre-composite (bucket, tileId) pairs into an offscreen sprite cache or dynamic atlas at startup so active gameplay renders single draw calls per tile without per-frame mesh subdivision.
4. Acceptance: face symbols align accurately inside the beveled front/top borders of every angled blank tile across all zones; red fives, winds, dragons and numbered suits stay crisp and legible even on the farthest north river row.

## Task 5A: Implement Orientation-Aware Carved Relief Shading & Caching

Objective: upgrade the Task 5 compositor so every tile face is shaded in world space from its slot's basis vectors, producing directional inner-wall bevel highlights, glossy paint glints and subtle groove parallax that survive any rotation.

Steps:
1. View vector and tangent-space view direction, for a slot at world position P_slot with basis (T, B, N): V_world = normalize(P_cam - P_slot); V_tan = (V_world . T, V_world . B, V_world . N).
2. One-step carved groove parallax: sample depth h from `face_normal_depth.a` at uv, then shift the lookup along -V_tan.xy proportional to groove depth (1 - h) and carving scale d_carve about 0.018: uv_carved = uv - (V_tan.xy / max(V_tan.z, 0.35)) * (1 - h) * d_carve. Re-sample albedo, normal and ao_roughness at uv_carved, so at oblique angles the painted stroke base shifts beneath the ivory lip.
3. Transform the tangent normal and light it: n_tan = 2 * rgb - 1; n_world = normalize(n_x * T + n_y * B + n_z * N). Diffuse: I_diff = max(n_world . L_world, 0) * C_key + C_amb, multiplied by AO_cavity, so stroke walls facing away from the key light fall into crisp shadow while lit walls brighten. Glossy enamel specular: H = normalize(L_world + V_world); I_spec = paintMask * pow(max(n_world . H, 0), 48) * 0.45.
4. Composite over the blank body (the V-carve lip may modulate the un-carved rim) and warp onto faceQuad. Bake at startup: group slots by (bucket, rounded T/B/N) — about 24 unique (bucket, orientation) pairs — and bake the 34 x 24 = 816 lit face decals into an offscreen cache at load, so gameplay holds 60 FPS with zero per-frame shader cost.
5. Acceptance: sideways riichi tiles and east/west river tiles show top-lit highlights on the newly top-facing inner walls of their carved glyphs, matching the key light direction of their blank body; enamel shows subtle glossy glints when angled toward the light while recessed corners keep dark cavity AO.

## Task 6: Implement the Deterministic Painter's Algorithm Renderer

Objective: render all board layers and tile slots in strict back-to-front and outer-to-inner order so overlapping bevels and inner thickness edges occlude accurately without a 3D depth buffer.

Steps:
1. Global zone draw order: (1) `board_bg` (mat, rim, center score display, seat wind indicators); (2) `wall_north` (bottom `layer_0` first, then top `layer_1`); (3) `wall_west` and `wall_east` sorted far-to-near along screen Y, `layer_0` before `layer_1` per stack; (4) `river_north` top-to-bottom rows, within each row outer columns toward the center column; (5) `river_west` and `river_east` top-to-bottom along screen Y, inner columns toward outer columns; (6) `river_south` top-to-bottom rows, outer columns toward center; (7) `meld_*` zones sorted back-to-front by screen Y; (8) `wall_south` (`layer_0` first then `layer_1`, outer columns toward center); (9) `hand_north`, `hand_west`, `hand_east` (opponent hands); (10) `hand_south` (player hand, drawn last).
2. Outer-to-inner sorting within horizontal rows: because perspective reveals the inner thickness edge of tiles on both sides of screen center (x = 0.5), tiles closer to the horizontal center overlap the inner edge of outer neighbors. For `hand_south`, `wall_north`, `wall_south` and horizontal river rows, sort by descending horizontal distance from screen center (|x - 0.5| descending): left half left-to-right, right half right-to-left.
3. Interactive tile elevation: on hover or selection in `hand_south`, offset anchor.y upward by -0.025 normalized screen units, keeping horizontal draw order intact or elevating hovered tiles without clipping adjacent inner edges.
4. Acceptance: zero visual overlap glitches where a tile's inner side face draws on top of a neighbor closer to screen center; upper wall tiles (`layer_1`) always sit cleanly atop lower tiles (`layer_0`), including dora indicator flips and kan dead-wall replacements.

## Task 6A: Implement Adjacency-Aware Dynamic Shadow Passes

Objective: render mat shadows, stacked wall shadows and inter-tile bevel occlusion dynamically, from which neighbouring slots are occupied in the current game state.

Steps:
1. Pass 1 — table mat shadow layer, between `board_bg` and all tile bodies: iterate every occupied slot and draw its `shadow_mat_{bucket}` at its anchor before any tile body. An open-end river tile therefore casts onto exposed felt, and the next discard's body covers that exposed shadow automatically. Render all mat shadows into an offscreen buffer with MAX alpha blending (or a clamped maximum opacity) before compositing onto `board_bg`, so overlapping penumbras merge instead of double-darkening.
2. Pass 2 — wall stack shadow: during the wall pass, after drawing a `layer_0` body, check whether `layer_1` at the same (seat, stack) is occupied; if so draw `shadow_wall_stack.png` mapped onto `layer_0`'s top face before drawing `layer_1`.
3. Pass 3 — dynamic bevel crevice AO: for any tile in a river, wall, meld or hand, inspect its orthogonal neighbours in the live state (`hasLeft`, `hasRight`, `hasTop`, `hasBottom`), and draw the matching `ao_seam_*` overlay mapped onto that tile's `faceQuad` at 50% to 70% opacity. Open edges (newest river tile, end of a broken wall, separated tsumo tile) omit the overlay so the lit bevel stays bright.
4. Pass 4 — interactive tile elevation: when a `hand_south` tile is hovered or selected (body shifted by dy = -0.025), keep its `shadow_mat` anchored at the resting position (y0), scaled 0.92x and at 0.75x opacity, and suppress `ao_seam_left`/`ao_seam_right` on both the elevated tile and its immediate neighbours while it is lifted.
5. Acceptance: adding or removing tiles in a river or wall updates mat shadows and crevice shading with zero double-darkened overlaps; lifting a hand tile separates it from its base shadow and its neighbours' bevel shadows.

**Landed runtime (2026-11-18, task 261117-004151).** The passes are `frontend/src/table/boardShadows.ts` (plan + compositor) over `frontend/src/table/shadowManifest.ts` (the two 4A manifests and the bucket rules). The renderer that owns the frame loop is the rendered view (261118-1657), which is parked and not merged; the module therefore takes a `ShadowBoard` (zones placed in board @1x px — structurally the parked view's `BoardZone[]`) and exposes exactly three call sites:

```
// once, between board_bg and the first tile body
shadows.drawMatShadowPass(ctx);
// per zone, per body, in painter order
shadows.drawWallStackShadow(ctx, zoneIndex, bodyIndex); // after the body
blitBody(...);
shadows.drawCreviceSeams(ctx, zoneIndex, bodyIndex);    // after the body
```

`update()` re-plans and repaints only the zone masks whose signature changed, so a one-tile change does not repaint the board. Decisions taken, with the measurement or source for each:

* **Mat shadows use MAX alpha via a transmittance layer, then `multiply`.** `shadows.json` requires MAX (never straight-over) and declares `composite.model: multiply`. Canvas 2D has no per-pixel max on alpha, so each sprite is pre-flattened onto white — which turns its alpha into the grey `b = 1 - alpha` — and the zone buffers merge with `darken`, which for an opaque source is exactly `min(b)` = MAX alpha. The merged layer is drawn once with `multiply` (`dest * b`), the manifest's own model. Measured: an 18-tile river's 181,719 shadowed pixels are never darker than the darkest single-tile render at that pixel (worst difference 0.00 luma); straight-over alpha would peak at 0.80 instead of 0.55 for two crossing 0.55 shadows.
* **One mat shadow per wall *stack*, at `layer_0`.** Task 4A grounds the three horizontal wall buckets and publishes their shadow at the bottom tier, so the pass draws `zone.shadows` (the layout already excludes `layer_1`) and a raised tile adds no second footprint.
* **The stack decal is keyed off live cells, not the layout.** It is drawn after a stack's `layer_0` body only when a `tier: 1` body exists at the same slot; the upper body then covers its inner part and the band on the lower tile stays visible (measured: 2,213 px, up to 54 luma). Remove the upper tile from the plan and both the body and the decal are gone.
* **Adjacency is logical, the side is geometric.** Neighbours come from the live cells (`row/column`, `column`, `slot/tier`, hand row slot), so the newest river tile, the end of a broken wall and the separated drawn tile write no overlay. The *edge* is resolved through the tile's own plate axes (`screenRotationOfQuad`), so a sideways riichi tile or a reversed seat quad still gets the mask on the side that faces the neighbour. The tier crevice of a wall stack is deliberately **not** an AO mask: 4A models it as the one measured stack decal, so a second overlay there would be a hidden duplicate.
* **Masks map straight onto `faceQuad`.** `ao_seams.json` authors `left` at `u = 0`, `right` at `u = 1`, `top` at `v = 0`, `bottom` at `v = 1`, so the whole image maps with no rotation — which is what keeps the fade on its authored axis (0.10 of the short side along u, 0.075 of the long side along v). Drawn at 0.6 of the mask's own 35 % peak (inside the 50-70 % band).
* **Elevation is 0.025 of a 1080-tall frame = 27 px**, per this task's step 4. The architecture's older Phase 5.1 said `drawY -= 12`; Task 6A is newer and specific, so 27 px wins — changing it is a one-constant edit. The lifted tile's shadow stays at its resting pivot, scaled 0.92 and at 0.75 opacity; only the crevices *facing* the lifted tile are dropped (the lifted tile's own left/right and the facing side of each neighbour), because a neighbour's far side still abuts a resting tile. Measured on the proof sheet: 1,202 pixels beside the lifted tile brighten, most by 21 luma, and the hand's seam count falls 24 → 20.
* **Zone lean is honoured.** The side ponds carry a 1° group rotation about `pivotX/pivotY`; the mat mask is painted inside the same rotation (with rotated bounds) and the decal/seam passes apply it, so a leaning pond's shadows lean with its bodies.

The per-axis offsets `dy = -0.025` and the `0.92`/`0.75` elevation numbers live in `boardShadows.ts` as `HAND_LIFT_PX`, `LIFTED_SHADOW_SCALE` and `LIFTED_SHADOW_OPACITY`.

**Proof renders (uncommitted, gitignored).** `cd frontend && npm run shadows:review` writes `tools/render/build/review/shadows/task6a-dynamic-shadows.png` (2190 × 1279, @1x: a river at 1/5/18 tiles with a bodies-only "before", a wall with the decal on/off and with its upper tier drawn, and a hand at rest vs lifted) plus `task6a-numbers.json`, and prints the numbers above. The panels are placed by the script's own harness, not by the rendered view's `boardPlan.ts`; the shadow mechanics are the real ones. **Visual sign-off is the user's (AGENTS.md §6).**

**Still to do when the rendered view lands:** call the three hooks from `BoardRenderer.ts`'s zone loop, and drop a drawn upper tier from the wall zone's `bodies` (not just hide it) so pass 2 updates. Opponent hands (`hand_north`/`hand_west`/`hand_east`) need 261118-2034's blue-back blanks; the hand bucket rules for them are implemented and unit-tested against the layout, and no proof render shows them.


## Task 7: Verification & Visual Calibration

Objective: validate perspective consistency, legibility and responsive scaling across target aspect ratios.

Steps:
1. Full-board stress test: populate a debug board with all 136 tiles visible at once (full walls with a flipped dora indicator, 3-row rivers with sideways riichi tiles, open kan melds, 14-tile hands).
2. Verify perspective cues: `wall_west` and `wall_east` show inner vertical faces and converge toward a vanishing point above the top edge; `hand_south` transitions from left-inner thickness on the left, straight-on in the center, to right-inner thickness on the right.
3. Responsive viewport scaling: scale the 1920x1080 root coordinate space uniformly (letterbox, or cover with safe-area padding) so normalized coordinates and sprite scales stay locked across window resizes.
4. Acceptance: the debug full-board render shows zero z-order overlaps, zero misaligned face decals, and holds 60 FPS with 2D sprite batching.
