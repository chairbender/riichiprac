#!/usr/bin/env node
/**
 * Integrity check for the carved face decals.
 *
 *   node tools/render/scripts/check-decals.mjs          # build/decals.json (PNG bake)
 *   node tools/render/scripts/check-decals.mjs --committed
 *
 * Uses `@napi-rs/canvas` to decode the committed AVIF/WebP (and the build PNG)
 * because the decals are lossy images; the shell/face checks remain
 * dependency-free. It validates facts, not looks (AGENTS.md §6):
 *
 *   - every decal exists and decodes as 8-bit RGBA at the manifest's size, and
 *     its byte count, alpha/ink measurements and decoded-RGBA sha256 match;
 *   - the four corners are transparent (this is a carve/paint overlay, not a
 *     full face plate), a meaningful share is transparent, and the alpha bbox
 *     sits inside the frame;
 *   - red fives carry red paint; each face/surface has its expected distinct
 *     light rotations;
 *   - the decal byte budget holds, and with `--committed` the whole frontend
 *     table stays under 8 MiB with an initial @1x board under 4 MiB.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRgba, measureDecal, sha256Rgba } from './decal-image.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tableDir = resolve(renderDir, '../../frontend/public/table');
const committed = process.argv.includes('--committed');
const manifestPath = committed
  ? join(tableDir, 'decals.json')
  : join(renderDir, 'build/decals.json');
const assetRoot = committed ? tableDir : join(renderDir, 'build');
const facesManifestPath = join(tableDir, 'faces.json');

const TOTAL_BUDGET = 8 * 1024 * 1024;
const INITIAL_LOAD_BUDGET = 4 * 1024 * 1024;
const FACE_UP_SHELL_IDS = [
  ...['00', '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', 'draw'].map(
    (slot) => `shell_hand_slot_${slot}`,
  ),
  'shell_flat_upright',
  'shell_flat_sideways',
  'shell_flat_upright_180',
  'shell_flat_sideways_270',
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

function checkDecalsSpec() {
  const spec = readJson(join(renderDir, 'decal-spec.json'));
  check(spec.version === 1, 'decal-spec.json version is 1');
  check(
    spec.raster?.width === 158 && spec.raster?.height === 216,
    `decal raster is 158x216 (${spec.raster?.width}x${spec.raster?.height})`,
  );
  check(spec.raster?.scale === 2, `decal raster is @2x (scale ${spec.raster?.scale})`);
  check(
    spec.raster?.paddingPixels === 4,
    `decal raster has a 4 px safety ring (${spec.raster?.paddingPixels})`,
  );
  check(
    JSON.stringify(spec.rotations) === JSON.stringify([0, 90, 180, 270]),
    'decal light rotations are 0/90/180/270',
  );
  check(
    JSON.stringify(spec.symbolRotations) === JSON.stringify([0]),
    'Phase 2 bakes symbol rotation 0 only',
  );
  check(Boolean(spec.carve), 'decal-spec.json records the carve parameters');
  check(
    spec.lighting?.upright?.frame === 'world',
    'the upright rig uses the world frame',
  );
  check(
    spec.lighting?.lying?.frame === 'face-normal',
    'the lying rig uses the face-normal frame',
  );
}

async function checkManifest() {
  check(existsSync(manifestPath), `decal manifest exists (${manifestPath})`);
  if (!existsSync(manifestPath)) return;
  const manifest = readJson(manifestPath);
  check(manifest.version === 1, 'decals.json version is 1');
  check(
    manifest.raster?.width === 158 && manifest.raster?.height === 216,
    `decals.json raster is 158x216 (${manifest.raster?.width}x${manifest.raster?.height})`,
  );
  check(
    JSON.stringify(manifest.rotations) === JSON.stringify([0, 90, 180, 270]),
    'decals.json light rotations are 0/90/180/270',
  );
  check(
    Array.isArray(manifest.surfaces) &&
      manifest.surfaces.includes('upright') &&
      manifest.surfaces.includes('lying'),
    `decals.json records both light rigs (${manifest.surfaces?.join('/')})`,
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

  const expectedRect = [4 / 158, 4 / 216, 154 / 158, 212 / 216];
  const rectMatches = (rect) =>
    Array.isArray(rect) &&
    rect.length === 4 &&
    rect.every((value, index) => Math.abs(value - expectedRect[index]) < 1e-6);

  let totalBytes = 0;
  const byFaceSurface = new Map();
  const hashesByFaceSurface = new Map();
  for (const [key, record] of entries) {
    check(
      record.surface === 'upright' || record.surface === 'lying',
      `${key} surface is upright or lying (${record.surface})`,
    );
    check(
      key === `${record.face}:${record.surface}:l${record.lightRotationDeg}:s${record.symbolRotationDeg}`,
      `${key} key matches its face/surface/rotations`,
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
      typeof record.textureFile === 'string' &&
        record.textureFile.startsWith('decals/') &&
        record.textureFile.includes(`-${record.surface}-`) &&
        /\.(avif|webp|png)$/.test(record.textureFile),
      `${key} textureFile names the surface and an image format (${record.textureFile})`,
    );
    check(
      rectMatches(record.facePlateRect),
      `${key} maps the inner 150x208 face plate (${JSON.stringify(record.facePlateRect)})`,
    );
    const file = join(assetRoot, record.textureFile);
    check(existsSync(file), `${key} image exists (${record.textureFile})`);
    if (!existsSync(file)) continue;
    const image = await loadRgba(file);
    check(
      image.width === manifest.raster.width &&
        image.height === manifest.raster.height &&
        image.channels === 4,
      `${key} is ${manifest.raster.width}x${manifest.raster.height} RGBA (got ${image.width}x${image.height}/${image.channels}ch)`,
    );
    const bytes = statSync(file).size;
    totalBytes += bytes;
    check(record.bytes === bytes, `${key} byte count matches (${bytes} B)`);
    check(
      record.sha256?.decodedRgba === sha256Rgba(image),
      `${key} decoded-RGBA sha256 matches the committed image`,
    );
    const stats = measureDecal(image);
    check(
      record.measured?.alphaPixels === stats.alphaPixels &&
        record.measured?.inkPixels === stats.inkPixels &&
        record.measured?.redPixels === stats.redPixels &&
        JSON.stringify(record.measured?.alphaBBox) === JSON.stringify(stats.alphaBBox) &&
        record.measured?.transparentFraction === stats.transparentFraction &&
        JSON.stringify(record.measured?.cornerAlpha) === JSON.stringify(stats.cornerAlpha),
      `${key} measured alpha/ink/bbox match the image`,
    );
    check(stats.alphaPixels > 500, `${key} has a visible carve (${stats.alphaPixels} px)`);
    check(stats.inkPixels > 200, `${key} has visible paint (${stats.inkPixels} px)`);
    check(
      stats.transparentFraction >= 0.1,
      `${key} is a carve overlay, ${(stats.transparentFraction * 100).toFixed(1)}% transparent`,
    );
    check(
      stats.cornerAlpha.every((alpha) => alpha <= 2),
      `${key} corners are transparent within lossy tolerance (${stats.cornerAlpha.join(',')})`,
    );
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
    const group = `${record.face}:${record.surface}`;
    byFaceSurface.set(group, (byFaceSurface.get(group) ?? 0) + 1);
    const hashes = hashesByFaceSurface.get(group) ?? new Set();
    hashes.add(record.sha256.decodedRgba);
    hashesByFaceSurface.set(group, hashes);
  }

  const spec = readJson(join(renderDir, 'decal-spec.json'));
  const budget = committed
    ? manifest.budget.bytes
    : (spec.output.buildBytesBudget ?? manifest.budget.bytes);
  check(
    totalBytes <= budget,
    `decal assets total ${totalBytes} B (${committed ? 'committed' : 'build'} budget ${budget} B)`,
  );
  note(`decal assets total ${totalBytes} B across ${entries.length} images`);
  note(`decal format ${manifest.raster?.format ?? 'unknown'}`);

  const rotationsSeen = new Set(entries.map(([, record]) => record.lightRotationDeg));
  check(
    rotationsSeen.size === 4,
    `the four light rotations are present (${[...rotationsSeen].sort().join('/')})`,
  );
  const surfaceRotations = manifest.surfaceRotations ?? {};
  for (const [group, hashes] of hashesByFaceSurface) {
    const surface = group.split(':')[1];
    const expected = surfaceRotations[surface]?.length ?? 4;
    check(
      hashes.size === expected,
      `${group} light rotations are ${expected} distinct images (${hashes.size})`,
    );
  }
  if (!committed) {
    note(`build manifest: ${byFaceSurface.size} face/surface groups, ${entries.length} decals`);
    return;
  }
  const facesManifest = readJson(facesManifestPath);
  const inkedFaces = Object.entries(facesManifest.faces)
    .filter(([, face]) => (face.measured?.inkPixels ?? 0) > 0)
    .map(([id]) => id);
  const expectedGroups = inkedFaces.length * (manifest.surfaces?.length ?? 2);
  check(
    [...byFaceSurface.keys()].length === expectedGroups,
    `every inked face has both surface rigs (${expectedGroups} groups)`,
  );
  for (const surface of manifest.surfaces ?? []) {
    const expected = surfaceRotations[surface]?.length ?? 4;
    check(
      inkedFaces.every((face) => byFaceSurface.get(`${face}:${surface}`) === expected),
      `every inked face has ${expected} ${surface} decals (${inkedFaces.length} faces)`,
    );
  }
}

function checkBudgets() {
  if (!committed) return;
  const shells = readJson(join(tableDir, 'shells.json')).shells;
  let shellsBytes = 0;
  let body1xBytes = 0;
  for (const record of Object.values(shells)) {
    for (const path of [record.textureFile, record.textureFile2x, record.shadowTextureFile]) {
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
  const total = shellsBytes + facesBytes + decalsBytes + manifestBytes + feltBytes;
  check(
    total <= TOTAL_BUDGET,
    `committed table assets are ${total} B (${(total / 1024 / 1024).toFixed(2)} MiB, limit 8 MiB)`,
  );
  // A decal-based board loads the shell bodies, the felt, the manifests and the
  // decals. The flat glyph PNGs remain build/fallback assets and are not
  // fetched when every inked face has a carved decal.
  const initial = body1xBytes + feltBytes + manifestBytes + decalsBytes;
  check(
    initial <= INITIAL_LOAD_BUDGET,
    `initial hand + board @1x load is ${initial} B (${(initial / 1024 / 1024).toFixed(2)} MiB, limit 4 MiB; flat glyphs are build-only)`,
  );
  note(
    `shells ${shellsBytes} B, faces ${facesBytes} B, decals ${decalsBytes} B, manifests ${manifestBytes} B, felt ${feltBytes} B`,
  );
  note(`Phase 2 atlas shells: ${FACE_UP_SHELL_IDS.length}`);
}

try {
  checkDecalsSpec();
  await checkManifest();
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
