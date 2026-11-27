# 3D table renderer: architecture record (as built)

Status: implemented; this record written 2026-11-27 (task 261118-142131, plan
unit **3D-16**). It describes the renderer that ships in `frontend/src/renderers/`
and the assets under `frontend/public/table/relief3d/`. The plan that ordered the
work, with each unit's as-built note, is
[`3d_renderer_implementation_plan.md`](3d_renderer_implementation_plan.md); the
floating HUD's composition contract is [`3d_hud.md`](3d_hud.md). Where this record
and a source file disagree, the source file wins (and this record is wrong).

This is a reference document, not a task list. It answers: how the view mounts,
what the numbers are, which assets carry which channel, how to measure the
result, and what is deliberately not done.

---

## 1. What the 3D view is

A full-window three.js table with carved tile faces, floating HTML chrome, and a
DOM interaction layer. It is one of three renderings of the same hand:

| View | What it is |
| --- | --- |
| **3D** (default) | The real-time three.js table. It takes the whole browser window; the status cards, action rail, hand dock and compass float over it as a HUD. |
| Stacked | Four player rows in turn order, human row above the docked hand. Also the accessible fallback when 3D cannot run. |
| Top-down | A flat 2D plan of the table, one edge per seat, compass in the middle. |

The planned fourth view (the 2.5D "rendered" table) never landed and its pipeline
was retired on 2026-11-19 (`docs/2_5d-removal.md`). The view list is therefore
**three** views, not the plan's four; the README and `AGENTS.md` §4 now state
three explicitly.

`?renderer=3d` still forces the 3D table for review links. The player's choice is
stored under `riichiprac.table-view` (its own key, not the settings blob), and 3D
is the default for a browser with no stored choice. A browser without WebGL2 draws
the stacked table and says why, without rewriting the stored choice.

---

## 2. Runtime topology

```
GameState (Rust -> serde -> JSON, immutable)
  └─ snapshotFromGameState()            renderers/snapshot.ts   (pure)
       └─ TableSnapshot                 renderers/contract.ts   (the one input)
            ├─ RendererHost             renderers/RendererHost.tsx
            │    ├─ dynamic import('./three')  -> Scene.ts      (lazy chunk)
            │    └─ overlay.tsx         projected hand/draw buttons + compass (DOM)
            └─ HudLayer                 renderers/hud/*        (mounted by App)
```

`HudLayer` is mounted by `App` and receives store props; it does not read the
snapshot or call the renderer. Its anchors come from `RendererHost`, published as
numbers.

Four rules hold the design together:

1. **One snapshot, many renderers.** The adapter is renderer-agnostic; replacing
   three.js changes nothing upstream of `contract.ts`.
2. **The canvas draws pictures; the DOM carries meaning and input.** Hand and
   drawn tiles are real `<button>`s positioned over the canvas from projected OBBs.
3. **The renderer is a child of React.** It mounts into the stage's div; switching
   views is an unmount, and `dispose()` is the only teardown path. Only one table
   is mounted at a time, so a stale atlas set never sits alongside a live one.
4. **On-demand frames.** With no animation and no perf HUD, the scene draws when
   the snapshot, tier, size or hover changes. Continuous rendering happens only
   during a deal-in/answered move or while `?perf=1` is open.

The stage is the window. The 3D canvas is a fixed, full-window layer at the
bottom of the Z ladder; no UI panel sits above or below it in document flow.
`HudLayer` is `position: fixed; inset: 0; pointer-events: none` and only its
controls take pointer events, so the canvas is never resized by chrome.

### 2.1 Module map

