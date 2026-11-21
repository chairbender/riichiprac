# 3D renderer implementation plan and task sequence

Status: planning, checked in 2026-11-18; 2.5D references retired 2026-11-19.
Task: 261118-1340 ("3D renderer: review the plan and break it into tasks").

> **Post-merge note (2026-11-19).** The 2.5D render pipeline the early units ran
> beside was retired in task 261119-1637. Its docs (`2_5d_*`, `rendered-table-*`),
> `tools/render/*` bake pipeline and `frontend/src/table/*` runtime are gone from
> the working tree and live only in git history. References to them below are
> historical provenance for how the 3D numbers were signed off; the 3D chain now
> owns them in `frontend/src/renderers/layoutConstants.ts` and bakes its carve
> with `frontend/tools/relief3d/bake-relief3d.mjs`. `docs/2_5d-removal.md`
> records the keep/delete decision.

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
- **Replacing the accessible views.** The stacked and top-down views remain the
  documented accessible fallback and are one pick away in the View control. The
  3D view is the default from the user's 2026-11-20 decision (superseding D13);
  it is the signed-off camera and carve, not a modelled room, and a browser that
  cannot run it draws the stacked table.
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
| D13 | ~~The 3D view is opt-in and never the default~~ — **superseded 2026-11-20:** 3D is exposed and the default; the 2D views are options, the pick is remembered under its own key, and switching views never re-deals. | `TableView` + `RendererHost` + `resolveTableMount` tests | 3D-14 |
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

**Interim state (as of 3D-14's landing; superseded by 3D-H2 for the shell).**
Before the floating layer, the 3D mount rendered **the scene alone**: no header,
no cards, no action bar and no hand dock, so nothing occupied Y space around the
canvas. The 2D views keep their existing layout. 3D-14 made the view a
reversible `TableView` value and guarantees that switching away removes the
shell modifier and leaves full screen; 3D-H2 (landed 2026-11-19) mounts the
floating shell — the top bar's Next Scenario and full-screen controls — with the
HUD chain's rows still to come (3D-H3…H5).

A full-screen toggle uses the Fullscreen API on the **shell**, not on the
canvas, so the floating layer travels with the scene; it is rendered only where
`requestFullscreen` exists, and it reports the browser's own state rather than
guessing. Browsers that do not support the API simply get the full-window view.
The component was built and tested in 3D-02 and is mounted by 3D-H2's top bar;
leaving full screen on a view switch is 3D-14's, through `fullscreen.ts`.

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
├── hud/                  # the floating layer over the 3D stage (H2–H5)
│   ├── HudLayer.tsx      # layer root, top bar, sheet mount, toast root
│   ├── hudLayout.ts      # pure stage -> HUD rects + the collision helper
│   ├── Sheet.tsx         # modal primitive: scrim, focus trap, Escape, inert
│   └── …                 # ActionRail, HandRail, ResultCard, SetupSheet, VerdictSheet
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
| Mat | 25 units = 700 mm square; side wall runs at 6.875 (derived), end runs at 5.875 | layout reference; the drawn felt is a square sized per frame to reach the top and bottom edges (3D-02), wall ring |
| Tile | 1 unit = 28 mm; 21 × 28 × 16.5 mm; bodies **touch** (no groove) | tile mesh + layout pitch |
| Wall | 4 runs × 17 stacks × 2 tiers, 0.75 pitch (one tile), one missing top tile at slot 16 (draw end) | wall layout |
| Ponds | 3 rows × 6, nearest row at 4.81, then 3.81 and 2.81 (one tile apart), 4 overflow anchors on the near row | river layout |
| Human hand | 13 tiles + a draw slot at +5.5125, reclined about its far bottom edge | hand layout |
| Compass well | 4 units | compass overlay anchor |
| Camera | 75 mm on 36 mm, 50° pitch, X = 0, 76 units, negative Shift Y | reference lens/pitch; the shipped frame solves closer (see the revisions below) |

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
frame. No view may project through a second camera. *(Landed in 3D-07: the
solver is gone; `cameraRig.ts` is `applyFrameToCamera` plus pure projection
helpers, and `cameraRig.test.ts` proves a real `PerspectiveCamera` fed a frame
projects every sample point exactly as `boardLayout.projectPoint` does.)*

**Board handoff revisions (2026-11-18, after the first full board render).** The
user's verdict on the 3D-07 board changed four layout numbers; they are binding
and they supersede the reference values above where they differ.

- **The wall's top tier was wrong in 3D-06.** `WALL.tierStepUnits` already
  contains the lower tile's thickness plus the tier gap, and the layout added
  the thickness again, so the top row hovered 16.5 mm above the row it sits on
  ("the top row is not lined up with the bottom row"). `wallTierHeightUnits(tier)`
  is the one formula now (`thickness / 2` bottom, `tierStepUnits + thickness / 2`
  top); the layout, the dora indicators and `hero.ts` all call it.
- **Hands sit much closer to the wall.** `HAND.backRadiusUnits` 10.6 → **8.225**
  (8.35 before 3D-20 closed the pitches, which pulled the side runs in by 0.125),
  i.e. the hand's front edge is 24 mm in front of a **side** run's outer face
  instead of 24 mm in front of the mat edge. That is the floor: a side run
  occupies the band beside every seat's hand, so the hand cannot come further in
  without the two overlapping (the layout gate caught exactly that during the
  wall-ring change). `MELD.rowRadiusUnits` follows the hand, and extra meld rows
  now step **toward the player** (`+index * rowPitch`) — the doc always said
  "nearer the player", the code stepped inward, and with the hand at 8.225 that
  would put rows 2–3 inside the wall ring (the overlap the change surfaced).
- **The player's and the across player's hands sit a tile thickness closer.**
  `HAND.endSeatRadiusUnits` (7.6357) is one 16.5 mm thickness inside
  `HAND.backRadiusUnits` (8.225), and `boardLayout.handRadius(seat, humanSeat)`
  gives it to the human and the far seat only — they face the inset end runs, so
  they have the slack; the left/right seats keep 8.225 because their side runs
  are the floor. Their melds move with them (`placeMelds` takes the seat's own
  radius). Measured at 16:9: the solved distance drops **55.56 → 52.73** and the
  hand's long axis grows to **7.49 %** of the frame height. The hand's own
  bottom margin is 6.59 % in the all-melds fixture because a left/right seat's
  meld row runs along the near corner at its side radius and is therefore the
  board's nearest content — the hand cannot be lower while those stay in frame.
- **The wall ring is squared.** The front and back runs (the human's own edge and
  the far edge) sit at **`WALL.endRunRadiusUnits` 5.875**, so their outer face is
  flush with a side run's end tile at `WALL.runHalfLengthUnits` 6.375 — "their
  outside edge lines up with the edge of the left/right walls". The side runs'
  radius is **derived** from that length since 3D-20 (`6.375 + tileHeight / 2 =
  6.875`), which is what makes the corners shared edges rather than 1.1 mm slots.
  All four cannot share one radius: a 17-stack run already spans its whole side
  of the ring, so a smaller square would overlap two stacks at every corner. Consequence for the framing: the
  board's vertical extremes are the **hands** (z ±8.94) and the side players'
  meld rows, not the walls, so the camera stays at 55.56 at 16:9 — the wall move
  is composition, not extra zoom. `wallRunRadius(run, humanSeat)` is the one rule
  (the inset follows the human, so it also moves when the human seat changes),
  and the dora indicators ride the far run's inset radius.
- **The fit subject is the board, not the mat.** `framingPoints` is the tile
  corners; the 25-unit mat is no longer in the fit, so the mat crops and the
  felt (a procedural square sized from the frame) runs off the edges. The
  reference's 76-unit distance **floor is deleted**: it existed to keep the
  reference's mat framing and would pin the camera back, which is exactly the
  "too far away / tiles too small" the handoff named. The lens (75 mm on 36 mm),
  the 50°/62° pitch, X = 0 and the Shift Y are unchanged.
- **Result at 16:9:** solved distance **55.56** (was 76), hand long axis 7.12 %
  of the frame height (was 5.17 %), the human hand's lowest body point 3.82 %
  above the bottom edge, and every tile still inside the 2 % safe area. Other
  aspects: 72.64 at 21:9, 47.05 at 3:2, 44.14 at 4:3 and 1:1, 42.67 in portrait.
  `check-3d-layout.mjs` prints all of it and gates the hand's bottom sliver.
- **Side effect, accepted:** the frame is solved against the actual tiles, so a
  meld-heavy board (which reaches further to the player's right) solves slightly
  further back. A typical board is stable.

### 2.5 Assets: reuse Task 4B, do not bake twice

**Read AGENTS.md §3b first.** The 2.5D workspace already models the tile body and
the whole table in 3D (`shell-spec.json` + `bake_shells.py`,
`table-reference-spec.json` + `bake_table_reference.py`) and has the approved
carve look baked as decals (`decal-spec.json`). Those are the reference for this
chain's geometry, materials, poses and carve: take the numbers from them instead
of inventing a second set. The first 3D-05 handoff did not, and shipped a tile
with a made-up corner radius and a blue back plate instead of the shell's taped
blue side; the correction is recorded in §6 under 3D-05.

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

- Body: warm ivory `#f5f0eb` roughness 0.16 + coat 0.4, no map — the sides and
  bevels are geometry. Back: `#132986` roughness 0.18 + coat 0.35, coat
  roughness 0.1. **These are `shell-spec.json`'s materials**, not new ones, and
  the white/blue split is the shell baker's gate at 0.3 of the thickness (front
  30 % ivory side band, back 70 % blue plus the back plate) — see AGENTS.md §3b.
- Face: the three relief atlases (albedo + paint mask, normal + height, AO +
  roughness), carved faces with tiered POM, wrapped diffuse to fake resin
  translucency, GGX specular with the sampled roughness, AO multiply, plus the
  shell's coat lobe.
- Carve displacement is scaled, not physical: the approved 2.5D decals bake the
  same engraving as shading only, so the live `POM_HEIGHT_SCALE` keeps the
  silhouette from sliding; 0 is the decal-equivalent end and the hero view's
  depth sweep is how the scale is chosen (3D-05).
- One key light matching the 2.5D rig's authored key (azimuth 315°,
  elevation 55° → three-space direction `normalize(-0.406, 0.819, 0.406)`), so
  highlights land top-left in both views, plus a low hemisphere fill and a very
  weak ambient. No environment map, no IBL file, no post-processing.
- `outputColorSpace = SRGBColorSpace`, `toneMapping = NoToneMapping`. The 2.5D
  shells were baked through AgX; the 3D view is not required to match them
  pixel-for-pixel, only to be a plausible sibling. Matching is a user call.
