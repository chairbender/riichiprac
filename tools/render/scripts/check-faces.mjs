#!/usr/bin/env node
/**
 * Integrity check for the committed tile-face glyph masters.
 *
 *   node tools/render/scripts/check-faces.mjs
 *
 * Dependency-free on purpose: it runs in CI and never needs resvg or Blender.
 * It validates facts, not looks (AGENTS.md §6). The masters are the input to the
 * 3D carve bake (`frontend/tools/relief3d/bake-relief3d.mjs`); the 2.5D sprite
 * pipeline that also used them was retired in task 261119-1637.
 *
 *   - `faces-spec.json` pins the public-domain upstream commit, lists exactly
 *     the 34 standard faces plus the three red fives, and every source SVG is
 *     vendored;
 *   - every committed glyph PNG decodes as 8-bit RGBA at the spec's size, its
 *     byte count, measured ink and decoded-RGBA sha256 match `faces.json`, the
 *     corners are transparent, haku has zero ink, and the red fives really
 *     carry red paint;
 *   - the glyph byte budget holds;
 *   - the 3D carve manifest (`relief3d.json`) covers exactly the same 37 face
 *     ids and its albedo/normal/AO atlases exist, so a master that disappears
 *     cannot silently leave the 3D carve behind.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng } from './png.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const facesSpecPath = join(renderDir, 'faces-spec.json');
const facesManifestPath = resolve(renderDir, '../../frontend/public/table/faces.json');
const reliefManifestPath = resolve(renderDir, '../../frontend/public/table/relief3d.json');
const tableDir = resolve(renderDir, '../../frontend/public/table');

const failures = [];
let checks = 0;

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

function faceInkStats(image) {
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
      inkPixels += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (r > g + 40 && r > b + 40) redPixels += 1;
    }
  }
  return {
    inkPixels,
    redPixels,
    inkBBox: maxX < 0 ? null : { left: minX, top: minY, right: maxX, bottom: maxY },
  };
}

const STANDARD_FACE_IDS = [
  '1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m',
  '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p',
  '1s', '2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s',
  '5mr', '5pr', '5sr',
  '1z', '2z', '3z', '4z', '5z', '6z', '7z',
];

function checkFacesSpec(spec) {
  check(spec.version === 1, 'faces-spec.json version is 1');
  check(
    typeof spec.source?.commit === 'string' && /^[0-9a-f]{40}$/.test(spec.source.commit),
    `faces-spec.json pins the upstream SVG commit (${spec.source?.commit})`,
  );
  check(
    typeof spec.source?.license === 'string' && /CC0|public domain/i.test(spec.source.license),
    'faces-spec.json records the public-domain licence',
  );
  const ids = spec.faces.map((face) => face.id);
  check(ids.length === 37, `faces-spec.json lists 37 faces (${ids.length})`);
  check(new Set(ids).size === 37, 'faces-spec.json face ids are unique');
  check(
    STANDARD_FACE_IDS.every((id) => ids.includes(id)),
    'faces-spec.json covers all 34 standard faces plus the 3 red fives',
  );
  check(!ids.includes('blank'), 'faces-spec.json has no blank glyph (the bare tile is blank)');
  for (const face of spec.faces) {
    check(
      typeof face.source === 'string' && existsSync(resolve(renderDir, face.source)),
      `${face.id} source SVG exists (${face.source})`,
    );
  }
  check(
    existsSync(facesManifestPath),
    'faces.json exists at frontend/public/table/faces.json',
  );
  if (!existsSync(facesManifestPath)) return;

  const manifest = readJson(facesManifestPath);
  check(manifest.version === 1, 'faces.json version is 1');
  check(
    manifest.source?.commit === spec.source.commit && manifest.source?.repo === spec.source.repo,
    'faces.json provenance matches the spec',
  );
  const raster = spec.raster;
  check(
    manifest.raster?.width === raster.width && manifest.raster?.height === raster.height,
    `faces.json raster is ${raster.width}x${raster.height}`,
  );
  const entries = manifest.faces ?? {};
  const entryIds = Object.keys(entries);
  check(entryIds.length === 37, `faces.json lists 37 faces (${entryIds.length})`);
  check(
    STANDARD_FACE_IDS.every((id) => entryIds.includes(id)),
    'faces.json covers all 37 glyph faces',
  );

  let totalBytes = 0;
  for (const id of STANDARD_FACE_IDS) {
    const entry = entries[id];
    const specFace = spec.faces.find((face) => face.id === id);
    check(Boolean(entry), `faces.json has ${id}`);
    if (!entry) continue;
    check(
      entry.sourceSvg === specFace.source,
      `${id} provenance points at its vendored SVG (${entry.sourceSvg})`,
    );
    check(typeof entry.textureFile === 'string', `${id} has a textureFile`);
    if (typeof entry.textureFile !== 'string') continue;
    const file = join(tableDir, entry.textureFile);
    check(existsSync(file), `${id} PNG exists (${entry.textureFile})`);
    if (!existsSync(file)) continue;
    const image = readPng(file);
    check(
      image.width === raster.width && image.height === raster.height && image.channels === 4,
      `${id} is ${raster.width}x${raster.height} RGBA (got ${image.width}x${image.height}/${image.channels}ch)`,
    );
    totalBytes += image.bytes;
    check(entry.bytes === image.bytes, `${id} manifest byte count matches (${image.bytes} B)`);
    check(
      entry.sha256?.decodedRgba === sha256(image.data),
      `${id} decoded-RGBA sha256 matches the committed PNG`,
    );
    const stats = faceInkStats(image);
    check(
      entry.measured?.inkPixels === stats.inkPixels &&
        entry.measured?.redPixels === stats.redPixels &&
        JSON.stringify(entry.measured?.inkBBox) === JSON.stringify(stats.inkBBox),
      `${id} measured ink matches the PNG (${stats.inkPixels} px, ${stats.redPixels} red)`,
    );
    if (id === '5z') {
      check(stats.inkPixels === 0, `5z (haku) is a blank white face (${stats.inkPixels} ink px)`);
    } else {
      check(stats.inkPixels > 1000, `${id} has visible ink (${stats.inkPixels} px)`);
      check(
        stats.inkBBox !== null &&
          stats.inkBBox.left >= 0 &&
          stats.inkBBox.top >= 0 &&
          stats.inkBBox.right <= image.width - 1 &&
          stats.inkBBox.bottom <= image.height - 1,
        `${id} ink is inside the glyph canvas (${JSON.stringify(stats.inkBBox)})`,
      );
      const inkFraction = stats.inkPixels / (image.width * image.height);
      check(
        inkFraction >= 0.02 && inkFraction <= 0.85,
        `${id} ink covers ${(inkFraction * 100).toFixed(1)}% (2-85%)`,
      );
    }
    if (entry.red === true) {
      check(stats.redPixels > 1000, `${id} red five really is red (${stats.redPixels} red px)`);
    }
    // The four glyph corners must be transparent so the carve bake sees a clean
    // glyph margin rather than paint at the plate's edge.
    for (const [x, y] of [
      [0, 0],
      [image.width - 1, 0],
      [0, image.height - 1],
      [image.width - 1, image.height - 1],
    ]) {
      check(pixel(image, x, y)[3] === 0, `${id} corner ${x},${y} is transparent`);
    }
  }
  check(
    totalBytes <= spec.output.bytesBudget,
    `face glyphs total ${totalBytes} B (budget ${spec.output.bytesBudget} B)`,
  );
  note(`face glyphs total ${totalBytes} B across ${entryIds.length} PNGs`);
}

/** The 3D carve consumes these masters; its manifest must cover the same set. */
function checkCarveContract() {
  check(existsSync(reliefManifestPath), 'relief3d.json exists (the 3D carve manifest)');
  if (!existsSync(reliefManifestPath)) return;
  const manifest = readJson(reliefManifestPath);
  const carveFaces = Object.keys(manifest.faces ?? {});
  check(carveFaces.length === 37, `relief3d.json covers 37 faces (${carveFaces.length})`);
  check(
    STANDARD_FACE_IDS.every((id) => carveFaces.includes(id)),
    'relief3d.json covers every glyph master id',
  );
  for (const [key, entry] of Object.entries(manifest.atlases ?? {})) {
    check(existsSync(join(tableDir, entry.file)), `relief3d ${key} atlas exists (${entry.file})`);
  }
}

try {
  const spec = readJson(facesSpecPath);
  checkFacesSpec(spec);
  checkCarveContract();
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  console.error(error);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} FAILED of ${checks} checks`);
  process.exit(1);
}
console.log(`\nOK ${checks} checks passed`);