| Path | Owns |
| --- | --- |
| `renderers/contract.ts` | `TableSnapshot`, `TableRenderer`, events, capabilities, tiers, stats. The face vocabulary (`TileFaceId`) is owned here, not imported from the 2D views. |
| `renderers/snapshot.ts` | `GameState -> TableSnapshot`. Sorts hands into display order; carries the answered/highlight flags. |
| `renderers/capabilities.ts` | WebGL2 probe, backing-store cap, tier resolution and records, debug/query parsing, mobile layout profile. |
| `renderers/layoutConstants.ts` | The committed table, tile, wall, pond, hand, meld, camera and light constants. Pure data. |
| `renderers/RendererHost.tsx` | Lazy import, lifecycle, fallback, session degrade, overlay mount, debug/perf HUD. |
| `renderers/overlay.tsx` | Projected hand/draw buttons and the compass (the a11y surface). |
| `renderers/answerPresentation.ts` | The post-answer board delta (presentation only; §3). |
| `renderers/answeredBoard.ts` | Applies that delta to the decision snapshot, with tile `uid`s. |
| `renderers/wall.ts` | The one wall model: 122 live + 14 dead slots from `tilesRemaining`. |
| `renderers/hud/*` | The floating layer: `HudLayer`, `hudLayout`, `Sheet`, `ActionRail`, `HandRail`, `ResultCard`, `SetupSheet`, `VerdictSheet`, tokens. |
| `renderers/three/index.ts` | The lazy entry: `createRenderer(canvas, options)`. |
| `renderers/three/Scene.ts` | Renderer, resize/backing store, on-demand loop, draw plan, dispose registry, `measure()`. |
| `renderers/three/boardLayout.ts` | `TableSnapshot -> PlacedTile[]` and `frameForAspect` (the only camera solve). |
| `renderers/three/cameraRig.ts` | A thin `PerspectiveCamera` adapter and pure projection helpers. It does not solve framing. |
| `renderers/three/tileGeometry.ts` | The beveled tile body, face-plate UVs and tangents. |
| `renderers/three/tileMaterial.ts` | The `ShaderMaterial`, carve/POM/self-shadow uniforms and per-tier step counts. |
| `renderers/three/reliefAssets.ts` | Manifest validation, atlas pins, tier upload settings, procedural fallback. |
| `renderers/three/boardMesh.ts` | One `InstancedMesh` for the whole board, plus flags. |
| `renderers/three/{shadows,sticks,felt,compassPlate}.ts` | Contact shadows, riichi sticks, felt, physical compass plate. |
| `renderers/three/{hitTest,motion,perf,probes,carveReport,seamProbe}.ts` | Projection hittest, deal-in/answered motion, frame stats, calibration probes. |
| `renderers/three/materials/tile.{vert,frag}.ts` | GLSL as TS template strings (no loader rule, testable source contracts). |

---

## 3. State, revision and motion

`GameState` is replaced only on a deal, import or scenario load. There is no
discard/draw event stream and no replay playback, so in the current app every
state change is a new position.

- The host increments `TableSnapshot.revision` on every new `GameState`. **A new
  revision is a cut, never a move:** no tile flight, at most a bounded deal-in.
- `shouldDealIn(previous, next)` is the whole diff rule: a different revision is a
  cut; a repeated revision is the same position with new flags and starts
  nothing; the first snapshot starts nothing.
- **The deal-in** is one uniform lift of `TILE.heightUnits / 2` (14 mm) settling to
  zero over `DEAL_IN_MS = 400` with a cubic ease-out. It is upward-only, exactly
  zero at the bound, and the frame loop stops when it settles.
- **Reduced motion:** the deal-in and the answered move are suppressed. The
  hover/focus lift is *not*: it is a discrete pose change, and it applies under
  every motion preference.
- **`playEvents()` is reserved and a no-op in v1.** The event type and its tests
  exist for a future live/replay source; nothing calls it.
- **The answered board is a presentation-only exception** (task 261121-1206): after
  an answer, the 3D board shows the resulting discard/call with a spring flight of
  `ANSWER_MOVE_MS = 340` (inside the 400 ms budget). The Rust engine and the
  store's `gameState` are untouched, Reset returns the pre-answer board, and the
  2D views still draw the decision position. This is the only place a
  same-`revision` snapshot changes pose.

