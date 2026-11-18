# 3D renderer implementation plan and task sequence

Status: planning, checked in 2026-11-18.
Task: 261118-1340 ("3D renderer: review the plan and break it into tasks").

This document turns the starting proposal
`3d_carved_tile_renderer_implementation_plan.md` (the reviewer's copy lives at
`/home/kylehipke/Downloads/`, is not committed, and is not authoritative) into a
reviewed architecture, an ordered unit sequence with acceptance criteria and
gates, and a proposed command-center slice. It is the build order, in the same
shape as [`replay-implementation-plan.md`](replay-implementation-plan.md) and
[`2_5d_implementation_plan.md`](2_5d_implementation_plan.md).

This is a **second, parallel** rendering effort. The 2.5D sprite pipeline
(`2_5d_mahjong_tile_rendering_architecture.md`, `2_5d_implementation_plan.md`,
`tools/render/*`, `frontend/src/table/*`) is owned by tasks 4, 4A, 5, 5A, 6, 6A,
6B and 7 and is not modified by any unit here. Where this plan needs something
from that pipeline it says so, and the 3D chain reads its committed assets
read-only.

**At a glance.** 16 implementation units plus one optional measurement spike.
The critical path to the first usable 3D view is 3D-01 → 3D-02 → 3D-03 →
3D-04 → 3D-05 → 3D-06 → 3D-07 → 3D-08 → 3D-14. Carving is built at 3D-05 (user
decision 4), so it is on that path; quality tiering, motion and the performance
harness are not, and full sign-off (3D-15) adds them. The 0-step kill switch
keeps the view renderable without carving even though POM is core.

| Wave | Units | What it buys |
| --- | --- | --- |
| 0 | 3D-01 | Snapshot contract, capability probe, feature gate |
| 1 | 3D-02, 3D-04, 3D-06 | Lazy three.js host, procedural tile mesh, world layout |
| 2 | 3D-03, 3D-05 | Relief asset bridge; a carved hero tile renders and is handed to the user |
| 3 | 3D-07, 3D-S1 | A full board renders in 1 instanced draw; real-hardware POM numbers recorded |
| 4 | 3D-08, 3D-09, 3D-10, 3D-12 | Accessible interaction, compass, carve calibration, motion |
| 5 | 3D-11, 3D-13 | Quality tiers and fallback; budget harness |
| 6 | 3D-14, 3D-15, 3D-16 | View switch, full-board sign-off, architecture record |

**v1 scope cut (the first usable checkpoint).** 3D-01…3D-09 plus 3D-14:
a static, carved, interactive, accessible 3D table reachable with
`?renderer=3d`, with no quality auto-downgrade and no motion. Everything after
that makes it calibrated, cheaper or safe to expose; **exposing it in the
persistent View control is 3D-15's decision**, not 3D-14's.

---

## 0. Scope and non-goals

**In scope**

- a true real-time 3D table rendered into a `<canvas>` in the browser, as an
  additional opt-in view beside the stacked, top-down and (when it lands) 2.5D
  rendered views. **It takes the whole browser window with no UI in the document
  flow around it**, and the app's UI is planned as a floating layer over the
  scene (user guidance, 2026-11-18; §9 decision 7), with an optional full-screen
  toggle;
- the same board information the top-down view shows: four seats with concealed
  hands, the human's drawn tile, four discard rivers, open melds, the wall,
  dora indicators, riichi declarations and sticks, wind/score/round compass;
- the human hand's discard interaction, keyboard and screen-reader support at
  parity with the top-down view;
- claimed-tile highlight and the answered/locked state;
- carved tile faces lit by one fixed key, with parallax occlusion mapping as a
  quality tier;
- a documented performance budget and a repeatable way to measure it.

**Non-goals**

- **Changing the Rust/WASM engine.** The 3D renderer consumes the existing
  serialized `GameState`. No new Rust field, type or export is required, and no
  cargo gate is allowed to change behaviour.
- **Touching the 2.5D pipeline.** No edits to `2_5d_*`, `tools/render/*` or
  `frontend/src/table/*`, and no unit waits on that chain. The 3D chain owns its
  own types and reads already-committed assets as immutable inputs; it never
  writes them.
- **Replacing the accessible views.** Stacked stays the default. 3D is opt-in,
  never auto-selected, and the stacked and top-down views remain the documented
  accessible fallback.
- **A live game loop.** The app has no in-hand transitions (see §2.3), so the
  animation system is a hover/lift and a bounded deal-in, plus an unused event
  seam for a future replay/live source.
- **A modelled table.** No rails, aprons, floors, room, or 3D compass text. The
  play surface is one felt plane (procedural, no new asset) plus a screen-space
  vignette; the compass is a DOM overlay.
- **WebGPU, post-processing, MSAA, shadow maps, glTF, KTX2/Draco.**
- **Wall depletion.** The wall is drawn full (as the 2.5D view draws it) and
  `tiles_remaining` stays a compass number. Deriving per-slot wall occupancy
  from `tiles_remaining` would invent physical state the engine does not
  publish; see §9 R6.
- **An agent signing off visuals.** Every look decision is a user handoff
  (AGENTS.md §6).

---

## 1. Decisions preserved

Every unit is gated on this table. "Enforcement point" is where the decision is
made mechanical rather than remembered.

| # | Decision | Enforcement point | Units |
| --- | --- | --- | --- |
| D1 | Three.js, exact version pin, imported only through a lazy dynamic import so stacked/top-down/2.5D never download it. Core only: no `three/examples/*`, no post-processing, no loaders. | `package.json` exact pin; a build-manifest check proves `three` is absent from the entry chunk | 3D-02, 3D-13 |
| D2 | WebGL2 only, via `WebGLRenderer`. WebGPU is rejected, not deferred. | context request is WebGL2 or the view is unavailable | 3D-02, 3D-11 |
| D3 | The renderer consumes a typed, immutable `TableSnapshot` derived in TypeScript from `GameState`; it never reads `GameState`, never calls WASM per frame. | `snapshotFromGameState` is the only producer; a lint-visible module boundary | 3D-01 |
| D4 | Animation timing belongs to the renderer's clock. React and the store never hold animation state, and no DOM answer path waits on an animation. | renderer API has no `enqueueAnimation`; a test answers with the renderer paused | 3D-12 |
| D5 | Use the committed Task 4B carved relief atlases as the 3D face maps, as read-only, hash-pinned inputs. Do not bake a second set, and do not make any unit wait on the 2.5D chain. | `reliefAssets.ts` pins and validates the manifest; a mismatch falls back loudly | 3D-03, 3D-10 |
| D6 | Tile mesh is procedural code, not glTF. Proportions and bevel are the committed shell spec (28 × 21 × 16.5 mm, 1 unit = 28 mm, 0.055-unit bevel, 0.64 × 0.89-unit face plate). | geometry invariants in tests | 3D-04 |
| D7 | Camera is the committed, user-signed-off whole-table rig (75 mm on a 36 mm gauge, 50° pitch, X = 0, 76 units), with an aspect-driven fit and a portrait preset. | framing assertions in `check-3d-layout.mjs` | 3D-02, 3D-06 |
| D8 | No shadow maps. Contact grounding is one instanced blob-quad pass plus the carved self-shadow in the fragment shader. | draw-call/asset budget | 3D-07, 3D-10 |
| D9 | Interaction lives in a DOM overlay of projected buttons; the canvas is `aria-hidden` decoration. | accessibility parity test against `PhysicalTable` | 3D-08 |
| D10 | POM ships from the hero-tile unit (user decision 2026-11-18: start with carving, do not bolt it on later). It is still a tiered parameter with a 0-step kill switch so the baseline cannot rot. | hero tile renders with POM; steps=0 renders the baseline in the same build | 3D-05, 3D-10, 3D-11 |
| D11 | No new committed runtime assets and no new hosting surface. Only new bytes are the lazy JS chunk. | budget script reports the delta | 3D-13 |
| D12 | Verification is scripted (numbers) or a user handoff. No agent looks at a render and declares it good. | every unit's gate names a command or a handoff | all |
| D13 | The 3D view is opt-in and never the default; switching views never re-deals. | `TableView` + `RendererHost` tests | 3D-14 |
| D14 | MIT stays clean: Three.js is MIT with a notice; Blender-baked assets are unchanged; no AGPL tool is added or linked. | third-party notice + dependency audit | 3D-16 |

Rejected alternatives are named where they matter (WebGPU in D2, glTF in D6,
shadow maps in D8) so they are not re-opened later as "phases".

---

## 2. Architecture decomposition

### 2.1 Runtime topology

```
        ┌──────────────────────────── React (DOM) ────────────────────────────┐
        │ App.tsx ── TableStage (existing chrome) ── table slot                │
        │   │                                                                 │
        │   ├── useGameStore.gameState (GameState, Rust/WASM payload)          │
        │   │        │                                                         │
        │   │        └─ snapshotFromGameState() ── TableSnapshot (immutable)    │
        │   │                                        │                        │
        │   └── RendererHost ─────────────────────────┤                        │
        │            │  (no three.js at module scope) │                        │
        │            ├─ mount: dynamic import('./renderers/three')             │
        │            │                                          │              │
        │            │                        ┌─────────────────▼──────────┐   │
        │            │                        │ TableRenderer (three.js)    │   │
        │            │                        │  camera rig · instanced    │   │
        │            │                        │  tiles · POM material      │   │
        │            │                        └─────────────────┬──────────┘   │
        │            │                                          │ canvas       │
        │            ├─ <canvas aria-hidden>  +  DOM overlay buttons (a11y)   │
        │            └─ compass DOM overlay (winds, scores, round, tiles left) │
        └──────────────────────────────────────────────────────────────────────┘
```

Four rules make this safe:

1. **One snapshot, many renderers.** The adapter is renderer-agnostic. Replacing
   Three.js with anything else never changes the snapshot.
2. **The canvas draws pictures; the DOM carries meaning and input.** The table is
   not a widget in a 3D scene; it is an image with an overlaid, positioned set of
   real buttons.
3. **The renderer is a child of React, not a peer.** It mounts into a div the
   table slot owns — for 3D, the full-window stage in `App`'s table slot — so
   switching views is a normal unmount and `dispose()` is the only teardown
   path.
4. **On-demand frames.** With no animation running, the renderer draws when the
   snapshot, tier, size or hover changes. Continuous rendering happens only while
   an animation or the perf HUD is active. This is a battery decision, not a
   performance optimisation of last resort.

**The stage is the window; the UI is a floating layer** (user guidance,
2026-11-18; §9 decision 7). The 3D canvas is a fixed, full-window layer
(`z-index: 0`) that fills the whole height of the browser: **no UI panel sits
above or below it in the document flow.** The UI that follows — header controls,
status cards, the action bar, the hand dock, the projected hand/draw buttons and
the compass — is positioned *over* the scene, the way a game HUD is, never
outside it.

