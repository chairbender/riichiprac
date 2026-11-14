/**
 * Phase 4 review boards and the scripted verification for the painter's
 * algorithm renderer.
 *
 *   cd frontend && npm run board:review
 *   cd frontend && npm run board:review -- --write-fixture
 *
 * It builds the real startup atlas with a Node Canvas 2D backend, loads the
 * committed felt, lays out the deterministic full table fixture, and:
 *
 *   1. runs the four architecture §5 checks with printed numbers:
 *      - shadow continuity (six-tile row, the sixth separated by the tsumo gap)
 *      - the 3-row pond crease
 *      - the sideways Riichi tile's down-right shadow
 *      - the two-tier wall overlap;
 *   2. checks the committed paint-order fixture and the full-screen felt at six
 *      viewport sizes;
 *   3. writes review boards under `tools/render/build/review/` (gitignored):
 *      desktop and mobile @1x, a desktop @2x, and three 3x zooms, plus
 *      `board-numbers.json`.
 *
 * AGENTS.md §6: the PNGs are for the user to open and judge. This script only
 * asserts numbers and prints them; it never narrates what an image looks like.
 *
 * It exits non-zero on a failed assertion, so it is a CI gate.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { Canvas as NapiCanvas } from '@napi-rs/canvas';
import {
  MAX_WALL_PAIRS_PER_SIDE,
  layoutBoard,
} from '../src/table/boardLayout';
import type { PaintableBoard, TilePlacement } from '../src/table/boardLayout';
import { paintOrderSnapshot, renderBoard } from '../src/table/boardRenderer';
import type { PaintOrderEntry } from '../src/table/boardRenderer';
import { TileAtlas } from '../src/table/TileAtlas';
import { parseFacesManifest } from '../src/table/faceManifest';
import { parseShellsManifest } from '../src/table/shellManifest';
import { TileAtlasBuilder } from '../src/table/TileAtlasBuilder';
import type { AtlasCanvas, AtlasImage } from '../src/table/TileAtlasBuilder';
import { SHELL_IDS, tileRenderKey } from '../src/table/tiles';
import type { TileFaceId } from '../src/table/tiles';
import { FIXTURE_FACES, fullBoardLayout } from '../src/table/fixtures/fullBoard';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const tableDir = resolve(scriptDir, '../public/table');
const outDir = resolve(scriptDir, '../../tools/render/build/review');
const fixturePath = resolve(scriptDir, '../src/table/fixtures/paint-order.json');
const writeFixture = process.argv.includes('--write-fixture');

const shells = parseShellsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')),
);
const faces = parseFacesManifest(JSON.parse(readFileSync(join(tableDir, 'faces.json'), 'utf8')));
const felt = (await loadImage(readFileSync(join(tableDir, 'felt.png')))) as unknown as
  CanvasImageSource;

function makeAtlas(pixelRatio: 1 | 2): Promise<TileAtlas> {
  const builder = new TileAtlasBuilder({
    shells,
    faces,
    resolveUrl: (relativePath) => join(tableDir, relativePath),
    loadImage: async (url) => (await loadImage(readFileSync(url))) as unknown as AtlasImage,
    createCanvas: (width, height) => createCanvas(width, height) as unknown as AtlasCanvas,
    pixelRatio,
  });
  return new TileAtlas(builder, shells, faces).warm(SHELL_IDS);
}

const atlas1x = await makeAtlas(1);
const atlas2x = await makeAtlas(2);

type Canvas = NapiCanvas;

const failures: string[] = [];
const results: Array<Record<string, unknown>> = [];

function assert(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function contextOf(canvas: Canvas): CanvasRenderingContext2D {
  return canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
}

interface Region {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
}

function region(canvas: Canvas, x: number, y: number, width: number, height: number): Region {
  const ix = Math.max(0, Math.round(x));
  const iy = Math.max(0, Math.round(y));
  const iw = Math.max(1, Math.min(Math.round(width), canvas.width - ix));
  const ih = Math.max(1, Math.min(Math.round(height), canvas.height - iy));
  return {
    data: contextOf(canvas).getImageData(ix, iy, iw, ih).data,
    width: iw,
    height: ih,
    x: ix,
    y: iy,
  };
}

function pixelLuma(data: Uint8ClampedArray, index: number): number {
  return 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
}

function meanLuma(canvas: Canvas, x: number, y: number, width: number, height: number): number {
  const { data } = region(canvas, x, y, width, height);
  let total = 0;
  for (let index = 0; index < data.length; index += 4) total += pixelLuma(data, index);
  return total / (data.length / 4);
}

function meanLumaOfRegion(value: Region): number {
  let total = 0;
  for (let index = 0; index < value.data.length; index += 4) {
    total += pixelLuma(value.data, index);
  }
  return total / (value.data.length / 4);
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function renderToCanvas(
  board: PaintableBoard,
  width: number,
  height: number,
  pixelRatio: number,
  atlas: TileAtlas,
): { canvas: Canvas; stats: ReturnType<typeof renderBoard> } {
  const canvas = createCanvas(width, height);
  const stats = renderBoard(contextOf(canvas), atlas, board, { felt, pixelRatio });
  return { canvas, stats };
}

/** Render the board at exactly 1 board px = 1 canvas px. */
function renderAtOneToOne(board: PaintableBoard): Canvas {
  const { canvas } = renderToCanvas(board, board.board.width, board.board.height, 1, atlas1x);
  return canvas;
}

