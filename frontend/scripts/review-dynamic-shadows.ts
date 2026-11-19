/**
 * Task 6A review sheet and numbers: the dynamic shadow passes on a live board.
 *
 *   cd frontend && npm run shadows:review
 *
 * Writes, under `tools/render/build/review/shadows/` (gitignored):
 *
 *   task6a-dynamic-shadows.png   the before/after panels below at 1:1
 *   task6a-numbers.json          the measured numbers printed to stdout
 *
 * Panels: a river at 1, 5 and 18 tiles (with a bodies-only "before"); a wall
 * stack with and without its upper tier; a hand tile resting and lifted.
 *
 * AGENTS.md §6: this file is evidence for the user. The script prints the
 * facts (luma drops, seam counts, touched pixels); it never judges the look,
 * and the agent does not sign it off.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Image, createCanvas, loadImage } from '@napi-rs/canvas';
import {
  BoardShadowRenderer,
  HAND_LIFT_PX,
  planShadows,
  zoneShadowMasks,
} from '../src/table/boardShadows';
import type { ShadowBoard, ShadowContext2D, ShadowImage } from '../src/table/boardShadows';
import { parseAoSeamsManifest, parseShadowsManifest } from '../src/table/shadowManifest';
import type { ShadowsManifest } from '../src/table/shadowManifest';
import { parseShellsManifest } from '../src/table/shellManifest';
import type { ShellsManifest } from '../src/table/shellManifest';
import { TileAtlas } from '../src/table/TileAtlas';
import type { AtlasCanvas, AtlasImage } from '../src/table/TileAtlasBuilder';
import { isFaceUpShellId, tileRenderKey } from '../src/table/tiles';
import type { FaceUpShellId, TileFaceId } from '../src/table/tiles';
import { layoutHand, layoutPond, layoutWall } from '../src/table/zoneLayout';
import type { LayoutZone, PondDiscard } from '../src/table/zoneLayout';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const tableDir = resolve(scriptDir, '../public/table');
const renderDir = resolve(scriptDir, '../../tools/render');
const outDir = join(renderDir, 'build/review/shadows');

const manifest: ShellsManifest = parseShellsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')),
);
const shadows: ShadowsManifest = parseShadowsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shadows.json'), 'utf8')),
);
const seams = parseAoSeamsManifest(JSON.parse(readFileSync(join(tableDir, 'ao_seams.json'), 'utf8')));
const feltSpec = JSON.parse(readFileSync(join(renderDir, 'felt-spec.json'), 'utf8'));
const FELT = `rgb(${feltSpec.baseColor[0]}, ${feltSpec.baseColor[1]}, ${feltSpec.baseColor[2]})`;

const PAD = 34;

const WARM_SHELLS: FaceUpShellId[] = [
  'shell_flat_upright',
  'shell_flat_sideways',
  'shell_flat_upright_180',
  'shell_flat_sideways_270',
  ...Array.from({ length: 13 }, (_, index) => `shell_hand_slot_${String(index).padStart(2, '0')}` as FaceUpShellId),
  'shell_hand_slot_draw',
];

const atlas = await TileAtlas.load({
  baseUrl: tableDir,
  fetchJson: async (url) => JSON.parse(readFileSync(url, 'utf8')),
  loadImage: async (url) => (await loadImage(readFileSync(url))) as unknown as AtlasImage,
  createCanvas: (width, height) => createCanvas(width, height) as unknown as AtlasCanvas,
  pixelRatio: 1,
  decalsUrl: null,
  warmShells: WARM_SHELLS,
});

const imageCache = new Map<string, ShadowImage>();
const imageFor = (file: string): ShadowImage | null => {
  const cached = imageCache.get(file);
  if (cached) return cached;
  try {
    const image = new Image();
    image.src = readFileSync(join(tableDir, file));
    imageCache.set(file, image as unknown as ShadowImage);
    return image as unknown as ShadowImage;
  } catch {
    return null;
  }
};

const createShadowCanvas = (width: number, height: number): AtlasCanvas =>
  createCanvas(width, height) as unknown as AtlasCanvas;

type Panel = {
  readonly label: string;
  readonly note: string;
  readonly canvas: AtlasCanvas;
  readonly luma: (x: number, y: number) => number;
  readonly board: ShadowBoard;
  readonly zone: LayoutZone;
};

interface PanelOptions {
  readonly passes: boolean;
  /** Draw the tile bodies on top of the passes (false isolates the mat layer). */
  readonly bodies?: boolean;
  /** Draw the pass-2 stack decal (false isolates its darkening). */
  readonly stackDecal?: boolean;
  readonly lifted?: { zoneId: string; bodyIndex: number } | null;
  readonly label: string;
  readonly note: string;
}

