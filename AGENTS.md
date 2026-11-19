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
Do not reduce decal resolution, compression quality, variant count, shell
detail, or delete assets (for example shadow sprites or fallback faces) to make
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
* **Offline tile-shell baker (asset pipeline, not shipped code):**
  * Visual sign-off on baked assets is the **user's**, not the agent's; see §6 before judging a render.
  * The opt-in rendered view composes blank tile **shells** baked offline. Blender 4.5.9 LTS builds the tile mesh, an orthographic camera, a locked top-left key plus a weak ambient fill, and the tight contact shadow/AO from a committed Python/JSON spec; `@resvg/resvg-js` rasterises the 2D face glyphs. No headless browser is part of the pipeline.
  * `shells.json` publishes each shell's texture size, anchor, advance width/height, and `faceQuad`. The runtime composites each tile face into its shell's `faceQuad` in a startup atlas and draws the board with a strict painter's algorithm; it never projects a 3D quad.
  * **Shadows are drawn from the live board state, never baked per sprite.** `frontend/src/table/boardShadows.ts` is Task 6A's four passes (mat layer → stack decal → bevel crevices → hover lift) over `shadowManifest.ts`, `seamOverlays.ts` and the Task 4A assets. The mat layer merges at MAX alpha by merging *transmittance* (`darken` on white-flattened sprites) and composites once with `multiply`; never draw two mat shadows with straight-over alpha. A crevice band is the ring between the sprite's silhouette and its face plate only — plus, on a lying tile, the near face's lit end — never a fade into the painted face — and one band per joint, on the lit edge: see `seamOverlays.ts`. A band occludes (0.85 at the crevice line, so the lit bevel loses its highlight); do not turn it back into a soft 20 % tint. Task 4A sprites are in the `table_layout.json` *reference frame* (a tile ~48 × 69 px), so they must be scaled by `referenceToShellScale` into `shells.json` space and anchored at the tile body's centre (`tileCentre`); drawing one unscaled puts its dense core at the tile's top-left corner. Its hooks are `drawMatShadowPass` once after `board_bg`, and `drawWallStackShadow` / `drawCreviceSeams` per body; the rendered view (261118-1657) owns the frame loop. Proof sheet: `cd frontend && npm run shadows:review`.
  * The active architecture is `2_5d_mahjong_tile_rendering_architecture.md`; read it before touching shells, layouts, or the compositor. Where that document's per-zone "impossible geometry" projections conflict with `2_5d_implementation_plan.md` (checked in 2026-11-17), the plan wins. `tools/render/README.md` is the active shell-baker/felt pipeline doc. `rendered-table-plan.md` and `rendered-table-strip-lights-plan.md` are **retired** design records with banners: do not regenerate or extend them.
  * **Whole-table calibration reference (not shipped).** `bash tools/render/bake-table-reference.sh --bake` builds one Blender scene of the complete table (walls, ponds, hands, drawn tile, melds, felt) from `tools/render/table-reference-spec.json`, publishes `tools/render/reference/` (a @1x board, one @2x crop per element family, a manifest with decoded-pixel hashes) and `tools/render/TABLE-REFERENCE.md` records the camera and how to compare a hybrid. It is **calibration-only**: it writes nothing under `frontend/public`, the runtime never reads it, and it is not a second source of layout truth. See §16 of the architecture doc.
  * **2.5D camera + lighting rig (not shipped).** `bash tools/render/bake-table-reference.sh --rig [--variant NAME]` renders the same scene and placements through the new pipeline's variant-based rig (`table-reference-spec.json`'s `rig` + `rig.variants`): 75 mm perspective, 50° pitch, X = 0, negative Shift Y, a soft overhead AREA key plus fills, film transparent, 1920 × 1080 RGBA. `v1-baseline` is the saved first rig; `v2-compact` is the first experiment (hands/melds at 8.8, a 40° readability-cheat hand whose shading normals are corrected to the 12° pose, key 6000 W); `v3-hand-shadow` extends it with the player's hand alone moved back to 9.3 and a shadow-only caster at the 12° pose (fills light-linked away from it); `v4-shadow-decal` keeps v3's spacing and replaces the caster with a fake soft gradient decal under the hand (hidden start under the tile, visible gradient from the front edge, no shadow rays); `v5`/`v6`/`v7` are three longer, stronger shadow takes (0.55 / 0.65 / 0.42 units, 50 / 40 / 65 % max alpha) for choosing a preference; `v10-shadow-split-blobs` rebuilds the chosen take A as the retired UI shadow recipe (one blurred contact rectangle per hand group, all four edges blurred); `v11-shadow-inner-offset` widens the hand row right end too, pushes the drawn tile blob 0.28 units past the hand, and offsets the whole footprint 0.06 units forward; `v12-shadow-symmetric` applies the UI group recipe (union the hand row and drawn tile into one footprint, blur once), so the gap is not double-darkened and the shadow is exactly symmetric; `v13-shadow-darker` keeps that shape and deepens it to match the wall key shadow (core 27 luma vs the wall 27) by offsetting the footprint 0.18 units south. **v13 is the chosen rig (user sign-off 2026-11-17) and the spec's `defaultVariant`.** Each variant publishes `tools/render/reference/rig/<variant>-1x.png` + `<variant>.json`; `reference/rig/index.html` is the A/B page. `scripts/check-table-rig.mjs` gates every committed variant (vanishing point above the frame, side-wall inner slivers, straight-on hand centre, no inward lean, framing, lit-face/blue/hand/side probes, the hand-cheat luma ratio). Calibration-only.
  * There is **no table model in the shipped 2.5D runtime**. The background is a full-screen felt raster with a vignette (`frontend/public/table/felt.png`); walls, ponds, hands, melds and (later) the compass are overlaid in screen space. Each zone uses the projection that reads best, so there is no shared perspective camera. (The 2.5D *workspace* does model the whole table in 3D as the calibration source — see §3b.)
  * The runtime is 2D composition only: images plus DOM. **Do NOT add a 3D/WebGL library to the frontend, and do not rasterise tile art in the browser.**

