#!/usr/bin/env node
/**
 * Minimal tile-map shadow test, with no shell re-render.
 *
 *   node tools/render/scripts/preview-shadow-tilemap.mjs --id shell_flat_upright --count 13
 *
 * It takes the single-tile shadow sprite from `preview-shadow.mjs`, slices it
 * into three pieces at the tile pitch:
 *
 *   left   = sprite x [0 .. anchor + cell]      (left overhang + first cell)
 *   middle = sprite x [anchor .. anchor + cell] (exactly one cell)
 *   right  = sprite x [anchor .. sprite width]  (last cell + right overhang)
 *
 * and lays left + (count - 2) middles + right edge-to-edge, then draws the
 * bodies on top. It also renders the true per-tile shadow union (all full
 * sprites, per-pixel max) for a numeric comparison of the seams.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drawSprite, drawSpriteMax, encodePng, readPng, zoomNearest } from './png.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const id = option('--id', 'shell_flat_upright');
const count = Number(option('--count', '13'));
const outDir = resolve(option('--out', join(renderDir, 'build', 'preview')));

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const spec = await readJson(join(renderDir, 'shell-spec.json'));
const manifestPath = join(renderDir, spec.outputs.manifest);
const manifest = await readJson(manifestPath);
const tableDir = resolve(dirname(manifestPath));
const shell = manifest.shells[id];
if (!shell) throw new Error(`shells.json has no ${id}`);

const lying = shell.shadowBlob?.lying === true;
const pads = lying
  ? spec.bake.shadow.padding1x
  : spec.bake.shadow.standingPadding1x ?? spec.bake.shadow.padding1x;
const body = readPng(resolve(tableDir, shell.textureFile));
const shadowPath = resolve(outDir, `shadow-${id}-sprite.png`);
const shadow = readPng(shadowPath);
const step = Number(option('--step', Math.abs(shell.gridStepPx.x[0])));
const cell = Math.round(step);
const anchor = pads.left;
const leftWidth = anchor + cell;
const middleWidth = cell;
const rightWidth = shadow.width - anchor;

function slice(image, x0, x1) {
  const width = x1 - x0;
  const data = Buffer.alloc(width * image.height * 4);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = (y * image.width + x0 + x) * 4;
      image.data.copy(data, (y * width + x) * 4, source, source + 4);
    }
  }
  return { width, height: image.height, channels: 4, data, stride: width * 4 };
}

const left = slice(shadow, 0, leftWidth);
const middle = slice(shadow, anchor, anchor + middleWidth);
const right = slice(shadow, anchor, shadow.width);

// Union-period pieces: one period of max(S(x), S(x - cell), ...), so the
// middle's left and right edges are identical and the pieces really marry.
const WINDOW = 5;
const unionCanvas = (width) => ({
  width,
  height: shadow.height,
  channels: 4,
  stride: width * 4,
  data: Buffer.alloc(width * shadow.height * 4),
});
const unionWindow = unionCanvas(WINDOW * middleWidth + shadow.width);
for (let index = 0; index < WINDOW; index += 1) {
  drawSpriteMax(unionWindow, shadow, index * middleWidth, 0);
}
const unionMiddle = slice(unionWindow, anchor + 2 * middleWidth, anchor + 3 * middleWidth);
const unionLeft = slice(unionWindow, 0, anchor + middleWidth);
const rightWindow = unionCanvas(shadow.width);
for (let index = 0; index < WINDOW; index += 1) {
  drawSpriteMax(rightWindow, shadow, -index * middleWidth, 0);
}
const unionRight = slice(rightWindow, anchor, shadow.width);

const [fr, fg, fb] = (await readJson(join(renderDir, 'felt-spec.json'))).baseColor;
const pad = 24;
const sheetWidth = 2 * pad + left.width + (count - 2) * middle.width + right.width;
const sheetHeight = 2 * pad + Math.max(shadow.height, body.height);
const feltCanvas = () => {
  const image = {
    width: sheetWidth,
    height: sheetHeight,
    channels: 4,
    stride: sheetWidth * 4,
    data: Buffer.alloc(sheetWidth * sheetHeight * 4),
  };
  for (let i = 0; i < sheetWidth * sheetHeight; i += 1) {
    image.data[i * 4] = fr;
    image.data[i * 4 + 1] = fg;
    image.data[i * 4 + 2] = fb;
    image.data[i * 4 + 3] = 255;
  }
  return image;
};
const transparent = () => ({
  width: sheetWidth,
  height: sheetHeight,
  channels: 4,
  stride: sheetWidth * 4,
  data: Buffer.alloc(sheetWidth * sheetHeight * 4),
});

const bodyAnchor = [shell.anchorX, shell.anchorY];
const firstGrid = pad + anchor;
const lastGrid = firstGrid + (count - 1) * cell;

// Tile map: left + middles + right, edge-to-edge.
const tileMap = feltCanvas();
const tileMapShadow = transparent();
drawSprite(tileMapShadow, left, pad, pad);
for (let index = 1; index < count - 1; index += 1) {
  drawSprite(tileMapShadow, middle, firstGrid + index * cell, pad);
}
drawSprite(tileMapShadow, right, lastGrid, pad);
drawSprite(tileMap, tileMapShadow, 0, 0);
for (let index = 0; index < count; index += 1) {
  drawSprite(tileMap, body, firstGrid + index * cell - bodyAnchor[0], pad + pads.top - bodyAnchor[1]);
}

// True union: every full shadow, per-pixel max.
const trueUnion = feltCanvas();
const trueUnionShadow = transparent();
for (let index = 0; index < count; index += 1) {
  drawSpriteMax(trueUnionShadow, shadow, firstGrid + index * cell - anchor, pad);
}
drawSprite(trueUnion, trueUnionShadow, 0, 0);
for (let index = 0; index < count; index += 1) {
  drawSprite(trueUnion, body, firstGrid + index * cell - bodyAnchor[0], pad + pads.top - bodyAnchor[1]);
}

// Union-period tile map: same row geometry, seamless pieces.
const unionTileMap = feltCanvas();
const unionTileMapShadow = transparent();
drawSprite(unionTileMapShadow, unionLeft, pad, pad);
for (let index = 1; index < count - 1; index += 1) {
  drawSprite(unionTileMapShadow, unionMiddle, firstGrid + index * cell, pad);
}
drawSprite(unionTileMapShadow, unionRight, lastGrid, pad);
drawSprite(unionTileMap, unionTileMapShadow, 0, 0);
for (let index = 0; index < count; index += 1) {
  drawSprite(unionTileMap, body, firstGrid + index * cell - bodyAnchor[0], pad + pads.top - bodyAnchor[1]);
}

mkdirSync(outDir, { recursive: true });
const write = (name, image) => {
  const path = join(outDir, name);
  const bytes = encodePng(image.width, image.height, image.channels, image.data);
  writeFileSync(path, bytes);
  console.log(`${path}  ${image.width}x${image.height}  ${bytes.length} B`);
};
write(`tilemap-${id}-${count}-1x.png`, tileMap);
write(`tilemap-${id}-${count}-true-union-1x.png`, trueUnion);
write(`tilemap-${id}-${count}-union-1x.png`, unionTileMap);
const zoomWidth = Math.min(540, sheetWidth - pad);
const zoomHeight = Math.min(330, sheetHeight - pad);
write(`tilemap-${id}-${count}-3x.png`, zoomNearest(tileMap, pad - 4, pad - 4, zoomWidth, zoomHeight, 3));
write(
  `tilemap-${id}-${count}-union-3x.png`,
  zoomNearest(unionTileMap, pad - 4, pad - 4, zoomWidth, zoomHeight, 3),
);

// Numeric seam report: alpha difference of the shadow-only layers, plus the
// max adjacent luma step across each internal cell boundary.
const alphaOf = (image) =>
  Array.from({ length: image.width * image.height }, (_, index) => image.data[index * 4 + 3] / 255);
const unionAlpha = alphaOf(trueUnionShadow);
function compareShadow(label, image) {
  const candidate = alphaOf(image);
  let sum = 0;
  let max = 0;
  let over = 0;
  let samples = 0;
  for (let i = 0; i < candidate.length; i += 1) {
    if (candidate[i] < 2 / 255 && unionAlpha[i] < 2 / 255) continue;
    const delta = Math.abs(candidate[i] - unionAlpha[i]);
    sum += delta;
    max = Math.max(max, delta);
    if (delta > 0.02) over += 1;
    samples += 1;
  }
  console.log(
    `  ${label}: alpha vs true union mean ${(sum / Math.max(1, samples)).toFixed(4)}, ` +
      `max ${max.toFixed(4)}, ${over}/${samples} px over 0.02`,
  );
}
const lumaAt = (image, x, y) => {
  const i = (Math.round(y) * image.width + Math.round(x)) * 4;
  return 0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2];
};
const seamY = pad + pads.top + shell.advanceHeight + 12;
function seamReport(label, image) {
  const seams = [];
  for (let index = 1; index < count; index += 1) {
    const x = firstGrid + index * cell;
    seams.push(
      `${lumaAt(image, x - 1, seamY).toFixed(1)}/${lumaAt(image, x, seamY).toFixed(1)}`,
    );
  }
  console.log(`  ${label} seam luma (left/right): ${seams.join('  ')}`);
}
console.log(
  `TILEMAP ${id}: ${count} tiles, step ${step.toFixed(2)} px (cell ${cell}), ` +
    `simple ${left.width}+${middle.width}x${count - 2}+${right.width} px`,
);
compareShadow('simple slices', tileMapShadow);
compareShadow('union-period slices', unionTileMapShadow);
seamReport('simple', tileMap);
seamReport('union-period', unionTileMap);
seamReport('true union', trueUnion);
