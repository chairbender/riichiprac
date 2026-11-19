#!/usr/bin/env node
/**
 * Compose the Task 4A review sheet (no Blender).
 *
 *   node tools/render/scripts/review-shadow-assets.mjs
 *
 * Writes, under the gitignored `build/review/shadows/`:
 *
 *   task4a-contact-sheet.png   four sections, each a real composite of the
 *                              committed pixels:
 *                              A) every bucket: the committed board crop, the
 *                                 mat shadow drawn at its anchor with the
 *                                 manifest's multiply model, then the blank
 *                                 body over it - exactly what Task 6A's pass 1
 *                                 plus a body draw will look like;
 *                              B) every wall seat: layer 0 body, the stack
 *                                 decal, then layer 1 body - pass 2;
 *                              C) the four crevice masks, cropped to their fade
 *                                 band with the alpha profile plotted beside
 *                                 them, so the 35 %-to-zero fade can be read
 *                                 off the pixels;
 *   task4a-numbers.json        the numbers the sheet annotates.
 *
 * Nothing here is a shipped asset and nothing here is a judgement: the sheet
 * exists so the user can look at it (AGENTS.md §6). The pass/fail facts live in
 * scripts/check-shadow-assets.mjs.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng, readPng, drawSprite } from './png.mjs';
import { drawText } from './label-font.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tableDir = resolve(renderDir, '..', '..', 'frontend', 'public', 'table');
const outDir = resolve(renderDir, 'build', 'review', 'shadows');

const layout = JSON.parse(readFileSync(resolve(tableDir, 'table_layout.json'), 'utf8'));
const blanks = JSON.parse(readFileSync(resolve(tableDir, 'blanks.json'), 'utf8'));
const shadows = JSON.parse(readFileSync(resolve(tableDir, 'shadows.json'), 'utf8'));
const seams = JSON.parse(readFileSync(resolve(tableDir, 'ao_seams.json'), 'utf8'));
const board = readPng(resolve(tableDir, 'board_bg.png'));

const frameWidth = shadows.frame.width;
const frameHeight = shadows.frame.height;
const pixelRatio = shadows.pixelRatio;
const slots = new Map(layout.slots.map((slot) => [slot.id, slot]));

const sheet = { width: 1064, height: 0, channels: 4, data: null, stride: 0 };
const MARGIN = 24;
const CELL = { width: 250, height: 216 };
const VIEW = { width: 220, height: 170 };

function load(spriteDir, name) {
  return readPng(resolve(spriteDir, name));
}

/** Box-filter a @2x sprite down to @1x in premultiplied space. */
function downsample2(image) {
  const width = Math.floor(image.width / 2);
  const height = Math.floor(image.height / 2);
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const i = ((y * 2 + dy) * image.width + x * 2 + dx) * 4;
          const alpha = image.data[i + 3] / 255;
          r += image.data[i] * alpha;
          g += image.data[i + 1] * alpha;
          b += image.data[i + 2] * alpha;
          a += alpha;
        }
      }
      if (a > 0) {
        data[out] = Math.round(r / a);
        data[out + 1] = Math.round(g / a);
        data[out + 2] = Math.round(b / a);
      }
      data[out + 3] = Math.round((a / 4) * 255);
    }
  }
  return { width, height, channels: 4, data, stride: width * 4 };
}

function clampOrigin(value, size, limit) {
  return Math.max(0, Math.min(value, limit - size));
}

function cropBoard(left, top, width, height) {
  const out = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(board.width - 1, Math.max(0, left + x));
      const sy = Math.min(board.height - 1, Math.max(0, top + y));
      const from = (sy * board.width + sx) * 4;
      board.data.copy(out, (y * width + x) * 4, from, from + 4);
    }
  }
  return { width, height, channels: 4, data: out, stride: width * 4 };
}

const lumaAt = (image, index) =>
  0.2126 * image.data[index] + 0.7152 * image.data[index + 1] + 0.0722 * image.data[index + 2];

/**
 * How much the shadow actually darkens the committed board inside its own
 * footprint, and that it changes nothing outside it. This is the measurement
 * that the composite follows the manifest's multiply model; it is a number, not
 * an opinion about how the result looks.
 */
