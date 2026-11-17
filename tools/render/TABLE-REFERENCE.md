# Whole-table 3D reference (calibration only)

A single Blender scene of the complete table and one locked perspective, used to
calibrate the opt-in 2.5D rendered view. **It is not a runtime asset and not a
dependency**: nothing under `frontend/public` is written by this pipeline, and the
Phase 4 compositor never reads it. The reference exists so a follow-up task can
replace one element family with a 2.5D piece and compare the hybrid against the
same physical table.

Status: geometry, camera and lighting are verified by scripted checks
(§ *Checks*). The **visual sign-off is the user's**, per `AGENTS.md` §6; no agent
has judged the renders by eye.

- Spec: `tools/render/table-reference-spec.json`
- Scene builder: `tools/render/bake_table_reference.py` (Blender 4.5.9)
- Publisher / checker: `tools/render/scripts/table-reference.mjs`,
  `tools/render/scripts/check-table-reference.mjs`
- Renders + manifest: `tools/render/reference/`

## Commands

```bash
bash tools/render/bake-table-reference.sh --dry-run   # build the scene, print the camera metrics
bash tools/render/bake-table-reference.sh --bake      # @2x master -> board + 17 crops + manifest + check
bash tools/render/bake-table-reference.sh --audition  # ortho / weak / physical boards at @1x
bash tools/render/bake-table-reference.sh --check     # spec + files + hashes + projection metrics; no Blender
```

`--bake` takes about 8 minutes on this 14-core box: one 5760 × 3600 CPU Cycles
render at 32 samples + OIDN, then a 2×2 box downsample to the @1x board and
integer crops from the same master. Blender is pinned to **4.5.9 LTS** at
`~/.local/opt/blender-4.5.9/blender` (or `BLENDER=...`); `--check` needs only
Node. An audition render is ~45 s per candidate at 720 px.

## Scene contents

1 unit = the 28 mm tile height (the same scale as `shell-spec.json`); 1 = 0.75
wide, 0.58929 thick. The human sits at −Y, +Z is up.

| Element | Plan | Tiles |
| --- | --- | --- |
| four wall runs | ring radius 7.0, 17 touching stacks × 0.75 pitch, 1.0 deep, two tiers, every tile face-down (blue up) | 136 |
| four ponds | 6 × 3 filled rows at radii 4.6 / 3.6 / 2.6; row 0 is nearest that player | 72 |
| four concealed hands | 13 standing tiles, blue back to the table centre, at radius 10.6 | 52 |
| human drawn tile | standing, +5.5125 after the row (the compositor's +0.35 advance gap) | 1 |
| four open melds | 3 tiles at radius 5.4, seat's right; two upright + the called tile sideways | 12 |
| felt | one flat cloth plane at z = 0 (`#1a5038`) | — |

Total **273 tiles**. The scene is a visual calibration target, not a legal game
state: glyphs come from a seeded shuffle and may repeat more than four times.

Tile bodies are built by the shell baker's own `build_tile` (same proportions,
same 0.055 / 6-segment bevel, same one-material white/blue gate), so the
reference body cannot drift from the shipped shells. The face glyph is the same
perspective-neutral PNG the runtime atlas uses, composited on a thin transparent
plane 0.0006 units above the white plate inside the bevel — *not* the carved
decal. 5z (haku) has zero ink and gets no plane; it is the bare lighting sample.

## The locked camera

| Property | Value |
| --- | --- |
| Mode | perspective (weak), no roll, no shift |
| Target | (0, 0, 0.35) |
| Eye | (0, −86.082565, 86.432565) |
| Elevation | **45.0°** |
| Lens / sensor | 140 mm / 36 mm, horizontal fit |
| Distance to target | 121.7391 units |
| Pixels per unit at the target | 92.0 @1x |
| Frames | **2880 × 1800 @1x**, 5760 × 3600 @2x master |
| Lighting | sun 6.6 W/m², 12° angular size, az 315° / el 55° (screen-space top-left), + `#3b4a5c` world at 1.0 |

Why this is 2.5D-compatible, in numbers (all recomputed by the checker from the
recorded placements):

| Measure | Value | Reading |
| --- | --- | --- |
| projected pond tile body (4 seats) | **106.2 / 94.8 / 100.7 / 94.3 px** | centre tiles sit next to the compositor's 104 px @1x shells |
| near/far scale spread | **1.125×** | a weak perspective: the four edges read as one table, not four stamps |
| front / back run length | 1220.1 / 1125.0 px (**1.085×**) | the near wall is 8.5 % longer; orthographic would be 1.000×, the physical eye 1.34× |
| left / right run length | 1220.1 / 1125.0 px (**1.085×**) | true mirror of the near/far pair |
| run angle error | **0.00°** on all four | level camera, no roll; the wall lines are horizontal/vertical |
| bottom / top hand size | **0.999×** | the standing hands read at the same size |
| outer front-wall lateral reveal | **4.34°** | each zone still shows a real side face |
| frame margin | **98.9 px** minimum (@1x) | the whole table plus felt fits with air |
| pinhole vs Blender | **0.0016 px** | the recorded camera is the rendered camera |

The elevation is **45°** because that is the level at which the two-tier wall
cannot swallow the near pond row: the pond outer edge is at 5.1, the wall inner
edge at 6.5 (clearance 1.4 units), the wall is 1.179 units tall, and
`tan 45° × 1.4 = 1.4 > 1.179`. At 33.7° the wall hides the near rows. The bake
proves it with **1,025 ray probes on every visible surface** (279 tiles minus the
68 legitimately covered lower wall tiers, 5 probes each): **0 occluded**. The
checker re-derives the clearance inequality from the spec, so a plan edit that
reintroduces the occlusion fails without Blender.