---

## 4. World, numbers

All lengths are tile units: **1 unit = 28 mm**, the tile height. Three world is
+X right, +Y up, +Z toward the human; the retired Blender reference is Z-up with
`(x, y, z)three = (x, z, -y)blender`.

| Quantity | As built | Source |
| --- | --- | --- |
| Tile body | 21 × 28 × 16.5 mm (`widthUnits` 0.75, `heightUnits` 1, `thicknessUnits` 0.5893) | `layoutConstants.TILE`, `TILE_MM` |
| Bevel | 0.055 units = 1.54 mm; no separate groove constant | `TILE.bevelUnits` |
| Face plate | 17.92 × 24.92 mm (0.64 × 0.89 units), inset by the bevel | `TILE.facePlate*`, `RELIEF_PLATE_UNITS` |
| Triangles per tile | 480 (budget 600) | `tileGeometry.ts` |
| Mat | 25 units = 700 mm square, no rails/aprons/room | `TABLE.matSizeUnits` |
| Wall | 4 runs × 17 stacks × 2 tiers; **122 live + 14 dead**; 0.75 pitch | `WALL` |
| Dead wall | The far run's intact 7 × 2 block, nudged 0.3 units (8.4 mm) clear of the live wall | `WALL`, `wall.ts` |
| Live wall | The contiguous arc suffix implied by `GameState.tiles_remaining`, depleted top tier first | `renderers/wall.ts` |
| Ponds | 3 rows × 6, nearest row at 4.81, then 3.81 and 2.81; 4 overflow anchors | `POND` |
| Human hand | 13 tiles + draw slot at +5.5125, reclined **40°** about its far bottom edge; accepted 30–45° | `HAND` |
| Hand row (screen) | 66.7 % of the stage width; on the 2 % bottom edge | `HAND`/`hudLayout` |
| Compass plate | Physical square on the felt, sized to touch the innermost discard row; overlay text is DOM | `COMPASS_PLATE`, `three/compassPlate.ts` |
| Sticks | Real 65 × 7 × 3.5 mm elliptical bar at **72 %** model scale (46.8 mm), one per declarer, inboard of the score row | `STICK`, `sticks.ts` |
| Mobile board | Applied only to a coarse pointer with stage short side ≤ 500 px: smaller plate, end ponds in, side ponds out, left row shifted a tile width | `capabilities.layoutProfileFor` |

### 4.1 Camera

There is exactly one projection source: `boardLayout.frameForAspect`. It solves
eye distance and a lens shift against the real board extents per aspect.
`cameraRig.ts` only copies the solved frame into a `PerspectiveCamera`
(`projectionMatrix[9]` carries the shift).

| Constant | Value |
| --- | --- |
| Lens / sensor | 75 mm on a 36 mm horizontal gauge |
| Pitch | 50°; portrait preset **62°** below aspect 1 |
| X / target / shift | X = 0; target (0, 0.35, 0); Shift Y = -0.02 |
| Reference distance (76 units) | **Removed.** The distance is solved; 16:9 lands at **50.257** units. |
| Supported aspects | 21:9, 16:9, 3:2, 4:3, 1:1, 3:4, 9:16 |
| Safe-area margin | 2 % of the frame, every tile |
| Hand face-to-view angle | ≤ 25° at every aspect |

The current `check-3d-layout.mjs` framing table (run 2026-11-27):

