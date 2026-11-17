#!/usr/bin/env node
/**
 * Publish the whole-table reference from the Blender @2x master.
 *
 *   node tools/render/scripts/table-reference.mjs
 *
 * Reads the transient bake output (`tools/render/build/reference/master-2x.png`
 * plus `geometry.json`) and writes the committed calibration assets under
 * `tools/render/reference/`:
 *
 *   full-board-1x.png     the @1x board, a 2x2 box downsample of the master
 *   crops-2x/*.png        one @2x crop per element family
 *   table-reference.json  camera, every tile placement, crop rects, measured
 *                         projection metrics, decoded-RGBA hashes
 *   index.html            a static contact page for the committed renders
 *
 * The reference is calibration-only: nothing under frontend/public is touched.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng, readPng } from './png.mjs';
import {
  CROP_PLAN,
  cameraFromCandidate,
  cropRect,
  measureScene,
  projectPoint,
  zoneTileIds,
} from './table-camera.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(renderDir, '..', '..');
const specPath = join(renderDir, 'table-reference-spec.json');
const buildDir = join(renderDir, 'build', 'reference');
const geometryPath = join(buildDir, 'geometry.json');
const masterPath = join(buildDir, 'master-2x.png');
const outDir = join(renderDir, 'reference');
const cropDir = join(outDir, 'crops-2x');

const fail = (message) => {
  console.error(`[table-reference] ERROR: ${message}`);
  process.exit(1);
};

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return fail(`cannot read ${path}: ${error.message}`);
  }
};

const spec = readJson(specPath);
const geometry = readJson(geometryPath);
if (!existsSync(masterPath)) {
  fail(`missing ${masterPath}; run "bash tools/render/bake-table-reference.sh --bake"`);
}

const chosenName = geometry.cameraCandidate;
if (chosenName !== spec.camera.chosen) {
  fail(
    `bake used camera "${chosenName}" but the spec's committed choice is ` +
      `"${spec.camera.chosen}"; re-bake or update the spec`,
  );
}
const candidate = spec.camera.candidates[chosenName];
const resolution1x = spec.camera.output.resolution1x;
const resolution2x = spec.camera.output.resolution2x;

const master = readPng(masterPath);
if (master.width !== resolution2x[0] || master.height !== resolution2x[1]) {
  fail(
    `master is ${master.width}x${master.height}, expected ` +
      `${resolution2x[0]}x${resolution2x[1]}`,
  );
}

const channels = 3;
const rgbOf = (image) => {
  if (image.channels === channels) return image;
  const data = Buffer.alloc(image.width * image.height * channels);
  for (let index = 0; index < image.width * image.height; index += 1) {
    data[index * 3] = image.data[index * 4];
    data[index * 3 + 1] = image.data[index * 4 + 1];
    data[index * 3 + 2] = image.data[index * 4 + 2];
  }
  return { width: image.width, height: image.height, channels, data };
};

const hashRgba = (image) =>
  createHash('sha256')
    .update(`${image.width}x${image.height}x${image.channels}:`)
    .update(image.data)
    .digest('hex');

const crop = (image, rect) => {
  const data = Buffer.alloc(rect.width * rect.height * image.channels);
  for (let row = 0; row < rect.height; row += 1) {
    const source = ((rect.y + row) * image.width + rect.x) * image.channels;
    image.data.copy(data, row * rect.width * image.channels, source, source + rect.width * image.channels);
  }
  return { width: rect.width, height: rect.height, channels: image.channels, data };
};

/** Deterministic 2x2 box downsample. */
const downsample = (image, factor) => {
  const width = image.width / factor;
  const height = image.height / factor;
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    fail(`master ${image.width}x${image.height} is not divisible by ${factor}`);
  }
  const data = Buffer.alloc(width * height * image.channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < image.channels; channel += 1) {
        let total = 0;
        for (let dy = 0; dy < factor; dy += 1) {
          for (let dx = 0; dx < factor; dx += 1) {
            const index =
              ((y * factor + dy) * image.width + (x * factor + dx)) * image.channels + channel;
            total += image.data[index];
          }
        }
        data[(y * width + x) * image.channels + channel] = Math.round(
          total / (factor * factor),
        );
      }
    }
  }
  return { width, height, channels: image.channels, data };
};

const writeImage = (path, image) => {
  writeFileSync(path, encodePng(image.width, image.height, image.channels, image.data));
  const decoded = decodePng(readFileSync(path), path);
  return {
    bytes: statSync(path).size,
    width: decoded.width,
    height: decoded.height,
    channels: decoded.channels,
    sha256: hashRgba(decoded),
  };
};

mkdirSync(outDir, { recursive: true });
if (existsSync(cropDir)) rmSync(cropDir, { recursive: true, force: true });
mkdirSync(cropDir, { recursive: true });