45° is also the elevation the pond and wall shells are baked at, which is why a
centre pond tile lands at ~100 px — the same size class as the 104 px @1x shell.
The compositor deliberately presents a stronger per-zone fan (its front outer
wall slot is 8.37°, derived from the physical eye at y = −47.8); that is a
presentation choice, not a reference error, and is what the per-zone comparison
records.

### Camera candidates

`--audition` renders all three at @1x under
`tools/render/build/reference/audition/`:

| Candidate | What it is | Why it is not the committed framing |
| --- | --- | --- |
| `ortho` | orthographic, 45°, 31.3043-unit width | zero lateral reveal: every zone becomes a flat stamp |
| **`weak`** (chosen) | 140 mm, 121.74 units, 45° | — |
| `physical` | 65 mm, 57.44 units, 45° (the retired v1 eye distance) | 1.34× near/far size spread; the near hand dominates the board |

Switching candidates is `--camera <name>` plus a `camera.chosen` edit; the
publisher refuses a master baked with a different candidate, and the manifest
records the candidate so a hybrid comparison can never mix framings silently.

## Renders and hashes

Committed under `tools/render/reference/`:

| File | Size | Notes |
| --- | --- | --- |
| `full-board-1x.png` | 2880 × 1800, 2,986,711 B | sha256 `cbe4129bfde92ae6989fa4cf3f830da3e77b5d0825f70bafe5724754b5141b62` |
| `crops-2x/*.png` (17) | 6,206,553 B total | one 2× crop per element family |
| `table-reference.json` | 145,567 B | camera (both scales), every tile placement, crop rects, metrics, hashes |
| `index.html` | — | static contact page for the renders |

Crops: `wall-front` 2522 × 352, `wall-back` 2328 × 331, `wall-left` /
`wall-right` 346 × 1871, `pond-bottom` 912 × 541, `pond-top` 876 × 508,
`pond-right` / `pond-left` 629 × 720, `hand-bottom` 1984 × 274, `hand-top`
1752 × 255, `hand-left` / `hand-right` 292 × 1457, `meld-bottom` 538 × 272,
`meld-right` 249 × 445, `meld-top` 509 × 256, `meld-left` 257 × 474,
`drawn-tile` 215 × 274. Every crop records its rect, tile ids, byte size and the
sha256 of its decoded RGB pixels in the manifest.

The committed set is **9,338,831 B**. Asset budgets are advisory during active
development (`AGENTS.md` §1c); this is a developer reference, not shipped art.

## Checks

`bash tools/render/bake-table-reference.sh --check` → **619 checks, 0 failures**:

- spec self-consistency (chosen candidate, both resolutions, all 17 families,
  the pond/wall clearance and elevation inequality);
- manifest camera equals the spec candidate resolved by the shared pinhole
  (`table-camera.mjs`), and the bake's pinhole matched Blender to 0.0016 px;
- every PNG exists, decodes as 8-bit RGB, has the declared dimensions and byte
  size, and its decoded-pixel sha256 matches the manifest;
- the full inventory and poses (136 wall tiles face-down in 17 two-tile stacks
  per run; 72 pond discards face-up; 52 standing concealed tiles + 1 drawn;
  12 meld tiles with exactly one called tile sideways per seat);
- every crop rect is exactly the projected family bounds + 28 px @2x, is inside
  the frame, and matches its file's pixels;
- every metric recomputes from the camera + placements and passes its threshold
  (scale spread ≤ 1.18, run ratio ≤ 1.22, run angle error ≤ 0.05°, pond tile
  88–116 px, margin ≥ 24 px);
- **lighting matches the shipped shells**: the bare 5z face measures
  **[221, 218, 214]** against `shell_flat_upright`'s recorded **[223, 220, 216]**;
  the face-down wall back measures **[1, 64, 159]** against
  `shell_wall_horizontal`'s **[3, 68, 165]** (tolerances 14 luma / 42 face
  channels / 55 blue channels).

## How a follow-up task uses it

1. Pick the family crop (`crops-2x/<family>-2x.png`) and the same family's
   composited 2.5D zone at the same scale; the @1x board is 2880 × 1800 and a
   centre pond tile is ~100 px, so a composited zone scaled 2× is close to the
   crop.
2. Compare body geometry first (silhouette, projected thickness, side reveal,
   bevel), then the glyph read, then the shadow direction. The reference's
   shadows are physical Cycles shadows from the top-left sun; the compositor's
   are the synthetic down-right blob. Shadow shape is a deliberate 2.5D
   shortcut, not a defect to match.
3. To replace one family, change the spec/plan **and re-bake**; never hand-edit a
   render. The manifest's hashes make drift visible.

## Known limits

- No dora indicators, no rails/compass/apron geometry, no felt vignette: the
  task's scene list plus one felt plane. The runtime's compass, rails and
  full-screen felt raster are compositor concerns.
- The tile multiset is not legal (a full pond + full wall + hands would need
  more than 136 tiles); faces are seeded for visual variety.
- Glyphs are the flat 2D masters on a plane, not carved/embossed paint; the
  reference is about the shell silhouette and the glyph's read, not the decal
  carve.
- One camera cannot reproduce the compositor's four per-zone camera families.
  The reference is deliberately the *weakest* perspective that still reveals
  every zone, so the divergence from the stronger compositor fans is a recorded
  presentation decision, not an unexplained mismatch.
