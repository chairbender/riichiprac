#!/usr/bin/env node
/**
 * Group shadows: merged footprint vs per-tile max, with numbers and sheets.
 *
 *   node tools/render/scripts/preview-group-shadow.mjs [--zone hand-14]
 *
 * No Blender, no shell re-render. Every group is composed twice from the same
 * hard shapes:
 *
 *   - merged : union the hard footprints, blur once  (the group recipe)
 *   - perTile: blur each footprint, take the max      (the Phase 1d contract)
 *
 * and written over the felt with the committed bodies. The numbers report the
 * alpha difference and the worst horizontal alpha step (a seam) in each.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drawSprite, encodePng, readPng, zoomNearest } from './png.mjs';
import { deriveShadowShape, shadowAlpha, shadowOverRgba } from './shadow-group.mjs';
import { buildZones } from './group-layouts.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(renderDir, 'build', 'preview');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const spec = await readJson(join(renderDir, 'shell-spec.json'));
const feltSpec = await readJson(join(renderDir, 'felt-spec.json'));
const manifestPath = join(renderDir, spec.outputs.manifest);
const manifest = await readJson(manifestPath);
const tableDir = resolve(dirname(manifestPath));
const [feltR, feltG, feltB] = feltSpec.baseColor;

const args = process.argv.slice(2);
const zoneIndex = args.indexOf('--zone');
const onlyZone = zoneIndex >= 0 ? args[zoneIndex + 1] : null;

mkdirSync(outDir, { recursive: true });

const feltCanvas = (width, height) => {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = feltR;
    data[i * 4 + 1] = feltG;
    data[i * 4 + 2] = feltB;
    data[i * 4 + 3] = 255;
  }
  return { width, height, channels: 4, stride: width * 4, data };
};

const bodyCache = new Map();
const bodyOf = (id) => {
  if (!bodyCache.has(id)) {
    bodyCache.set(id, readPng(resolve(tableDir, manifest.shells[id].textureFile)));
  }
  return bodyCache.get(id);
};

// The derived shape is relative to the body-box left/top (the tile's grid).
const shapeAt = (tile, pad) => {
  const shape = deriveShadowShape(manifest.shells[tile.id], spec);
  if (!shape) throw new Error(`no shadow shape for ${tile.id}`);
  return {
    ...shape,
    centre: [tile.gridX + shape.centre[0] + pad, tile.gridY + shape.centre[1] + pad],
  };
};

function compose(zone, mode) {
  const pad = zone.blurPad;
  const width = zone.width + 2 * pad;
  const height = zone.height + 2 * pad;
  const image = feltCanvas(width, height);
  const shapes = zone.tiles.map((tile) => shapeAt(tile, pad));
  const alpha = shadowAlpha(width, height, shapes, mode);
  shadowOverRgba(image, alpha, shapes[0].colour);
  for (const tile of zone.bodies) {
    const entry = manifest.shells[tile.id];
    const sprite = bodyOf(tile.id);
    drawSprite(
      image,
      sprite,
      Math.round(pad + tile.gridX - entry.anchorX),
      Math.round(pad + tile.gridY - entry.anchorY),
    );
  }
  return { image, alpha };
}

function compare(zone, merged, reference) {
  const pixels = merged.length;
  let sum = 0;
  let max = 0;
  let samples = 0;
  for (let i = 0; i < pixels; i += 1) {
    if (merged[i] < 0.01 && reference[i] < 0.01) continue;
    const delta = Math.abs(merged[i] - reference[i]);
    sum += delta;
    max = Math.max(max, delta);
    samples += 1;
  }
  return { mean: sum / Math.max(1, samples), max, samples };
}

/**
 * Worst *kink* in the shadow field at a tile boundary: a seam is a step, so the
 * alpha at the boundary departs from the midpoint of its neighbours ±4 px. A
 * smooth Gaussian, however wide, has a small second difference.
 */
function seam(width, height, alpha, boundaries) {
  let worst = 0;
  let at = null;
  for (const boundary of boundaries) {
    const x = Math.max(4, Math.min(width - 5, Math.round(boundary)));
    for (let y = 0; y < height; y += 1) {
      const value = alpha[y * width + x];
      if (value < 0.02) continue;
      const left = alpha[y * width + x - 4];
      const right = alpha[y * width + x + 4];
      const kink = Math.abs(value - (left + right) / 2);
      if (kink > worst) {
        worst = kink;
        at = [x, y];
      }
    }
  }
  return { worst, at };
}

/** Midpoints between adjacent tile anchors: where a slice would have a seam. */
function boundariesOf(zone) {
  const xs = [...new Set(zone.tiles.map((tile) => tile.gridX))].sort((a, b) => a - b);
  const result = [];
  for (let index = 1; index < xs.length; index += 1) {
    if (xs[index] - xs[index - 1] < 8) continue;
    result.push((xs[index] + xs[index - 1]) / 2);
  }
  return result;
}

const zones = buildZones(manifest, spec).filter(
  (zone) => !onlyZone || zone.id === onlyZone,
);

const write = (name, image) => {
  const path = join(outDir, name);
  const bytes = encodePng(image.width, image.height, image.channels, image.data);
  writeFileSync(path, bytes);
  return `${path}  ${image.width}x${image.height}  ${bytes.length} B`;
};

