# Project Context: Riichi Mahjong Trainer

- stage changes without asking.
- commit and push after finishing a task
- push after committing.

## 1. Project Identity & Objective
You are building a fully client-side, browser-based web application that trains players on specific Riichi Mahjong scenarios and heuristics (heavily inspired by *Riichi Book 1*). 
The app generates randomized hands and board states that perfectly fit predefined teaching constraints, asking the user to make the correct decision (e.g., Riichi vs. Dama, Push vs. Fold, Nani Kiru).

## 1b. Reference Material: Riichi Book 1 Source
The full text of *Riichi Book 1* is checked out locally at:

```
/home/kylehipke/workspaces/RiichiBooks
```

* Each chapter is a separate LaTeX source: `RiichiBook1-ch1-tenhou1.tex` (tile efficiency),
  `ch4-five` (5-block theory), `ch7-riichi` (riichi vs. dama), `ch8-defense` (push/fold,
  betaori, suji), `ch9-call` (call decisions), `ch10-grand` (grand strategy), etc.
  `RiichiBook1.pdf` is the compiled book; `figs/` holds its diagrams.
* Use it as the authority for **what the book actually says** when defining a scenario's
  constraints and `correct_action`. Do not paraphrase from memory or invent a heuristic:
  read the relevant chapter, quote the rule, and encode that.
* When a scenario's teaching constraint is ambiguous, the book wins over any assumption in
  this file. Cite the chapter and the specific rule in the scenario's doc comment/report.

## 1c. Asset size / memory budget policy (2026-11-16)

**Do not optimize for the committed-asset (8 MB) or initial-load (4 MB) byte
budgets during active development.** Visual quality and correctness come first.
Do not reduce atlas resolution, compression quality, variant count, glyph-master
detail, or delete assets (for example carvings or fallback faces) to make
a byte budget pass unless the user explicitly asks for an optimization pass.

- Measure and record asset sizes, but treat over-budget numbers as information,
  not a reason to change the art or the feature scope.
- Budget checks are advisory during development. A separate, explicit
  optimization task may later decide what to trade; do not pre-empt it.
- This overrides any older instruction or check that treats those budgets as a
  hard acceptance criterion.

## 2. Core Architecture: Constraint Satisfaction Problem (CSP)
**CRITICAL RULE:** Do NOT attempt to build an "AI" or "Oracle" that generates a random hand and then calculates the best move. 
The app is a **Constraint Satisfaction Generator**:
1. The "correct answer" and constraints are defined *first* programmatically.
2. **Constructive Skeletons:** The Rust engine forces required tiles into the hand to meet the constraints.
3. **5-Block Theory Fill:** The remaining tiles are randomly filled.
4. **Fast Rejection Sampling:** The hand is fed into the `agari` crate. If it violates constraints (e.g., accidental extra yaku, furiten, unintended waits), the state is instantly rejected and re-rolled. Thousands of rejections can happen in milliseconds.
5. The final, validated state is passed to the frontend as a static JSON object containing the `correct_action`.

## 3. Technology Stack & Division of Labor
* **Backend (Rust -> WASM):** 
  * Handles ALL game logic, state generation, validation, and rejection sampling. 
  * Uses the `agari` crate for low-level Mahjong logic (shanten, yaku, ukeire).
  * Compiled via `wasm-pack`. 
  * **Entropy:** Must use `js-sys` (`Math.random`) for RNG. Standard OS-level entropy will fail in the WASM browser sandbox.
* **Frontend (Vite + React + Zustand + TypeScript):**
  * **Extremely thin logic layer.** Do NOT put game rules or evaluation logic in React.
  * Takes JSON from WASM and renders it. Captures user clicks and compares them to the `correct_action` in the JSON payload.
  * Uses `riichi-mahjong-tiles` (SVG) for tile rendering in the stacked and top-down views.
* **Offline carve baker (3D, not shipped code):** `frontend/tools/relief3d/bake-relief3d.mjs`
  turns the committed glyph masters (`frontend/public/table/faces/`) into the
  carved face channel atlases under `frontend/public/table/relief3d/` (albedo,
  normal/height, AO/roughness) plus `relief3d.json`. It is deterministic and needs
  no Blender or browser. Visual sign-off on baked assets is the **user's**, not the
  agent's; see §6.