**Interim state (as of 3D-02's landing).** While there is no floating layer yet,
the 3D mount renders **the scene alone**: no header, no cards, no action bar and
no hand dock are mounted, so nothing occupies Y space around the canvas. The
2D views keep their existing layout. 3D-14 re-mounts the chrome as the floating
layer and must remove the shell modifier (and leave full screen) when the user
switches away.

A full-screen toggle uses the Fullscreen API on the **shell**, not on the
canvas, so the floating layer travels with the scene; it is rendered only where
`requestFullscreen` exists, and it reports the browser's own state rather than
guessing. Browsers that do not support the API simply get the full-window view.
The component is built and tested in 3D-02 but stays unmounted until the
floating layer exists (3D-14), because offering a header control is UI.

### 2.2 Repository and build boundaries

All new 3D code lives under `frontend/src/renderers/`, a directory nothing else
owns:

```
frontend/src/renderers/
├── contract.ts           # TableSnapshot, RendererEvent, capabilities, quality tiers
├── snapshot.ts           # GameState -> TableSnapshot, pure
├── capabilities.ts       # WebGL2 probe, backend-store cap, tier resolution inputs
├── layoutConstants.ts    # committed table/camera constants (mirrors the reference spec)
├── RendererHost.tsx      # React host: lazy import, lifecycle, fallback, overlay mount
├── overlay.tsx           # projected DOM hit targets + compass (a11y surface)
├── three/
│   ├── index.ts          # the lazy entry: createRenderer(canvas, opts)
│   ├── Scene.ts          # renderer, resize, on-demand loop, dispose registry
│   ├── cameraRig.ts      # committed rig + aspect/portrait fit + framing numbers
│   ├── boardLayout.ts    # TableSnapshot -> PlacedTile[] (world transforms)
│   ├── tileGeometry.ts   # beveled mesh, face plate UVs, tangents
│   ├── reliefAssets.ts   # relief.json + 3 atlases, procedural fallback
│   ├── tileMaterial.ts   # node-free ShaderMaterial, tier uniforms
│   ├── boardMesh.ts      # InstancedMesh + per-instance attributes
│   ├── shadows.ts        # instanced contact-blob quads
│   ├── sticks.ts         # instanced riichi sticks
│   ├── felt.ts           # procedural felt texture + plane
│   ├── hitTest.ts        # world OBB -> CSS rect (pure projection math)
│   ├── materials/tile.vert.ts, tile.frag.ts   # GLSL as TS template strings
│   ├── perf.ts           # frame-time EMA, tier downgrade, stats
│   └── debug.ts          # ?debug= modes + ?perf= HUD
└── *.test.ts
```

Why GLSL in `.ts` strings: `npm run build` is `tsc -b && vite build`, and a
`?raw` import would need a declaration and a loader rule. Template strings need
neither, and tests can assert shader source contracts (for example that the
derivative guard precedes the first branch).

New scripts, dependency-free Node, in the existing `frontend/scripts/` style:

- `check-3d-layout.mjs` — 3D-owned layout constants and internal invariants:
  per-zone counts, OBB separation, camera framing at five aspect ratios. An
  optional `--reference` flag compares the constants against
  `table-reference-spec.json` for local calibration; CI does not use it, so a
  2.5D edit cannot turn the 3D gate red.
- `check-3d-budget.mjs` — atlas and GPU bytes per tier, instances, triangles,
  draw calls, lazy-chunk gzip size, `three` absent from the entry chunk.

Neither script needs a GPU, a browser, or a new dependency.

### 2.3 State model, snapshot frequency and animation ownership

The browser facts that shape this, verified in this repo:

- `GameState` is a serialized Rust payload (`src/state.rs` → `serde` →
  `frontend/src/types/game.ts`), handed to React as one immutable object.
- The store only ever replaces `gameState` on **deal, import or scenario load**
  (`store/useGameStore.ts` sets it in two places; nothing mutates the table in
  place after an answer). There is no discard/draw event stream anywhere in the
  app, and no replay playback.
- Therefore, in the current app, *every* state change is a new position, not a
  move within one.

Consequences, which the initial plan got wrong:

- **The renderer must not infer game moves from snapshot diffs.** A diff between
  two scenarios would "animate" a discard that never happened. The snapshot
  carries a `revision` supplied by the host (incremented on every new
  `gameState`), and any snapshot with a new revision is a **cut**: no tile
  flight, at most a bounded deal-in fade.
- **Rigid-body draw/discard/flip animations are not in v1.** They need a live
  game or replay source. The math and the event seam exist, unit-tested, behind
  `playEvents()`; nothing calls it yet.
- **`syncState` frequency is "once per user action"** (order of seconds), never
  per frame. Building a snapshot is O(tiles). No WASM call happens inside the
  render loop; the WASM module is already initialized by the time a table
  exists.
- **The snapshot API is synchronous.** The initial plan's `mount(): Promise`
  and `enqueueAnimation(): Promise` are dropped: the host owns the async module
  load, and a renderer that can queue animation is a renderer that can drift
  from the DOM.

What the snapshot carries (see §4) is everything the top-down view currently
renders plus the answered/highlight flags. It deliberately does **not** carry
lesson text, the answer, the rationale, or the call offer: those are DOM.

### 2.4 Camera and layout source

The world-space layout already exists, user-signed-off, in
`tools/render/table-reference-spec.json` (whole-table calibration, rig v13):

| Quantity | Committed value | 3D use |
| --- | --- | --- |
| Mat | 25 units = 700 mm square, front/back walls at radius 7.0 | layout reference; the drawn felt is a square sized per frame to reach the top and bottom edges (3D-02), wall ring |
| Tile | 1 unit = 28 mm; 21 × 28 × 16.5 mm; 0.3 mm gaps | tile mesh + layout pitch |
| Wall | 4 runs × 17 stacks × 2 tiers, 0.760714 pitch, one missing top tile at slot 16 (draw end) | wall layout |
| Ponds | 3 rows × 6, nearest row at 4.81, next at 2.7886, 4 overflow anchors on the near row | river layout |
| Human hand | 13 tiles + a draw slot at +5.5805, reclined about its far bottom edge | hand layout |
| Compass well | 4 units | compass overlay anchor |
| Camera | 75 mm on 36 mm, 50° pitch, X = 0, 76 units, negative Shift Y | `cameraRig.ts` |

The 3D chain **mirrors** those constants in `renderers/layoutConstants.ts` and
owns them: `check-3d-layout.mjs` asserts the internal invariants (counts, framing,
hand angle) without reading anything under `tools/`. Comparing the constants
against `table-reference-spec.json` is an optional local `--reference` run that
prints a table; it is not a CI gate and no unit waits on it. The chain does not
import across the `tools/` boundary at build time and does not modify the spec.
Blender is Z-up with −Y toward the viewer; the three world is +X right, +Y up,
+Z toward the human, mapped as `(x, y, z)three = (x, z, −y)blender`.

Two additions the 2.5D reference cannot answer:

- **Aspect fit.** The reference is a 1920 × 1080 frame. The renderer solves eye
  distance from the framing target and keeps the whole mat plus the human hand
  inside a safe area at 21:9, 16:9, 3:2, 4:3, 1:1, 3:4 and 9:16. A portrait
  preset increases pitch (62°) so the table fills the width instead of becoming
  a postage stamp. Framing is asserted numerically, not judged.
- **Hand recline.** The reference's readable hand is reclined 40° back from
  upright as a deliberate cheat (v2-v13). True 3D gets that for free and lights
  it honestly. The default is 40°, the accepted band is 30–45°, and the gate is
  numeric: the angle between the hand face normal and the camera view ray must
  be ≤ 25° for the human hand at every supported aspect.

**One frame, owned by the layout (reconciliation, 2026-11-18).** Two pure
solutions to the same problem landed in parallel: 3D-02's `cameraRig.ts` (the
committed 76-unit rig fitted to a fixed mat+hand subject, which only ever moves
back) and 3D-06's `boardLayout.frameForAspect` (a distance + lens-nudge solve
over the actual `layoutBoard` extents, gated by `check-3d-layout.mjs`). They
agree at 16:9 to within 0.05 units; 3D-06 also lifts the projection 18 px there
to hold its 2 % safe-area margin, and it moves the camera much closer on taller
frames (64.4 units at 3:2, 60.9 in portrait). **`frameForAspect` wins: it solves
against the real board and owns the gate, so it is the only projection source
from 3D-07 on.** `cameraRig.ts` becomes a thin `PerspectiveCamera` adapter, the
felt is sized from that frame (`groundHit` against the frame's eye/axes/fov/
shift, preserving the top/bottom rule), and 3D-08's hit rects use the same
frame. No view may project through a second camera.

### 2.5 Assets: reuse Task 4B, do not bake twice

Task 4B (landed, `frontend/public/table/relief/`, 3.39 MiB, 37 faces at
256 × 340 px) already bakes exactly the channels a POM pipeline needs. The
mapping is direct:

| 3D need | Committed channel | Runtime conversion |
| --- | --- | --- |
| Parallax height | `face_normal_depth.png` **A**: 1.0 at the uncarved face, 0.0 at the engraving floor | `depth = 1 − h`; scale by `carve.depthMm / 28` in tile units |
| Carve normals | `face_normal_depth.png` **RGB**: tangent x-right, y-down, z-out | sample with `textureGrad`; instance TBN maps to world; V runs downward (`texture.flipY = false`) |
| Albedo | `face_albedo.png` **RGB** (white on resin) + **A** paint mask | `mix(#f5f0eb, albedo.rgb, paintAlpha)`; the resin white is authored to multiply |
| Cavity AO | `face_ao_roughness.png` **R** | multiplies diffuse |
| Roughness | `face_ao_roughness.png` **G** (0.45 resin, 0.12 lacquer) | GGX alpha |
| Face rects | `relief.json` `faces[].cell.rect` (normalized UV) | per-instance atlas rect |
| Face plate | 0.64 × 0.89 units = 17.92 × 24.92 mm, inset 0.055 units | tile geometry UVs |

Decisions on top of that reuse:

- **The committed atlases are the out-of-the-box path.** They are already in
  the repo and the Pages artifact, so "runs with no external assets" is
  satisfied better by them than by a second procedural baker. The initial plan's
  "procedural baker first, compatible with baked atlases later" is inverted.
- **A procedural fallback still exists, for failure and for tests:** if the
  manifests are missing or invalid, build one 64 × 64 neutral cell in code
  (ivory, flat normal, height 1, AO 1, roughness 0.45) so the scene renders and
  says `relief: fallback`. Unit tests use the same generator in Node.
- **No new committed texture.** The felt is procedural (deterministic value
  noise, 512 × 512, regenerated into a CanvasTexture at mount) and the
  screen-space vignette is CSS, because `felt.png` has a vignette baked into
  screen space and must not be wrapped onto a 3D plane.
- **Resolution is sufficient, permanently under this budget.** The reference rig
  puts a tile's long axis at ≈104 CSS px at 1920 wide, so ≈208 px at a 4K
  backing store. The 340 px cell is therefore ≈1.6 texels per screen pixel —
  *oversampled*, not undersampled. The cell would only be undersampled above a
  ~6,280 px-wide backing store, which the 8.29 MP cap (and its DPR rule) forbids.
  POM only displaces the sample; it does not magnify the texture. **No rebake is
  planned** (user decision 6): a 2× atlas would cost ≈176 MB raw / ≈234 MB with
  mips for no visible gain. The real sampling risk is mip/anisotropy at grazing
  angles, which `textureGrad` and anisotropy address.
- **No second bake here, and no ask of the 2.5D chain.** If higher-resolution
  carving were ever wanted, it would be a 3D-owned offline task in a 3D-owned
  directory, built from the vendored public-domain SVGs — never a change
  requested from the 2.5D pipeline.
- **Independence by validation, not by trust.** The manifest and atlas sizes are
  pinned in the 3D code; `reliefAssets.ts` validates them on load. A 2.5D rebake
  that changes the atlas therefore either matches the pin or degrades the 3D view
  to the procedural cell with a visible status — it cannot break it silently.

GPU memory, stated up front: each atlas is 1536 × 2380 × 4 B = 14.6 MB, so
three atlases are **43.9 MB** raw and **58.5 MB** with a full mip chain. The
compatibility tier downsamples to 768 × 1190 at load (≈ 14.6 MB with mips), which
matters more on phones than the byte budget does.

Face orientation: `relief.json` publishes per-cell pixels with the glyph
top-left at the cell top-left, y-down. The tile's face UV is authored V-down to
match, so no flip is applied to the row and the tangent basis (`x` right,
`y` down, `z` out) is consistent with three's UV convention once `flipY` is off.

### 2.6 Materials and lighting

- Body: warm ivory `#f5f0eb` (the committed shell face colour), roughness 0.35,
  no map — the sides and bevels are geometry. Back: `#132986` (committed blue).
