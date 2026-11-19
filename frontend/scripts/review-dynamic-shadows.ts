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
import {
  SEAM_BAND_MAX_PX,
  SEAM_MIN_RING_LUMA,
  SEAM_OPACITY,
  SeamOverlayCache,
} from '../src/table/seamOverlays';
import { parseBlanksManifest } from '../src/table/blankManifest';
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
const blanks = parseBlanksManifest(JSON.parse(readFileSync(join(tableDir, 'blanks.json'), 'utf8')));
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

/** The per-(shell, side) bevel rings and their composed band overlays. */
const seamOverlays = new SeamOverlayCache({
  createCanvas: createShadowCanvas,
  seams,
  imageFor,
});
const planOfBoard = (board: ShadowBoard, lifted?: { zoneId: string; bodyIndex: number } | null) =>
  planShadows(manifest, shadows, board, {
    lifted: lifted ?? null,
    seamBands: (shell, side) => seamOverlays.bandFor(shell, side),
    blankBucket: (bucket) => blanks.buckets[bucket] ?? null,
  });

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
  /** Draw the pass-3 bevel bands (false isolates their contribution). */
  readonly crevices?: boolean;
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
    seamOverlays,
    blanks,
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
    if (options.passes && options.crevices !== false) {
      renderer.drawCreviceSeams(context, 0, index);
    }
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
  river5NoSeams: await composePanel(river5, {
    passes: true,
    crevices: false,
    label: 'A3b · river of 5, bands suppressed',
    note: 'identical except pass 3: the mat layer only',
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
  handRestNoSeams: await composePanel(hand, {
    passes: true,
    crevices: false,
    label: 'C1b · hand at rest, bands suppressed',
    note: 'identical except pass 3',
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
  return planOfBoard(panel.board);
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

// Where the crevice bands land, and how wide they are: only the chamfer, one
// band per joint, on the lit edge of the pair.
const flatSides = (['left', 'right', 'top', 'bottom'] as const).map((side) => {
  const band = seamOverlays.bandFor(manifest.shells.shell_flat_upright, side);
  return `${side}:${band ? `${band.ringLuma.toFixed(0)}luma/${Math.min(band.width, band.height).toFixed(1)}px${band.regions.length > 1 ? `+near${band.regions[1].width.toFixed(0)}px` : ''}` : 'none'}`;
});
const seamShape = {
  total: planOf(panels.river5).seams.length,
  bySide: Object.fromEntries(
    (['left', 'right', 'top', 'bottom'] as const).map((side) => [
      side,
      planOf(panels.river18).seams.filter((draw) => draw.side === side).length,
    ]),
  ),
  shellFlatUprightBands: flatSides,
  bandMaxPx: SEAM_BAND_MAX_PX,
  minRingLuma: SEAM_MIN_RING_LUMA,
  opacity: SEAM_OPACITY,
};
console.log(
  `[seams] flat_upright rings ${flatSides.join(' ')} · 18-tile river bands ${JSON.stringify(seamShape.bySide)}`,
);

// The newest tile's open edge draws no band: pass 3 on and off must agree on
// the whole strip beside it (the mat shadow is in both renders).
const newestTile = river5.bodies[newest];
const newestShell = manifest.shells[newestTile.shell];
const openLeft = PAD + newestTile.drawX + newestShell.texWidth - 2;
const openRight = openLeft + 8;
let openEdgeDiff = 0;
for (let y = PAD + newestTile.drawY; y < PAD + newestTile.drawY + newestShell.texHeight; y += 1) {
  for (let x = openLeft; x < openRight; x += 1) {
    if (panels.river5.luma(x, y) !== panels.river5NoSeams.luma(x, y)) openEdgeDiff += 1;
  }
}
console.log(
  `[river] newest tile's right edge: ${openEdgeDiff} px differ with pass 3 on vs off (open edge draws nothing)`,
);
numbers.openEdge = { pixelsDifferingBesideNewestTile: openEdgeDiff };

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
numbers.seams = seamShape;
numbers.handLift = {
  panelChanged: liftDiff.changed,
  darkestExposedLuma: Number(liftDiff.maxDrop.toFixed(2)),
  brightestBodyOverFeltLuma: Number(liftDiff.maxRise.toFixed(2)),
  seamsResting: planOf(panels.handRest).seams.length,
  seamsLifted: planOfBoard(panels.handLifted.board, {
    zoneId: 'hand-bottom',
    bodyIndex: HAND_LIFTED_INDEX,
  }).seams.length,
};
console.log(
  `[hand] seams: ${numbers.handLift.seamsResting} at rest, ${numbers.handLift.seamsLifted} lifted`,
);

// What pass 3 alone contributes, and whether it stays on the chamfer.
const seamDiff = comparePanels(panels.river5NoSeams, panels.river5);
const boardPx = (panel: Panel): number => panel.canvas.width * panel.canvas.height;
const bandRects = planOf(panels.river5).seams.flatMap((draw) => {
  const tile = river5.bodies[draw.bodyIndex];
  const shell = manifest.shells[tile.shell];
  const band = seamOverlays.bandFor(shell, draw.side)!;
  return band.regions.map((region) => ({
    left: panels.river5.board.zones[0].x + tile.drawX + region.x,
    top: panels.river5.board.zones[0].y + tile.drawY + region.y,
    right: panels.river5.board.zones[0].x + tile.drawX + region.x + region.width,
    bottom: panels.river5.board.zones[0].y + tile.drawY + region.y + region.height,
  }));
});
const changedPixels = (before: Panel, after: Panel): Array<[number, number]> => {
  const width = before.canvas.width;
  const a = (before.canvas.getContext('2d') as unknown as ShadowContext2D).getImageData(0, 0, width, before.canvas.height).data;
  const b = (after.canvas.getContext('2d') as unknown as ShadowContext2D).getImageData(0, 0, width, after.canvas.height).data;
  const points: Array<[number, number]> = [];
  for (let pixel = 0; pixel < a.length / 4; pixel += 1) {
    const offset = pixel * 4;
    if (a[offset] === b[offset] && a[offset + 1] === b[offset + 1] && a[offset + 2] === b[offset + 2]) continue;
    points.push([pixel % width, Math.floor(pixel / width)]);
  }
  return points;
};
const seamPoints = changedPixels(panels.river5NoSeams, panels.river5);
let outsideBands = 0;
for (const [x, y] of seamPoints) {
  const inside = bandRects.some(
    (rect) => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom,
  );
  if (!inside) outsideBands += 1;
}
console.log(
  `[seams] pass 3 on vs off, same river: ${seamPoints.length} px change ` +
    `(${((seamPoints.length / boardPx(panels.river5)) * 100).toFixed(2)}% of the panel), ` +
    `darkest ${seamDiff.maxDrop.toFixed(1)} luma, ${outsideBands} px outside a bevel band`,
);
numbers.seams = {
  ...seamShape,
  changedPx: seamPoints.length,
  changedShareOfPanel: Number(((seamPoints.length / boardPx(panels.river5)) * 100).toFixed(3)),
  maxDarkeningLuma: Number(seamDiff.maxDrop.toFixed(2)),
  pixelsOutsideBand: outsideBands,
};

const handSeamDiff = comparePanels(panels.handRestNoSeams, panels.handRest);
console.log(
  `[seams] hand at rest: ${handSeamDiff.changed} px change, darkest ${handSeamDiff.maxDrop.toFixed(1)} luma, ` +
    `brightest ${handSeamDiff.maxRise.toFixed(1)} luma`,
);
numbers.handSeams = {
  changedPx: handSeamDiff.changed,
  maxDarkeningLuma: Number(handSeamDiff.maxDrop.toFixed(2)),
  maxBrighteningLuma: Number(handSeamDiff.maxRise.toFixed(2)),
};

const beforeDiff = comparePanels(panels.riverBefore, panels.river5);
console.log(
  `[passes] 5-tile river, bodies only vs all four passes: ${beforeDiff.changed} px differ, ` +
    `darkest ${beforeDiff.maxDrop.toFixed(1)} luma, brightest ${beforeDiff.maxRise.toFixed(1)} luma`,
);
numbers.passesDelta = { changed: beforeDiff.changed, maxDarkening: Number(beforeDiff.maxDrop.toFixed(2)) };

// A 3x nearest-neighbour crop of one joint: the front seam and the near face's
// lit end are the two places pass 3 should touch, and 1:1 is too small to judge.
function zoomPanel(panel: Panel, x0: number, y0: number, width: number, height: number, zoom: number, label: string, note: string): Panel {
  const canvas = createShadowCanvas(Math.round(width * zoom), Math.round(height * zoom));
  const ctx = canvas.getContext('2d') as unknown as ShadowContext2D;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(panel.canvas as never, x0, y0, width, height, 0, 0, canvas.width, canvas.height);
  return {
    label,
    note,
    canvas,
    board: panel.board,
    zone: panel.zone,
    luma: (x, y) => {
      const data = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
      return Math.round((data[0] + data[1] + data[2]) / 3);
    },
  };
}
const jointTile = river5.bodies.reduce((best, tile) =>
  (tile.cell?.column ?? 9) < (best.cell?.column ?? 9) ? tile : best,
  river5.bodies[0]);
const jointX = Math.max(0, PAD + jointTile.drawX - 10);
const jointY = Math.max(0, PAD + jointTile.drawY - 2);
panels.jointBands = zoomPanel(panels.river5, jointX, jointY, 40, 112, 3, 'D1 · one joint at 3x, bands on', 'left neighbour, front seam and the near face’s lit end');
panels.jointNoBands = zoomPanel(panels.river5NoSeams, jointX, jointY, 40, 112, 3, 'D2 · the same joint, bands off', 'the only difference is pass 3');

// ---------------------------------------------------------------- sheet
const title = 64;
const gap = 22;
const caption = 44;
const panelsByRow: Panel[][] = [
  [panels.river1, panels.river5, panels.river5NoSeams],
  [panels.river18],
  [panels.wallFull, panels.wallNoDecal, panels.wallBroken],
  [panels.handRest, panels.handRestNoSeams, panels.handLifted],
  [panels.jointBands, panels.jointNoBands],
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