async function drawTile(
  context: ShadowContext2D,
  shellId: string,
  face: TileFaceId | null,
  drawX: number,
  drawY: number,
): Promise<void> {
  const shell = manifest.shells[shellId];
  if (face && isFaceUpShellId(shellId)) {
    const sprite = atlas.getSprite(tileRenderKey(shellId, face));
    const page = atlas.getPage(sprite);
    context.drawImage(
      page.canvas as never,
      sprite.uv.x,
      sprite.uv.y,
      sprite.uv.width,
      sprite.uv.height,
      drawX,
      drawY,
      sprite.texWidth,
      sprite.texHeight,
    );
    return;
  }
  const image = imageFor(shell.textureFile);
  if (!image) throw new Error(`review: no image for ${shell.textureFile}`);
  context.drawImage(image as never, drawX, drawY, shell.texWidth, shell.texHeight);
}

/**
 * Compose one zone on the felt: the mat pass, then every body in painter order
 * with its stack decal above the lower tier and its crevices below the next.
 */
async function composePanel(zone: LayoutZone, options: PanelOptions): Promise<Panel> {
  const width = Math.ceil(zone.width) + PAD * 2;
  const height = Math.ceil(zone.height) + PAD * 2;
  const canvas = createShadowCanvas(width, height);
  const context = canvas.getContext('2d') as unknown as ShadowContext2D;
  context.fillStyle = FELT;
  context.fillRect(0, 0, width, height);

  const board: ShadowBoard = {
    zones: [{ zone, x: PAD, y: PAD, scale: 1 }],
    width,
    height,
  };
  const renderer = new BoardShadowRenderer({
    createCanvas: createShadowCanvas,
    board,
    manifest,
    shadows,
    seams,
    imageFor,
    pixelRatio: 1,
  });
  renderer.update({ lifted: options.lifted ?? null });

  if (options.passes) renderer.drawMatShadowPass(context);

  if (options.bodies === false) {
    const luma = (x: number, y: number): number => {
      const data = context.getImageData(Math.round(x), Math.round(y), 1, 1).data;
      return Math.round((data[0] + data[1] + data[2]) / 3);
    };
    return { label: options.label, note: options.note, canvas, luma, board, zone };
  }

  for (let index = 0; index < zone.bodies.length; index += 1) {
    const body = zone.bodies[index];
    const lifted =
      options.lifted !== undefined &&
      options.lifted !== null &&
      zone.id === options.lifted.zoneId &&
      index === options.lifted.bodyIndex;
    const drawY = PAD + body.drawY - (lifted ? HAND_LIFT_PX : 0);
    if (options.passes && options.stackDecal !== false) {
      renderer.drawWallStackShadow(context, 0, index);
    }
    await drawTile(context, body.shell, body.face, PAD + body.drawX, drawY);
    if (options.passes) renderer.drawCreviceSeams(context, 0, index);
  }

  const luma = (x: number, y: number): number => {
    const data = context.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    return Math.round((data[0] + data[1] + data[2]) / 3);
  };
  return { label: options.label, note: options.note, canvas, luma, board, zone };
}