- Face: the three relief atlases (albedo + paint mask, normal + height, AO +
  roughness), carved faces with tiered POM, wrapped diffuse to fake resin
  translucency, GGX specular with the sampled roughness, AO multiply.
- One key light matching the 2.5D rig's authored key (azimuth 315°,
  elevation 55° → three-space direction `normalize(-0.406, 0.819, 0.406)`), so
  highlights land top-left in both views, plus a low hemisphere fill and a very
  weak ambient. No environment map, no IBL file, no post-processing.
- `outputColorSpace = SRGBColorSpace`, `toneMapping = NoToneMapping`. The 2.5D
  shells were baked through AgX; the 3D view is not required to match them
  pixel-for-pixel, only to be a plausible sibling. Matching is a user call.
- Context: `antialias: false`, `alpha: false`, `powerPreference:
  'high-performance'`, `preserveDrawingBuffer: false`. At an 8.3 MP backing
  store, 4× MSAA is a fill-rate and memory cost with nothing to buy.

### 2.7 Interaction and accessibility

The canvas is an image. Everything a user can do or must hear is DOM:

- Hand and drawn tile become absolutely positioned `<button>`s over the canvas,
  sized from the projected OBB with a 44 × 44 CSS px minimum, labelled exactly
  as `HandDock`'s tiles are, disabled when answered, in the same order.
- The compass (four seats: wind symbol, score, riichi marker; centre: round and
  tiles left; honba stays in the existing stage status line) is a DOM overlay
  with the same group/role/label structure as `PhysicalTable`'s compass, and a
  drift test compares the accessible names.
- Hover/focus lifts the tile in 3D (bounded, reduced-motion aware) and never
  moves the button.
- Tile faces, rivers, melds and walls are decorative and not individually
  focusable — exactly as in the top-down view, where only the hand is
  interactive. A hidden heading names the view for screen readers.
- The interaction layer is a pure function of `TableSnapshot` + camera matrices
  (`hitTest.ts`), so it is unit-testable in Node without WebGL.
- **Chrome over the scene.** The stage is the whole window (§2.1). Once the
  floating layer lands (3D-14; hand/draw buttons in 3D-08, compass in 3D-09),
  the app chrome — header controls, status cards, the action bar and the hand
  dock — is positioned *over* the canvas in Z order, never in the document flow
  above or below it. Until then the 3D view deliberately shows no chrome at all.
  No overlay may capture pointer events outside its own controls: clicking the
  felt (once anything is bound to it) and every chrome control must keep
  working. Floating panels keep their own backgrounds so they stay readable
  over the felt.

### 2.8 Performance budget, stated and justified

**Backing-store cap: 8.29 MP (3840 × 2160).** The initial plan's "native 4K
with devicePixelRatio up to 2.0" means a 7680 × 4320 backing store — 33.2 MP,
four times the pixels — with no legibility gain on a 4K display. The cap is
expressed as `min(devicePixelRatio, 2)` **and** an area limit:
`dpr_eff = clamp(min(dpr, 2), 1, sqrt(8.29e6 / (cssW · cssH)))`.

| Tier | Backing store | POM steps | Shadow march | DPR cap | Target |
| --- | --- | --- | --- | --- | --- |
| high (desktop) | ≤ 8.29 MP | 12 | 3 | 2.0 | 60 fps (16.7 ms) |
| balanced | ≤ 4.67 MP | 8 | 2 | 1.5 | 60 fps |
| compat (mobile / weak) | ≤ 2.07 MP | 0 (normal + AO only) | 0 | 1.0 | 30 fps floor (33 ms) |

Draw calls: **4 in steady state** (tiles, contact shadows, riichi sticks, felt)
and a hard ceiling of **12** including debug. Instances: one tile mesh with
capacity **320**. Triangles ≤ 200 k (320 × ≤ 600 tris + environment).

The instance count is worth stating because the starting proposal assumed 136:
the wall alone is 4 × 17 × 2 = 136 tiles, and it is decorative but drawn full
(§0), so a full board is 136 + up to 53 concealed/draw + up to 72 discards + up
to ~20 meld tiles + 5 dora ≈ 280. Capacity 320 leaves headroom; 192 k triangles
is a non-issue at this scale, which is why the tile budget can stay ≤ 600.

Where the budget is most likely to be missed, in order:

1. **POM dependent fetches.** At 8.29 MP, tile faces cover roughly 20 % of the
   screen (1.66 M px). 12 depth steps + 3 light steps + 6 shading taps ≈ 21
   dependent texture fetches per face pixel ≈ 35 M fetches/frame ≈ 2.1 G/s at
   60 fps — the largest single cost, and it is latency-bound rather than
   bandwidth-bound, which is what integrated GPUs are worst at. This is why the
   step budget is a tier, not a constant.
2. **The reclined human hand.** It is the largest contiguous tile area on screen
   (~25 % at 4K), so it alone accounts for more face pixels than all four ponds
   together — even though the ponds are more oblique (~40° vs ~10° off normal)
   and therefore cost more per pixel. The near hand is where fill rate is spent.
3. **Overdraw.** Contact-shadow quads are transparent and overlap in rows; they
   are drawn first, with depth test on and depth write off, and are clipped to
   their quads.
4. **GPU memory and texture bandwidth on phones.** 58.5 MB of atlas plus mips
   competes with the existing 43 MB language model; the compat tier's load-time
   downsample exists for that.
5. **Shader compile stalls at mount.** The lazy chunk loads, compiles, and only
   then draws; the host holds the previous view's last frame (or the felt) until
   the first frame is ready, so there is no white flash.

Deferred-with-a-reason: MSAA (fill rate), shadow maps (a ~280-caster map pass at
this size costs more than the contact quads and looks worse on a mat), and
post-processing / tone mapping (adds a full-screen pass and changes the ivory).

### 2.9 Licensing and hosting

- **Three.js is MIT** (`three/MIT`), acceptable for an MIT app. Add its notice
  to `THIRD_PARTY_NOTICES.md` (new file) and keep the bundler's licence banner.
  Version pinning is part of D1: no `^`, no range.
- **Blender is GPL, but its output is not.** The 3D path reuses Blender-baked
  PNGs that the 2.5D chain already commits and ships; nothing new is generated
  and no GPL code is linked into the app.
- **No AGPL tooling anywhere.** No `libriichi`, no Mortal code, no `basisu`
  (Apache-2.0 would be acceptable if compression is ever needed — that is the
  sanctioned path), no Draco.
- **Hosting is unchanged.** The relief atlases are already in
  `frontend/public/table/relief/` and therefore already in the Pages artifact;
  the only new bytes are the lazy JS chunk (same-origin, no R2/HF, no new CORS
  story). Unlike the weights, nothing here needs a release download or a mirror.
- **What the 3D path needs that the 2.5D path did not:** a runtime 3D dependency
  (Three.js) and therefore a third-party notice and a bundle-size gate. Nothing
  else: no model files, no compressed-texture transcoder, no environment maps.

### 2.10 Testing and verification stance

CI has no GPU and jsdom has no WebGL, so the plan splits verification into three
kinds and never pretends one substitutes for another:

1. **Pure modules, Node + vitest** — snapshot adapter, layout, geometry
   invariants, projection/hit-test math, tier resolution, DPR cap, budget
   counters. These are the majority of the assertions and all of them are exact.
2. **DOM, jsdom + @testing-library** — host lifecycle, fallback when WebGL2 is
   unavailable, overlay buttons/labels/order/disabled state, compass labels,
   accessibility parity with `PhysicalTable`.
3. **Look and frame rate, the user** — shading quality, POM, felt, framing
   aesthetics. The agent hands over a URL/artifact and numbers it already
   checked and asks a specific question (AGENTS.md §6). The in-app debug modes
   and perf HUD exist so that handoff is about taste, not mystery.

No Playwright, no headless-GL dependency, no screenshot diffing in CI. The
layout/budget scripts are dependency-free Node so they run in the existing
frontend CI job without new setup.

### 2.11 Library choice, version policy and bundle size

The choice is on the record because the task asked for it explicitly, and
because "which renderer library" is the kind of decision that silently reopens.

| Option | Verdict | Why |
| --- | --- | --- |
| **Three.js** (MIT) | **chosen** | Owns the renderer, `InstancedMesh` + `InstancedBufferAttribute`, math, texture upload/mipmap/anisotropy, resize, and context-loss events. We write the geometry, layout and shaders — which is the actual work — and none of the plumbing. |
| Raw WebGL2 (no library) | rejected | Smallest bundle, but we would own matrix math, VAO/UBO setup, instanced attribute binding, mip generation, anisotropy, context-loss handling and the render loop: roughly 1.5–2.5 k lines of infrastructure the repo has to maintain, with **no performance advantage at ~300 instances**. |
| Babylon.js (MIT) | rejected | A full engine (scene graph, materials, post-process, loaders) at roughly 2–3× Three.js's size for features we deliberately do not use. |
| regl | rejected | A thin functional wrapper: keeps the dependency and still leaves all pipeline/shader plumbing to us; smaller community. |
| PlayCanvas | rejected | Editor/asset-pipeline assumptions that do not match a Rust/WASM app and a hand-authored scene. |
| WebGPU (via any library) | rejected | Coverage is still not universal in 2026, the WebGL2 path has to exist anyway, and nothing here needs compute or bindless resources. Not deferred: rejected. |

**Version policy.** Pin exactly (no `^`, no range) and record the exact version
in D1 and in `3d_renderer_architecture.md`. Depend on the core entry only; no
`three/examples/*`, no loaders, no post-processing, no addons. Upgrading is its
own task that re-runs `check-3d-budget.mjs` and the 3D-05/3D-10 handoffs — a
silent `npm update` is a bug.

**As built (3D-02, 2026-11-18).** `three@0.187.0` and `@types/three@0.187.0`,
both exact. Two build-toolchain facts came out of landing the first lazy chunk
and should not be undone casually:

- `vite.config.ts` spells out `build.minify: 'esbuild'` (Vite's default, written
  down on purpose): `vite-plugin-top-level-await` reads `build.minify` in its
  own `config` hook before Vite applies that default, and it rewrites every
  chunk that contains a dynamic import — now the app's entry chunk. Without the
  explicit value the rewritten entry ships unminified (+19 KB gzip, measured).
  The chunk gate in 3D-13 would see that as an entry regression.
- `@swc/core` is pinned to `1.12.14`, the plugin's declared baseline.
  `@swc/core@1.16.x` rejects the plugin's generated AST for a chunk that has
  exports (`missing field type`), which is exactly the shape the first
  dynamic-import split produces (the entry then exports the symbols its lazy
  chunk shares). Upgrade the plugin and the swc pin together or not at all.

**Bundle size.** The measured budget is **≤ 200 KB gzip for the lazy 3D chunk**
(advisory; 3D-13 prints it), and **0 bytes added to the entry chunk**, which
3D-13 asserts by parsing the build manifest. For context, the app already loads
a 43 MB language-model file and a multi-MB sprite atlas on other paths, so a
~150 KB lazy chunk is not a reason to hand-roll a renderer; it is also why the
chunk must stay lazy for anyone using the stacked, top-down or 2.5D views.

---

## 3. End-to-end pipeline

1. **Deal.** Rust generates a validated `GameState`; React stores it.
2. **Snapshot.** `snapshotFromGameState(state, revision, answered, highlight)`
   produces an immutable `TableSnapshot`: seat-relative zones, face ids, flags,
   compass numbers. Pure, no DOM, no three.
3. **Host.** `RendererHost` decides whether the 3D view is allowed
   (`?renderer=3d` or the selected view, WebGL2 present, not a forced fallback),
   lazy-imports `renderers/three`, creates the canvas, and passes the snapshot.
4. **Tier.** Capability probe + viewport + device class pick `high | balanced |
   compat`; the persisted/URL override wins.
5. **Assets.** One fetch of `relief.json` + three PNGs (cached by the browser),
   validated against the manifest, uploaded with mipmaps and anisotropy; on any
   failure the procedural cell is used.