function placementsById(board: PaintableBoard): Map<string, TilePlacement> {
  return new Map(board.placements.map((placement) => [placement.id, placement]));
}

mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// Check 1: shadow continuity. Five tight blank tiles plus the drawn blank tile
// after the real 13.3 px tsumo gap. One sprite must serve all six. For every
// seam, the same board is rendered again without the left tile, so the 4 px
// band immediately right of its body is the *same* pixels with and without the
// overhang: the difference is the baked shadow, and nothing else.
//
// Blank faces keep the body a uniform ivory, so the numbers are the shadow, not
// glyph ink.
// ---------------------------------------------------------------------------
{
  const blanks = (count: number): TileFaceId[] => Array.from({ length: count }, () => 'blank');
  const board = layoutBoard(shells, { hand: blanks(5), draw: 'blank', wallPairsPerSide: 0 });
  const canvas = renderAtOneToOne(board);
  const row = board.placements
    .filter((placement) => placement.seat === 'bottom' && placement.zone === 'hand')
    .sort((left, right) => left.gridX - right.gridX);
  assert(row.length === 6, 'shadow check: the row has six tiles');

  const without = (id: string): PaintableBoard => ({
    board: board.board,
    placements: board.placements
      .filter((placement) => placement.id !== id)
      .map((placement, index) => ({ ...placement, drawOrder: index })),
  });

  const seams: Array<Record<string, unknown>> = [];
  const bandOf = (target: Canvas, x: number, y: number) => region(target, x, y, 4, 30);

  for (let index = 0; index < 4; index += 1) {
    const left = row[index];
    const next = row[index + 1];
    const seamX = left.gridX + left.advanceRect.width;
    const y = next.gridY + 12;
    assert(Math.abs(seamX - next.gridX) < 1e-6, `shadow check: seam ${index} abuts the next body`);

    const baseline = renderAtOneToOne(without(left.id));
    const shadowed = bandOf(canvas, seamX, y);
    const bare = bandOf(baseline, seamX, y);
    let differing = 0;
    for (let pixel = 0; pixel < shadowed.data.length; pixel += 4) {
      if (shadowed.data[pixel] !== bare.data[pixel]) differing += 1;
    }
    const total = shadowed.data.length / 4;
    const shadowMean = meanLumaOfRegion(shadowed);
    const bareMean = meanLumaOfRegion(bare);
    assert(shadowMean < bareMean - 3, `shadow check: seam ${index} shadow lands on the next body`);
    assert(differing / total > 0.5, `shadow check: seam ${index} covers the next body`);
    seams.push({
      seam: index,
      overhangX: round(seamX),
      overlapsBody: true,
      shadowLuma: round(shadowMean),
      samePixelsWithoutNeighbour: round(bareMean),
      darkerBy: round(bareMean - shadowMean),
      changedFraction: round(differing / total, 3),
    });
  }

  // Tiles 5 and 6: their 4 px overhang must hang over felt alone. The same
  // without-the-tile baseline isolates the shadow from the mottled felt.
  for (const index of [4, 5]) {
    const tile = row[index];
    const overhangX = tile.gridX + tile.advanceRect.width;
    const overlapsAnyBody = board.placements.some((placement) => {
      if (placement.id === tile.id) return false;
      const body = placement.advanceRect;
      return (
        overhangX < body.x + body.width &&
        body.x < overhangX + 4 &&
        tile.gridY + 12 < body.y + body.height &&
        body.y < tile.gridY + 42
      );
    });
    const baseline = renderAtOneToOne(without(tile.id));
    const shadowed = bandOf(canvas, overhangX, tile.gridY + 12);
    const bare = bandOf(baseline, overhangX, tile.gridY + 12);
    let differing = 0;
    for (let pixel = 0; pixel < shadowed.data.length; pixel += 4) {
      if (shadowed.data[pixel] !== bare.data[pixel]) differing += 1;
    }
    const total = shadowed.data.length / 4;
    const shadowMean = meanLumaOfRegion(shadowed);
    const bareMean = meanLumaOfRegion(bare);
    assert(!overlapsAnyBody, `shadow check: tile ${index + 1} overhang is over felt only`);
    assert(shadowMean < bareMean - 0.5, `shadow check: tile ${index + 1} still shades the felt`);
    assert(differing / total > 0.1, `shadow check: tile ${index + 1} leaves a felt shadow`);
    seams.push({
      seam: index === 4 ? 'fifth (before the gap)' : 'sixth (drawn tile)',
      overhangX: round(overhangX),
      overlapsBody: false,
      shadowLuma: round(shadowMean),
      feltLuma: round(bareMean),
      darkerBy: round(bareMean - shadowMean, 3),
      changedFraction: round(differing / total, 3),
    });
  }

  const sprites = row.map((placement) =>
    atlas1x.getSprite(tileRenderKey(placement.shell, placement.face)),
  );
  const sharedSprite = sprites.every(
    (sprite) =>
      sprite.uv.x === sprites[0].uv.x &&
      sprite.uv.y === sprites[0].uv.y &&
      sprite.uv.width === sprites[0].uv.width &&
      sprite.uv.height === sprites[0].uv.height,
  );
  assert(sharedSprite, 'shadow check: all six tiles blit the same sprite slot');
  results.push({ check: 'shadow-continuity', seams, sharedSprite });
  console.log(
    `shadow continuity: 4 seams over the next body (darker by ` +
      seams.slice(0, 4).map((seam) => seam.darkerBy).join('/') +
      ` luma, changed ${seams.map((seam) => seam.changedFraction).slice(0, 4).join('/')}); ` +
      `fifth over felt ${seams[4].darkerBy} luma (changed ${seams[4].changedFraction}), ` +
      `sixth over felt ${seams[5].darkerBy} luma (changed ${seams[5].changedFraction}); ` +
      `shared sprite ${sharedSprite}`,
  );
}

