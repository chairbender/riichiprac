# Retiring the 2.5D renderer (2026-11-19)

The true-3D renderer is the chosen approach (task 261119-1637). The 2.5D sprite
pipeline — runtime module, bakes, bake tooling, docs and the leftover view
wiring — is removed from the working tree. Git history keeps everything; no
archive copy is needed. This note records what went, what stayed and why.

## The audit that decided it

On `origin/main` (`a1cbf9d`, after the 3D R9 landing):

* nothing under `frontend/src/renderers/**`, `App.tsx`, `components/**` or any
  test imports `frontend/src/table/**`;
* `frontend/src/renderers/three/reliefAssets.ts` loads only
  `/table/relief3d.json` plus the three `relief3d/*.png` atlases;
* `frontend/src/renderers/three/felt.ts` generates its felt procedurally, so
  `/table/felt.png` is unused;
* the "rendered" `TableView` value and the TableStage mount never landed on
  `main` (they live on `task/261118-1657-2-5d-wire-the-rendered-view-into-the-app`);
  `TableStage.tsx` and its CSS are unreferenced leftovers of that wiring;
* `frontend/tools/relief3d/bake-relief3d.mjs` (the 3D-owned carve bake) reads the
  committed glyph masters `frontend/public/table/faces/<id>.png` — not the
  retired Task 4B relief maps — and cites the decal carve numbers, so the face
  masters are a **3D build input**, not a 2.5D runtime asset;
* `.github/workflows/deploy.yml` re-ran the 2.5D shell/face/decal checkers on
  every deploy.

## Deleted

| Path | Reason |
| --- | --- |
| `frontend/src/table/**` (15 files) | The 2.5D runtime: atlas builder/atlas, zone layout, contact overlays, tile ids, the six manifest parsers and their tests. Nothing imports it. |
| `frontend/src/components/TableStage.tsx` + the `.table-stage*` block in `App.css` | The 2.5D full-screen shell. Unmounted and imported by nothing; the stacked and top-down views have their own layout. |
| `frontend/scripts/{export-overlays,export-lying-catches,export-lying-samples,review-atlas,review-carved,review-overlays,review-lying-samples,review-zone-layout,review-contact-shadow-experiment,tune-carved}.ts` (+ `tune-carved.html`), and their `package.json` scripts | Every one imports `frontend/src/table/**` (most also `tools/render/scripts/shadow-group.mjs`). |
| `frontend/public/table/` — `shells/` (321) + `shells.json`, `blanks/` (16) + `blanks.json`, `shadows/` (24) + `shadows.json`, `overlays/` (292) + `overlays.json`, `decals/` (180) + `decals.json`, `tile_faces.png`/`tile_faces.json`, `ao_seams.json`, `board_bg.png`, `felt.png`, `catches.json`, `lying-catches.json`, `table_layout.json` | The 2.5D bakes. No runtime or 3D consumer. |
| `tools/render/` except the retained glyph-master baker below | The 2.5D bake pipeline: shell/felt/decal/shadow/board/overlay bakers, the table-layout exporter, the whole-table calibration rig and its 42 MB of reference renders, the layout labs, review/preview scripts and the retired Task 4B relief baker. Nothing in the 3D chain runs them. |
| `2_5d_implementation_plan.md`, `2_5d_mahjong_tile_rendering_architecture.md`, `rendered-table-plan.md`, `rendered-table-strip-lights-plan.md` | The 2.5D design docs (the last two already carried RETIRED banners). |
| The 2.5D verification steps in `.github/workflows/deploy.yml` | They checked shells, faces and decals that no longer ship. Replaced by the 3D carve check. |

## Kept

| Path | Why |
| --- | --- |
| `frontend/public/table/relief3d/` + `relief3d.json` | The live 3D carve channels; `reliefAssets.ts` loads them at runtime. |
| `frontend/public/table/faces/` (37 masters) + `faces.json` | **Shared, not 2.5D-only.** `frontend/tools/relief3d/bake-relief3d.mjs` samples these 300×400 public-domain glyph masters to bake the 3D albedo/normal/AO atlases. The task inventory listed `faces/` for deletion; that would have broken 3D re-bakes, so it stays. |
| `tools/render/faces/` (37 SVGs + `SOURCE.md`), `tools/render/faces-spec.json`, `tools/render/scripts/{bake-faces,face-raster,png,check-faces}.mjs`, `tools/render/package.json`, `tools/render/package-lock.json`, `tools/render/README.md` (rewritten) | The producer of those shared glyph masters: the ASCII/symbol-only SVG sources, the pinned resvg rasteriser and the manifest/hash checker. Kept so the 3D carve's input stays reproducible; ~0.8 MB. |
| `frontend/tools/relief3d/` | The 3D carve bake. |
| `frontend/src/renderers/**`, `frontend/scripts/check-3d-{layout,seams}.mjs`, `seam-probe.{ts,html}`, `riichi-mahjong-tiles` | 3D chain and shared UI (stacked/top-down views, compass/chrome overlay). |
| `frontend/src/store/useSettingsStore.ts`, `App.tsx` view switch | Only `stacked`/`topdown` exist on `main`; the 3D view is opt-in through `?renderer=3d`, never a view value. No edit needed. |
| `cargo`/WASM game state, replay/pack code, scenario packs, `frontend/public/models` | Untouched. |

## Sizes

| Tree | Before | After |
| --- | --- | --- |
| `frontend/public/table/` | 888 tracked files, 17 MB | 42 tracked files, ~3.6 MB (`relief3d` 2.9 MB + `faces` 0.6 MB + 2 manifests) |
| `tools/render/` | 172 tracked files, 45 MB | 47 tracked files, ~0.9 MB (the glyph-master baker) |
| `frontend/src/table/` | 15 files, 264 KB | gone |
| `frontend/scripts/` | 15 files | 4 files (2 × 3D gate + seam-probe page/script) |

Net: 998 tracked files and ~57 MB of 2.5D assets/tooling removed.

## Follow-ups recorded, not done here

* The 3D chain's own numbers live in `frontend/src/renderers/layoutConstants.ts`;
  comments that cited `tools/render/*.json` as the source of those numbers now
  name them as retired historical provenance (the specs are in git history).
* `frontend/src/renderers/three/reliefAssets.ts` still validates its pinned
  atlases; `node frontend/tools/relief3d/bake-relief3d.mjs --check` is the
  replacement CI gate for the removed shell/face/decal checkers.