- Context: `alpha: false`, `powerPreference: 'high-performance'`,
  `preserveDrawingBuffer: false`. **MSAA is on above the `compat` tier** since
  3D-20 (see §3D-20's "Landed" record), which reverses this section's original
  `antialias: false`: the committed 0.055-unit bevel and the 1.5 mm bevel valley
  between two touching tiles are 1-4 px at the reference solve, so without it
  every silhouette, bevel and seam edge was a hard step. The 3D-20 measurement is the justification (the
  hand's outer silhouette's largest one-pixel luma step falls 48 % at 1920 x 1080
  with MSAA on), and the cost is buffers only (+174 MB at the 8.29 MP cap) since
  MSAA does not multiply the per-pixel POM march.

### 2.7 Interaction and accessibility

The canvas is an image. Everything a user can do or must hear is DOM:

- Hand and drawn tile become absolutely positioned `<button>`s over the canvas,
  sized from the projected OBB with a 44 × 44 CSS px minimum, labelled exactly
  as `HandDock`'s tiles are, disabled when answered, in the same order.
- The compass (four seats: wind symbol, score; centre: round and tiles left;
  honba stays in the existing stage status line) is a DOM overlay
  with the same group/role/label structure as `PhysicalTable`'s compass, and a
  drift test compares the accessible names. Its **square** is real 3D table
  furniture laid on the felt (`three/compassPlate.ts`, one draw, sized to touch
  the innermost discard row on all four sides) so it obeys the camera; only its
  numbers and glyphs are DOM, superimposed in screen space and therefore never
  foreshortened. Each seat is one row with the wind glyph greyed to the left of
  the score; the visible score is Tenhou's split plate (the hundreds large, the
  trailing two digits small and grey) while the accessible name keeps the full
  score. The corners carry no stick icon (the 3D bar on the plate is the
  declarer's marker), but the corner name still ends ", riichi".
- Hover/focus lifts the tile in 3D (bounded, and applied under every motion
  preference because it is a discrete change) and never moves the button.
- Tile faces, rivers, melds and walls are decorative and not individually
  focusable — exactly as in the top-down view, where only the hand is
  interactive. A hidden heading names the view for screen readers.
- The interaction layer is a pure function of `TableSnapshot` + camera matrices
  (`hitTest.ts`), so it is unit-testable in Node without WebGL.
- **Chrome over the scene.** The stage is the whole window (§2.1). The floating
  HUD is the 3D HUD chain (3D-H1…H5), not a renderer unit; its shell landed in
  3D-H2 (the hand/draw buttons came in 3D-08, the compass in 3D-09), and the
  app chrome — header controls, status cards, the action bar and the hand dock —
  is positioned *over* the canvas in Z order, never in the document flow above or
  below it. No overlay may capture pointer events outside its own controls:
  clicking the felt (once anything is bound to it) and every chrome control must
  keep working. Floating panels keep their own backgrounds so they stay readable
  over the felt.

### 2.8 Performance budget, stated and justified

**Backing-store cap: 8.29 MP (3840 × 2160).** The initial plan's "native 4K
with devicePixelRatio up to 2.0" means a 7680 × 4320 backing store — 33.2 MP,
four times the pixels — with no legibility gain on a 4K display. The cap is
expressed as `min(devicePixelRatio, 2)` **and** an area limit:
`dpr_eff = clamp(min(dpr, 2), 1, sqrt(8.29e6 / (cssW · cssH)))`.
(The lower clamp was corrected in 3D-11: a CSS viewport larger than the budget
cannot be covered at DPR 1, so the ratio may fall below 1 — see 3D-11's as-built
note and `capabilities.TIER_BACKING_STORE`.)

| Tier | Backing store | POM steps | Shadow march | DPR cap | Target |
| --- | --- | --- | --- | --- | --- |
| high (desktop) | ≤ 8.29 MP | 12 | 4 | 2.0 | 60 fps (16.7 ms) |
| balanced | ≤ 4.67 MP | 8 | 2 | 1.5 | 60 fps |
| compat (mobile / weak) | ≤ 2.07 MP | 0 (normal + AO only) | 0 | 1.0 | 30 fps floor (33 ms) |

**MSAA (3D-20).** `high` and `balanced` ask for a 4x context; `compat` does not.
The tiers above are *resolved* (resolved-buffer) areas; the sample buffers they
imply at the cap are 4 x (colour 4 B + depth 3 B) = 232 MB against 58 MB, i.e.
+174 MB — buffers, not fill: the fragment shader (and so the POM march) still
runs once per pixel. `capabilities.backingStoreBytes(pixels, antialias)` states
the numbers and a unit test pins them.

**Self-shadow step count (3D-10, 2026-11-19).** This table originally said
3 / 2 / 0 for the shadow march, written before the shader existed. 3D-10's
deliverable, 3D-S1's fallback and the unit's gate all name **4 / 2 / 0**, so the
table now matches the shipped `SHADOW_STEPS`; see 3D-10's as-built note.

**Measured POM cost (3D-S1, 2026-11-19).** The 12 / 8 / 0 depth counts above
were an estimate when the table was written; 3D-S1 measured the built shader.
The harness is `frontend/scripts/check-3d-pom.mjs` (one command, no new
dependency): it mounts the real `TableScene` on the fixture board through Vite
and Chrome, ramps the GPU's clocks, then renders 0 / 8 / 12 / 16 depth steps in
alternating order and reads each six-frame batch's GPU time from
`EXT_disjoint_timer_query_webgl2`. Tier `high`, MSAA 4×, shadow march 4, DPR 1,
driver-reported buffer 3838 × 2159 at the 4K setting (the 8.29 MP cap).

| Backing store | 0 steps | 8 steps | 12 steps | 16 steps |
| --- | --- | --- | --- | --- |
| 1920 × 1080 (2.07 MP) | 11.3 ms | 13.2 ms | 11.9 ms | 11.0 ms |
| 3840 × 2160 → 3838 × 2159 (8.29 MP) | 15.4 ms | 15.5 ms | 16.6 ms | 15.3 ms |

Medians of 180 frames per cell, GPU timer query; CPU submission is a separate
0.07–0.12 ms/frame and is not in these numbers. Three repeats put every cell
inside ±1.5 ms of the table. The one signal that survives the noise is **+0.1
to +1.2 ms for 12 steps over 0 steps at 4K**; the other cells are within their
spread. Recorded per AGENTS.md §6 as numbers, not as a look.

Machine and conditions, because they bound the absolute figures: Intel
Graphics (MTL) iGPU on Meteor Lake-P, Mesa 26.2.6, Chrome 157.0.8103.78,
headless `--use-angle=gl` (renderer string
`ANGLE (Intel, Mesa Intel(R) Graphics (MTL), OpenGL ES 3.2)`); GPU clocks
observed at 600–1250 MHz against an 1850 MHz RP0 (the machine was on battery,
74 %, not charging), so these are a *lower bound* on a plugged-in run; load
average was 7–15 with a `mine_replays label` job and four other agent sessions
running. The probe ramps for 25 s and alternates the step order per iteration
so clock drift cannot land on one count; repeat runs move cells by up to
1.5 ms, which is why only the 4K 0→12 difference is stated as a result.

Consequences, recorded as the unit's decision (Decisions, §9 item 9):

- **Keep `high` 12, `balanced` 8, `compat` 0.** 16 steps is not worth a
  measured 0–1 ms: it is inside the noise at 4K and cost up to +2.4 ms in one
  1080p repeat. `compat`'s 0 is confirmed: a 4-step march would add under
  0.5 ms and does not change the tier's look, which 3D-10 shipped as
  `shadowSteps 0` too.
- **POM is not the frame-time driver at these counts.** The 0-step frame is
  already 9–11 ms at 1080p and ~15 ms at 4K, so the base shading (anisotropic
  sampling of the three relief maps, the 4-step self-shadow march and the 4×
  MSAA resolve at 8.29 MP) owns the budget. At 4K the shipped `high` frame sits
  ~0–2 ms under 16.7 ms on this machine, which is exactly why 3D-11's automatic
  downgrade is the mechanism that keeps the view usable; more POM steps are not
  where an optimisation would pay.

Method notes worth keeping for 3D-13's harness (each was measured, not
assumed): `gl.finish()` **does not wait** in Chrome's command buffer (a 32-frame
batch "finished" in 0.1 ms), and neither does `fenceSync` +
`clientWaitSync`; a query around a single presented frame brackets the gap to
that frame's flush and reports one display interval (16.7 ms at 1080p for 0 and
12 steps alike); and a timer query read in a spinning main-thread loop never
becomes available. The working shape is a multi-frame batch, an async
`QUERY_RESULT_AVAILABLE` poll, and a long clock ramp.

Draw calls: **5 in steady state** (tiles, contact shadows, riichi sticks, the
physical compass plate, felt) and a hard ceiling of **12** including debug.
Instances: one tile mesh with capacity **320**. Triangles ≤ 200 k (320 × ≤ 600
tris + environment).

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

*Correction after 3D-S1 (2026-11-19).* Item 1 above ranks the depth march first
on a fetch-count estimate; the measurement does not support it. Going 0 → 12
steps changed the GPU frame by +0.1 to +1.2 ms at 8.29 MP while the 0-step frame
was already ~15 ms, so the cost is in the *base* shading every tile pixel pays
(the three anisotropic relief samples, the self-shadow march and the MSAA
resolve), not in the number of depth steps. Items 2–5 keep their ranking as
hypotheses; item 1's rank is superseded by the section above.

**Measurement protocol (3D-13).** Every performance number quoted for this
renderer — in unit reports and in 3D-15's verification report — is taken the
same way, so two runs are comparable:

1. Serve the production build (`npm run build` then preview) and open
   `?renderer=3d&perf=1`. Record the browser and its version, and the GPU/driver
   string from `chrome://gpu` (or the platform equivalent).
2. Three viewports: **1920 × 1080 at DPR 1** (the reference frame the camera was
   solved against), **1366 × 768 at DPR 1** (a laptop), and **820 × 1180 at
   DPR 2** (a portrait phone). The HUD prints the *resolved* DPR and backing-store
   area, which is the number that matters: the tier cap may lower a 4K window's
   DPR to 1, or a 5K window's below 1.
3. Record the tier the HUD reports, and that tier's depth/self-shadow step
   counts. Do not hand-pick a tier for a report unless it is labelled as a
   pinned-tier run (`?quality=`).
4. **Warm vs cold.** A *cold* number includes the first frame after the lazy
   chunk's download, compile and texture upload; quote it only if it is labelled
   cold. A *warm* number is read after the board reports ready and the HUD shows
   at least `FRAME_STAT_WINDOW` (240) samples (about 4 s at 60 fps); the first
   5 s after mount are the cold window and are never quoted as the result.
5. Report **p50 and p95** frame time together, never a mean or a best frame. The
   60 fps target is p95 ≤ 16.7 ms; the `compat` floor is p95 ≤ 33 ms. Also
   record draw calls, instances and triangles from the HUD so a slow result can
   be attributed (fill vs instance count vs overdraw).
6. A run that trips the automatic downgrade is a real measurement of the lower
   tier, not of the one that was pinned: report the tier the HUD ends on, and
   say that a downgrade happened.

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
  readonly debug: DebugMode | null; // 'albedo' | 'height' | 'normal' | 'steps' | 'pom-off' | 'wireframe' | 'hero'
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
  plane, sized per frame** (`feltSizeForFrame` since 3D-07 made 3D-06's frame the
  only projection source, from the frame's top/bottom
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
  until the 3D HUD shell exists (3D-H2), because a header control is UI. Leaving
  full screen when the view changes lands in 3D-14 (`fullscreen.ts`).

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
  control and the stored-view fallback are 3D-14's).
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
(3D-08/3D-09), the view switch (3D-14), and the floating shell with its chrome
and the full-screen toggle (the 3D HUD chain, 3D-H1…H5).

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

**As built (3D-05, 2026-11-18; corrected the same day after the first
handoff).** Files: `three/{tileMaterial,lighting,hero,probes,reliefTextures}.ts`,
`three/materials/tile.{vert,frag}.ts`, the hero wiring in `three/Scene.ts`, the
debug HUD in `RendererHost.tsx`/`.css`, `contract.ts` (`DebugMode` gains `hero`,
the hero report/capture types, two optional debug methods on `TableRenderer`,
`pomSteps`/`heightScale` on the report), `capabilities.ts` (`hero` in
`DEBUG_MODES`), and tests for each. The hero view's four tiles are the real
committed deliveries at their real places: the human hand's centre slot
(reclined 40°), the human pond's nearest row (lying), the far wall's first dora
indicator (lying, oriented to the human) and a face-down wall top-tier tile
beyond the five dora stacks (blue back). One `InstancedMesh`, one material, one
draw — the shape 3D-07 scales.

**The body is the shell baker's, not an invented one** (AGENTS.md §3b). The
first handoff's tile was wrong in three ways and all three are now taken from
`bake_shells.py` / `shell-spec.json`: the silhouette corner radius is one bevel
(0.055 units = 1.54 mm) instead of an invented 0.1, so the inset glyph plate has
a (near-)sharp corner; the white/blue split is the baker's shader gate on local
Z at `backEdgeFraction` 0.3 of the thickness — the front 4.95 mm of the side wall
is ivory and the back 11.55 mm plus the whole back plate is blue, instead of a
blue back plate alone; and the finish is the shell's melamine (ivory 0.16 +
coat 0.4, backing 0.18 + coat 0.35, coat roughness 0.1) as a second GGX lobe,
instead of a flat 0.35/0.28. A numeric check on the exported back macro: the
face-down slot's near edge reads a 100 px ivory band under the blue side/back
band at 15 px/mm, i.e. the 4.95 mm / 11.55 mm gate.

**The carve is calibrated to the approved decals, not to the physical depth.**
The committed relief map describes a real 0.55 mm groove and its normal and AO
channels shade that in full, but the approved 2.5D carved decals
(`decal-spec.json`) bake the carve head-on as shading only, so their glyph never
slides. At the pond's 37° the full 0.55 mm depth moves a stroke edge by 0.41 mm
— a whole stroke width — which is what made the first handoff "way too
recessed". `POM_HEIGHT_SCALE` (0.25) now scales the *displacement* only: 1.5
texels at the pond, 0.6 at the hand, 1.9 at the dora, versus 5.98 / 2.26 / 7.64
before. The hero export is a labelled four-panel **depth sweep** per slot
(scales 0 / 0.25 / 0.5 / 1) so the decal look can be picked: scale 0 is the
decal-equivalent shading-only end, 1 is the physical groove.

Measured against the decals (both shading-only carves, 0.495 mm vs 0.55 mm): the
decal `1m` lip's ivory luminance spans p05 128 / p50 188 / p95 254 (min 113); the
3D hand face's spans 182 / 237 / 241 (min 116) at every scale, so the *shading*
family matches and the displacement was the outlier. Depth-sweep difference
against the POM-off panel, over the exported pixels: hand mean 3.5/255 at scale
0.25 (4.4 % of pixels), 6.3 at 0.5, 8.0 at 1.0; the dora likewise 5.2 / 6.0 /
7.0; Haku and the blue back stay at 0.0 (flat face, no carve).

The rig (`lighting.ts`): key `#fff7ea` at 2.507, hemisphere fill
`#cfe0ff`/`#0b1512` at 1.10, ambient `#ffffff` at 0.251 (three.js intensity
units; the shader divides by π), which sums to neutral 1.0 irradiance on an
up-facing normal (0.998 / 0.992 / 1.006 linear) and 0.97 / 0.96 / 0.95 on the
reclined hand. `POM_STEPS` = 12 / 8 / 0 for high / balanced / compat;
`?debug=pom-off` forces 0; the loop bound is 32; the shader clamps the
displacement to **8 texels**.

Numbers from a real WebGL2 run (Chrome + ANGLE/SwiftShader, 1920 × 992 CSS,
DPR 2), printed by the HUD (`frontend/scripts/out/hero-report.txt`):

| probe | reading | target | ΔE |
| --- | --- | --- | --- |
| face ivory (pond, Haku, open) | `#f5f0ec` | `#f5f0eb` | 0.51 |
| blue back (wall, face-down) | `#132986` | `#132986` | 0.00 |
| paint (hand, `1p` artwork) | `#434356` (navy), ΔE 74 from ivory | — | pass |
| Haku at the same point | `#f5f0ec`, redness 5 | — | clean |
| ivory bevel (hand) | `#dbd6d3` | — | pass |

POM off (steps 0) reproduces every reading, so the carve path is one uniform.

| slot | incidence | live parallax | physical (scale 1) |
| --- | --- | --- | --- |
| hand (reclined 40°) | 16.0° | 0.56 texels | 2.26 |
| pond (lying) | 37.3° | 1.50 texels | 5.98 |
| dora indicator (top tier) | 44.2° | 1.91 texels | 7.64 |
| face-down wall tile | 0° (no carve) | 0 | 0 |

The hero worst is 1.93 at every supported aspect. The strict board-wide worst
under the board's own camera (`frameForAspect`, §2.4) — a far opponent meld at
4:3 — is 2.10 at the live scale and 8.41 at the physical depth, where the
shader's clamp takes over; the test prints both.

Shader-compile failure path: `installShaderErrorTrap` throws three's
`onShaderError` log as a `TileShaderError`, so the host reports `failed` with the
driver text. It caught two real bugs in this unit (a `vec3` tangent declared for a
4-component attribute, and a backtick in a GLSL comment) — the exact failure mode
the criterion exists for. Covered by tests on both the trap and the host.

