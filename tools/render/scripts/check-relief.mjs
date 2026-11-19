#!/usr/bin/env node
/**
 * Integrity check for the Task 4B orthographic carved relief maps.
 *
 *   node tools/render/scripts/check-relief.mjs            # committed atlases (CI)
 *   node tools/render/scripts/check-relief.mjs --build    # build/relief.json (preview)
 *
 * Dependency-free on purpose: it runs in CI and never needs Blender or resvg.
 * It validates facts, not looks (AGENTS.md §6):
 *
 *   - relief-spec.json still declares the required contract: 256 x 340 px per
 *     tile, 0.45-0.65 mm engraving with a 35-45 degree V-carve wall, 0.45 / 0.12
 *     roughness, and the three named atlases;
 *   - relief.json lists every face exactly once in a 256 x 340 cell inside the
 *     atlas, with non-overlapping rects, and every atlas decodes as 8-bit RGBA
 *     at the declared size with the recorded byte count and decoded-RGBA hash;
 *   - per face, un-carved resin is exactly 0.0 paint alpha and #FFFFFF albedo,
 *     the painted groove floor is paint alpha 1 / depth 0 / flat normal /
 *     0.12 roughness, and the open face is depth 1 / flat normal / AO ~1.0 /
 *     0.45 roughness;
 *   - the measured V-carve wall angle in the normal map is inside 35-45 degrees
 *     (its median), and the depth ramp is exactly the wall run wide outside the
 *     paint silhouette;
 *   - the three atlases are pixel-aligned: the albedo paint mask and the
 *     roughness paint gate agree, and every non-flat normal / non-1 depth pixel
 *     lies in the paint's wall band (never on the open face);
 *   - the paint silhouette matches the committed flat glyph (IoU), so the relief
 *     map can replace the fallback glyph without the symbol moving, and the
 *     pigment RGB matches the flat glyph's pigment.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng } from './png.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tableDir = resolve(renderDir, '../../frontend/public/table');
const build = process.argv.includes('--build');
const manifestPath = build ? join(renderDir, 'build/relief/preview.json') : join(tableDir, 'relief.json');
const assetRoot = build ? join(renderDir, 'build/relief') : tableDir;
const spec = JSON.parse(readFileSync(join(renderDir, 'relief-spec.json'), 'utf8'));
const facesSpec = JSON.parse(readFileSync(join(renderDir, spec.source.facesSpec), 'utf8'));

const failures = [];
let checks = 0;
const strictBudget = process.argv.includes('--strict-budget');

function check(condition, label) {
  checks += 1;
  if (condition) {
    console.log(`PASS ${label}`);
  } else {
    failures.push(label);
    console.log(`FAIL ${label}`);
  }
}

function note(message) {
  console.log(`INFO ${message}`);
}

function budgetCheck(condition, label) {
  checks += 1;
  if (condition) console.log(`PASS ${label}`);
  else if (strictBudget) {
    failures.push(label);
    console.log(`FAIL ${label}`);
  } else console.log(`WARN ${label} (advisory; --strict-budget to fail)`);
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const cellWidth = Number(spec.raster.cellWidth);
const cellHeight = Number(spec.raster.cellHeight);

// ---------------------------------------------------------------------------
// Spec contract
// ---------------------------------------------------------------------------

function checkSpec() {
  check(spec.version === 1, `relief-spec.json version is 1 (${spec.version})`);
  check(
    cellWidth === 256 && cellHeight === 340,
    `relief-spec.json cell is 256x340 (${cellWidth}x${cellHeight})`,
  );
  const expectedFaces = facesSpec.faces.length;
  check(
    Number(spec.raster.columns) * Number(spec.raster.rows) >= expectedFaces,
    `atlas grid fits all ${expectedFaces} faces (${spec.raster.columns}x${spec.raster.rows})`,
  );
  const [minDepth, maxDepth] = spec.carve.depthRangeMm;
  check(
    spec.carve.depthMm >= minDepth && spec.carve.depthMm <= maxDepth,
    `engraving depth ${spec.carve.depthMm} mm is inside ${minDepth}-${maxDepth} mm`,
  );
  const [minAngle, maxAngle] = spec.carve.wallAngleRangeDeg;
  check(
    spec.carve.wallAngleDeg >= minAngle && spec.carve.wallAngleDeg <= maxAngle,
    `V-carve wall ${spec.carve.wallAngleDeg} deg is inside ${minAngle}-${maxAngle} deg`,
  );
  check(
    spec.carve.bevelSide === 'outside-glyph',
    `bevel sits outside the glyph outline (${spec.carve.bevelSide})`,
  );
  check(
    Math.abs(spec.paint.roughness.open - 0.45) < 1e-9 &&
      Math.abs(spec.paint.roughness.paint - 0.12) < 1e-9,
    `roughness is 0.45 resin / 0.12 lacquer (${spec.paint.roughness.open}/${spec.paint.roughness.paint})`,
  );
  check(
    spec.ao.distanceMm > 0 &&
      spec.ao.remap?.floor > 0 &&
      spec.ao.remap.floor < 0.45 &&
      spec.ao.remap.low > 0 &&
      spec.ao.remap.low < 1 &&
      spec.ao.remap.gamma > 0,
    `AO cavity remap is configured (${JSON.stringify(spec.ao.remap)})`,
  );
}

// ---------------------------------------------------------------------------
// Small image helpers
// ---------------------------------------------------------------------------

function crop(image, x, y, width, height) {
  const data = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const source = ((y + row) * image.width + x) * 4;
    data.set(image.data.subarray(source, source + width * 4), row * width * 4);
  }
  return { width, height, channels: 4, data };
}

/** Binary dilation with a square window, separable and dependency-free. */
function dilate(mask, width, height, radius) {
  const horizontal = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let hit = 0;
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      for (let sx = x0; sx <= x1; sx += 1) {
        if (mask[y * width + sx]) {
          hit = 1;
          break;
        }
      }
      horizontal[y * width + x] = hit;
    }
  }
  const output = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let hit = 0;
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(height - 1, y + radius);
      for (let sy = y0; sy <= y1; sy += 1) {
        if (horizontal[sy * width + x]) {
          hit = 1;
          break;
        }
      }
      output[y * width + x] = hit;
    }
  }
  return output;
}