function compositeDrop(raw, shaded, sprite, dx, dy) {
  let sum = 0;
  let count = 0;
  let outsideMax = 0;
  for (let y = 0; y < shaded.height; y += 1) {
    for (let x = 0; x < shaded.width; x += 1) {
      const ix = x - dx;
      const iy = y - dy;
      const inside = ix >= 0 && iy >= 0 && ix < sprite.width && iy < sprite.height;
      const alpha = inside ? sprite.data[(iy * sprite.width + ix) * 4 + 3] : 0;
      const index = (y * shaded.width + x) * 4;
      const drop = lumaAt(raw, index) - lumaAt(shaded, index);
      if (alpha > 0) {
        sum += drop;
        count += 1;
      } else if (Math.abs(drop) > outsideMax) {
        outsideMax = Math.abs(drop);
      }
    }
  }
  return {
    shadowPx: count,
    meanLumaDrop: count ? Number((sum / count).toFixed(2)) : 0,
    maxLumaDropOutside: Number(outsideMax.toFixed(2)),
  };
}

/** One cell: the board under the tile, the mat shadow, then the body. */
function drawTileCell(x, y, bucket, anchor) {
  const blank = blanks.blanks[bucket];
  const blankImage = downsample2(load(resolve(tableDir, 'blanks'), `${bucket}.png`));
  const shadow = shadows.matShadows[bucket];
  const shadowImage = shadow
    ? downsample2(load(resolve(tableDir, 'shadows'), shadow.textureFile.split('/').pop()))
    : null;
  const anchorX = anchor.x * layout.referenceResolution.width;
  const anchorY = anchor.y * layout.referenceResolution.height;
  const left = clampOrigin(Math.round(anchorX - VIEW.width / 2), VIEW.width, board.width);
  const top = clampOrigin(Math.round(anchorY - VIEW.height / 2), VIEW.height, board.height);
  const view = cropBoard(left, top, VIEW.width, VIEW.height);
  let composite = null;
  if (shadowImage) {
    const dx = Math.round(
      anchorX - left - shadow.pivot.x / pixelRatio,
    );
    const dy = Math.round(anchorY - top - shadow.pivot.y / pixelRatio);
    const raw = { ...view, data: Buffer.from(view.data) };
    drawSprite(view, shadowImage, dx, dy);
    composite = compositeDrop(raw, view, shadowImage, dx, dy);
  }
  const bodyX = Math.round(anchorX - left - blank.pivot.x / pixelRatio);
  const bodyY = Math.round(anchorY - top - blank.pivot.y / pixelRatio);
  drawSprite(view, blankImage, bodyX, bodyY);
  drawSprite(sheet, view, x, y);
  return composite;
}

function text(x, y, value, scale = 2) {
  drawText(sheet, value, x, y, { scale });
  return y + 7 * scale + 4;
}

function fillRect(x, y, width, height, colour) {
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const target = ((y + row) * sheet.width + x + col) * 4;
      if (target < 0 || target + 3 >= sheet.data.length) continue;
      sheet.data[target] = colour[0];
      sheet.data[target + 1] = colour[1];
      sheet.data[target + 2] = colour[2];
      sheet.data[target + 3] = 255;
    }
  }
}

// --------------------------------------------------------------- sheet plan
const buckets = Object.keys(blanks.blanks).sort();
const bucketRows = Math.ceil(buckets.length / 4);
const stackRows = 1;
const seamRows = 4;
const headerHeight = 96;
sheet.height =
  headerHeight +
  (40 + bucketRows * CELL.height) +
  (40 + stackRows * CELL.height) +
  (40 + seamRows * 170) +
  80;
sheet.data = Buffer.alloc(sheet.width * sheet.height * 4, 255);
sheet.stride = sheet.width * 4;
fillRect(0, 0, sheet.width, sheet.height, [18, 20, 24]);

let cursor = 20;
cursor = text(MARGIN, cursor, '2.5D TASK 4A  DECOUPLED SHADOW ASSETS', 3);
cursor = text(
  MARGIN,
  cursor,
  `VARIANT ${shadows.variant}  FRAME ${frameWidth}X${frameHeight}  MAT ${shadows.totals.matShadows}  STACK ${shadows.totals.wallStacks}  MASKS ${seams.totals.masks}`,
  2,
);
cursor = text(
  MARGIN,
  cursor,
  'COMPOSITE: SOURCE-OVER BLACK, ALPHA = MEASURED OCCLUSION (DEST X (1 - A))',
  2,
);

