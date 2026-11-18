#!/usr/bin/env node
/**
 * Measure the Task 3 layout export against its Blender probe render.
 *
 *   node tools/render/scripts/table-layout-proof.mjs
 *
 * `bake-table-layout.sh --bake` renders one emissive marker per anchor at
 * 1920 x 1080 with every other object hidden. The marker is centred on the
 * anchor's world position, so its rendered alpha centroid is Blender's own
 * projection of that centre. This script:
 *
 *   - decodes the committed probe render, finds one connected component per
 *     marker and computes its alpha-weighted subpixel centroid;
 *   - matches every component to its exported slot one-to-one, then writes the
 *     per-slot delta and the maximum delta to `reference/layout/layout-proof
 *     .json`;
 *   - draws every exported anchor cross and face quad over the committed rig
 *     render (`overlay-1x.png`) and a 4x zoom under each bucket representative
 *     (`overlay-zoom-4x.png`), so the user can inspect the alignment;
 *   - fails when any marker is missing, any delta exceeds the spec's
 *     `proof.thresholdPx` (1 px), or the committed render cannot be read.
 *
 * The gate (`check-table-layout.mjs`) re-measures the same committed probe PNG
 * without Blender, so the 1 px claim is reproducible from the repository.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drawText } from './label-font.mjs';
import { encodePng, readPng, zoomNearest } from './png.mjs';
import { matchProbes, measureProbes } from './table-layout.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(renderDir, '..', '..');
const spec = JSON.parse(readFileSync(join(renderDir, 'table-reference-spec.json'), 'utf8'));
const layoutSpec = spec.layout;
const proofSpec = layoutSpec.proof;

const fail = (message) => {
  console.error(`table-layout-proof: ${message}`);
  process.exit(1);
};

const layoutPath = join(root, layoutSpec.output);
if (!existsSync(layoutPath)) fail(`layout missing at ${layoutPath}; run bake-table-layout.sh --bake`);
const layout = JSON.parse(readFileSync(layoutPath, 'utf8'));
const [width, height] = [layout.referenceResolution.width, layout.referenceResolution.height];

const probePath = join(renderDir, proofSpec.directory, proofSpec.probes);
if (!existsSync(probePath)) fail(`probe render missing at ${probePath}`);
const probe = readPng(probePath);
if (probe.width !== width || probe.height !== height) {
  fail(`probe is ${probe.width}x${probe.height}, expected ${width}x${height}`);
}
if (probe.channels !== 4) fail(`probe has ${probe.channels} channels, expected RGBA`);

const boardPath = join(
  renderDir,
  'reference',
  spec.rig.output.directory,
  spec.rig.output.imagePattern.replace('{variant}', layout.variant),
);
if (!existsSync(boardPath)) fail(`board render missing at ${boardPath}`);
const board = readPng(boardPath);
if (board.width !== width || board.height !== height || board.channels !== 4) {
  fail(`board is ${board.width}x${board.height}x${board.channels}, expected ${width}x${height} RGBA`);
}

const components = measureProbes(probe, proofSpec.alphaThreshold);
let measured;
try {
  measured = matchProbes(
    components,
    layout.slots,
    width,
    height,
    proofSpec.matchRadiusPx,
  );
} catch (error) {
  fail(error.message);
}
if (measured.maxDelta > proofSpec.thresholdPx) {
  fail(
    `worst marker is ${measured.maxDelta.toFixed(3)} px from the export; ` +
      `the acceptance is ${proofSpec.thresholdPx} px`,
  );
}

// --------------------------------------------------------------------------- //
// Overlay + zoom sheet
// --------------------------------------------------------------------------- //
const overlay = {
  width: board.width,
  height: board.height,
  channels: 4,
  data: Buffer.from(board.data),
};
const MAGENTA = [255, 0, 200];
const CYAN = [0, 230, 255];
const YELLOW = [255, 230, 0];

function blend(image, x, y, rgb, alpha = 1) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const offset = (y * image.width + x) * image.channels;
  for (let channel = 0; channel < 3; channel += 1) {
    image.data[offset + channel] = Math.round(
      image.data[offset + channel] * (1 - alpha) + rgb[channel] * alpha,
    );
  }
  image.data[offset + 3] = Math.max(image.data[offset + 3], Math.round(255 * alpha));
}

function line(image, x0, y0, x1, y1, rgb, alpha = 1) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let step = 0; step <= steps; step += 1) {
    const t = steps === 0 ? 0 : step / steps;
    blend(image, Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), rgb, alpha);
  }
}

for (const slot of layout.slots) {
  const x = slot.anchor.x * width;
  const y = slot.anchor.y * height;
  const quad = slot.faceQuad.map((corner) => [corner.x * width + x, corner.y * height + y]);
  for (let corner = 0; corner < 4; corner += 1) {
    const next = (corner + 1) % 4;
    line(overlay, quad[corner][0], quad[corner][1], quad[next][0], quad[next][1], CYAN, 0.55);
  }
  for (let arm = -3; arm <= 3; arm += 1) {
    blend(overlay, Math.round(x) + arm, Math.round(y), MAGENTA, 1);
    blend(overlay, Math.round(x), Math.round(y) + arm, MAGENTA, 1);
  }
}
for (const record of measured.records.values()) {
  blend(overlay, Math.round(record.probePx[0]), Math.round(record.probePx[1]), YELLOW, 1);
}
const overlayPath = join(renderDir, proofSpec.directory, proofSpec.overlay);
writeFileSync(overlayPath, encodePng(overlay.width, overlay.height, 4, overlay.data));

// One representative per bucket plus the drawn hand tile, on a 4x nearest zoom.
const zoomSlots = Object.values(layout.bucketCatalogue)
  .map((record) => record.representative)
  .concat(['hand_south_13'])
  .filter((id, index, list) => list.indexOf(id) === index);
const byId = new Map(layout.slots.map((slot) => [slot.id, slot]));
const size = proofSpec.zoomSize;
const factor = proofSpec.zoomFactor;
const cellWidth = size * factor + 24;
const labelHeight = 44;
const columns = 4;
const rows = Math.ceil(zoomSlots.length / columns);
const sheet = {
  width: columns * cellWidth,
  height: rows * (size * factor + labelHeight),
  channels: 4,
  data: Buffer.alloc(columns * cellWidth * rows * (size * factor + labelHeight) * 4),
};
for (let index = 0; index < sheet.data.length; index += 4) {
  sheet.data[index] = 18;
  sheet.data[index + 1] = 22;
  sheet.data[index + 2] = 24;
  sheet.data[index + 3] = 255;
}
zoomSlots.forEach((id, index) => {
  const slot = byId.get(id);
  if (!slot) fail(`zoom slot ${id} is not in the layout`);
  const x = Math.round(slot.anchor.x * width);
  const y = Math.round(slot.anchor.y * height);
  const cropX = Math.max(0, Math.min(width - size, Math.round(x - size / 2)));
  const cropY = Math.max(0, Math.min(height - size, Math.round(y - size / 2)));
  const crop = zoomNearest(overlay, cropX, cropY, size, size, factor);
  const cellX = (index % columns) * cellWidth;
  const cellY = Math.floor(index / columns) * (size * factor + labelHeight);
  for (let row = 0; row < crop.height; row += 1) {
    const target = ((cellY + row) * sheet.width + cellX) * 4;
    const source = row * crop.width * 4;
    crop.data.copy(sheet.data, target, source, source + crop.width * 4);
  }
  const record = measured.records.get(id);
  drawText(sheet, id, cellX + 4, cellY + size * factor + 4, { scale: 1, rgb: [230, 236, 232] });
  drawText(sheet, slot.bucket, cellX + 4, cellY + size * factor + 16, {
    scale: 1,
    rgb: [120, 220, 255],
  });
  drawText(sheet, `DELTA ${record.deltaPx.toFixed(3)} PX`, cellX + 4, cellY + size * factor + 28, {
    scale: 1,
    rgb: [255, 230, 0],
  });
});
const zoomPath = join(renderDir, proofSpec.directory, proofSpec.zoom);
writeFileSync(zoomPath, encodePng(sheet.width, sheet.height, 4, sheet.data));

const proof = {
  version: 1,
  generatedBy: 'tools/render/scripts/table-layout-proof.mjs',
  layout: layoutSpec.output,
  variant: layout.variant,
  referenceResolution: { width, height },
  probe: {
    file: `${proofSpec.directory}/${proofSpec.probes}`,
    markers: components.length,
    pixels: components.reduce((sum, component) => sum + component.pixels, 0),
    alphaThreshold: proofSpec.alphaThreshold,
  },
  board: `${spec.rig.output.directory}/${spec.rig.output.imagePattern.replace('{variant}', layout.variant)}`,
  overlay: `${proofSpec.directory}/${proofSpec.overlay}`,
  zoom: `${proofSpec.directory}/${proofSpec.zoom}`,
  thresholdPx: proofSpec.thresholdPx,
  maxDeltaPx: round(measured.maxDelta),
  meanDeltaPx: round(measured.meanDelta),
  p95DeltaPx: measured.p95,
  slots: [...measured.records.values()].sort((a, b) => a.id.localeCompare(b.id)),
  note:
    'Each probePx is the alpha-weighted centroid of one rendered marker, matched one-to-one to its exported anchor. ' +
    'The export is accepted when every delta is within thresholdPx.',
};
const proofPath = join(renderDir, proofSpec.directory, proofSpec.record);
writeFileSync(proofPath, `${JSON.stringify(proof, null, 1)}\n`);

console.log(
  `table-layout-proof: ${components.length} markers, max ${measured.maxDelta.toFixed(4)} px, ` +
    `mean ${proof.meanDeltaPx.toFixed(4)} px, p95 ${measured.p95.toFixed(4)} px`,
);
console.log(`  proof   ${proofPath}`);
console.log(`  overlay ${overlayPath}`);
console.log(`  zoom    ${zoomPath}`);

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}