const masterRgb = rgbOf(master);
const board1x = downsample(masterRgb, 2);
if (board1x.width !== resolution1x[0] || board1x.height !== resolution1x[1]) {
  fail(`@1x board is ${board1x.width}x${board1x.height}, expected ${resolution1x[0]}x${resolution1x[1]}`);
}
const boardFile = spec.renders.fullBoard1x;
const boardRecord = writeImage(join(outDir, boardFile), board1x);

const camera2x = cameraFromCandidate(candidate, resolution2x);
const camera1x = cameraFromCandidate(candidate, resolution1x);
const tiles = geometry.scene.tiles;
const margin = spec.renders.cropMarginPx2x;

const cropFamilies = new Map(spec.renders.cropFamilies.map((entry) => [entry.id, entry]));
if (cropFamilies.size !== Object.keys(CROP_PLAN).length) {
  fail('renders.cropFamilies does not list exactly the element families');
}

const crops = {};
const index = {};
for (const tile of tiles) {
  if (tile.kind === 'drawn') index.drawn = { drawn: [tile.id] };
}
for (const name of Object.keys(CROP_PLAN)) {
  const [kind, seat] = CROP_PLAN[name];
  const family = cropFamilies.get(name);
  if (!family) fail(`crop family ${name} is missing from the spec`);
  if (family.kind !== kind && !(family.kind === 'drawn' && kind === 'drawn')) {
    fail(`crop family ${name} has kind ${family.kind}, expected ${kind}`);
  }
  if (!family.seats.includes(seat)) fail(`crop family ${name} does not list seat ${seat}`);
  let ids;
  if (kind === 'drawn') {
    ids = tiles.filter((tile) => tile.kind === 'drawn').map((tile) => tile.id);
  } else {
    ids = tiles.filter((tile) => tile.kind === kind && tile.seat === seat).map((tile) => tile.id);
  }
  if (ids.length === 0) fail(`crop family ${name} has no tiles`);
  const planned = cropRect(camera2x, tiles, ids, margin);
  const image = crop(masterRgb, planned);
  const file = `${name}-2x.png`;
  const written = writeImage(join(cropDir, file), image);
  crops[name] = {
    file: `${spec.renders.crops2xDir}/${file}`,
    family: family.kind,
    seat,
    tiles: ids,
    rect2x: { x: planned.x, y: planned.y, width: planned.width, height: planned.height },
    ...written,
  };
}

const metrics = measureScene(camera1x, tiles, spec);
const metricsMatch = (recorded, computed, path = '') => {
  for (const [key, value] of Object.entries(computed)) {
    const recordedValue = recorded?.[key];
    if (value && typeof value === 'object') {
      metricsMatch(recordedValue, value, `${path}${key}.`);
    } else if (Math.abs((recordedValue ?? Number.NaN) - value) > 1e-3) {
      fail(`recorded metric ${path}${key}=${recordedValue} does not match the re-bake ${value}`);
    }
  }
};
metricsMatch(geometry.metrics, metrics);

const byId = new Map(tiles.map((tile) => [tile.id, tile]));
for (const [name, sample] of Object.entries(geometry.lightingSamples ?? {})) {
  const tile = byId.get(sample.tile);
  if (!tile) fail(`lighting sample ${name} references missing tile ${sample.tile}`);
  const local = [0, 0, sample.localPoint[2]];
  const rotated = [
    tile.rotation[0] * local[0] + tile.rotation[1] * local[1] + tile.rotation[2] * local[2],
    tile.rotation[3] * local[0] + tile.rotation[4] * local[1] + tile.rotation[5] * local[2],
    tile.rotation[6] * local[0] + tile.rotation[7] * local[1] + tile.rotation[8] * local[2],
  ];
  const point = tile.origin.map((value, axis) => value + rotated[axis]);
  const [px, py] = projectPoint(camera1x, point);
  if (Math.abs(px - sample.pixel1x[0]) > 0.01 || Math.abs(py - sample.pixel1x[1]) > 0.01) {
    fail(`lighting sample ${name} pixel drifted: ${sample.pixel1x} -> ${[px, py]}`);
  }
}

const manifest = {
  version: 1,
  generatedBy: 'tools/render/scripts/table-reference.mjs',
  sourceScript: 'tools/render/bake_table_reference.py',
  spec: 'tools/render/table-reference-spec.json',
  blender: geometry.blender,
  cameraCandidate: chosenName,
  camera: camera2x,
  camera1x,
  resolution1x,
  resolution2x,
  hashConvention:
    'sha256 over "<width>x<height>x<channels>:" followed by the decoded RGB(A) bytes, at the file\'s own resolution. Bytes are the committed PNG file size.',
  masterDownsample: spec.camera.output.masterDownsample,
  projectionDeltaPx: geometry.projectionDeltaPx,
  visibility: geometry.visibility,
  table: {
    units: spec.table.units,
    seats: spec.table.seats,
    wall: spec.table.wall,
    pond: spec.table.pond,
    hand: spec.table.hand,
    meld: spec.table.meld,
    felt: spec.table.felt,
  },
  scene: {
    dimensions: geometry.scene.dimensions,
    innerFacePlate: geometry.scene.innerFacePlate,
    tiles: geometry.scene.tiles,
  },
  metrics,
  lightingSamples: geometry.lightingSamples,
  renders: {
    fullBoard1x: { file: boardFile, ...boardRecord, scale: 1 },
    crops2x: crops,
  },
  elementFamilyCount: Object.keys(crops).length,
};

