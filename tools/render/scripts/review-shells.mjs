#!/usr/bin/env node
/**
 * Review sheets for the baked 2.5D shells.
 *
 *   node tools/render/scripts/review-shells.mjs [--out tools/render/build/review]
 *
 * These are throwaway artefacts for the user's visual sign-off (AGENTS.md §6),
 * never shipped and never committed (`build/` is gitignored). The script only
 * lays sprites out with the manifest's own `advanceWidth/Height` and draw order,
 * so what you see is the layout contract, not a hand-composed mock-up:
 *
 *   - `shells-row-1x.png`       every shell in catalogue order, on the felt base
 *   - `discard-row-1x.png`      6-tile discard row + an isolated tile, then a
 *                               riichi (sideways) tile in a row
 *   - `discard-row-zoom4x.png`  nearest-neighbour 4x of the discard seams
 *   - `wall-stack-1x.png`       two-tier wall stack plus both side-wall columns
 *   - `wall-stack-zoom4x.png`   nearest-neighbour 4x of a stack seam
 *   - `each-4x-<shell>.png`     every shell at 4x, transparent margins included
 *
 * Draw order follows the architecture: uniform rows (ponds) right-to-left,
 * per-slot fan rows (hand, top hand, walls) outermost-to-innermost, wall stacks
 * bottom tier before top tier. The background is the felt's base colour
 * (not the felt raster), so shadow contrast is easy to see.
 *
 * `--audition` writes the candidate matrix instead: one labelled sheet
 * per shell (`shell-candidates-<shell>.png`) with one row (or, for the side
 * walls, one column) per candidate, each composed at that candidate's own
 * `gridStepPx`, plus a `REF PHASE 1` row/column from the committed half-size
 * shells. Parameters are printed with the dependency-free 5x7 font in
 * `label-font.mjs`, and a layout guard throws if a sprite or the content would
 * leave the sheet.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drawSprite, drawSpriteMax, encodePng, readPng, zoomNearest } from './png.mjs';
import { drawText, textWidth, wrapText } from './label-font.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = outIndex >= 0 ? resolve(args[outIndex + 1]) : join(renderDir, 'build', 'review');
const auditionMode = args.includes('--audition');
const previewMode = args.includes('--preview');
const shadowAuditionMode = args.includes('--shadow-audition');

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const shellSpec = await readJson(join(renderDir, 'shell-spec.json'));
const feltSpec = await readJson(join(renderDir, 'felt-spec.json'));
const manifest = await readJson(
  previewMode
    ? join(renderDir, 'build', 'preview', 'shells.json')
    : join(renderDir, shellSpec.outputs.manifest),
);
const tableDir = previewMode
  ? resolve(renderDir, 'build', 'preview')
  : resolve(renderDir, dirname(shellSpec.outputs.manifest));

const [feltR, feltG, feltB] = feltSpec.baseColor;
mkdirSync(outDir, { recursive: true });

const textures = new Map();
function texture(id) {
  if (!textures.has(id)) {
    const entry = manifest.shells[id];
    if (!entry) throw new Error(`shells.json has no ${id}`);
    textures.set(id, readPng(resolve(tableDir, entry.textureFile)));
  }
  return textures.get(id);
}

const shadowTextures = new Map();
function shadowTexture(id) {
  if (!shadowTextures.has(id)) {
    const entry = manifest.shells[id];
    if (!entry) throw new Error(`shells.json has no ${id}`);
    shadowTextures.set(id, readPng(resolve(tableDir, entry.shadowTextureFile)));
  }
  return shadowTextures.get(id);
}

function canvas(width, height) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = feltR;
    data[i * 4 + 1] = feltG;
    data[i * 4 + 2] = feltB;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data, channels: 4, stride: width * 4 };
}

// The blob shadows are separate sprites. Queue every tile placement, then flush
// every shadow into one transparent layer with a per-pixel max (the union), draw
// that layer over the felt, and only then draw the bodies. A shadow can never
// land on top of a neighbouring tile, and two adjacent blobs do not double-darken
// where they overlap.
/** The union of the body box and the separate shadow box, relative to the grid. */
function spriteBox(entry) {
  const bodyLeft = -entry.anchorX;
  const bodyTop = -entry.anchorY;
  const shadowLeft = -(entry.shadowAnchorX ?? entry.anchorX);
  const shadowTop = -(entry.shadowAnchorY ?? entry.anchorY);
  const right = Math.max(
    bodyLeft + entry.texWidth,
    shadowLeft + (entry.shadowTexWidth ?? entry.texWidth),
  );
  const bottom = Math.max(
    bodyTop + entry.texHeight,
    shadowTop + (entry.shadowTexHeight ?? entry.texHeight),
  );
  return {
    left: Math.min(bodyLeft, shadowLeft),
    top: Math.min(bodyTop, shadowTop),
    right,
    bottom,
    width: right - Math.min(bodyLeft, shadowLeft),
    height: bottom - Math.min(bodyTop, shadowTop),
  };
}

const pendingDraws = [];
function draw(id, target, gridX, gridY) {
  const entry = manifest.shells[id];
  const box = spriteBox(entry);
  const left = Math.round(gridX + box.left);
  const top = Math.round(gridY + box.top);
  const right = Math.round(gridX + box.right);
  const bottom = Math.round(gridY + box.bottom);
  if (left < 0 || top < 0 || right > target.width || bottom > target.height) {
    throw new Error(
      `sheet overflow: ${id} body/shadow ${left},${top}..${right},${bottom} ` +
        `leaves ${target.width}x${target.height}`,
    );
  }
  pendingDraws.push({ id, target, gridX, gridY });
}

function transparentCanvas(width, height) {
  return {
    width,
    height,
    data: Buffer.alloc(width * height * 4),
    channels: 4,
    stride: width * 4,
  };
}

function flushDraws() {
  const layers = new Map();
  for (const item of pendingDraws) {
    if (!layers.has(item.target)) {
      layers.set(item.target, transparentCanvas(item.target.width, item.target.height));
    }
    const entry = manifest.shells[item.id];
    drawSpriteMax(
      layers.get(item.target),
      shadowTexture(item.id),
      Math.round(item.gridX - (entry.shadowAnchorX ?? entry.anchorX)),
      Math.round(item.gridY - (entry.shadowAnchorY ?? entry.anchorY)),
    );
  }
  for (const [target, layer] of layers) drawSprite(target, layer, 0, 0);
  for (const item of pendingDraws) {
    const entry = manifest.shells[item.id];
    drawSprite(
      item.target,
      texture(item.id),
      Math.round(item.gridX - entry.anchorX),
      Math.round(item.gridY - entry.anchorY),
    );
  }
  pendingDraws.length = 0;
}

const pendingText = [];
function queueText(image, text, x, y, options) {
  pendingText.push({ image, text, x, y, options });
}
function flushText() {
  for (const item of pendingText) drawText(item.image, item.text, item.x, item.y, item.options);
  pendingText.length = 0;
}

function write(name, image) {
  flushDraws();
  flushText();
  const buffer = encodePng(image.width, image.height, image.channels, image.data);
  const path = join(outDir, name);
  writeFileSync(path, buffer);
  console.log(`${path}  ${image.width}x${image.height}  ${buffer.length} B`);
}

function zoomOf(image, x, y, width, height, factor, name) {
  const cropWidth = Math.max(1, Math.floor(width));
  const cropHeight = Math.max(1, Math.floor(height));
  const clampedX = Math.max(0, Math.min(image.width - cropWidth, Math.floor(x)));
  const clampedY = Math.max(0, Math.min(image.height - cropHeight, Math.floor(y)));
  write(name, zoomNearest(image, clampedX, clampedY, cropWidth, cropHeight, factor));
}

