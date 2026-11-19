#!/usr/bin/env node
/**
 * Integrity check for the Phase 2 face glyphs and the startup-atlas budget.
 *
 *   node tools/render/scripts/check-faces.mjs
 *
 * Dependency-free on purpose: it runs in CI and never needs resvg or Blender.
 * It validates facts, not looks (AGENTS.md §6):
 *
 *   - `faces-spec.json` pins the public-domain upstream commit, lists exactly
 *     the 34 standard faces plus the three red fives, and every source SVG is
 *     vendored;
 *   - every committed glyph PNG decodes as 8-bit RGBA at the spec's size, its
 *     byte count, measured ink and decoded-RGBA sha256 match `faces.json`, the
 *     corners are transparent (so the atlas can clip to `faceQuad` without
 *     touching the shell's bevel), haku has zero ink, and the red fives really
 *     carry red paint;
 *   - the glyph byte budget holds;
 *   - the committed table assets (shells + manifest + felt + glyphs +
 *     `faces.json`) stay under the 8 MiB total-asset limit, and a full board's
 *     @1x bodies + felt + manifests stay under the 4 MiB initial-load limit;
 *   - the Phase 2 atlas is planned for the 18 face-up shells (14 hand slots +
 *     the flat upright/sideways pond shells) with the runtime's page formula,
 *     and reports its decoded RGBA cost at 1x and 2x. The 34 per-slot dora
 *     shells are not in the Phase 2 catalogue; this prints their additional
 *     cost for the follow-up task.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng } from './png.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const facesSpecPath = join(renderDir, 'faces-spec.json');
const shellsManifestPath = resolve(renderDir, '../../frontend/public/table/shells.json');
const facesManifestPath = resolve(renderDir, '../../frontend/public/table/faces.json');
const feltPath = resolve(renderDir, '../../frontend/public/table/felt.png');
const tableDir = resolve(renderDir, '../../frontend/public/table');

const TOTAL_BUDGET = 8 * 1024 * 1024;
const INITIAL_LOAD_BUDGET = 4 * 1024 * 1024;
const PAGE_WIDTH = 2048;
const ATLAS_1X_BUDGET = 32 * 1024 * 1024;

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

/** Asset byte budgets are advisory during active development (AGENTS.md §1c). */
function budget(condition, label) {
  checks += 1;
  if (condition) {
    console.log(`PASS ${label}`);
  } else if (strictBudget) {
    failures.push(label);
    console.log(`FAIL ${label}`);
  } else {
    console.log(`WARN ${label} (advisory; --strict-budget to fail)`);
  }
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

const HAND_SLOT_IDS = [
  '00', '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', 'draw',
];

const PHASE2_FACE_UP_SHELL_IDS = [
  ...HAND_SLOT_IDS.map((slot) => `shell_hand_slot_${slot}`),
  'shell_flat_upright',
  'shell_flat_sideways',
  'shell_flat_upright_180',
  'shell_flat_sideways_270',
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
  check(!ids.includes('blank'), 'faces-spec.json has no blank glyph (the bare shell is blank)');
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
    const file = join(tableDir, entry.textureFile.replace(/^faces\//, 'faces/'));
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
    // The four glyph corners must be transparent, so the atlas can clip to the
    // face plate without the glyph's own margin carrying paint.
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

  // The master must stay above the @2x face axes so the atlas only downsamples.
  const shells = readJson(shellsManifestPath).shells;
  let maxFaceLongAxis = 0;
  for (const id of PHASE2_FACE_UP_SHELL_IDS) {
    const quad = shells[id].faceQuad;
    for (let i = 0; i < 4; i += 1) {
      const [x1, y1] = quad[i];
      const [x2, y2] = quad[(i + 1) % 4];
      maxFaceLongAxis = Math.max(maxFaceLongAxis, Math.hypot(x2 - x1, y2 - y1));
    }
  }
  check(
    raster.height >= 1.5 * maxFaceLongAxis * 2,
    `master glyph ${raster.width}x${raster.height} stays ${(raster.height / (maxFaceLongAxis * 2)).toFixed(2)}x the longest @2x face axis (${(maxFaceLongAxis * 2).toFixed(1)} px)`,
  );
}

function checkBudgets() {
  const shells = readJson(shellsManifestPath).shells;
  let shellsBytes = 0;
  let body1xBytes = 0;
  let faceUpBody1xBytes = 0;
  let faceUpShadow1xBytes = 0;
  for (const [id, record] of Object.entries(shells)) {
    for (const path of [
      record.textureFile,
      record.textureFile2x,
      record.shadowTextureFile,
    ]) {
      shellsBytes += statSync(join(tableDir, path)).size;
    }
    body1xBytes += statSync(join(tableDir, record.textureFile)).size;
    if (PHASE2_FACE_UP_SHELL_IDS.includes(id)) {
      faceUpBody1xBytes += statSync(join(tableDir, record.textureFile)).size;
      faceUpShadow1xBytes += statSync(join(tableDir, record.shadowTextureFile)).size;
    }
  }
  let facesBytes = 0;
  for (const record of Object.values(readJson(facesManifestPath).faces)) {
    facesBytes += statSync(join(tableDir, record.textureFile)).size;
  }
  const decalsManifestPath = join(tableDir, 'decals.json');
  let decalsBytes = 0;
  let decalsManifestBytes = 0;
  if (existsSync(decalsManifestPath)) {
    decalsManifestBytes = statSync(decalsManifestPath).size;
    for (const record of Object.values(readJson(decalsManifestPath).decals)) {
      decalsBytes += statSync(join(tableDir, record.textureFile)).size;
    }
  }
  // Task 4B relief atlases are committed for the Task 5A compositor; they are
  // measured here so the total-asset number stays honest. Nothing fetches them
  // until Task 5A lands.
  const reliefManifestPath = join(tableDir, 'relief.json');
  let reliefBytes = 0;
  if (existsSync(reliefManifestPath)) {
    reliefBytes = statSync(reliefManifestPath).size;
    for (const record of Object.values(readJson(reliefManifestPath).atlases ?? {})) {
      const file = join(tableDir, record.file);
      if (existsSync(file)) reliefBytes += statSync(file).size;
    }
  }
  const manifestBytes = statSync(shellsManifestPath).size + statSync(facesManifestPath).size;
  const feltBytes = statSync(feltPath).size;
  const total =
    shellsBytes +
    manifestBytes +
    feltBytes +
    facesBytes +
    decalsBytes +
    decalsManifestBytes +
    reliefBytes;
  budget(
    total <= TOTAL_BUDGET,
    `committed table assets are ${total} B (${(total / 1024 / 1024).toFixed(2)} MiB, limit 8 MiB)`,
  );

  // The flat-glyph board loads one body per drawn shell at @1x, the felt, both
  // manifests and the 37 glyph masters. Shadows are group shapes, not sprites.
  // The @1x bodies of all 107 shells are the worst case if every zone is drawn.
  // The decal-based initial load is measured by check-decals.mjs.
  const initial = body1xBytes + feltBytes + manifestBytes + facesBytes;
  budget(
    initial <= INITIAL_LOAD_BUDGET,
    `initial hand + board @1x load is ${initial} B (${(initial / 1024 / 1024).toFixed(2)} MiB, limit 4 MiB)`,
  );
  note(
    `Phase 2 face-up shells: ${faceUpBody1xBytes} B bodies + ${faceUpShadow1xBytes} B shadow sprites @1x`,
  );
  note(
    `shell textures ${shellsBytes} B, faces ${facesBytes} B, manifests ${manifestBytes} B, ` +
      `felt ${feltBytes} B, carved decals ${decalsBytes} B, relief atlases ${reliefBytes} B`,
  );
}

/** Mirror of the runtime per-shell page layout (TileAtlasBuilder). */
function planAtlasPage(texWidth, texHeight, slots, scale) {
  const spriteWidth = texWidth * scale;
  const spriteHeight = texHeight * scale;
  const columns = Math.max(1, Math.min(slots, Math.floor(PAGE_WIDTH / spriteWidth)));
  const rows = Math.ceil(slots / columns);
  return { width: columns * spriteWidth, height: rows * spriteHeight, slots };
}

function checkAtlasPlan() {
  const shells = readJson(shellsManifestPath).shells;
  const faces = readJson(facesManifestPath).faces;
  const inkedFaces = STANDARD_FACE_IDS.filter((id) => (faces[id]?.measured?.inkPixels ?? 0) > 0);
  const bareSlots = STANDARD_FACE_IDS.length > inkedFaces.length ? 1 : 0;
  const slots = inkedFaces.length + bareSlots;
  check(
    slots === 37,
    `one face-up shell page holds 37 slots (${inkedFaces.length} inked + ${bareSlots} bare)`,
  );
  check(
    PHASE2_FACE_UP_SHELL_IDS.every((id) => shells[id]?.faceUp === true),
    `all ${PHASE2_FACE_UP_SHELL_IDS.length} Phase 2 atlas shells are face-up in shells.json`,
  );
  check(
    ['shell_wall_horizontal', 'shell_wall_side_left', 'shell_wall_side_right'].every(
      (id) => shells[id]?.faceUp === false && !PHASE2_FACE_UP_SHELL_IDS.includes(id),
    ),
    'the face-down wall shells are bare and contribute no atlas page',
  );

  for (const scale of [1, 2]) {
    let pixels = 0;
    let maxPage = 0;
    for (const id of PHASE2_FACE_UP_SHELL_IDS) {
      const record = shells[id];
      const page = planAtlasPage(record.texWidth, record.texHeight, slots, scale);
      pixels += page.width * page.height;
      maxPage = Math.max(maxPage, page.width, page.height);
    }
    const rgba = pixels * 4;
    note(
      `atlas @${scale}x: ${PHASE2_FACE_UP_SHELL_IDS.length} pages, ${pixels} px, ` +
        `${(rgba / 1024 / 1024).toFixed(2)} MiB RGBA, largest page edge ${maxPage} px`,
    );
    if (scale === 1) {
      check(
        rgba <= ATLAS_1X_BUDGET,
        `the @1x startup atlas is ${rgba} B RGBA (limit ${ATLAS_1X_BUDGET} B)`,
      );
    }
  }

  let doraPixels1x = 0;
  const doraIds = Object.keys(shells).filter(
    (id) => shells[id].faceUp === true && id.includes('_faceup') && id.includes('_slot_'),
  );
  for (const id of doraIds) {
    const record = shells[id];
    const page = planAtlasPage(record.texWidth, record.texHeight, slots, 1);
    doraPixels1x += page.width * page.height;
  }
  note(
    `not built (Phase 2 scope): ${doraIds.length} per-slot dora shells would add ` +
      `${doraPixels1x} px / ${(doraPixels1x * 4 / 1024 / 1024).toFixed(2)} MiB at 1x`,
  );
}

try {
  const spec = readJson(facesSpecPath);
  checkFacesSpec(spec);
  checkBudgets();
  checkAtlasPlan();
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  console.error(error);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} FAILED of ${checks} checks`);
  process.exit(1);
}
console.log(`\nOK ${checks} checks passed`);
