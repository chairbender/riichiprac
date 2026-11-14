# Rendered Table Task 1.5: Parlor Strip-Light Rig

> **RETIRED 2026-11-13 — historical design record.**
> The full-scene pipeline this rig belonged to is superseded by
> [`2_5d_mahjong_tile_rendering_architecture.md`](2_5d_mahjong_tile_rendering_architecture.md).
> The new shell baker uses a locked top-left key plus a weak ambient fill, not
> this parlor rig. The numbers below are kept only so the old spike assets and
> reports remain traceable.

Status: **done** (command-center task 261113-1238). Kept as the design record
for the shipped rig; numbers and measured results are in
[`tools/render/README.md`](tools/render/README.md).

It ran before Tasks 2 and 3, because the rig is baked into every body sprite and
face decal and re-baking the full set later is expensive.

Parent design: [`rendered-table-plan.md`](rendered-table-plan.md). Task 1 assets
and the tuner live in [`tools/render/`](tools/render/README.md).

## 1. Why

Task 1 ends with a single huge 26 × 20 area key. That is a studio softbox: it
produces a broad, soft sheen, and getting any visible edge out of it needed a
deep carve (0.24 mm), very wide fillets (spreads 0.92) and a 200 kW key whose
top edge sits at RGB(249), almost clipped. The fill is now roughly co-equal with
the key on the flat face.

The target is a **mahjong parlor**: bright linear fluorescents overhead,
mirrored in the glossy melamine. The signature is not a soft blob — it is
**long, narrow white streaks** running along the up-facing bevels and along the
lower wall of every engraved stroke. That is also the graphic "90s pre-rendered"
look, so the parlor read and the aesthetic agree here.

The reflection geometry is worth writing down because it explains Task 1's
tuning: for a surface normal tilted `θn` from the vertical face and a light at
elevation `θL`, the mirror direction sits at `2 θn`, so `θn = θL / 2`.

- A ceiling light (78°) reflects on the **lower wall** of the groove
  (`θn ≈ 39°`), just above the floor junction. That is the authentic parlor
  band the current rig produces.
- The floor junction itself (`θn → 0`) needs a light at the eye's height; only a
  frontal light (the fill) can do that. In a parlor that band is *bounce*, not a
  fixture, so it should be dim and low-contrast.

So Task 1.5 does not change where the highlight lands; it changes its **shape**
from a softbox blot into a fluorescent streak by making the sources long and
thin.

## 2. Goal and non-goals

Goals:

- a rig of 2–4 elongated area lights ("tubes") that reads as parlor fluorescents;
- visible long specular streaks on the bevels and inside the engraving, at the
  shipped 2× size;
- no clipping, key-dominant balance, deep carve rolled back toward a physical
  0.1–0.15 mm;
- the whole rig exposed in the tuner, including the strip length/width/roll, and
  a one-click comparison against the Task 1 studio rig.

Non-goals:

- no runtime change; the decal/body split and the manifest are untouched;
- no HDRI or external asset — area lights only, so the pipeline stays offline and
  deterministic;
- the baked highlight pass (Task 1 option A) is **not** taken; strips are the
  chosen approach.

## 3. What a strip light buys us

The visible specular footprint is the source shape projected through the
fillet's normal sweep.

- **Length** (along the stroke) sets how long the streak is. A tube is long, so
  the streak runs along the bevel/fillet like a real reflection.
- **Width** sets the streak's cross-section. At ~2.5 units (≈70 mm at tile scale)
  and ~55 units away it subtends ~2.6°, so the streak is narrow and graphic
  rather than a blob.
