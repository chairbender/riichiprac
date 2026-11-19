# Glyph-master baker (retained from the retired 2.5D pipeline)

The 2.5D render pipeline was removed on 2026-11-19 (task 261119-1637). This
directory keeps one piece of it because the **3D** renderer still needs it: the
tile-face glyph masters.

## Why this survives

`frontend/tools/relief3d/bake-relief3d.mjs` samples the committed 300×400 glyph
masters in `frontend/public/table/faces/<id>.png` to bake the 3D face albedo,
normal/height and AO/roughness atlases (`frontend/public/table/relief3d/`).
Those masters are rasterised from the public-domain SVG sources here, so this
is the reproducible producer of a 3D build input, not a 2.5D runtime asset.

Sources: `faces/` (37 symbol-only SVGs; provenance in `faces/SOURCE.md`).
Configuration and output paths: `faces-spec.json`.

## Commands

```bash
cd tools/render
npm ci                       # @resvg/resvg-js, pinned
npm run faces                # re-bake frontend/public/table/faces/*.png + faces.json
npm run faces:verify         # prove the bake is deterministic
npm run check:faces          # validate the committed masters against faces.json
```

No Blender and no browser are involved.

## Not here any more

The shell, felt, decal, shadow, overlay, board-background and table-layout
bakers, the whole-table calibration rig, the layout labs and the Task 4B relief
baker were all deleted with the pipeline. They live in git history; nothing the
3D chain runs referenced them.