/** Erosion is the complement of a dilation of the complement. */
function erode(mask, width, height, radius) {
  const inverse = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) inverse[i] = mask[i] ? 0 : 1;
  const grown = dilate(inverse, width, height, radius);
  const output = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) output[i] = grown[i] ? 0 : 1;
  return output;
}

/** Bilinear alpha sample of a committed flat glyph at face-local (u, v). */
function glyphAlpha(glyph, u, v) {
  const gx = Math.min(glyph.width - 1, Math.max(0, u * glyph.width - 0.5));
  const gy = Math.min(glyph.height - 1, Math.max(0, v * glyph.height - 0.5));
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(glyph.width - 1, x0 + 1);
  const y1 = Math.min(glyph.height - 1, y0 + 1);
  const fx = gx - x0;
  const fy = gy - y0;
  const at = (x, y) => glyph.data[(y * glyph.width + x) * 4 + 3] / 255;
  return (
    at(x0, y0) * (1 - fx) * (1 - fy) +
    at(x1, y0) * fx * (1 - fy) +
    at(x0, y1) * (1 - fx) * fy +
    at(x1, y1) * fx * fy
  );
}

function glyphRgb(glyph, u, v) {
  const x = Math.min(glyph.width - 1, Math.max(0, Math.round(u * glyph.width - 0.5)));
  const y = Math.min(glyph.height - 1, Math.max(0, Math.round(v * glyph.height - 0.5)));
  const index = (y * glyph.width + x) * 4;
  return [glyph.data[index], glyph.data[index + 1], glyph.data[index + 2]];
}