Handoff artifacts: `frontend/scripts/out/hero-<slot>-depth-sweep.png` (4 labelled
2560 × 672 strips: one macro shot per depth scale, same incidence ray, same
lights, same shader, camera moved in), `hero-overview.png` (the live view at
3840 × 2160), `hero-report.txt`, and `decal-1m-{upright,lying}.png` — the
committed carved decals converted to PNG and composited on the ivory face, as the
approved recess to compare against. **Verdict: pending the user's review.**

**Hero face moved to `1p`, and the carve mask fixed (same day, at the user's
request: "a more complex carve").** The first `1p` bake carved every opaque
pixel, so its whole disc sank — "just a recessed circle". `1p`'s artwork is
woven with **opaque white** (17 066 of 87 040 cell px, 19.6 %) that is the bare
tile showing through, while `1m` has none: the carve mask is now `opaque AND
ΔE(colour, ivory) > 10` (the runtime paint probe's rule) and the relief3d albedo
drops the white to transparent, so the white reads as raised uncarved islands.
Measured after: plate ivory p25/p50/p95 **230 / 237 / 243**, its edges 162, paint
34–98; `1p` whiteFraction 0.196, `1m` 0.000. The bake now also publishes its own
albedo (pigment from the committed atlas, mask corrected) instead of reusing the
committed one, so the runtime shader sees the same paint the carve does.

**The same request's earlier detail.** `1p` is multi-colour (navy 16004 px, white 12539, black 4860, crimson
3530 in the committed albedo), so the paint probe is now a **contrast** test —
the block median must sit at least ΔE 25 from the committed ivory — instead of a
redness test, and its point is the widest navy band (11.2 texels of clearance).
A white part of the artwork deliberately does not count: it is within ΔE 6 of
the ivory. This also exposed a bake bug: the AO horizon treated *deeper*
neighbours as occluders, so it darkened the open face around the pit instead of
the pit itself; fixed, and the AO atlas is 766 kB now instead of 1009 kB.

**Live-shading pass (same day, after the user's second review: "the inside
white parts just look like white paint").** Measured against the approved
decals, face `1m`, as luma by distance from the paint boundary:

| 0 / 0.5 / 1.0 mm | decal | render before | render now |
| --- | --- | --- | --- |
| ivory luma | 217 / 240 / 240 | 110 / 195 / 238 (`ao^4`, normal 1.6) | 179 / 227 / 238 |

| paint luma | p05 | p25 | p50 | p75 | p95 |
| --- | --- | --- | --- | --- | --- |
| decal | 31 | 43 | **80** | 87 | 177 |
| render | 74 | 80 | **84** | 87 | 102 |

What that bought: the key's area character (five samples over a 24° radius, the
bake's tube is ~40°), a lower wrap (0.3) and a calibrated lacquer sheen on the
paint (`PAINT_SHEEN` 0.05 linear) that desaturates it exactly as the decal's
bake does (render median rgb 172,65,65 against the decal's 196,46,37). What it
cannot buy: the decal's *width* (a 0.3 mm wall against the relief bake's
0.655 mm) and the paint's *internal variation* (the decal's groove floor is
slightly concave; the committed one is flat). Curving the normal/AO to fake
sharpness only spreads a dark halo — the numbers above are the record of that
attempt. `CARVE_NORMAL_STRENGTH` and `CARVE_AO_POWER` stay at 1.0 (use the maps
as baked) and become the controls for the rebake below.

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

**As built (3D-S1, 2026-11-19).** Deliverable: `frontend/scripts/check-3d-pom.mjs`
(the one-command harness), `frontend/scripts/pom-probe.html` and
`frontend/scripts/pom-probe.ts` (the page it drives). No app source, no shader,
no committed asset, no layout constant and no test fixture changed; the probe
touches `TableScene`'s private `draw()`/`board.material`/`sampleHandle` and
stops 3D-11's install-time monitor only so the tier cannot downgrade during a
measurement.

Measurement: 0 / 8 / 12 / 16 = POM_STEPS at 1920 × 1080 (2.07 MP) and
3840 × 2160 under the 8.29 MP cap (3838 × 2159), tier `high`, MSAA on,
`SHADOW_STEPS` held at 4, Chrome 157.0.8103.78 with ANGLE/GL on the Mesa Intel
MTL iGPU, DPR 1. The full table, the repeat spread, the machine caveats and the
method notes are in §2.8 under "Measured POM cost (3D-S1, 2026-11-19)". Result
recorded below in the decisions list (item 9): **12 / 8 / 0 stand**, and the
spike is not skipped.

Acceptance criteria met: eight combinations with browser, GPU, DPR and driver
buffer recorded; a recommended `high` count (12) and a confirmed `compat` count
(0). A repeat run is `cd frontend && npm run pom:measure` (or
`node frontend/scripts/check-3d-pom.mjs`); the JSON reports land in
`/tmp/opencode/pom-probe/`.

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
  the closed contact seams); stacked wall tiers are the only intentional
  proximity and are separated by the tier gap.
- Pond rows start at the far row and fill toward the seat, matching the
  committed convention; the 4 overflow cells are used before any new row.
- The human hand's face-normal-to-view angle is ≤ 25° at every supported aspect
  (9:16, 3:4, 1:1, 16:9, 21:9); ~~all mat corners are in frame with ≥ 2 %
  margin~~ **every tile is in frame with ≥ 2 % margin** (revised 2026-11-18 after
  the board handoff: the board is the fit subject, not the mat — see §2.4's
  revisions); the hand's tile long axis is ≥ 5 % of viewport height.
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

**As built (3D-07, 2026-11-18).** Files: `three/{boardMesh,shadows,sticks}.ts`,
the rewritten `three/cameraRig.ts` (the adapter only), the board wiring in
`three/Scene.ts`, `felt.ts` (`feltSizeForFrame`), `hero.ts` (the same frame),
`three/materials/tile.{vert,frag}.ts` (`aFlags` replaces `aFaceUp`), the
highlight/dim uniforms in `tileMaterial.ts`, two board lifecycle events in
`contract.ts` and their listeners in `RendererHost.tsx`, plus
`three/{boardMesh,shadows,sticks,drawCalls,cameraRig.test,felt.test}.test.ts`
and one fixture change (`boardFixture` flags the newest discard its
`highlightDiscard` names, so the highlight path is exercised).

*Draw shape.* The whole board is one `InstancedMesh` (capacity 320, count live),
the contact shadows one instanced quad layer, the sticks one instanced box layer,
and the felt one plane: **4 draw calls**, invariant to tile count. (3D-09 added
the physical compass plate as a fifth; see §2.8 and its own record.) The fixture
board is 252 tiles / 203 grounded shadows; the widest board the layout gate
builds is 280 tiles, so the capacity is a malformed-snapshot guard, not a
budget. `boardMesh.test.ts` fails on > 320 instances or a non-finite matrix
instead of dropping tiles. The GPU-free half of the `drawCalls ≤ 4` gate builds
the three board layers with the production builders and counts meshes
(`drawCalls.test.ts`, via `countSceneDrawCalls`); `measure().drawCalls` still
reports the renderer's own count in the browser.

*One camera.* `cameraRig.ts` no longer solves anything: `applyFrameToCamera`
copies 3D-06's `frameForAspect` eye/target/pitch/fov and patches the lens shift
into `projectionMatrix[9]`. `cameraRig.test.ts` applies frames at all seven
supported aspects to a real three `PerspectiveCamera` and asserts the frame's
eye, pitch, fov and shift, then that `Vector3.project(camera)` equals
`boardLayout.projectPoint` for five sample points (the two projections are one).
The felt is re-sized from the same frame (`feltSizeForFrame`), so the 16:9 solve
moves it up with the image; `groundHit` round-trips each felt hit back to its
asking NDC point.

*Flags.* `boardMesh.INSTANCE_FLAG` is `faceUp: 1, highlighted: 2, dimmed: 4`,
packed as one float attribute and decoded in the fragment shader with
`mod`/`floor` bit tests. Face-up selects the carved plate, face-down the blue
back; highlighted multiplies by `TILE_HIGHLIGHT.tint` (1.35/1.22/1.05) at
strength 1, dimmed multiplies by `dimGain` 0.62 after the BRDF. Tests assert the
bits (hover/tsumogiri tiles, wall = 0), that opponent hands and the wall are
face-down while the human hand and dora are face-up, and that a riichi discard's
body — not a glyph — is turned: its glyph-up axis is the seat's right (+X) where
its neighbour's is the tile's forward (-Z), both horizontal.

*Contact shadows.* One instanced draw with two profiles. **Lying tiles** get one
quad each: the oriented-box footprint plus 0.12 units per side, at `liftUnits`
0.015 above the felt, with a procedural rounded-rect alpha (`shadowAlphaAt`: 1 at
the centre, 0 at every edge, monotone between) in a 64 × 64 `DataTexture`; the
wall's top tier is excluded (it rests on the tile below). **The human's hand
group** — the concealed row *and* the drawn tile unioned — gets one analytic
band instead, because that hand is reclined 40° and overhangs its contact line,
so per-tile quads read as a scalloped line rather than a hand on the table. The
other three hands stand on the table (per-tile blobs are correct there) and keep
them. The band is the **2.5D recipe,
copied**: `table-reference-spec.json`'s rig variant `v13-shadow-darker`
(chosen 2026-11-17) publishes `handShadow { depthUnits 0.5, offsetUnits 0.18,
spreadUnits 0.18, sigmaUnits 0.26, sigmaXUnits 0.1, unionGroups }`, derived from
the shipped UI group layer (`shells.json` `shadowShape`, σ 5 px standing,
`#0b1418`) and `2_5d_mahjong_tile_rendering_architecture.md` §10.12 ("blur the
union once"). In 3D it is built from the tiles' **contact** corners (a reclined
hand's body overhangs its contact edge by ~0.45 units, so its box would make the
band twice as deep). The rig's own numbers read thin and crisp at this camera's
closer solve, so the handoffs widened them: **1.1 deep, its south (solid) edge
0.65 past the contact line, spread 0.24 at both row ends, Gaussian σ 0.5 across /
0.3 along**, and the quad carries a **1.5σ fade margin** outside that rectangle.

That margin was a bug fix, not a tweak: the analytic profile is 0.5 alpha on the
rectangle's edge and 0 a sigma outside it, so a quad that ended at the rectangle
was cut off at half opacity — a hard-edged "solid rectangle". With the margin the
profile completes inside the geometry: 0.99 alpha on the contact line, 0.84 at
28 px, 0.5 at 46 px, 0 at 81 px below the hand at 1920 × 1080 (~27 luma at its
darkest). The reference view's band is ~46 px at its own scale, so this is
deliberately larger/lower per the handoff. The tsumogiri gap gets shadow like the
rest of the union. Both profiles are one material/one call (the shader
branches on a per-instance kind). The material is transparent black,
`depthTest` on, `depthWrite` off, drawn in the transparent pass after the opaque
tiles, and every quad sits below a tile's top surface — so the depth test, not an
ordering hack, keeps a quad off a tile body. Tests assert all of that
numerically, including the v13 constants, the band's edge alpha and its anchor.

*Handoff (accepted 2026-11-18).* The board, the squared wall ring, the closer
camera, the hand bands and the radial casts were reviewed in the live view over
several rounds and signed off ("That looks good now"). The private-hand shade
(3D-18) was rejected in favour of the radial cast shadows (3D-19). The
waterfall/deal-in motion and the perf HUD remain 3D-12/3D-13; the antialiasing
and touching-tile seam work is the designated successor task **261118-2243**
("3D R20: anti-aliasing and white seams between touching tiles"), to be started
by landing this one with `cc-task land-next`.

**Board handoff follow-up (2026-11-18, same day).** The first render produced
four layout corrections, all recorded in §2.4's "Board handoff revisions" and
landed here: the wall's top tier sits on the bottom tier (the thickness was
counted twice, so the top row floated), the hands moved from radius 10.6 to 8.225
(and meld rows step toward the player so they clear the wall), the camera frames
the board rather than the mat with the 76-unit floor deleted — 16:9 solves to
52.73 after 3D-20 closed the pitches (55.56 before that), the tiles are ~37 %
larger and the human hand sits 6.59 % above the bottom edge — the front/back wall
runs are inset to 5.875 so the ring's front and back edges line up with the side
runs' end tiles, and the human's and the across player's hands then move a tile
thickness closer to those end runs (`HAND.endSeatRadiusUnits` 7.6357), which lets
the camera solve in. `check-3d-layout.mjs` gates all of it, including the hand's
bottom sliver, the two run radii and (since 3D-20) the tile-gap table; the look is
still the user's call at the same URL.

---

### 3D-08 — Interaction overlay and accessibility parity

**Goal.** Make the 3D view as usable as the top-down view for touch, mouse,
keyboard and screen reader.

**Depends on:** 3D-07.

**Deliverables**

- `hitTest.ts` (in `three/`, because it uses the camera): pure world-OBB →
  CSS-rect projection (`hitRects()`).
- `overlay.tsx`: absolutely positioned buttons for hand and draw tiles, plus a
  focus ring and hover lift callbacks (the lift is a discrete pose change, so
  the motion preference does not gate it).
- Tests that compare this view's accessible surface with `PhysicalTable`'s.

**Acceptance criteria**

- The overlay is positioned against the **full-window stage** (3D-02, §2.1): the
  buttons sit on the scene, not inside a card. This unit lands the first part of
  the floating UI; the 3D HUD chain (3D-H1…H5) mounts the rest of the chrome
  (header, action bar, hand dock, cards) as the same kind of layer, and the two
  must not capture each other's pointer events.
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