- **Roll** (the tube's long-axis azimuth) changes which strokes catch it. A few
  tubes at different roll/positions give several passing streaks, like a ceiling
  of separate fixtures.
- **Count** gives the parlor's characteristic multiple highlights and soft
  multi-shadow contact.

Scale reminder: 1 world unit = 28 mm (tile height). A 1.2 m tube is ~43 units;
the current key is 56 units away, so the ceiling is ~1.6 m above the table. A
starting tube is 40 × 2.5 units.

## 4. Spec and code changes

The existing light schema already has `size` and `sizeY`; a strip is just a very
elongated `RECTANGLE` area light, so the schema only needs:

- a `rollDeg` per light (default 0): after `aim()`, rotate the light around its
  local Z so the rectangle's long axis can point along the table's X or Y. This
  is the only `build_lights` change.
- an optional `group` tag (`tube` / `bounce` / `rim`) so the tuner can address
  tube[i] generically and the manifest can record the rig without positional
  assumptions.

Recommended shape in `scene-spec.json`:

```json
"lights": [
  { "id": "tube-0", "group": "tube", "target": [0, 0.6, 0],
    "azimuthDeg": 0, "elevationDeg": 78, "distance": 56,
    "size": 40, "sizeY": 2.5, "rollDeg": 0,
    "energyW": 90000, "hex": "#fdf9f1" },
  { "id": "tube-1", "group": "tube", "target": [-2, 4.0, 0], ... },
  { "id": "tube-2", "group": "tube", "target": [2, 2.5, 0], ... },
  { "id": "bounce", "group": "bounce", "target": [0, -1, 0.3],
    "azimuthDeg": 30, "elevationDeg": 10, "distance": 34,
    "size": 42, "sizeY": 27, "energyW": 5000, "hex": "#cfe4d3" },
  { "id": "rim", "group": "rim", ... }
]
```

`build_and_render.py` changes are small: read `rollDeg` and rotate after aiming,
keep everything else. No new render pass, no compositor work. Render cost rises
only because there are more lights (a few percent).

## 5. Starting rig and tuner controls

Starting values (to be tuned in the tuner, not gospel):

- 3 tubes, elevation 78°, azimuth 0°, distance 56 units, length 40, width 2.5,
  ~90 kW each, targets spread along Y so the tubes are offset across the table;
- **bounce fill**: 30° / 10°, 34 units, ~5 kW, slightly green (`#cfe4d3`) to
  read as felt/room bounce rather than a studio fill;
- **rim**: keep one rear strip (170° / 45°) or drop it once the tubes separate
  the tile from the felt;
- ambient 0.5.

Tuner additions (`tools/render/tune.mjs` + `tune.html`):

- a **Rig preset** switch: `Task 1 studio` vs `Parlor strips`;
- tube controls: **count** (2–4), length (10–60 units, shown in mm), width
  (1–8), elevation, roll, power;
- keep the existing key/fill/ambient controls for the studio preset;
- the compass should draw every tube as a short bar (not just an arrow), so roll
  is visible;
- keep the full-tile preview as the default when tuning lights.

## 6. Re-tuning the carve

With a defined streak, the fillet no longer has to carry the highlight on its
own. Target after strips:

- depth back toward `0.006–0.009` of thickness (0.1–0.15 mm);
- transition `0.20–0.35 mm`, spreads `0.5–0.8`;
- paint gloss stays low (roughness ≈ 0.16) so the streak is white rather than
  pink;
- check the top edge stays below ~250 after the rig change.

The goal is that the parlor streak survives at 2× even with a shallow, physically
plausible engraving.

## 7. Acceptance

- The contact sheet shows at least two distinct long streaks on the body bevels
  and the decal's fillets at the shipped 2× size.
- The tuner changes the streak length/width/roll live; a "studio vs parlor"
  comparison is possible without editing the spec.
- No channel clipping on the top edge or the paint; the decal/body seam stays
  invisible (re-check the seam zoom).
- The full spike regenerates in one command; the render stays deterministic.
- `tools/render/README.md` records the rig, the `θn = θL / 2` reasoning, the
  strip numbers and the "parlor vs studio" presets.
- Decal bake time within ~10% of Task 1 at the same quality settings.

## 8. Task chain placement

Insert between Task 1 and Tasks 2/3:

| Step | What | Why here |
| --- | --- | --- |
| Task 1 | body + decal spike, tuner, scene spec | done |
| **1.5 (this)** | parlor strip rig, tuner strip controls, carve re-tune | the rig is baked into every body and decal; do it once, before the bulk bakes |
| Task 2 | hand slots, table, manifest | uses the final rig |
| Task 3 | 38 codes × 5 orientations | uses the final rig; the tube streaks are baked per orientation |

No new command-center ID yet; create one when this is scheduled.

## 9. Outcome (what shipped)

Recorded after the bake so the plan matches the assets; full detail is in
[`tools/render/README.md`](tools/render/README.md).

- **Rig**: `parlor` = `tube-0` (az 0 / elev 50 / 85 kW), `tube-1` (az 90 /
  elev 58 / 65 kW), `bounce` (az 30 / elev 10 / 2.5 kW, `#cfe4d3`), `rim`
  (az 170 / elev 45 / 6 kW), ambient 0.4. `tube-2`/`tube-3` ship disabled; the
  spec carries four so the tuner's count control never invents numbers. Sizes
  are 40 × 2.5 units (1120 × 70 mm) at a 56-unit throw.
- **Studio preset**: Task 1's rig is kept verbatim under `lightPresets.studio`.
- **Carve**: 0.0121 of thickness (0.20 mm) over a 0.30 mm transition, spreads
  0.6 / 0.8, blur 0.12 mm. That is deeper than the 0.1–0.15 mm this plan asked
  for: the streak was tuned visually and the chosen look wants the wall a little
  deeper. Not the plan's fallback (a silently deepened carve) — it is recorded
  here instead.
- **Measured**: body peak 250/255, decal peak 242/255, no clipped pixels; the
  decal bake is ~67 s at 256 samples, *faster* than Task 1's ~82 s; the seam is
  still invisible at 2×; the render is still seeded and deterministic.
- **The sparkle**: the 1:1 review composite point-samples the decal, so the
  sub-pixel fillet highlight shows as bright dashes. Kept on purpose until the
  final display resolution is settled; `decals.compositeSupersample` opts into a
  box filter. See the README's composite-sampling section.
- **Tuner**: rig preset switch, tube count, per-tube azimuth/elevation/roll/
  offset/length/width/power, bounce power, one rim per rig, plus the existing
  carve controls. The compass draws each tube as a rotated bar.

## 9b. Risks and fallbacks

- **Busy lighting.** Several tubes mean several highlights and softer, more
  complex shadows. If it reads cluttered, reduce to two tubes or shorten them.
- **Restricted streak direction.** Roll makes the streak follow the tube; a
  single tube only lights strokes whose fillet normals align. That is authentic,
  but if it looks too directional, add a second tube at a different roll.
- **Decal vs body position dependence.** The decal is baked at the canonical
  upright rig, so its streak is position-independent; the body's bevel streaks
  are per slot. With long tubes the streak is close to uniform across the hand
  row, so the seam tolerance should hold — verify at the hand row ends.
- **Top-edge clipping.** More lights can push the ivory over 250; watch the
  measured body values.
- **Aesthetic drift.** If the parlor rig loses the crisp 90s look, the fallback
  is a single long tube plus the baked highlight pass (Task 1 option A); do not
  silently deepen the carve again.
