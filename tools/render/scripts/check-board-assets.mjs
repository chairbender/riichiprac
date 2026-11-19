#!/usr/bin/env node
/**
 * Acceptance gate for the Task 4 static board assets. No Blender.
 *
 *   node tools/render/scripts/check-board-assets.mjs
 *
 * Validates facts, not looks (AGENTS.md §6):
 *
 *   - the bake is the default rig variant's, at the layout's 1920 x 1080
 *     reference resolution, with the same camera;
 *   - the layout's bucket catalogue and the blanks manifest agree one-to-one:
 *     every emitted bucket has exactly one sprite, one representative slot and
 *     the slot's published anchor/depth/scale, and the sprite count is under
 *     the Task 4 limit of 20;
 *   - every blank PNG is RGBA at its recorded size, has a real opaque body, an
 *     anti-aliased edge, a fully transparent padding border and no external
 *     alpha more than `noHaloPx` away from the body (a baked cast shadow would
 *     fail); its recorded pivot maps back to the layout anchor, its pixel face
 *     quad maps back to the slot's normalized faceQuad, and its decoded-RGBA
 *     hash matches the manifest;
 *   - the board PNG is opaque at 1920 x 1080, is not a flat fill, and its
 *     decoded hash matches;
 *   - the face atlas is the stable 37-face rank/honour/red-five order in a
 *     6 x 7 grid of 288 x 384 cells, cells tile without overlap, each inked
 *     face has ink, haku is the one documented zero-ink face, the 0m/0p/0s
 *     aliases point at the three red fives, and every cell + the whole atlas
 *     reproduce the manifest's decoded hashes.
 */
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng } from './png.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tableDir = resolve(renderDir, '..', '..', 'frontend', 'public', 'table');