* **Retired 2.5D pipeline (2026-11-19).** The offline shell/felt/decal/overlay bake
  chain, the 2.5D runtime under `frontend/src/table/`, its public bakes and its
  design docs were removed in task 261119-1637; they live in git history. Do not
  resurrect or extend them. `docs/2_5d-removal.md` records what went, what stayed
  and why.

### 3b. The 3D renderer owns its geometry, materials and carve numbers

Before adding geometry, a material or a carve number under
`frontend/src/renderers/three/`, read the existing source and take the number
from there. This is a standing rule for every 3D session: a runtime tile that
invents its own corner radius, blue band or engraving depth is a bug even when
it renders.

* **Tile body and material** — `frontend/src/renderers/three/tileGeometry.ts`,
  `tileMaterial.ts` and `layoutConstants.ts` (`TILE`, `TILE_MM`): 21 × 28 ×
  16.5 mm, a 0.055-unit bevel, the Z-gated ivory/blue split, and the face/back
  materials. The numbers were signed off as part of the retired 2.5D model work
  and survive only here; the old specs are in git history.
* **Table layout and camera** — `frontend/src/renderers/layoutConstants.ts`
  (`TABLE`, `CAMERA`, `WALL`, hands, ponds, melds, dead wall, compass well) and
  `three/boardLayout.ts`, which solve the transforms and the one-point camera.
  The user approved the table model and anchor bank on 2026-11-17.
  Since task 261120-2112 the wall follows state: the 136-tile wall is
  **122 live + 14 dead**, the live wall is one contiguous arc depleted from the
  break (top tier first) by `GameState.tiles_remaining` (at most 70 at a
  decision), and the dead wall is the far run's intact 7×2 block, nudged
  0.3 units (8.4 mm) clear of the live wall. `frontend/src/renderers/wall.ts` is
  the one model that turns the count into slots; do not re-derive occupancy in
  another module. Plan §2.4a and §9 R6 record the decision.
* **The carve** — the approved engraving look is baked into the 3D channel atlas
  by `frontend/tools/relief3d/bake-relief3d.mjs`: the glyph area pushed in by
  0.495 mm through a 0.3 mm Bézier transition, with the wall **inside** the
  painted silhouette, and `whiteFillUncarved` / `whiteFillThreshold` 0.9 leaving
  the artwork's white as raised bare tile (`1p` alone is 17 % white). The glyph
  masters (`frontend/public/table/faces/<id>.png`) are the carve's input and
  `relief3d/` is its output. Do not read a retired `relief/` path.
* **Materials and lighting** — the tile materials above and the committed key
  (azimuth 315°, elevation 55°, `#fff7ea`) mirrored by `three/lighting.ts`.

Corollary: when a new unit and these sources disagree, the committed constants
win; ask the user before inventing a third number.

### 3c. The floating 3D HUD (3D-H2 onwards)

The chrome over the 3D stage lives in `frontend/src/renderers/hud/` and is
governed by `3d_hud.md`, which is binding on every HUD unit. Facts to build on:

* **One layer.** `HudLayer` is `position: fixed; inset: 0; pointer-events: none`
  and is mounted by `App` only for the 3D view, as a sibling of the stage. It
  never sits in the document flow, never shrinks the canvas, and only panels and
  controls take pointer events.
* **Geometry is one pure function.** `hud/hudLayout.ts` turns the stage size,
  the safe insets and the scene's anchors into every HUD rect, and its collision
  rule (nothing within 8 px of the hand band or the compass) is the gate. Do not
  add a second layout path or a bare `z-index`: the rungs and the palette are
  `hud/tokens.css`, and `hudCss.test.ts` checks both.
* **The anchors come from the renderer, as numbers.** `RendererHost` publishes
  `{ handBand, compass }` into `hud/hudAnchors.ts`; `TableRenderer.handBandRect()`
  is the lock-independent hand band. The HUD never reads the DOM past its own
  safe-area probe and never calls the renderer.
* **Slots, not new layouts.** H3–H5 mount into `HudLayer`'s props (`hintRow`,
  `actionRail`, `resultCard`, `toasts`, `sheet`) and the one `Sheet` primitive.