// --------------------------------------------------------------------------- //
// 0. Preview mode: only the shells named by --only, written under build/preview.
//    This is the fast loop; it never reads or writes the committed manifest.
// --------------------------------------------------------------------------- //
if (previewMode) {
  const ids = Object.keys(manifest.shells);
  if (!ids.length) throw new Error('preview manifest has no shells');
  const pad = 24;
  const rowGap = 24;
  const labelH = 22;
  const rightStep = (entry) => {
    const x = entry.gridStepPx.x;
    const y = entry.gridStepPx.y;
    const pick = Math.abs(x[0]) >= Math.abs(y[0]) ? x : y;
    return pick[0] < 0 ? -pick[0] : pick[0];
  };
  const step = Math.max(8, rightStep(manifest.shells[ids[0]]));
  // The shadow box is larger than the body box, so a sheet must reserve the
  // shadow's own right/bottom extent or the blob clips at the edge.
  const rightExtent = (entry) =>
    Math.max(entry.texWidth - entry.anchorX, entry.shadowTexWidth - entry.shadowAnchorX);
  const bottomExtent = (entry) =>
    Math.max(entry.texHeight - entry.anchorY, entry.shadowTexHeight - entry.shadowAnchorY);
  const maxTextureHeight = Math.max(...ids.map((id) => bottomExtent(manifest.shells[id])));
  const packedRight = Math.max(
    ...ids.map((id, index) => pad + index * step + rightExtent(manifest.shells[id])),
  );
  const explodedStep = step + rowGap;
  const explodedRight = Math.max(
    ...ids.map((id, index) => pad + index * explodedStep + rightExtent(manifest.shells[id])),
  );
  const width = Math.ceil(Math.max(packedRight, explodedRight) + pad + 160);
  const rowHeight = labelH + maxTextureHeight;
  const image = canvas(width, Math.ceil(pad + rowHeight * 2 + 2 * rowGap + 3 * labelH + 2 * pad));
  queueText(
    image,
    `PREVIEW  ${ids.length} SHELL${ids.length === 1 ? '' : 'S'}  (BUILD/PREVIEW, NOT COMMITTED)`,
    pad,
    pad,
    { scale: 2, rgb: [244, 238, 220] },
  );
  const packedTop = pad + labelH + pad;
  const explodedTop = packedTop + rowHeight + rowGap + labelH;
  queueText(image, 'PACKED AT GRIDSTEPPX', pad, packedTop - labelH, { scale: 2, rgb: [204, 214, 200] });
  queueText(image, 'EXPLODED', pad, explodedTop - labelH, { scale: 2, rgb: [204, 214, 200] });
  const offsetOf = (id) => {
    const entry = manifest.shells[id];
    return entry.handSlot?.offsetUnits ?? entry.topHandSlot?.offsetUnits ?? entry.wallSlot?.offsetUnits ?? 0;
  };
  const packedOrder = [...ids].sort((a, b) => Math.abs(offsetOf(b)) - Math.abs(offsetOf(a)));
  packedOrder.forEach((id, index) => {
    draw(id, image, pad + index * step, packedTop);
  });
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    draw(id, image, pad + index * explodedStep, explodedTop);
    queueText(
      image,
      id.replace('shell_', ''),
      pad + index * explodedStep,
      explodedTop + maxTextureHeight + 4,
      { scale: 1, rgb: [204, 214, 200] },
    );
  }
  write('preview-1x.png', image);
  for (const id of ids) {
    const sprite = texture(id);
    write(`preview-${id}-4x.png`, zoomNearest(sprite, 0, 0, sprite.width, sprite.height, 4));
    const entry = manifest.shells[id];
    console.log(
      `PREVIEW ${id}: tex ${entry.texWidth}x${entry.texHeight}, ` +
        `advance ${entry.advanceWidth}x${entry.advanceHeight}, grid ${JSON.stringify(entry.gridStepPx)}, ` +
        `${entry.stackStepPx ? `stack ${JSON.stringify(entry.stackStepPx)}, ` : ''}` +
        `${entry.camera?.distanceUnits !== undefined ? `off ${entry.camera.lateralOffsetUnits} d ${entry.camera.distanceUnits}, ` : ''}` +
        `faceUp ${entry.faceUp}`,
    );
  }
  console.log(`${outDir}/preview-1x.png  and ${ids.length} 4x zoom(s)`);
  process.exit(0);
}