```
aspect  pitch  distance   mat X    mat Y   tiles  hand long  hand bottom  face/view  strict ray
 2.333   50°    65.68     5.04%  -30.60%   2.00%    7.76%       2.00%      10.0°      15.9°
 1.778   50°    50.26   -11.29%  -32.63%   2.00%    7.89%       2.00%      10.0°      18.1°
 1.500   50°    42.57   -24.81%  -34.31%   2.00%    7.98%       2.00%      10.0°      19.8°
 1.333   50°    42.02   -26.03%  -26.82%   2.00%    7.20%       6.04%      10.0°      19.9°
 1.000   50°    42.02   -26.03%   -7.61%   2.00%    5.40%      17.03%      10.0°      19.9°
 0.750   62°    41.21   -23.04%    2.41%   2.00%    3.59%      21.72%      22.0°      32.6°
 0.563   62°    41.21   -23.04%   14.31%   2.00%    2.69%      28.79%      22.0°      32.6°
```

The mat crops (negative margins) by design: the fit subject is the tiles, not the
700 mm mat. "Strict ray" is the hand's angle to the actual eye ray rather than the
idealised view axis; the gate uses the 25° figure.

---

## 5. The carved face

### 5.1 Asset channel table

Three PNG atlases of **1536 × 2380** (a 6 × 7 grid of 256 × 340 cells; 37 used,
5 unused) are the runtime carve. Manifest: `frontend/public/table/relief3d.json`.
Pins are duplicated in `reliefAssets.ts` (`PINNED_RELIEF3D_ATLASES`) and checked at
load; a mismatch is the procedural fallback, not a guess.

| Atlas file | Role | Bytes | SHA-256 | Channels |
| --- | --- | --- | --- | --- |
| `relief3d/face_albedo.png` | `albedo` | 458,909 | `9bd5e4f0…02d7` | RGB = paint pigment; **A = paint mask** (0 bare tile, 1 painted). sRGB. |
| `relief3d/face_normal_depth.png` | `normalDepth` | 1,567,000 | `46ce116e…a154` | RGB = tangent normal, x right / y down / z out, 8-bit; **A = normalized height** (1 open face, 0 engraving floor). Linear. |
| `relief3d/face_ao_roughness.png` | `aoRoughness` | 972,171 | `43715ae7…60d3` | R = cavity AO; G = roughness; B unused; A 255. Linear. |

Cell grid: 14.29 px/mm across, 13.64 px/mm down; the plate maps [0, 1] onto the
cell's exact border. **Unused cells carry the open face**, never zeros:

- `normalDepth` (128, 128, 255, 255)
- `aoRoughness` (255, 115, 0, 255)
- `albedo` (255, 255, 255, 0)

That rule is what removed the black plate-edge hairline (task 261119-2029): a
bilinear or mip tap at a plate edge blends the neighbouring cell, and zeros there
decode to a degenerate normal at the deepest groove with AO 0.

### 5.2 Carve numbers

`frontend/tools/relief3d/bake-relief3d.mjs` (Node + `@napi-rs/canvas` for decode;
no Blender, no browser) bakes the atlases from the committed flat glyph masters
`frontend/public/table/faces/<id>.png` (300 × 400, public domain). It is
deterministic; `--check` re-derives and prints the pins and measured numbers.

| Number | Value |
| --- | --- |
| Engraving depth | **0.495 mm** |
| Wall transition | 0.3 mm Bézier, wall **inside** the painted silhouette |
| Blur | 0.12 mm (`blurUnits` 0.00429) |
| AO | horizon approximation, 1.4 mm, 8 directions × 10 steps |
| Roughness | open resin 0.45, lacquer paint 0.12 |
| White-fill rule | artwork white (all channels ≥ 90 % of white) stays uncarved bare tile |
| Baked faces | 37 (the `blank` face has no art) |

The albedo is sampled from the glyph masters, not derived from the carve
geometry, so a carve-profile change only moves the normal/height and
AO/roughness channels; the paint colour and mask are geometry-independent.
Nothing hand-edits an atlas.

The glyph masters' producer is `tools/render/` (`npm run check:faces`): 37
symbol-only SVGs pinned at `SakaiTaka23/riichi-mahjong-tiles` commit
`f37d6cc2557498d23f13eb3e955e0e44e5c863ff`, CC0, rasterised by a pinned
`@resvg/resvg-js` 2.6.2. That directory is retained solely because the 3D bake
reads its output; the rest of the 2.5D tooling is gone.

