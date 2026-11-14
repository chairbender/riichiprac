/**
 * Scripted geometry dump for the Phase 3 board layout.
 *
 *   cd frontend && npm run layout:dump
 *
 * It lays out a worst-case full board with the real `shells.json` and:
 *
 *   1. asserts the geometry (zone containment/disjointness, anchor mapping,
 *      hand pitch and tsumo gap, pond wrap, Riichi advance, wall tiers,
 *      draw order, uniform pond size, viewport fitting);
 *   2. writes `tools/render/build/review/layout-dump.json` with every placement
 *      and the derived numbers;
 *   3. writes `tools/render/build/review/layout-preview.svg`, a labelled
 *      geometry diagram: solid rectangles are advance (body) boxes at their
 *      grid positions, dots are the sprite draw origins (`grid - anchor`), and
 *      outlines are the declared zones. It is not a rendering and not visual
 *      evidence: AGENTS.md §6 leaves any visual judgement to the user.
 *
 * The script exits non-zero on a failed assertion, so it is a CI gate.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FELT_RUNTIME,
  MAX_WALL_PAIRS_PER_SIDE,
  POND_COLUMNS,
  POND_ROWS,
  SEAT_SIDES,
  boardMetrics,
  boardToCss,
  fitBoardToViewport,
  layoutBoard,
} from '../src/table/boardLayout';
import type {
  BoardLayout,
  BoardLayoutInput,
  BoardRect,
  PondDiscardInput,
  TilePlacement,
} from '../src/table/boardLayout';
import { parseShellsManifest } from '../src/table/shellManifest';
import type { TileFaceId } from '../src/table/tiles';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const tableDir = resolve(scriptDir, '../public/table');
const outDir = resolve(scriptDir, '../../tools/render/build/review');

const shells = parseShellsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')),
);
const metrics = boardMetrics(shells);
const flat = shells.shells.shell_flat_upright;
const sideways = shells.shells.shell_flat_sideways;
const standing = shells.shells.shell_hand_standing;

const failures: string[] = [];
let checks = 0;

function check(condition: boolean, message: string): void {
  checks += 1;
  if (!condition) failures.push(message);
}

function close(actual: number, expected: number, epsilon = 1e-6): boolean {
  return Math.abs(actual - expected) <= epsilon;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

const FACES: readonly TileFaceId[] = [
  '1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m',
  '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p',
  '1s', '2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s',
  '1z', '2z', '3z', '4z', '5z', '6z', '7z',
];

function pond(offset: number, riichiIndex: number): PondDiscardInput[] {
  return Array.from({ length: POND_COLUMNS * POND_ROWS }, (_value, index) => ({
    face: FACES[(offset + index) % FACES.length],
    riichi: index === riichiIndex,
  }));
}

const input: BoardLayoutInput = {
  hand: FACES.slice(0, 13),
  draw: '5p',
  ponds: {
    bottom: pond(0, 3),
    right: pond(9, 8),
    top: pond(18, 14),
    left: pond(27, 0),
  },
  wallPairsPerSide: MAX_WALL_PAIRS_PER_SIDE,
};
const layout: BoardLayout = layoutBoard(shells, input);
const counts = layout.counts;

function right(rect: BoardRect): number {
  return rect.x + rect.width;
}
function bottom(rect: BoardRect): number {
  return rect.y + rect.height;
}
function contains(outer: BoardRect, inner: BoardRect, epsilon = 1e-6): boolean {
  return (
    inner.x >= outer.x - epsilon &&
    inner.y >= outer.y - epsilon &&
    right(inner) <= right(outer) + epsilon &&
    bottom(inner) <= bottom(outer) + epsilon
  );
}
function overlaps(left: BoardRect, rightRect: BoardRect, epsilon = 1e-6): boolean {
  return (
    left.x < right(rightRect) - epsilon &&
    rightRect.x < right(left) - epsilon &&
    left.y < bottom(rightRect) - epsilon &&
    rightRect.y < bottom(left) - epsilon
  );
}

// --- board and zones ---------------------------------------------------------
const boardRect: BoardRect = { x: 0, y: 0, ...metrics.board };
const zones = [
  { name: 'hand', rect: metrics.zones.hand },
  { name: 'reserve', rect: metrics.zones.reserve },
  ...SEAT_SIDES.map((side) => ({ name: `pond-${side}`, rect: metrics.zones.ponds[side] })),
  ...SEAT_SIDES.map((side) => ({ name: `wall-${side}`, rect: metrics.zones.walls[side] })),
];
for (const zone of zones) {
  check(contains(boardRect, zone.rect), `${zone.name} is inside the board`);
}
for (let left = 0; left < zones.length; left += 1) {
  for (let rightIndex = left + 1; rightIndex < zones.length; rightIndex += 1) {
    check(
      !overlaps(zones[left].rect, zones[rightIndex].rect),
      `${zones[left].name} does not overlap ${zones[rightIndex].name}`,
    );
  }
}

// --- anchor mapping and body bounds -----------------------------------------
check(layout.placements.length === counts.hand + counts.draw + counts.ponds + counts.walls, 'counts add up');
for (const placement of layout.placements) {
  const shell = shells.shells[placement.shell];
  check(
    close(placement.drawX, placement.gridX - shell.anchorX),
    `${placement.id} drawX = gridX - anchorX`,
  );
  check(
    close(placement.drawY, placement.gridY - shell.anchorY),
    `${placement.id} drawY = gridY - anchorY`,
  );
  check(
    placement.advanceRect.width === shell.advanceWidth &&
      placement.advanceRect.height === shell.advanceHeight &&
      placement.advanceRect.x === placement.gridX &&
      placement.advanceRect.y === placement.gridY,
    `${placement.id} advance rect is the opaque body`,
  );
  const zone =
    placement.zone === 'hand'
      ? metrics.zones.hand
      : placement.zone === 'pond'
        ? metrics.zones.ponds[placement.seat]
        : metrics.zones.walls[placement.seat];
  check(contains(zone, placement.advanceRect), `${placement.id} body is inside its zone`);
  check(contains(boardRect, placement.advanceRect), `${placement.id} body is inside the board`);
}

// --- hand -------------------------------------------------------------------
const handTiles = layout.placements
  .filter((placement) => placement.kind === 'hand')
  .sort((left, rightTile) => left.gridX - rightTile.gridX);
const draw = layout.placements.find((placement) => placement.kind === 'draw');
check(handTiles.length === 13, 'hand has 13 concealed tiles');
check(draw !== undefined, 'hand has a drawn tile');
for (let index = 1; index < handTiles.length; index += 1) {
  check(
    close(handTiles[index].gridX - handTiles[index - 1].gridX, standing.advanceWidth),
    'hand pitch is advanceWidth',
  );
}
if (draw) {
  check(
    close(
      draw.gridX - handTiles[handTiles.length - 1].gridX,
      standing.advanceWidth + 0.35 * standing.advanceWidth,
    ),
    'tsumo gap is 0.35 * advanceWidth before the drawn tile',
  );
}
const lastPlacedTile = draw ?? handTiles[handTiles.length - 1];
check(
  close(
    handTiles[0].gridX - metrics.zones.hand.x,
    right(metrics.zones.hand) - right(lastPlacedTile.advanceRect),
  ),
  'hand is centred in its zone',
);

// --- ponds ------------------------------------------------------------------
for (const side of SEAT_SIDES) {
  const cells: TilePlacement[] = Array.from({ length: POND_COLUMNS * POND_ROWS }, (_value, index) => {
    const placement = layout.placements.find((candidate) => candidate.id === `${side}-pond:${index}`);
    if (!placement) throw new Error(`missing ${side}-pond:${index}`);
    return placement;
  });
  const frame = metrics.ponds[side];
  for (let index = 1; index < cells.length; index += 1) {
    const column = index % POND_COLUMNS;
    if (column !== 0) {
      const deltaX = cells[index].gridX - cells[index - 1].gridX;
      const deltaY = cells[index].gridY - cells[index - 1].gridY;
      check(
        frame.axis === 'horizontal'
          ? close(deltaX, cells[index - 1].shell === 'shell_flat_sideways'
              ? frame.sidewaysAlongAdvancePx
              : frame.alongPitchPx)
          : close(deltaY, cells[index - 1].shell === 'shell_flat_sideways'
              ? frame.sidewaysAlongAdvancePx
              : frame.alongPitchPx),
        `${side} pond pitch after tile ${index - 1} matches the shell`,
      );
      check(
        frame.axis === 'horizontal' ? close(deltaY, 0) : close(deltaX, 0),
        `${side} pond stays in its row`,
      );
    } else {
      check(
        frame.axis === 'horizontal'
          ? close(cells[index].gridX, frame.originX)
          : close(cells[index].gridY, frame.originY),
        `${side} pond wraps to the row origin after 6 columns`,
      );
      check(
        frame.axis === 'horizontal'
          ? close(cells[index].gridY - cells[index - 1].gridY, frame.awayPitchPx * frame.awayY)
          : close(cells[index].gridX - cells[index - 1].gridX, frame.awayPitchPx * frame.awayX),
        `${side} pond steps one row toward the compass`,
      );
    }
  }
  for (const cell of cells) {
    check(contains(metrics.zones.ponds[side], cell.advanceRect), `${cell.id} is inside its pond zone`);
    if (cell.shell === 'shell_flat_sideways') {
      check(
        cell.advanceRect.width === sideways.advanceWidth &&
          cell.advanceRect.height === sideways.advanceHeight,
        `${cell.id} uses the sideways advance box`,
      );
    } else {
      check(
        cell.shell === 'shell_flat_upright' &&
          cell.advanceRect.width === flat.advanceWidth &&
          cell.advanceRect.height === flat.advanceHeight,
        `${cell.id} uses the uniform upright advance box`,
      );
    }
  }
  const sidewaysCount = cells.filter((cell) => cell.shell === 'shell_flat_sideways').length;
  check(sidewaysCount === 1, `${side} pond has exactly one Riichi tile`);
}

// --- walls ------------------------------------------------------------------
for (const side of SEAT_SIDES) {
  const lower = Array.from({ length: MAX_WALL_PAIRS_PER_SIDE }, (_value, index) =>
    layout.placements.find((candidate) => candidate.id === `${side}-wall:lower:${index}`),
  );
  const upper = Array.from({ length: MAX_WALL_PAIRS_PER_SIDE }, (_value, index) =>
    layout.placements.find((candidate) => candidate.id === `${side}-wall:upper:${index}`),
  );
  check(lower.every((placement) => placement !== undefined), `${side} has a lower tier`);
  check(upper.every((placement) => placement !== undefined), `${side} has an upper tier`);
  for (let index = 0; index < MAX_WALL_PAIRS_PER_SIDE; index += 1) {
    const lowerTile = lower[index]!;
    const upperTile = upper[index]!;
    check(close(upperTile.gridX - lowerTile.gridX, 0), `${side} wall tier dx = 0`);
    check(
      close(upperTile.gridY - lowerTile.gridY, -metrics.wallTierStepPx[side]),
      `${side} wall tier dy = -wallStepY`,
    );
    check(lowerTile.drawOrder < upperTile.drawOrder, `${side} lower tier paints first`);
    check(
      contains(metrics.zones.walls[side], lowerTile.advanceRect) &&
        contains(metrics.zones.walls[side], upperTile.advanceRect),
      `${side} wall tiles stay in the wall zone`,
    );
  }
  const expectedShell =
    side === 'top' || side === 'bottom'
      ? 'shell_wall_horizontal'
      : side === 'left'
        ? 'shell_wall_side_left'
        : 'shell_wall_side_right';
  check(lower[0]!.shell === expectedShell, `${side} wall uses ${expectedShell}`);
}

// --- draw order -------------------------------------------------------------
const orders = layout.placements.map((placement) => placement.drawOrder);
check(new Set(orders).size === orders.length, 'draw order is unique');
check(orders.every((order, index) => order === index), 'draw order is contiguous from 0');
const lastTopWall = Math.max(
  ...layout.placements
    .filter((placement) => placement.seat === 'top' && placement.zone === 'wall')
    .map((placement) => placement.drawOrder),
);
const firstSideWall = Math.min(
  ...layout.placements
    .filter(
      (placement) =>
        placement.zone === 'wall' && (placement.seat === 'left' || placement.seat === 'right'),
    )
    .map((placement) => placement.drawOrder),
);
const firstPond = Math.min(
  ...layout.placements.filter((placement) => placement.zone === 'pond').map((placement) => placement.drawOrder),
);
const lastPond = Math.max(
  ...layout.placements.filter((placement) => placement.zone === 'pond').map((placement) => placement.drawOrder),
);
const firstBottomWall = Math.min(
  ...layout.placements
    .filter((placement) => placement.seat === 'bottom' && placement.zone === 'wall')
    .map((placement) => placement.drawOrder),
);
const firstHand = Math.min(
  ...layout.placements.filter((placement) => placement.zone === 'hand').map((placement) => placement.drawOrder),
);
check(lastTopWall < firstSideWall, 'top wall paints before the side walls');
check(firstSideWall < firstPond, 'side walls paint before the ponds');
check(lastPond < firstBottomWall, 'ponds paint before the bottom wall');
check(firstBottomWall < firstHand, 'bottom wall paints before the hand');

// --- viewport fitting -------------------------------------------------------
const viewports = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
  { width: 844, height: 390 },
];
const fits = viewports.map((viewport) => {
  const fit = fitBoardToViewport(viewport, metrics.board);
  const cssWidth = metrics.board.width * fit.scale;
  const cssHeight = metrics.board.height * fit.scale;
  check(fit.scale > 0, `fit at ${viewport.width}x${viewport.height} has a positive scale`);
  check(cssWidth <= viewport.width + 1e-9, `board width fits ${viewport.width}x${viewport.height}`);
  check(cssHeight <= viewport.height + 1e-9, `board height fits ${viewport.width}x${viewport.height}`);
  check(
    close(fit.offsetX, (viewport.width - cssWidth) / 2) &&
      close(fit.offsetY, (viewport.height - cssHeight) / 2),
    `board is centred at ${viewport.width}x${viewport.height}`,
  );
  const topLeft = boardToCss(fit, { x: 0, y: 0 });
  check(close(topLeft.x, fit.offsetX) && close(topLeft.y, fit.offsetY), 'boardToCss maps the origin');
  return {
    viewport,
    scale: Number(fit.scale.toFixed(4)),
    offsetX: Number(fit.offsetX.toFixed(2)),
    offsetY: Number(fit.offsetY.toFixed(2)),
    cssBoard: {
      width: Number(cssWidth.toFixed(2)),
      height: Number(cssHeight.toFixed(2)),
    },
    cssTile: {
      width: Number((flat.advanceWidth * fit.scale).toFixed(2)),
      height: Number((flat.advanceHeight * fit.scale).toFixed(2)),
    },
  };
});

// --- write the artifacts ----------------------------------------------------
mkdirSync(outDir, { recursive: true });

const numbers = {
  board: metrics.board,
  felt: {
    runtime: FELT_RUNTIME,
    rationale:
      '100% 100% stretch keeps the baked vignette at the real screen edges at every aspect ratio; cover would crop it in portrait. The felt is a separate full-screen raster, not part of the board transform.',
  },
  zones: metrics.zones,
  metrics: {
    hand: metrics.hand,
    ponds: Object.fromEntries(
      SEAT_SIDES.map((side) => [
        side,
        {
          axis: metrics.ponds[side].axis,
          alongPitchPx: metrics.ponds[side].alongPitchPx,
          awayPitchPx: metrics.ponds[side].awayPitchPx,
          sidewaysAlongAdvancePx: metrics.ponds[side].sidewaysAlongAdvancePx,
          zone: metrics.ponds[side].zone,
        },
      ]),
    ),
    wallTierStepPx: metrics.wallTierStepPx,
    wall: metrics.wall,
  },
  counts,
  wallPairsPerSide: layout.wallPairsPerSide,
  fits,
  riichiAdvance: {
    horizontalPx: Math.abs(sideways.gridStepPx.y[0]),
    verticalPx: Math.abs(sideways.gridStepPx.x[1]),
    sidewaysAdvanceBox: {
      width: sideways.advanceWidth,
      height: sideways.advanceHeight,
    },
    note: 'Tight-row advance from gridStepPx, not the 54 px advanceWidth: a tight row must not open a 2 px felt gap. Phase 1 baseline §8.4 / tools/render/README.md.',
  },
  handTsumoGapPx: metrics.hand.tsumoGapPx,
  rounding: 'coordinates are rounded to 1e-3 here for readability; the engine keeps full precision',
  placements: layout.placements.map((placement) => ({
    ...placement,
    gridX: round3(placement.gridX),
    gridY: round3(placement.gridY),
    drawX: round3(placement.drawX),
    drawY: round3(placement.drawY),
    advanceRect: {
      x: round3(placement.advanceRect.x),
      y: round3(placement.advanceRect.y),
      width: placement.advanceRect.width,
      height: placement.advanceRect.height,
    },
    bodyRect: {
      x: round3(placement.bodyRect.x),
      y: round3(placement.bodyRect.y),
      width: placement.bodyRect.width,
      height: placement.bodyRect.height,
    },
  })),
};

writeFileSync(join(outDir, 'layout-dump.json'), `${JSON.stringify(numbers, null, 2)}\n`);

// Geometry diagram. Not visual evidence; see AGENTS.md §6.
const scale = 2;
const pad = 24;
const width = metrics.board.width * scale + pad * 2;
const height = metrics.board.height * scale + pad * 2;
const zoneColors: Record<string, string> = {
  hand: '#2f6b4f',
  reserve: '#5d5a44',
  'pond-bottom': '#24505f',
  'pond-top': '#24505f',
  'pond-left': '#24505f',
  'pond-right': '#24505f',
  'wall-top': '#3b3f52',
  'wall-bottom': '#3b3f52',
  'wall-left': '#3b3f52',
  'wall-right': '#3b3f52',
};
const tileColors: Record<string, string> = {
  hand: '#8fc9a8',
  draw: '#b7e0c8',
  discard: '#9fc7d6',
  'wall-lower': '#9a9cb0',
  'wall-upper': '#c2c4d6',
};
const svg: string[] = [];
svg.push(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
);
svg.push(`<rect width="${width}" height="${height}" fill="#1a5038"/>`);
svg.push(
  `<text x="${pad}" y="${pad - 8}" fill="#e8dfc8" font-family="system-ui, sans-serif" font-size="13">` +
    `Phase 3 layout geometry: ${metrics.board.width} x ${metrics.board.height} board px; ` +
    `${layout.placements.length} placements (${counts.hand} hand, ${counts.draw} draw, ${counts.ponds} discards, ${counts.walls} wall tiles). ` +
    `Solid = advance box at grid; dot = sprite draw origin (grid - anchor). Diagram, not a render.</text>`,
);
svg.push(`<g transform="translate(${pad} ${pad}) scale(${scale})">`);
for (const zone of zones) {
  svg.push(
    `<rect x="${zone.rect.x}" y="${zone.rect.y}" width="${zone.rect.width}" height="${zone.rect.height}" ` +
      `fill="${zoneColors[zone.name] ?? '#333'}" fill-opacity="0.16" stroke="${zoneColors[zone.name] ?? '#777'}" stroke-width="0.6" stroke-dasharray="${
        zone.name === 'reserve' ? '4 3' : '2 2'
      }"/>`,
  );
}
for (const placement of layout.placements) {
  const fill = tileColors[placement.kind] ?? '#999';
  svg.push(
    `<rect x="${placement.gridX.toFixed(2)}" y="${placement.gridY.toFixed(2)}" ` +
      `width="${placement.advanceRect.width}" height="${placement.advanceRect.height}" ` +
      `fill="${fill}" fill-opacity="0.88" stroke="#1d2a24" stroke-width="0.35"/>`,
  );
  const cx = placement.gridX + placement.advanceRect.width / 2;
  const cy = placement.gridY + placement.advanceRect.height / 2;
  const label = placement.face === 'blank' ? '' : placement.face;
  if (label) {
    svg.push(
      `<text x="${cx.toFixed(2)}" y="${(cy + 2.6).toFixed(2)}" text-anchor="middle" ` +
        `font-family="system-ui, sans-serif" font-size="6" fill="#14201a">${label}</text>`,
    );
  }
  svg.push(
    `<circle cx="${placement.drawX.toFixed(2)}" cy="${placement.drawY.toFixed(2)}" r="0.7" fill="#f2c14e"/>`,
  );
}
svg.push(`</g>`);
svg.push(
  `<text x="${pad}" y="${height - 8}" fill="#9fb8a8" font-family="system-ui, sans-serif" font-size="11">` +
    `zones: ${zones
      .map((zone) => `${zone.name} ${zone.rect.x.toFixed(1)},${zone.rect.y.toFixed(1)} ${zone.rect.width.toFixed(1)}x${zone.rect.height.toFixed(1)}`)
      .join(' | ')}</text>`,
);
svg.push('</svg>');
writeFileSync(join(outDir, 'layout-preview.svg'), `${svg.join('\n')}\n`);

// --- report -----------------------------------------------------------------
console.log(`layout checks: ${checks}, failures: ${failures.length}`);
for (const failure of failures) console.log(`FAIL ${failure}`);
console.log('');
console.log(`board ${metrics.board.width} x ${metrics.board.height} board px (@1x CSS px)`);
console.log('zones:');
for (const zone of zones) {
  console.log(
    `  ${zone.name.padEnd(12)} x ${zone.rect.x.toFixed(2).padStart(7)} y ${zone.rect.y
      .toFixed(2)
      .padStart(7)}  ${zone.rect.width.toFixed(2).padStart(7)} x ${zone.rect.height
      .toFixed(2)
      .padStart(7)}`,
  );
}
console.log(
  `hand: pitch ${metrics.hand.pitchPx} px, tsumo gap ${metrics.hand.tsumoGapPx.toFixed(2)} px`,
);
for (const side of SEAT_SIDES) {
  const frame = metrics.ponds[side];
  console.log(
    `pond ${side.padEnd(6)} ${frame.axis.padEnd(10)} along ${frame.alongPitchPx.toFixed(2)} px, away ${frame.awayPitchPx.toFixed(2)} px, riichi advance ${frame.sidewaysAlongAdvancePx.toFixed(2)} px`,
  );
}
console.log(
  `walls: horizontal tier ${metrics.wallTierStepPx.top.toFixed(3)} px, side tier ${metrics.wallTierStepPx.left.toFixed(3)}/${metrics.wallTierStepPx.right.toFixed(3)} px, pitches ${metrics.wall.pitchPx.horizontal.toFixed(2)}/${metrics.wall.pitchPx.vertical.toFixed(2)} px, ${layout.wallPairsPerSide} pairs a side`,
);
for (const fit of fits) {
  console.log(
    `fit ${fit.viewport.width}x${fit.viewport.height}: scale ${fit.scale}, board ${fit.cssBoard.width}x${fit.cssBoard.height} css px at ${fit.offsetX},${fit.offsetY}, tile ${fit.cssTile.width}x${fit.cssTile.height} css px`,
  );
}
console.log(
  `placements: ${layout.placements.length} (hand ${counts.hand}, draw ${counts.draw}, discards ${counts.ponds}, walls ${counts.walls})`,
);
console.log(`dump:    ${join(outDir, 'layout-dump.json')}`);
console.log(`preview: ${join(outDir, 'layout-preview.svg')}`);
console.log(
  'AGENTS.md §6: the SVG is a geometry diagram for the user to review, not agent visual evidence.',
);

if (failures.length > 0) process.exitCode = 1;