// --------------------------------------------------------------------------- //
// 0b. Shadow audition: the same flat/wall/hand shells at REF and three shadow
//     variants, with the seam and isolated-drop luma printed.
// --------------------------------------------------------------------------- //
if (shadowAuditionMode) {
  const block = shellSpec.shadowAudition;
  const shadowManifest = await readJson(join(renderDir, block.manifest));
  const shadowDir = dirname(join(renderDir, block.manifest));
  const shadowTextures = new Map();
  const variantTexture = (record) => {
    const key = record.textureFile;
    if (!shadowTextures.has(key)) {
      shadowTextures.set(key, readPng(resolve(shadowDir, key)));
    }
    return shadowTextures.get(key);
  };
  const variantShadowTexture = (record) => {
    const key = record.shadowTextureFile;
    if (!shadowTextures.has(key)) {
      shadowTextures.set(key, readPng(resolve(shadowDir, key)));
    }
    return shadowTextures.get(key);
  };
  const pendingRecords = [];
  const drawRecord = (record, target, gridX, gridY, what = 'shadow') => {
    const texture = variantTexture(record);
    const left = Math.round(gridX - record.anchorX);
    const top = Math.round(gridY - record.anchorY);
    if (left < 0 || top < 0 || left + texture.width > target.width || top + texture.height > target.height) {
      throw new Error(
        `shadow sheet overflow: ${what} ${record.textureFile} ${left},${top} ` +
          `${texture.width}x${texture.height} leaves ${target.width}x${target.height}`,
      );
    }
    pendingRecords.push({ record, target, gridX, gridY });
  };
  const flushRecordDraws = () => {
    const layers = new Map();
    for (const item of pendingRecords) {
      if (!layers.has(item.target)) {
        layers.set(item.target, transparentCanvas(item.target.width, item.target.height));
      }
      drawSpriteMax(
        layers.get(item.target),
        variantShadowTexture(item.record),
        Math.round(item.gridX - item.record.shadowAnchorX),
        Math.round(item.gridY - item.record.shadowAnchorY),
      );
    }
    for (const [target, layer] of layers) drawSprite(target, layer, 0, 0);
    for (const item of pendingRecords) {
      drawSprite(
        item.target,
        variantTexture(item.record),
        Math.round(item.gridX - item.record.anchorX),
        Math.round(item.gridY - item.record.anchorY),
      );
    }
    pendingRecords.length = 0;
  };
  const lumaAt = (image, x, y) => {
    const i = (Math.round(y) * image.width + Math.round(x)) * 4;
    return 0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2];
  };
  const advancePadding = (record) => record.padding?.right ?? 0;
  const pad = 24;
  const labelWidth = 340;
  const labelLine = 16;
  const gap = 24;
  const flat = shadowManifest.variants[0].shells[block.shells[0]];
  const wall = shadowManifest.variants[0].shells[block.shells[1]];
  const hand = shadowManifest.variants[0].shells[block.shells[2]];
  const flatStep = flat.gridStepPx.x[0];
  const handStep = hand.gridStepPx.x[0];
  const flatWidth = 6 * flatStep + gap + flat.advanceWidth + advancePadding(flat);
  const handWidth = 6 * handStep + gap + hand.advanceWidth + advancePadding(hand);
  const wallWidth = Math.abs(wall.stackStepPx[0]) + wall.advanceWidth + advancePadding(wall) + 20;
  const width = Math.ceil(pad + labelWidth + pad + flatWidth + pad + wallWidth + pad + handWidth + pad);
  const variantHeight = 170;
  const headerHeight = 58;
  const height = Math.ceil(pad + headerHeight + shadowManifest.variants.length * variantHeight + pad);
  const image = canvas(width, height);
  queueText(image, 'SHADOW CANDIDATES  REF + A/B/C', pad, pad, {
    scale: 3,
    rgb: [244, 238, 220],
  });
  queueText(
    image,
    'FLAT RUN + ISOLATED (SEAM AND DROP),  WALL STACK,  HAND RUN + ISOLATED',
    pad,
    pad + 28,
    { scale: 2, rgb: [204, 214, 200] },
  );
  const flatX = pad + labelWidth + pad;
  const wallX = flatX + flatWidth + pad;
  const handX = wallX + wallWidth + pad;
  shadowManifest.variants.forEach((variant, rowIndex) => {
    const rowTop = pad + headerHeight + rowIndex * variantHeight;
    queueText(image, variant.id, pad, rowTop, {
      scale: 2,
      rgb: [244, 238, 220],
    });
    queueText(image, variant.label, pad, rowTop + 20, {
      scale: 1,
      rgb: [204, 214, 200],
    });
    const flatRecord = variant.shells[block.shells[0]];
    const wallRecord = variant.shells[block.shells[1]];
    const handRecord = variant.shells[block.shells[2]];
    const bodyTop = rowTop + 44;
    // Flat run, right-to-left, then the isolated tile.
    for (let index = 5; index >= 0; index -= 1) {
      drawRecord(flatRecord, image, flatX + index * flatStep, bodyTop);
    }
    const isolatedX = flatX + 6 * flatStep + gap;
    drawRecord(flatRecord, image, isolatedX, bodyTop);
    // Wall stack: bottom tier, then the top tier at its projected thickness.
    drawRecord(wallRecord, image, wallX, bodyTop);
    drawRecord(
      wallRecord,
      image,
      wallX + wallRecord.stackStepPx[0],
      bodyTop + wallRecord.stackStepPx[1],
    );
    // Hand run, right-to-left, then the isolated tile.
    for (let index = 5; index >= 0; index -= 1) {
      drawRecord(handRecord, image, handX + index * handStep, bodyTop - 10);
    }
    drawRecord(handRecord, image, handX + 6 * handStep + gap, bodyTop - 10);
    flushRecordDraws();
    const seam = lumaAt(image, flatX + flatStep + 2, bodyTop + flatRecord.advanceHeight * 0.5);
    const interior = lumaAt(image, flatX + flatStep + 14, bodyTop + flatRecord.advanceHeight * 0.5);
    const isolated = lumaAt(image, isolatedX + flatStep + 3, bodyTop + flatRecord.advanceHeight - 2);
    const bare = lumaAt(image, handX + handWidth - 6, bodyTop + flatRecord.advanceHeight - 2);
    queueText(
      image,
      `SEAM ${seam.toFixed(1)} VS ${interior.toFixed(1)}   DROP ${isolated.toFixed(1)} VS ${bare.toFixed(1)}`,
      pad,
      rowTop + 108,
      { scale: 1, rgb: [204, 214, 200] },
    );
    console.log(
      `SHADOW ${variant.id}: seam ${seam.toFixed(1)} vs ${interior.toFixed(1)}, ` +
        `drop ${isolated.toFixed(1)} vs ${bare.toFixed(1)}`,
    );
    queueText(image, variant.note ?? '', pad, rowTop + 124, {
      scale: 1,
      rgb: [160, 180, 164],
    });
  });
  write('shadow-candidates.png', image);
  console.log(`${outDir}/shadow-candidates.png  ${width}x${height}`);
  process.exit(0);
}

// --------------------------------------------------------------------------- //
// 1. Every shell in a row, with gaps, so each silhouette is reviewable.
// --------------------------------------------------------------------------- //
if (!auditionMode) {
  const ids = shellSpec.shells.map((shell) => shell.id);
  const gap = 24;
  const boxes = ids.map((id) => spriteBox(manifest.shells[id]));
  const leftPad = Math.max(...boxes.map((box) => -box.left)) + gap;
  const topPad = Math.max(...boxes.map((box) => -box.top)) + gap;
  const cell = Math.max(...boxes.map((box) => box.width)) + gap;
  const width = Math.ceil(leftPad + ids.length * cell + gap);
  const height = Math.ceil(topPad + Math.max(...boxes.map((box) => box.height)) + gap);
  const image = canvas(width, height);
  let x = leftPad;
  for (const id of ids) {
    draw(id, image, x, topPad);
    x += cell;
  }
  write('shells-row-1x.png', image);
  for (const id of ids) {
    const sprite = texture(id);
    write(`each-4x-${id}.png`, zoomNearest(sprite, 0, 0, sprite.width, sprite.height, 4));
  }
}

// --------------------------------------------------------------------------- //
// 2. Discard rows: shadow continuity, the isolated-tile case, and riichi.
// --------------------------------------------------------------------------- //
if (!auditionMode) {
  const upright = manifest.shells.shell_flat_upright;
  const sideways = manifest.shells.shell_flat_sideways;
  const upBox = spriteBox(upright);
  const sideBox = spriteBox(sideways);
  const pad = 24;
  const padX = Math.max(pad, -upBox.left, -sideBox.left) + 4;
  const padY = Math.max(pad, -upBox.top, -sideBox.top) + 4;
  const uprightStep = upright.gridStepPx.x[0];
  const sidewaysStep = sideways.gridStepPx.y[0];
  const rowY = (index) => padY + index * (upright.advanceHeight + pad);
  const riichiY = rowY(1) + upright.advanceHeight - sideways.advanceHeight;
  const continuityRight = padX + 6 * uprightStep + 15 + upBox.right;
  const riichiRight = padX + 6 * uprightStep + sidewaysStep + upBox.right;
  const width = Math.ceil(Math.max(continuityRight, riichiRight) + pad);
  const height = Math.ceil(
    Math.max(rowY(0) + upBox.bottom, riichiY + Math.max(upBox.bottom, sideBox.bottom)) + pad,
  );
  const image = canvas(width, height);

  // Row 1: six touching tiles, then a 15 px gap, then an isolated tile. Drawn
  // right-to-left: the left tile's right shadow must fall on its right
  // neighbour's left bevel.
  const continuity = [];
  for (let index = 0; index < 6; index += 1) {
    continuity.push(['shell_flat_upright', padX + index * uprightStep]);
  }
  continuity.push(['shell_flat_upright', padX + 6 * uprightStep + 15]);
  for (const [id, gridX] of [...continuity].reverse()) draw(id, image, gridX, rowY(0));

  // Row 2: a riichi / called tile rotated 90°, extrusion and shadow still
  // down-right. A sideways tile advances by its long (height) axis.
  const riichiRow = [];
  let x = padX;
  for (let index = 0; index < 3; index += 1) {
    riichiRow.push(['shell_flat_upright', x]);
    x += uprightStep;
  }
  riichiRow.push(['shell_flat_sideways', x]);
  x += sidewaysStep;
  for (let index = 0; index < 3; index += 1) {
    riichiRow.push(['shell_flat_upright', x]);
    x += uprightStep;
  }
  for (const [id, gridX] of [...riichiRow].reverse()) draw(id, image, gridX, riichiY);

  write('discard-row-1x.png', image);
  zoomOf(
    image,
    padX - 2,
    rowY(0) - 2,
    4 * upright.advanceWidth + 8,
    upright.advanceHeight + 8,
    4,
    'discard-row-zoom4x.png',
  );

  // Numbers for the shadow-continuity test: the seam between two touching
  // tiles should be darker than untouched felt, and the isolated tile should
  // still cast a shadow on the felt.
  const lumaAt = (x, y) => {
    const i = (Math.round(y) * image.width + Math.round(x)) * 4;
    return 0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2];
  };
  const feltX = width - pad - 4;
  const seamFaceX = padX + uprightStep + 2;
  const interiorFaceX = padX + uprightStep + 14;
  console.log(
    `INFO discard seam: neighbour face edge luma ${lumaAt(seamFaceX, rowY(0) + upright.advanceHeight * 0.5).toFixed(1)} ` +
      `vs its interior ${lumaAt(interiorFaceX, rowY(0) + upright.advanceHeight * 0.5).toFixed(1)}`,
  );
  const isolatedX = padX + 6 * uprightStep + 15;
  console.log(
    `INFO isolated tile shadow luma ${lumaAt(isolatedX + upright.advanceWidth * 0.5, rowY(0) + upright.advanceHeight + 4).toFixed(1)} ` +
      `vs bare felt ${lumaAt(feltX, rowY(0) + upright.advanceHeight - 2).toFixed(1)}`,
  );
}