// ---------------------------------------------------------------------------
// Check 2: pond row seam. Three full rows: row 1's bottom thickness and row 2's
// top edge must be separated by a 1-4 px dark crease (the 2 px AO fringe of the
// tile painted later), not merge into one bright strip.
// ---------------------------------------------------------------------------
{
  const discards = Array.from({ length: 18 }, (_value, index) => ({
    face: FIXTURE_FACES[index % FIXTURE_FACES.length],
  }));
  const board = layoutBoard(shells, { ponds: { top: discards }, wallPairsPerSide: 0 });
  const canvas = renderAtOneToOne(board);
  const cells = Array.from({ length: 18 }, (_value, index) => {
    const placement = board.placements.find((candidate) => candidate.id === `top-pond:${index}`);
    if (!placement) throw new Error(`missing top-pond:${index}`);
    return placement;
  });

  const seams: Array<Record<string, unknown>> = [];
  for (let rowSeam = 0; rowSeam < 2; rowSeam += 1) {
    const upperRow = cells[rowSeam * 6];
    for (const column of [1, 3, 4]) {
      const cell = cells[rowSeam * 6 + column];
      const x = cell.gridX + 8;
      const width = 20;
      const face = meanLuma(canvas, x, upperRow.gridY + 12, width, 24);
      const start = Math.round(upperRow.gridY + 38);
      const values: number[] = [];
      for (let y = start; y < start + 15; y += 1) {
        values.push(meanLuma(canvas, x, y, width, 1));
      }
      let minIndex = 0;
      for (let index = 1; index < values.length; index += 1) {
        if (values[index] < values[minIndex]) minIndex = index;
      }
      const threshold = face - 12;
      let run = 1;
      for (let index = minIndex - 1; index >= 0 && values[index] < threshold; index -= 1) run += 1;
      for (let index = minIndex + 1; index < values.length && values[index] < threshold; index += 1) {
        run += 1;
      }
      const minLuma = values[minIndex];
      assert(minLuma < threshold, `row seam ${rowSeam}/${column}: crease is dark`);
      assert(run >= 1 && run <= 5, `row seam ${rowSeam}/${column}: crease is 1-4 px (${run})`);
      seams.push({
        rowSeam: rowSeam + 1,
        column,
        creaseOffsetY: minIndex + 38,
        minLuma: round(minLuma),
        faceLuma: round(face),
        darkRunPx: run,
      });
    }
  }
  const tightest = seams.reduce((lowest, seam) =>
    (seam.faceLuma as number) - (seam.minLuma as number) <
    (lowest.faceLuma as number) - (lowest.minLuma as number)
      ? seam
      : lowest,
  );
  console.log(
    `pond row seam: ${seams.length} samples; darkest crease ${tightest.minLuma} at y+${tightest.creaseOffsetY} ` +
      `(face ${tightest.faceLuma}, run ${tightest.darkRunPx} px)`,
  );
  results.push({ check: 'pond-row-seam', seams });
}