### 5.3 Runtime shading

- The plate is a height-field carve: tiered parallax occlusion (POM) displacement,
  sampled tangent normal, AO multiply, one GGX lobe from the sampled roughness,
  wrapped diffuse for resin translucency, plus the shell's coat lobe.
- **POM displacement is scaled, not physical.** `CARVE_DEPTH_MM = 0.55` is the
  calibrated integration depth (the committed carve is 0.495 mm, so the constant
  is the ~11 % conservative end); `POM_HEIGHT_SCALE = 0.25` scales the
  *displacement* so a stroke's silhouette does not slide, matching the approved
  decals' shading-only look. 0 is "POM off" (decal-equivalent); the hero depth
  sweep `[0, 0.25, 0.5, 1]` is how the value was chosen.
- The parallax budget is **8 atlas texels** (`POM_MAX_TEXELS`); the loop bound is
  32, the live count is the tier's.
- The light-space **self-shadow** multiplies the key alone (not fill/ambient), with
  strength 0.45, bias 0.02 (0.011 mm), softness 0.35 (0.19 mm) and a 6-texel
  reach, inside the 8-texel gate. `compat` and `?debug=shadow-off` skip it.
- Body materials are the signed-off shell kit, not invented: ivory `#f5f0eb`
  roughness 0.16 + coat 0.4; back `#132986` roughness 0.18 + coat 0.35, coat
  roughness 0.1; the ivory/blue split is a Z gate at 0.3 of the thickness.
- One key light at azimuth 315°, elevation 55°, colour `#fff7ea`; a low
  hemisphere fill and a very weak ambient. No environment map, IBL, shadow maps or
  post-processing. `outputColorSpace = SRGBColorSpace`,
  `toneMapping = NoToneMapping`.
- **MSAA is on above `compat`** (4×), because the 0.055-unit bevel and the 1.5 mm
  bevel valley are 1–4 px at the reference solve. MSAA is buffers, not shader
  work: at the 8.29 MP cap it is +174 MB of colour/depth samples, not four POM
  marches. `compat` asks for `antialias: false`.
- The debug modes are `albedo`, `height`, `normal`, `steps`, `flags`, `shadow`,
  `pom-off`, `shadow-off`, `wireframe`, `hero`, all via `?debug=`.

---

## 6. Render plan, budget and tiers

### 6.1 Draws and geometry

The whole board is one `InstancedMesh`; the scene's steady plan is **five
draws** (felt, contact shadows, tiles, sticks, compass plate) against a hard
ceiling of 12 including debug views. Tile count does not change the draw count.
Capacity is `BOARD_TILE_CAPACITY = 320` instances; a snapshot that would exceed it
throws rather than dropping tiles.

Measured by `check-3d-layout.mjs` (2026-11-27): the fixture board is **203
tiles / 395 touching pairs**, 0 slots and 0 interpenetrations; the widest board it
builds is **231 tiles / 443 pairs**, also 0 slots/overlaps. `check-3d-budget.mjs`
counts 480 triangles and 282 vertices per tile, 97,440 triangles for the fixture
board's 203 tiles (its 4 sticks are separate instances) and 110,880 for the
widest board; a full-capacity board is 320 × 480 = **153,600 triangles** against
the 200 k ceiling (192,000 budgeted).

### 6.2 Atlas GPU bytes

| Tier | Upload | Anisotropy | Mipmaps | Atlas GPU |
| --- | --- | --- | --- | --- |
| high | 1536 × 2380 | 8 | yes | **58,490,880 B** |
| balanced | 1536 × 2380 | 4 | yes | **58,490,880 B** |
| compat | 768 × 1190 | 2 | yes | **14,622,720 B** |