const spec = JSON.parse(readFileSync(resolve(renderDir, 'board-assets-spec.json'), 'utf8'));
const layout = JSON.parse(readFileSync(resolve(tableDir, 'table_layout.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(tableDir, 'blanks.json'), 'utf8'));
const atlas = JSON.parse(readFileSync(resolve(tableDir, 'tile_faces.json'), 'utf8'));

let checks = 0;
let failures = 0;
const fail = (message) => {
  failures += 1;
  console.error(`  FAIL ${message}`);
};
const check = (condition, message) => {
  checks += 1;
  if (!condition) fail(message);
  return condition;
};
const checkEqual = (label, left, right) => {
  checks += 1;
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    fail(`${label}: ${JSON.stringify(left)} != ${JSON.stringify(right)}`);
  }
};
const close = (left, right, tolerance = 1e-6) => Math.abs(left - right) <= tolerance;

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function area(quad) {
  let total = 0;
  for (let i = 0; i < quad.length; i += 1) {
    const a = quad[i];
    const b = quad[(i + 1) % quad.length];
    total += a.x * b.y - b.x * a.y;
  }
  return total / 2;
}

function measureCell(image, rect) {
  let inkPixels = 0;
  let opaquePixels = 0;
  let redPixels = 0;
  for (let y = 0; y < rect.height; y += 1) {
    for (let x = 0; x < rect.width; x += 1) {
      const i = ((rect.y + y) * image.width + rect.x + x) * 4;
      const r = image.data[i];
      const g = image.data[i + 1];
      const b = image.data[i + 2];
      const a = image.data[i + 3];
      if (a > 8) {
        inkPixels += 1;
        if (a > 250) opaquePixels += 1;
        if (r > g + 40 && r > b + 40) redPixels += 1;
      }
    }
  }
  return { inkPixels, opaquePixels, redPixels };
}

function cellRgba(image, rect) {
  const out = Buffer.alloc(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y += 1) {
    const from = ((rect.y + y) * image.width + rect.x) * 4;
    image.data.copy(out, y * rect.width * 4, from, from + rect.width * 4);
  }
  return out;
}

// ------------------------------------------------------------------ contract
checkEqual('manifest.version', manifest.version, 1);
check(
  manifest.generatedBy === 'tools/render/bake_board_assets.py',
  `manifest.generatedBy is ${manifest.generatedBy}`,
);
checkEqual('manifest.variant', manifest.variant, layout.variant);
checkEqual('manifest.layout.file', manifest.layout.file, 'table_layout.json');
checkEqual(
  'manifest.layout.sha256',
  manifest.layout.sha256,
  sha256(readFileSync(resolve(tableDir, 'table_layout.json'))),
);
checkEqual('manifest.referenceResolution', manifest.referenceResolution, layout.referenceResolution);
const pixelRatio = Number(spec.blanks.pixelRatio);
checkEqual('manifest.pixelRatio', manifest.pixelRatio, pixelRatio);
const frameWidth = layout.referenceResolution.width * pixelRatio;
const frameHeight = layout.referenceResolution.height * pixelRatio;
checkEqual('manifest.frame', manifest.frame, { width: frameWidth, height: frameHeight });
for (const key of ['eye', 'target', 'lensMm', 'sensorWidthMm', 'shiftX', 'shiftY', 'elevationDeg']) {
  checkEqual(`camera.${key}`, manifest.camera[key], layout.camera[key]);
}

const catalogue = layout.bucketCatalogue;
const buckets = Object.keys(catalogue).sort();
const declared = [];
for (const family of layout.buckets) {
  const names = family.names ?? Object.values(family.seats ?? {});
  for (const name of names) {
    declared.push(name);
    if (family.rotatedSuffix) declared.push(`${name}${family.rotatedSuffix}`);
  }
}
checkEqual('declared buckets', declared.slice().sort(), buckets);
checkEqual('manifest bucket keys', Object.keys(manifest.blanks).sort(), buckets);
check(
  buckets.length < Number(spec.checks.maxBlankSprites),
  `${buckets.length} blank sprites is not under ${spec.checks.maxBlankSprites}`,
);
const slots = new Map(layout.slots.map((slot) => [slot.id, slot]));

// --------------------------------------------------------------------- board
const boardRecord = manifest.board;
const boardPath = resolve(tableDir, boardRecord.textureFile);
checkEqual('board.textureFile', boardRecord.textureFile, 'board_bg.png');
checkEqual(
  'board.spec resolution',
  [boardRecord.width, boardRecord.height],
  spec.board.resolution,
);
checkEqual('board.pixelRatio', boardRecord.pixelRatio, 1);
checkEqual(
  'board.scene.visible',
  boardRecord.scene.visible,
  ['compass-plate', 'compass-ring', 'compass-well-floor', 'floor', 'mat', 'rim'].sort(),
);
check(boardRecord.scene.filmTransparent === false, 'board is not rendered with an opaque film');
checkEqual('board bytes', boardRecord.bytes, statSync(boardPath).size);

if (check(readPngSafe(boardPath) !== null, 'board_bg.png is a readable PNG')) {
  const image = readPng(boardPath);
  checkEqual('board.png size', [image.width, image.height], [boardRecord.width, boardRecord.height]);
  checkEqual('board.png channels', image.channels, 4);
  const minAlpha = boardRecord.alpha?.min;
  let decodedMinAlpha = 255;
  let min = 255;
  let max = 0;
  let sum = 0;
  for (let i = 0; i < image.width * image.height; i += 1) {
    const a = image.data[i * 4 + 3];
    if (a < decodedMinAlpha) decodedMinAlpha = a;
    const luma = Math.round(
      0.2126 * image.data[i * 4] + 0.7152 * image.data[i * 4 + 1] + 0.0722 * image.data[i * 4 + 2],
    );
    if (luma < min) min = luma;
    if (luma > max) max = luma;
    sum += luma;
  }
  const mean = sum / (image.width * image.height);
  let variance = 0;
  for (let i = 0; i < image.width * image.height; i += 1) {
    const luma =
      0.2126 * image.data[i * 4] + 0.7152 * image.data[i * 4 + 1] + 0.0722 * image.data[i * 4 + 2];
    variance += (luma - mean) ** 2;
  }
  const deviation = Math.sqrt(variance / (image.width * image.height));
  checkEqual('board.png opaque', decodedMinAlpha, Number(spec.checks.boardAlpha));
  checkEqual('board record alpha', minAlpha, Number(spec.checks.boardAlpha));
  check(
    deviation > 6,
    `board_bg.png is a flat fill (luma deviation ${deviation.toFixed(2)})`,
  );
  check(
    max - min > 20,
    `board_bg.png has no tonal range (luma ${min.toFixed(0)}..${max.toFixed(0)})`,
  );
  checkEqual('board sha256', sha256(image.data), boardRecord.sha256.decodedRgba);
  // Content facts, not a look: the visible play surface is the green mat and the
  // recessed centre well is darker than the felt around it. A blank/black or
  // tile-filled board fails both.
  const pixel = (nx, ny) => {
    const x = Math.min(image.width - 1, Math.floor(nx * image.width));
    const y = Math.min(image.height - 1, Math.floor(ny * image.height));
    const i = (y * image.width + x) * 4;
    return [image.data[i], image.data[i + 1], image.data[i + 2]];
  };
  const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const well = luma(pixel(0.5, 0.5));
  const mat = luma(pixel(0.5, 0.62));
  check(
    well < mat - Number(spec.checks.boardWellLumaDropMin),
    `board centre well luma ${well.toFixed(1)} is not darker than the mat ${mat.toFixed(1)}`,
  );
  let green = 0;
  let sampled = 0;
  for (let ny = 0.35; ny < 0.65; ny += 0.01) {
    for (let nx = 0.25; nx < 0.75; nx += 0.01) {
      const [r, g, b] = pixel(nx, ny);
      sampled += 1;
      if (g > r + 8 && g > b + 4) green += 1;
    }
  }
  const greenFraction = green / sampled;
  check(
    greenFraction >= Number(spec.checks.boardGreenFractionMin),
    `only ${(greenFraction * 100).toFixed(1)}% of the central board is green mat`,
  );
  console.log(
    `[board] ${image.width}x${image.height} ${boardRecord.bytes} B ` +
      `luma ${min.toFixed(0)}..${max.toFixed(0)} mean ${mean.toFixed(1)} ` +
      `well ${well.toFixed(1)} mat ${mat.toFixed(1)} green ${(greenFraction * 100).toFixed(1)}%`,
  );
}

function readPngSafe(path) {
  try {
    return readPng(path);
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------- blanks
const haloRadius = Number(spec.checks.noHaloPx);
const minOpaque = Number(spec.checks.minOpaquePixels);
const minPartial = Number(spec.checks.minPartialAlphaPixels);

for (const bucket of buckets) {
  const record = manifest.blanks[bucket];
  const entry = catalogue[bucket];
  const slot = slots.get(entry.representative);
  const label = `blank:${bucket}`;

  checkEqual(`${label} family`, record.family, entry.family);
  checkEqual(`${label} bucket`, record.bucket, bucket);
  checkEqual(`${label} representative`, record.representative, entry.representative);
  checkEqual(`${label} slotCount`, record.slotCount, entry.count);
  checkEqual(`${label} pixelRatio`, record.pixelRatio, pixelRatio);
  check(check(Boolean(slot), `${label} representative is not in the layout`));
  if (!slot) continue;

  checkEqual(`${label} anchor`, record.anchor, slot.anchor);
  checkEqual(`${label} depth`, record.depth, slot.depth);
  checkEqual(`${label} scale`, record.scale, slot.scale);
  checkEqual(`${label} textureFile`, record.textureFile, `blanks/${bucket}.png`);
  const path = resolve(tableDir, record.textureFile);
  checkEqual(`${label} bytes`, record.bytes, statSync(path).size);

  const image = readPngSafe(path);
  if (!check(image !== null, `${label} is a readable PNG`)) continue;
  checkEqual(`${label} size`, [image.width, image.height], [record.width, record.height]);
  checkEqual(`${label} channels`, image.channels, 4);

  const alpha = Buffer.alloc(image.width * image.height);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = image.data[i * 4 + 3];
  let opaque = 0;
  let partial = 0;
  for (const value of alpha) {
    if (value === 255) opaque += 1;
    else if (value > 0) partial += 1;
  }
  check(opaque >= minOpaque, `${label} has only ${opaque} opaque pixels`);
  check(partial >= minPartial, `${label} has only ${partial} anti-aliased edge pixels`);
  checkEqual(`${label} opaque record`, record.alpha.opaquePixels, opaque);
  checkEqual(`${label} partial record`, record.alpha.partialAlphaPixels, partial);

  const edges = [
    alpha.subarray(0, image.width),
    alpha.subarray((image.height - 1) * image.width),
  ];
  let edgeMax = 0;
  for (const row of edges) for (const value of row) if (value > edgeMax) edgeMax = value;
  for (let y = 0; y < image.height; y += 1) {
    edgeMax = Math.max(edgeMax, alpha[y * image.width], alpha[y * image.width + image.width - 1]);
  }
  check(edgeMax === 0, `${label} padding border is not fully transparent (max alpha ${edgeMax})`);

  // A cast shadow would be low-alpha pixels far from the opaque body. The body
  // is the alpha>=200 core; no alpha in (16..199] may sit more than noHaloPx
  // away from it. The tile's own anti-aliased edge is one pixel wide.
  const high = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i += 1) high[i] = alpha[i] >= 200 ? 1 : 0;
  let halo = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const i = y * image.width + x;
      if (alpha[i] <= 16 || alpha[i] >= 200) continue;
      let near = false;
      for (let dy = -haloRadius; dy <= haloRadius && !near; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= image.height) continue;
        for (let dx = -haloRadius; dx <= haloRadius; dx += 1) {
          const xx = x + dx;
          if (xx < 0 || xx >= image.width) continue;
          if (high[yy * image.width + xx]) {
            near = true;
            break;
          }
        }
      }
      if (!near) halo += 1;
    }
  }
  check(halo === 0, `${label} has ${halo} external alpha pixels (cast-shadow halo)`);

  const frameW = manifest.frame.width;
  const frameH = manifest.frame.height;
  const anchorX = (record.crop.left + record.pivot.x) / frameW;
  const anchorY = (record.crop.top + record.pivot.y) / frameH;
  check(
    close(anchorX, record.anchor.x, 1e-5) && close(anchorY, record.anchor.y, 1e-5),
    `${label} pivot does not land on the exported anchor (${anchorX},${anchorY} vs ${record.anchor.x},${record.anchor.y})`,
  );
  check(
    record.pivot.x >= 0 &&
      record.pivot.x < image.width &&
      record.pivot.y >= 0 &&
      record.pivot.y < image.height,
    `${label} pivot ${record.pivot.x},${record.pivot.y} is outside the sprite`,
  );

  checkEqual(`${label} faceQuad corners`, record.faceQuad.length, 4);
  let quadOk = true;
  for (let corner = 0; corner < record.faceQuad.length; corner += 1) {
    const px = record.faceQuad[corner];
    const source = slot.faceQuad[corner];
    const expectedX = (record.anchor.x + source.x) * frameW - record.crop.left;
    const expectedY = (record.anchor.y + source.y) * frameH - record.crop.top;
    quadOk =
      quadOk &&
      close(px.x, expectedX, 0.01) &&
      close(px.y, expectedY, 0.01) &&
      px.x >= 0 &&
      px.x <= image.width &&
      px.y >= 0 &&
      px.y <= image.height;
  }
  check(quadOk, `${label} faceQuad does not map back to the slot's projected quad inside the sprite`);
  const quadArea = area(record.faceQuad);
  const layoutArea = area(slot.faceQuad);
  check(Math.abs(quadArea) > 0, `${label} faceQuad has zero area`);
  check(
    close(quadArea, layoutArea * frameW * frameH, 0.5),
    `${label} faceQuad area ${quadArea} does not match the slot's projected area ${layoutArea * frameW * frameH}`,
  );
  checkEqual(`${label} faceVisible`, record.faceVisible, layoutArea > 0);
  check(
    record.faceVisible || record.family === 'wall_side' || record.family === 'wall_horizontal',
    `${label} hides its face but is not a wall bucket`,
  );
  check(close(quadArea, record.faceQuadAreaPx, 0.02), `${label} faceQuadAreaPx disagrees`);
  checkEqual(`${label} sha256`, sha256(image.data), record.sha256.decodedRgba);

  console.log(
    `[blank] ${bucket.padEnd(20)} ${image.width}x${image.height} ` +
      `pivot ${record.pivot.x.toFixed(1)},${record.pivot.y.toFixed(1)} ` +
      `opaque ${opaque} edge ${partial} halo ${halo}`,
  );
}