// ---------------------------------------------------------------------- A
const composites = {};
cursor = text(MARGIN, cursor + 8, 'A. MAT SHADOW UNDER BODY, DRAWN AT THE SAME ANCHOR', 3);
let gridTop = cursor + 8;
for (let index = 0; index < buckets.length; index += 1) {
  const bucket = buckets[index];
  const column = index % 4;
  const row = Math.floor(index / 4);
  const x = MARGIN + column * CELL.width;
  const y = gridTop + row * CELL.height;
  const blank = blanks.blanks[bucket];
  composites[bucket] = drawTileCell(x, y, bucket, blank.anchor);
  const record = shadows.matShadows[bucket];
  let lineY = y + VIEW.height + 6;
  lineY = text(x, lineY, bucket.toUpperCase(), 2);
  lineY = text(
    x,
    lineY,
    `PEAK ${record.alpha.peakAlpha.toFixed(2)} SUP ${record.alpha.supportPx} GND ${record.grounded ? '1' : '0'}`,
    2,
  );
}

// ---------------------------------------------------------------------- B
cursor = gridTop + bucketRows * CELL.height + 12;
cursor = text(MARGIN, cursor, 'B. WALL STACK PASS: LAYER 0 + DECAL + LAYER 1', 3);
let sectionTop = cursor + 8;
const stackSeats = ['north', 'south', 'east', 'west'];
for (let index = 0; index < stackSeats.length; index += 1) {
  const seat = stackSeats[index];
  const record = shadows.wallStack.seats[seat];
  const lowSlot = slots.get(record.layer0);
  const highSlot = slots.get(record.layer1);
  const x = MARGIN + index * CELL.width;
  const y = sectionTop;
  const anchorX = lowSlot.anchor.x * layout.referenceResolution.width;
  const anchorY = lowSlot.anchor.y * layout.referenceResolution.height;
  const left = clampOrigin(Math.round(anchorX - VIEW.width / 2), VIEW.width, board.width);
  const top = clampOrigin(Math.round(anchorY - VIEW.height / 2), VIEW.height, board.height);
  const view = cropBoard(left, top, VIEW.width, VIEW.height);
  const low = downsample2(load(resolve(tableDir, 'blanks'), `${lowSlot.bucket}.png`));
  const high = downsample2(load(resolve(tableDir, 'blanks'), `${highSlot.bucket}.png`));
  const decal = downsample2(load(resolve(tableDir, 'shadows'), record.textureFile.split('/').pop()));
  const drawAt = (slot, image, pivot) =>
    drawSprite(
      view,
      image,
      Math.round(slot.anchor.x * layout.referenceResolution.width - left - pivot.x / pixelRatio),
      Math.round(slot.anchor.y * layout.referenceResolution.height - top - pivot.y / pixelRatio),
    );
  drawAt(lowSlot, low, blanks.blanks[lowSlot.bucket].pivot);
  drawSprite(
    view,
    decal,
    Math.round(anchorX - left - record.pivot.x / pixelRatio),
    Math.round(anchorY - top - record.pivot.y / pixelRatio),
  );
  drawAt(highSlot, high, blanks.blanks[highSlot.bucket].pivot);
  drawSprite(sheet, view, x, y);
  let lineY = y + VIEW.height + 6;
  lineY = text(x, lineY, `${seat.toUpperCase()} ${record.bucket.toUpperCase()}`, 2);
  text(x, lineY, `PEAK ${record.alpha.peakAlpha.toFixed(2)} MEAN ${record.alpha.meanAlpha.toFixed(2)}`, 2);
}