A tier change within the same upload scale must not re-decode the atlases; only a
scale change (`compat` ↔ the others) reloads them.

### 6.3 Tier table

| Tier | DPR cap | Backing store | POM steps | Shadow steps | MSAA | Target |
| --- | --- | --- | --- | --- | --- | --- |
| high | 2.0 | ≤ 8.29 MP | 12 | 4 | 4× | 60 fps |
| balanced | 1.5 | ≤ 4.67 MP | 8 | 2 | 4× | 60 fps |
| compat | 1.0 | ≤ 2.07 MP | 0 | 0 | off | 30 fps floor |

The backing-store ratio is `min(dpr, tier cap)` then reduced by the area budget; it
may fall **below 1** on a CSS viewport larger than the budget (a 5120 × 2880 stage
lands near 0.75 at `high` rather than 14.75 MP). Floor: 0.1.

**As built, the app always mounts `high`:** `FORCED_QUALITY_TIER = 'high'` (user
decision 2026-11-21, "high looked right on a phone and held its frame budget").
The URL > stored > auto machinery is kept and tested for a future quality
selector, but nothing reaches it. The automatic choice, if it were enabled, is:
`compat` for a coarse pointer or a viewport under 900 × 600; `high` for a viewport
at least 1280 × 720 with both hardware hints ≥ 8 GB and ≥ 8 cores; `balanced`
otherwise.

The frame-time monitor is likewise **off** (`FRAME_MONITOR_ENABLED = false`): the
25 ms downgrade / 33 ms terminal degrade, 2 s sustain, EMA 0.2 and 250 ms
credibility cap are kept, tested, and not acted on. The `?perf=1` HUD still samples
real frames every 250 ms. Context loss and a session degrade record still return
the user to the stored 2D view with a notice.

`measure()` reports tier, draw calls, triangles, instances, atlas bytes, backing
store/DPR, frame p50/p95 and sample count.

### 6.4 Bundle

three.js is reachable only through `RendererHost`'s dynamic `import('./three')`.
`check-3d-budget.mjs` asserts the entry reaches one lazy chunk by `import(…)`,
`index.html` neither loads nor preloads it, and the `three` marker appears in no
other chunk. Measured on this landing build (2026-11-27):

```
entry index-*.js:        752,184 B raw, gzip 141,525 B
3D chunk three-*.js:     671,559 B raw, gzip 181,273 B  (advisory 200,000 B)
```

Going over the advisory only prints a warning; the gate's exit code does not
depend on it. Re-run the script on the landing build rather than trusting a
transcription.

---

## 7. Interaction, accessibility and the HUD

- Hand and drawn tile are absolutely positioned `<button>`s over the canvas, sized
  from the projected OBB with a **44 × 44 CSS px minimum**, labelled exactly as the
  2D hand dock's tiles, disabled when answered, in the same order.
- Hover/focus lifts the tile by half a tile height (14 mm) and never moves the
  button. The lift is the only hover cue (the tint was removed 2026-11-20);
  keyboard focus keeps `:focus-visible`.
- The compass is DOM text over a physical 3D plate: each seat one row with its
  wind and (split-plate) score, centre round and tiles left; accessible names match
  the top-down compass and a drift test compares them.
- The HUD is one fixed layer with one pure layout function (`hudLayout.ts`): no
  at-rest rect may come within **8 px** of the hand/draw band or the compass at any
  supported aspect. Z ladder is `canvas < scene overlay < HUD < sheet < toast`,
  from the tokens block.
- Sheets are modal, one at a time, focus-trapped, Escape closes, focus returns to
  the trigger, the scene is `inert`, the page does not scroll and the renderer is
  never unmounted. The full-screen toggle promotes the shell, so the HUD travels
  with the scene.
- `3d_hud.md` is binding on every HUD unit; `hudCss.test.ts` pins the tokens and
  the collapsed trigger geometry.

---

## 8. Measurement protocol

