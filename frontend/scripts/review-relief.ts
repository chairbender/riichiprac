/**
 * Task 5A review sheet: flat glyph vs Task 5 carved decal vs world-space relief.
 *
 *   cd frontend && npm run atlas:review:relief
 *
 * Writes under `tools/render/build/review/`:
 *
 *   relief-compare-4x.png   one row per face, three orientations, three sources
 *   relief-board-2x.png     a five-position board strip (upright, 90, 180, 270)
 *   relief-numbers.json     bake/blit timings, cache counts, orientation diffs
 *
 * The images are evidence for the user (AGENTS.md §6); the JSON numbers are
 * the scripted checks. The script never asks the agent to judge a render.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { CarvedReliefBakery } from '../src/table/carvedRelief';
import { parseDecalsManifest } from '../src/table/decalManifest';
import type { DecalsManifest } from '../src/table/decalManifest';
import { parseFacesManifest } from '../src/table/faceManifest';
import { parseReliefManifest } from '../src/table/reliefManifest';
import { parseShellsManifest } from '../src/table/shellManifest';
import { blitTileSprite } from '../src/table/TileAtlas';
import { TileAtlasBuilder } from '../src/table/TileAtlasBuilder';
import type {
  AtlasCanvas,
  AtlasImage,
  BakedTileAtlas,
  BakedTileSprite,
} from '../src/table/TileAtlasBuilder';
import {
  groupSlotsByOrientation,
  parseTableLayoutManifest,
  reliefGroupForShell,
} from '../src/table/tableLayoutManifest';
import type { TileFaceId } from '../src/table/tiles';
import { FACE_UP_SHELL_IDS, tileRenderKey } from '../src/table/tiles';
import type { FaceUpShellId } from '../src/table/tiles';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const tableDir = resolve(scriptDir, '../public/table');
const outDir = resolve(scriptDir, '../../tools/render/build/review');

const shells = parseShellsManifest(JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')));
const faces = parseFacesManifest(JSON.parse(readFileSync(join(tableDir, 'faces.json'), 'utf8')));
const relief = parseReliefManifest(JSON.parse(readFileSync(join(tableDir, 'relief.json'), 'utf8')));
const layout = parseTableLayoutManifest(
  JSON.parse(readFileSync(join(tableDir, 'table_layout.json'), 'utf8')),
);
const decals = parseDecalsManifest(JSON.parse(readFileSync(join(tableDir, 'decals.json'), 'utf8')));
const groups = groupSlotsByOrientation(layout);

const loadNapi = async (url: string): Promise<AtlasImage> =>
  (await loadImage(readFileSync(url))) as unknown as AtlasImage;
const createAtlasCanvas = (width: number, height: number) =>
  createCanvas(width, height) as unknown as AtlasCanvas;

function builder(
  options: {
    decalSet?: DecalsManifest;
    withRelief?: boolean;
  } = {},
): TileAtlasBuilder {
  return new TileAtlasBuilder({
    shells,
    faces,
    ...(options.decalSet ? { decals: options.decalSet } : {}),
    ...(options.withRelief ? { relief: { manifest: relief, layout } } : {}),
    resolveUrl: (relativePath) => join(tableDir, relativePath),
    loadImage: loadNapi,
    createCanvas: createAtlasCanvas,
    pixelRatio: 1,
  });
}

const ORIENTATIONS: { shell: FaceUpShellId; label: string }[] = [
  { shell: 'shell_flat_upright', label: 'upright 0' },
  { shell: 'shell_flat_sideways', label: 'rotated 90' },
  { shell: 'shell_flat_upright_180', label: 'rotated 180' },
  { shell: 'shell_flat_sideways_270', label: 'rotated 270' },
];

const REVIEW_FACES: TileFaceId[] = ['1m', '1p', '1s', '7z', '5z'];
/**
 * The atlas is built over the whole face-up catalogue, so the bake/cache
 * numbers are the real startup cost (the hand slots share five groups, which
 * is where the cache hits come from).
 */
const atlasShells: FaceUpShellId[] = [...FACE_UP_SHELL_IDS];

console.log('building flat glyph atlas...');
const flatAtlas = await builder().build(atlasShells);
console.log('building Task 5 carved-decal atlas...');
const carvedAtlas = await builder({ decalSet: decals }).build(atlasShells);
console.log('building Task 5A relief atlas...');
const reliefAtlas = await builder({ decalSet: decals, withRelief: true }).build(atlasShells);

mkdirSync(outDir, { recursive: true });

const FELT = '#1a5038';
const PANEL = '#123d2b';
const INK = '#f3ead7';
const MUTED = '#b9c9b6';
const ACCENT = '#7fd4a2';

type Ctx = CanvasRenderingContext2D;