/** Pixel-diff two equally sized panels: where, and by how much, they differ. */
function comparePanels(
  before: Panel,
  after: Panel,
): { changed: number; maxDrop: number; maxRise: number; dropAt: [number, number]; riseAt: [number, number] } {
  const width = before.canvas.width;
  const height = before.canvas.height;
  const a = (before.canvas.getContext('2d') as unknown as ShadowContext2D).getImageData(0, 0, width, height).data;
  const b = (after.canvas.getContext('2d') as unknown as ShadowContext2D).getImageData(0, 0, width, height).data;
  let changed = 0;
  let maxDrop = 0;
  let maxRise = 0;
  let dropAt: [number, number] = [0, 0];
  let riseAt: [number, number] = [0, 0];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const left = (a[offset] + a[offset + 1] + a[offset + 2]) / 3;
      const right = (b[offset] + b[offset + 1] + b[offset + 2]) / 3;
      const delta = left - right;
      if (Math.abs(delta) < 1) continue;
      changed += 1;
      if (delta > maxDrop) {
        maxDrop = delta;
        dropAt = [x, y];
      }
      if (-delta > maxRise) {
        maxRise = -delta;
        riseAt = [x, y];
      }
    }
  }
  return { changed, maxDrop, maxRise, dropAt, riseAt };
}

// ---------------------------------------------------------------- builds
const discards = (count: number): PondDiscard[] => [
  '1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m',
  '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p',
].slice(0, count).map((face, index) => ({ face: face as TileFaceId, riichi: index === 14 }));

const river1 = layoutPond(manifest, { discards: discards(1) });
const river5 = layoutPond(manifest, { discards: discards(5) });
const river18 = layoutPond(manifest, { discards: discards(18) });
const wall = layoutWall(manifest, { wall: 'front', count: 5, startIndex: 6, doraIndex: 8 });
const wallBroken: LayoutZone = {
  ...wall,
  bodies: wall.bodies.filter((tile) => (tile.cell?.tier === 1 ? tile.cell.slot !== 7 : true)),
};
const hand = layoutHand(manifest, {
  faces: ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '3p', '4p'],
  draw: '5p',
});
const HAND_LIFTED_INDEX = hand.bodies.findIndex((tile) => tile.shell === 'shell_hand_slot_06');
if (HAND_LIFTED_INDEX < 0) throw new Error('review: the lifted hand fixture lost shell_hand_slot_06');

console.log('[task6a] composing panels…');
const panels = {
  riverBefore: await composePanel(river5, {
    passes: false,
    label: 'A2 · river of 5, bodies only',
    note: 'before: no mat shadow, no crevice',
  }),
  river1: await composePanel(river1, {
    passes: true,
    label: 'A1 · river of 1',
    note: 'one discard: one mat shadow, no crevice at all',
  }),
  river5: await composePanel(river5, {
    passes: true,
    label: 'A3 · river of 5',
    note: 'four crevices, the newest tile’s right edge still open',
  }),
  river18: await composePanel(river18, {
    passes: true,
    label: 'A4 · river of 18',
    note: 'three full rows; every interior edge creased',
  }),
  wallFull: await composePanel(wall, {
    passes: true,
    label: 'B1 · wall, both tiers',
    note: 'one mat shadow per stack + the seat’s stack decal',
  }),
  wallNoDecal: await composePanel(wall, {
    passes: true,
    stackDecal: false,
    label: 'B2 · wall, stack decal suppressed',
    note: 'the same stacks with pass 2 off: only the decal differs from B1',
  }),
  wallBroken: await composePanel(wallBroken, {
    passes: true,
    label: 'B3 · wall, slot 7 upper tile drawn',
    note: 'the upper body and its decal are both gone',
  }),
  handRest: await composePanel(hand, {
    passes: true,
    label: 'C1 · hand at rest',
    note: 'crevices between every pair of slots',
  }),
  handLifted: await composePanel(hand, {
    passes: true,
    lifted: { zoneId: 'hand-bottom', bodyIndex: HAND_LIFTED_INDEX },
    label: `C2 · hand, slot 06 lifted ${HAND_LIFT_PX} px`,
    note: 'shadow stays at rest, 0.92× and 0.75 fade; crevices beside it drop',
  }),
};

// ---------------------------------------------------------------- numbers
const numbers: Record<string, unknown> = {
  generatedBy: 'frontend/scripts/review-dynamic-shadows.ts',
  task: '6A',
  shadowsVariant: shadows.variant,
  seamOpacity: 0.6,
  handLiftPx: HAND_LIFT_PX,
  panels: {},
};