### 3b. The 2.5D workspace already models the tile and the table in 3D — use it, do not re-derive it

The parallel 2.5D effort has already built (and the user has signed off) most of
the 3D work the opt-in three.js view needs. Before adding geometry, a material
or a carve number under `frontend/src/renderers/three/`, read the existing source
and take the number from there. This is a standing rule for every 3D session, not
a one-off: a runtime tile that invents its own corner radius, blue band or
engraving depth is a bug even when it renders.

* **Tile body and material** — `tools/render/shell-spec.json`'s `tile` block and
  `bake_shells.py`'s `build_tile` / `build_tile_material`:
  * 21 × 28 × 16.5 mm; `bevel.width` 0.055 units with `segments` 6 and an angle
    limit of 30° on **every** edge. The silhouette corner radius is therefore one
    bevel (1.54 mm), and the face plateau, inset by `faceInset` 0.055, has a
    sharp corner (17.92 × 24.92 mm = the 0.64 × 0.89-unit glyph plate).
  * the white/blue split is a **shader gate on local Z** at
    `backEdgeFraction` 0.3 of the thickness, not a per-face material: the front
    30 % (4.95 mm) of the side wall is ivory, the back 70 % (11.55 mm) is blue,
    and the whole back plate is blue;
  * face `#f5f0eb` roughness 0.16 + coat 0.4, backing `#132986` roughness 0.18 +
    coat 0.35, both coat roughness 0.1 (`coat` is a real clear coat, not a
    roughness tweak);
  * `bake_table_reference.py` imports that same `build_tile`, so the whole-table
    model and the shipped shells cannot drift from each other.
* **Table layout and poses** — `tools/render/table-reference-spec.json` and
  `bake_table_reference.py`: 269 modelled tiles, the wall runs/stacks/tiers, the
  dead wall, the pond rows and riichi slots, the hand rows and draw gap, the meld
  rows, the mat/rim/compass well and the slot anchors. The user approved the
  table model and anchor bank on 2026-11-17. `frontend/src/renderers/layoutConstants.ts`
  mirrors those numbers; if one is missing, take it from the spec and cite it.