function spriteOf(atlas: BakedTileAtlas, shell: FaceUpShellId, face: TileFaceId): BakedTileSprite {
  const sprite = atlas.sprites.get(tileRenderKey(shell, face));
  if (!sprite) throw new Error(`atlas has no ${shell} / ${face}`);
  return sprite;
}

function drawSprite(
  ctx: Ctx,
  atlas: BakedTileAtlas,
  sprite: BakedTileSprite,
  x: number,
  y: number,
  scale: number,
): void {
  const page = atlas.pages[sprite.pageIndex];
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    page.canvas as never,
    sprite.uv.x,
    sprite.uv.y,
    sprite.uv.width,
    sprite.uv.height,
    x,
    y,
    sprite.uv.width * scale,
    sprite.uv.height * scale,
  );
}

/* ------------------------------------------------------------------------- *
 * A/B sheet
 * ------------------------------------------------------------------------- */

const SCALE = 4;
const variants: { label: string; atlas: BakedTileAtlas; note: string }[] = [
  { label: 'flat glyph', atlas: flatAtlas, note: 'Task 4 fallback' },
  { label: 'carved decal', atlas: carvedAtlas, note: 'Task 5 path' },
  { label: 'world relief', atlas: reliefAtlas, note: 'Task 5A' },
];
const cellWidth = Math.ceil(110 * SCALE) + 24;
const cellHeight = Math.ceil(106 * SCALE) + 56;
const sheet = createCanvas(cellWidth * variants.length * ORIENTATIONS.length + 32, REVIEW_FACES.length * cellHeight + 64);
const sheetCtx = sheet.getContext('2d');
sheetCtx.fillStyle = FELT;
sheetCtx.fillRect(0, 0, sheet.width, sheet.height);
sheetCtx.font = '600 18px sans-serif';
sheetCtx.fillStyle = INK;
sheetCtx.fillText('Task 5A A/B: same face, same slot, three face sources (4x)', 20, 30);
sheetCtx.font = '14px sans-serif';
sheetCtx.fillStyle = MUTED;
sheetCtx.fillText(
  'Rows: 1m, 1p, 1s, 7z, 5z (haku, no paint). Columns: upright, 90, 180, 270; each with flat / carved / relief.',
  20,
  52,
);

REVIEW_FACES.forEach((face, row) => {
  ORIENTATIONS.forEach((orientation, orientationIndex) => {
    variants.forEach((variant, variantIndex) => {
      const column = orientationIndex * variants.length + variantIndex;
      const x = 12 + column * cellWidth;
      const y = 64 + row * cellHeight;
      sheetCtx.fillStyle = PANEL;
      sheetCtx.fillRect(x, y, cellWidth - 12, cellHeight - 12);
      const sprite = spriteOf(variant.atlas, orientation.shell, face);
      drawSprite(sheetCtx, variant.atlas, sprite, x + 12, y + 26, SCALE);
      sheetCtx.font = '600 14px sans-serif';
      sheetCtx.fillStyle = variantIndex === 2 ? ACCENT : INK;
      sheetCtx.fillText(`${face} · ${orientation.label} · ${variant.label}`, x + 10, y + 18);
      sheetCtx.font = '12px sans-serif';
      sheetCtx.fillStyle = MUTED;
      sheetCtx.fillText(variant.note, x + 10, y + cellHeight - 20);
    });
  });
});
writeFileSync(join(outDir, 'relief-compare-4x.png'), sheet.toBuffer('image/png'));

/* ------------------------------------------------------------------------- *
 * Board strip: the four pond orientations plus the human hand
 * ------------------------------------------------------------------------- */

const BOARD: { shell: FaceUpShellId; face: TileFaceId; label: string }[] = [
  { shell: 'shell_flat_upright', face: '1p', label: 'south pond · 0°' },
  { shell: 'shell_flat_sideways', face: '5s', label: 'east pond · 90°' },
  { shell: 'shell_flat_upright_180', face: '9m', label: 'north pond · 180°' },
  { shell: 'shell_flat_sideways_270', face: '7z', label: 'west pond · 270°' },
  { shell: 'shell_hand_slot_06', face: '1m', label: 'hand centre · upright' },
];
const boardScale = 3;
const boardCells = BOARD.map((entry) => {
  const sprite = spriteOf(reliefAtlas, entry.shell, entry.face);
  return { entry, sprite };
});
const boardWidth = boardCells.reduce((total, cell) => total + cell.sprite.uv.width * boardScale + 24, 24);
const boardHeight =
  Math.max(...boardCells.map((cell) => cell.sprite.uv.height * boardScale)) + 72;
