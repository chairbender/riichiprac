#!/usr/bin/env node
/**
 * Integrity check for the carved face decals.
 *
 *   node tools/render/scripts/check-decals.mjs          # build/decals.json
 *   node tools/render/scripts/check-decals.mjs --committed
 *
 * Dependency-free: PNG only, no Blender, no Node Canvas. It validates facts,
 * not looks (AGENTS.md §6):
 *
 *   - every decal PNG exists, decodes as 8-bit RGBA at the manifest's size,
 *     and its byte count, alpha/ink measurements and decoded-RGBA sha256 match;
 *   - the four corners are transparent (this is a carve/paint overlay, not a
 *     full face plate), a meaningful share of the image is transparent, and
 *     the alpha bbox sits inside the image;
 *   - red fives really carry red paint; each face's four light rotations are
 *     distinct images;
 *   - the decal byte budget holds, and with `--committed` the whole frontend
 *     table stays under 8 MiB with an initial @1x board under 4 MiB.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng } from './png.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tableDir = resolve(renderDir, '../../frontend/public/table');
const committed = process.argv.includes('--committed');
const manifestPath = committed
  ? join(tableDir, 'decals.json')
  : join(renderDir, 'build/decals.json');
const assetRoot = committed ? tableDir : join(renderDir, 'build');
const checkFacesManifestPath = join(tableDir, 'faces.json');

const TOTAL_BUDGET = 8 * 1024 * 1024;
const INITIAL_LOAD_BUDGET = 4 * 1024 * 1024;
const FACE_UP_SHELL_IDS = [
  ...['00', '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', 'draw'].map(
    (slot) => `shell_hand_slot_${slot}`,
  ),
  'shell_flat_upright',
  'shell_flat_sideways',
];

const failures = [];
let checks = 0;

function check(condition, label) {
  checks += 1;
  if (condition) console.log(`PASS ${label}`);
  else {
    failures.push(label);
    console.log(`FAIL ${label}`);
  }
}

function note(message) {
  console.log(`INFO ${message}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function pixel(image, x, y) {
  const index = (y * image.width + x) * image.channels;
  return [
    image.data[index],
    image.data[index + 1],
    image.data[index + 2],
    image.channels === 4 ? image.data[index + 3] : 255,
  ];
}

function measure(image) {
  let alphaPixels = 0;
  let inkPixels = 0;
  let redPixels = 0;
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const [r, g, b, a] = pixel(image, x, y);
      if (a <= 8) continue;
      alphaPixels += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const saturation = Math.max(r, g, b) - Math.min(r, g, b);
      if (a > 127 && (saturation > 24 || luma < 150)) inkPixels += 1;
      if (r > g + 40 && r > b + 40) redPixels += 1;
    }
  }
  return {
    alphaPixels,
    inkPixels,
    redPixels,
    alphaBBox: maxX < 0 ? null : { left: minX, top: minY, right: maxX, bottom: maxY },
    transparentFraction: Number((1 - alphaPixels / (image.width * image.height)).toFixed(5)),
  };
}

function checkDecalsSpec() {
  const spec = readJson(join(renderDir, 'decal-spec.json'));
  check(spec.version === 1, 'decal-spec.json version is 1');
  check(
    spec.raster?.width === 150 && spec.raster?.height === 208,
    `decal raster is 150x208 (${spec.raster?.width}x${spec.raster?.height})`,
  );
  check(spec.raster?.scale === 2, `decal raster is @2x (scale ${spec.raster?.scale})`);
  check(
    JSON.stringify(spec.rotations) === JSON.stringify([0, 90, 180, 270]),
    `decal light rotations are 0/90/180/270 (${spec.rotations?.join('/')})`,
  );
  check(
    JSON.stringify(spec.symbolRotations) === JSON.stringify([0]),
    'Phase 2 bakes symbol rotation 0 only',
  );
  check(Boolean(spec.carve), 'decal-spec.json records the carve parameters');
}

function checkManifest() {
  check(existsSync(manifestPath), `decal manifest exists (${manifestPath})`);
  if (!existsSync(manifestPath)) return;
  const manifest = readJson(manifestPath);
  check(manifest.version === 1, 'decals.json version is 1');
  check(
    manifest.raster?.width === 150 && manifest.raster?.height === 208,
    `decals.json raster is 150x208 (${manifest.raster?.width}x${manifest.raster?.height})`,
  );
  check(
    JSON.stringify(manifest.rotations) === JSON.stringify([0, 90, 180, 270]),
    'decals.json light rotations are 0/90/180/270',
  );
  check(
    JSON.stringify(manifest.symbolRotations) === JSON.stringify([0]),
    'decals.json symbol rotations are [0]',
  );
  const entries = Object.entries(manifest.decals ?? {});
  check(entries.length > 0, `decals.json has ${entries.length} decals`);
  check(
    manifest.totals?.decals === entries.length,
    `manifest totals.decals matches (${manifest.totals?.decals})`,
  );

  let totalBytes = 0;
  const byFace = new Map();
  const hashesByFace = new Map();
  for (const [key, record] of entries) {
    check(
      key === `${record.face}:l${record.lightRotationDeg}:s${record.symbolRotationDeg}`,
      `${key} key matches its face/rotations`,
    );
    check(
      record.lightRotationDeg === 0 ||
        record.lightRotationDeg === 90 ||
        record.lightRotationDeg === 180 ||
        record.lightRotationDeg === 270,
      `${key} lightRotationDeg is a right angle (${record.lightRotationDeg})`,
    );
    check(record.symbolRotationDeg === 0, `${key} symbolRotationDeg is 0`);
    check(
      typeof record.textureFile === 'string' && record.textureFile.startsWith('decals/'),
      `${key} textureFile is under decals/ (${record.textureFile})`,
    );
    check(
      JSON.stringify(record.facePlateRect) === JSON.stringify([0, 0, 1, 1]),
      `${key} maps its whole image to the face plate`,
    );
    const file = join(assetRoot, record.textureFile);
    check(existsSync(file), `${key} PNG exists (${record.textureFile})`);
    if (!existsSync(file)) continue;
    const image = readPng(file);
    check(
      image.width === manifest.raster.width &&
        image.height === manifest.raster.height &&
        image.channels === 4,
      `${key} is ${manifest.raster.width}x${manifest.raster.height} RGBA (got ${image.width}x${image.height}/${image.channels}ch)`,
    );
    totalBytes += image.bytes;
    check(record.bytes === image.bytes, `${key} byte count matches (${image.bytes} B)`);
    check(
      record.sha256?.decodedRgba === sha256(image.data),
      `${key} decoded-RGBA sha256 matches the committed PNG`,
    );
    const stats = measure(image);
    check(
      record.measured?.alphaPixels === stats.alphaPixels &&
        record.measured?.inkPixels === stats.inkPixels &&
        record.measured?.redPixels === stats.redPixels &&
        JSON.stringify(record.measured?.alphaBBox) === JSON.stringify(stats.alphaBBox) &&
        record.measured?.transparentFraction === stats.transparentFraction,
      `${key} measured alpha/ink/bbox match the PNG`,
    );
    check(stats.alphaPixels > 500, `${key} has a visible carve (${stats.alphaPixels} px)`);
    check(stats.inkPixels > 200, `${key} has visible paint (${stats.inkPixels} px)`);
    check(
      stats.transparentFraction >= 0.2,
      `${key} is a carve overlay, ${(stats.transparentFraction * 100).toFixed(1)}% transparent`,
    );
    for (const [x, y] of [
      [0, 0],
      [image.width - 1, 0],
      [0, image.height - 1],
      [image.width - 1, image.height - 1],
    ]) {
      check(pixel(image, x, y)[3] === 0, `${key} corner ${x},${y} is transparent`);
    }
    check(
      stats.alphaBBox !== null &&
        stats.alphaBBox.left >= 0 &&
        stats.alphaBBox.top >= 0 &&
        stats.alphaBBox.right <= image.width - 1 &&
        stats.alphaBBox.bottom <= image.height - 1,
      `${key} carve is inside the decal frame`,
    );
    if (record.face === '5mr' || record.face === '5pr' || record.face === '5sr') {
      check(stats.redPixels > 1000, `${key} red five really is red (${stats.redPixels} px)`);
    }
    byFace.set(record.face, (byFace.get(record.face) ?? 0) + 1);
    const hashes = hashesByFace.get(record.face) ?? new Set();
    hashes.add(record.sha256.decodedRgba);
    hashesByFace.set(record.face, hashes);
  }

  check(
    totalBytes <= manifest.budget.bytes,
    `decal assets total ${totalBytes} B (budget ${manifest.budget.bytes} B)`,
  );
  note(`decal assets total ${totalBytes} B across ${entries.length} PNGs`);

  const rotationsSeen = new Set(entries.map(([, record]) => record.lightRotationDeg));
  check(
    rotationsSeen.size === 4,
    `the four light rotations are present (${[...rotationsSeen].sort().join('/')})`,
  );
  for (const [face, hashes] of hashesByFace) {
    check(hashes.size === 4, `${face} light rotations are four distinct renders (${hashes.size})`);
  }
  if (!committed) {
    note(`spike/build manifest: ${byFace.size} faces, ${entries.length} decals`);
    return;
  }
  const facesManifest = readJson(checkFacesManifestPath);
  const inkedFaces = Object.entries(facesManifest.faces)
    .filter(([, face]) => (face.measured?.inkPixels ?? 0) > 0)
    .map(([id]) => id);
  check(
    inkedFaces.every((face) => byFace.get(face) === 4),
    `every inked face has four decals (${inkedFaces.length} faces)`,
  );
  check(
    entries.length === inkedFaces.length * 4,
    `committed decal count is ${inkedFaces.length * 4} (${entries.length})`,
  );
}

function checkBudgets() {
  if (!committed) return;
  const shells = readJson(join(tableDir, 'shells.json')).shells;
  let shellsBytes = 0;
  let body1xBytes = 0;
  for (const record of Object.values(shells)) {
    for (const path of [
      record.textureFile,
      record.textureFile2x,
      record.shadowTextureFile,
      record.shadowTextureFile2x,
    ]) {
      shellsBytes += statSync(join(tableDir, path)).size;
    }
    body1xBytes += statSync(join(tableDir, record.textureFile)).size;
  }
  let facesBytes = 0;
  for (const record of Object.values(readJson(join(tableDir, 'faces.json')).faces)) {
    facesBytes += statSync(join(tableDir, record.textureFile)).size;
  }
  let decalsBytes = 0;
  for (const record of Object.values(readJson(join(tableDir, 'decals.json')).decals)) {
    decalsBytes += statSync(join(tableDir, record.textureFile)).size;
  }
  const manifestBytes =
    statSync(join(tableDir, 'shells.json')).size +
    statSync(join(tableDir, 'faces.json')).size +
    statSync(join(tableDir, 'decals.json')).size;
  const feltBytes = statSync(join(tableDir, 'felt.png')).size;
  const total = shellsBytes + manifestBytes + feltBytes + facesBytes + decalsBytes;
  check(
    total <= TOTAL_BUDGET,
    `committed table assets are ${total} B (${(total / 1024 / 1024).toFixed(2)} MiB, limit 8 MiB)`,
  );
  const initial = body1xBytes + feltBytes + manifestBytes + facesBytes + decalsBytes;
  check(
    initial <= INITIAL_LOAD_BUDGET,
    `initial hand + board @1x load is ${initial} B (${(initial / 1024 / 1024).toFixed(2)} MiB, limit 4 MiB)`,
  );
  note(
    `shells ${shellsBytes} B, faces ${facesBytes} B, decals ${decalsBytes} B, manifests ${manifestBytes} B, felt ${feltBytes} B`,
  );
  note(`Phase 2 atlas shells: ${FACE_UP_SHELL_IDS.length}`);
}

try {
  checkDecalsSpec();
  checkManifest();
  checkBudgets();
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  console.error(error);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} FAILED of ${checks} checks`);
  process.exit(1);
}
console.log(`\nOK ${checks} checks passed`);