// ---------------------------------------------------------------------------
// Check 3: Riichi rotation. Only the 2D glyph is rotated, never the shell, so
// the sideways shell's baked margin must still point down-right. Proven twice:
// the atlas sprite's alpha-mass centroid (the baked margin itself) and the
// composited margins over the felt.
// ---------------------------------------------------------------------------
{
  const board = layoutBoard(shells, {
    ponds: { top: [{ face: 'blank', riichi: true }] },
    wallPairsPerSide: 0,
  });
  const tile = board.placements.find((placement) => placement.shell === 'shell_flat_sideways');
  if (!tile) throw new Error('riichi check: no sideways tile');
  const shell = shells.shells.shell_flat_sideways;
  const sprite = atlas1x.getSprite(tileRenderKey('shell_flat_sideways', 'blank'));
  const page = atlas1x.getPage(sprite);

  // The baked margin's alpha centroid, in sprite px, relative to the body box.
  const pageContext = (page.canvas as unknown as Canvas).getContext('2d');
  const spriteData = pageContext.getImageData(
    sprite.uv.x,
    sprite.uv.y,
    sprite.uv.width,
    sprite.uv.height,
  ).data;
  let alphaWeight = 0;
  let alphaX = 0;
  let alphaY = 0;
  for (let y = 0; y < sprite.uv.height; y += 1) {
    for (let x = 0; x < sprite.uv.width; x += 1) {
      const alpha = spriteData[(y * sprite.uv.width + x) * 4 + 3];
      const insideBody =
        x >= sprite.anchorX &&
        x < sprite.anchorX + sprite.advanceWidth &&
        y >= sprite.anchorY &&
        y < sprite.anchorY + sprite.advanceHeight;
      if (insideBody || alpha === 0) continue;
      alphaWeight += alpha;
      alphaX += alpha * (x - (sprite.anchorX + sprite.advanceWidth / 2));
      alphaY += alpha * (y - (sprite.anchorY + sprite.advanceHeight / 2));
    }
  }
  const spriteDx = alphaX / alphaWeight;
  const spriteDy = alphaY / alphaWeight;

  // The same margins composited over the felt: the right and bottom padding
  // carry more shadow mass than the left/top AO fringe.
  const canvas = renderAtOneToOne(board);
  const body = tile.advanceRect;
  const y = body.y + 8;
  const height = Math.round(body.height) - 16;
  const right = region(canvas, body.x + body.width, y, shell.padding.right, height);
  const left = region(canvas, body.x - shell.padding.left, y, shell.padding.left, height);
  const bottom = region(canvas, body.x + 8, body.y + body.height, Math.round(body.width) - 16, shell.padding.bottom);
  const top = region(canvas, body.x + 8, body.y - shell.padding.top, Math.round(body.width) - 16, shell.padding.top);
  const reference = meanLuma(canvas, body.x + 120, body.y, 20, body.height);
  const mass = (value: Region): number => {
    let total = 0;
    for (let index = 0; index < value.data.length; index += 4) {
      total += Math.max(0, reference - pixelLuma(value.data, index));
    }
    return total;
  };
  const rightMass = mass(right);
  const leftMass = mass(left);
  const bottomMass = mass(bottom);
  const topMass = mass(top);

  assert(spriteDx > 0.5 && spriteDy > 0.5, 'riichi check: the sprite margin centroid is down-right');
  assert(rightMass > leftMass, 'riichi check: the right margin carries more shadow than the left');
  assert(bottomMass > topMass, 'riichi check: the bottom margin carries more shadow than the top');
  console.log(
    `riichi rotation: sprite margin alpha centroid dx ${round(spriteDx)} dy ${round(spriteDy)} px; ` +
      `felt masses right ${Math.round(rightMass)} > left ${Math.round(leftMass)}, ` +
      `bottom ${Math.round(bottomMass)} > top ${Math.round(topMass)}; ` +
      `faceRotationDeg ${shell.faceRotationDeg}`,
  );
  results.push({
    check: 'riichi-rotation',
    faceRotationDeg: shell.faceRotationDeg,
    spriteMarginCentroid: { dx: round(spriteDx, 3), dy: round(spriteDy, 3) },
    feltShadowMass: {
      right: Math.round(rightMass),
      left: Math.round(leftMass),
      bottom: Math.round(bottomMass),
      top: Math.round(topMass),
    },
  });
}