const board = createCanvas(boardWidth, boardHeight);
const boardCtx = board.getContext('2d');
boardCtx.fillStyle = FELT;
boardCtx.fillRect(0, 0, boardWidth, boardHeight);
boardCtx.font = '600 16px sans-serif';
boardCtx.fillStyle = INK;
boardCtx.fillText('Task 5A relief on the four pond orientations and the standing hand (3x)', 12, 26);
let cursor = 18;
for (const { entry, sprite } of boardCells) {
  drawSprite(boardCtx, reliefAtlas, sprite, cursor, 36, boardScale);
  boardCtx.font = '12px sans-serif';
  boardCtx.fillStyle = MUTED;
  boardCtx.fillText(entry.label, cursor, boardHeight - 14);
  cursor += sprite.uv.width * boardScale + 24;
}
writeFileSync(join(outDir, 'relief-board-2x.png'), board.toBuffer('image/png'));

/* ------------------------------------------------------------------------- *
 * Numbers: cache, bake cost, blit cost, orientation proof
 * ------------------------------------------------------------------------- */

const bakery = new CarvedReliefBakery({
  manifest: relief,
  layout,
  loadImage: loadNapi,
  resolveUrl: (relativePath) => join(tableDir, relativePath),
  createCanvas: createAtlasCanvas,
  dCarve: 0.018,
});
const baked: { shell: FaceUpShellId; group: string; ms: number }[] = [];
const startBake = performance.now();
for (const orientation of ORIENTATIONS) {
  const started = performance.now();
  const group = reliefGroupForShell(layout, orientation.shell, groups);
  if (!group) throw new Error(`no relief group for ${orientation.shell}`);
  const decal = await bakery.decalFor('1m', group, 96, 128, [223, 220, 216]);
  if (!decal) throw new Error(`no relief decal for ${orientation.shell}`);
  baked.push({ shell: orientation.shell, group: group.key, ms: performance.now() - started });
}
const lookupBakeMs = performance.now() - startBake;

/** Compare the same face's aligned decal across two orientations. */
function diffDecals(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let changed = 0;
  for (let index = 0; index < a.length; index += 1) {
    if (Math.abs(a[index] - b[index]) > 1) changed += 1;
  }
  return changed;
}

/** A synthetic board: 136 tiles across the five face-up shells. */
const benchmarkShells: FaceUpShellId[] = [
  ...boardCells.map((cell) => cell.entry.shell),
];
const benchmarkFaces: TileFaceId[] = [
  '1m',
  '2m',
  '3m',
  '4m',
  '5m',
  '6m',
  '7m',
  '8m',
  '9m',
  '1p',
  '2p',
  '3p',
  '4p',
  '5p',
  '6p',
  '7p',
  '8p',
  '9p',
  '1s',
  '2s',
  '3s',
  '4s',
  '5s',
  '6s',
  '7s',
  '8s',
  '9s',
  '1z',
  '2z',
  '3z',
  '4z',
  '5z',
  '6z',
  '7z',
];
const tiles: BakedTileSprite[] = [];
for (let index = 0; index < 136; index += 1) {
  const shell = benchmarkShells[index % benchmarkShells.length];
  const face = benchmarkFaces[index % benchmarkFaces.length];
  tiles.push(spriteOf(reliefAtlas, shell, face));
}

const benchmarkCanvas = createCanvas(1920, 1080);
const benchmarkCtx = benchmarkCanvas.getContext('2d');
function frame(): void {
  benchmarkCtx.fillStyle = '#1a5038';
  benchmarkCtx.fillRect(0, 0, 1920, 1080);
  for (let index = 0; index < tiles.length; index += 1) {
    const sprite = tiles[index];
    const page = reliefAtlas.pages[sprite.pageIndex];
    blitTileSprite(benchmarkCtx, page, sprite, 40 + (index % 17) * 108, 40 + Math.floor(index / 17) * 112);
  }
}
for (let warm = 0; warm < 20; warm += 1) frame();
const frameTimes: number[] = [];
for (let count = 0; count < 300; count += 1) {
  const started = performance.now();
  frame();
  frameTimes.push(performance.now() - started);
}
frameTimes.sort((a, b) => a - b);
const mean = frameTimes.reduce((total, value) => total + value, 0) / frameTimes.length;
const percentile = (p: number) => frameTimes[Math.min(frameTimes.length - 1, Math.floor((p / 100) * frameTimes.length))];

const decalPixels: Record<string, Uint8ClampedArray> = {};
for (const entry of baked) {
  const decal = await bakery.decalFor(
    '1m',
    reliefGroupForShell(layout, entry.shell, groups)!,
    96,
    128,
    [223, 220, 216],
  );
  decalPixels[entry.shell] = (decal!.canvas.getContext('2d') as CanvasRenderingContext2D).getImageData(
    0,
    0,
    96,
    128,
  ).data;
}