6. **Layout.** Every tile in the snapshot becomes a `PlacedTile` (position,
   rotation, face rect, flags). Walls come from constants; the human hand
   reclines; rivers fill 3 × 6 from the far row; melds sit right of the hand;
   dora indicators sit face-up on the far wall's top tier.
7. **Pack and draw.** Instance matrices and per-instance attributes are packed
   into one `InstancedMesh`; contact shadows and riichi sticks are separate
   instanced draws; the felt is one plane. One frame, then idle until dirty.
8. **Overlay.** Projected hand/draw OBBs become DOM buttons; the compass overlay
   renders winds, scores, round and tiles left.
9. **Input.** A button click calls the existing discard/declare handler in the
   store; the answer path is unchanged, and the store's `answered` flag flows
   back through the snapshot to disable the buttons.
10. **Teardown.** Switching views unmounts the host, which cancels the frame,
    deletes geometries, materials, textures and the renderer, and drops caches.

---

## 4. Shared contracts

Planning-level TypeScript; the units implement these shapes, and they are the
only coupling between React, the snapshot and the renderer.

```ts
// contract.ts
// The face vocabulary is owned here, not imported from frontend/src/table/*.
// The relief manifest's own `faces` keys are the runtime check: every id below
// must resolve to a cell, and a manifest that disagrees is a hard load error.
export type TileFaceId =
  | `${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}${'m' | 'p' | 's'}`
  | '5mr' | '5pr' | '5sr'
  | '1z' | '2z' | '3z' | '4z' | '5z' | '6z' | '7z'
  | 'blank';

export type Seat = 0 | 1 | 2 | 3;
export type Zone = 'hand' | 'draw' | 'river' | 'meld' | 'wall' | 'dora';

export interface SnapshotTile {
  readonly face: TileFaceId;
  readonly zone: Zone;
  /** Zone-local index: hand slot, river cell, meld slot, wall stack/tier. */
  readonly slot: number;
  readonly faceUp: boolean;
  /** Rotated 90° about its own vertical axis: riichi declarations, called meld tiles. */
  readonly sideways: boolean;
  readonly highlighted?: boolean; // newest discard being claimed
  readonly dimmed?: boolean;      // tsumogiri
}

export interface SnapshotMeld {
  readonly kind: 'Chi' | 'Pon' | 'Kan' | 'Ankan';
  readonly tiles: readonly SnapshotTile[];
  /** Seat the called tile came from, for the sideways call-tile placement. */
  readonly calledFrom: Seat | null;
}

export interface SnapshotSeat {
  readonly seat: Seat;
  readonly wind: 'East' | 'South' | 'West' | 'North';
  readonly score: number;
  readonly concealed: readonly SnapshotTile[]; // 13 - 3 * melds, in hand order
  readonly draw: SnapshotTile | null;
  readonly melds: readonly SnapshotMeld[];
  readonly river: readonly SnapshotTile[];     // oldest first, max 18 + overflow
  readonly riichi: boolean;
  readonly riichiDiscardIndex: number | null;
}

export interface TableSnapshot {
  /** Incremented by the host on every new GameState. A new revision is a cut, never a move. */
  readonly revision: number;
  readonly humanSeat: Seat;
  readonly seats: readonly [SnapshotSeat, SnapshotSeat, SnapshotSeat, SnapshotSeat];
  readonly wall: readonly SnapshotTile[];      // face-down, fixed count, decorative
  readonly dora: readonly SnapshotTile[];      // face-up on the far wall
  readonly compass: {
    readonly roundWind: 'East' | 'South' | 'West' | 'North';
    readonly handNumber: number;
    readonly honba: number;
    readonly riichiSticks: number;
    readonly tilesRemaining: number;
  };
  readonly highlightDiscard: { readonly seat: Seat; readonly index: number } | null;
  /** True once the hand is answered: input is locked in every view. */
  readonly locked: boolean;
}

export type QualityTier = 'high' | 'balanced' | 'compat';

export interface RendererCapabilities {
  readonly webgl2: boolean;
  readonly maxTextureSize: number;
  readonly devicePixelRatio: number;
  /** Reason the 3D view must not be offered, or null. */
  readonly unavailable: string | null;
}

export interface RendererOptions {
  readonly tier: QualityTier;
  readonly debug: DebugMode | null; // 'albedo' | 'height' | 'normal' | 'steps' | 'pom-off' | 'wireframe'
  readonly perfHud: boolean;
  readonly reducedMotion: boolean;
}

/** Reserved for a future live/replay source. Not called in v1. */
export type RendererEvent =
  | { kind: 'draw'; seat: Seat; face: TileFaceId }
  | { kind: 'discard'; seat: Seat; face: TileFaceId; riichi: boolean }
  | { kind: 'meld'; seat: Seat; meld: SnapshotMeld }
  | { kind: 'flip'; face: TileFaceId };

export interface RendererStats {
  readonly tier: QualityTier;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly instances: number;
  readonly atlasBytes: number;
  readonly frameMsP50: number;
  readonly frameMsP95: number;
}

export interface TableRenderer {
  /** Idempotent, cheap (O(tiles)); call on every snapshot change. */
  syncState(snapshot: TableSnapshot): void;
  setSize(cssWidth: number, cssHeight: number, dpr: number): void;
  setQuality(tier: QualityTier): void;
  /** Pure projection of interactive tiles to CSS rects, for the DOM overlay. */
  hitRects(): readonly HitRect[];
  playEvents(events: readonly RendererEvent[]): void; // v1: no-op, tested
  measure(): RendererStats;
  dispose(): void;
}

export interface HitRect {
  readonly seat: Seat;
  readonly zone: 'hand' | 'draw';
  readonly slot: number;
  readonly face: TileFaceId;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
```

Two interface notes that matter:

- `hitRects()` is on the renderer (it owns the camera matrices) but is **pure**:
  it never creates DOM. The overlay renders the buttons.
- There is no `mount()`. The host creates the canvas before importing three, so
  a WebGL2 failure is decided before any three.js code runs.

---

## 5. Dependency graph and waves

```
3D-01 contract
 ├─ 3D-04 mesh ──────────────────┐
 ├─ 3D-06 layout ─────────────┐  │
 └─ 3D-02 host ─ 3D-03 ─ 3D-05 hero + POM ─ 3D-S1 spike
                                    │              │
     3D-07 board ◄─ 3D-04, 3D-05, 3D-06           │
     3D-08 overlay ◄─ 3D-07                       │
     3D-09 compass ◄─ 3D-07                       │
     3D-10 calibrate ◄─ 3D-05, 3D-07, 3D-S1 ◄─────┘
     3D-12 motion ◄─ 3D-07, 3D-08
     3D-11 tiers ◄─ 3D-02, 3D-10
     3D-13 budget ◄─ 3D-07, 3D-11
     3D-14 view switch ◄─ 3D-08 (soft: 3D-11, 3D-13)
     3D-15 sign-off ◄─ 3D-08, 3D-09, 3D-11, 3D-12, 3D-13, 3D-14
     3D-16 docs ◄─ 3D-15
```

**Critical path to the first usable view:** 3D-01 → 3D-02 → 3D-03 → 3D-04
→ 3D-05 → 3D-06 → 3D-07 → 3D-08 → 3D-14. 3D-04 and 3D-06 start as soon as
3D-01 lands, in parallel with the host work. POM is inside 3D-05 and therefore
on the path by decision; tiering (3D-11), calibration polish (3D-10) and the
budget harness (3D-13) gate full sign-off (3D-15), not the first view. Nothing
in this graph is a 2.5D unit.

**Waves**

| Wave | Units that can run in parallel | Exit criterion |
| --- | --- | --- |
| 0 | 3D-01 | Snapshot + capabilities tested; no three.js in the bundle |
| 1 | 3D-02, 3D-04, 3D-06 | An empty felt scene mounts behind `?renderer=3d`; geometry and layout pass their numeric gates |
| 2 | 3D-03, 3D-05 | A carved hero tile renders with the committed face maps and is handed to the user |
| 3 | 3D-07, 3D-S1 | A full board renders in 1 instanced draw; real-hardware POM numbers recorded |
| 4 | 3D-08, 3D-09, 3D-10, 3D-12 | The view is usable with mouse, keyboard and screen reader; carving calibrated |
| 5 | 3D-11, 3D-13 | Tiers and fallback work; the budget script prints and asserts |
| 6 | 3D-14, 3D-15, 3D-16 | The view is in the switch, signed off, and documented |

---

## 6. Unit specifications

Conventions: every unit's gate includes the frontend gate
`cd frontend && npm test && npm run build && npm run lint` unless stated, plus
its own script. No unit touches Rust, so the cargo gates in §8 are run once per
PR but are expected to be untouched. "Handoff" means the unit ends with an
artifact path, a URL, a specific question and the numbers the agent already
checked, per AGENTS.md §6.

### 3D-01 — Snapshot contract and capability probe

**Goal.** Freeze the boundary between Rust state and the renderer before any
rendering exists.

**Depends on:** —

**Deliverables**

- `contract.ts` (shapes in §4), `snapshot.ts`, `capabilities.ts`, and
  `layoutConstants.ts` (the committed table/camera constants every later unit
  reads; pure data, no three.js).
- `snapshotFromGameState` covering hands, draws, discards, melds, dora, riichi,
  red fives, highlight and locked state.
- `parseRendererQuery(search)` → `{ renderer: '3d' | null; quality: QualityTier | null; debug; perf }`
  with strict values and unknown-value rejection.
- `probeCapabilities()` that never leaks a live WebGL2 context.

**Acceptance criteria**

- A seat with `meld`s reduces its concealed count correctly (13 → 10 for one
  meld, 7 for two); a `draw: null` hand produces 13 slots and no draw tile.
- Red fives map to `5mr`/`5pr`/`5sr` from both `red_fives` and `discard.is_red`;
  a plain `5m` stays `5m`.
- Riichi discards are marked `sideways`; `riichi_discard_index` is honoured when
  the flag is absent; tsumogiri discards are `dimmed`.
- `highlightDiscard` is null unless a call/ron offer names a seat and index.
- `locked` is true exactly when the app has an answer for the hand.
- Unknown face codes fail loudly in tests, not silently at runtime.
- `probeCapabilities` returns `{ webgl2: false }` under jsdom and never throws;
  after probing, no context is left allocated (verified by a spy on
  `getContext`/`loseContext`).
- Snapshot is deeply frozen in development and contains no DOM or three types.
- No import from `frontend/src/table/*`: the face vocabulary is defined in
  `contract.ts` and validated against the relief manifest's `faces` keys at load
  (3D-03), so the two chains cannot break each other by editing a type.
- `three` is not imported anywhere yet.

**Gate:** frontend gate.

---

### 3D-02 — Lazy host, lifecycle and empty scene

**Goal.** Mount and dispose a WebGL2 scene without shipping three.js to anyone
who does not ask for it.

**Depends on:** 3D-01.

**Deliverables**

- `RendererHost.tsx` with states `idle | loading | ready | unsupported | failed`,
  a lazy `import('./three')`, a canvas, and an error boundary.
- `three/index.ts`, `Scene.ts`: renderer, resize, on-demand loop, a dispose
  registry for every buffer/geometry/material/texture.
- `cameraRig.ts` (imports `layoutConstants.ts`) with the committed rig and the
  aspect/portrait fit.
- `felt.ts`: deterministic 512 × 512 procedural felt texture and **one square
  plane, sized per frame** (`feltSizeForPose`, from the frame's top/bottom
  ground intersection) so it always reaches the top and bottom edges. It is
  never stretched to the aspect: on a wide window its side edges stay inside the
  frame and the background shows beside it. The 25-unit mat stays the layout
  reference; a CSS radial vignette overlay.
- `package.json`: `three` added with an **exact** version; the version is
  recorded in this plan when it is chosen.