function planOf(panel: Panel): ReturnType<typeof planShadows> {
  return planShadows(manifest, shadows, seams, panel.board);
}

const river1Plan = planOf(panels.river1);
const river5Plan = planOf(panels.river5);
const river18Plan = planOf(panels.river18);
const wallFullPlan = planOf(panels.wallFull);
const wallBrokenPlan = planOf(panels.wallBroken);

numbers.panels = {
  river1: { tiles: river1.bodies.length, mat: river1Plan.mat.length, seams: river1Plan.seams.length },
  river5: { tiles: river5.bodies.length, mat: river5Plan.mat.length, seams: river5Plan.seams.length },
  river18: { tiles: river18.bodies.length, mat: river18Plan.mat.length, seams: river18Plan.seams.length },
  wallFull: {
    tiles: wall.bodies.length,
    mat: wallFullPlan.mat.length,
    stacks: wallFullPlan.stacks.length,
    seams: wallFullPlan.seams.length,
  },
  wallBroken: {
    tiles: wallBroken.bodies.length,
    mat: wallBrokenPlan.mat.length,
    stacks: wallBrokenPlan.stacks.length,
    seams: wallBrokenPlan.seams.length,
  },
  hand: { tiles: hand.bodies.length, mat: planOf(panels.handRest).mat.length },
};

// A river's newest tile must have no crevice on its open side.
const newest = river5.bodies.reduce((best, tile, index) =>
  (tile.cell?.column ?? 0) > (river5.bodies[best].cell?.column ?? 0) ? index : best,
  0);
const newestSides = (['left', 'right', 'top', 'bottom'] as const).filter(
  (side) => river5Plan.adjacency[0][newest][side] !== null,
);
console.log(`[river] newest tile of the 5-tile row: neighbour sides = ${newestSides.join(',') || 'none'}`);

// Mat shadows must merge at MAX alpha: the 18-tile row may never darken past
// the darkest single tile at any pixel.
const masks = zoneShadowMasks(river18Plan, panels.river18.board);
console.log(
  `[mat] 18-tile river: ${river18Plan.mat.length} shadows, one zone mask ` +
    `${masks[0].width}x${masks[0].height} at (${masks[0].x}, ${masks[0].y})`,
);
// Every tile of the 18-tile river on its own, mat layer only, rendered at the
// same origin, so the merged row can be compared pixel for pixel with the
// darkest single tile at that pixel. A compound would show up as a merged pixel
// darker than every single-tile render. Bodies are excluded on purpose: a
// neighbour's body covering a shadowed pixel is the growth behaviour working,
// not a compounding bug.
const mergedMat = await composePanel(river18, {
  passes: true,
  bodies: false,
  label: 'mat only',
  note: '',
});
const soloData: Uint8ClampedArray[] = [];
for (let index = 0; index < river18.bodies.length; index += 1) {
  const solo: LayoutZone = {
    ...river18,
    bodies: [river18.bodies[index]],
    shadows: [
      river18.shadows.find(
        (tile) =>
          tile.gridX === river18.bodies[index].gridX && tile.gridY === river18.bodies[index].gridY,
      )!,
    ],
  };
  const panel = await composePanel(solo, { passes: true, bodies: false, label: 'solo', note: '' });
  soloData.push(
    (panel.canvas.getContext('2d') as unknown as ShadowContext2D).getImageData(
      0,
      0,
      panel.canvas.width,
      panel.canvas.height,
    ).data,
  );
}
const mergedData = (
  mergedMat.canvas.getContext('2d') as unknown as ShadowContext2D
).getImageData(0, 0, mergedMat.canvas.width, mergedMat.canvas.height).data;
let worstCompound = 0;
let compared = 0;
for (let pixel = 0; pixel < mergedData.length / 4; pixel += 1) {
  const offset = pixel * 4;
  const merged = (mergedData[offset] + mergedData[offset + 1] + mergedData[offset + 2]) / 3;
  let darkestSingle = 255;
  for (const data of soloData) {
    const value = (data[offset] + data[offset + 1] + data[offset + 2]) / 3;
    if (value < darkestSingle) darkestSingle = value;
  }
  if (darkestSingle === 255) continue;
  compared += 1;
  worstCompound = Math.max(worstCompound, darkestSingle - merged);
}
console.log(
  `[mat] max alpha merge: ${compared} shadowed px compared against all 18 single-tile renders, ` +
    `worst darkening past the darkest single = ${worstCompound.toFixed(2)} luma`,
);
numbers.matMerge = { comparedPixels: compared, worstDarkeningPastSingleLuma: Number(worstCompound.toFixed(3)) };

