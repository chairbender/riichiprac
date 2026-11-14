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
 * Draw order follows the architecture: horizontal rows right-to-left, wall
 * stacks bottom tier before top tier. The background is the felt's base colour
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
import { drawSprite, encodePng, readPng, zoomNearest } from './png.mjs';
import { drawText, wrapText } from './label-font.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = outIndex >= 0 ? resolve(args[outIndex + 1]) : join(renderDir, 'build', 'review');
const auditionMode = args.includes('--audition');

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
if (!auditionMode) {
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
if (!auditionMode) {
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
// 3. Wall stacks: two tiles per column, the upper tier at the published
//    stackStepPx, plus face-up dora tiles on top of the revealed stacks.
// --------------------------------------------------------------------------- //
if (!auditionMode) {
  const wall = manifest.shells.shell_wall_horizontal;
  const leftWall = manifest.shells.shell_wall_side_left;
  const rightWall = manifest.shells.shell_wall_side_right;
  const pad = 24;
  const run = 6;
  const sideRun = 4;
  const wallStepX = wall.gridStepPx.x[0];
  const wallRise = Math.abs(wall.stackStepPx[1]);
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
  const sideTop = pad + wallRise + wall.advanceHeight + pad;
  const sideHeight = (sideRun - 1) * Math.abs(columns[0].step[1]) + leftWall.advanceHeight;
  const width = Math.ceil(pad + run * wallStepX + pad + columns.reduce((sum, c) => sum + c.span + pad, 0));
  const height = Math.ceil(sideTop + sideHeight + pad);
  const image = canvas(width, height);
  const wallTop = pad + wallRise;
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

  // Horizontal wall: right-to-left; bottom tier, then the top tier. The fourth
  // stack from the left is a revealed dora indicator (face-up top tile).
  for (let index = run - 1; index >= 0; index -= 1) {
    const x = pad + index * wallStepX;
    assertInside('shell_wall_horizontal', x, wallTop, `wall ${index} bottom`);
    draw('shell_wall_horizontal', image, x, wallTop);
    const topId = index === 3 ? 'shell_wall_horizontal_faceup' : 'shell_wall_horizontal';
    assertInside(topId, x + wall.stackStepPx[0], wallTop + wall.stackStepPx[1], `wall ${index} top`);
    draw(topId, image, x + wall.stackStepPx[0], wallTop + wall.stackStepPx[1]);
  }
  console.log(
    `INFO wall stack: horizontal rise ${wall.stackStepPx[1]} px (projected thickness), 2 tiers`,
  );

  // Side-wall columns: top-of-screen first, bottom tier then top tier per
  // stack. The second stack in each column is a dora indicator.
  let cursorX = pad + run * wallStepX + pad;
  columns.forEach((column) => {
    const drift = Math.abs((sideRun - 1) * column.step[0]);
    const originX = cursorX + (column.step[0] < 0 ? drift : 0) + 4;
    for (let index = 0; index < sideRun; index += 1) {
      const x = originX + index * column.step[0];
      const y = sideTop + index * column.step[1];
      assertInside(column.id, x, y, `${column.id} ${index} bottom`);
      draw(column.id, image, x, y);
      const topId = index === 1 ? column.dora : column.id;
      assertInside(topId, x + column.entry.stackStepPx[0], y + column.entry.stackStepPx[1], `${column.id} ${index} top`);
      draw(topId, image, x + column.entry.stackStepPx[0], y + column.entry.stackStepPx[1]);
    }
    console.log(
      `INFO ${column.id}: column step ${column.step.map((value) => value.toFixed(2)).join(',')} px, ` +
        `stack rise ${column.entry.stackStepPx[1]} px`,
    );
    cursorX += column.span + pad;
  });

  write('wall-stack-1x.png', image);
  zoomOf(
    image,
    pad + 3 * wallStepX - 10,
    wallTop - 6,
    2 * wallStepX + 20,
    wallRise + wall.advanceHeight + 12,
    4,
    'wall-stack-zoom4x.png',
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
      `1X ${bytes.toFixed(1)}K B`,
      ...(record.stackStepPx ? [`RISE ${record.stackStepPx[1]} PX`] : []),
    ];
  };

  const LABEL_WIDTH = 220;
  const LABEL_LINE = 16;
  const LABEL_HEIGHT = LABEL_LINE * 9;
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
    drawText(image, `${baseId.toUpperCase()}  CANDIDATE MATRIX`, MARGIN, cursor, {
      scale: 3,
      rgb: [244, 238, 220],
    });
    cursor += HEADER_TITLE;
    drawText(
      image,
      `BASE LONG AXIS ${base.targetLongAxisPx1x} PX @1X / ${base.targetLongAxisPx2x} PX @2X ` +
        `(PHASE 1 ${base.previousTargetLongAxisPx1x} / ${base.previousTargetLongAxisPx1x * base.pixelRatio})`,
      MARGIN,
      cursor,
      { scale: 2, rgb: [176, 200, 186] },
    );
    cursor += HEADER_BASE;
    for (const line of plan.lines) {
      drawText(image, line, MARGIN, cursor, { scale: 2, rgb: [214, 220, 190] });
      cursor += HEADER_LINE;
    }
    drawText(
      image,
      'TILES ARE COMPOSED WITH THIS CANDIDATE OWN GRIDSTEPPX; ROWS RIGHT-TO-LEFT, ROWS TOP-TO-BOTTOM',
      MARGIN,
      cursor,
      { scale: 1, rgb: [150, 168, 156] },
    );
    return cursor + HEADER_GAP;
  }

  function label(image, row, x, y) {
    fillRect(image, x, y, LABEL_WIDTH, LABEL_HEIGHT, [10, 22, 17]);
    const lines = labelLines(row);
    lines.forEach((line, index) => {
      drawText(image, line, x + 8, y + 6 + index * LABEL_LINE, {
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
        label(image, row, x, top);
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
        label(image, row, MARGIN, y);
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
  console.log('draw order: horizontal rows right-to-left; wall bottom tier before the top tier');
}