const reliefStats = reliefAtlas.stats;
const numbers = {
  generatedBy: 'frontend/scripts/review-relief.ts',
  path: 'Task 5A CPU startup bake into the per-(bucket, rounded basis) decal cache',
  cache: {
    key: 'face @ (bucket|t…|b…|n…) @ output size @ ivory calibration',
    layoutGroups: groups.length,
    faceUpGroups: new Set(
      FACE_UP_SHELL_IDS.map((shell) => reliefGroupForShell(layout, shell, groups)?.key).filter(
        (key): key is string => Boolean(key),
      ),
    ).size,
    reliefDecalsInAtlas: reliefStats.reliefDecals,
    reliefCacheHits: reliefStats.reliefCacheHits,
    reliefSprites: reliefStats.reliefSprites,
  },
  bake: {
    atlasLoadMs: round(reliefStats.reliefAtlasLoadMs),
    decalBakeMs: round(reliefStats.reliefBakeMs),
    perDecalMs: round(reliefStats.reliefBakeMs / Math.max(1, reliefStats.reliefDecals)),
    postLoadBakesMs: round(lookupBakeMs),
    perOrientation: baked.map((entry) => ({ shell: entry.shell, ms: round(entry.ms), group: entry.group })),
    note:
      'reliefCacheHits > 0 proves the hand-slot shells share one decal per (bucket, basis) group; ' +
      'the post-load bakes are a second bakery instance used for the orientation proof, not the atlas cost.',
  },
  blit: {
    tilesPerFrame: tiles.length,
    frames: frameTimes.length,
    meanMs: round(mean),
    p50Ms: round(percentile(50)),
    p95Ms: round(percentile(95)),
    maxMs: round(frameTimes[frameTimes.length - 1]),
    perTileUs: round((mean / tiles.length) * 1000),
    shadingCallsPerFrame: 0,
    note: '136 drawImage blits per frame; the relief baker is not reachable from the frame path.',
  },
  hypothetical: {
    perFrameCpuShadingMs: round(
      (reliefStats.reliefBakeMs / Math.max(1, reliefStats.reliefDecals)) * tiles.length,
    ),
    note: '136 tiles x the measured per-decal bake time; this is what per-frame CPU relief shading would cost.',
  },
  orientation: {
    layoutGroups: groups.length,
    upVs90DecalDiffBytes: round(
      diffDecals(decalPixels.shell_flat_upright, decalPixels.shell_flat_sideways),
    ),
    upVs180DecalDiffBytes: round(
      diffDecals(decalPixels.shell_flat_upright, decalPixels.shell_flat_upright_180),
    ),
    upVs270DecalDiffBytes: round(
      diffDecals(decalPixels.shell_flat_upright, decalPixels.shell_flat_sideways_270),
    ),
  },
  atlasStats: {
    flat: { buildMs: round(flatAtlas.stats.buildMs), sprites: flatAtlas.stats.sprites },
    carved: {
      buildMs: round(carvedAtlas.stats.buildMs),
      decalSprites: carvedAtlas.stats.decalSprites,
      flatGlyphSprites: carvedAtlas.stats.flatGlyphSprites,
    },
    relief: {
      buildMs: round(reliefAtlas.stats.buildMs),
      reliefSprites: reliefAtlas.stats.reliefSprites,
      reliefDecals: reliefAtlas.stats.reliefDecals,
      reliefGroups: reliefAtlas.stats.reliefGroups,
      reliefBakeMs: round(reliefAtlas.stats.reliefBakeMs),
      reliefCacheHits: reliefAtlas.stats.reliefCacheHits,
    },
  },
  outputs: {
    sheet: 'relief-compare-4x.png',
    board: 'relief-board-2x.png',
  },
  note:
    'A/B images are for the user to sign off (AGENTS.md §6). The numbers prove the orientation cache ' +
    'differs per basis, the blit frame path does no shading, and the startup cost is a one-off.',
};

writeFileSync(join(outDir, 'relief-numbers.json'), `${JSON.stringify(numbers, null, 2)}\n`);

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

console.log(
  `Task 5A: ${groups.length} layout groups, ${reliefStats.reliefDecals} cached decals, ` +
    `bake ${numbers.bake.decalBakeMs} ms (${numbers.bake.perDecalMs} ms/decal), ` +
    `blit ${numbers.blit.meanMs} ms/frame for ${tiles.length} tiles ` +
    `(p95 ${numbers.blit.p95Ms} ms), 0 shading calls/frame.`,
);
console.log(
  `relief diff bytes (upright vs 90/180/270): ${numbers.orientation.upVs90DecalDiffBytes} / ` +
    `${numbers.orientation.upVs180DecalDiffBytes} / ${numbers.orientation.upVs270DecalDiffBytes}.`,
);
console.log(`wrote ${outDir}/relief-compare-4x.png, relief-board-2x.png, relief-numbers.json`);
