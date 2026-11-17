/**
 * Review sheet for the rendered table (Phase 4).
 *
 *   cd frontend && npm run board:review
 *
 * Builds the real board with the committed `shells.json`, the startup atlas and
 * the Phase 3.5 contact decals, runs the real {@link TableCompositor}, and
 * writes:
 *
 *   tools/render/build/review/rendered-board-1x.png
 *     the fixture board over the committed felt at @1x (art for the user)
 *   tools/render/build/review/rendered-board-numbers.json
 *     zone/group/tile counts, painter order, group shadow sigmas and the
 *     cache results of a second identical update
 *
 * AGENTS.md §6: the PNG is evidence for the user to inspect, not for the agent
 * to sign off. The printed numbers are the scripted check.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { parseShellsManifest } from '../src/table/shellManifest';
import { parseOverlayManifest } from '../src/table/overlayManifest';
import { parseCatchesManifest } from '../src/table/catchManifest';
import { parseLyingCatchesManifest } from '../src/table/lyingCatchManifest';
import { boardGameState } from '../src/table/boardFixture';
import { buildBoard } from '../src/table/boardLayout';
import { boardImagePaths, loadBoardImages } from '../src/table/boardAssets';
import { resolveBoardContactOverlays } from '../src/table/contactOverlays';
import { TableCompositor } from '../src/table/TableCompositor';
import type { BoardCanvas } from '../src/table/TableCompositor';
import { TileAtlas } from '../src/table/TileAtlas';
import type { AtlasCanvas, AtlasImage } from '../src/table/TileAtlasBuilder';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const tableDir = resolve(scriptDir, '../public/table');
const outDir = resolve(scriptDir, '../../tools/render/build/review');

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(readFileSync(path, 'utf8'));
const asCanvas = (width: number, height: number): BoardCanvas =>
  createCanvas(width, height) as unknown as BoardCanvas;
const loadFileImage = async (url: string): Promise<AtlasImage> =>
  (await loadImage(readFileSync(url))) as unknown as AtlasImage;

const manifest = parseShellsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')),
);
const overlays = parseOverlayManifest(
  JSON.parse(readFileSync(join(tableDir, 'overlays.json'), 'utf8')),
);
const catches = parseCatchesManifest(
  JSON.parse(readFileSync(join(tableDir, 'catches.json'), 'utf8')),
);
const lyingCatches = parseLyingCatchesManifest(
  JSON.parse(readFileSync(join(tableDir, 'lying-catches.json'), 'utf8')),
);

const atlas = await TileAtlas.load({
  baseUrl: tableDir,
  fetchJson: readJson,
  loadImage: loadFileImage,
  createCanvas: (width, height) => createCanvas(width, height) as unknown as AtlasCanvas,
  pixelRatio: 1,
});

const state = boardGameState();
const board = buildBoard(manifest, state);
const zoneOverlays = resolveBoardContactOverlays(
  manifest,
  board,
  overlays,
  catches,
  lyingCatches,
);
const images = await loadBoardImages(
  boardImagePaths(board, manifest, zoneOverlays),
  new Map<string, CanvasImageSource>(),
  {
    tableBaseUrl: tableDir,
    loadImage: async (url) =>
      (await loadImage(readFileSync(url))) as unknown as CanvasImageSource,
  },
);

const destination = asCanvas(board.width, board.height);
const compositor = new TableCompositor(
  manifest,
  atlas,
  images,
  destination,
  (width, height) => createCanvas(width, height) as unknown as BoardCanvas,
);
const first = compositor.update(board, zoneOverlays);
const second = compositor.update(board, zoneOverlays);

const pixels = (destination as unknown as { getContext: (id: '2d') => { getImageData: (x: number, y: number, w: number, h: number) => { data: Uint8ClampedArray } } })
  .getContext('2d')
  .getImageData(0, 0, board.width, board.height).data;
let opaquePixels = 0;
let translucentPixels = 0;
let edgePixels = 0;
for (let y = 0; y < board.height; y += 1) {
  for (let x = 0; x < board.width; x += 1) {
    const alpha = pixels[(y * board.width + x) * 4 + 3];
    if (alpha > 250) opaquePixels += 1;
    else if (alpha > 5) translucentPixels += 1;
    if (alpha > 5 && (x < 4 || y < 4 || x >= board.width - 4 || y >= board.height - 4)) {
      edgePixels += 1;
    }
  }
}
if (edgePixels !== 0) {
  throw new Error(`rendered board clips ${edgePixels} non-transparent pixels at its edge`);
}
if (opaquePixels < 10000 || translucentPixels < 10000) {
  throw new Error(
    `rendered board looks empty: ${opaquePixels} opaque, ${translucentPixels} shadow pixels`,
  );
}

const felt = await loadImage(readFileSync(join(tableDir, 'felt.png')));
const sheet = createCanvas(board.width, board.height);
const sheetContext = sheet.getContext('2d');
sheetContext.drawImage(felt, 0, 0, board.width, board.height);
sheetContext.drawImage(destination as unknown as ReturnType<typeof createCanvas>, 0, 0);

mkdirSync(outDir, { recursive: true });
const pngPath = join(outDir, 'rendered-board-1x.png');
writeFileSync(pngPath, sheet.toBuffer('image/png'));

const tiles = board.zones.reduce(
  (total, placement) => total + placement.zone.bodies.length,
  0,
);
const shadows = board.zones.reduce(
  (total, placement) => total + placement.zone.shadows.length,
  0,
);
const numbers = {
  board: { width: board.width, height: board.height },
  zones: board.zones.map((placement) => ({
    id: placement.id,
    layer: placement.layer,
    kind: placement.zone.kind,
    side: placement.zone.side,
    x: placement.x,
    y: placement.y,
    width: placement.zone.width,
    height: placement.zone.height,
    rotationDeg: placement.zone.rotationDeg,
    bodies: placement.zone.bodies.length,
    shadows: placement.zone.shadows.length,
    drawPositionsInteger: placement.zone.bodies.every(
      (tile) => Number.isInteger(tile.drawX) && Number.isInteger(tile.drawY),
    ),
  })),
  groups: board.groups.map((group) => ({
    id: group.id,
    sigmaPx1x: group.sigmaPx1x,
    coreAlpha: group.coreAlpha,
    shapes: group.shapes.length,
    pad: group.pad,
    zones: group.zoneIds,
  })),
  totals: {
    zones: board.zones.length,
    groups: board.groups.length,
    tiles,
    shadows,
    images: images.size,
    overlayDecals: [...zoneOverlays.values()].reduce(
      (total, list) => total + list.length,
      0,
    ),
    opaquePixels,
    translucentPixels,
    edgePixels,
  },
  painterOrder: first.drawOrder,
  secondUpdate: {
    rebuiltZones: second.rebuiltZones,
    rebuiltGroups: second.rebuiltGroups,
    reusedZones: second.reusedZones,
    reusedGroups: second.reusedGroups,
  },
};
const numbersPath = join(outDir, 'rendered-board-numbers.json');
writeFileSync(numbersPath, `${JSON.stringify(numbers, null, 2)}\n`);

console.log(
  `BOARD ${board.width}x${board.height}px @1x, ${board.zones.length} zones, ` +
    `${board.groups.length} shadow groups, ${tiles} bodies, ${shadows} shadow shapes`,
);
console.log(`PAINT ORDER ${first.drawOrder.join('  ')}`);
console.log(
  `GROUPS ${board.groups
    .map((group) => `${group.id}=sigma ${group.sigmaPx1x}/${group.shapes.length}`)
    .join('  ')}`,
);
console.log(
  `SECOND UPDATE rebuilt zones ${second.rebuiltZones.length}, groups ` +
    `${second.rebuiltGroups.length} (cache holds the board)`,
);
console.log(
  `PIXELS opaque ${opaquePixels}, translucent shadow ${translucentPixels}, ` +
    `clipped at the edge ${edgePixels}`,
);
console.log(`WROTE ${pngPath}`);
console.log(`WROTE ${numbersPath}`);