// The open edge of the newest tile stays at felt luma.
const newestTile = river5.bodies[newest];
const outsideX = PAD + newestTile.drawX + manifest.shells[newestTile.shell].texWidth + 3;
const outsideY = PAD + newestTile.drawY + 60;
const outsideLuma = panels.river5.luma(outsideX, outsideY);
const feltLuma = panels.river5.luma(2, 2);
console.log(`[river] felt beside the newest tile: ${outsideLuma} vs open felt ${feltLuma}`);
numbers.openEdge = { outside: outsideLuma, felt: feltLuma };

// The wall stack decal and the lifted hand both show up as a pixel difference.
const decalDiff = comparePanels(panels.wallNoDecal, panels.wallFull);
console.log(
  `[wall] stack decal on vs off (same bodies): ${decalDiff.changed} px darken, ` +
    `most by ${decalDiff.maxDrop.toFixed(1)} luma at ${decalDiff.dropAt.join(',')}, ` +
    `nothing brightens by more than ${decalDiff.maxRise.toFixed(1)}`,
);
const wallDiff = comparePanels(panels.wallBroken, panels.wallFull);
console.log(
  `[wall] upper tier present vs drawn off: ${wallDiff.changed} px differ, ` +
    `darker by up to ${wallDiff.maxDrop.toFixed(1)} luma at ${wallDiff.dropAt.join(',')}`,
);
numbers.wallStack = {
  decalChangedPx: decalDiff.changed,
  decalMaxDarkeningLuma: Number(decalDiff.maxDrop.toFixed(2)),
  decalMaxBrighteningLuma: Number(decalDiff.maxRise.toFixed(2)),
  tierRemovedChangedPx: wallDiff.changed,
};
const liftDiff = comparePanels(panels.handRest, panels.handLifted);
console.log(
  `[hand] lifted vs resting over the whole panel: ${liftDiff.changed} px differ, ` +
    `darker by up to ${liftDiff.maxDrop.toFixed(1)} luma (body gone, shadow exposed) ` +
    `at ${liftDiff.dropAt.join(',')}, brighter by up to ${liftDiff.maxRise.toFixed(1)} ` +
    `(body over felt) at ${liftDiff.riseAt.join(',')}`,
);
// The crevice change lives beside the lifted tile, not under it: outside the
// lifted body's own column band, the only thing that may change is a removed
// bevel crease.
const liftedBody = hand.bodies[HAND_LIFTED_INDEX];
const bodyLeft = PAD + liftedBody.drawX;
const bodyRight = bodyLeft + manifest.shells[liftedBody.shell].advanceWidth;
let creviceBrightened = 0;
let creviceBrightest = 0;
let creviceAt: [number, number] = [0, 0];
for (let y = 0; y < panels.handRest.canvas.height; y += 1) {
  for (let x = 0; x < panels.handRest.canvas.width; x += 1) {
    if (x >= bodyLeft - 3 && x <= bodyRight + 3) continue;
    const before = panels.handRest.luma(x, y);
    const after = panels.handLifted.luma(x, y);
    const rise = after - before;
    if (rise <= 0) continue;
    creviceBrightened += 1;
    if (rise > creviceBrightest) {
      creviceBrightest = rise;
      creviceAt = [x, y];
    }
  }
}
console.log(
  `[hand] beside the lifted tile: ${creviceBrightened} px brighten, most by ` +
    `${creviceBrightest} luma at ${creviceAt.join(',')} (its bevel crease is gone)`,
);
numbers.handLift = {
  panelChanged: liftDiff.changed,
  darkestExposedLuma: Number(liftDiff.maxDrop.toFixed(2)),
  brightestBodyOverFeltLuma: Number(liftDiff.maxRise.toFixed(2)),
  neighbourPixelsBrightened: creviceBrightened,
  neighbourBrightestLuma: creviceBrightest,
  seamsResting: planOf(panels.handRest).seams.length,
  seamsLifted: planShadows(manifest, shadows, seams, panels.handLifted.board, {
    lifted: { zoneId: 'hand-bottom', bodyIndex: HAND_LIFTED_INDEX },
  }).seams.length,
};
console.log(
  `[hand] seams: ${numbers.handLift.seamsResting} at rest, ${numbers.handLift.seamsLifted} lifted`,
);