- Minimal `App.tsx` wiring: `?renderer=3d` mounts the host in place of the
  current table (only when a `GameState` exists); no persistence.
- **Full-window, scene-only stage** (user guidance 2026-11-18, revised the same
  day): the shell drops its phone-width column and the 3D stage becomes a fixed
  layer covering the whole viewport, with **no UI mounted above or below it** in
  the document flow. The stacked and top-down layouts are untouched.
- **Full-screen toggle** (`components/FullscreenButton.tsx`): promotes the
  shell, not the canvas, follows `fullscreenchange`, and renders nothing where
  the Fullscreen API is absent. Built and tested here, but kept **unmounted**
  until the floating UI layer exists (3D-14), because a header control is UI.

**Acceptance criteria**

- Without the query parameter, no network request for the three chunk is made
  (a test asserts `RendererHost` has no static import of `renderers/three`).
- With `?renderer=3d`, an empty felt scene mounts at the correct camera framing
  on a 1920 × 1080 viewport; the canvas is `aria-hidden`, is not focusable, and
  has an accessible name on a sibling heading.
- The 3D stage is the whole window: the shell has no max-width, the stage is a
  fixed full-viewport layer, and a DOM test asserts that **no** app chrome
  (header, cards, action bar, hand dock, player rows) is mounted with it. A
  transient status or generation error floats over the scene without pushing the
  canvas down.
- The felt reaches the top and bottom edges: a numeric test projects the frame's
  centre line onto the ground plane (`groundHit`) at the supported aspects plus
  9:19.5/9:21 phone portraits and asserts the square's far/near edges are at or
  beyond them. A second assertion checks that at 16:9 and 21:9 the square is
  narrower than the frame, so its left/right edges are visible inside it (no
  black band above the table, and no stretched mat).
- The full-screen component targets the shell and follows `fullscreenchange`
  rather than its own guess; it renders nothing without the API (jsdom). It is
  not mounted by 3D-02 (above), and its tests cover both states.
- `dispose()` releases every registered resource; mount/unmount ×5 leaves the
  tracked resource count at zero; React StrictMode's double effect does not
  create two renderers.
- WebGL2 unavailable (jsdom, or a mocked failing `getContext`) → state
  `unsupported` and a rendered message over the stage, never a thrown error.
  While the view is scene-only there is no 2D fallback inside it; the standard
  views remain reachable by dropping the query parameter (the persistent View
  control is 3D-14's).
- `webglcontextlost` is prevented, one restore is attempted, a second loss
  disposes and reports `failed` with a message over the stage.
- Precedence is explicit and tested: explicit query param > stored view >
  default (`stacked`).
- Framing numbers at 16:9 match the reference within 1 px for the mat corners
  (printed by `check-3d-layout.mjs` in 3D-06; this unit prints them from the
  camera rig).
- No console errors/warnings in dev.

**Gate:** frontend gate.
**Merge note:** touches `App.tsx` (shell modifier, snapshot/revision memo, mount
slot and the full-screen control; ~100 lines with comments) and `App.css`. The
2.5D view tasks may touch the same files; that is ordinary merge contention, not
a dependency — neither chain waits for the other. Keep the diff to the mount
point and the shell modifier.

**Handoff recorded (2026-11-18).** The user reviewed the full-window,
scene-only mount and the square felt at `?renderer=3d` and said: "Looks good
now." Accepted as-is: no app chrome mounted, the camera rig and framing, the
procedural felt (a square sized to the frame's top and bottom edges, sides
visible on a wide window), and the status/error placement. Not yet built and
still owned by later units: the board (3D-07), the floating hand/compass UI
(3D-08/3D-09), the re-mounted chrome plus the full-screen toggle (3D-14).

---

### 3D-03 — Relief asset bridge and procedural fallback

**Goal.** Turn the committed Task 4B bakes into three GPU textures and a
face-id → atlas-rect lookup, with a truthful failure path.

**Depends on:** 3D-02.

**Deliverables**

- `reliefAssets.ts`: fetch `table/relief.json`, validate `version`, the three
  atlas entries, 37 face cells and normalized rects, and pin the three atlas
  byte sizes and `sha256` values (a mismatch is a hard load error that reports
  the fallback status, never a silent re-read); fetch the three PNGs; create
  textures (albedo sRGB, normal/data linear, `flipY = false`, mipmaps,
  anisotropy from tier); report `relief: 'committed' | 'fallback'`.
- A procedural neutral cell generator, shared with tests.
- A load-time downsample path for the `compat` tier.

**Acceptance criteria**

- All 37 face ids resolve; unknown ids resolve to `blank`; unused cells are not
  addressable. The manifest's `faces` keys must equal the contract's 37-tile
  vocabulary (a runtime list beside the type), so a manifest/contract mismatch is
  a load error rather than a missing tile.
- A Node test decodes the committed atlases with `@napi-rs/canvas`, samples each
  face's cell, and matches `relief.json`'s `measured` values (paint fraction, AO
  mean, roughness means) within a stated tolerance for at least three faces —
  proving the rect mapping and the y-down convention.
- A UV assertion proves the face plate maps 0.64 × 0.89 units, not the full
  21 × 28 mm face (`relief-spec.json`'s prose says 20.89 mm while the committed
  `plateUnits` and the cell rects say 17.92 mm; the committed data wins — see
  §9 R2).
- Missing/invalid manifest, a hash/size mismatch, or a failed PNG fetch →
  fallback cell, one console warning, the scene still renders, and
  `measure().relief === 'fallback'`.
- GPU bytes are reported per tier and match the arithmetic in §2.5.
- No committed relief file changes: the unit reads `frontend/public/table/relief/`
  and never writes it (the gate is a clean `git status`).
- The unit needs no change from the 2.5D chain and waits for nothing; the pinned
  manifest is the contract.

**Gate:** frontend gate.

---

### 3D-04 — Procedural tile geometry

**Goal.** One deterministic beveled tile mesh with a correct face plate and
per-instance-ready attributes.

**Depends on:** 3D-01.

**Deliverables**

- `tileGeometry.ts`: rounded beveled box, 6 bevel segments, 0.055-unit bevel,
  domed back optional, `faceZone` attribute, face-plate UVs, tangents.

**Acceptance criteria**

- Local bounds are exactly 0.75 × 1.0 × 0.58929 units (± 1e-6) for a
  21 × 28 × 16.5 mm tile at 1 unit = 28 mm.
- The face plateau occupies x ∈ ±0.32, z(face plane) with the 0.64 × 0.89-unit
  plate centred; a sampled UV at the plate's top-left is (0, 0) with V pointing
  down the glyph.
- `faceZone == 1` on every plateau vertex and 0 on bevel, sides and back; the
  shader's zone branch is therefore geometrically exact.
- All normals are unit length; all tangents are unit length and orthogonal to
  their normal; winding is outward (a signed-volume check > 0).
- ≤ 600 triangles; no `Math.random`; two builds produce identical buffers
  (hash the Float32Arrays).
- No assets, no imports outside the renderer directory.

**Gate:** frontend gate.

---

### 3D-05 — Hero tile: material, lighting and POM

**Goal.** Prove the look of one carved tile, made of the real maps and the real
light, before scaling to a full board. POM is built here, not added later (user
decision 4 of 2026-11-18), and the 0-step kill switch is built alongside it.

**Depends on:** 3D-02, 3D-03, 3D-04.

**Deliverables**

- `tileMaterial.ts` + `materials/tile.vert.ts`, `materials/tile.frag.ts` with
  albedo/paint compositing, normal mapping, AO, GGX, wrapped diffuse, the
  front/side/back split, and the tangent-space height ray march (derivative guard
  before any branch, secant refinement after the first hit).
- Tier-driven step count; `POM_STEPS = 0` remains a first-class path.
- `lighting.ts` (key, fill, ambient) and `?renderer=3d&debug=hero`.
- `probes.ts`: read back a few pixels (face ivory, paint, blue back, side) and
  print them as numbers in the debug HUD.

**Acceptance criteria**

- The shader compiles with no GLSL errors in a real browser; a compile failure is
  surfaced as a host `failed` state, and a test covers that path.
- The debug HUD reports the four probe colours; face ivory is within ΔE 6 of
  `#f5f0eb` under the key light, the back is within ΔE 6 of `#132986` in
  shadow-free fill. (The exact thresholds are the unit's to set; they are
  numbers, printed, not a look.)
- The painted glyph is present on the face and absent from the blue back (a
  probe/flag check, not a look). Whether the ink *reads* as recessed is the
  handoff question below, not an agent verdict.
- `POM_STEPS = 0` reproduces the un-carved baseline within the probe tolerance,
  so the carve path is removable in one uniform.
- The worst-case parallax displacement, computed from the committed camera, the
  face plate and `carve.depthMm`, is ≤ 8 texels at every supported aspect; a unit
  test computes and prints it. (At 4K the hand is ~10° off normal and the ponds
  ~40°, giving ≈ 6.6 texels; a bad depth parameter fails the gate.)
- The derivative guard test fails if `dFdx`/`dFdy` move below the first `if`, and
  every texture sample uses explicit gradients.
- No `three/examples`, no post-processing, no new asset.
- **Handoff:** `npm run dev` → `?renderer=3d&debug=hero`, plus one exported PNG
  per slot (pond, hand, wall, back) under `frontend/scripts/out/`, POM on and
  off — ask: does the carving read as physically recessed, does the material
  family match the 2.5D shells, and does Haku stay clean? Record the verdict.

**Gate:** frontend gate + user verdict.

---

### 3D-S1 — POM cost measurement (optional, no app change)

**Goal.** Answer "how many POM steps fit in 16.7 ms on this hardware" with a
measurement instead of an estimate, using the shader 3D-05 actually built. If POM
is already on the critical path by decision, this spike is how its step counts are
chosen rather than guessed.

**Depends on:** 3D-05.

**Deliverable:** a throwaway page (not committed) or the debug route plus a
one-command harness that renders a full board's worth of tile instances (~280)
with POM step counts 0 / 8 / 12 / 16 at 1080p and 4K, reporting GPU timer-query
or EMA frame times. Results go in §2.8 (a short table) and in the plan's
decision log.

**Acceptance criteria**

- Numbers for all 8 combinations on the user's machine, with browser, GPU and
  DPR recorded.
- A recommended `high` step count and a confirmed `compat` step count (0 or 4).
- If the spike is skipped, 3D-10 uses §2.8's defaults (12/8/0 depth, 4/2/0
  shadow) and says so.

**Gate:** none beyond a recorded table (it changes no shipped code).

---

### 3D-06 — Board layout engine

**Goal.** Turn a `TableSnapshot` into exact world transforms for every tile, from
the committed table geometry.

**Depends on:** 3D-01.

**Deliverables**

- `boardLayout.ts` (pure, imports `layoutConstants.ts`), plus
  `frontend/scripts/check-3d-layout.mjs`.

**Acceptance criteria**

- Every zone is produced: 4 walls × 17 stacks × 2 tiers, four ponds in 3 × 6
  rows with the overflow extending the near row, melds right of each hand with
  the called tile sideways, the human hand reclined 40° (band 30–45°) with a
  separate draw slot, opponent hands upright and face-down, dora indicators
  face-up on the far wall's top tier (one per indicator, from the draw end),
  riichi sticks near the centre.
- The multiset of foreground tiles equals the snapshot's foreground tiles
  exactly (no duplicates, none dropped); wall tiles are the fixed decorative
  set and are excluded from that comparison.
- No two foreground tiles' oriented boxes intersect (a separating-axis check at
  the committed 0.3 mm gaps); stacked wall tiers are the only intentional
  proximity and are separated by the tier gap.
- Pond rows start at the far row and fill toward the seat, matching the
  committed convention; the 4 overflow cells are used before any new row.
- The human hand's face-normal-to-view angle is ≤ 25° at every supported aspect
  (9:16, 3:4, 1:1, 16:9, 21:9); all mat corners are in frame with ≥ 2 % margin;
  the hand's tile long axis is ≥ 5 % of viewport height.
