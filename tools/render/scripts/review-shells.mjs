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
 *   - `shells-row-1x.png`       all six shells in catalogue order, on the felt base
 *   - `discard-row-1x.png`      6-tile discard row + an isolated tile, then a
 *                               riichi (sideways) tile in a row
 *   - `discard-row-zoom4x.png`  nearest-neighbour 4x of the discard seams
 *   - `wall-stack-1x.png`       two-tier wall stack plus both side-wall columns
 *   - `wall-stack-zoom4x.png`   nearest-neighbour 4x of a stack seam
 *   - `each-4x-<shell>.png`     every shell at 4x, transparent margins included
 *
 * Draw order follows the architecture: horizontal rows right-to-left, wall
 * stacks bottom tier before top tier. The background is the felt's base colour
 * (not the felt raster), so shadow contrast is easy to see.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drawSprite, encodePng, readPng, zoomNearest } from './png.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = outIndex >= 0 ? resolve(args[outIndex + 1]) : join(renderDir, 'build', 'review');

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const shellSpec = await readJson(join(renderDir, 'shell-spec.json'));
const feltSpec = await readJson(join(renderDir, 'felt-spec.json'));
const manifest = await readJson(join(renderDir, shellSpec.outputs.manifest));
const tableDir = resolve(renderDir, dirname(shellSpec.outputs.manifest));

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

function draw(id, target, gridX, gridY) {
  const entry = manifest.shells[id];
  drawSprite(target, texture(id), Math.round(gridX - entry.anchorX), Math.round(gridY - entry.anchorY));
}

function write(name, image) {
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
// 1. Every shell in a row, with gaps, so each silhouette is reviewable.
// --------------------------------------------------------------------------- //
{
  const ids = shellSpec.shells.map((shell) => shell.id);
  const gap = 24;
  const width = ids.reduce((sum, id) => sum + manifest.shells[id].texWidth + gap, gap);
  const height = Math.max(...ids.map((id) => manifest.shells[id].texHeight)) + 2 * gap;
  const image = canvas(width, height);
  let x = gap;
  for (const id of ids) {
    draw(id, image, x, gap);
    x += manifest.shells[id].texWidth + gap;
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
{
  const upright = manifest.shells.shell_flat_upright;
  const sideways = manifest.shells.shell_flat_sideways;
  const pad = 24;
  const width = Math.ceil(pad * 2 + 10 * upright.advanceWidth + sideways.advanceWidth + 15);
  const height = Math.ceil(pad * 3 + 2 * upright.advanceHeight + sideways.advanceHeight);
  const image = canvas(width, height);
  const rowY = (index) => pad + index * (upright.advanceHeight + pad);

  // Rows advance by the physical tile width (gridStepPx.x), so neighbours touch
  // with no felt showing between their bodies.
  const uprightStep = upright.gridStepPx.x[0];
  const sidewaysStep = sideways.gridStepPx.y[0];

  // Row 1: six touching tiles, then a 15 px gap, then an isolated tile. Drawn
  // right-to-left: the left tile's right shadow must fall on its right
  // neighbour's left bevel.
  const continuity = [];
  for (let index = 0; index < 6; index += 1) {
    continuity.push(['shell_flat_upright', pad + index * uprightStep]);
  }
  continuity.push(['shell_flat_upright', pad + 6 * uprightStep + 15]);
  for (const [id, gridX] of [...continuity].reverse()) draw(id, image, gridX, rowY(0));

  // Row 2: a riichi / called tile rotated 90°, extrusion and shadow still
  // down-right. A sideways tile advances by its long (height) axis.
  const riichiRow = [];
  let x = pad;
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
  const riichiY = rowY(1) + upright.advanceHeight - sideways.advanceHeight;
  for (const [id, gridX] of [...riichiRow].reverse()) draw(id, image, gridX, riichiY);

  write('discard-row-1x.png', image);
  zoomOf(
    image,
    pad - 2,
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
  const seamFaceX = pad + uprightStep + 2;
  const interiorFaceX = pad + uprightStep + 14;
  console.log(
    `INFO discard seam: neighbour face edge luma ${lumaAt(seamFaceX, rowY(0) + upright.advanceHeight * 0.5).toFixed(1)} ` +
      `vs its interior ${lumaAt(interiorFaceX, rowY(0) + upright.advanceHeight * 0.5).toFixed(1)}`,
  );
  console.log(
    `INFO isolated tile shadow luma ${lumaAt(pad + 6 * uprightStep + 15 + uprightStep + 3, rowY(0) + upright.advanceHeight - 2).toFixed(1)} ` +
      `vs bare felt ${lumaAt(feltX, rowY(0) + upright.advanceHeight - 2).toFixed(1)}`,
  );
}

// --------------------------------------------------------------------------- //
// 3. Two-tier wall stack (bottom tier first, then the top tier) and the side
//    wall columns, which advance vertically.
// --------------------------------------------------------------------------- //
{
  const wall = manifest.shells.shell_wall_horizontal;
  const leftWall = manifest.shells.shell_wall_side_left;
  const rightWall = manifest.shells.shell_wall_side_right;
  const pad = 24;
  const stack = 8;
  const wallStepX = wall.gridStepPx.x[0];
  const wallStepY = Math.abs(wall.gridStepPx.y[1]);
  const tierOffset = Math.round(wallStepY) - 10; // review placement: 10 px of the lower tier shows
  const width = Math.ceil(2 * pad + stack * wallStepX + leftWall.advanceWidth + rightWall.advanceWidth + pad);
  const sideRuns = 3;
  const leftStep = leftWall.gridStepPx.y[1]; // published step already points down
  const rightStep = rightWall.gridStepPx.y[1];
  const height = Math.ceil(
    Math.max(
      2 * pad + tierOffset + wall.advanceHeight,
      pad + sideRuns * leftStep + leftWall.advanceHeight + pad,
    ),
  );
  const image = canvas(width, height);

  for (let index = stack - 1; index >= 0; index -= 1) {
    draw('shell_wall_horizontal', image, pad + index * wallStepX, pad + tierOffset);
  }
  for (let index = stack - 1; index >= 0; index -= 1) {
    draw('shell_wall_horizontal', image, pad + index * wallStepX, pad);
  }

  // Side-wall columns step along the tile's long axis, top-of-screen first.
  const leftX = pad + stack * wallStepX + pad;
  const rightX = leftX + leftWall.advanceWidth + pad;
  for (let index = 0; index < sideRuns; index += 1) {
    draw('shell_wall_side_left', image, leftX, pad + index * leftStep);
    draw('shell_wall_side_right', image, rightX, pad + index * rightStep);
  }

  write('wall-stack-1x.png', image);
  zoomOf(
    image,
    pad + 2 * wallStepX - 8,
    pad - 4,
    3 * wallStepX + 16,
    tierOffset + wall.advanceHeight + 8,
    4,
    'wall-stack-zoom4x.png',
  );
}

console.log('');
console.log(`felt base colour ${feltR},${feltG},${feltB} (from felt-spec.json)`);
console.log('draw order: horizontal rows right-to-left; wall bottom tier before the top tier');