// --------------------------------------------------------------------- atlas
const expectedOrder = [
  ...['m', 'p', 's'].flatMap((suit) => Array.from({ length: 9 }, (_, i) => `${i + 1}${suit}`)),
  ...Array.from({ length: 7 }, (_, i) => `${i + 1}z`),
  '5mr',
  '5pr',
  '5sr',
];
checkEqual('atlas.order', atlas.order, expectedOrder);
checkEqual('atlas.aliases', atlas.aliases, { '0m': '5mr', '0p': '5pr', '0s': '5sr' });
checkEqual('atlas face count', Object.keys(atlas.faces).length, Number(spec.checks.atlasFaces));
checkEqual('atlas.columns', atlas.atlas.columns, spec.atlas.columns);
checkEqual('atlas.rows', atlas.atlas.rows, spec.atlas.rows);
const cellWidth = atlas.raster.cellWidth;
const cellHeight = atlas.raster.cellHeight;
checkEqual('atlas cellWidth', cellWidth, atlas.atlas.cellWidth);
checkEqual('atlas cellHeight', cellHeight, atlas.atlas.cellHeight);
checkEqual('atlas size', [atlas.atlas.width, atlas.atlas.height], [
  spec.atlas.columns * cellWidth,
  spec.atlas.rows * cellHeight,
]);