## 4. UI / UX Design Constraints (React)
* **Mobile-First, Stacked Layout:** The 2D UI must be optimized for portrait mode on mobile devices.
  The stacked layout is the accessible 2D fallback and what a browser without WebGL2 draws.
* **View modes:** The View control switches the same hand between the full-window rendered **3D**
  table, the stacked layout and the flat top-down **plan** view. **3D is the default** (user decision
  2026-11-20): every browser opens on it, the other two are options in the control, and the player's
  pick is remembered locally under its own key (`riichiprac.table-view`), separate from the older
  settings blob so a 2D choice stored while 3D was opt-in does not keep anyone out of 3D. A browser
  that cannot run 3D draws the stacked table, says why, and keeps the choice. `?renderer=3d` still
  overrides for review links. Switching never re-deals.
* **No skeuomorphism by default:** Do NOT make a physically rich, square Mahjong table the
  default view. (The 3D table is the default *view*; it is the signed-off camera and carve, not a
  modelled room, rails or floors — see §3b.)
* **Top-down plan view:** a flat 2D plan (human at the bottom edge, one seat per table edge)
  with no perspective or camera tilt. Its table edges hold only tiles: winds, scores, and
  Riichi sticks live on the compass in the middle, one corner facing each player.
* **3D view (the default):** a real-time three.js scene with the committed
  tile proportions and carved faces (see §3b). It **takes the whole browser window and the full
  height of the screen**, and **no UI panel sits above or below the canvas** in the document flow. The UI —
  status cards, action bar, hand dock, plus the projected hand buttons and compass — is a
  **floating layer over the scene** (Z order, like a typical game HUD): the hand/draw buttons
  landed in 3D-08, the compass in 3D-09, targeting as `position: fixed` in 3D-H2, together with
  the shell's top bar (**the app name "riichiprac" on the very top-left with the Setup trigger under it — from
  3D-H4 — plus Next Scenario and full screen; no scenario name, no lesson label**), its safe-area handling,
  the sheet primitive and the mounted full-screen toggle. 3D-H3…H5 fill that shell (action rail, toasts,
  setup sheet, result card and verdict
  sheet). A full-screen
  toggle promotes the shell so the layer comes along. The stacked and top-down views keep their
  own layout, and leaving 3D restores it. See
  `3d_hud.md` (the HUD composition and overlay contract) and
  `3d_renderer_implementation_plan.md` (§2.1, §2.7, §11, §9 decision 7; decision D13's "opt-in,
  never the default" is superseded by the 2026-11-20 default decision).
* **Layout Structure:**
  * 4 strictly vertical flex/grid rows (one for each player).
  * Each opponent row displays their Wind, Points, Melds, and Discard River.
  * The Human Player's row is pinned to the bottom of the screen and includes their 14-tile active hand for easy tapping.
* **Visual Rules:** Riichi discards must be horizontal in the river. In the 2D views, rotate the
  tile glyph and keep the tile upright; never rotate a pre-shaded tile image. In 3D, lay the tile
  body sideways. Riichi sticks must be visibly rendered for players who have called Riichi.
* **Scenario sources (replay-first, shipped 2026-11-20):** replay rows — the
  real played games shipped as replay packs, badged **REPLAY** and listed under
  the picker's **Replay** source filter — are the default and prominent source
  for every lesson with shipped coverage (26 of the 28 lesson ids the seven packs
  cover, 9,328 reviewed bases); generated
  lessons remain available as the opt-in/fallback alternative (the **Generated**
  filter, `preferReplay: false` persisted, and the **GENERATED** badge). The
  filters are exclusive: Replay lists replay rows only, Generated lists generated
  rows only, and Both lists every row, so a lesson without a replay row is
  reachable under Generated or Both. A lesson without enough reviewed replay
  bases keeps its generated default. The covered/uncovered decision is RF2's
  manifest-driven coverage model and the first deal is replay-first too (RF4), so
  do not re-implement either in React. The build-wide flip is
  `DEFAULT_PREFER_REPLAY` in `frontend/src/store/useSettingsStore.ts`; the full
  rollback and the coverage floor are in `replay-first-rollout.md`.

## 5. Agent Workflow Rules
* Always write WASM-compatible Rust tests (`#[wasm_bindgen_test]`) to verify generator logic before attempting to render the state in React.
* Keep pull requests and file modifications strictly bounded to the current task. Do not jump ahead to frontend styling if asked to write backend generators.
* Rely on the `agari` crate's documentation for all mathematical hand evaluations.
* When you change a 3D asset or the carve, verify it instead of eyeballing it:
  `node frontend/tools/relief3d/bake-relief3d.mjs --check` (pins and measured
  carve numbers) and the `reliefAssets.test.ts` pins in `npm test`. The glyph
  masters have their own check: `cd tools/render && npm run check:faces`.
  Never hand-edit a generated atlas or the glyph PNGs.
* Keep the 3D view's interaction and ARIA behaviour equivalent to the top-down view. The stacked and top-down views remain the accessible fallback.
* Visual work follows §6: verify visuals with scripted checks or hand the artifact to the user. Never sign off a render, screenshot, or layout from your own inspection.

## 5b. Offline compute policy: use the whole machine

Offline, non-interactive miner/corpus stages are CPU-intensive and must use the
whole machine by default. This covers corpus generation, ingest, extraction,
labelling, selection and review-report building, transform/variant generation,
and any future batch scenario mining. "Use the whole machine" means:

* derive worker counts from available cores (for example `available_parallelism`
  or the corpus plan's `workers`/`allow_parallel`), not a hard-coded 1;
* parallelise per game, per replay file, or per independent state, and merge
  deterministic results in file order so the output stays reproducible;
* expose an explicit bounded mode for tests, fixtures, debugging and initial
  development (`--workers 1`, a fixture plan, or a small `--limit`), and make
  those the exception rather than the default;
* print phase and file progress for long runs, so "how far along is it?" has a
  measured answer instead of a guess;
* record the worker count and wall time in the run report or evidence.

A single-threaded offline run is a defect unless it is intentionally bounded for
testing/initial development or the operator explicitly asks for it. Do not trade
throughput for quiet defaults: a 500-game labelling or selection pass should use
all cores.

Status (Q2p, 2026-11-18): every implemented batch stage honours this —
`select`, `extract`, `label` and `transform` take `--workers N` (default `0` =
every available core) and `--progress`, parallelise per replay file or base,
merge in the serial order, and record the resolved worker count and wall time in
their reports. The shared pool/progress/shared-connection helpers live in
`src/miner/parallel.rs`, and the contract plus its tests are described in
`replay-miner-operations.md` ("Parallel execution (Q2p)"). The measured evidence
for the 544-game extract and label passes is in `q2-scale-up-1000.md`.

## 5c. Model weights in worktrees (Mortal tensors)

`frontend/public/models/mortal_298k.safetensors` is **gitignored**, so a fresh
worktree does not have it. The app's Mortal evaluation and
`mine_replays label --weights` both need it.

**Canonical copy on this machine (the main checkout):**

```
/home/kylehipke/workspaces/riichiprac/frontend/public/models/mortal_298k.safetensors
```

43,555,532 bytes, SHA-256
`afb911473ac8e20cb249c4c71344cf92c780cfc98d405c60574f38f485ccc128`.

To use it in a worktree, either point `--weights` at the path above, or copy it
into the worktree so the dev server serves `/models/mortal_298k.safetensors`:

```bash
cp /home/kylehipke/workspaces/riichiprac/frontend/public/models/mortal_298k.safetensors \
   frontend/public/models/mortal_298k.safetensors
```

Do not commit the file and do not re-download a different checkpoint: the hash
above is the `mortal_298k` labeler identity used by the replay packs. If the
main checkout is missing, other copies live under
`~/migration-kit/opencode-migration-*/workspaces/*/frontend/public/models/`, but
verify the SHA-256 before use. `cargo test --features miner` and the labeler
tests skip or fail closed when the weights are absent; the app itself runs
without them until Mortal is requested.

## 6. Visual Work: Do Not Look and Judge; Ask the User

**Rule.** An agent working in this repo must not form a visual, aesthetic, or "does this look right"
judgement from its own inspection of an image, render, screenshot, or live page. The agent's visual
perception and taste are unreliable, so any verdict it reaches that way is worthless and must not be
treated as verification. Judge only through **programmatic / scripted checks**, or hand the artifact
to the user and ask.

This is a standing rule for every riichiprac session, not a preference for one task.

### What counts as a legitimate check

A check is legitimate when a script prints pass/fail or numbers, so the result does not depend on
the agent's eyes:

* **Pixel / colour assertions** over a decoded image: read the RGBA buffer and assert on specific
  pixels, rows, channel ranges, or a count of clipped pixels. `tools/render/scripts/check-faces.mjs`
  and `frontend/src/renderers/three/reliefAssets.test.ts` are the models — their PNG decoding
  turns "is this clipping?" into numbers instead of an eyeball call.
* **Rect / geometry assertions**: every atlas cell lies inside its declared grid, the glyph rect
  maps onto the face plate, the layout constants' extents match the solved transforms, and every
  declared texture size matches the file on disk.
* **Manifest / asset bounds validation**: every path referenced by `relief3d.json` or `faces.json`
  exists, every required key is present, every face has one entry, and the declared sizes and
  decoded-RGBA hashes match the files on disk. Keep this integrity test scripted and
  dependency-free.
* **Dimension / decoded-pixel and hash diffs**: re-render and compare against a known-good baseline.
  Hash **decoded RGBA**, not the PNG bytes — Blender's container bytes can differ run to run while
  the image is identical.
* **File-size and byte budgets**: the committed assets are measured; the §1c budget figures are
  advisory during development, not a reason to degrade an asset.
* **DOM / layout / ARIA assertions in `vitest`**: element presence, roles, labels, text, classes,
  ordering, and interaction effects (click → state change). Prefer these over describing a page.
* **Build, lint, and type checks**: `npm run build`, `npm run lint`, `cargo test`, `wasm-pack test`,
  and a clean console — these are facts, not opinions.

Explicitly **not** acceptable evidence: "the tiles look a bit dark", "the spacing feels tight",
"the perspective seems off", "that renders fine to me", or any conclusion drawn from opening the
image, the contact sheet, or a browser window. If that sentence is the only basis for calling the
work done, the work is not verified.

### What to do instead

1. **Save the artifact to a path the user can open.** Keep task output inside the worktree (or
   `/tmp/opencode` for throwaways): the committed carve (`frontend/public/table/relief3d/` +
   `relief3d.json`), the glyph masters (`frontend/public/table/faces/`), or a named screenshot of
   the `?renderer=3d` view.
2. **Tell the user the path and the command to view it**, e.g. `xdg-open <path>`,
   `code <path>`, `node frontend/tools/relief3d/bake-relief3d.mjs --check` for the numbers,
   `cd frontend && npm run dev` → `http://localhost:5173/?renderer=3d`, or another artifact path.
3. **Say exactly what to look at and what question needs an answer**, and what to compare it
   against ("compare this atlas to the one at `HEAD~1`", "is the resin seam visible on the top
   bevel at final resolution?", "does the riichi stick's shadow still point down-right?").
4. **State the numbers you already checked** so the user only judges what only they can judge.
5. **Wait for their verdict before calling the visual work done**, and record it in the relevant
   plan/report. If they say it is wrong, change the spec/code — never hand-edit a generated image.

### Where this rule bites

* **3D carve and glyph masters.** All asset judgement is numeric or the user's. When you need a new
  check, add it to `reliefAssets.test.ts`, `bake-relief3d.mjs --check` or
  `tools/render/scripts/check-faces.mjs` so it **prints numbers**, rather than narrating what the
  image looks like. After a regeneration, give the user the atlas path
  (`frontend/public/table/relief3d/`), the `--check` output and the `relief3d.json` diff, then ask
  whether the bake is acceptable.
* **Frontend visual diffs.** Assert structure and behaviour in `vitest` (roles, labels, classes,
  ordering, ARIA, click effects, computed geometry where jsdom allows) and keep the views'
  accessibility equivalent. For anything purely visual — spacing, colour, the 3D scene's felt,
  lighting and composition — start `npm run dev`, give the user the URL and what to compare, and
  let them decide. Never diff two screenshots yourself and declare a match, and never claim a
  layout "looks correct" from a description of the CSS.