writeFileSync(join(outDir, spec.renders.manifest), `${JSON.stringify(manifest, null, 1)}\n`);

const html = renderIndex(manifest);
writeFileSync(join(outDir, 'index.html'), html);

const totalBytes =
  boardRecord.bytes +
  Object.values(crops).reduce((sum, record) => sum + record.bytes, 0) +
  statSync(join(outDir, spec.renders.manifest)).size;

console.log(`[table-reference] camera ${chosenName} (${candidate.mode}, ${candidate.elevationDeg} deg)`);
console.log(
  `[table-reference] board ${boardFile} ${boardRecord.width}x${boardRecord.height} ` +
    `${boardRecord.bytes} B sha256 ${boardRecord.sha256.slice(0, 16)}...`,
);
for (const [name, record] of Object.entries(crops)) {
  console.log(
    `[table-reference] crop ${name.padEnd(13)} ${String(record.width).padStart(4)}x` +
      `${String(record.height).padEnd(4)} ${String(record.bytes).padStart(7)} B ` +
      `${record.tiles.length} tiles`,
  );
}
console.log(`[table-reference] ${Object.keys(crops).length} crops, ${totalBytes} B committed`);
console.log(`[table-reference] metrics scaleSpread ${metrics.scaleSpread}, ` +
  `frontBackRunRatio ${metrics.frontBackRunRatio}, minFrameMarginPx ${metrics.minFrameMarginPx}`);

function renderIndex(record) {
  const escape = (value) => String(value).replace(/[&<>"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[character]));
  const metricRows = [
    ['pond tile size (px @1x, 4 seats)', record.metrics.pondTileSizePx.join(' / ')],
    ['near/far scale spread', record.metrics.scaleSpread],
    ['front/back run length ratio', record.metrics.frontBackRunRatio],
    ['left/right run length ratio', record.metrics.leftRightRunRatio],
    ['run angle error (deg)', Object.values(record.metrics.runAngleErrorDeg).join(' / ')],
    ['bottom/top hand size ratio', record.metrics.bottomTopHandRatio],
    ['front outer lateral reveal (deg)', record.metrics.frontOuterRevealDeg],
    ['minimum frame margin (px @1x)', record.metrics.minFrameMarginPx],
  ];
  const crops = Object.entries(record.renders.crops2x)
    .map(
      ([name, crop]) => `
      <figure>
        <a href="${escape(crop.file)}"><img src="${escape(crop.file)}" alt="${escape(name)}"></a>
        <figcaption>${escape(name)} · ${crop.width}×${crop.height} @2x · ${crop.tiles.length} tiles</figcaption>
      </figure>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>riichiprac whole-table 3D reference</title>
<style>
  body { margin: 0 auto; max-width: 1180px; padding: 24px; background: #10171b; color: #dbe6e9;
         font: 15px/1.45 system-ui, sans-serif; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  p { color: #9fb2b8; max-width: 78ch; }
  img { max-width: 100%; display: block; border-radius: 4px; }
  figure { margin: 0 0 26px; }
  figcaption { color: #9fb2b8; font-size: 13px; padding-top: 6px; }
  table { border-collapse: collapse; margin: 18px 0 34px; font-size: 14px; }
  th, td { text-align: left; padding: 4px 14px 4px 0; border-bottom: 1px solid #23343a; }
  th { color: #9fb2b8; font-weight: 500; }
  code { color: #cbe3c6; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 26px; }
</style>
<h1>Whole-table 3D reference</h1>
<p>Calibration only. One Blender scene and one camera; compare the 2.5D compositor's
element crops against these. Committed by <code>${escape(record.generatedBy)}</code>
from <code>${escape(record.sourceScript)}</code>; camera <code>${escape(record.cameraCandidate)}</code>
(${escape(record.camera.mode)}, ${record.camera.elevationDeg}° elevation, eye
[${record.camera.eye.map((value) => value.toFixed(2)).join(', ')}]).</p>
<figure>
  <a href="${escape(record.renders.fullBoard1x.file)}"><img src="${escape(record.renders.fullBoard1x.file)}" alt="full board"></a>
  <figcaption>full board @1x · ${record.renders.fullBoard1x.width}×${record.renders.fullBoard1x.height}</figcaption>
</figure>
<table>
${metricRows.map(([label, value]) => `<tr><th>${escape(label)}</th><td>${escape(value)}</td></tr>`).join('\n')}
</table>
<div class="grid">${crops}
</div>
</html>
`;
}
