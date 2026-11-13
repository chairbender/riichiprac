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
* **Offline table renderer (asset pipeline, not shipped code):**
  * Visual sign-off on baked assets is the **user's**, not the agent's; see §6 before judging a render.
  * The opt-in rendered table view uses sprites baked offline from a 3D scene. Blender 4.5.9 LTS builds the scene, camera, lights, and materials from a committed Python/JSON spec; `@resvg/resvg-js` is the offline SVG rasteriser for tile-face textures. No headless browser is part of the pipeline.
  * The generator, spec, generated sprites, and manifest are committed. The design and regeneration steps live in `rendered-table-plan.md`; read it before touching rendered-table assets or layout.
  * The runtime is 2D composition only: images plus DOM. **Do NOT add a 3D/WebGL library to the frontend, and do not rasterise tile art in the browser.**

## 4. UI / UX Design Constraints (React)
* **Mobile-First, Stacked Layout:** The UI must be optimized for portrait mode on mobile devices.
  The stacked layout is the default view.
* **View modes:** The header's View control switches the same hand between the stacked layout,
  the flat top-down **plan** view, and the opt-in **rendered** table. Switching never re-deals.
* **No skeuomorphism by default:** Do NOT make a physically rich, square Mahjong table the
  default view.
* **Rendered table view:** a Tenhou-style, fixed-camera 2.5D table composed at runtime from
  offline-rendered sprites. The perspective and lighting are baked into the assets; the
  frontend remains 2D. Runtime camera controls, orbit/tilt/zoom, browser 3D, and per-frame
  lighting are out of scope. The view must provide the same information and interactions as
  the top-down view.
* **Top-down plan view:** a flat 2D plan (human at the bottom edge, one seat per table edge)
  with no perspective or camera tilt. Its table edges hold only tiles: winds, scores, and
  Riichi sticks live on the compass in the middle, one corner facing each player.
* **Layout Structure:**
  * 4 strictly vertical flex/grid rows (one for each player).
  * Each opponent row displays their Wind, Points, Melds, and Discard River.
  * The Human Player's row is pinned to the bottom of the screen and includes their 14-tile active hand for easy tapping.
* **Visual Rules:** Riichi discards must be rotated 90 degrees horizontally in the river. Riichi sticks must be visibly rendered for players who have called Riichi.

## 5. Agent Workflow Rules
* Always write WASM-compatible Rust tests (`#[wasm_bindgen_test]`) to verify generator logic before attempting to render the state in React.
* Keep pull requests and file modifications strictly bounded to the current task. Do not jump ahead to frontend styling if asked to write backend generators.
* Rely on the `agari` crate's documentation for all mathematical hand evaluations.
* Run the offline render pipeline when changing a rendered-table asset. Commit the generator/spec and the regenerated sprites + manifest together; never hand-edit a generated sprite.
* Keep the rendered view's interaction and ARIA behaviour equivalent to the top-down view. The stacked and top-down views remain the accessible fallback.
* Visual work follows §6: verify visuals with scripted checks or hand the artifact to the user. Never sign off a render, screenshot, or layout from your own inspection.

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
  pixels, rows, channel ranges, or a count of clipped pixels. `channel_stats()` in
  `tools/render/build_and_render.py` is the model — it turns "is this clipping?" into
  `maxChannel` / `clippedPixels` numbers instead of an eyeball call.
* **Rect / geometry assertions**: every face quad lies inside its body and its inset, the face
  homography (`faceMatrix`) really maps the decal rect onto the quad, crop rects stay within the
  frame, sprite dimensions equal the declared CSS size × pixel ratio.
* **Manifest / asset bounds validation**: every path referenced by the manifest exists, every tile
  code has all five orientations, draw orders are unique per stack, required keys are present, and
  the declared rects match the files on disk. (`rendered-table-plan.md` §12.13 describes this
  integrity test; keep it scripted.)
* **Dimension / decoded-pixel and hash diffs**: re-render and compare against a known-good baseline.
  Hash **decoded RGBA**, not the PNG bytes — Blender's container bytes can differ run to run while
  the image is identical (`tools/render/README.md`).
* **File-size and byte budgets**: total committed assets ≤ 8 MB, initial hand + board load ≤ 4 MB,
  per-sprite size ceilings.
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
   `/tmp/opencode` for throwaways): the render output dir and its contact sheet from
   `bash tools/render/render.sh [spec] [out-dir]`, or a screenshot saved to a named file.
2. **Tell the user the path and the command to view it**, e.g. `xdg-open <path>`,
   `code <path>`, `bash tools/render/render.sh` then `<out-dir>/contact-sheet.png`,
   `cd frontend && npm run dev` → `http://localhost:5173`, or
   `node tools/render/tune.mjs` → `http://localhost:7457` for lighting/carve tuning.
3. **Say exactly what to look at and what question needs an answer**, and what to compare it
   against ("compare this sprite to the one at `HEAD~1`", "is the blue backing band visible on the
   side edge at final resolution?", "does the streak sit on the fillet or against the paint edge?").
4. **State the numbers you already checked** so the user only judges what only they can judge.
5. **Wait for their verdict before calling the visual work done**, and record it in the relevant
   plan/report. If they say it is wrong, change the spec/code — never hand-edit a generated image.

### Where this rule bites

* **Rendered-table pipeline (`tools/render/`).** All asset judgement is numeric or the user's.
  When you need a new check, add it to `build_and_render.py`, `scripts/contact-sheet.mjs`, or the
  manifest integrity test so it **prints numbers**, rather than narrating what the image looks like.
  Use `tune.mjs` as the user's knob-turning UI — do not simulate it by editing `scene-spec.json`
  and squinting at the output. After a regeneration, give the user the out-dir, the contact sheet,
  and the manifest diff, and ask whether the bake is acceptable.
* **Frontend visual diffs.** Assert structure and behaviour in `vitest` (roles, labels, classes,
  ordering, ARIA, click effects, computed geometry where jsdom allows) and keep the views'
  accessibility equivalent. For anything purely visual — spacing, colour, the rendered table's
  perspective and composition — start `npm run dev`, give the user the URL and what to compare,
  and let them decide. Never diff two screenshots yourself and declare a match, and never claim a
  layout "looks correct" from a description of the CSS.