- `check-3d-layout.mjs` prints the constant table and the per-zone counts and
  framing numbers for the five aspects, and fails on any internal invariant. Its
  optional `--reference` run compares the constants against
  `table-reference-spec.json` and prints both values, but is never part of a CI
  gate (the constants are 3D-owned).
- Pure: no three.js, no DOM.

**Gate:** frontend gate + `node frontend/scripts/check-3d-layout.mjs`.

---

### 3D-07 — Instanced board, contact shadows, sticks

**Goal.** Render the whole layout in one tile draw call, grounded and lit.

**Depends on:** 3D-04, 3D-05, 3D-06.

**Deliverables**

- `boardMesh.ts`: one `InstancedMesh` (capacity 320), per-instance matrix,
  `aAtlasRect` (vec4), `aFlags` (face-up / highlighted / dimmed), and a per-instance
  atlas page if pages are ever needed (not in v1).
- `shadows.ts`: one instanced quad draw with a procedural rounded-rect alpha
  texture, scaled per tile, anchored under each grounded tile.
- `sticks.ts`: one instanced mesh for riichi sticks.
- **One framing source** (§2.4): the scene's camera is
  `boardLayout.frameForAspect`, `cameraRig.ts` is reduced to the
  `PerspectiveCamera` adapter, its duplicate distance/shift solver is deleted,
  and the felt is re-sized from that frame.

**Acceptance criteria**

- The rendered camera equals the solved frame (eye, pitch, field of view and
  projection shift) and no second camera solver remains in the renderer; the
  felt still reaches the top and bottom edges at every supported aspect under
  the new frame.
- One tile draw call for the whole board (wall + foreground, ≤ 320 instances);
  `measure()` reports `instances`, `triangles`, `drawCalls` and a test asserts
  `drawCalls ≤ 4` in the default debug-off scene.
- Face-up tiles show their face; face-down wall and opponent hands show backs;
  riichi/meld call tiles are rotated 90° about the vertical axis and their faces
  stay upright relative to their own body (no special-case glyph rotation — a
  structural advantage of real 3D over the 2.5D shell set).
- Per-instance matrices contain no NaN/Inf and every instance is inside the mat
  bounds (a numeric assertion on the packed buffer).
- Highlighted discards are visually distinct by a numeric probe (their instance
  flag is 1 and the shader's highlight range is set); dimmed tsumogiri tiles
  likewise.
- Contact quads are depth-tested, depth-write off, and never overdraw a tile
  body (a render-order assertion plus a user check).

**Gate:** frontend gate.

---

### 3D-08 — Interaction overlay and accessibility parity

**Goal.** Make the 3D view as usable as the top-down view for touch, mouse,
keyboard and screen reader.

**Depends on:** 3D-07.

**Deliverables**

- `hitTest.ts` (in `three/`, because it uses the camera): pure world-OBB →
  CSS-rect projection (`hitRects()`).
- `overlay.tsx`: absolutely positioned buttons for hand and draw tiles, plus a
  focus ring, hover lift callbacks, and reduced-motion handling.
- Tests that compare this view's accessible surface with `PhysicalTable`'s.

**Acceptance criteria**

- The overlay is positioned against the **full-window stage** (3D-02, §2.1): the
  buttons sit on the scene, not inside a card. This unit lands the first part of
  the floating UI; 3D-14 re-mounts the rest of the chrome (header, action bar,
  hand dock, cards) as the same kind of layer, and the two must not capture each
  other's pointer events.
- Exactly one button per hand tile plus the draw when present; zero when the
  hand is locked (answered), matching `HandDock`.
- Labels and order are identical to the top-down hand's accessible names for the
  same state (a drift test, not a copy); `aria-pressed`/riichi/kan controls stay
  in the existing action bar, not in the 3D overlay.
- Hit targets are ≥ 44 × 44 CSS px after projection, or expanded to that size
  while staying within the tile's cell so neighbours do not overlap.
- Keyboard: Tab reaches the hand in order, Enter/Space discards, Escape is
  untouched; focus is visible; after answering, focus stays somewhere valid.
- Resize/orientation change recomputes rects; no stale button survives a
  snapshot change; a test toggles 9:16 ↔ 16:9 and asserts the rects move (the
  3D stage is the window, so the window's own aspect drives this).
- The canvas stays `aria-hidden`; the table has an accessible name and a
  description that names the current view.
- Clicking a button calls the same handler the top-down/stacked views call; the
  answer flow has no renderer dependency (answers work with the renderer
  disposed).
- The buttons land on the tiles: `hitRects()` and the rendered instance
  transforms both come from `frameForAspect` on the same `BoardLayout` (a drift
  test projects the hand OBBs through the frame and compares).

**Gate:** frontend gate.

---

### 3D-09 — Compass and table chrome overlay

**Goal.** Put the table's numbers where the top-down view puts them, without
3D text.

**Depends on:** 3D-07.

**Deliverables:** `overlay.tsx` compass: four seat groups (wind glyph, score,
riichi marker) and a centre group (round, tiles left), anchored to the compass
well by the camera projection; a 3D riichi stick per declarer, with the
accessible marker on that seat.

**Acceptance criteria**

- Values and labels match `PhysicalTable`'s compass for the same state, asserted
  by a drift test (wind names, scores, round, `tiles_remaining`, riichi).
- The overlay is centred on the projected compass well within 2 % of the
  **window** (the 3D stage is full-window, §2.1), at every supported aspect, and
  never covers the human hand's buttons or the overlaid chrome.
- The overlay does not capture pointer events outside its own labels (the canvas
  and hand buttons stay reachable).
- Riichi sticks: exactly one 3D stick per seat whose `riichi` flag is true,
  matching `PhysicalTable`'s per-seat stick; the pot count (`compass.riichiSticks`)
  stays where it is today (the table info drawer) and is not duplicated on the 3D
  table.

**Gate:** frontend gate.

---

### 3D-10 — Carve calibration: light-space self-shadow, debug modes, step tiers

**Goal.** Finish the carving: micro-shadow the groove walls, make the parameters
observable, and lock the per-tier step counts against the measured budget.

**Depends on:** 3D-05, 3D-07, 3D-S1 (or the §2.8 defaults).

**Deliverables**

- Light-space self-shadow march in `tile.frag.ts` (4 steps high / 2 balanced / 0
  compat), depth/strength calibration uniforms, and the final tier step table.
- `?debug=albedo|height|normal|steps|pom-off|wireframe`.
- A source-contract test for the tier step table and the flood-state of the
  debug path.

**Acceptance criteria**

- Steps are exactly the tier's number (12/8/0 for depth, 4/2/0 for the shadow
  march) at runtime and in `measure()`.
- Debug modes change only shading and never the layout, the hit rects or the
  snapshot; each mode's readout prints its numeric legend.
- `?debug=pom-off` matches the `POM_STEPS = 0` baseline within the probe
  tolerance on a full board.
- Calibration never moves the parallax bound above the 8-texel gate from 3D-05.
- **Handoff:** the hero, a pond row and a full wall at 4K, with steps 0 vs 12 and
  self-shadow off vs on; ask whether the ink reads behind a lit near wall and
  whether the shadow is too strong on the small glyphs. Record verdict.

**Gate:** frontend gate + user verdict.

---

### 3D-11 — Quality tiers, capability tiering and fallback

**Goal.** Never be the reason a device feels broken.

**Depends on:** 3D-02, 3D-10 (tier plumbing may start after 3D-02).

**Deliverables**

- Tier resolution (URL > stored > auto), DPR/area cap, frame-time EMA
  downgrade, context-loss policy, `prefers-reduced-motion` wiring, the
  "3D unavailable" explanation in the view control.

**Acceptance criteria**

- `effectiveDpr` never yields a backing store above 8.29 MP, tested across
  320 × 640 → 5120 × 2880 and DPR 1/1.5/2/3.
- Auto tier: touch-primary or small-viewport devices start at `compat`; a device
  with a discrete/high-performance hint and a large viewport starts at `high`.
  Explicit `?quality=` always wins.
- Frame time above 25 ms for 2 s downgrades exactly one tier, logs once, and does
  not oscillate (no upgrade in the same session unless the user asks).
- At `compat` with > 33 ms for 2 s, the host reports `degrade`, records the
  reason in `sessionStorage` so the next mount does not auto-try, and returns to
  the previously selected view with a dismissible notice.
- `prefers-reduced-motion: reduce` removes the deal-in and hover lift; the POM
  and layout are unchanged.
- Context loss twice in a session → fallback, remembered for the session.
- A missing WebGL2 makes the 3D option disabled with a title explaining why, and
  never persisted.

**Gate:** frontend gate.

---

### 3D-12 — Motion: hover, deal-in and the event seam

**Depends on:** 3D-07, 3D-08.

**Goal.** Motion that cannot mislead: no invented moves, no blocked input.

**Deliverables**

- Hover/focus lift (≤ 4 mm, 120 ms), a bounded deal-in (≤ 400 ms) on a revision
  change, and `playEvents()` with damped-spring tile flight math (unused in v1).
- Tests for the diff rule "new revision = cut".

**Acceptance criteria**

- No animation is ever triggered by a non-revision snapshot change (a state
  update that is not a new deal is a no-op for positions).
- A revision change plays the deal-in once; reduced motion plays nothing.
- `playEvents()` supports `draw`/`discard`/`meld`/`flip` with deterministic,
  unit-tested interpolation (start/end transforms, monotonic time, no overshoot
  through the felt plane); it is not called by the host in v1, and a test proves
  the host never calls it.
- Answers remain correct and immediate while an animation runs; a test submits an
  answer mid-animation.
- The renderer's clock is injectable (`now()`); tests run without real timers.
- After any animation the scene settles to exactly the layout's transforms.

**Gate:** frontend gate.

---

### 3D-13 — Performance budget and measurement harness

**Depends on:** 3D-07, 3D-11.

**Deliverables**

- `frontend/scripts/check-3d-budget.mjs` (dependency-free) and `perf.ts` + the
  perf HUD (`?perf=1`).
- A measurement protocol paragraph in this plan (resolution, DPR, tier, browser,
  warm/cold).

**Acceptance criteria**

- The script prints and asserts: three atlas byte counts (must match
  `relief.json`), GPU bytes per tier, instance and triangle counts, draw calls,
  lazy-chunk gzip size, and that `three` appears in no entry chunk (it inspects
  `dist/` after `npm run build`).
- The chunk gate is advisory at ≤ 200 KB gzip and fails the script only if
  `three` leaks into the entry chunk or the chunk is missing.
- The HUD reports tier, DPR, backing-store MP, steps, draw calls, frame p50/p95
  and instances; it is off by default and costs nothing when off.
- The script exits non-zero on: an atlas hash/size drift, a missing atlas, a
  draw-call ceiling breach, or a leaked three import.
- The protocol is recorded here and used for the 3D-15 report.

**Gate:** `npm run build && node frontend/scripts/check-3d-budget.mjs`, plus the
frontend gate.

---

### 3D-14 — View switch integration

**Depends on:** 3D-08. Soft: 3D-11 (unsupported/fallback story), 3D-13 (budget
gate). Nothing from the 2.5D chain: the 3D view is its own `TableView` value and
does not wait for the 2.5D rendered view.

**Goal.** Make the 3D view a first-class, reversible choice.

**Deliverables**

- `TableView` gains `'rendered3d'`; `AppControls` lists it with an unsupported
  reason when unavailable; `App.tsx` mounts it in the same table slot; the
  existing view tests extend; AGENTS.md §4's view list is updated to name the
  fourth view.
- A single `RENDERED3D_EXPOSED` constant keeps the option out of the picker (the
  query flag still works) until 3D-15 flips it.
- **The full-window stage becomes reversible** (user guidance 2026-11-18): the
  shell modifier that drops the phone-width column and fixes the 3D backdrop is
  applied only for the 3D value, and switching away removes it *and* leaves
  full screen (never leaves the user in a full-screen 2D view).
- **The floating UI layer** (user guidance, revised 2026-11-18): re-mount the
  app chrome — header controls, status cards, the action bar and the hand dock —
  over the scene in Z order instead of in the document flow above/below it, and
  mount the full-screen toggle (`components/FullscreenButton.tsx`, built in
  3D-02) in that layer. The scene-only interim (§2.1) ends with this unit.

**Acceptance criteria**

- Switching stacked ↔ topdown ↔ (rendered) ↔ rendered3d keeps the same
  `GameState`, the same selection/answer state, and does not re-deal (a test
  asserts the state object is identical across switches).
- Switching into and out of 3D adds/removes the shell's 3D modifier exactly
  once; after leaving, the stacked/top-down layout is byte-for-byte the same
  structure it had before (the stage is no longer fixed, the column width is
  back), and `document.fullscreenElement` is null.
- In 3D, the chrome is mounted *over* the fixed stage (DOM/stacking assertions,
  no Y-flow siblings of the canvas), every chrome control still works, and the
  full-screen toggle is present exactly when the API is.
- The 3D view (once `RENDERED3D_EXPOSED`) persists across reload when selected and
  supported; when it later becomes unavailable the stored value falls back
  **without** rewriting the user's choice (so a temporarily unsupported device
  does not lose it).