const flatNormal = (r, g, b) => Math.abs(r - 128) <= 2 && Math.abs(g - 128) <= 2 && b >= 252;

// ---------------------------------------------------------------------------
// Manifest and atlases
// ---------------------------------------------------------------------------

function checkManifest(manifest) {
  check(manifest.version === 1, `relief.json version is 1 (${manifest.version})`);
  check(
    manifest.state === (build ? 'preview' : 'committed'),
    `relief.json state is ${build ? 'preview' : 'committed'} (${manifest.state})`,
  );
  check(
    manifest.raster?.cellWidth === cellWidth && manifest.raster?.cellHeight === cellHeight,
    `relief.json cell is 256x340 (${manifest.raster?.cellWidth}x${manifest.raster?.cellHeight})`,
  );
  const columns = manifest.raster.columns;
  const rows = manifest.raster.rows;
  check(
    manifest.raster.atlasWidth === columns * cellWidth &&
      manifest.raster.atlasHeight === rows * cellHeight,
    `atlas is ${columns * cellWidth}x${rows * cellHeight} (${manifest.raster.atlasWidth}x${manifest.raster.atlasHeight})`,
  );
  check(
    manifest.raster.plateMm?.length === 2 &&
      Math.abs(manifest.raster.plateMm[0] - 17.92) < 0.01 &&
      Math.abs(manifest.raster.plateMm[1] - 24.92) < 0.01,
    `plate is the 17.92 x 24.92 mm inset face (${manifest.raster.plateMm})`,
  );
  check(
    manifest.raster.pxPerMm?.x > 14 &&
      manifest.raster.pxPerMm?.x < 15 &&
      manifest.raster.pxPerMm?.y > 13 &&
      manifest.raster.pxPerMm?.y < 14,
    `px per mm is recorded (${JSON.stringify(manifest.raster.pxPerMm)})`,
  );
  check(
    manifest.carve?.depthMm === spec.carve.depthMm &&
      manifest.carve?.wallAngleDeg === spec.carve.wallAngleDeg,
    'relief.json carve matches relief-spec.json',
  );

  const faceIds = facesSpec.faces.map((face) => face.id);
  const manifestIds = Object.keys(manifest.faces ?? {});
  if (build) {
    check(
      manifestIds.length > 0 && manifestIds.every((id) => faceIds.includes(id)),
      `the preview manifest lists known faces (${manifestIds.join(', ')})`,
    );
  } else {
    check(
      manifestIds.length === faceIds.length && faceIds.every((id) => manifest.faces[id]),
      `relief.json lists all ${faceIds.length} faces (${manifestIds.length})`,
    );
  }
  const cells = Object.entries(manifest.faces ?? {}).map(([id, face]) => ({ id, ...face.cell }));
  const indices = new Set(cells.map((cell) => cell.index));
  const columns_ = new Set(cells.map((cell) => `${cell.column},${cell.row}`));
  check(indices.size === cells.length, `every face has its own cell index (${cells.length})`);
  check(columns_.size === cells.length, 'no two faces share a cell column/row');
  let rectsOk = true;
  let rectsInside = true;
  for (const cell of cells) {
    const [u0, v0, u1, v1] = cell.rect;
    rectsOk =
      rectsOk &&
      Math.abs(u0 - cell.x / manifest.raster.atlasWidth) < 1e-7 &&
      Math.abs(v0 - cell.y / manifest.raster.atlasHeight) < 1e-7 &&
      Math.abs(u1 - u0 - cellWidth / manifest.raster.atlasWidth) < 1e-7 &&
      Math.abs(v1 - v0 - cellHeight / manifest.raster.atlasHeight) < 1e-7;
    rectsInside =
      rectsInside &&
      cell.x >= 0 &&
      cell.y >= 0 &&
      cell.x + cellWidth <= manifest.raster.atlasWidth &&
      cell.y + cellHeight <= manifest.raster.atlasHeight;
  }
  check(rectsOk, 'every face cell rect matches its pixel origin and the cell size');
  check(rectsInside, 'every face cell lies inside the atlas');

  return { faceIds, cells };
}