// ---------------------------------------------------------------------------
// Check 4: two-tier wall overlap. The upper tile's body covers the lower tile's
// resin plate and its bottom shadow lands on the lower tile's visible strip.
// Render the stack, then the same board without the upper tile, and compare.
// ---------------------------------------------------------------------------
{
  const board = layoutBoard(shells, { wallPairsPerSide: 1 });
  const canvas = renderAtOneToOne(board);
  const byId = placementsById(board);
  const lower = byId.get('top-wall:lower:0');
  const upper = byId.get('top-wall:upper:0');
  if (!lower || !upper) throw new Error('wall check: missing wall tiles');

  const baseline: PaintableBoard = {
    board: board.board,
    placements: board.placements
      .filter((placement) => placement.id !== 'top-wall:upper:0')
      .map((placement, index) => ({ ...placement, drawOrder: index })),
  };
  const baseCanvas = renderAtOneToOne(baseline);

  const upperBodyBottom = upper.gridY + upper.advanceRect.height;
  const lowerBodyBottom = lower.gridY + lower.advanceRect.height;
  const coveredLowerBody = upperBodyBottom - lower.gridY;
  const stripTop = Math.ceil(upperBodyBottom);
  const stripHeight = Math.max(1, Math.round(lowerBodyBottom) - stripTop);
  const stripX = lower.gridX + 10;
  const stripWidth = 18;

  const stackStrip = region(canvas, stripX, stripTop, stripWidth, stripHeight);
  const baseStrip = region(baseCanvas, stripX, stripTop, stripWidth, stripHeight);
  let differing = 0;
  for (let index = 0; index < stackStrip.data.length; index += 1) {
    if (stackStrip.data[index] !== baseStrip.data[index]) differing += 1;
  }
  const differingFraction = differing / stackStrip.data.length;
  const stackMean = meanLumaOfRegion(stackStrip);
  const baseMean = meanLumaOfRegion(baseStrip);

  assert(upper.drawOrder > lower.drawOrder, 'wall check: the upper tile paints after the lower');
  assert(
    coveredLowerBody > 0.85 * lower.advanceRect.height,
    'wall check: the upper body covers the lower resin plate',
  );
  assert(stripHeight >= 3 && stripHeight <= 6, 'wall check: the visible lower strip is the tier step');
  assert(differingFraction > 0.3, 'wall check: the upper shadow paints over the lower strip');
  assert(stackMean < baseMean - 2, 'wall check: the upper shadow darkens the lower strip');
  console.log(
    `wall overlap: tier dy ${round(upper.gridY - lower.gridY)} px, upper body covers ` +
      `${round(coveredLowerBody)} of ${lower.advanceRect.height} px; visible strip ${stripHeight} px ` +
      `luma ${round(stackMean)} (without upper ${round(baseMean)}), differing ` +
      `${round(differingFraction * 100, 1)}%`,
  );
  results.push({
    check: 'wall-overlap',
    tierDy: round(upper.gridY - lower.gridY, 3),
    coveredLowerBody: round(coveredLowerBody, 3),
    visibleStripPx: stripHeight,
    stripLuma: { stacked: round(stackMean), lowerOnly: round(baseMean) },
    differingFraction: round(differingFraction, 3),
  });
}