- `?renderer=3d` still overrides, and `?renderer=25d`/absence does not force
  anything beyond the stored view.
- Switching away disposes the GPU resources (resource-count test) and switching
  back restores the same board (a screenshot-free structural assertion).
- The 2.5D rendered view, when present, keeps its own value and is not renamed.
- No `2_5d_*`, `tools/render/*` or `frontend/src/table/*` diff.

**Gate:** frontend gate.
**Merge note:** the highest-contention unit for *conflicts* (the same
`App.tsx`/`useSettingsStore.ts`/`AppControls.tsx` files as the parallel 2.5D view
work). It has no dependency on that work; merge order is a normal judgement call
and any conflict is hand-resolved.

---

### 3D-15 — Full-board verification, calibration and sign-off

**Depends on:** 3D-08, 3D-09, 3D-11, 3D-12, 3D-13, 3D-14.

**Deliverables**

- A deterministic stress state fixture (all zones full, all 37 faces, four
  riichi, a kan, three-row rivers, a claimed discard, answered and unanswered
  variants).
- Flipping `RENDERED3D_EXPOSED` is part of this unit, and only after the checks
  below pass.
- A verification report appended to this plan: counts, framing numbers, budget
  numbers, the five-aspect matrix, the a11y checklist, and the user's verdicts.
- Screenshots/artifacts for the user under a committed or build-ignored path
  (never used as agent evidence).

**Acceptance criteria**

- Stress state renders every zone with the expected tile counts; no NaN, no
  overlap, no missing face; the same state through stacked, top-down and 3D
  yields identical accessible answers and compass values.
- Five aspect ratios **at the window's own size** (the 3D stage is the window,
  §2.1): framing gate green, hand buttons reachable, no overlay collision, and
  the overlaid chrome (header, action bar, hand dock, compass) never covers a
  hand/draw hit target.
- Full screen: the toggle works in a real browser, the scene re-fits to the new
  window size, the overlay re-projects, and leaving full screen restores the
  layout without a re-deal.
- `check-3d-layout.mjs` and `check-3d-budget.mjs` green; the frontend gate green;
  the Rust gates unaffected.
- Keyboard-only pass: reach the hand, discard, hear the result, reach Next
  Scenario.
- Screen-reader check: the table announces round, scores, tiles left and the
  hand; no orphan focus stops.
- **User handoff** on the finished board: full-window table at 16:9 and 9:16 and
  in full screen, POM on and off; ask for the accept/reject on spacing, felt,
  hand recline, compass placement, chrome-over-scene composition and carving
  strength, and record it.

**Gate:** all scripts + frontend gate + user verdict recorded.

---

### 3D-16 — Architecture record and docs

**Depends on:** 3D-15.

**Deliverables**

- `3d_renderer_architecture.md`: decisions as built, the actual numbers, the
  asset channel table, the tier table, the measurement protocol, known limits.
- `THIRD_PARTY_NOTICES.md` with the Three.js MIT notice; README's view list and
  AGENTS.md §4 updated to the four views; this plan marked implemented with
  deviations listed.
- A recorded note on the stale `relief-spec.json` prose (17.92 mm vs 20.89 mm),
  written as information for whoever owns that file. It is not a request and
  nothing in the 3D chain waits for it.

**Acceptance criteria**

- A new contributor can find, from AGENTS.md, the plan, the architecture record,
  the two scripts and the asset provenance.
- The record's numbers match the harness output on the landing commit.
- No AGPL tool mentioned as used; Three.js version recorded exactly.

**Gate:** frontend gate (docs-only diff otherwise).

---

## 7. Proposed command-center slicing

One task per unit, all `worktree` on `riichiprac`, created wave by wave (not all
at once). Titles are the proposed task titles.

| Unit | Proposed title | Depends on |
| --- | --- | --- |
| 3D-01 | 3D R1: snapshot contract, capability probe, feature gate | — |
| 3D-02 | 3D R2: lazy three.js host, lifecycle, empty felt scene | 3D-01 |
| 3D-03 | 3D R3: relief asset bridge and procedural fallback | 3D-02 |
| 3D-04 | 3D R4: procedural beveled tile geometry | 3D-01 |
| 3D-05 | 3D R5: hero tile — material, lighting and POM | 3D-02, 3D-03, 3D-04 |
| 3D-S1 | 3D S1: POM cost measurement on real hardware | 3D-05 |
| 3D-06 | 3D R6: world-space board layout and drift check | 3D-01 |
| 3D-07 | 3D R7: instanced board, contact shadows, sticks | 3D-04, 3D-05, 3D-06 |
| 3D-08 | 3D R8: interaction overlay and accessibility parity | 3D-07 |
| 3D-09 | 3D R9: compass and chrome overlay | 3D-07 |
| 3D-10 | 3D R10: carve calibration, self-shadow, debug modes | 3D-05, 3D-07, 3D-S1 |
| 3D-11 | 3D R11: quality tiers, downgrade and fallback | 3D-02, 3D-10 |
| 3D-12 | 3D R12: hover/deal-in motion and the event seam | 3D-07, 3D-08 |
| 3D-13 | 3D R13: performance budget and measurement harness | 3D-07, 3D-11 |
| 3D-14 | 3D R14: view switch integration | 3D-08 |
| 3D-15 | 3D R15: full-board verification and sign-off | 3D-08, 3D-09, 3D-11, 3D-12, 3D-13, 3D-14 |
| 3D-16 | 3D R16: architecture record and docs | 3D-15 |

Creation pattern (one wave at a time):

```bash
cc-task new "3D R1: snapshot contract, capability probe, feature gate" \
  --open --type worktree --repo riichiprac <<'EOF'
Implementation unit 3D-01 from 3d_renderer_implementation_plan.md. Read the
plan, implement only this unit, and run its gate. Do not touch the 2.5D
pipeline (2_5d_*, tools/render/*, frontend/src/table/*).
EOF
```

Every task body should repeat the 2.5D non-touch list and the AGENTS.md §6 rule;
the units that end in a handoff (3D-05, 3D-10, 3D-15) must say so in the task
body so the session does not self-approve a look.

**Ordering recommendation.** Start wave 0 + wave 1 (3D-01, then 3D-02/04/06 in
parallel). 3D-14 can land as soon as 3D-08 is done; it is only a merge-conflict
risk against the parallel 2.5D view work, not a sequencing dependency, so rebase
and resolve rather than wait.

---

## 8. Verification gates

Shared commands, defined once; unit gates refer to them.

```bash
# Full app gate. The 3D units change no Rust, so these must stay green untouched.
cargo fmt --check
cargo test --lib
cargo clippy --lib --tests -- -D warnings
cargo check --target wasm32-unknown-unknown

# Frontend gate.
cd frontend && npm test && npm run build && npm run lint

# 3D layout gate (dependency-free, no GPU).
node frontend/scripts/check-3d-layout.mjs

# 3D budget gate (needs a build; no GPU).
cd frontend && npm run build && node scripts/check-3d-budget.mjs
```

If a baseline gate is already red on `main` for an unrelated reason, record it in
the unit's report and do not "fix" it inside a 3D unit.

A unit is not done unless: its own acceptance criteria are met, its gate list is
green, its handoff (if any) is recorded with the user's verdict, and it states
which files it touched.

---

## 9. Risks and decisions

| # | Risk | Likelihood / impact | Mitigation | Owner |
| --- | --- | --- | --- | --- |
| R1 | POM does not fit the frame budget on the target hardware | medium / medium | tier step counts, 0-step/`pom-off` kill switch, self-shadow off at balanced/compat, 3D-S1 measures the built shader and 3D-11 downgrades automatically | 3D-10, 3D-11 |
| R2 | Face-map sampling and the committed plate: 256 × 340 is ≈1.6 texels per screen pixel at 4K (oversampled within the 8.29 MP cap), but `relief-spec.json`'s prose says the plate is 20.89 mm while the committed `plateUnits`/cell rects say 17.92 mm | low / low | Ship on the committed plate (17.92 mm); **no rebake** (user decision 6); log the prose discrepancy for the 2.5D owner as information, not as a request | 3D-03 |
| R3 | Three.js version churn breaks shader/instancing APIs | low / medium | exact pin, no addons, upgrade only as an explicit task with a budget + look re-check | 3D-02, 3D-16 |
| R4 | Merge contention with the parallel 2.5D view work in `App.tsx`, `useSettingsStore.ts`, `AppControls.tsx`, `AGENTS.md` (conflicts, not dependencies) | high / low | keep the 3D diff to the mount point; rebase and resolve by hand; neither chain waits for the other | 3D-02, 3D-14 |
| R5 | Mobile GPU memory (58 MB atlas + existing 43 MB model) or thermal throttling | medium / medium | compat tier half-res, 0 POM, on-demand frames, 30 fps floor, auto-fallback remembered per session | 3D-11 |
| R6 | The wall is decorative, so a "full wall + 14-tile hands" picture is physically impossible | certain / low | documented; depletion needs a Rust wall census, out of v1 (non-goal) | plan |
| R7 | The DOM overlay drifts from the 3D camera (buttons not aligned with tiles) | medium / high (usability) | single projection source (`hitRects()`), tests at two aspects, user check on the final board | 3D-08 |
| R8 | Shading/looks cannot be verified in CI | certain / medium | numeric probes for colours and POM displacement, debug modes, explicit user handoffs, no self-approval | all |
| R9 | A new runtime dependency is more than the repo wants | low / medium | lazy chunk, budget gate, exact pin, MIT notice; the renderer interface keeps the choice reversible | 3D-02, 3D-16 |
| R10 | Both renderers load the relief atlases at once (double GPU memory) if a view ever mounts both | low / medium | only one table is mounted at a time (structural test in 3D-14); dispose drops textures | 3D-14 |

**Decisions recorded with the user (2026-11-18)** — all seven are settled; they
are binding on the units, not open questions.

1. **Exposure: behind the flag.** The 3D view stays reachable only by
   `?renderer=3d` until 3D-15 signs it off; `RENDERED3D_EXPOSED` flips only then,
   and it is never the default.
2. **Camera: adopt the v13 whole-table rig.** 75 mm on a 36 mm gauge, 50° pitch,
   X = 0, 76 units, with the aspect/portrait solver. No new framing is
   commissioned.