async function checkAtlases(manifest) {
  const atlases = {};
  let totalBytes = 0;
  for (const name of ['face_albedo', 'face_normal_depth', 'face_ao_roughness']) {
    const record = manifest.atlases?.[name];
    check(Boolean(record), `relief.json records ${name}`);
    if (!record) continue;
    const file = join(assetRoot, record.file);
    check(existsSync(file), `${name} exists (${record.file})`);
    if (!existsSync(file)) continue;
    const image = readPng(file);
    check(
      image.width === manifest.raster.atlasWidth &&
        image.height === manifest.raster.atlasHeight &&
        image.channels === 4,
      `${name} is ${manifest.raster.atlasWidth}x${manifest.raster.atlasHeight} RGBA (got ${image.width}x${image.height}/${image.channels}ch)`,
    );
    const bytes = statSync(file).size;
    totalBytes += bytes;
    check(record.bytes === bytes, `${name} byte count matches (${bytes} B)`);
    atlases[name] = { image, record };
  }
  budgetCheck(
    totalBytes <= Number(spec.output.bytesBudget),
    `relief atlas bytes ${totalBytes} <= budget ${spec.output.bytesBudget}`,
  );
  return atlases;
}

// ---------------------------------------------------------------------------
// Per-face checks
// ---------------------------------------------------------------------------