// --------------------------------------------------------------------------- //
// 3. The wall rings: the per-slot front/back wall fan, the 2-tile stack and the
//    approved side-wall columns.
// --------------------------------------------------------------------------- //
function wallSlotId(wall, index, faceUp) {
  return `shell_wall_${wall}_slot_${String(index).padStart(2, '0')}${faceUp ? '_faceup' : ''}`;
}

if (!auditionMode) {
  const block = shellSpec.wallSlots;
  const count = block.count;
  const centre = block.centreIndex;
  const pad = 24;
  const labelH = 24;
  const rowGap = 20;
  const leftWall = manifest.shells.shell_wall_side_left;
  const rightWall = manifest.shells.shell_wall_side_right;
  const sideRun = 4;
  const wallPadX = Math.max(
    pad,
    ...Object.entries(manifest.shells)
      .filter(([id, entry]) => entry.wallSlot || id.startsWith('shell_wall_side'))
      .map(([, entry]) => entry.shadowAnchorX ?? 0),
  ) + 4;

  // The packed row advances by the physical tile-width axis of the centre slot;
  // each slot's own body is wider where its side face is revealed, exactly as
  // the layout contract says (the side face tucks under the neighbour).
  const centreEntry = manifest.shells[wallSlotId('front', centre, false)];
  const wallStepX = centreEntry.gridStepPx.x[0];
  const frontDora = 12;
  const backDora = 4;
  const wallOffsetOf = (id) => manifest.shells[id].wallSlot?.offsetUnits ?? 0;
  const wallOuterToInner = (ids) =>
    [...ids].sort((a, b) => Math.abs(wallOffsetOf(b)) - Math.abs(wallOffsetOf(a)));

  // The column step is whichever published tile axis points down the screen
  // (the long axis for the horizontal wall, the short axis for the side walls).
  const downStep = (entry) => {
    const x = entry.gridStepPx.x;
    const y = entry.gridStepPx.y;
    const pick = Math.abs(x[1]) >= Math.abs(y[1]) ? x : y;
    return pick[1] < 0 ? [-pick[0], -pick[1]] : pick;
  };
  const columns = [
    { id: 'shell_wall_side_left', dora: 'shell_wall_side_left_faceup', step: downStep(leftWall), entry: leftWall },
    { id: 'shell_wall_side_right', dora: 'shell_wall_side_right_faceup', step: downStep(rightWall), entry: rightWall },
  ].map((column) => ({
    ...column,
    span: Math.abs((sideRun - 1) * column.step[0]) + column.entry.advanceWidth + 8,
  }));

  // The packed run's extents include the full sprite (shadow margin included)
  // and the upper tier's lateral stackStepPx drift, not just the advance box.
  const packedExtent = (wall) => {
    let left = Infinity;
    let right = -Infinity;
    for (let index = 0; index < count; index += 1) {
      const down = manifest.shells[wallSlotId(wall, index, false)];
      const up = manifest.shells[wallSlotId(wall, index, true)];
      const x = wallPadX + index * wallStepX;
      for (const [entry, shift] of [[down, 0], [up, down.stackStepPx[0]]]) {
        const box = spriteBox(entry);
        left = Math.min(left, x + shift + box.left);
        right = Math.max(right, x + shift + box.right);
      }
    }
    return { left, right };
  };
  const runExtent = [packedExtent('front'), packedExtent('back')].reduce(
    (extent, current) => ({
      left: Math.min(extent.left, current.left),
      right: Math.max(extent.right, current.right),
    }),
    { left: Infinity, right: -Infinity },
  );
  const sideWidth = columns.reduce((sum, column) => sum + column.span + pad, 0);
  const width = Math.ceil(Math.max(runExtent.right + pad, wallPadX + sideWidth));
  const runHeight = labelH + centreEntry.advanceHeight + 44;
  const sideHeight = labelH + (sideRun - 1) * Math.abs(columns[0].step[1]) + leftWall.advanceHeight + 24;
  // The upper tier of the wall stack sits one projected thickness above the
  // lower tier, and its blob shadow needs its own top padding. The outer slots
  // have the largest perspective rise, so size the margin for the whole run.
  const maxStackRise = Math.max(
    ...['front', 'back'].flatMap((wall) =>
      Array.from({ length: count }, (_, index) =>
        Math.abs(manifest.shells[wallSlotId(wall, index, false)].stackStepPx[1]),
      ),
    ),
  );
  const stackShadowPad = Math.ceil(maxStackRise + (centreEntry.shadowAnchorY ?? 0));
  const height = Math.ceil(pad + 2 * runHeight + rowGap + sideHeight + pad + stackShadowPad);
  const image = canvas(width, height);

  const assertInside = (id, gridX, gridY, what) => {
    const entry = manifest.shells[id];
    const sprite = texture(id);
    const left = Math.round(gridX - entry.anchorX);
    const top = Math.round(gridY - entry.anchorY);
    if (left < 0 || top < 0 || left + sprite.width > image.width || top + sprite.height > image.height) {
      throw new Error(
        `wall-stack layout overflow: ${what} ${id} ${left},${top} ` +
          `${sprite.width}x${sprite.height} leaves ${image.width}x${image.height}`,
      );
    }
  };

  function drawPackedWall(wall, top, doraIndex) {
    const label = wall === 'front' ? 'FRONT WALL (BOTTOM, HUMAN SIDE)' : 'BACK WALL (TOP)';
    queueText(image, `${label}  ${count} STACKS  PACKED`, pad, top, {
      scale: 2,
      rgb: [244, 238, 220],
    });
    const bodyTop = top + labelH;
    // The camera is at the row centre, so the inner tile is nearer: the bottom
    // tier is drawn outermost-to-innermost on both halves, centre last.
    const bottomIds = Array.from({ length: count }, (_, index) => wallSlotId(wall, index, false));
    for (const id of wallOuterToInner(bottomIds)) {
      const index = manifest.shells[id].wallSlot.index;
      const x = wallPadX + index * wallStepX;
      assertInside(id, x, bodyTop, `${wall} ${index} bottom`);
      draw(id, image, x, bodyTop);
    }
    // Then the top tier, same order, with the dora slot face up.
    const topIds = Array.from({ length: count }, (_, index) =>
      wallSlotId(wall, index, index === doraIndex),
    );
    for (const id of wallOuterToInner(topIds)) {
      const index = manifest.shells[id].wallSlot.index;
      const down = manifest.shells[wallSlotId(wall, index, false)];
      const x = wallPadX + index * wallStepX + down.stackStepPx[0];
      const y = bodyTop + down.stackStepPx[1];
      assertInside(id, x, y, `${wall} ${index} top`);
      draw(id, image, x, y);
    }
    return bodyTop + centreEntry.advanceHeight + 24;
  }

  const frontBottom = drawPackedWall('front', pad + stackShadowPad, frontDora);
  const backTop = frontBottom + rowGap;
  const backBottom = drawPackedWall('back', backTop, backDora);

  // Side-wall columns: top-of-screen first, bottom tier then top tier per
  // stack. The second stack in each column is a dora indicator.
  const sideTop = backBottom + rowGap;
  queueText(image, 'SIDE WALLS (APPROVED PERSPECTIVE, 2-TILE STACKS)', pad, sideTop, {
    scale: 2,
    rgb: [244, 238, 220],
  });
  const sideBodyTop = sideTop + labelH;
  let cursorX = wallPadX;
  columns.forEach((column) => {
    const drift = Math.abs((sideRun - 1) * column.step[0]);
    const originX = cursorX + (column.step[0] < 0 ? drift : 0) + 4;
    for (let index = 0; index < sideRun; index += 1) {
      const x = originX + index * column.step[0];
      const y = sideBodyTop + index * column.step[1];
      assertInside(column.id, x, y, `${column.id} ${index} bottom`);
      draw(column.id, image, x, y);
    }
    for (let index = 0; index < sideRun; index += 1) {
      const x = originX + index * column.step[0] + column.entry.stackStepPx[0];
      const y = sideBodyTop + index * column.step[1] + column.entry.stackStepPx[1];
      const topId = index === 1 ? column.dora : column.id;
      assertInside(topId, x, y, `${column.id} ${index} top`);
      draw(topId, image, x, y);
    }
    cursorX += column.span + pad;
  });

  const outerFront = manifest.shells[wallSlotId('front', count - 1, false)];
  const outerBack = manifest.shells[wallSlotId('back', count - 1, false)];
  console.log(
    `INFO front wall: run step ${wallStepX.toFixed(2)} px, outer slot ` +
      `${outerFront.wallSlot.angleDeg} deg, body ${outerFront.advanceWidth}x${outerFront.advanceHeight}, ` +
      `stack rise ${outerFront.stackStepPx[1]} px`,
  );
  console.log(
    `INFO back wall: outer slot ${outerBack.wallSlot.angleDeg} deg, body ` +
      `${outerBack.advanceWidth}x${outerBack.advanceHeight}, stack rise ${outerBack.stackStepPx[1]} px`,
  );
  console.log(`INFO wall stack: ${count} stacks per front/back wall, 2 tiers per stack`);

  write('wall-stack-1x.png', image);
  zoomOf(
    image,
    pad + (count - 3) * wallStepX - 10,
    backTop - 6,
    3 * wallStepX + 20,
    labelH + Math.abs(centreEntry.stackStepPx[1]) + centreEntry.advanceHeight + 12,
    3,
    'wall-stack-zoom3x.png',
  );

  // ------------------------------------------------------------------------- //
  // The fan itself: the same slots with a gap so each slot's side reveal is
  // visible. The left half and the right half are separate rows so both mirror
  // images fit on one readable sheet.
  // ------------------------------------------------------------------------- //
  const fanGap = 24;
  const half = centre + 1;
  const fanStep = wallStepX + fanGap;
  const fanPad = 24;
  const fanLabelH = 24;
  const fanPadX = Math.max(
    fanPad,
    ...Object.values(manifest.shells)
      .filter((entry) => entry.wallSlot)
      .map((entry) => entry.shadowAnchorX ?? 0),
  ) + 4;
  let fanRight = -Infinity;
  for (const wall of ['front', 'back']) {
    for (let step = 0; step < half; step += 1) {
      const index = centre + step;
      const down = manifest.shells[wallSlotId(wall, index, false)];
      const up = manifest.shells[wallSlotId(wall, index, true)];
      const x = fanPadX + step * fanStep;
      fanRight = Math.max(fanRight, x + spriteBox(down).right);
      fanRight = Math.max(fanRight, x + down.stackStepPx[0] + spriteBox(up).right);
    }
  }
  const fanWidth = Math.ceil(fanRight + fanPad);
  const fanRowHeight = fanLabelH + Math.abs(centreEntry.stackStepPx[1]) + centreEntry.advanceHeight + 44;
  const fanTopMargin = Math.ceil(maxStackRise + (centreEntry.shadowAnchorY ?? 0));
  const fanImage = canvas(
    fanWidth,
    Math.ceil(4 * fanRowHeight + fanPad + fanTopMargin + 3 * 20),
  );
  const fanAssertInside = (id, gridX, gridY, what) => {
    const entry = manifest.shells[id];
    const sprite = texture(id);
    const left = Math.round(gridX - entry.anchorX);
    const top = Math.round(gridY - entry.anchorY);
    if (left < 0 || top < 0 || left + sprite.width > fanImage.width || top + sprite.height > fanImage.height) {
      throw new Error(
        `wall-fan layout overflow: ${what} ${id} ${left},${top} ` +
          `${sprite.width}x${sprite.height} leaves ${fanImage.width}x${fanImage.height}`,
      );
    }
  };
  function drawFanRow(wall, top, indices, label, doraIndex) {
    queueText(fanImage, label, fanPad, top, { scale: 2, rgb: [244, 238, 220] });
    const bodyTop = top + fanLabelH;
    const bottomIds = indices.map((index) => wallSlotId(wall, index, false));
    for (const id of wallOuterToInner(bottomIds)) {
      const index = manifest.shells[id].wallSlot.index;
      const step = indices.indexOf(index);
      const x = fanPadX + step * fanStep;
      fanAssertInside(id, x, bodyTop, `${wall} slot ${index} bottom`);
      draw(id, fanImage, x, bodyTop);
    }
    const topIds = indices.map((index) => wallSlotId(wall, index, index === doraIndex));
    for (const id of wallOuterToInner(topIds)) {
      const index = manifest.shells[id].wallSlot.index;
      const step = indices.indexOf(index);
      const down = manifest.shells[wallSlotId(wall, index, false)];
      const x = fanPadX + step * fanStep + down.stackStepPx[0];
      const y = bodyTop + down.stackStepPx[1];
      fanAssertInside(id, x, y, `${wall} slot ${index} top`);
      draw(id, fanImage, x, y);
    }
    // Slot number under each tile, so a note can name the slot directly.
    for (let step = 0; step < indices.length; step += 1) {
      const index = indices[step];
      queueText(fanImage, String(index), fanPad + step * fanStep + 28, bodyTop + centreEntry.advanceHeight + 8, {
        scale: 2,
        rgb: [204, 214, 200],
      });
    }
    return bodyTop + centreEntry.advanceHeight + 30;
  }
  const leftIndices = Array.from({ length: half }, (_, index) => index);
  const rightIndices = Array.from({ length: half }, (_, index) => centre + index);
  const fanRows = [];
  for (const wall of ['front', 'back']) {
    const outer = manifest.shells[wallSlotId(wall, count - 1, false)];
    for (const [indices, halfLabel] of [
      [rightIndices, `RIGHT HALF  SLOTS ${centre}..${count - 1}`],
      [leftIndices, `LEFT HALF  SLOTS 0..${centre}`],
    ]) {
      const top = fanPad + fanTopMargin + fanRows.length * (fanRowHeight + 20);
      drawFanRow(
        wall,
        top,
        indices,
        `${wall.toUpperCase()} WALL ${halfLabel}  OUTER ${outer.wallSlot.angleDeg} DEG`,
        indices === rightIndices ? count - 1 : 1,
      );
      fanRows.push({ wall, indices, top });
    }
  }
  write('wall-fan-1x.png', fanImage);
  for (const row of fanRows.filter((entry) => entry.indices === rightIndices)) {
    zoomOf(
      fanImage,
      fanPadX + (half - 3) * fanStep - 8,
      row.top - 4,
      3 * fanStep + 16,
      fanLabelH + Math.abs(centreEntry.stackStepPx[1]) + centreEntry.advanceHeight + 16,
      3,
      `wall-fan-${row.wall}-right-zoom3x.png`,
    );
  }
}

