# Whole-table 3D model + slot anchors

A Blender model of the complete Riichi table and one named `Empty` for every
tile slot. It is a **development/calibration model**: nothing under
`frontend/public` is written and the runtime never reads it.

**Scope note (2026-11-17):** this task is the table model and the anchor bank.
The placement renders here inherit the earlier calibration reference's camera
and are **not** a lighting verdict. **Task 2** (2026-11-17) now owns the
perspective and lighting calibration and ships it as a separate `--rig` mode of
the same scene and the same 269 placements: a 75 mm perspective camera with a
negative lens shift, a soft overhead area key plus fills, film transparent, and
a 1920 × 1080 RGBA reference. The placement board below stays at its own
2880 × 2112 framing for plan review. See [The 2.5D rig](#the-25d-rig-task-2).

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
- Published rig: [`reference/rig-1x.png`](reference/rig-1x.png),
  [`reference/rig.json`](reference/rig.json),
  [`reference/rig.html`](reference/rig.html)
- Integrity gates: [`scripts/check-table-reference.mjs`](scripts/check-table-reference.mjs)
  and [`scripts/check-table-rig.mjs`](scripts/check-table-rig.mjs)

## Commands

```bash
bash tools/render/bake-table-reference.sh --dry-run   # build + validate; print the model's metrics
bash tools/render/bake-table-reference.sh --bake      # render the @2x placement reference, publish, check
bash tools/render/bake-table-reference.sh --rig       # render the 2.5D rig reference (1920x1080 RGBA), publish, check
bash tools/render/bake-table-reference.sh --rig --rig-width 960 --samples 16   # fast tuning render, never publishes
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
same scene (`--rig`). It reuses every tile placement from this model; the only
content difference is that `hand-bottom-06` is forced to a blank (`5z`) face so
the hand has a known ivory lighting probe. The committed artifact is
[`reference/rig-1x.png`](reference/rig-1x.png) (1920 × 1080 RGBA), its record
[`reference/rig.json`](reference/rig.json), and a contact page
[`reference/rig.html`](reference/rig.html).

### Camera

| Parameter | Value |
| --- | --- |
| Projection | Perspective (not orthographic) |
| Lens / sensor | **75 mm** on a 36 mm sensor, horizontal fit (75 mm is the middle of the plan's 65–85 mm band) |
| Position | eye `(0, −48.851858, 58.569378)`, X = 0, behind the south edge; target `(0, 0, 0.35)` |
| Distance | **76 units** (eye to target) |
| Pitch | **50°** down from horizontal (inside the plan's 48–52°) |
| Lens shift | Shift X **0**, Shift Y **−0.02** |
| Roll | none: the camera right vector is world +X |
| Clip | 1 … 600 units |

The distance is the width fit: the whole 700 mm mat plus its raised rim fits the
16:9 frame with **164.6 px** of margin on each side. The far rim is **16.3 px**
inside the top of the frame; the near rim is deliberately cropped **41.8 px**
below the bottom (the plan only requires the table *width* to fit, and a
gameplay view does not show the near rim). The player's standing hand sits
**73.5 px** above the bottom edge. Every tile is inside the frame.

**Shift Y sign.** Blender measures camera shift against the sensor width
(here 1920 px, not 1080) and its positive direction moves the image **down**:
`y = 1080/2 + shiftY × 1920 − focal·up/depth`. The plan asks for a *negative*
Shift Y; this rig sets **−0.02**, which raises the image 38.4 px. Without it the
far rim would be cut by 22 px; with it the board is framed as above. The
`project_point` in `bake_table_reference.py` and `scripts/table-camera.mjs` was
corrected to that convention in this task (it had only ever run with shift 0),
and `bake_table_reference.py` asserts it against Blender's own
`world_to_camera_view` on every rig bake (worst drift 0.0004 px).

### Lighting

| Element | Value |
| --- | --- |
| Key | one **AREA** light, 20 × 14 units (560 × 392 mm), at `(0, −2.5, 22)` — slightly forward of centre — aimed at the table centre, 9000 W, `#fff7ea` |
| Fill near | AREA 26 × 16 units at `(0, −26, 9)` aimed at `(0, 0, 0.5)`, 1400 W, `#cfe0ff`: the standing hand and the far wall's south faces |
| Fill left / right | AREA 14 × 14 units at `(∓22, −7, 11)`, 700 W each, `#dfe9ff`: the side walls' inner vertical faces and the bevels |
| Ambient | world `#3b4a5c` × **0.35** (lights the scene, writes no background with film transparent) |
| Contact occlusion | Cycles path-traced GI: soft contact shadows under every tile base and crevice darkening between neighbours. Cycles has no Eevee-style AO toggle; this is the "bake soft contact shadows" arm of the plan's step. |
| Render | CPU Cycles, **64 samples**, adaptive (threshold 0.02), OpenImageDenoise, AgX / "AgX - Medium High Contrast", exposure 0 |
| Film | **Film > Transparent**, room floor hidden: the published PNG is RGBA |

The rig reproduces the shipped shells' lit measurements: the blank pond face
measures **217.2** luma (`[219.8, 216.8, 213.1]`) against the shipped
`shell_flat_upright` face `[223, 220, 216]`, and the face-down wall back
`[12, 70, 160]` against the shipped `[3, 68, 165]`. `rig.json` also records the
light objects (type, size, location, aim, watts, colour, direction) so Task 3A
can export a `lighting` block that matches the actual scene.

### Acceptance, as numbers

`scripts/check-table-rig.mjs` recomputes these from the camera and the recorded
placements and then measures the rendered pixels (AGENTS.md §6: numbers, not
looks). The committed bake reports:

| Criterion | Measured |
| --- | --- |
| Side-wall inner vertical faces visible | 3.80 px wide (minimum over both runs); probe luma **121.0 / 118.6** against **69.1** felt |
| Runs converge above the frame | both inner-face lines meet the +Y vanishing point at `(960.0, −4265.4)`, **0.096 px** from it; the point is above the top edge |
| South hand centre straight-on | slot 06 inner side **0.34 px** (≤ 0.6 px) |
| Outer hand shows its inner thickness | slots 00 / 12: **3.81 px** (≥ 3 px), growing outward monotonically |
| No inward trapezoidal lean | every south-hand plate edge leans **outward** 0 … **2.27 px** (a 50° pitch cannot give parallel verticals; the plan's ceiling is 2.5 px) |
| Framing | rim margins 164.6 / 164.6 / 16.3 px (left / right / top); hand bottom 73.5 px; all 269 tiles inside |
| Lit face / blue back / hand face | **217.2** / blue−red **152.0** / **137.9** luma |
| Felt probe | `(0, 6, 0)` open felt, **69.1** luma |
| Film transparent | **26.8 %** transparent pixels, opaque table, corners alpha 0 |

### What still needs the user

The numbers say the geometry and exposure are what the plan asked for; only the
user can sign off the *look* (AGENTS.md §6). To review:

```bash
xdg-open tools/render/reference/rig-1x.png     # the committed RGBA reference
xdg-open tools/render/reference/rig.html       # the same image with the numbers
bash tools/render/bake-table-reference.sh --check
```

Questions only the user can answer: do the side-wall inner faces read as visible
sunlit slivers at 1920 × 1080, or are they too thin at 3.8 px? Is the 73.5 px
gap under the player's hand the right amount, or should the board sit lower
(more near-rim crop) or higher? Do the key/fill balance and the shadow softness
read as a parlour table, or does the near fill flatten the bevels?

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