* **The carve** — `tools/render/decal-spec.json` and the committed carved decals
  (`frontend/public/table/decals/`) are the approved engraving look. The 3D
  chain bakes that *geometry* into its own channel atlas
  (`frontend/tools/relief3d/bake-relief3d.mjs` →
  `frontend/public/table/relief3d/` + `relief3d.json`): the glyph area pushed in
  by `depthFractionOfThickness` 0.03 (0.495 mm) through a 0.3 mm Bézier
  transition, with the wall **inside** the painted silhouette, and
  `whiteFillUncarved` / `whiteFillThreshold` 0.9 leaving the artwork's white as
  raised bare tile (`1p` alone is 17 % white). Displacement is scaled
  (`POM_HEIGHT_SCALE`) so a stroke does not slide at a grazing angle; hand the
  scale back as the depth-sweep comparison. **The Task 4B relief atlases are
  retired and were removed from the tree on 2026-11-18** — do not read
  `frontend/public/table/relief*`; the glyph masters (`faces/<id>.png`) are the
  carve's input and `relief3d/` is its output.
* **Materials and lighting** — the shells' materials above, and
  `shell-spec.json`'s `lighting` block (key azimuth 315°, elevation 55°,
  `#fff7ea`) which the 3D chain's `LIGHT` already mirrors.

Corollary: when the 3D chain and these sources disagree, the committed shell spec
and the reference table win; ask the user before inventing a third number. The
2.5D sprite pipeline is still not to be touched (§3, top of this section): this
rule is about *reading* the model work, not editing it.

## 4. UI / UX Design Constraints (React)
* **Mobile-First, Stacked Layout:** The UI must be optimized for portrait mode on mobile devices.
  The stacked layout is the default view.
* **View modes:** The header's View control switches the same hand between the stacked layout,
  the flat top-down **plan** view, and the opt-in **rendered** table. Switching never re-deals.
* **No skeuomorphism by default:** Do NOT make a physically rich, square Mahjong table the
  default view.
* **Rendered table view:** a Tenhou-style 2.5D board composed at runtime from
  six offline-baked blank tile shells plus 2D face glyphs. There is no single
  scene camera and no modelled table: each zone uses the projection that reads
  best (bottom hand front-elevation, ponds top-down, side walls fixed oblique,
  top hand/walls top-down), all over a full-screen felt raster with a vignette.
  Lighting, thickness and shadow/AO padding are baked into the shells; the
  frontend remains 2D. Runtime camera controls, orbit/tilt/zoom, browser 3D, and
  per-frame lighting are out of scope. The view must provide the same
  information and interactions as the top-down view.
* **Top-down plan view:** a flat 2D plan (human at the bottom edge, one seat per table edge)
  with no perspective or camera tilt. Its table edges hold only tiles: winds, scores, and
  Riichi sticks live on the compass in the middle, one corner facing each player.
* **3D view (opt-in, `?renderer=3d` until 3D-15):** a real-time three.js scene with the committed
  tile proportions and carved faces. Its tile body, materials, table poses and carve look come
  from the 2.5D workspace's existing 3D model work (`tools/render/shell-spec.json`,
  `bake_shells.py`, `table-reference-spec.json`, `decal-spec.json`) — see §3b; do not re-derive
  them. It **takes the whole browser window and the full height of
  the screen**, and **no UI panel sits above or below the canvas** in the document flow. While
  the view is being built (as of 3D-02) it mounts the scene alone. The planned UI — header
  controls, status cards, action bar, hand dock, plus the projected hand buttons and compass —
  is a **floating layer over the scene** (Z order, like a typical game HUD), landed in 3D-08,
  3D-09 and 3D-14; a full-screen toggle then promotes the shell so the layer comes along. The
  stacked and top-down views keep their own layout, and leaving 3D restores it. It is never the
  default and never auto-selected. See `3d_renderer_implementation_plan.md` (§2.1, §2.7, §9
  decision 7) and note that the help text for the View control still describes the two 2D views
  until 3D-14 adds the fourth.
* **Layout Structure:**
  * 4 strictly vertical flex/grid rows (one for each player).
  * Each opponent row displays their Wind, Points, Melds, and Discard River.
  * The Human Player's row is pinned to the bottom of the screen and includes their 14-tile active hand for easy tapping.
* **Visual Rules:** Riichi discards must be horizontal in the river. Use the dedicated
  `shell_flat_sideways` shell and rotate only the 2D face glyph; never rotate a pre-shaded upright
  sprite. Riichi sticks must be visibly rendered for players who have called Riichi.