// ---------------------------------------------------------------------- C
cursor = sectionTop + stackRows * CELL.height + 12;
cursor = text(MARGIN, cursor, 'C. CREVICE MASKS: FADE FROM THE OUTER BEVEL EDGE', 3);
sectionTop = cursor + 8;
const edges = ['left', 'right', 'top', 'bottom'];
for (let index = 0; index < edges.length; index += 1) {
  const edge = edges[index];
  const record = seams.seams[edge];
  const image = load(resolve(tableDir, 'shadows'), record.textureFile.split('/').pop());
  const y = sectionTop + index * 170;
  let lineY = text(MARGIN, y, `${edge.toUpperCase()} EDGE`, 2);
  lineY = text(
    MARGIN,
    lineY,
    `OUTER ${record.measured.edgeAlpha.toFixed(2)} @ ${(record.measured.fadeFractionOfTileWidth * 100).toFixed(1)}% W`,
    2,
  );
  text(MARGIN, lineY, `${record.axis.toUpperCase()} AXIS ${record.side.toUpperCase()}`, 2);
  // A native-resolution crop of the fade band over a mid grey so the alpha reads.
  const band = { width: 160, height: 160, channels: 4, data: Buffer.alloc(160 * 160 * 4, 255), stride: 160 * 4 };
  for (let py = 0; py < band.height; py += 1) {
    for (let px = 0; px < band.width; px += 1) {
      const sx = record.axis === 'u' ? px : px + 160;
      const sy = record.axis === 'u' ? py + 160 : py;
      const i = (sy * image.width + sx) * 4;
      const alpha = image.data[i + 3] / 255;
      const grey = Math.round(120 * (1 - alpha));
      const out = (py * band.width + px) * 4;
      band.data[out] = grey;
      band.data[out + 1] = grey;
      band.data[out + 2] = grey;
      band.data[out + 3] = 255;
    }
  }
  drawSprite(sheet, band, MARGIN + 180, y);
  // The profile: alpha against distance from that edge, 0 to 25 % of the axis.
  const plotX = MARGIN + 180 + 170;
  const plotWidth = 480;
  const plotHeight = 150;
  const span = Math.round(image.height * 0.25);
  fillRect(plotX, y, plotWidth, plotHeight, [36, 38, 44]);
  for (let px = 0; px < span; px += 1) {
    const mid = Math.floor(image.width / 2);
    const sx = record.axis === 'u' ? px : mid;
    const sy = record.axis === 'u' ? mid : px;
    const alpha = image.data[(sy * image.width + sx) * 4 + 3] / 255;
    const barX = plotX + Math.round((px / span) * (plotWidth - 2));
    const barTop = y + plotHeight - 1 - Math.round(alpha * (plotHeight - 2));
    for (let py = barTop; py < y + plotHeight; py += 1) {
      const target = (py * sheet.width + barX) * 4;
      sheet.data[target] = 235;
      sheet.data[target + 1] = 235;
      sheet.data[target + 2] = 240;
      sheet.data[target + 3] = 255;
    }
  }
  drawText(sheet, `0..25% OF ${record.axis.toUpperCase()} AXIS`, plotX, y + plotHeight + 4, { scale: 2 });
}

// ------------------------------------------------------------------ publish
mkdirSync(outDir, { recursive: true });
const sheetPath = resolve(outDir, 'task4a-contact-sheet.png');
writeFileSync(sheetPath, encodePng(sheet.width, sheet.height, 4, sheet.data));

const numbers = {
  generatedBy: 'tools/render/scripts/review-shadow-assets.mjs',
  variant: shadows.variant,
  frame: shadows.frame,
  composite: shadows.composite,
  buckets: Object.fromEntries(
    buckets.map((bucket) => [
      bucket,
      {
        anchor: blanks.blanks[bucket].anchor,
        composite: composites[bucket],
        shadow: {
          textureFile: shadows.matShadows[bucket].textureFile,
          pivot: shadows.matShadows[bucket].pivot,
          width: shadows.matShadows[bucket].width,
          height: shadows.matShadows[bucket].height,
          peakAlpha: shadows.matShadows[bucket].alpha.peakAlpha,
          supportPx: shadows.matShadows[bucket].alpha.supportPx,
          grounded: shadows.matShadows[bucket].grounded,
          groundDropUnits: shadows.matShadows[bucket].groundDropUnits,
        },
      },
    ]),
  ),
  wallStack: {
    perSeat: shadows.wallStack.perSeat,
    seatAgreement: shadows.wallStack.seatAgreement,
    seats: Object.fromEntries(
      Object.entries(shadows.wallStack.seats).map(([seat, record]) => [
        seat,
        {
          textureFile: record.textureFile,
          anchor: record.anchor,
          peakAlpha: record.alpha.peakAlpha,
          meanAlpha: record.alpha.meanAlpha,
        },
      ]),
    ),
  },
  seams: Object.fromEntries(
    Object.entries(seams.seams).map(([edge, record]) => [
      edge,
      {
        textureFile: record.textureFile,
        edgeAlpha: record.measured.edgeAlpha,
        fadeAxisFraction: record.measured.fadeAxisFraction,
        fadeFractionOfTileWidth: record.measured.fadeFractionOfTileWidth,
        monotonic: record.measured.monotonic,
      },
    ]),
  ),
};
const numbersPath = resolve(outDir, 'task4a-numbers.json');
writeFileSync(numbersPath, `${JSON.stringify(numbers, null, 2)}\n`);
for (const [bucket, record] of Object.entries(composites)) {
  console.log(
    `[brightness] ${bucket.padEnd(20)} shadow ${String(record.shadowPx).padStart(5)} px ` +
      `mean drop ${record.meanLumaDrop.toFixed(2)} luma, outside max ${record.maxLumaDropOutside.toFixed(2)}`,
  );
}
console.log(`[review] ${sheet.width}x${sheet.height} -> ${sheetPath}`);
console.log(`[review] numbers -> ${numbersPath}`);