function checkFace(face, manifest, images) {
  const cell = face.cell;
  const label = face.id;
  const albedo = crop(images.face_albedo, cell.x, cell.y, cellWidth, cellHeight);
  const normal = crop(images.face_normal_depth, cell.x, cell.y, cellWidth, cellHeight);
  const material = crop(images.face_ao_roughness, cell.x, cell.y, cellWidth, cellHeight);
  const glyphPath = join(tableDir, `faces/${label}.png`);
  const glyph = existsSync(glyphPath) ? readPng(glyphPath) : null;

  const width = cellWidth;
  const height = cellHeight;
  const count = width * height;
  const paint = new Uint8Array(count);
  const roughPaint = new Uint8Array(count);
  const carved = new Uint8Array(count);

  let paintPixels = 0;
  let whiteMismatch = 0;
  const angles = [];
  let aoInteriorMin = 1;
  let glyphInk = 0;
  let glyphInkMissing = 0;
  let maskOutsideInk = 0;
  let glyphIntersection = 0;
  let glyphUnion = 0;
  let pigmentSamples = 0;
  let pigmentError = 0;
  let pigmentMax = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const p = i * 4;
      const alpha = albedo.data[p + 3];
      const r = albedo.data[p];
      const g = albedo.data[p + 1];
      const b = albedo.data[p + 2];
      const nr = normal.data[p];
      const ng = normal.data[p + 1];
      const nb = normal.data[p + 2];
      const depth = normal.data[p + 3];
      const ao = material.data[p];
      const roughness = material.data[p + 1];

      if (alpha > 127) {
        paint[i] = 1;
        paintPixels += 1;
      }
      // roughness = 114.75 - 84.15 * paintAlpha, so < 72 is the same 0.5
      // paint-mask threshold the albedo alpha uses, within 0.015 of alpha.
      if (roughness < 72) roughPaint[i] = 1;
      if (depth < 128) carved[i] = 1;
      if (alpha === 0 && (r !== 255 || g !== 255 || b !== 255)) whiteMismatch += 1;
      // Wall angle from the decoded tangent normal, for the non-flat pixels.
      if (Math.abs(nr - 128) > 3 || Math.abs(ng - 128) > 3) {
        const nx = (nr / 255) * 2 - 1;
        const ny = (ng / 255) * 2 - 1;
        const nz = (nb / 255) * 2 - 1;
        angles.push((Math.atan2(Math.hypot(nx, ny), Math.max(nz, 1e-6)) * 180) / Math.PI);
      }
      if (alpha > 200) aoInteriorMin = Math.min(aoInteriorMin, ao / 255);

      if (glyph) {
        const u = (x + 0.5) / width;
        const v = (y + 0.5) / height;
        const ink = glyphAlpha(glyph, u, v);
        if (ink > 0.5) glyphInk += 1;
        if (ink > 0.95 && alpha < 50) glyphInkMissing += 1;
        if (alpha > 200 && ink < 0.02) maskOutsideInk += 1;
        if (ink > 0.5 && alpha > 127) glyphIntersection += 1;
        if (ink > 0.5 || alpha > 127) glyphUnion += 1;
        if (ink > 0.99 && alpha > 254 && pigmentSamples < 20000) {
          const flat = glyphRgb(glyph, u, v);
          const error = Math.max(
            Math.abs(flat[0] - r),
            Math.abs(flat[1] - g),
            Math.abs(flat[2] - b),
          );
          pigmentError += error;
          pigmentMax = Math.max(pigmentMax, error);
          pigmentSamples += 1;
        }
      }
    }
  }

  // The paint's wall band: the V-carve runs outward from the paint silhouette.
  const runPx = Math.ceil(manifest.carve.wallRunMm * manifest.raster.pxPerMm.x) + 2;
  const paintReference = new Uint8Array(paint);
  if (glyph) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (glyphAlpha(glyph, (x + 0.5) / width, (y + 0.5) / height) > 0.2) {
          paintReference[y * width + x] = 1;
        }
      }
    }
  }
  const band = dilate(paintReference, width, height, runPx);
  let aoOpenMinValue = 1;
  let depthOutsideBand = 0;
  let normalOutsideBand = 0;
  let roughnessOutsideBand = 0;
  let depthOpen = 0;
  let bandPixels = 0;
  let bandCarved = 0;
  for (let i = 0; i < count; i += 1) {
    const p = i * 4;
    const depth = normal.data[p + 3];
    const nr = normal.data[p];
    const ng = normal.data[p + 1];
    const nb = normal.data[p + 2];
    const roughness = material.data[p + 1];
    if (!band[i]) {
      if (depth === 255) aoOpenMinValue = Math.min(aoOpenMinValue, material.data[p] / 255);
      if (depth !== 255) depthOutsideBand += 1;
      if (!flatNormal(nr, ng, nb)) normalOutsideBand += 1;
      if (Math.abs(roughness - 115) > 2) roughnessOutsideBand += 1;
    } else {
      bandPixels += 1;
      if (depth > 0 && depth < 255) bandCarved += 1;
    }
    if (depth === 255) depthOpen += 1;
  }

  // Cross-atlas agreement of the paint support.
  // The two-texel ring inside the paint silhouette is the lip: the render's
  // antialiasing and the rounded V-carve crease both live there, so the floor
  // contract is checked on the paint core, not on the ring.
  const paintCore = erode(paint, width, height, 2);
  const paintGrown = dilate(paint, width, height, 2);
  const roughGrown = dilate(roughPaint, width, height, 2);
  const depthTolerance = Math.ceil(((manifest.carve.handVariation ?? 0) + 0.02) * 255);
  let paintCorePixels = 0;
  let depthInPaint = 0;
  let normalInPaint = 0;
  let roughnessInPaint = 0;
  let maskDisagreement = 0;
  let misaligned = 0;
  let strongContradiction = 0;
  for (let i = 0; i < count; i += 1) {
    if (paint[i] !== roughPaint[i]) maskDisagreement += 1;
    if (paint[i] && !roughGrown[i]) misaligned += 1;
    if (roughPaint[i] && !paintGrown[i]) misaligned += 1;
    const p = i * 4;
    if (albedo.data[p + 3] > 200 && material.data[p + 1] > 100) strongContradiction += 1;
    if (!paintCore[i]) continue;
    paintCorePixels += 1;
    if (normal.data[p + 3] > depthTolerance) depthInPaint += 1;
    if (!flatNormal(normal.data[p], normal.data[p + 1], normal.data[p + 2])) normalInPaint += 1;
    const roughness = material.data[p + 1];
    if (roughness < 28 || roughness > 34) roughnessInPaint += 1;
  }
  const paintCoreDenominator = Math.max(1, paintCorePixels);

  const totalPainted = Math.max(1, paintPixels);
  const angleSorted = angles.sort((a, b) => a - b);
  const pct = (p) => (angleSorted.length ? angleSorted[Math.floor(p * (angleSorted.length - 1))] : 0);
  const iou = glyphUnion ? glyphIntersection / glyphUnion : 1;

  check(
    paintPixels === face.measured.paintPixels,
    `${label} paint pixels match the manifest (${paintPixels})`,
  );
  check(whiteMismatch === 0, `${label} un-carved albedo is #FFFFFF everywhere (${whiteMismatch} off)`);
  if (paintPixels > 0) {
    check(
      depthInPaint / paintCoreDenominator < 0.01,
      `${label} painted groove floor is at the engraving depth (${paintCorePixels} core px, ${depthInPaint} off)`,
    );
    check(
      normalInPaint / paintCoreDenominator < 0.01,
      `${label} painted groove floor is flat (${paintCorePixels} core px, ${normalInPaint} off)`,
    );
    check(
      roughnessInPaint / paintCoreDenominator < 0.01,
      `${label} painted groove is 0.12 roughness (${paintCorePixels} core px, ${roughnessInPaint} off)`,
    );
    check(
      pct(0.5) >= 35 && pct(0.5) <= 45,
      `${label} measured V-carve wall median ${pct(0.5).toFixed(2)} deg is inside 35-45 deg`,
    );
    check(
      pct(0.99) <= 46,
      `${label} measured V-carve wall p99 ${pct(0.99).toFixed(2)} deg does not exceed the 40 deg carve`,
    );
    check(
      aoInteriorMin <= 0.9,
      `${label} cavity AO darkens the groove (min ${aoInteriorMin.toFixed(3)})`,
    );
  }
  check(
    depthOutsideBand === 0,
    `${label} depth is 1 outside the ${runPx}px wall band (${depthOutsideBand} px)`,
  );
  check(
    normalOutsideBand === 0,
    `${label} normal is flat outside the wall band (${normalOutsideBand} px)`,
  );
  check(
    roughnessOutsideBand === 0,
    `${label} open face is 0.45 roughness outside the wall band (${roughnessOutsideBand} px)`,
  );
  check(
    aoOpenMinValue >= 0.95,
    `${label} open face AO is ~1.0 outside the wall band (min ${aoOpenMinValue.toFixed(3)})`,
  );
  check(
    maskDisagreement / totalPainted < 0.01,
    `${label} albedo paint mask and roughness paint gate agree at the lip (${maskDisagreement} px = ${(100 * maskDisagreement / totalPainted).toFixed(3)}%)`,
  );
  check(
    misaligned === 0,
    `${label} albedo paint mask and roughness paint gate agree within 2 px (${misaligned} px beyond)`,
  );
  check(
    strongContradiction === 0,
    `${label} no pixel is both painted albedo and open-face roughness (${strongContradiction})`,
  );
  if (paintPixels > 0) {
    check(
      bandCarved / Math.max(1, bandPixels) > 0.2,
      `${label} the wall band really carries the carved ramp (${bandCarved}/${bandPixels} px)`,
    );
  }
  if (glyph) {
    check(
      iou >= 0.97,
      `${label} paint silhouette matches the flat glyph (IoU ${iou.toFixed(4)})`,
    );
    check(
      maskOutsideInk === 0,
      `${label} no paint outside the flat glyph ink (${maskOutsideInk} px)`,
    );
    check(
      glyphInk === 0 || glyphInkMissing / glyphInk < 0.01,
      `${label} the flat glyph ink is painted (${glyphInkMissing}/${glyphInk} missing)`,
    );
    if (pigmentSamples > 100) {
      check(
        pigmentError / pigmentSamples <= 12,
        `${label} pigment RGB matches the flat glyph (mean ${(pigmentError / pigmentSamples).toFixed(2)}, max ${pigmentMax})`,
      );
    }
  }
  note(
    `${label}: paint ${paintPixels} px, wall p50 ${pct(0.5).toFixed(1)} deg, ` +
      `AO floor ${aoInteriorMin.toFixed(2)} / open ${aoOpenMinValue.toFixed(2)}, ` +
      `depth band ${bandCarved} px, flat-glyph IoU ${iou.toFixed(4)}`,
  );

  return {
    id: label,
    paintPixels,
    wallAngleP50: pct(0.5),
    wallAngleP99: pct(0.99),
    aoInteriorMin,
    aoOpenMin: aoOpenMinValue,
    iou,
    glyphInk,
    glyphInkMissing,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  checkSpec();
  check(existsSync(manifestPath), `relief manifest exists (${manifestPath})`);
  if (!existsSync(manifestPath)) {
    console.log(`\n${failures.length} failure(s) of ${checks} checks`);
    process.exitCode = 1;
    return;
  }
  const manifest = readJson(manifestPath);
  checkManifest(manifest);
  const atlases = await checkAtlases(manifest);
  if (!atlases.face_albedo || !atlases.face_normal_depth || !atlases.face_ao_roughness) {
    console.log(`\n${failures.length} failure(s) of ${checks} checks`);
    process.exitCode = 1;
    return;
  }

  const images = {
    face_albedo: atlases.face_albedo.image,
    face_normal_depth: atlases.face_normal_depth.image,
    face_ao_roughness: atlases.face_ao_roughness.image,
  };
  check(
    images.face_albedo.width === images.face_normal_depth.width &&
      images.face_albedo.width === images.face_ao_roughness.width &&
      images.face_albedo.height === images.face_normal_depth.height &&
      images.face_albedo.height === images.face_ao_roughness.height,
    'the three atlases share one pixel grid',
  );

  const results = [];
  for (const id of Object.keys(manifest.faces)) {
    results.push(checkFace({ id, ...manifest.faces[id] }, manifest, images));
  }

  const inked = results.filter((result) => result.paintPixels > 0);
  const worstIou = Math.min(...inked.map((result) => result.iou));
  const wallMin = Math.min(...inked.map((result) => result.wallAngleP50));
  const wallMax = Math.max(...inked.map((result) => result.wallAngleP50));
  const aoMin = Math.min(...inked.map((result) => result.aoInteriorMin));
  note(`faces ${results.length}, inked ${inked.length}`);
  note(`worst flat-glyph IoU ${worstIou.toFixed(4)}`);
  note(`wall angle median range ${wallMin.toFixed(2)}-${wallMax.toFixed(2)} deg`);
  note(`deepest cavity AO ${aoMin.toFixed(3)}`);
  const totalBytes = Object.values(manifest.atlases).reduce((sum, record) => sum + record.bytes, 0);
  note(`atlas bytes ${totalBytes} (${(totalBytes / 1048576).toFixed(2)} MiB)`);

  check(worstIou >= 0.97, `every inked face matches its flat glyph (worst IoU ${worstIou.toFixed(4)})`);
  check(
    inked.every((result) => result.wallAngleP50 >= 35 && result.wallAngleP50 <= 45),
    `every inked face carves at 35-45 deg (${wallMin.toFixed(2)}-${wallMax.toFixed(2)})`,
  );
  check(
    aoMin >= 0.2 && aoMin <= 0.55,
    `tight stroke intersections reach about 0.45 cavity AO (darkest ${aoMin.toFixed(3)})`,
  );

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length) {
    console.log(`${failures.length} failure(s):`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
  }
}

await main();