## 5. Agent Workflow Rules
* Always write WASM-compatible Rust tests (`#[wasm_bindgen_test]`) to verify generator logic before attempting to render the state in React.
* Keep pull requests and file modifications strictly bounded to the current task. Do not jump ahead to frontend styling if asked to write backend generators.
* Rely on the `agari` crate's documentation for all mathematical hand evaluations.
* Run the **shell baker** and its integrity check when changing a rendered-view asset:
  `bash tools/render/bake-shells.sh --check` (no Blender) and, for the felt,
  `bash tools/render/bake-felt.sh`. Commit the baker/spec and the regenerated felt,
  shells, and `shells.json` together; never hand-edit a generated shell or the felt.
* The **carved relief maps** (Task 4B) were **retired and removed from the
  shipped tree on 2026-11-18**: the runtime relief shading (Task 5A) was rejected
  and the Phase 2b carved decals are the runtime path. The bake tooling remains
  (`bash tools/render/bake-relief.sh --bake`, gate
  `bash tools/render/bake-relief.sh --check`) if the approach is revived; do not
  commit atlas outputs back into `frontend/public/table/` without an explicit
  decision.
* The whole-table calibration reference has its own gate:
  `bash tools/render/bake-table-reference.sh --check` (no Blender). It is
  calibration-only and never a runtime dependency.
* Keep the rendered view's interaction and ARIA behaviour equivalent to the top-down view. The stacked and top-down views remain the accessible fallback.
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
  pixels, rows, channel ranges, or a count of clipped pixels. `scripts/check-shells.mjs` in
  `tools/render/` is the model — its PNG decoder turns "is this clipping?" and "does the vignette
  actually darken the edges?" into numbers instead of an eyeball call.
* **Rect / geometry assertions**: every shell's `faceQuad` lies inside its opaque body, `anchorX/Y`
  plus `advanceWidth/Height` plus the declared padding equals `texWidth/texHeight`, the sideways
  glyph rotation maps the glyph rect onto its `faceQuad`, and every shell's declared size matches
  the file on disk.
* **Manifest / asset bounds validation**: every path referenced by `shells.json` exists, every
  required key is present, every shell type has one entry per orientation, and the declared texture
  and advance sizes match the files on disk. Keep this integrity test scripted and dependency-free.
* **Dimension / decoded-pixel and hash diffs**: re-render and compare against a known-good baseline.
  Hash **decoded RGBA**, not the PNG bytes — Blender's container bytes can differ run to run while
  the image is identical (`tools/render/README.md`).
* **File-size and byte budgets**: total committed assets ≤ 8 MB, initial hand + board load ≤ 4 MB,
  per-shell size ceilings.
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
   `/tmp/opencode` for throwaways): the committed felt (`frontend/public/table/felt.png`), the
   shell output dir (`frontend/public/table/shells/`) and `shells.json`, or a named screenshot.
2. **Tell the user the path and the command to view it**, e.g. `xdg-open <path>`,
   `code <path>`, `bash tools/render/bake-shells.sh --check` for the numbers,
   `cd frontend && npm run dev` → `http://localhost:5173`, or another artifact path.
3. **Say exactly what to look at and what question needs an answer**, and what to compare it
   against ("compare this shell to the one at `HEAD~1`", "is the resin seam visible on the top
   bevel at final resolution?", "does the sideways shadow still point down-right?").
4. **State the numbers you already checked** so the user only judges what only they can judge.
5. **Wait for their verdict before calling the visual work done**, and record it in the relevant
   plan/report. If they say it is wrong, change the spec/code — never hand-edit a generated image.

### Where this rule bites

* **Shell pipeline (`tools/render/`).** All asset judgement is numeric or the user's. When you need
  a new check, add it to `scripts/check-shells.mjs` or the bakers so it **prints numbers**, rather
  than narrating what the image looks like. After a regeneration, give the user the relevant
  asset path (`frontend/public/table/felt.png`, `frontend/public/table/shells/`), the
  `bash tools/render/bake-shells.sh --check` output, and the `shells.json` diff, then ask whether
  the bake is acceptable. There is no tuner in the active pipeline.
* **Frontend visual diffs.** Assert structure and behaviour in `vitest` (roles, labels, classes,
  ordering, ARIA, click effects, computed geometry where jsdom allows) and keep the views'
  accessibility equivalent. For anything purely visual — spacing, colour, the felt/vignette,
  projection composition — start `npm run dev`, give the user the URL and what to compare, and let
  them decide. Never diff two screenshots yourself and declare a match, and never claim a layout
  "looks correct" from a description of the CSS.