// --------------------------------------------------------------------------- //
// 3b. The standing hand: the 13-tile row + drawn tile, and the top hand's
//     reuse of the back-wall fan.
// --------------------------------------------------------------------------- //
if (!auditionMode) {
  const block = shellSpec.handSlots;
  const topHand = shellSpec.topHand;
  const pad = 24;
  const labelH = 24;
  const rowIds = Array.from({ length: block.rowCount }, (_, index) =>
    `shell_hand_slot_${String(index).padStart(2, '0')}`,
  );
  const drawId = 'shell_hand_slot_draw';
  const centreEntry = manifest.shells[`shell_hand_slot_${String(block.centreIndex).padStart(2, '0')}`];
  const handStepX = centreEntry.gridStepPx.x[0];
  const rowOffset = (index) => (index - block.centreIndex) * block.stepUnits;
  const handX = (offset) => pad + ((offset - rowOffset(0)) / block.stepUnits) * handStepX;
  const drawX = handX(block.drawOffsetUnits);
  const topIds = Array.from({ length: topHand.rowCount }, (_, index) =>
    `shell_hand_top_slot_${String(index).padStart(2, '0')}`,
  );
  const topCentre = manifest.shells[`shell_hand_top_slot_${String(topHand.centreIndex).padStart(2, '0')}`];
  const topStepX = topCentre.gridStepPx.x[0];
  const offsetOf = (id) =>
    manifest.shells[id].handSlot?.offsetUnits ??
    manifest.shells[id].topHandSlot?.offsetUnits ??
    0;
  const outerToInner = (ids) =>
    [...ids].sort((a, b) => Math.abs(offsetOf(b)) - Math.abs(offsetOf(a)));

  // ----- Packed: the actual hand row, drawn tile gap, and the top hand. -----
  const packedWidth = Math.ceil(pad + handX(block.drawOffsetUnits) + centreEntry.advanceWidth + pad);
  const packedHeight = Math.ceil(2 * (labelH + 120) + 3 * 18 + 2 * pad);
  const packed = canvas(packedWidth, packedHeight);
  const packedAssert = (id, gridX, gridY, what) => {
    const entry = manifest.shells[id];
    const sprite = texture(id);
    const left = Math.round(gridX - entry.anchorX);
    const top = Math.round(gridY - entry.anchorY);
    if (left < 0 || top < 0 || left + sprite.width > packed.width || top + sprite.height > packed.height) {
      throw new Error(
        `hand-stack layout overflow: ${what} ${id} ${left},${top} ` +
          `${sprite.width}x${sprite.height} leaves ${packed.width}x${packed.height}`,
      );
    }
  };
  queueText(packed, 'HUMAN HAND  13-TILE ROW + DRAWN TILE  PACKED', pad, pad, {
    scale: 2,
    rgb: [244, 238, 220],
  });
  const handTop = pad + labelH;
  // The camera is at the row centre, so the inner tile is nearer: draw
  // outermost-to-innermost on both halves, centre last. This is the correction
  // for the left-of-centre overlap.
  const handXOf = (id) =>
    id === drawId ? drawX : handX(rowOffset(Number(id.slice(-2))));
  for (const id of outerToInner([...rowIds, drawId])) {
    const x = handXOf(id);
    packedAssert(id, x, handTop, `hand slot ${id}`);
    draw(id, packed, x, handTop);
  }
  console.log(
    `INFO hand row: step ${handStepX.toFixed(2)} px, outer ${manifest.shells[rowIds[0]].handSlot.angleDeg} deg, ` +
      `drawn ${manifest.shells[drawId].handSlot.angleDeg} deg, gap ${(drawX - handX(rowOffset(block.rowCount - 1))).toFixed(2)} px centre-to-centre`,
  );

  const topTop = handTop + 120 + 12 + labelH;
  queueText(packed, 'TOP HAND  13 TILES  STANDING, BLUE BACKS  PACKED', pad, topTop - labelH, {
    scale: 2,
    rgb: [244, 238, 220],
  });
  for (const id of outerToInner(topIds)) {
    const index = manifest.shells[id].topHandSlot.index;
    const x = pad + index * topStepX;
    packedAssert(id, x, topTop, `top hand ${index}`);
    draw(id, packed, x, topTop);
  }
  console.log(
    `INFO top hand: ${topIds.length} tiles, step ${topStepX.toFixed(2)} px, ` +
      `outer ${manifest.shells[topIds[0]].topHandSlot.angleDeg} deg`,
  );
  write('hand-stack-1x.png', packed);
  zoomOf(
    packed,
    drawX - 2 * handStepX - 8,
    handTop - 6,
    3 * handStepX + 16,
    labelH + 120 + 8,
    3,
    'hand-right-zoom3x.png',
  );

  // ----- Exploded: the fan itself, both halves, every slot numbered. -----
  const gap = 24;
  const fanPad = 24;
  const fanLabelH = 24;
  const handFanStep = handStepX + gap;
  const topFanStep = topStepX + gap;
  const half = block.centreIndex + 1;
  const handRightIndices = [...rowIds.slice(block.centreIndex), drawId];
  const handLeftIndices = rowIds.slice(0, block.centreIndex + 1);
  const topRightIndices = topIds.slice(topHand.centreIndex);
  const topLeftIndices = topIds.slice(0, topHand.centreIndex + 1);
  const fanRows = [
    { ids: handRightIndices, step: handFanStep, title: `HAND RIGHT HALF  SLOTS ${block.centreIndex}..12 + DRAWN  OUTER ${manifest.shells[drawId].handSlot.angleDeg} DEG` },
    { ids: handLeftIndices, step: handFanStep, title: `HAND LEFT HALF  SLOTS 0..${block.centreIndex}  OUTER ${manifest.shells[rowIds[0]].handSlot.angleDeg} DEG` },
    { ids: topRightIndices, step: topFanStep, title: `TOP HAND RIGHT HALF  SLOTS ${topHand.centreIndex}..${topHand.rowCount - 1}  OUTER ${manifest.shells[topIds[topIds.length - 1]].topHandSlot.angleDeg} DEG` },
    { ids: topLeftIndices, step: topFanStep, title: `TOP HAND LEFT HALF  SLOTS 0..${topHand.centreIndex}  SAME FAN` },
  ];
  const fanRowHeight = fanLabelH + 120 + 40;
  let fanWidth = 0;
  for (const row of fanRows) {
    let right = -Infinity;
    for (let step = 0; step < row.ids.length; step += 1) {
      const entry = manifest.shells[row.ids[step]];
      right = Math.max(right, fanPad + step * row.step - entry.anchorX + entry.texWidth);
    }
    fanWidth = Math.max(fanWidth, right);
  }
  const longestTitle = Math.max(...fanRows.map((row) => textWidth(row.title, 2)));
  fanWidth = Math.ceil(Math.max(fanWidth + fanPad, longestTitle + 2 * fanPad));
  const fanImage = canvas(fanWidth, Math.ceil(fanRows.length * fanRowHeight + 2 * fanPad + 3 * 16));
  const fanAssert = (id, gridX, gridY, what) => {
    const entry = manifest.shells[id];
    const sprite = texture(id);
    const left = Math.round(gridX - entry.anchorX);
    const top = Math.round(gridY - entry.anchorY);
    if (left < 0 || top < 0 || left + sprite.width > fanImage.width || top + sprite.height > fanImage.height) {
      throw new Error(
        `hand-fan layout overflow: ${what} ${id} ${left},${top} ` +
          `${sprite.width}x${sprite.height} leaves ${fanImage.width}x${fanImage.height}`,
      );
    }
  };
  fanRows.forEach((row, rowIndex) => {
    const top = fanPad + rowIndex * (fanRowHeight + 16);
    queueText(fanImage, row.title, fanPad, top, { scale: 2, rgb: [244, 238, 220] });
    const bodyTop = top + fanLabelH;
    const xOf = new Map(row.ids.map((id, step) => [id, fanPad + step * row.step]));
    for (const id of outerToInner(row.ids)) {
      fanAssert(id, xOf.get(id), bodyTop, `fan row ${rowIndex} ${id}`);
      draw(id, fanImage, xOf.get(id), bodyTop);
    }
    row.ids.forEach((id, step) => {
      const label =
        id === drawId
          ? 'D'
          : id.replace('shell_hand_top_slot_', 'TOP').replace('shell_hand_slot_', '');
      queueText(fanImage, label, fanPad + step * row.step + 30, bodyTop + 124, {
        scale: 2,
        rgb: [204, 214, 200],
      });
    });
  });
  write('hand-fan-1x.png', fanImage);
  zoomOf(
    fanImage,
    fanPad + (handRightIndices.length - 3) * handFanStep - 8,
    fanPad - 4,
    3 * handFanStep + 16,
    fanLabelH + 120 + 16,
    3,
    'hand-fan-right-zoom3x.png',
  );
}