**As landed (2026-11-19).** `hitTest.ts` projects each tile's body OBB through
the scene's own frame. Targets aim for 44 × 44 CSS px and clamp to the tile's
cell when the projection is smaller, and adjacent targets split at the projected
midpoint of their centres so no two ever overlap (a phone at 390 × 844 therefore
gets the largest non-overlapping target, not an overlapping 44 px one; the
reference aspect clears 44 px on both axes). The overlay's DOM order is
`HandDock`'s display sort — both call `handTileLabel` and `handOverlay.ts`'s
`overlayHandTiles` — while each button is positioned on its own tile's rect.
`App` passes its `selectTile`, `callRiichi` and `callKan` straight through, so
the click path has no renderer in it. `TableRenderer.setHoverTile(tile | null)`
is the seam the overlay calls once per hover/focus change (and with `null` when
the hovered button disappears); `Scene` responds by raising that tile by half a
tile height (14 mm) along world +Y, without moving the button — see §9
decision 8. Nothing is painted over the face: the lift is the only hover cue
(user request 2026-11-20), while keyboard focus keeps its ring. The lift is a
discrete pose change, not an animation, so it applies under every motion
preference (user decision 2026-11-21); reduced motion suppresses only the
deal-in. A null hover always clears, and the overlay's rects always come
from the un-lifted pose.
The overlay is the first floating-layer element: absolutely positioned over the
full-window stage, `pointer-events: none` except for its buttons.

**User verdict (2026-11-19):** accepted — the projected hand and the half-tile
hover lift "looks good now" on the running dev server.

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

**As landed (3D-09, 2026-11-19; revised the same day after user review).**
Files: new `renderers/compassOverlay.ts` (pure compass model and box math) and
`renderers/three/compassPlate.ts` (the physical square), `renderers/overlay.tsx`
(`TableCompass` beside the unchanged hand overlay), `renderers/RendererHost.tsx`
(reads and clears the projected well, mounts the compass whenever the scene is
ready and not in the hero debug view), `renderers/RendererHost.css` (the
screen-space number layer), `renderers/contract.ts` (`CompassRect`, optional
`TableRenderer.compassRect()`), `renderers/three/hitTest.ts`
(`compassPlateRect` + `compassPlateCorners`), `renderers/three/Scene.ts`
(`compassRect()` on the same solved frame, and the plate in `buildBoard`),
`renderers/three/{boardLayout,boardFixture,sticks}.ts` and
`layoutConstants.ts` (per-seat sticks), `scripts/check-3d-layout.mjs`, and the
tests `compassOverlay.test.ts`, `three/compassPlate.test.ts`,
`overlay.test.tsx`, `RendererHost.test.tsx`, `three/drawCalls.test.ts`,
`boardLayout.test.ts`, `sticks.test.ts` and `layoutConstants.test.ts`.

*The square is 3D, the numbers are not.* User review (2026-11-19) rejected the
first take, where the panel was a DOM box with a background: "the square needs
to be an actual physical square that sits on the table, not something that
floats over the 3d scene. The numbers / text themselves SHOULD be superimposed
over the 3d scene, so they don't have perspective distortion, but the square
itself should." The plate is therefore one real mesh on the felt: a rounded
(0.28-unit corners), bevelled slab 0.08 units (2.24 mm) proud, extruded from a
`Shape` in core three with the 2.5D panel's dark face (`#151b23`), and it
foreshortens with the camera like the felt and the ponds. A second user
revision the same day widened it: "the compass should extend out so it's
touching the top row of discards for each player (the discards are placed right
up against it)." `COMPASS_PLATE.sizeUnits` is therefore derived, not authored —
the innermost pond row's inner edge on all four sides, less the chamfer and a
0.004-unit hair of felt (4.58 units square; the physical edge stops 0.004 units
short of a discard). The DOM layer lost its background, border and radius and
is now only the numbers, wind glyphs and riichi markers, laid over an inscribed
square of the plate's projected rectangle (`MIN_COMPASS_PX` floor), so nothing
in the text is skewed. The plate is a fifth steady-state draw (§2.8), asserted
by `drawCalls.test.ts`; `three/compassPlate.test.ts` pins its footprint, height,
touch distance, one-mesh cost and that no tile on a full board can meet it. The
per-seat riichi sticks now stand on its top face (`COMPASS_PLATE.topUnits +
STICK.heightUnits / 2`) instead of the felt.

*Anchor.* The compass adds no second camera: `compassPlateRect` projects the
plate's four corners through the same `frameForAspect` frame `hitRects()` uses,
publishes their bounding rectangle plus its centre, and the DOM square takes the
rectangle's shorter side centred on that centre (floor `MIN_COMPASS_PX` = 132 px,
so a stage whose plate projects smaller still reads). Measured: 355.7 × 266.1 px
plate at 16:9 (1920 × 1080) → a 266 px square at font 21.3 px (score lead 1.5 em
= 32 px); seven supported aspects plus 390 × 844 and 320 × 568 phones are all
asserted. At each, the compass centre is within 0.4 % of the window of the
independently projected world origin (gate: 2 %), the projected origin lies
inside the square, and **no hand or draw button intersects it** — the human's
topmost button is ≥ 271 px below the compass at 16:9, 56 px at 390 × 844 (a 90 px
plate, grown to the 132 px floor) and 34 px at 320 × 568. Above the floor the
square also stays inside the plate's rectangle.

*Labels and structure.* `compassOverlay.ts` derives each corner from the
snapshot using the human-anchored turn order the plan view uses, and
`overlay.test.tsx` renders `PhysicalTable` and `TableCompass` for one state and
compares the accessible names **in DOM order** — including the side group names
and the round/tiles-left string — rather than restating them. The corner's
accessible name keeps `PhysicalTable`'s raw integer score ("South wind, 26000
points, riichi") while the visible plate uses Tenhou's split: the hundreds at
1.5 em and the trailing two digits at 0.58 em in grey (`25000` → `250` + `00`),
which is lossless and gives the digits room without shrinking them. Under it is
the user's second-revision layout: one **row** per seat, with the wind glyph
greyed (42 % opacity) to the LEFT of the score and the riichi marker after it;
the row turns with its seat (`SIDE_ROTATION`'s 0/270/180/90), and the wind glyph,
score and `RiichiStick` are the same components the 2D compass uses. The drift
test compares the plates' **values** (the scene's `data-score` against the plan's
rendered digits) and asserts each split recombines to its score, so the two
presentations cannot disagree.

*Riichi sticks.* `layoutBoard` now draws **one 3D stick per seat whose `riichi`
flag is true**, on that seat's own side of the compass, lengthways along its
edge (`BoardStick.seat` + `yawDeg`; `sticks.ts` composes the yaw). The
1000-point pot is not drawn on the 3D table at all — the unit explicitly keeps
`compass.riichiSticks` in the table information drawer — so the prior row of
`riichiSticks` sticks on the human's side is gone. The layout gate now checks
one stick per declarer, its side/radius/tangent, and clearance from every tile
at its own yaw.

*Sticks: the real bar, with a carved pip.* Two more user revisions the same
day: the sticks belong "above the number (closer to the center)" and "the 3d
stick models look awful, they're supposed to be rounded … that [sprite] is more
accurate, but we want it as a 3d model"; then the model itself: "65mm long, 7mm
wide, and 3.5mm thick. The material is Polystyrene resin. Every edge of the
stick has rounded long edges, about .4mm … there should only be a center pip,
not those weird grey lines on the sides … the center pip is actually 'carved
out' and then painted on … use the same approach we used with the tiles."

- **Dimensions and shape.** `STICK_MM` is 65 × 7 × 3.5 mm. The bar is drawn at
  **72 %** of that (`STICK.modelScale`), a readability compromise the user asked
  for so it fits inside the scores: 46.8 × 5.04 × 2.52 mm, i.e. 1.671 × 0.18 ×
  0.09 units. Everything below is that scaled bar; the proportions and shape are
  the real ones. The user's final shape note — "looking at the
  stick from the long end, the cross-sectional profile of the stick should be
  an ellipse, and "looking down on the stick like we do on the table, the
  profile should be a rectangle (with only very very slightly rounded corners),
  so the ends should terminate abruptly rather than being semi-ovals" — replaces
  the earlier 0.4 mm bevel. The mesh is a **swept ellipse**, every cross-section
  the same 7 × 3.5 mm ellipse, with **flat ends** and a 0.4 mm round easing only
  the four plan corners: the top view is a 65 × 7 mm rectangle with abrupt ends.
  That is what gives the continuous round on the long edges (an extruded
  flat-topped slab could not). It is one instanced `BufferGeometry` built in
  core three (40 segments around, 28 along the length, 4 across each end rim). The material is
  `MeshPhysicalMaterial` (polystyrene `ior` 1.59) with a **clear coat** 0.5 at
  roughness 0.07 and a per-texel roughness map, so it has the sheen the flat
  matte box lacked. The grey end bands are gone; the only decoration is the
  centre pip.