let failures = 0;
for (const zone of zones) {
  const merged = compose(zone, 'merged');
  const reference = compose(zone, 'perTile');
  const delta = compare(zone, merged.alpha, reference.alpha);
  const boundaries = boundariesOf(zone);
  const mergedSeam = seam(merged.image.width, merged.image.height, merged.alpha, boundaries);
  const referenceSeam = seam(
    reference.image.width,
    reference.image.height,
    reference.alpha,
    boundaries,
  );
  const rows = [
    write(`group-shadow-${zone.id}-merged-1x.png`, merged.image),
    write(`group-shadow-${zone.id}-reference-1x.png`, reference.image),
  ];
  // A visual diff: black where the two agree, brighter where they diverge.
  const diff = feltCanvas(merged.image.width, merged.image.height);
  for (let i = 0; i < merged.alpha.length; i += 1) {
    const value = Math.min(255, Math.round(Math.abs(merged.alpha[i] - reference.alpha[i]) * 255 * 6));
    diff.data[i * 4] = value;
    diff.data[i * 4 + 1] = value;
    diff.data[i * 4 + 2] = value;
  }
  rows.push(write(`group-shadow-${zone.id}-diff-1x.png`, diff));
  if (
    (zone.id.startsWith('hand') || zone.id.startsWith('pond')) &&
    zone.width < 760
  ) {
    const pad = zone.blurPad;
    rows.push(
      write(
        `group-shadow-${zone.id}-merged-3x.png`,
        zoomNearest(
          merged.image,
          Math.max(0, pad - 4),
          Math.max(0, pad - 4),
          Math.min(merged.image.width - pad + 4, 260),
          Math.min(merged.image.height - pad + 4, 160),
          3,
        ),
      ),
    );
  }
  for (const row of rows) console.log(row);
  console.log(
    `ZONE ${zone.id}: ${zone.width}x${zone.height}, ${zone.tiles.length} shadow tiles, ` +
      `${zone.bodies.length} bodies, sigma ${zone.sigma} px, blur pad ${zone.blurPad}`,
  );
  console.log(
    `  alpha vs per-tile max: mean ${delta.mean.toFixed(4)}, max ${delta.max.toFixed(4)}, ` +
      `${delta.samples} shadow px`,
  );
  console.log(
    `  worst boundary kink (${boundaries.length} seams): merged ${mergedSeam.worst.toFixed(4)} ` +
      `at ${JSON.stringify(mergedSeam.at)}, per-tile ${referenceSeam.worst.toFixed(4)} ` +
      `at ${JSON.stringify(referenceSeam.at)}`,
  );
  if (delta.mean > 0.05) failures += 1;
}

// ---------------------------------------------------------------------------
// Trust check: does the derived hard shape reproduce the per-shell sprite?
// Run `bake-shells.sh --preview-shadow --only <id>` first for any shell listed.
// ---------------------------------------------------------------------------
const previewIds = ['shell_hand_slot_06', 'shell_flat_upright', 'shell_flat_sideways'];
console.log('SHAPE CHECK: derived shape vs build/preview single-tile sprites');
for (const id of previewIds) {
  let sprite;
  try {
    sprite = readPng(join(outDir, `shadow-${id}-sprite.png`));
  } catch {
    console.log(`  ${id}: no preview sprite (run --preview-shadow --only ${id})`);
    continue;
  }
  const entry = manifest.shells[id];
  const shape = deriveShadowShape(entry, spec);
  const pads = entry.shadowBlob.lying
    ? spec.bake.shadow.padding1x
    : spec.bake.shadow.standingPadding1x ?? spec.bake.shadow.padding1x;
  const width = entry.advanceWidth + pads.left + pads.right;
  const height = entry.advanceHeight + pads.top + pads.bottom;
  if (width !== sprite.width || height !== sprite.height) {
    console.log(
      `  ${id}: sprite ${sprite.width}x${sprite.height} but the spec box is ${width}x${height}`,
    );
    continue;
  }
  const placed = {
    ...shape,
    centre: [shape.centre[0] + pads.left, shape.centre[1] + pads.top],
  };
  const alpha = shadowAlpha(width, height, [placed], 'merged');
  let max = 0;
  let sum = 0;
  let samples = 0;
  for (let y = 2; y < height - 2; y += 1) {
    for (let x = 2; x < width - 2; x += 1) {
      const i = y * width + x;
      const delta = Math.abs(alpha[i] - sprite.data[i * 4 + 3] / 255);
      max = Math.max(max, delta);
      sum += delta;
      samples += 1;
    }
  }
  console.log(
    `  ${id}: mean ${(sum / samples).toFixed(4)}, max ${max.toFixed(4)} ` +
      `(${shape.lying ? 'lying' : 'standing'}, angle ${shape.angleDeg.toFixed(2)} deg)`,
  );
  if (max > 0.05) failures += 1;
}

console.log(
  failures === 0
    ? 'GROUP SHADOW: shape derivation matches the committed single-tile shadows.'
    : `GROUP SHADOW: ${failures} zone(s) or shape(s) outside tolerance.`,
);