// --------------------------------------------------------------------------- //
// 4. Candidate matrix: one labelled sheet per auditioned shell at the current base.
// --------------------------------------------------------------------------- //
if (auditionMode) {
  const candidateManifest = await readJson(join(renderDir, shellSpec.audition.manifest));
  const candidateDir = dirname(join(renderDir, shellSpec.audition.manifest));
  const committedManifest = manifest;
  const committedDir = tableDir;

  function fillRect(image, x, y, width, height, rgb) {
    const left = Math.max(0, Math.round(x));
    const top = Math.max(0, Math.round(y));
    const right = Math.min(image.width, Math.round(x + width));
    const bottom = Math.min(image.height, Math.round(y + height));
    for (let py = top; py < bottom; py += 1) {
      for (let px = left; px < right; px += 1) {
        const offset = (py * image.width + px) * 4;
        image.data[offset] = rgb[0];
        image.data[offset + 1] = rgb[1];
        image.data[offset + 2] = rgb[2];
        image.data[offset + 3] = 255;
      }
    }
  }

  function rightStep(record) {
    const x = record.gridStepPx.x;
    const y = record.gridStepPx.y;
    return Math.abs(x[0]) >= Math.abs(y[0]) ? x : y;
  }

  function downStep(record) {
    // A wall column always steps down the screen, even where the projected
    // long axis leans far enough that the published axis points up.
    const x = record.gridStepPx.x;
    const y = record.gridStepPx.y;
    const pick = Math.abs(x[1]) >= Math.abs(y[1]) ? x : y;
    return pick[1] < 0 ? [-pick[0], -pick[1]] : pick;
  }

  function quadNumbers(record) {
    const quad = record.faceQuad;
    const width = Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]);
    const height = Math.hypot(quad[2][0] - quad[1][0], quad[2][1] - quad[1][1]);
    const long = Math.max(width, height);
    const short = Math.min(width, height);
    return { width, height, long, short, ratio: short / long };
  }

  const rowsFor = (baseId) => {
    const entry = candidateManifest.shells[baseId];
    const committed = committedManifest.shells[baseId];
    const rows = entry.candidates.map((record) => ({
      record,
      texture: readPng(resolve(candidateDir, record.textureFile)),
      title: `CANDIDATE ${record.candidate.candidateId}`,
      reference: false,
    }));
    rows.push({
      record: committed,
      texture: readPng(resolve(committedDir, committed.textureFile)),
      title: 'REF COMMITTED',
      reference: true,
    });
    return rows;
  };

  const labelLines = (row) => {
    const record = row.record;
    const face = quadNumbers(record);
    const bytes = record.measured.bytes1x / 1024;
    return [
      row.title,
      `CAM AZ ${record.camera.azimuthDeg} / EL ${record.camera.elevationDeg}`,
      `TEX ${record.texWidth}×${record.texHeight}`,
      `BODY ${record.advanceWidth}×${record.advanceHeight}`,
      `FACE ${face.long.toFixed(0)}×${face.short.toFixed(0)}`,
      `SHORT/LONG ${face.ratio.toFixed(2)}`,
      ...(record.camera.distanceUnits !== undefined
        ? [`OFF ${record.camera.lateralOffsetUnits} D ${record.camera.distanceUnits}`]
        : []),
      `1X ${bytes.toFixed(1)}K B`,
      ...(record.stackStepPx ? [`RISE ${record.stackStepPx[1]} PX`] : []),
    ];
  };

  const LABEL_WIDTH = 220;
  const LABEL_LINE = 16;
  const LABEL_HEIGHT = LABEL_LINE * 10 + 8;
  const MARGIN = 20;
  const PAD = 16;
  const ISOLATED_GAP = 24;
  const HEADER_TITLE = 28;
  const HEADER_BASE = 20;
  const HEADER_LINE = 16;
  const HEADER_GAP = 18;

  function headerPlan(baseId, width) {
    const entry = candidateManifest.shells[baseId];
    const lines = wrapText(`QUESTION: ${entry.question}`, width - 2 * MARGIN, 2);
    // title + base line + question lines + the small draw-order note + gap
    const height = HEADER_TITLE + HEADER_BASE + lines.length * HEADER_LINE + HEADER_LINE + HEADER_GAP;
    return { lines, height };
  }

  function header(image, baseId, plan, y) {
    const base = candidateManifest.base;
    let cursor = y;
    queueText(image, `${baseId.toUpperCase()}  CANDIDATE MATRIX`, MARGIN, cursor, {
      scale: 3,
      rgb: [244, 238, 220],
    });
    cursor += HEADER_TITLE;
    queueText(
      image,
      `BASE LONG AXIS ${base.targetLongAxisPx1x} PX @1X / ${base.targetLongAxisPx2x} PX @2X ` +
        `(PHASE 1 ${base.previousTargetLongAxisPx1x} / ${base.previousTargetLongAxisPx1x * base.pixelRatio})`,
      MARGIN,
      cursor,
      { scale: 2, rgb: [176, 200, 186] },
    );
    cursor += HEADER_BASE;
    for (const line of plan.lines) {
      queueText(image, line, MARGIN, cursor, { scale: 2, rgb: [214, 220, 190] });
      cursor += HEADER_LINE;
    }
    queueText(
      image,
      'TILES ARE COMPOSED WITH THIS CANDIDATE OWN GRIDSTEPPX; ROWS RIGHT-TO-LEFT, ROWS TOP-TO-BOTTOM',
      MARGIN,
      cursor,
      { scale: 1, rgb: [150, 168, 156] },
    );
    return cursor + HEADER_GAP;
  }

  function labelPanel(image, row, x, y) {
    fillRect(image, x, y, LABEL_WIDTH, LABEL_HEIGHT, [10, 22, 17]);
    const lines = labelLines(row);
    lines.forEach((line, index) => {
      queueText(image, line, x + 8, y + 6 + index * LABEL_LINE, {
        scale: 2,
        rgb: index === 0 ? [244, 238, 220] : [204, 214, 200],
      });
    });
  }

  function drawAt(row, image, gridX, gridY) {
    drawSprite(
      image,
      row.texture,
      Math.round(gridX - row.record.anchorX),
      Math.round(gridY - row.record.anchorY),
    );
  }

  /** Layout assertion: a sprite (including its shadow padding) must fit. */
  function fit(image, row, gridX, gridY, what) {
    const left = Math.round(gridX - row.record.anchorX);
    const top = Math.round(gridY - row.record.anchorY);
    const right = left + row.texture.width;
    const bottom = top + row.texture.height;
    if (left < 0 || top < 0 || right > image.width || bottom > image.height) {
      throw new Error(
        `sheet layout overflow: ${what} sprite ${left},${top} ${row.texture.width}x${row.texture.height} ` +
          `leaves ${image.width}x${image.height}`,
      );
    }
  }

  for (const baseId of Object.keys(candidateManifest.shells)) {
    const entry = candidateManifest.shells[baseId];
    const rows = rowsFor(baseId);
    const sideWall = baseId.startsWith('shell_wall_side');

    if (sideWall) {
      // Candidate matrix: one column per candidate, a wall run of four tiles
      // stepping down (a leaned column drifts sideways, so each cell is wide
      // enough for its own drift and the run is centred in it).
      const run = 4;
      const columns = rows.length;
      const spans = rows.map((row) => {
        const down = downStep(row.record);
        return Math.max(
          LABEL_WIDTH + 8,
          Math.abs((run - 1) * down[0]) + row.record.advanceWidth + 8,
        );
      });
      const columnHeights = rows.map((row) => {
        const down = downStep(row.record);
        const rise = Math.abs(row.record.stackStepPx?.[1] ?? 0);
        return LABEL_HEIGHT + 12 + (run - 1) * down[1] + rise + row.record.texHeight;
      });
      const width = Math.ceil(MARGIN * 2 + spans.reduce((sum, value) => sum + value, 0) + (columns - 1) * 12);
      const plan = headerPlan(baseId, width);
      const height = Math.ceil(
        MARGIN + plan.height + Math.max(...columnHeights) + MARGIN,
      );
      const image = canvas(width, height);
      const top = header(image, baseId, plan, MARGIN);
      let x = MARGIN;
      rows.forEach((row, index) => {
        labelPanel(image, row, x, top);
        const down = downStep(row.record);
        const drift = Math.abs((run - 1) * down[0]);
        const originX = x + (spans[index] - (drift + row.record.advanceWidth)) / 2 + (down[0] < 0 ? drift : 0);
        const originY = top + LABEL_HEIGHT + 12;
        const rise = row.record.stackStepPx ?? [0, 0];
        for (let step = 0; step < run; step += 1) {
          const x = originX + step * down[0];
          const y = originY + step * down[1];
          // A wall stack is two tiles: the bottom tier, then the top tier one
          // projected thickness higher.
          fit(image, row, x, y, `${baseId} column ${step} bottom`);
          drawAt(row, image, x, y);
          fit(image, row, x + rise[0], y + rise[1], `${baseId} column ${step} top`);
          drawAt(row, image, x + rise[0], y + rise[1]);
        }
        x += spans[index] + 12;
      });
      const contentBottom = top + Math.max(...columnHeights);
      if (contentBottom > height - MARGIN) {
        throw new Error(`sheet layout overflow: ${baseId} content bottom ${contentBottom} > ${height - MARGIN}`);
      }
      write(`shell-candidates-${baseId}.png`, image);
    } else {
      // One row per candidate: six touching tiles (drawn right-to-left), then
      // an isolated tile so the drop shadow lands on bare felt.
      const pond = baseId === 'shell_flat_upright' || baseId === 'shell_flat_sideways';
      const run = 6;
      const rowWidths = rows.map((row) => {
        const right = rightStep(row.record);
        return (run - 1) * right[0] + row.record.advanceWidth + ISOLATED_GAP + row.record.advanceWidth;
      });
      const rowHeights = rows.map((row) => {
        const down = downStep(row.record);
        const extra = pond ? Math.max(0, down[1]) : 0;
        return Math.max(LABEL_HEIGHT, row.record.texHeight + extra + 8);
      });
      const width = Math.ceil(MARGIN + LABEL_WIDTH + PAD + Math.max(...rowWidths) + MARGIN);
      const plan = headerPlan(baseId, width);
      const contentHeight = rowHeights.reduce((sum, value) => sum + value + 10, 0);
      const height = Math.ceil(MARGIN + plan.height + contentHeight + MARGIN);
      const image = canvas(width, height);
      let y = header(image, baseId, plan, MARGIN);
      rows.forEach((row, index) => {
        labelPanel(image, row, MARGIN, y);
        const right = rightStep(row.record);
        const down = downStep(row.record);
        const originX = MARGIN + LABEL_WIDTH + PAD;
        const originY = y + 4;
        const rowCount = pond ? 2 : 1;
        for (let pondRow = 0; pondRow < rowCount; pondRow += 1) {
          for (let tile = run - 1; tile >= 0; tile -= 1) {
            const gx = originX + tile * right[0] + pondRow * down[0];
            const gy = originY + tile * right[1] + pondRow * down[1];
            fit(image, row, gx, gy, `${baseId} row ${index} tile ${tile}`);
            drawAt(row, image, gx, gy);
          }
        }
        const isolatedX =
          originX + (run - 1) * right[0] + row.record.advanceWidth + ISOLATED_GAP;
        fit(image, row, isolatedX, originY, `${baseId} row ${index} isolated`);
        drawAt(row, image, isolatedX, originY);
        y += rowHeights[index] + 10;
      });
      if (y > height - MARGIN + 10) {
        throw new Error(`sheet layout overflow: ${baseId} content bottom ${y} > ${height - MARGIN}`);
      }
      write(`shell-candidates-${baseId}.png`, image);
    }
    console.log(
      `INFO ${baseId}: ${entry.candidates.length} candidates + 1 reference, question: ${entry.question}`,
    );
  }
}

console.log('');
console.log(`felt base colour ${feltR},${feltG},${feltB} (from felt-spec.json)`);
if (!auditionMode) {
  console.log('draw order: ponds right-to-left; fans outermost-to-innermost; wall bottom tier before top tier');
}