// ---------------------------------------------------------------------------
// Full-board fixture: the committed draw-order snapshot, plus the numbers.
// ---------------------------------------------------------------------------
const full = fullBoardLayout(shells);
const snapshot = paintOrderSnapshot(full);
{
  const fixture = {
    generatedBy: 'frontend/scripts/render-board.ts',
    board: full.board,
    placementCount: full.placements.length,
    counts: full.counts,
    order: snapshot,
  };
  if (writeFixture) {
    writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`paint order: wrote fixture ${fixturePath}`);
  } else {
    const committed = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      order: PaintOrderEntry[];
      placementCount: number;
      board: { width: number; height: number };
    };
    assert(committed.placementCount === full.placements.length, 'fixture: placement count');
    assert(
      committed.board.width === full.board.width && committed.board.height === full.board.height,
      'fixture: board size',
    );
    assert(
      JSON.stringify(committed.order) === JSON.stringify(snapshot),
      'fixture: draw order matches the committed snapshot',
    );
  }
  console.log(
    `paint order: ${snapshot.length} tiles, first ${snapshot[0].id}, last ${snapshot[snapshot.length - 1].id}, ` +
      `counts ${JSON.stringify(full.counts)}`,
  );
  results.push({
    check: 'paint-order',
    placements: snapshot.length,
    counts: full.counts,
    first: snapshot[0],
    last: snapshot[snapshot.length - 1],
  });
}

// ---------------------------------------------------------------------------
// Full-screen felt at multiple viewports.
// ---------------------------------------------------------------------------
{
  const viewports = [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 1440, height: 900 },
    { width: 320, height: 480 },
    { width: 1024, height: 768 },
    { width: full.board.width, height: full.board.height },
  ];
  const fits: Array<Record<string, unknown>> = [];
  for (const viewport of viewports) {
    const { canvas, stats } = renderToCanvas(
      full,
      viewport.width,
      viewport.height,
      1,
      atlas1x,
    );
    const all = region(canvas, 0, 0, viewport.width, viewport.height);
    let transparent = 0;
    for (let index = 3; index < all.data.length; index += 4) {
      if (all.data[index] !== 255) transparent += 1;
    }
    const corner = meanLuma(canvas, 0, 0, 4, 4);
    const handTile = full.placements.find(
      (placement) => placement.seat === 'bottom' && placement.kind === 'hand',
    )!;
    const screenX = stats.fit.offsetX + (handTile.gridX + handTile.advanceRect.width / 2) * stats.fit.scale;
    const screenY = stats.fit.offsetY + (handTile.gridY + handTile.advanceRect.height / 2) * stats.fit.scale;
    const face = meanLuma(canvas, screenX - 2, screenY - 2, 4, 4);
    assert(transparent === 0, `viewport ${viewport.width}x${viewport.height}: felt covers every pixel`);
    assert(face > corner + 30, `viewport ${viewport.width}x${viewport.height}: tiles sit over the felt`);
    fits.push({
      viewport,
      scale: round(stats.fit.scale, 4),
      offsetX: round(stats.fit.offsetX),
      offsetY: round(stats.fit.offsetY),
      cssBoard: {
        width: round(full.board.width * stats.fit.scale),
        height: round(full.board.height * stats.fit.scale),
      },
      tilePx: {
        width: round(handTile.advanceRect.width * stats.fit.scale),
        height: round(handTile.advanceRect.height * stats.fit.scale),
      },
      cornerLuma: round(corner),
      handLuma: round(face),
      transparentPixels: transparent,
    });
    console.log(
      `viewport ${String(viewport.width).padStart(4)}x${String(viewport.height).padEnd(4)}: ` +
        `scale ${round(stats.fit.scale, 4)}, tile ${round(handTile.advanceRect.width * stats.fit.scale)}x` +
        `${round(handTile.advanceRect.height * stats.fit.scale)} css px, corner luma ${round(corner)}, ` +
        `hand luma ${round(face)}, transparent ${transparent}`,
    );
  }
  results.push({ check: 'viewports', fits });
}