- **The pip is carved and painted.** `three/stickMaps.ts` generates the same
  three-part face the tiles use for their engraving — albedo with the paint
  mixed in, a tangent normal of the recess wall and a roughness map — for a
  3 mm pip (42 % of the bar's width, the sprite's own proportion) sunk 0.4 mm
  through a 0.5 mm wall, with a baked 22 % cavity darkening (0.25 mm would be
  sub-pixel at the stick's ~19 px on-screen width). The face is the
  bar's plan projection (u along the length, v across the ellipse) maps the
  pip to the top centre and the curved sides to the atlas's plain-ivory border,
  so one material and one instanced draw still cover the whole bar. There is no
  POM march: the pip is 0.4 mm deep, which is under half a pixel of parallax at
  the reference angle, and the normal map carries the carve; the tiles' 0.55 mm
  glyph wall is a different scale. `sticks.test.ts` pins the bar's extents, the
  rounded-edge inset, the pip's albedo/normal/roughness, and the one draw.
- **Position.** `STICK.radiusUnits` is **0.98**. The scaled bar is 1.671 units
  long, so neighbours clear each other by 0.054 units (their inner faces are
  0.89 from the centre against a 0.836 half-length); it sits in the 0.35-unit
  band between the centre group (~0.8 out) and the score row's inner edge
  (~1.21 out). The earlier revision had pushed the top/bottom score rows out to
  the plate edge to make room for the full-size bar, which put them over the
  discards; that is reverted, so the rows are centred in their thirds again and
  the scores have a 0.46-unit margin to the plate's edge. One further user note
  (2026-11-19) puts the **three opponents' scores** a little further out
  (`translateX/translateY` of 0.5 em on the top/left/right seat groups) while
  the human's bottom row stays where it is. The layout gate checks
  stick-to-stick clearance as well as tile clearance.
- **No DOM stick icon.** The user asked for the 3D model alone, so the 3D
  compass's corner row is only the grey wind and the score; the corner's
  accessible name still ends ", riichi" for each declarer, and the drift test
  compares the informative names (ignoring `PhysicalTable`'s decorative sprite
  label).

*Interaction.* The compass is informational: no buttons, no tab stops, and the
layer is `pointer-events: none` with only its labels re-enabling them, so the
felt and the hand buttons stay reachable. It renders whether or not a hand
handler is supplied, and is removed while the scene is loading, unsupported,
failed or in the hero debug view.

*Previewing the sticks.* A real hand often has nobody in riichi, so a reviewer
could not see the per-seat felt sticks at all. `?preview=sticks` (added
2026-11-19 at the user's request, alongside `?renderer=3d`) marks every seat
riichi in the **3D view's copy** of the snapshot only: `withPreviewRiichi` in
`snapshot.ts` copies the snapshot and flips each seat's flag, leaving every
other field (including the recorded riichi discard) untouched; the store, the
2D views and the answer never see it. The query parser tests the flag and the
adapter tests the copy. It is review-only and disappears with the rest of the
preview chrome at 3D-15 sign-off.

**Visual sign-off (2026-11-19): accepted — "Looks good now."** The first pass was
reviewed by the user that day and seven further rounds followed before the
verdict: the physical square and Tenhou score plate; the discards-touching size,
bigger numbers and the grey wind at the left; the real 65 × 7 × 3.5 mm
polystyrene bar with its carved pip and no DOM icon; the elliptical
cross-section; the rectangular top view with abrupt, 0.4 mm-eased ends; the
72 % scale with the score rows back inside the plate; the opponents' scores
nudged outward; and the round/tiles-left group lifted to its final optical
offset (`translateY(-0.32em)`). The delivered numbers are the plate at
4.582 units touching the innermost discards, 21.3 px base type at 16:9
(32 px score lead), the bar at 46.8 × 5.04 × 2.52 mm drawn at radius 0.98, and
four per-seat riichi sticks driven by `?preview=sticks` for inspection. The
whole-board look is re-checked once more at 3D-15; this unit's own visual
question is closed.

---

### 3D-10 — Carve self-shadow, debug modes, step tiers

**Reshaped 2026-11-18.** Carve *geometry* is no longer this unit's job: 3D-17
bakes it from `decal-spec.json` (decided with the user after the live-shading
comparison). 3D-10 keeps the light-space self-shadow, the `?debug=` modes and
the step-tier calibration.

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

**As built (3D-10, 2026-11-19).** Files: `three/materials/tile.frag.ts` (the
light-space march, the `shadow` debug view), `three/tileMaterial.ts`
(`SHADOW_STEPS` 4/2/0, `SHADOW_MAX_STEPS` 8, `SHADOW_CALIBRATION`, the shadow
uniforms and handle controls, `shadowStepsFor`, `shadowReachTexels`),
`three/carveReport.ts` (the pure worst-case readings),
`three/{carveReport,carveShadow,debugPath}.test.ts`, `contract.ts` (`DEBUG_MODES`
gains `shadow` and `shadow-off`, `RendererStats.shadowSteps`, `CarveReport` /
`CarveCapture`, the two optional renderer methods), `capabilities.ts`,
`debugLegend.ts` (new, pure: the codes plus each mode's numeric legend),
`Scene.ts` (`measure().shadowSteps`, `carveReport()`, `carveCaptures()`, the
macro camera), `RendererHost.tsx` / `.css` (the carve HUD), and
`RendererHost.test.tsx`. No 2.5D file, no committed asset and no layout constant
changed; `POM_MAX_TEXELS` stays 8.

*The march.* After the depth march resolves the plate UV, the fragment walks
toward the key in the plate's tangent frame: at step `t` the ray's normalized
depth is `surfaceDepth - t`, and a sampled height above it occludes. The reach is
the same plate/cell conversion as the parallax offset (physical carve depth
through the key's tangent angle), clamped to 6 texels — **inside** the 8-texel
parallax gate. The term multiplies the key irradiance only (fill and ambient are
not shadowed); the open face can never shadow itself because its ray starts at
depth 0 and the bias (0.02 normalized = 0.011 mm) is above the map's
quantization. `uShadowSteps = 0` skips the block entirely, so `compat` and
`?debug=shadow-off` are the unshadowed 3D-05 path.

*Calibration numbers.* `SHADOW_CALIBRATION` = depth 0.55 mm (the physical groove,
not the 0.25 POM displacement scale), strength **0.45**, bias **0.02**,
softness **0.35** (0.19 mm), reach clamp **6 texels**. An offline model of the
march over the committed `1p` height channel (same arithmetic, 4 steps) reads:

| attitude | key angle | reach | open face visibility | groove floor visibility | carved px touched | whole-cell key loss |
| --- | --- | --- | --- | --- | --- | --- |
| human hand (reclined 40°) | 33.15° | 5.03 px | 1.0000 | 0.932 | 18.3 % | 1.95 % |
| pond (lying) | 35.03° | 5.39 px | 1.0000 | 0.918 | 20.4 % | 2.34 % |
| dora (far wall) | 35.03° | 5.39 px | 1.0000 | 0.918 | 20.4 % | 2.34 % |

So the term is a groove effect with no acne on the open face; a floor pixel that
is beside a lit wall loses at most 0.45 of the key (≈ 31 % of the pixel's total
irradiance, since the key is ≈ 70 % of it). The board's worst readings at all
seven supported aspects are shadow 35.03° → **5.51 texels** (the dora) and
parallax 47.98° → **2.18 texels** (a far meld at 4:3), both under their clamps;
`carveReport.test.ts` prints the per-aspect table.

*Debug modes.* `?debug=albedo|height|normal|steps|flags|shadow|pom-off|
shadow-off|wireframe` (plus `hero`) mount the real table. `shadow` is the new
false-colour view: R = the key's visibility (1 lit, 0 occluded), G = the shadow
term. Each mode has one numeric legend in `debugLegend.ts`, printed in the carve
HUD together with the live tier, both step counts, the clamp values and the two
worst reaches. The HUD is `aria-label="3D carve measurements"` in the top-right
corner (the hero panel keeps the bottom-left). `debugPath.test.ts` pins that the
shader's debug chain assigns only `colour` (the flood property), that every mode
has a legend whose code matches the shader, and that `boardLayout.ts` /
`hitTest.ts` / `Scene.syncState` / `Scene.hitRects` never read a debug mode.

*Handoff export.* `carveCaptures()` renders a 4K (3840 × 2160 across the 2 x 2
matrix) labelled sheet per view: four panels = depth 0 / the tier's count, each
with the self-shadow off / its count. The board view exports three —
`carve-board-states.png`, `carve-pond-states.png`, `carve-wall-states.png` (the
last two are macro shots down the board's own incidence ray) — and the hero view
exports `carve-hero-states.png`. Export always shades normally (a false-colour
debug mode is temporarily cleared) and restores the live state afterwards.
Verified end-to-end in a real browser through a direct scene probe (no app
overlay): the three board sheets come out 3840 × 2224 (the extra 64 px is the
panel captions) at 4.3 / 6.7 / 4.6 MB, and the pond sheet's four quadrant mean
lumas are 116.80 / 117.41 / 116.68 / 117.32 — i.e. the self-shadow is darker by
0.12 and 0.09 at the two depth counts, and depth 12 is brighter by 0.61 / 0.64
than depth 0. The matrix changes exactly the two uniforms it says it does.

*Real-browser checks (Chrome + ANGLE/SwiftShader).* The hero view's probes all
pass with the shadow on: face ivory `#f6f0ec` vs `#f5f0eb` (ΔE 0.63), blue back
ΔE 0.00, paint and bevel probes pass, and the POM-off comparison is within
tolerance. The carve HUD reads depth 12 / shadow 4, parallax worst 44.65° → 1.94,
shadow worst 35.03° → 5.51. `?debug=shadow` renders the board with every open
face at R = visibility 1 (the sampled pixels read luma 54, i.e. pure red), and
`node scripts/check-3d-seams.mjs --debug=pom-off` passes on a full board, so the
0-step baseline is still the seam gate's baseline.

A real A/B (the fixture board at 1366 × 768, MSAA on) between the lit view and
`?debug=shadow-off` measures the term itself: **13,627 px differ (1.30 % of the
frame), every one darker with the self-shadow on, mean |Δluma| 4.68 over the
changed pixels and max 19.1**; the other 98.7 % of the frame is byte-identical.
That is the groove-only, key-only effect the offline model predicts, rendered by
the shipped shader rather than modelled.

*Handoff (accepted 2026-11-19).* The user reviewed the live board and the four
4K sheets (`?renderer=3d` against `?debug=shadow-off`, plus the exported state
matrix) and recorded the verdict **"Looks fine."** That accepts the carve with
the self-shadow at the shipped calibration — strength 0.45, 4 steps at `high`,
6-texel reach — and answers both named questions in the affirmative: the ink
reads beside a lit near wall (the groove shadow is visible where the key crosses
the wall) and the self-shadow does not muddy the small glyphs. No calibration
change was requested, so `SHADOW_CALIBRATION` and `SHADOW_STEPS` stand as
measured above. The named questions, for the record, were: **(1)** does the ink
read behind a lit near wall — i.e. is a groove's shadow visible where the key
crosses the wall, or does the paint look flat? **(2)** is the self-shadow too
strong on the small glyphs — do the thin strokes read muddy rather than
engraved? The live A/B needs no image: `?debug=pom-off` is carve off,
`?debug=shadow-off` is a lit carve with no self-shadow.

One follow-up recorded, not changed: the shader still integrates against
**0.55 mm** (3D-05's calibration) while the only surviving carve manifest,
`relief3d.json`, is **0.495 mm** deep. `tileMaterial.ts` documents the
difference; aligning it would shorten both marches ~10% and is a calibration
decision for a later unit, not a drive-by edit.

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
- `prefers-reduced-motion: reduce` removes the deal-in animation; the instant
  hover lift still applies. The POM and layout are unchanged.
- Context loss twice in a session → fallback, remembered for the session.
- A missing WebGL2 makes the 3D option disabled with a title explaining why, and
  never persisted.

**Gate:** frontend gate.

**As built (3D-11, 2026-11-19).** Files: `frontend/src/renderers/capabilities.ts`
(tier resolution, per-tier DPR/area budgets, the stored-tier and session-fallback
records, the unavailable reason), `frontend/src/renderers/three/perf.ts` (new,
pure: the frame-time EMA and decisions), `frontend/src/renderers/motionPreference.ts`
(new: the `prefers-reduced-motion` read/watch pair and hook),
`frontend/src/renderers/{RendererHost.tsx,RendererHost.css}` (resolution, events,
session memo, notice), `frontend/src/renderers/three/{Scene.ts,tileMaterial.ts}`
(per-tier backing store, atlas reload, sampling window, `measure()` percentiles),
`frontend/src/renderers/contract.ts` (the two quality events and their detail),
`frontend/src/App.tsx` / `App.css` (return to the stored view with the dismissible
notice). Tests: `capabilities.test.ts`, `three/perf.test.ts` (new),
`motionPreference.test.ts` (new), `RendererHost.test.tsx`,
`App.renderer3d.degrade.test.tsx` (new). No 2.5D file, no committed asset, no
Rust change.

*Tier resolution.* `resolveQualityTier({ queryTier, storedTier, environment })`
implements **URL > stored > auto** and returns the source as well as the tier. A
stored preference lives under `riichiprac.3d.quality` (localStorage; written by
`storeQualityTier`, ready for the 3D-14 control). Auto is: `compat` when the
primary pointer is coarse or the viewport is under 900 × 600 CSS px; `high` when
the viewport is at least 1280 × 720 **and** both hardware hints say 8 GB and 8
cores; `balanced` otherwise. There is no reliable discrete-GPU query
(`WEBGL_debug_renderer_info` is gated/spoofable and `powerPreference` is a
request), so the hint is deliberately conservative: a device that hides either
value never resolves to `high`. `readTierEnvironment` reads `innerWidth/Height`,
`matchMedia('(pointer: coarse)')` (a fine pointer vetoes the `maxTouchPoints`
fallback so a touch laptop stays balanced) and the two navigator hints; every
read is guarded.

*DPR and area.* `effectiveDevicePixelRatio(w, h, dpr, tier = 'high')` applies the
tier's DPR ceiling (2 / 1.5 / 1) and area budget (8.29 / 4.6656 / 2.0736 MP;
`TIER_BACKING_STORE`). The acceptance matrix (320 × 640 … 5120 × 2880 × DPR
1/1.5/2/3 × three tiers) is a unit test asserting `backingStorePixels` never
exceeds the tier budget. One correction to §2.8 is recorded rather than hidden:
its `clamp(..., 1, …)` could not honour the cap for a CSS viewport larger than
8.29 MP, so a ratio **below 1** is now allowed (floor
`MIN_DEVICE_PIXEL_RATIO = 0.1`); 5120 × 2880 lands near 0.75 at `high` instead of
14.75 MP. The budget owns one place (`Scene.applyBackingStore`) that both a
resize and a tier change call. A tier change also re-applies the material step
counts, and a change that alters the atlas upload scale (`compat` halves it)
reloads the relief set and rebinds the textures (`TileMaterialHandle.setTextures`)
so the half-size cell is sampled from a half-size atlas.

*Frame-time EMA.* `FrameTimeMonitor` takes `(nowMs, frameMs)` samples and is pure
except for one log line per decision. Thresholds are **25 ms** for a downgrade,
**33 ms** at `compat` for the terminal degrade, sustained **2000 ms**, with an
EMA weight of 0.2. It drops exactly one tier per sustained window, never
upgrades, ignores zero/invalid samples, and ignores deltas (or gaps between
samples) above 250 ms so a hidden tab or a debugger pause cannot degrade a fast
device. `measure()` now reports the recent window's p50/p95. The scene runs one
5 s sampling window after the first board/hero draw — the only continuous
rendering in the view — and then returns to on-demand frames; a downgrade
dispatches `tile3d:quality-changed` with `{tier, frameMsEma, kind, reason}`.

*Context loss and degrade.* The host keeps the existing policy (prevent default,
restore once, second loss closes the view) and now writes
`riichiprac.3d.fallback` to sessionStorage. A `context-lost` record blocks every
later mount for the session; a `degraded` record blocks only an **automatic**
mount, so an explicit `?quality=` or stored tier may still try. A terminal
degrade disposes the scene, writes the record, shows the host's dismissible
notice and calls the new `onDegraded(message)` prop. App uses that to delete
`renderer=3d` from the URL, re-render the stored view and keep the same message
as a dismissible banner, so the switch is real rather than a notice over a dead
stage; a session-local override also keeps the standard view if a browser
refuses `history.replaceState`. (3D-14's View control consumes
`threeViewUnavailableReason(capabilities)` for its disabled option; the host
prints the same sentence when a link asks for 3D on an unsupported browser, and
no 3D value is written to the settings store.)

*Reduced motion.* `usePrefersReducedMotion` follows
`prefers-reduced-motion: reduce`, including live changes; the host uses it when
the prop is not supplied and passes the resolved flag to `RendererOptions`. The
DOM overlay reports hover/focus under every preference: the lift is a discrete
pose change, not an animation (user decision 2026-11-21). 3D-12 consumes the
same flag for the deal-in only; neither POM nor the layout reads it.

*Acceptance evidence.* `capabilities.test.ts` prints and asserts the viewport/DPR
matrix, the three tier budgets, URL > stored > auto, the pointer/hardware rules,
the storage round-trips and the unavailable sentence. `perf.test.ts` asserts one
downgrade per sustained window with one log line, high → balanced → compat, the
terminal degrade at 33 ms, no upgrade, the hidden-tab gap and the p50/p95
statistics. `RendererHost.test.tsx` asserts auto resolution, stored precedence,
`prefers-reduced-motion`, the session memo after a double context loss, the
terminal-degrade notice/dismiss/memo and the no-auto-retry rule.
`App.renderer3d.degrade.test.tsx` asserts App removes the query flag, restores
the standard shell and keeps the notice dismissible.

---

### 3D-12 — Motion: hover, deal-in and the event seam

**Depends on:** 3D-07, 3D-08.

**Goal.** Motion that cannot mislead: no invented moves, no blocked input.

**Deliverables**

- Hover/focus lift (half a tile height, 14 mm, landed early in 3D-08 by user
  decision 8; the earlier ≤ 4 mm figure is superseded), a bounded deal-in
  (≤ 400 ms) on a revision change, and `playEvents()` with damped-spring tile
  flight math (unused in v1).
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

**As built (3D-12, 2026-11-19).** Files:
`frontend/src/renderers/three/motion.ts` (new: the cut rule, the deal-in and
the event-flight seam, all pure), `frontend/src/renderers/three/Scene.ts` (the
deal-in loop, hover composition, reduced-motion gate, the reserved
`playEvents()`), `frontend/src/renderers/three/index.ts` (an optional injected
`MotionClock`), `frontend/src/renderers/{contract,RendererHost}.tsx` (docs).
Tests: `three/motion.test.ts` (new), `RendererHost.test.tsx`. No 2.5D file, no
committed asset, no Rust change.

*The cut rule.* `shouldDealIn(previous, next)` is the whole diff rule: a
different revision is a cut, a repeated one is the same position with new flags
and starts nothing, and the first snapshot (the mount, whose atlases are still
loading) starts nothing either. `DealInMotion.cut()` is the only way a deal-in
can start, so a non-revision update is a position no-op by construction; the
scene still rebuilds the buffer, but every pose is identical (a test asserts the
layouts and matrices match byte-for-byte across a `locked` change).

*The deal-in.* One uniform lift from `TILE.heightUnits / 2` (14 mm, the same
amount as the hover lift) settling to zero over `DEAL_IN_MS = 400` with a cubic
ease-out. It is upward-only (never through the felt), monotone, exactly zero at
and past the bound, and `withVerticalLift(instances, 0)` returns the input array,
so the settled frame **is** the layout's matrices rather than a tolerance match.
The scene runs its own `requestAnimationFrame` loop only while a deal-in is
active and stops as soon as the sample reports `done`; a missing
`requestAnimationFrame` cancels the lift instead of leaving the board raised.

*Reduced motion.* `DealInMotion` is constructed with the resolved flag: `cut()`
returns false and `sample()` is a zero-lift no-op, so no frame loop ever starts.
The scene also ignores a hover ref under the same flag (belt and braces: the
overlay already suppresses the report while still delivering the `null` clear).

*The clock.* `MotionClock` is `{ now(): number }`; the default reads
`performance.now` (falling back to `Date.now`). `TableScene` takes one and
`createRenderer` forwards an optional one, so a future renderer test can drive
the deal-in by hand. The pure tests never install a timer: they pass a fake
clock.

*The event seam.* `flightWaypoints(layout, event)` resolves `draw` (the seat's
wall draw end → its draw slot), `discard` (the hand tile of that face, or the
draw → the newest pond cell), `meld` (the caller's newest pond cell → the meld,
no travel for a closed kan) and `flip` (in place, half a turn).
`sampleFlight()` interpolates with the critically damped step response
`1 - (1 + kt)e^{-kt}` (`k = 9`, strictly increasing, never above 1) plus a
vertical arc, so the path is deterministic, monotonic in time and never crosses
the felt plane; the end sample is exactly the target transform. Nothing calls
it in v1: `Scene.playEvents()` stays a no-op and a `RendererHost` test asserts
the host never invokes it across a deal, a hover and an answer.

*Answers during motion.* The overlay's buttons are never gated on the scene's
animation; a test submits an answer immediately after a revision cut and asserts
the handler runs synchronously with the same `(tile, index, draw)` arguments the
stacked view sends.

*Review aid.* `?renderer=3d&preview=deal` adds one floating "Replay deal-in
(preview)" button to the bare 3D stage. It bumps the snapshot revision on the
current hand, so the motion can be watched repeatedly before 3D-14 mounts the
Next Scenario chrome over the scene; the game state, the answer and the 2D views
never see it. It is the same review-only shape as 3D-09's `?preview=sticks`, and
a test asserts the revision moves while the seats and locked flag do not.
**User verdict (2026-11-19):** the deal-in and the replay control "look fine for
now"; the remaining full-board motion judgement stays with 3D-14's chrome and
3D-15's sign-off.

*Evidence.* `motion.test.ts` asserts the cut rule (including the
same-revision/locked no-op over the full fixture), the 400 ms bound, the
monotone lift to exactly zero, the exact settle, reduced motion, and every event
kind's start/end/monotonic/no-overshoot invariants. `RendererHost.test.tsx`
asserts the never-called seam and the immediate mid-motion answer.

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

**As built (3D-13, 2026-11-19).** Files: `frontend/scripts/check-3d-budget.mjs`
(new, dependency-free: Node `fs`/`crypto`/`zlib` over `dist/` plus the app's own
constants through Vite's SSR loader), `frontend/src/renderers/perfHud.ts` (new:
the HUD's pure reading and its 250 ms sample interval), `perfHud.test.ts` (new),
`frontend/src/renderers/RendererHost.tsx` / `RendererHost.css` (the `?perf=1`
panel and its polling effect), `frontend/src/renderers/three/Scene.ts` (the
three new `measure()` fields and continuous sampling while the HUD is open),
`frontend/src/renderers/contract.ts` (`devicePixelRatio`, `backingStorePixels`,
`frameSamples` on `RendererStats`), `RendererHost.test.tsx`, `frontend/package.json`
(`budget:check`) and the measurement protocol above. No 2.5D file, no committed
asset, no Rust change.

*The script.* It loads the app's real constants (`PINNED_RELIEF3D_ATLASES`,
`reliefGpuBytes`, `RELIEF_RASTER`, `TIER_BACKING_STORE`, `antiAliasFor`,
`BOARD_TILE_CAPACITY`, `buildTileGeometry`, `SCENE_DRAW_CALLS`,
`steadyStateDrawCalls`, the fixture/layout builders), then checks the build:
the three `relief3d/` atlases exist with the pinned byte count and SHA-256 (and
the manifest agrees with both the pins and the files); the published GPU totals
are 58,490,880 B at `high`/`balanced` and 14,622,720 B at `compat`; one tile is
480 triangles (budget 600), the widest legal board is 280 instances of 320, and
a full-capacity board is 153,600 triangles of the 200 k ceiling; the steady plan
is five draws of the hard ceiling twelve; and post-build, the entry names one
lazy chunk that contains three.js, the entry reaches it only through
`import(…)`, `index.html` neither loads nor preloads it, and three's marker
strings appear in no other chunk. The chunk's gzip size is printed against the
200 KB advisory and only warns when over. The exit code is non-zero only for
atlas drift/missing files, a broken count or draw-call ceiling, or a leaked
three import (the plan's rule). On this build the chunk was 661,989 B raw /
178,226 B gzip and the entry 677,962 B raw / 119,796 B gzip.

*The HUD.* `?perf=1` mounts a floating panel that reads `measure()` every 250 ms
and prints tier, resolved DPR, backing-store MP, depth/shadow steps, draw calls,
instances, triangles, frame p50/p95, sample count and atlas MB. It is off by
default: with the flag absent there is no interval, no `measure()` call and no
extra rendering. With it on, `Scene.startPerfSampling` keeps drawing and sampling
real animation-frame deltas after the `PERF_SAMPLE_WINDOW_MS` window instead of
returning to on-demand frames, so p50/p95 describe the live table. The 5 s
window with the HUD off is unchanged (3D-11), and the monitor's 25 ms/33 ms rules
still apply while the HUD is open.

*Gate evidence.* `npm test`, `npm run build`, `npm run lint` and
`node scripts/check-3d-budget.mjs` are green; the gate run's printed table is
the script's own report, not a transcription.

---

### 3D-14 — View switch integration

**Depends on:** 3D-08. Soft: 3D-11 (unsupported/fallback story), 3D-13 (budget
gate). Nothing from the 2.5D chain: the 3D view is its own `TableView` value and
does not wait for the 2.5D rendered view.

**Goal.** Make the 3D view a first-class, reversible choice.

**Scope note (rescoped 2026-11-19, user decision).** This unit is the view-switch
mechanics only. The floating chrome re-mount described in the earlier draft of
this section moved to the **3D HUD chain**: 3D-H1 (composition spec and overlay
contract), 3D-H2 (shell, safe areas, full-screen), 3D-H3 (action rail and
tile-less hand dock), 3D-H4 (setup sheet), 3D-H5 (result card and verdict
sheet). The 3D view keeps its scene-only mount until 3D-H2 lands, and this unit
must not port the 2D chrome.

**Deliverables**

- `TableView` gains `'rendered3d'`; `AppControls` lists it (disabled, with the
  reason, when this browser cannot run it); `App.tsx` mounts it in the same
  table slot; the existing view tests extend; AGENTS.md §4's view list names the
  fourth view.
- A single `RENDERED3D_EXPOSED` constant keeps the option out of the picker (the
  query flag still works) until 3D-15 flips it. Exposure is the picker only: a
  value a later build stored still mounts, so the choice survives a reload.
  *(Update 2026-11-20: the user made 3D the default, so the constant is `true`
  and the picker offers all three views. The view also moved to its own
  `localStorage` key so a 2D choice stored while 3D was opt-in cannot keep
  anyone in 2D. 3D-15 now verifies the exposure instead of flipping it.)*
- **The full-window stage becomes reversible** (user guidance 2026-11-18): the
  shell modifier that drops the phone-width column and fixes the 3D backdrop is
  applied only for the 3D value, and switching away removes it *and* leaves
  full screen (never leaves the user in a full-screen 2D view).
- The `FullscreenButton` (`components/FullscreenButton.tsx`, built in 3D-02)
  stays **unmounted** here; 3D-H2 mounts it in the floating shell. This unit
  still owns leaving full screen when the view changes, via `fullscreen.ts`.

**Acceptance criteria**

- Switching stacked ↔ topdown ↔ (rendered) ↔ rendered3d keeps the same
  `GameState`, the same selection/answer state, and does not re-deal (a test
  asserts the state object is identical across switches).
- Switching into and out of 3D adds/removes the shell's 3D modifier exactly
  once; after leaving, the stacked/top-down layout is structurally unchanged
  (the stage is no longer fixed, the column width is back) and
  `document.fullscreenElement` is null.
- **No chrome is mounted in 3D yet** (scene alone): no Y-flow siblings of the
  canvas, the canvas owns the window, and the full-screen toggle is still
  absent. The chrome-over-scene assertions belong to 3D-H2/H3's own gates.
- The 3D view persists across reload when selected and supported (its own
  `riichiprac.table-view` key since 2026-11-20, separate from the older settings
  blob); when it is unavailable the chosen value falls back **without**
  rewriting the user's choice (so a temporarily unsupported device does not lose
  it). A browser with no choice at all opens on 3D and falls back to the stacked
  table when it cannot run it.
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
- `RENDERED3D_EXPOSED` has already flipped (user decision 2026-11-20, which also
  made 3D the default); this unit verifies the exposed, default composition
  rather than flipping the flag.
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

### 3D-17 — 3D-owned carve rebake at the decal profile

**Goal.** Give the live shading the crispness the approved 2.5D decals have, by
rebaking the carve channels at the decal's *profile* instead of the current
0.655 mm / 40° one. This is the user-chosen "B" path (2026-11-18, second
review): a fully live-lit face, not baked art pasted on the shells. The
decal-on-shell hybrid stays the fallback (see 3D-05).

**Depends on:** 3D-05. **Does not touch the 2.5D pipeline**: a new 3D-owned
directory, its own spec and its own script, reading only the committed
public-domain glyph PNGs.

**Deliverables**

- `tools/render3d/relief3d-spec.json` + `bake-relief3d.py`: port
  `bake_decals.py`'s carve field (`carve_field` / `bezier_profile` /
  `blurUnits` / `alphaRamp`) into a channel bake (albedo+paint, tangent
  normal+height, AO+roughness) at **256 × 340** per face (the committed cell
  size: 14.3 px/mm, still higher resolution than the decal's 8.4 px/mm), with
  the decal's numbers: `depthFractionOfThickness` 0.03 (0.495 mm),
  `transitionUnits` 0.0107 (0.3 mm), `blurUnits` 0.00429, and a tight AO
  distance so the groove's shadow is a line, not a field.
- `frontend/public/table/relief3d/` + `relief3d.json` with the same shape as
  `relief.json` (cells, plate, measured stats, byte+sha256 pins), 37 faces.
- `reliefAssets.ts` gains a source selector (`relief3d` when present and
  pinned, else the committed `relief`), so 3D-03's validation and the fallback
  path are unchanged.
- No 2.5D file, no 2.5D request; the old relief atlases stay committed and
  readable (the 2.5D owns them).

**Acceptance criteria**

- The new bake's lip profile and paint distribution are measured against the
  decal exactly as in 3D-05's report, and the test prints both: the ivory luma
  at 0 / 0.5 / 1.0 mm must be within 25 / 8 / 8 of the decal's 217 / 240 / 240,
  and the paint's p05/p50/p95 within 15 / 12 / 40 of 31 / 80 / 177.
- The carve depth, wall run and AO distance are printed beside the committed
  bake's, so the difference is a number, not an impression.
- Every committed atlas matches its pin; a missing or off-pin `relief3d`
  degrades to the committed `relief` with one warning (no hard failure).
- The hero view (`?renderer=3d&debug=hero`) and its depth sweep are re-run and
  handed to the user; the verdict is recorded here.
- No change to the tile body, the materials, the light rig or the layout.

**Gate:** frontend gate + the bake's own `--check` + user verdict.

**As built (3D-17, 2026-11-18).** `frontend/tools/relief3d/bake-relief3d.mjs` (Node,
no Blender, `@napi-rs/canvas` for PNG decode only) bakes
`frontend/public/table/relief3d/` plus `relief3d.json`: the decal's carve (glyph
area displaced inward, wall **inside** the painted silhouette, 0.495 mm through a
0.3 mm Bézier transition) as albedo, normal+height and AO+roughness at 256 × 340.
Inputs are the committed **flat glyph masters** (`faces/<id>.png`), premultiplied
and un-premultiplied into the cell, with the 2.5D chain's published bare-tile
rule (`whiteFillUncarved`, `whiteFillThreshold` 0.9). 22 s for 37 faces; 0.45 MB
albedo + 1.53 MB normal + 0.95 MB AO/roughness committed. This replaced the
retired Task 4B albedo as the input when main removed those assets (2026-11-18);
`reliefAssets.ts` now has a single source (relief3d) plus the procedural cell. Normals are
the exact height-field gradient; AO is a stated horizon approximation (8
directions × 10 steps over 1.4 mm). `reliefAssets.ts` gained `source:
'relief3d' | 'committed'` with its own pin table and a degrade-to-committed path;
`Scene.ts` asks for `relief3d`, `measure()`/the HUD report it.

Two bugs found while landing it, both caught by numbers rather than eyes:

- **A canvas surface premultiplies alpha**, and this bake's height channel is 0
  across every groove floor, so decoding the atlas through `drawImage` multiplied
  the floors' normal RGB away (the PNG was correct; the reader was not). The
  runtime factory now uploads a straight-alpha `ImageBitmap`
  (`premultiplyAlpha: 'none'`, decoder-side resize for the compat tier) and never
  touches a canvas; the baker writes PNG bytes directly with `node:zlib`.
- the first bake's `erfinv` treated an erf value as a probability, producing NaNs
  for negative distances (flat black cells); fixed with `Phi^-1((v+1)/2)/sqrt(2)`.

Measured against the decal after the switch (hand macro, `1m`): ivory at
0 / 0.5 / 1.0 mm **160 / 223 / 235** against the decal's 217 / 240 / 240; paint
interior **88** against 72; and the scanline now shows 241 bright ivory, 121–143
shaded ivory between strokes and 59–88 ink with 66–80 dark stroke edges, where the
committed bake read a flat 84 everywhere. The paint's *interior variation* (decal
p05 31 … p95 177) still exceeds ours (63 … 90): the decal's bright end is a
specular streak from its area light, and our directional key plus a 24° spread
does not reproduce it. `hero-vs-decal-1p.png` in the artifact directory puts the two
side by side.

**Verdict (2026-11-18, after the `1p` white-island fix): approved** — "That's
better, that looks great." The carve reads as physically recessed at the hand's
16°, the depth sweep remains the review process (it is where the bumps read),
and the shell body, blue band and Haku's clean face were accepted earlier in the
same thread. `POM_HEIGHT_SCALE` stays at 0.25; `1p` is the hero face.

**Plate-edge black seam (fixed 2026-11-19, task 261119-2029).** Some faces drew a
black hairline along one edge: White dragon (5z), Green dragon (6z), South (2z),
North (4z), West (3z) along the bottom, Red dragon (7z) along its side. Cause was
in the **asset**, not the shader: 37 faces fill 37 of the grid's 42 cells and the
plate's UV maps [0, 1] onto the cell's exact border, so the bilinear tap at a
plate edge is a 50/50 blend of the cell's last texel and the next cell's first
one. The five unused cells at the bottom right were left all-zero, and
`(0, 0, 0, 0)` decodes to a normal lying in the plate plane at the deepest groove
height with `AO 0` — black, tilted and sunken. Row 5's honours sit directly above
those cells and Chun sits left of one, which is exactly the reported set. The
bake now fills every unused cell with the open face (normal 128/128/255, height
255, AO 255, roughness 115, no paint mask — the same values as
`buildNeutralCell`), so every boundary blend is open-face-with-open-face. Measured
by `bake-relief3d.mjs --check` and `reliefAssets.test.ts`: the worst plate-edge
sample went from `2z bottom ao 127.5, height 127.5, normalZ 0.000` to `9p right
ao 255, height 255, normalZ 0.993`, and a decoded-pixel diff against the previous
atlas shows **only** the five unused cells changed — every used cell, and so
every glyph and carve number, is byte-identical.

### 3D-19 — Radial cast shadows from standing things

**Goal.** The board should read as lit from a lamp above the compass: every
standing thing throws a fairly diffuse shadow **directly away from the table
centre**. Replaces 3D-18, which shaded the hand's own material instead of putting
a shadow on the felt.

**Depends on:** 3D-06 (layout, `wallRunRadius`), 3D-07 (the shadow layer).

**Deliverables**

- `shadows.SHADOW.cast` (the numbers) and one `bandQuad` helper shared with the
  human hand's band.
- `shadowInstances`: one radial band per **opponent hand** (row + draw unioned),
  one per **wall run**, and one per **side run's player-facing end**; the human's
  hand keeps its own signed-off band untouched; ponds, melds, dora keep their
  contact blobs.

**Acceptance criteria**

- The human hand's band is byte-for-byte what it was (depth 1.1, offset 0.65,
  spread 0.24, σ 0.5/0.3) — the user asked for it to be unaffected.
- Every radial band's visible edge lands exactly `cast.lengthUnits` past the
  object's own base on its outward axis, for all four seats and all four runs;
  tests compute the base from the tiles' contact corners.
- Every band is a blurred rectangle with the 1.5σ fade margin, so its alpha
  reaches 0 inside the quad (no half-opacity cut-off).
- One quad per hand group and per wall run; still one instanced draw.

**Gate:** frontend gate.

**As built (3D-19, 2026-11-18).** `SHADOW.cast = { lengthUnits 1.2, overlapUnits
0.2, spreadUnits 0.24, sigmaAcrossUnits 0.6, sigmaAlongUnits 0.35 }`; the quad's
fade margin moved to `SHADOW.marginSigmas` (1.5) and is shared by both band
kinds. At 16:9 (≈ 58 px per unit near the centre) each cast is a ~70 px gradient
past the object's base, with the core dark at the foot:

| cast | where it lands |
| --- | --- |
| `wall-cast-0` (near run) | the felt strip between the near wall (outer face 6.375) and the human's hand (7.636), reaching 1.2 units out |
| `wall-cast-1/3` (side runs) | sideways past the side walls' outer face (7.375) |
| `wall-cast-2` (far run) | up-screen past the far wall (6.375) to 7.575 |
| `wall-end-cast-1/3` (side runs' ends) | +Z off each side run's end face, 1.0 wide (the wall's own thickness), to 7.575 — fills the notch where the near run's band stops at x ±6.375 |
| `hand-cast-1` (right seat) | +X from its base at 8.225, reaching 9.425 |
| `hand-cast-2` (across) | -Z from its outer base edge at 7.636, to -8.836 (partly near the top edge) |
| `hand-cast-3` (left seat) | -X from its base |
| `hand-group-0` (the human) | **unchanged** |

184 quads in total on the fixture board (177 tile blobs + 4 wall casts + 2 side
end casts + the human's band + 3 hand casts), one instanced draw. The near wall's cast and the
human's band overlap between 6.8 and 7.7 units from the centre — physically where
a centre lamp's wall shadow would fall — so that strip reads darker than either
alone; the hand's own band is untouched.

---

### 3D-20 — Anti-aliasing and white seams between touching tiles

**Goal.** Remove the aliasing on tile silhouettes/bevels and the see-through slot
between two tiles that should be touching, without breaking the draw-call budget
or the layout's no-overlap invariant.

**Depends on:** 3D-07.

**Deliverables / acceptance:** held in the task body of **261118-2243** ("3D R20:
anti-aliasing and white seams between touching tiles") until the unit starts, so
this plan does not duplicate a spec that is still being refined. The plan-level
constraints bind: no 2.5D-pipeline diff, `drawCalls ≤ 4` in the default scene,
`measure()` reporting intact, `check-3d-layout.mjs` green, and AGENTS.md §6 (a
numeric probe or the user's verdict, never an agent's look).

**Landed 2026-11-19 (task 261118-2243).** Two rounds: the first fixed the wrong
thing, the second fixed the real one. Both are recorded because the first
round's numbers are what identified the mistake.

*Round 1 (rejected by the user).* A shader-darkened inter-tile crevice, derived
from the 2.5D masks. It measured "no *bright* pixel in the groove" and passed its
gate, but the user reported the result as "a painted-on black smudge on the edges
of the tile" and named the real defect: **you could see through the gaps**. The
gate's statistic could not see that (a dark felt sliver never wins a brightest-
pixel test), and it only sampled four mid-row lateral seams, never the wall's
corners or the tier ends. The crevice is gone: no `contact.ts`, no `aContact`
attribute, no shading term.

*What the gaps were — measured.* `frontend/src/renderers/three/gaps.ts` measures
every pair of tiles' surface-to-surface separation. On the fixture board before
the change: **520 slots** in (0, 1.4 mm] —

| family | count | width |
| --- | --- | --- |
| wall stacks and wall tiers | 300 | 0.30 mm |
| wall ring **corners** | 20 | **1.10 mm** |
| pond rows | 91 | 0.30 mm |
| pond columns | 53 | 0.20 mm |
| hand row | 36 | 0.30 mm |
| wall / dora | 10 | 0.30 mm |
| meld | 8 | 0.30 mm |
| dora / dora | 2 | 0.30 mm |

The corner slots were not the committed groove at all: the stack pitch carried
0.0107 units, so a run's end sat at `runHalfLengthUnits` 6.4607, while the side
runs were hard-coded to radius 7 and their inner faces to 6.5000 — a 0.0393-unit
(1.1 mm) slot at every corner, full run length deep, straight down to the felt.

*The fix — close the layout, not shade it.* There is no groove constant any more:

- every row pitch is the body extent it repeats (wall stacks, wall tiers, hand
  row, pond columns, pond rows, meld slots, sideways advances), so touching
  bodies meet exactly;
- the wall's side-run radius is **derived** (`runHalfLength + tileHeight / 2` =
  6.875) so an end run's outer face and a side run's inner face are the same
  plane and the corner tiles share a 0.75 × 16.5 mm face instead of a slot;
- the *deliberate* separations stay and are documented as such: the 7.35 mm
  tsumogiri draw gap, the 4.2 mm between the draw and the meld row, the 2.8 mm
  between meld rows, the felt between zones.

Result, measured by the same instrument: the fixture board has **520 touching
pairs and 0 slots**, the widest board (4 melds/seat, kans, 22 discards, 5 dora)
**576 touching pairs and 0 slots**, and no pair interpenetrates. What remains
between two touching tiles is their own bevels' shallow V (2 × 0.055 units), which
is geometry, not a hole — the user asked for the groove to stay.

*The gate.* `check-3d-layout.mjs` now prints the touching-pair table and asserts
that **no pair is separated by anything between a true contact and a deliberate
1.4 mm gap** — the statement "there is no slot", which is what the defect was.
`node frontend/scripts/check-3d-seams.mjs` (or `npm run seams:check` in
`frontend/`) renders the same board in headless Chrome and reads `readPixels`
scanlines across four seams (hand row, pond row, wall front, wall tier): every
seam now reports **0 leak pixels** (no core pixel reads as the felt's green or the
clear colour) at 1920 × 1080, 1366 × 768 and 820 × 1180 at DPR 2, with MSAA on and
off. Its other half is the anti-aliasing measurement (see below).

*MSAA.* `capabilities.antiAliasFor(tier)` asks for a 4× context above the
`compat` tier (off at `compat`), which reverses plan §2.6's original
`antialias: false`; the user has accepted the AA. The cost is buffers, not shader
work — MSAA runs the fragment shader once per pixel, so the 12-step POM march is
not multiplied, and at the 8.29 MP cap the backing store goes from 58 MB
(colour 33.2 + depth 24.9) to 232 MB (132.6 + 99.5), i.e. +174 MB, which is why
`compat` keeps it off. Measured on the human hand's outer silhouette as the mean
largest one-pixel luma step over nine parallel scan lines, MSAA off → on:
**182.9 → 162.9 (11 %)** at 1920 × 1080, **178.2 → 121.0 (32 %)** at 1366 × 768,
**186.9 → 143.0 (23 %)** at 820 × 1180 @ DPR 2. A single scan line is grid-phase
noise (it read −2 % on one run), which is why the probe averages nine.

*Sign-off (2026-11-19).* The user reviewed the closed-gap board and the
plate-only finish over Tailscale HTTPS and replied "Looks great." — the visual
verdict AGENTS.md §6 requires for 3D-20. Two rounds were rejected on the way
here (the crevice shading, then nothing else); both are recorded below because
the numbers that rejected them are what pointed at the real causes.

**Follow-up (2026-11-19): a non-secure origin lost the carve.** Found while
serving the board over a tailnet URL: `crypto.subtle` does not exist on a
plain-HTTP origin other than `localhost`, the relief bridge's SHA-256 pin threw
`hash-unavailable`, and the loader took its procedural fallback — so the 3D view
drew fallback faces with only one console line to say so. The bridge now verifies
with its own `sha256.ts` (`sha256HexSync`, plain JS, ~30 ms for the three ~3 MB
atlases, tested against the standard vectors, `node:crypto` and the committed
pins) and WebCrypto is only the fast path; `ReliefAssets.verification` reports
`webcrypto` or `javascript`, `measure().reliefVerification` surfaces it, and one
warning names HTTPS as the fix. Measured on the tailnet HTTP origin: `status:
relief3d`, `reliefVerification: javascript`, the committed art drawn, no fallback.

**Follow-up (2026-11-19): the glint on wall bevels.** With the seams closed the
user reported a *different* defect: "very bright prominent white highlights" on
the bevelled edge of some wall tiles, and only some. It is not the seam work and
not geometry — it is the shell finish evaluated per pixel.

*Cause.* The body carries the shell's finish (roughness 0.16-0.18 plus a
0.1-roughness clear coat). A GGX lobe that tight is 1-2 deg wide and thousands of
times the diffuse level at its peak, so wherever a bevel's normal crosses the
half-vector *for that tile's own view ray* the rim saturates — and its neighbour,
half a tile away, does not. That is why only a band of tiles lights up and why it
moves with the viewport. The 2.5D shells never show it because their key is baked:
a 40 deg-wide tube drawn into the sprite, identical on every tile of an attitude.

*Measured.* A geometry-only probe could not attribute it (a face-up hand tile in
front of a wall looks like a wall face), so the probe now asks the shader: it
draws the board twice — lit, then `?debug=flags`, whose RGB *is*
`(face-up, blue-body, plate-zone)` — and tallies bright pixels per family. On the
fixture board at 1280 x 720, at 200 luma: **276 of 141,862 blue-body pixels
(0.195 %)** were bright, 142 of them fully clipped; after the fix, **24 (0.017 %)**
and none clipped. The ivory body (19,497 -> 19,512) and the face-up plates
(133,027 -> 133,085) did not move, i.e. nothing about the approved face look
changed.

*Fix.* `lighting.BODY_SPECULAR`: keep the shell's finish on **plate-like**
surfaces (`|local normal . face normal|` >= 0.985 — a flat face or backing, where
the lobe lands as a uniform sheen over the whole plate) and give the curved band
a broad, coat-free lobe (roughness 0.45, coat 0). The new `?debug=flags` view
stays as a real debug mode; `Scene.glintReport()` + `glintProbe.ts` are the
numeric instrument, and `check-3d-seams.mjs` prints and gates them (blue-body
bright pixels <= 0.1 % of blue-body coverage).

*Companion facts.* `drawCalls` stays 4, `measure()` is unchanged and
`RendererOptions.antialias` is the host's resolved decision. The in-page probe is
`frontend/scripts/seam-probe.html` (`?aa=`, `?debug=`, `?png=`, `?w=&h=&dpr=`),
which mounts the real `TableScene`; `TableScene.seamReport()` is the read-back.

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
| 3D-H1 | 3D H1: HUD composition spec and overlay contract | 3D-09 |
| 3D-H2 | 3D H2: HUD shell, safe areas and full-screen layer | 3D-H1, 3D-14 |
| 3D-H3 | 3D H3: practice HUD - action rail, call toggles, tile-less hand dock | 3D-H2 |
| 3D-H4 | 3D H4: setup sheet - scenarios, hotseat and settings | 3D-H2 |
| 3D-H5 | 3D H5: result card and post-answer verdict sheet | 3D-H2, 3D-H3 |

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
| R7 | The DOM overlay drifts from the 3D camera (buttons not aligned with tiles) | medium / high (usability) | single projection source (`hitRects()`), tests at two aspects, user check on the final board. **Closed in 3D-08** by the drift test that re-projects the hand OBBs through `frameForAspect`; the remaining user check is 3D-15's | 3D-08 |
| R8 | Shading/looks cannot be verified in CI | certain / medium | numeric probes for colours and POM displacement, debug modes, explicit user handoffs, no self-approval | all |
| R9 | A new runtime dependency is more than the repo wants | low / medium | lazy chunk, budget gate, exact pin, MIT notice; the renderer interface keeps the choice reversible | 3D-02, 3D-16 |
| R11 | The committed Task 4B carve is too soft to match the approved 2.5D decals at a live-lit face (0.655 mm wall, empty flat floor) | seen / medium (looks) | measure against the decals (3D-05's report), bake a 3D-owned set at the decal profile (3D-17), keep decal-on-shell as the fallback | 3D-05, 3D-17 |
| R10 | Both renderers load the relief atlases at once (double GPU memory) if a view ever mounts both | low / medium | only one table is mounted at a time (structural test in 3D-14); dispose drops textures | 3D-14 |

**Decisions recorded with the user (2026-11-18)** — all seven are settled; they
are binding on the units, not open questions. Items 8 and 9 were added later,
in 3D-08 and 3D-S1 respectively, and are equally binding.

1. **Exposure: the default (superseded 2026-11-20).** The 2026-11-18 decision
   was "behind the flag, never the default". The user's 2026-11-20 decision
   reverses it: 3D is exposed in the View control and is the default for every
   browser; the stacked and top-down views are options, the player's pick is
   remembered under its own key, and a browser that cannot run 3D draws stacked
   with the reason shown.
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
   Until that layer exists, the 3D view mounts **the scene alone**; 3D-14 makes
   the view a reversible `TableView` value (the shell modifier applies only for
   it, switching away removes it and leaves full screen, and the 2D layout comes
   back), while the chrome re-mount, the safe areas and the full-screen
   **toggle** are the 3D HUD chain's (3D-H2 owns the shell and mounts the
   toggle). The stacked and top-down views keep their existing layout
   throughout.
8. **Hover lift: half a tile height, with nothing painted over the face**
   (added 2026-11-19, in 3D-08; tint removed 2026-11-20). A hovered or focused
   hand/draw tile rises by
   `TILE.heightUnits / 2` = 14 mm along world +Y; the DOM button keeps its
   projected rect, so the pointer target never moves. This supersedes the ≤ 4 mm
   figure in §3D-12, which keeps the deal-in and the event seam. **Update (user
   decision 2026-11-21): the lift applies under every motion preference.** It is
   a discrete pose change, not an animation, so `prefers-reduced-motion: reduce`
   suppresses only the deal-in; the hover/focus lift and its clear are always
   delivered. **Update (user request 2026-11-20):**
   the button's `rgba(207, 224, 255, 0.08)` hover background was removed — over
   the carved face it read as a stray light box, not a highlight — so the lift is
   the only hover cue. Keyboard focus keeps its `:focus-visible` ring, which is
   what preserves the 2D views' visible-focus behaviour.
9. **POM step counts are measurements, not estimates, and they stand**
   (added 2026-11-19, in 3D-S1). `high` 12 / `balanced` 8 / `compat` 0 are
   confirmed on the machine described in §2.8: 12 steps costs +0.1 to +1.2 ms
   at 8.29 MP, 16 steps buys nothing outside the ±1.5 ms repeat spread, and
   `compat` 0 is confirmed for the same reason. The class of thing this decides
   is the *tier table*, not the shader: the base shading is ~15 ms at 4K on
   that GPU, so the automatic downgrade (3D-11) — not the depth count — is what
   protects the frame budget. A future unit that changes the shader's cost
   profile re-runs `node frontend/scripts/check-3d-pom.mjs` before touching the
   counts.

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
  sign-off), §4 (view modes) and §3b (the 3D chain's own constants).
- [`docs/2_5d-removal.md`](docs/2_5d-removal.md) — the retired 2.5D pipeline:
  what was removed, what survived and why. The old `2_5d_*` docs, the
  `tools/render/*` specs and the reference renders are in git history.
- [`replay-implementation-plan.md`](replay-implementation-plan.md) — the
  document skeleton, unit table and gate conventions.
- [`3d_hud.md`](3d_hud.md) — the floating HUD's composition, overlay contract
  and collision gate (H1); §11 lists the units that implement it.
- [`hosting-plan.md`](hosting-plan.md) — the Pages / R2 / Hugging Face pattern
  the 3D path deliberately does not extend.

---

## 11. HUD units (3D-H1 – 3D-H5)

The floating layer over the 3D stage is its own small chain, sequenced after
3D-14's view switch. The composition and the overlay contract are
[`3d_hud.md`](3d_hud.md) (H1); this section is the unit and gate record, so the
two must be read together. H1 is binding on H2–H5: a unit that needs a
different composition edits `3d_hud.md` first.

| Unit | Title | Depends on | Gate | Result |
| --- | --- | --- | --- | --- |
| 3D-H1 | HUD composition spec and overlay contract | 3D-09 (landed); soft 3D-14 | docs-only: stage, commit, push | `3d_hud.md` + this section; no app code |
| 3D-H2 | HUD shell, safe areas and full-screen layer | H1, 3D-14 | frontend gate + `node frontend/scripts/check-3d-layout.mjs` | `HudLayer` mounted only for the 3D view; top bar, hand-panel slot, sheet/toast primitives, tokens, `hudLayout` collision helper, `handBandRect()` contract addition, full-screen toggle mounted |
| 3D-H3 | Practice HUD: action rail, call toggles, tile-less hand dock | H2 | frontend gate + layout script | the hand panel's hint row and action row: `ActionBar`, the Riichi/Kan toggles, the Mortal chip; toasts; one hand only; collision matrix extended |
| 3D-H4 | Setup sheet: scenarios, hotseat and settings | H2 | frontend gate + layout script | one setup sheet: scenario pool (incl. replay packs), AI Hotseat body, settings (agreement/view/export-import), table info and notes; no re-deal |
| 3D-H5 | Result card and post-answer verdict sheet | H2, H3 | frontend gate + layout script + user verdict | result card after an answer; full verdict sheet on Details; never auto-expands |

```text
3D-H1 (contract)
 └─ 3D-H2 (shell, tokens, layout, sheets)
     ├─ 3D-H3 (panel rows, toasts)
     │   └─ 3D-H5 (result card, verdict sheet)
     └─ 3D-H4 (setup sheet)
3D-15 runs the joint matrix after H5; 3D-16 records the HUD as built.
```

**Landed: 3D-H2 (2026-11-19).** The shell, the tokens, `hudLayout()`, the sheet
primitive, the anchor store (`renderers/hud/hudAnchors.ts`), the
`handBandRect()` contract addition and the mounted full-screen toggle are in.
`App.tsx`'s 3D branch is now `<HudLayer>` + the fixed stage; the top bar holds
Next Scenario and full screen only, and no 2D header is mounted in 3D. The
`?preview=deal` review aid was retired with it. `3d_hud.md` §9 records the
as-built details (the anchor seam, the safe-area probe and the nested-layer
marker) that H3–H5 depend on.

**Landed: 3D-H3 (2026-11-20).** The hand panel's two rows and the toast stack
are in: `ActionRail` (the shared `ActionBar` plus the extracted `CallToggles`),
`HandRail` (the live-region hint from the shared `handHintFor` and the
pre-answer Mortal chip), and `buildHudToasts`/`ToastStack`. `App.tsx`'s 3D
branch passes them into `HudLayer` and no longer renders status/error blocks in
the stage's flow. `hudLayout()` gained the `hint` slot, the per-row rects and
their collision entries, and the rail reports its own 1/2-row wrap. One hand:
the rail renders no tile control, and the composition test asserts one button
per hand tile plus the draw, the armed riichi/kan submit through the store and
rail-then-hand Tab order. `3d_hud.md` §9 records the as-built facts and the one
deliberate departure from the draft task text (no `AnswerSummary` or Next in the
tile-less rail; they are H5's result card and H2's top bar). The user accepted
the composition on the running dev server on 2026-11-20 ("looks fine") and asked
for one unrelated change with it: the snapshot adapter now sorts every hand into
display order, so the 3D canvas draws the same hand the projected buttons and the
2D dock show (`snapshot.test.ts` pins it).

**Landed: 3D-H5 (2026-11-20).** The post-answer result card and the verdict
sheet are in: `hud/{ResultCard,VerdictSheet}.tsx` re-host `AnswerSummary` and
`VerdictPanel`, `src/verdictText.ts` is the one source for their wording,
`HandRail`'s Mortal chip opens the same sheet pre-answer (Peek/Retry live
there), and `HudLayer` owns one persistent result live region. `hudLayout()`
returns the card's content box and its Details trigger, and the collision gate
names both at every supported aspect. `App.tsx` changed only at the 3D mount
seam (`verdictOpen` plus the slot wiring); a new hand closes the sheet without
re-dealing or re-grading. At the user's request (2026-11-20) the result card and
the verdict sheet header each carry their own Next Scenario control, so dealing
again never requires the top bar; the top bar's stays as it was. `3d_hud.md` §9
records the as-built facts. The composition handoff awaits the user's verdict;
3D-15/16 remain.

**Landed: 3D-H4 (2026-11-20).** The setup sheet is in:
`hud/{SetupSheet.tsx, SetupSheet.test.tsx}` behind one top-bar trigger, with
sections for the scenario pool (the 2D `ScenarioPicker`, staged draft intact,
nested-layer marker for Escape), the AI Hotseat form (the extracted
`HotseatCardBody`, inline in the sheet — no second scrim or dialog), the
settings (the extracted `AgreementToggle` and `ViewPicker`, so the 2D header and
the sheet cannot drift), the export/import block and the table information plus
notes. `hudLayout()` learned the trigger's reserved `96 × 44` box and names it in
the at-rest set; `App.tsx` keeps one `hudSheet` state (replacing H5's
`verdictOpen`), so at most one sheet exists, a deal closes it and leaving 3D
closes it, and nothing re-deals or remounts the scene. The position-description
toast gained a Details action into the sheet's full text. `3d_hud.md` §9 records
the as-built facts, including the two deliberate deltas: the picker's panel is in
flow inside the sheet instead of an absolutely positioned popover, and §5's
portrait icon-only top bar is not implemented, so the trigger keeps its label
and its reserved width at every aspect. The composition handoff awaits the
user's verdict; 3D-15/16 remain.

**Rules binding all five units.**

- **One hand.** The projected DOM buttons from 3D-08 are the only hand controls;
  no HUD unit renders tiles. A count test enforces it.
- **No Y-flow.** The HUD is one `position: fixed` layer: `pointer-events: none`
  at the root, `auto` on each control; the canvas keeps the whole window and is
  never resized by chrome.
- **Z ladder.** `canvas < scene overlay < HUD < sheet < toast`, from the token
  block only (`3d_hud.md` §6.1).
- **Collision.** `hudLayout()` is pure and is the gate: no at-rest rect may come
  within 8 px of the hand/draw band or the compass at any supported aspect.
  H2 lands it; H3–H5 extend its state and the same matrix; 3D-15 runs the whole
  thing on the stress fixture.
- **Sheets.** Modal, one at a time, focus-trapped, Escape closes, focus returns
  to the trigger, the scene is `inert`, the page does not scroll, the renderer
  is never unmounted.
- **Composition handoffs.** Each visual unit ends with the artifact, the
  numbers already checked and the user's verdict (AGENTS.md §6); H1's §12
  questions are the first of them.
- **Scope.** HUD files live under `frontend/src/renderers/hud/`; `App.tsx` is
  touched only at the 3D mount seam. No Rust, no `GameState`, no 2D layout, no
  new camera framing or assets, and nothing from the retired 2.5D pipeline.

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
| 3D-S1 | `frontend/scripts/{check-3d-pom.mjs,pom-probe.html,pom-probe.ts}` (measurement only) |
| 3D-12 | `frontend/src/renderers/three/motion.ts` (new), `RendererHost.tsx` |
| 3D-13 | `frontend/scripts/check-3d-budget.mjs`, `three/perf.ts` |
| 3D-14 | `frontend/src/store/useSettingsStore.ts`, `frontend/src/renderers/{resolveTableMount.ts,capabilities.ts}`, `frontend/src/components/AppControls.tsx`, `frontend/src/fullscreen.ts`, `frontend/src/App.tsx`, `AGENTS.md` §4 |
| 3D-15 | tests + this plan's verification report |
| 3D-16 | `3d_renderer_architecture.md`, `THIRD_PARTY_NOTICES.md`, `README.md`, `AGENTS.md` §4 |
| 3D-H1 | `3d_hud.md`, this plan (§11, §3D-14, §9 decision 7) |
| 3D-H2 | `frontend/src/renderers/hud/*` (new), `renderers/{contract,RendererHost}.*`, `renderers/three/{hitTest,Scene}.ts`, `frontend/src/App.tsx` (3D mount seam) |
| 3D-H3 | `frontend/src/renderers/hud/*`, `frontend/src/components/HandDock.tsx` |
| 3D-H4 | `frontend/src/renderers/hud/*` (reusing `ScenarioPicker`, `HotseatCard`, `ExportImportControls`, `TableInfo`) |
| 3D-H5 | `frontend/src/renderers/hud/*` (reusing `VerdictPanel`, `AnswerSummary`) |
