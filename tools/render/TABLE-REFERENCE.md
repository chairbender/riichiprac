# Whole-table 3D model + slot anchors

A Blender model of the complete Riichi table and one named `Empty` for every
tile slot. It is a **development/calibration model**: nothing under
`frontend/public` is written and the runtime never reads it.

**Scope note (2026-11-17):** this task is the table model and the anchor bank.
The perspective and lighting are inherited from the earlier calibration
reference and are **not** tuned here; a separate Task 2 sets those up. The
render in this task exists so placement can be eyeballed, not for a lighting
sign-off.

- Scene + camera + anchor spec: [`table-reference-spec.json`](table-reference-spec.json)
- Blender generator: [`bake_table_reference.py`](bake_table_reference.py)
- Entry point: [`bake-table-reference.sh`](bake-table-reference.sh)
- Published model: [`reference/`](reference/) — board, element crops,
  `slot-anchors.json`, `table-reference.json`, contact page
- Integrity gate: [`scripts/check-table-reference.mjs`](scripts/check-table-reference.mjs)

## Commands

```bash
bash tools/render/bake-table-reference.sh --dry-run   # build + validate; print the model's metrics
bash tools/render/bake-table-reference.sh --bake      # render the @2x master, publish, check
bash tools/render/bake-table-reference.sh --check     # spec/anchors/clearance/files gate; no Blender
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

## Camera and lighting (inherited, not tuned here)

The renders use the reference's locked weak-perspective camera: 45° elevation,
140 mm / 36 mm, eye `(0, −86.0826, 86.4326)`, target `(0, 0, 0.35)`, 2880 × 2112
@1x from one 5760 × 4224 @2x master. The sun/ambient rig is the earlier
reference's. **Task 2 owns the perspective and lighting calibration**; do not
read this task's render as a lighting verdict. The camera exists to show the
placement and to keep the model in the same space as the previous reference.

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