3. **Hand: keep the recline already settled, no rail.** 40° back from upright
   (the reference rig's readable pose), no near rail or other added geometry.
   The only gate is the numeric face-to-view angle (≤ 25°).
4. **Carving: start with POM.** POM is built in 3D-05 with the hero tile, not
   added later; 3D-10 is calibration and self-shadow. The 0-step kill switch and
   the tier step counts still exist, so "POM off" remains a supported mode.
5. **Concurrency: run in parallel with the 2.5D chain.** The two chains share no
   units and neither waits for the other; the only overlap is ordinary merge
   contention in `App.tsx`/store/controls (R4), resolved by hand.
6. **Face resolution: no rebake.** The committed 256 × 340 maps are kept. Under
   the 8.29 MP backing-store cap a tile is ≈208 px on screen at 4K against a
   340 px map (≈1.6 texels/px, oversampled); the map would only become
   undersampled above a ~6,280 px-wide backing store, which the cap forbids. A 2×
   rebake would cost ≈176 MB raw / ≈234 MB with mips for no visible gain, and is
   not planned. If it is ever wanted, it is a 3D-owned offline task, not a request
   to the 2.5D chain.
7. **Full-window stage, no UI around it, floating UI later** (added and revised
   2026-11-18, while 3D-02 was in progress). The 3D display takes the whole
   browser window and the full height of the screen. **No UI panel sits above or
   below the canvas (no Y-flow siblings).** The UI that follows — header
   controls, status cards, action bar, hand dock, the hand/draw buttons (3D-08)
   and the compass (3D-09) — is planned as a **floating layer over the scene**
   (Z order, like a typical game HUD), not as elements outside the canvas.
   Until that layer exists, 3D-02 mounts **the scene alone**; 3D-14 re-mounts the
   chrome as the floating layer, mounts the full-screen toggle (Fullscreen API,
   promoting the shell so the layer travels with the scene) and restores the 2D
   layout — including leaving full screen — when the user switches away. The
   stacked and top-down views keep their existing layout throughout.

**Chain independence (recorded).** No 3D unit depends on 2.5D work, and no 2.5D
unit depends on 3D work. The 3D chain reads the *already committed* relief
manifest and atlases as immutable inputs (§2.5) and validates them by hash; a
2.5D rebake cannot silently change the 3D result — it either matches the pinned
manifest or the 3D view falls back to the procedural cell and reports it. The
table/camera constants are owned by 3D (`layoutConstants.ts`); comparing them
against `table-reference-spec.json` is an optional local `--reference` run, not a
CI gate, so a 2.5D edit cannot turn the 3D gate red.

---

## 10. Related docs

- [`AGENTS.md`](AGENTS.md) — project rules, including §6 (no agent visual
  sign-off) and §4 (view modes).
- [`2_5d_mahjong_tile_rendering_architecture.md`](2_5d_mahjong_tile_rendering_architecture.md)
  — the parallel renderer; §12b is the Task 4B relief bake this plan consumes,
  §16 is the whole-table calibration rig.
- [`2_5d_implementation_plan.md`](2_5d_implementation_plan.md) — the task shape
  this plan mirrors; its non-goals and file ownership apply.
- [`tools/render/relief-spec.json`](tools/render/relief-spec.json),
  [`tools/render/table-reference-spec.json`](tools/render/table-reference-spec.json),
  [`tools/render/shell-spec.json`](tools/render/shell-spec.json) — the committed
  numbers (read-only for this chain).
- [`replay-implementation-plan.md`](replay-implementation-plan.md) — the
  document skeleton, unit table and gate conventions.
- [`hosting-plan.md`](hosting-plan.md) — the Pages / R2 / Hugging Face pattern
  the 3D path deliberately does not extend.

---

## Appendix A — What changed from the initial plan

The starting proposal was a reasonable six-phase sketch. It was accepted where
it was right and corrected where the repository or the browser facts disagree.

### Accepted

- The overall goal and the non-destructive parallel-renderer stance.
- True 3D with POM as the carving technique, and the reasoning for it (baked
  sprites multiply by orientation; a 2D emboss breaks on rotated tiles).
- A single instanced tile draw with per-instance atlas rects.
- A locked one-point-perspective camera rather than an orbitable one.
- Procedural out-of-the-box capability plus a path to offline bakes.
- The per-face height/normal/AO/roughness decomposition — though its channels
  are taken from the already-committed bake rather than re-generated.
- Debug shader modes as the way to tune carving.
- Quality tiers, including a no-POM compatibility tier.

### Corrected, and why

1. **Animation model.** The proposal assumes an event stream and
   `enqueueAnimation()`. The app has none: every `GameState` the frontend sees is
   a new position, and answering does not move tiles. Diff-based animation would
   invent moves. v1 therefore has hover + a bounded deal-in; rigid-body
   draw/discard/flip exists only as unit-tested math behind `playEvents()` for a
   future live/replay source.
2. **A second carving baker.** Task 4B already ships exactly height, tangent
   normals, cavity AO, roughness, albedo and a paint mask for all 37 faces at
   256 × 340, plus per-face rects and measured statistics. Building a Canvas/SVG
   baker would duplicate it and create two sources of truth. The 3D path consumes
   the committed atlases and keeps only a procedural *fallback* cell. This also
   means **no new runtime assets**.
3. **Tile proportions.** 26 × 19.5 × 16 mm is replaced by the committed
   28 × 21 × 16.5 mm (height × width × thickness), 1 unit = 28 mm, 0.055-unit
   bevel, 0.64 × 0.89-unit face plate. Two renderers with different tile sizes
   would read as two different games.
4. **Haku's "un-inked rectangular border".** The committed face art has no
   printed symbol for Haku and bakes to zero ink; a carved blank frame would
   invent a motif. Haku is a bare ivory face in both views.
5. **POM sequencing.** The proposal put POM in Phase 4 of 6. My first draft
   deferred it behind a no-carve board; the user's 2026-11-18 decision is to start
   with carving. POM is therefore built in the hero-tile unit (3D-05) and is on
   the critical path, while keeping the parts that de-risk it: a 0-step kill
   switch, tier step counts, and a numeric parallax bound. "POM later" is gone;
   "POM that can be turned off" is not.
6. **"60 fps at native 4K with DPR up to 2."** That is a 33.2 MP backing store.
   The budget is capped at 8.29 MP with an area-based DPR rule, and the
   projection shows why that is the defensible number.
7. **Camera numbers (28–32° FOV, 54° pitch).** Replaced by the already
   user-signed-off v13 rig (75 mm on a 36 mm gauge, 50° pitch, X = 0, 76 units,
   negative shift), plus an aspect solver and a portrait preset. The 2.5D
   reference is the only calibrated camera in the repo; inventing a second one
   would be a regression.
8. **The `BoardRenderer` interface.** Trimmed to `syncState`/`setSize`/
   `setQuality`/`hitRects`/`playEvents`/`measure`/`dispose`. No promise-returning
   `mount` or `enqueueAnimation`; the host owns loading and the renderer owns its
   clock. The 2.5D compositor is **not** required to adopt this interface for the
   3D view to land; that is a later, optional refactor (and would touch owned
   files).
9. **Directory.** `src/rendering/` becomes `frontend/src/renderers/`, because the
   app lives in `frontend/` and `frontend/src/table/` is the 2.5D owner's.
10. **Toggle.** The proposal's `?renderer=3d` / `?renderer=25d` is kept as a query
    override, but the durable control is the existing View setting gaining a
    fourth value; the view stays behind the query flag until 3D-15's sign-off, and
    it is never selected automatically.
11. **Shadow maps.** Not used. Contact grounding is one instanced blob-quad pass
    plus the shader's carved self-shadow. A ~280-caster map at 8 MP costs more and
    looks worse on a mat.
12. **Debug overlay as shipped UI.** The proposal's six-mode overlay with live
    sliders is a tuning tool, not a feature. It becomes query-parameter debug
    modes plus an off-by-default perf HUD.
13. **Accessibility.** Unaddressed in the proposal. The canvas is
    `aria-hidden`; hand/draw tiles are positioned DOM buttons labelled exactly
    like the top-down view; the compass is DOM. Parity is tested, not asserted.
14. **Tests and the toggle.** Unaddressed in the proposal. jsdom has no WebGL, so
    the plan splits pure/DOM/user verification, forbids headless-GPU CI, and adds
    a budget script that proves `three` never enters the entry chunk.
15. **Verification criteria.** The proposal's acceptance criteria are all visual
    ("visibly shifts", "crisp", "clearly"). Under AGENTS.md §6 those are not
    verifiable by an agent. Every one is now either a number/script or an
    explicit user handoff with a named question.
16. **WebGPU, glTF, KTX2.** Rejected explicitly (coverage, needless loader and
    asset pipeline, new licence surface) rather than left open, so they do not
    return as phases.
17. **A table model.** The proposal implies a table frame and HUD in 3D. The
    scene is one felt plane plus a CSS vignette; the compass is DOM. This keeps
    the two renderers consistent about where information lives and avoids 3D
    text entirely.
18. **Wall depletion.** Considered and rejected: `tiles_remaining` is a draw
    count, not a per-slot census. Drawing a full decorative wall (as the 2.5D
    view does) is the honest option until the engine publishes wall occupancy.
19. **State ownership.** The proposal has the renderer consume an unspecified
    "board state". The plan specifies a typed, immutable `TableSnapshot` produced
    only by a pure adapter, with a revision that distinguishes a new position
    from an in-place update, and no per-frame WASM.
20. **Licensing/hosting.** Three.js's MIT notice, the exact-pin policy, and the
    "no new hosted assets" conclusion are added; the proposal was silent on both.
21. **Chain independence.** My first draft made 3D-14 wait for the 2.5D view
    tasks and treated a hi-res rebake as a 2.5D request. Both are removed by the
    user's 2026-11-18 decision: no 3D unit waits for 2.5D work and nothing is
    asked of it. The remaining coupling is read-only, hash-validated inputs and
    3D-owned constants; a 2.5D change can degrade the 3D view to its fallback but
    cannot break it and cannot turn its gate red.

---

## Appendix B — Unit-to-path map

| Unit | Primary paths |
| --- | --- |
| 3D-01 | `frontend/src/renderers/{contract,snapshot,capabilities,layoutConstants}.ts` |
| 3D-02 | `frontend/src/renderers/{RendererHost.tsx,three/{index,Scene,cameraRig,felt}.ts}`, `frontend/src/components/FullscreenButton.tsx`, `frontend/src/App.tsx`, `frontend/src/App.css`, `frontend/package.json` |
| 3D-03 | `frontend/src/renderers/three/reliefAssets.ts` |
| 3D-04 | `frontend/src/renderers/three/tileGeometry.ts` |
| 3D-05 | `frontend/src/renderers/three/{tileMaterial,lighting,probes}.ts`, `.../materials/tile.{vert,frag}.ts` |
| 3D-06 | `frontend/src/renderers/three/boardLayout.ts`, `frontend/scripts/check-3d-layout.mjs` |
| 3D-07 | `frontend/src/renderers/three/{boardMesh,shadows,sticks}.ts` |
| 3D-08 | `frontend/src/renderers/three/hitTest.ts`, `frontend/src/renderers/overlay.tsx` |
| 3D-09 | `frontend/src/renderers/overlay.tsx` (compass), `three/sticks.ts` |
| 3D-10 | `frontend/src/renderers/three/materials/tile.frag.ts`, `debug.ts` |
| 3D-11 | `frontend/src/renderers/{capabilities.ts,three/perf.ts}` |
| 3D-12 | `frontend/src/renderers/three/motion.ts` (new), `RendererHost.tsx` |
| 3D-13 | `frontend/scripts/check-3d-budget.mjs`, `three/perf.ts` |
| 3D-14 | `frontend/src/store/useSettingsStore.ts`, `frontend/src/components/AppControls.tsx`, `frontend/src/App.tsx`, `AGENTS.md` §4 |
| 3D-15 | tests + this plan's verification report |
| 3D-16 | `3d_renderer_architecture.md`, `THIRD_PARTY_NOTICES.md`, `README.md`, `AGENTS.md` §4 |