// ---------------------------------------------------------------------------
// Review boards: @1x desktop/mobile, a @2x board and three zooms.
// ---------------------------------------------------------------------------
const artifacts: Array<Record<string, unknown>> = [];

function saveCanvas(fileName: string, canvas: Canvas, label: string): void {
  const file = join(outDir, fileName);
  writeFileSync(file, canvas.toBuffer('image/png'));
  const data = contextOf(canvas).getImageData(0, 0, canvas.width, canvas.height).data;
  const hash = createHash('sha256').update(Buffer.from(data)).digest('hex');
  artifacts.push({
    label,
    file,
    width: canvas.width,
    height: canvas.height,
    bytes: statSync(file).size,
    decodedRgbaSha256: hash,
  });
  console.log(
    `board: ${file} (${canvas.width}x${canvas.height}, ${statSync(file).size} B, ${label})`,
  );
}

for (const [name, label, viewport, pixelRatio, atlas] of [
  ['board-desktop-1440x900-1x.png', 'desktop @1x', { width: 1440, height: 900 }, 1, atlas1x],
  ['board-mobile-390x844-1x.png', 'mobile @1x', { width: 390, height: 844 }, 1, atlas1x],
  ['board-desktop-1440x900-2x.png', 'desktop @2x', { width: 1440, height: 900 }, 2, atlas2x],
] as const) {
  const { canvas } = renderToCanvas(full, viewport.width, viewport.height, pixelRatio, atlas);
  saveCanvas(name, canvas, label);
}

{
  // One 3x render of the whole board, cropped into three review zooms.
  const zoom = 3;
  const { canvas } = renderToCanvas(
    full,
    full.board.width * zoom,
    full.board.height * zoom,
    zoom,
    atlas2x,
  );
  const crops: Array<{ name: string; label: string; x: number; y: number; width: number; height: number }> = [
    { name: 'board-zoom-top-wall.png', label: 'zoom: top hand + two-tier top wall', x: 40, y: 0, width: 640, height: 150 },
    { name: 'board-zoom-riichi-pond.png', label: 'zoom: bottom pond + sideways riichi', x: 230, y: 400, width: 300, height: 180 },
    { name: 'board-zoom-bottom-hand.png', label: 'zoom: bottom hand + open melds', x: 50, y: 620, width: 620, height: 84 },
  ];
  for (const crop of crops) {
    const target = createCanvas(crop.width * zoom, crop.height * zoom);
    const ctx = contextOf(target);
    ctx.drawImage(
      canvas as unknown as CanvasImageSource,
      crop.x * zoom,
      crop.y * zoom,
      crop.width * zoom,
      crop.height * zoom,
      0,
      0,
      crop.width * zoom,
      crop.height * zoom,
    );
    saveCanvas(crop.name, target, crop.label);
  }
}

const numbersFile = join(outDir, 'board-numbers.json');
writeFileSync(
  numbersFile,
  `${JSON.stringify(
    {
      generatedBy: 'frontend/scripts/render-board.ts',
      board: full.board,
      atlas: {
        pixelRatio1x: atlas1x.pixelRatio,
        sprites1x: atlas1x.sprites.size,
        pixelRatio2x: atlas2x.pixelRatio,
        sprites2x: atlas2x.sprites.size,
      },
      wallPairsPerSide: MAX_WALL_PAIRS_PER_SIDE,
      checks: results,
      artifacts,
    },
    null,
    2,
  )}\n`,
);

console.log('');
console.log(`board checks: failures ${failures.length}`);
for (const failure of failures) console.log(`FAIL ${failure}`);
console.log(`numbers: ${numbersFile}`);
if (failures.length > 0) process.exitCode = 1;