Everything here prints numbers. **No agent signs off a render or a look from its
own inspection** (`AGENTS.md` §6); visual judgement is the user's.

| What | Command | Notes |
| --- | --- | --- |
| Frontend gate | `cd frontend && npm test && npm run build && npm run lint` | Needs the WASM `pkg/` (see README). |
| Layout gate | `node frontend/scripts/check-3d-layout.mjs` | Dependency-free, no GPU, no browser. Counts, gaps, framing table, hand band, meld stability. |
| Budget gate | `cd frontend && npm run build && node scripts/check-3d-budget.mjs` | Atlas pins/bytes, GPU totals, triangle/draw ceilings, lazy chunk. Needs `dist/`. |
| Seam gate | `node frontend/scripts/check-3d-seams.mjs` | Launches Chrome; fails with `ENOENT` where no Chrome binary exists. |
| POM cost | `node frontend/scripts/check-3d-pom.mjs` | Launches Chrome; the per-tier step measurement. |
| Carve bake | `node frontend/tools/relief3d/bake-relief3d.mjs --check` | Re-derives the atlases, prints pins and measured carve numbers. |
| Glyph masters | `cd tools/render && npm run check:faces` | Manifest/hash/pixel checks over the 37 CC0 SVGs and PNGs. |
| Live numbers | `?renderer=3d&perf=1` | `?perf=1` HUD: tier, DPR, backing store, steps, draws, frame p50/p95, atlas MB. |
| Calibration | `?renderer=3d&debug=hero` | Four hero slots and the POM depth sweep; exports probes and capture sheets. |

The layout and budget scripts load the app's own TypeScript through the frontend's
Vite install, so run `npm ci` in `frontend/` first. The seam and POM scripts need a
real Chrome; in CI they are the deploy job's business, not a headless substitute.

When a gate is already red on the landing baseline for an environment reason,
record it and do not "fix" it inside an unrelated unit (plan §8).

---

## 9. Known limits and deliberate deviations

1. **Three views, not four.** The 2.5D "rendered" view and its pipeline were
   retired 2026-11-19; the fourth view never landed.
2. **`high` is the only mounted tier.** Tier resolution and auto-downgrade are
   implemented, tested and disabled by user decision (2026-11-21). The
   `?quality=` and `?perf=1` review paths remain.
3. **POM displacement is 25 % of the physical depth.** This is a look decision to
   match the approved decals; the physical 0.55 mm groove is still shaded in full
   by the normal/AO maps and the self-shadow.
4. **AO is a stated horizon approximation**, not a path-traced bake: 8 directions
   × 10 steps over 1.4 mm. The self-shadow is a light-space height-field march
   that darkens the key only.
5. **No environment map, IBL, shadow maps or post-processing.** Contact shadows
   are instanced quad blobs and the cast shadows are geometry/shape layers; the
   felt is procedural.
6. **The wall is decorative but state-driven.** It draws 122 live + 14 dead tiles
   and depletes the live arc by `tiles_remaining`; it is not a rules engine. The
   1000-point riichi pot is not drawn on the table (sticks are per declarer); the
   pot stays in the table information.
7. **The answered board is client-side presentation only.** No post-action
   `GameState` exists, so the engine's state is untouched; the 2D views keep the
   decision position.
8. **No live/replay animation.** `playEvents()` is a tested no-op; rigid-body
   draw/discard/flip motion waits for a live source.
9. **One table at a time.** The renderer dynamic import is mounted only for the 3D
   view; `dispose()` drops textures and the GL context on switch.
10. **Plate prose is stale in a retired file.** `tools/render/relief-spec.json`
    (retired 2026-11-19, commit `5adc785`; in git history) described the plate as
    20.89 mm, while its committed `plateUnits`/cell rects say **17.92 mm**. The 3D
    chain ships 17.92 mm (plan decision 6, no rebake) and its own manifest records
    the same. This note is information for whoever owns that retired file, not a
    request; nothing in the 3D chain waits on it.