const atlasPath = resolve(tableDir, atlas.atlas.file);
checkEqual('atlas file', atlas.atlas.file, 'tile_faces.png');
checkEqual('atlas bytes', atlas.atlas.bytes, statSync(atlasPath).size);
const atlasImage = readPngSafe(atlasPath);
if (check(atlasImage !== null, 'tile_faces.png is a readable PNG')) {
  checkEqual('atlas.png channels', atlasImage.channels, 4);
  checkEqual('atlas.png size', [atlasImage.width, atlasImage.height], [
    atlas.atlas.width,
    atlas.atlas.height,
  ]);
  checkEqual('atlas sha256', sha256(atlasImage.data), atlas.atlas.sha256.decodedRgba);

  const seen = new Set();
  const emptyFaces = [];
  for (const id of atlas.order) {
    const face = atlas.faces[id];
    const label = `atlas:${id}`;
    check(Boolean(face), `${label} is missing from the region map`);
    if (!face) continue;
    checkEqual(`${label} index`, face.index, atlas.order.indexOf(id));
    checkEqual(`${label} row`, face.row, Math.floor(face.index / atlas.atlas.columns));
    checkEqual(`${label} column`, face.column, face.index % atlas.atlas.columns);
    checkEqual(`${label} cell`, [face.region.width, face.region.height], [cellWidth, cellHeight]);
    checkEqual(`${label} region x`, face.region.x, face.column * cellWidth);
    checkEqual(`${label} region y`, face.region.y, face.row * cellHeight);
    const key = `${face.region.x},${face.region.y}`;
    check(!seen.has(key), `${label} overlaps another region at ${key}`);
    seen.add(key);

    const measured = measureCell(atlasImage, face.region);
    checkEqual(`${label} inkPixels`, measured.inkPixels, face.measured.inkPixels);
    checkEqual(`${label} redPixels`, measured.redPixels, face.measured.redPixels);
    checkEqual(`${label} decoded hash`, sha256(cellRgba(atlasImage, face.region)), face.sha256.decodedRgba);
    if (measured.inkPixels === 0) emptyFaces.push(id);
    if (!spec.checks.atlasEmptyFaces.includes(id)) {
      check(
        measured.inkPixels >= Number(spec.checks.atlasMinInkPixels),
        `${label} has only ${measured.inkPixels} ink pixels`,
      );
    }
  }
  checkEqual('atlas empty faces', emptyFaces.sort(), spec.checks.atlasEmptyFaces.slice().sort());

  for (const [alias, target] of Object.entries(atlas.aliases)) {
    check(Boolean(atlas.faces[target]), `atlas alias ${alias} -> ${target} is missing`);
    checkEqual(`alias ${alias}`, atlas.faces[target]?.red, true);
  }
  for (const id of spec.checks.atlasAliases) {
    check(Boolean(atlas.aliases[id]), `atlas is missing the ${id} alias`);
  }

  // Unused cells are required to be empty, so a future addition cannot leak ink
  // into a slot the region map does not name.
  const used = new Set(atlas.order.map((id) => atlas.faces[id].index));
  for (let index = 0; index < atlas.atlas.columns * atlas.atlas.rows; index += 1) {
    if (used.has(index)) continue;
    const rect = {
      x: (index % atlas.atlas.columns) * cellWidth,
      y: Math.floor(index / atlas.atlas.columns) * cellHeight,
      width: cellWidth,
      height: cellHeight,
    };
    checkEqual(`atlas unused cell ${index}`, measureCell(atlasImage, rect).inkPixels, 0);
  }

  console.log(
    `[atlas] ${atlasImage.width}x${atlasImage.height} ${atlas.atlas.bytes} B ` +
      `${atlas.order.length} faces (${atlas.order.length - emptyFaces.length} inked)`,
  );
}

// --------------------------------------------------------------------- report
console.log(`\n${checks} checks, ${failures} failures`);
if (failures > 0) {
  process.exitCode = 1;
}
