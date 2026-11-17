# Whole-table 3D model + slot anchors

A Blender model of the complete Riichi table and one named `Empty` for every
tile slot. It is a **development/calibration model**: nothing under
`frontend/public` is written and the runtime never reads it.

**Scope note (2026-11-17):** this task is the table model and the anchor bank.
The placement renders here inherit the earlier calibration reference's camera
and are **not** a lighting verdict. **Task 2** (2026-11-17) owns the perspective
and lighting calibration and ships it as a separate `--rig` mode of the same
scene and placements. It is variant-based (A/B): `v1-baseline` is the saved
first rig, `v2-compact` the first experiment (bigger, hands/melds pulled in to
the wall, a readability cheat on the player's hand, dimmer key), and
`v3-hand-shadow` moves only the player's hand a further half tile back, and
`v4-shadow-decal` replaces the shadow with a soft gradient that emerges from the
tile's front edge, and `v5`–`v7` are three longer/stronger takes on that
gradient for choosing a preference. The
placement board below stays at its own 2880 × 2112 framing for plan review. See
[The 2.5D rig](#the-25d-rig-task-2).

**Placement sign-off (2026-11-17):** the user reviewed the committed board, the
table plan and the anchor plan and approved the table model, anchor bank, riichi
discards, dead wall/dora, drawn wall ends and the melded called-tile edge. The
visual verdict was the user's (AGENTS.md §6); the numbers in this note were
produced by the scripted checks.

- Scene + camera + anchor spec: [`table-reference-spec.json`](table-reference-spec.json)
  (the Task 2 camera/light rig is the spec's `rig` block)
- Blender generator: [`bake_table_reference.py`](bake_table_reference.py)
- Entry point: [`bake-table-reference.sh`](bake-table-reference.sh)
- Published model: [`reference/`](reference/) — board, element crops,
  `slot-anchors.json`, `table-reference.json`, contact page
- Published rig variants: [`reference/rig/`](reference/rig/) —
  `<variant>-1x.png` + `<variant>.json` for each saved look, plus the A/B page
  [`reference/rig/index.html`](reference/rig/index.html)
- Integrity gates: [`scripts/check-table-reference.mjs`](scripts/check-table-reference.mjs)
  and [`scripts/check-table-rig.mjs`](scripts/check-table-rig.mjs)

## Commands

```bash
bash tools/render/bake-table-reference.sh --dry-run   # build + validate; print the model's metrics
bash tools/render/bake-table-reference.sh --bake      # render the @2x placement reference, publish, check
bash tools/render/bake-table-reference.sh --rig       # render/publish/check the default rig variant (v1-baseline)
bash tools/render/bake-table-reference.sh --rig --variant v2-compact   # one A/B variant
bash tools/render/bake-table-reference.sh --rig --variant v2-compact --rig-width 700 --samples 12   # fast tuning, never publishes
bash tools/render/bake-table-reference.sh --check     # both gates; no Blender
```

Blender is pinned to 4.5.9 LTS at `~/.local/opt/blender-4.5.9/blender` (present
in this environment). `--check` needs only Node.

## The table model

1 unit = 28 mm (the shell baker's tile scale). 269 tile bodies + the table.

| Element | Model |
| --- | --- |
| Playing mat | 700 mm × 700 mm (25 × 25 units), cloth `#1a5038`, top at z = 0 |
| Rim | raised outer frame outside the mat: 25 mm wide (0.9 units), 9.8 mm high (0.35 units), dark wood |
| Compass/score well | 4.0-unit recessed square at the centre (0.06 deep), dark plate + brass ring, all below z = 0 so it cannot occlude a pond |
| Walls | four runs × 17 stacks × 2 tiers (blue up), pitch 0.760714, tier step 0.6, ring radius 7.0. The west (left) run has the **7-stack dead wall** at slots 0–6 with a 0.5-unit break after slot 6; the dora indicator is the face-up top tile at slot 4 (`1z`). Every run has only the **bottom tile at slot 16** (the draw end), so the wall is 132 tiles. |
| Ponds | four 6 × 3 filled rivers (72 discards), column pitch 0.757143 (0.2 mm gap), row pitch 1.010714 (0.3 mm gap), row radii 4.81 / 3.799286 / 2.788571. Each pond has one **riichi discard** at row 1, column 5, turned 90° to the seat's right; it is shifted after the previous tile and its near edge is aligned to the row baseline. |
| Hands | four 13-tile standing rows; the human's (south) row is reclined 12° backward about its far bottom edge, the other three are upright blue-back rows; human also has the drawn-tile slot at +5.580536 (intentional tsumogiri gap) |
| Melds | one 3-tile open pon per seat **outside the wall ring, on the table edge to the player's right** (rod radius 10.6, x from 6.1): two upright tiles + the called tile sideways with its near edge flush with the uprights' bottom edge (the same near-edge rule as the riichi discard); a fourth anchor slot per seat is the kan extension |
| Felt/room | dark floor plane at z = −0.08 outside the rim |

The tile mesh, bevel and white/blue material gate come from `bake_shells.py`,
so the tile body is the shipped shell body. The bevel is therefore the shell's
0.055 units (1.54 mm). The task brief suggested 0.8–1.2 mm; that would desync the
model from the shipped shells and the shell `faceQuad`, so it is left as the
shell value. Face glyphs are the flat 2D masters on a plane inside the plate
bevel, not carved decals.

### Clearance

Adjacent tiles in walls, rivers and hands have **0.2–0.5 mm** clearance, and no
two tile bodies intersect. The model's target is 0.3 mm; pond columns are 0.2 mm
so the four inner pond rows clear each other at the corners. The bake measures
**346 adjacent pairs**, reports **0.2000–0.3000 mm**, and proves **0
intersecting pairs** with an AABB sweep over all 269 tiles. Three intentional
exceptions are recorded separately: the dead-wall **break** is 14.3 mm, the
turned riichi tile's far-side row gap is 7.3 mm (its 0.75-unit depth), and the
drawn tile is 7.4 mm from the hand row (the tsumogiri gap). `--check` repeats
the measurement from the published placements.

## Slot anchors

Every valid tile position is an Empty in the dedicated Blender collection
**`SlotAnchors`**, at the tile's 3D body centre with the tile's pose. The model
has **293 anchors**, of which **269 are occupied** by the reference tiles and
24 are reserved (16 row-2 river overflow slots, 4 kan-extension meld slots,
4 drawn top-tier wall slots).

| Zone | Naming | Anchors | Occupied |
| --- | --- | --- | --- |
| walls | `wall_{seat}_{stack:02d}_{layer}` | 136 (4 × 17 × 2) | 132 (4 drawn tops) |
| rivers | `river_{seat}_{row}_{col}` (row 0..2, col 0..5, overflow 6..9) | 88 (4 × 22) | 72 |
| melds | `meld_{seat}_{slot}` (slot 0..3) | 16 (4 × 4) | 12 |
| hands | `hand_{seat}_{index:02d}` (00..12; south also 13 for the drawn tile) | 53 | 53 |
| **total** | | **293** | **269** |

Seats are `south` (the human/bottom), `east` (right), `north` (top) and `west`
(left).

### Face quads

Every anchor carries the four corners of the glyph face plate:

- Anchor-local space: `+x` = tile right, `+y` = glyph top, `+z` = out of the
  painted face; the anchor is at the tile body centre.
- Corners are **TL, TR, BR, BL** at
  `x = ±(width/2 − faceInset)`, `y = ±(height/2 − faceInset)`,
  `z = +thickness/2`, with `faceInset = 0.055` units (the shell bevel inset), so
  the quad is the same plate the runtime atlas maps a glyph onto.
- Stored as Blender custom properties on each Empty: `faceQuadLocal` and
  `faceQuadWorld` (flat 12 floats each) plus `faceQuadOrder = "TL,TR,BR,BL"`.
- Also published machine-readable in [`reference/slot-anchors.json`](reference/slot-anchors.json)
  with each anchor's `name`, `zone`, `seat`, `index`, `tileId`, `tileFace`,
  `occupied`, `origin`, `rotation` (row-major 3×3), `faceQuadLocal`,
  `faceQuadWorld` and `extra` (overflow/kan flags). The file also records the
  camera.

For a follow-up projection export: `world = anchor.matrix_world @ Vector(corner)`
for each local corner (or read `faceQuadWorld`), then project with
`world_to_camera_view`.

## Camera and lighting: the placement view

The `--bake` placement board still uses the reference's locked weak-perspective
camera: 45° elevation, 140 mm / 36 mm, eye `(0, −86.0826, 86.4326)`, target
`(0, 0, 0.35)`, 2880 × 2112 @1x from one 5760 × 4224 @2x master, with the earlier
reference's sun/ambient rig. It exists to show the anchors and keep the model in
the same space as the previous reference; it is not the 2.5D framing.

## The 2.5D rig (Task 2)

Task 2 of [`2_5d_implementation_plan.md`](../../2_5d_implementation_plan.md)
ships the perspective and lighting for the new pipeline as a second mode of the
same scene (`--rig`). It reuses every tile placement from this model. The rig is
**variant-based** so settings can be A/B compared without losing a look:

- `table-reference-spec.json`'s `rig` blocks are the saved **v1 baseline**
  (the first committed rig).
- `rig.variants` holds named experiments. A variant may override the **table
  layout** (hand/meld radius, hand tilt), the **camera**, the **lights**, the
  **render settings** and the **acceptance thresholds**. Empty overrides mean
  "the baseline".
- Each variant renders to `tools/render/reference/rig/<variant>-1x.png` with its
  record in `<variant>.json`. `tools/render/reference/rig/index.html` is the
  A/B page (both images, both settings tables, both number sets).
- The gate `scripts/check-table-rig.mjs` validates **every committed variant**.

```bash
bash tools/render/bake-table-reference.sh --rig                        # v1 baseline: render, publish, check
bash tools/render/bake-table-reference.sh --rig --variant v2-compact    # one variant
bash tools/render/bake-table-reference.sh --rig --variant v2-compact --rig-width 700 --samples 12  # fast tuning, never publishes
bash tools/render/bake-table-reference.sh --check                       # every committed variant, no Blender
```

Every rig variant shares these fixed rules: perspective (not orthographic),
65–85 mm on a 36 mm sensor, 48–52° pitch, eye on X = 0 behind the south edge, a
negative Shift Y, no roll, 16:9 at 1920 × 1080, Film > Transparent with the room
floor hidden, one large soft AREA key slightly forward of centre plus low fills,
and Cycles path-traced GI for the contact shadows. The player's blank hand probe
(`hand-bottom-06` forced to `5z`) gives a known ivory hand face in every variant;
`check-table-rig.mjs` also confirms the only face override is that probe.

### v1-baseline (saved 2026-11-17)

The first committed rig, kept unchanged as the A/B reference.

| Parameter | Value |
| --- | --- |
| Camera | 75 mm, 50° pitch, eye `(0, −48.851858, 58.569378)`, **76 units**, Shift Y **−0.02**, no roll |
| Framing | whole 700 mm mat + rim width, 164.6 px side margins; far rim 16.3 px inside; near rim cropped 41.8 px; hand 73.5 px above the bottom |
| Layout | hands radius **10.6**, melds **10.6**; player hand reclined **12°** |
| Lights | AREA key 20 × 14 at `(0, −2.5, 22)`, **9000 W**, `#fff7ea`; fills 1400 W at `(0, −26, 9)` and 700 W each at `(±22, −7, 11)`; world `#3b4a5c` × 0.35 |
| Measured | discard face **217.2**, blue back 63.7, hand face **137.9**, side inner faces 121.0 / 118.6, felt 69.1 |

### v2-compact (experiment, 2026-11-17)

The user's direction: everything bigger and more compact, hands and melds pulled
in to the wall, the player's hand angled more toward the eye for readability,
and the key dimmed a little.

| Parameter | v2 | vs v1 |
| --- | --- | --- |
| Hands / melds radius | **8.8 / 8.8 units** | pulled in from 10.6; the hand row now sits 1.3 units behind the wall's outer edge (was 3.1) |
| Player hand tilt | **40°** recline about the far bottom edge | was 12°; the face is now ~19° off the eye instead of ~47°, so the faces read much closer to straight-on |
| Camera | 75 mm, 50° pitch, eye `(0, −37.924469, 45.546622)`, **59 units**, Shift Y −0.02 | framed to the tile content, not the mat: **every tile inside** (≥ 26.8 px), hand 45.2 px above the bottom, rim crosses the frame edges |
| Tile size | hand face width **48.42 px** | 1.29× linear / 1.68× area larger than v1 |
| Lights | key **6000 W**, fills 900 / 450 / 450 W | key cut 33 % in energy; the lit discard face drops **217.2 → 203.3** luma (AgX compresses most of it) |
| Measured | discard face **203.3**, blue back 50.5, hand face **119.8**, side inner faces 95.4 / 98.2, felt 51.8 | |

**The hand cheat, and its lighting.** The 40° recline is deliberately not
physical: the tile balances on its far bottom edge, the near bottom edge floats
0.38 units (10.6 mm) above the table, and the reference render's cast shadow is
therefore not the production shadow (the runtime will draw a blob shadow under
it). To keep the light on the hand looking like a normally seated tile, every
hand material — the blank bodies and their face decals — shades with its normal
rotated back by the extra 28° about world X (the hand row is not yawed), so the
key and fills land exactly as they would on the 12° physical pose. The
silhouette keeps the cheat; the shading does not. Measured proof, same lights:
without the correction the 40° hand face reads **178.8** luma at the tuning
render; with it, **119.8** — the physical-pose level (v1's 12° hand reads
137.9 at its brighter key). The gate enforces `hand/discard luma ≤ 0.7`
(measured **0.589**) so a regression that drops the correction fails.

The correction is a shading-normal rotation per hand material, recorded in the
bake as `handLightingCheat` (mode `physicalPose`, physical/cheated tilt, the
28° delta, 27 objects, 11 materials). Task 3A should export the **physical**
face basis for the player's hand (or the cheat has to move into the runtime
shader) if the same look is to survive the sprite pipeline.

### v3-hand-shadow (experiment, 2026-11-17)

v3 extends v2 with the user's follow-up: only the player's hand moves further
from the wall, and its shadow stops giving the cheat away.

| Parameter | v3 | vs v2 |
| --- | --- | --- |
| Player's hand radius | **9.3** | the shared 8.8 radius still applies to the three opponent hands; only the bottom hand (and its drawn tile) moves back the extra **0.5 units** (half a tile height) |
| Camera | 75 mm, 50° pitch, eye `(0, −38.88865, 46.695689)`, **60.5 units**, Shift Y −0.02 | refit for the moved hand: every tile inside (≥ 28.6 px), hand 28.6 px above the bottom, hand face 47.37 px wide |
| Hand shadow | **physical-pose caster**, fills light-linked away from it | was the cheated hand's own shadow |
| Measured | discard face **203.2**, hand face **105.5** (hand/discard 0.519), side inner faces 93.4 / 100.2, felt 51.8; wall behind the hand **uniform** | |

**The shadow cheat.** The 40° hand casts a tall shadow under itself and a
hand-shaped shadow up the wall behind it (the near fill sees the hand from the
south; that wall band measured a **45.4** luma dip in v2). v3 turns the hand's
own shadow off entirely and gives every hand tile a **shadow-only duplicate at
the 12° physical pose**: invisible to the camera, diffuse and glossy rays and
volume scatter, visible only to shadow rays. Each fill's blocker collection
omits those casters, so only the key casts the physical shadow — a short band
falling south, the same family as the shadow in front of the wall. The wall row
now measures a **4.3** dip (uniform), and the under-hand shadow is the normal
tile's, not the leaning tile's. The hand still never casts onto the wall or the
pond behind it.

The bake records the casters (`handShadow`: 14 casters, 27 hand objects hidden,
the three light-linked fills), and the gate enforces: the player's hand base is
exactly 0.5 units behind the other hands, the caster tilt is the physical 12°,
and the wall dip stays under 15 luma.

### v4-shadow-decal (experiment, 2026-11-17)

v4 keeps v3's spacing exactly (the player's hand at 9.3, camera at 60.5) and
replaces the rendered physical-pose caster, which read as hard black rectangles
and started at the *rear* edge where the tile balances, with a **fake soft
gradient shadow**.

| Parameter | v4 |
| --- | --- |
| Shadow | straight-alpha black strip on the mat; **2 strips** (the 13-tile row and the drawn tile), no shadow rays |
| Start | radius **9.4336**, i.e. 0.317 units *under* the tile, so its hard near edge is hidden and the visible gradient begins at the tile's front edge (front edge 9.7514, edge height 0.3788) |
| Shape | `maxAlpha 0.3`, length **0.32 units** (9 mm), falloff `(1-v)^1.2`, x ends faded over 3 % |
| Measured | darkest visible felt **0.867×** the lit felt at 0.10 units from the edge; back to **0.994×** by 0.34 units; wall behind the hand **0.8** dip; hand face 117.6 luma |

The decal is pure darkening (a black roughness-1 surface whose alpha is a UV
gradient), so it cannot go solid black the way the caster's shadow core did: the
darkest visible pixels are about 13 % below the local felt, and the gradient has
returned to lit felt within ~0.2 units (≈ 12 px at 1920). Because it casts no
shadow rays, nothing appears on the wall behind the hand, and the hand's own
cast shadow stays off. The hand face reads **117.6** in v4 rather than v3's 105.5
because v3's casters were also blocking fill light on the hand's face; with them
gone the physical-pose shading is the full read.

The gate enforces: the decal starts under the tile, `maxAlpha` ≤ 0.45, the
darkest visible felt ≥ 0.7× the local felt, the shadow is gone (≥ 0.92×) by 0.34
units, the gradient is monotonic, and the wall dip stays under 15.

### Shadow takes (v5–v7, 2026-11-17)

v4's gradient was judged barely visible, so three takes extend v4 with a longer,
stronger decal. Each lifts the framing 19 px (Shift Y −0.03 instead of −0.02) so
the longer gradient finishes on lit felt instead of reaching the frame edge; the
hand bottom margin goes 28.6 → 47.8 px. v4 itself is untouched for comparison.

| Variant | Length | Max alpha | Falloff | Darkest visible (× felt) | Back to lit felt |
| --- | --- | --- | --- | --- | --- |
| **v4** (reference) | 0.32 u / 9 mm | 0.30 | 1.2 | 0.867 | ~0.34 u |
| **v5 shadow wash** | 0.55 u / 15 mm | 0.50 | 1.0 | 0.702 | ~0.55 u |
| **v6 long faint** | 0.65 u / 18 mm | 0.40 | 0.7 | 0.733 | ~0.70 u |
| **v7 deep contact** | 0.42 u / 12 mm | 0.65 | 1.4 | 0.70 | ~0.40 u |

All four share the hidden start under the tile, the front-edge emergence, no
shadow rays and a clean wall behind the hand (dip 0.7–0.8 luma). The gate holds
every take to the "no black rectangle" floor: max alpha ≤ 0.75, the darkest
visible felt ≥ 0.4× the local felt, a monotonic fade (5 % noise tolerance) and
lit felt by the variant's fade distance.

### What still needs the user

The numbers say the geometry, framing, shadowing and exposure are what was
asked; only the user can sign off the *look* (AGENTS.md §6).

```bash
xdg-open tools/render/reference/rig/index.html   # v1 / v2 / v3 side by side, with the numbers
bash tools/render/bake-table-reference.sh --check
```

The open question is which shadow take to keep: v4 (0.32 u, 13 % dark), v5 (0.55 u,
30 % dark), v6 (0.65 u, softly 27 % dark) or v7 (0.42 u, 30 % dark but firmer at
the edge). Compare them on the A/B page, then the chosen one becomes the
production setting and the others can be pruned. The 40° recline and the 203
discard face are unchanged.

## Published renders and checks

`bash tools/render/bake-table-reference.sh --bake` writes the full board @1x,
one @2x crop per element family, `table-reference.json` (camera, every tile
placement, metrics, decoded-RGB hashes) and `slot-anchors.json`, then runs the
dependency-free gate:

- spec + camera consistency, the full 132/72/52/12/1 tile inventory and poses
  (dead wall, dora, draw ends, riichi discards);
- every anchor's name, zone, count, unique name, body-centre origin, rotation,
  and the 12-float face plate in local and world space;
- clearance 0.2–0.5 mm for the 346 adjacent pairs, the 14.3 mm dead-wall break
  and the 7.3 mm turned-riichi gap, and **0** intersecting tile
  bodies;
- every render's dimensions, bytes and decoded-pixel hash;
- the table surface facts (700 mm mat, rim outside the mat, recessed well) and
  the rim inside the frame;
- the earlier reference's lighting samples (informational for this task; they
  tie the render to the shipped shells).

The near rim is inside the new 2880 × 2112 frame; the board shows the whole
mat and rim with an 88 px bottom margin. The committed reference set is
regenerated by the bake; the tile crops are at 2× the board.

## Game-state variants deliberately not modelled here

This reference is the early-hand calibration state: a full concealed hand plus
one open meld. Two legal states are **not** separate 3D scenes, because they are
layout variants that reuse the existing shells and face variants:

- **19+ discards in a pond.** In play, extra discards continue on the last row
  rather than starting a fourth row. The runtime layout should wrap them into
  row 2, columns 6+, reusing the same flat shells. The four reserved row-2
  overflow anchors in `SlotAnchors` document those slots, but placing tile
  bodies there in 3D would collide with the neighbouring pond (a property of the
  physical table), so they stay empty.
- **Two or more open melds.** In a real hand the concealed count shrinks by 3
  per open meld (13 - 3N at rest; 14 - 3N with the draw), so additional melds
  occupy the space vacated by the hand. The runtime should lay the meld groups
  in a line to the left of the first meld and give `layoutHand` the short
  concealed row; the same shells are reused. Modelling extra melds against the
  current full 13-tile hand would be an illegal, colliding position, so it is
  not a reference scene.

If a visual target for those states is wanted later, build a separate mid-game
reference with the correct short hand (or a 2.5D layout preview), not by adding
tiles to this early-hand reference.

## Ambiguities resolved in this model

- **Bevel**: the brief says 0.8–1.2 mm; the shipped shell body uses 1.54 mm
  (0.055 units). Kept the shell value so the model and shells agree.
- **Overflow rivers**: the brief says "row 2 for columns 6+" without a count;
  four extra columns (6..9) fit before the west/east wall at this table size.
  They are anchors only (no tiles) because a fully occupied overflow row would
  run into the neighbouring pond.
- **Melds**: the brief says "corner slots ... for chii, pon, kan and kita". One
  4-slot meld row per seat is modelled outside the wall on the player's right;
  the reference pon occupies 3 slots and the fourth is the kan extension. Only
  one such row is present per seat.
- **Kita**: a 3-player rule; no separate tile is modelled, the meld row's slots
  are the generic declaration area.
- **Hand tilt**: the brief names the player's standing hand, so only the south
  hand is reclined 12°; the three opponents' back rows stay upright.
- **Empty slots**: 20 anchors have no body (river overflow, kan extension); they
  still carry a full face quad.