11. **The 3D stage is not a modelled room.** No rails, floors, aprons or walls
    beyond the 25-unit mat, by design (`AGENTS.md` §4).

---

## 10. Licensing and provenance

The repository is **AGPL-3.0-or-later** because the shipped WASM evaluator is a
translation of AGPL-3.0 `libriichi`/Mortal v4 code and is served to users. The 3D
path adds no AGPL tool; its runtime dependency is three.js under MIT.

- `three` **0.187.0** (MIT), pinned exactly, no addons; `@types/three` 0.187.0.
- `@napi-rs/canvas` **1.1.1** (MIT) is a dev dependency of the offline bake only.
- `@resvg/resvg-js` **2.6.2** (MPL-2.0) is dev-only in `tools/render/`.
- Tile artwork: CC0 SVGs from `SakaiTaka23/riichi-mahjong-tiles` at the pinned
  commit; the committed PNG masters and atlases are bakes of those sources.

`THIRD_PARTY_NOTICES.md` carries the notices. No 3D asset is generated from a
third-party render or texture.

---

## 11. Where to look next

- [`3d_renderer_implementation_plan.md`](3d_renderer_implementation_plan.md) — the
  unit sequence, acceptance criteria, as-built notes, recorded decisions and the
  verification record.
- [`3d_hud.md`](3d_hud.md) — the floating layer's composition, overlay contract,
  collapse table and collision gate.
- [`docs/2_5d-removal.md`](docs/2_5d-removal.md) — what the retired 2.5D pipeline
  was and which pieces survive as 3D build inputs.
- [`docs/licensing.md`](docs/licensing.md),
  [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) — licences and provenance.
- `AGENTS.md` §3b, §3c, §4, §5 and §6 — the standing rules for the 3D chain.

---

## Appendix A — Landing gate record (2026-11-27, Windows)

This unit is docs-only. The gate was run on the landing tree and every 3D-owned
script was green:

| Check | Result |
| --- | --- |
| `node scripts/check-3d-layout.mjs` | PASS — all invariants, framing table, 0 slots/overlaps |
| `node scripts/check-3d-budget.mjs` | PASS — 5 draws, 153,600/200,000 tris at capacity, pins and chunk checks |
| `node frontend/tools/relief3d/bake-relief3d.mjs --check` | PASS — `relief3d check: ok`, depth 0.495 mm, atlases match pins, unused cells open-face |
| `npm run lint` | PASS |
| `npm test` | 1593 passed, 1 skipped **after** the environment workarounds below |
| `npm run build` | PASS **after** the environment workarounds below |
| `check-3d-seams.mjs` / `check-3d-pom.mjs` | Not run: they launch `google-chrome-stable`, which is absent on this machine (`ENOENT`). They are the deploy job's browser gates. |

Two **baseline environment** blockers exist on this Windows checkout; neither is
caused by this unit and neither was fixed here (plan §8: record, do not drive-by
fix an unrelated red gate):

1. **Case-insensitive filenames.** `frontend/src/renderers/hud/ActionRail.tsx`
   (the component) and `actionRail.ts` (its pure model) differ only in the case of
   one segment. On Windows, TypeScript (TS1149/TS2305), Rollup (the component
   import resolves to the model file) and Vitest all fail; on Linux CI the names
   are distinct and everything is green. The fix is a rename in a separate HUD
   task, not in this docs unit.
2. **Node 26 web storage.** Node 26 ships an experimental global
   `localStorage` that shadows jsdom's, so `window.localStorage` is `undefined`
   in Vitest unless the process runs with `--no-experimental-webstorage`. That is
   an environment flag, not a repo setting.

With a temporary, uncommitted rename of the model file plus
`NODE_OPTIONS=--no-experimental-webstorage`, the full suite and the production
build pass, and the budget numbers above are the script's own output. The
committed tree keeps the original filenames.