const beforeDiff = comparePanels(panels.riverBefore, panels.river5);
console.log(
  `[passes] 5-tile river, bodies only vs all four passes: ${beforeDiff.changed} px differ, ` +
    `darkest ${beforeDiff.maxDrop.toFixed(1)} luma, brightest ${beforeDiff.maxRise.toFixed(1)} luma`,
);
numbers.passesDelta = { changed: beforeDiff.changed, maxDarkening: Number(beforeDiff.maxDrop.toFixed(2)) };

// ---------------------------------------------------------------- sheet
const title = 64;
const gap = 22;
const caption = 44;
const panelsByRow: Panel[][] = [
  [panels.river1, panels.river5, panels.riverBefore],
  [panels.river18],
  [panels.wallFull, panels.wallNoDecal, panels.wallBroken],
  [panels.handRest, panels.handLifted],
];
const sheetWidth = Math.max(
  ...panelsByRow.map((row) => row.reduce((total, panel) => total + panel.canvas.width + gap, gap)),
  760,
);
const sheetHeight =
  title +
  panelsByRow.reduce(
    (total, row) => total + Math.max(...row.map((panel) => panel.canvas.height)) + caption + gap,
    0,
  );
const sheet = createCanvas(sheetWidth, sheetHeight);
const sheetContext = sheet.getContext('2d');
sheetContext.fillStyle = '#12151a';
sheetContext.fillRect(0, 0, sheetWidth, sheetHeight);
sheetContext.fillStyle = '#f3ead7';
sheetContext.font = 'bold 26px sans-serif';
sheetContext.fillText('2.5D TASK 6A · ADJACENCY-AWARE DYNAMIC SHADOW PASSES', 20, 34);
sheetContext.fillStyle = '#9fb3c8';
sheetContext.font = '16px sans-serif';
sheetContext.fillText(
  `VARIANT ${shadows.variant} · MAT PASS = MAX ALPHA (darken) THEN MULTIPLY · SEAMS AT ${'60'}% OF THE MASK · LIFT ${HAND_LIFT_PX} PX`,
  20,
  56,
);

let cursorY = title;
for (const row of panelsByRow) {
  let cursorX = gap;
  const rowHeight = Math.max(...row.map((panel) => panel.canvas.height));
  for (const panel of row) {
    sheetContext.drawImage(panel.canvas as never, cursorX, cursorY);
    sheetContext.fillStyle = '#f3ead7';
    sheetContext.font = 'bold 15px sans-serif';
    sheetContext.fillText(panel.label, cursorX, cursorY + panel.canvas.height + 18);
    sheetContext.fillStyle = '#9fb3c8';
    sheetContext.font = '14px sans-serif';
    sheetContext.fillText(panel.note, cursorX, cursorY + panel.canvas.height + 36);
    cursorX += panel.canvas.width + gap;
  }
  cursorY += rowHeight + caption + gap;
}

mkdirSync(outDir, { recursive: true });
const sheetPath = join(outDir, 'task6a-dynamic-shadows.png');
writeFileSync(sheetPath, sheet.toBuffer('image/png'));
const numbersPath = join(outDir, 'task6a-numbers.json');
writeFileSync(numbersPath, `${JSON.stringify(numbers, null, 2)}\n`);
console.log(`[review] ${sheet.width}x${sheet.height} -> ${sheetPath}`);
console.log(`[review] numbers -> ${numbersPath}`);
