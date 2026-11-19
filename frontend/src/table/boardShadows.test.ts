import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, Image } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import {
  BoardShadowRenderer,
  HAND_LIFT_PX,
  LIFTED_SHADOW_OPACITY,
  LIFTED_SHADOW_SCALE,
  buildZoneAdjacency,
  planShadows,
  screenSideOf,
  zoneShadowMasks,
} from './boardShadows';
import type { ShadowBoard, ShadowContext2D, ShadowImage, ShadowZonePlacement } from './boardShadows';
import {
  SEAM_BAND_MAX_PX,
  SEAM_BAND_MIN_PX,
  SEAM_MIN_RING_LUMA,
  SEAM_OPACITY,
  SeamOverlayCache,
  drawMaskInBand,
  seamBandRect,
} from './seamOverlays';
import type { SpriteSide } from './seamOverlays';
import { parseAoSeamsManifest, parseShadowsManifest } from './shadowManifest';
import type { AoSeamsManifest, ShadowsManifest } from './shadowManifest';
import { parseShellsManifest } from './shellManifest';
import type { ShellsManifest } from './shellManifest';
import {
  layoutHand,
  layoutMeld,
  layoutPond,
  layoutWall,
} from './zoneLayout';
import type { LayoutZone, PondDiscard } from './zoneLayout';
import type { TileFaceId } from './tiles';
import type { AtlasCanvas } from './TileAtlasBuilder';

/**
 * Real Canvas 2D (`@napi-rs/canvas`) and the real committed assets, so the
 * assertions are decoded pixels and the committed manifests, not a mock.
 */
const tableDir = fileURLToPath(new URL('../../public/table/', import.meta.url));
const shells: ShellsManifest = parseShellsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')),
);
const shadows: ShadowsManifest = parseShadowsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shadows.json'), 'utf8')),
);
const seams: AoSeamsManifest = parseAoSeamsManifest(
  JSON.parse(readFileSync(join(tableDir, 'ao_seams.json'), 'utf8')),
);

const createShadowCanvas = (width: number, height: number): AtlasCanvas =>
  createCanvas(width, height) as unknown as AtlasCanvas;

const imageCache = new Map<string, ShadowImage | null>();
const imageFor = (file: string): ShadowImage | null => {
  if (imageCache.has(file)) return imageCache.get(file) ?? null;
  try {
    // `Image.src` decodes synchronously in Node, so the passes stay synchronous.
    const image = new Image();
    image.src = readFileSync(join(tableDir, file));
    imageCache.set(file, image as unknown as ShadowImage);
    return image as unknown as ShadowImage;
  } catch {
    imageCache.set(file, null);
    return null;
  }
};

const seamOverlays = new SeamOverlayCache({
  createCanvas: createShadowCanvas,
  seams,
  imageFor,
});
const planOf = (board: ShadowBoard, lifted?: { zoneId: string; bodyIndex: number } | null) =>
  planShadows(shells, shadows, board, {
    lifted: lifted ?? null,
    seamBands: (shell, side) => seamOverlays.bandFor(shell, side),
  });

function boardOf(zones: LayoutZone[], scale = 1): ShadowBoard {
  let x = 0;
  const placements: ShadowZonePlacement[] = zones.map((zone) => {
    const placement: ShadowZonePlacement = { zone, x, y: 0, scale };
    x += Math.ceil(zone.width * scale) + 20;
    return placement;
  });
  return {
    zones: placements,
    width: Math.max(1, Math.ceil(x)),
    height: Math.max(1, Math.ceil(Math.max(...zones.map((zone) => zone.height + 40)))),
  };
}

const HAND_FACES: TileFaceId[] = [
  '1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '3p', '4p',
];
const hand13 = (draw: TileFaceId | null = null): LayoutZone =>
  layoutHand(shells, { faces: HAND_FACES, draw });

const discards = (count: number): PondDiscard[] =>
  Array.from({ length: count }, (_, index) => ({ face: '1m' as const, riichi: index === 6 }));

function sides(neighbours: {
  readonly left: number | null;
  readonly right: number | null;
  readonly top: number | null;
  readonly bottom: number | null;
}): string {
  return (['left', 'right', 'top', 'bottom'] as const)
    .filter((side) => neighbours[side] !== null)
    .join(',');
}

/** A board canvas painted with a felt grey, ready for a pass. */
function boardCanvas(board: ShadowBoard): {
  canvas: AtlasCanvas;
  ctx: ShadowContext2D;
  luma: (x: number, y: number) => number;
} {
  const canvas = createShadowCanvas(Math.ceil(board.width), Math.ceil(board.height));
  const ctx = canvas.getContext('2d') as unknown as ShadowContext2D;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const luma = (x: number, y: number): number => {
    const data = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    return Math.round((data[0] + data[1] + data[2]) / 3);
  };
  return { canvas, ctx, luma };
}

function render(
  board: ShadowBoard,
  options: { lifted?: { zoneId: string; bodyIndex: number } | null; ratio?: 1 | 2 } = {},
): { renderer: BoardShadowRenderer; ctx: ShadowContext2D; luma: (x: number, y: number) => number } {
  const renderer = new BoardShadowRenderer({
    createCanvas: createShadowCanvas,
    board,
    manifest: shells,
    shadows,
    seamOverlays,
    imageFor,
    pixelRatio: options.ratio ?? 1,
  });
  renderer.update({ lifted: options.lifted ?? null });
  const { ctx, luma } = boardCanvas(board);
  renderer.drawMatShadowPass(ctx);
  return { renderer, ctx, luma };
}

describe('sprite sides', () => {
  it('puts a neighbour on the sprite edge it is drawn against', () => {
    // The sprite is axis-aligned whatever the baked pose: a sideways riichi
    // tile's joint is still on its screen edge, not on a plate axis.
    expect(screenSideOf(50, 0)).toBe('right');
    expect(screenSideOf(-50, 4)).toBe('left');
    expect(screenSideOf(0, 50)).toBe('bottom');
    expect(screenSideOf(3, -50)).toBe('top');
  });
});

describe('adjacency from the live state', () => {
  it('opens the newest river tile’s edge and closes it as the row grows', () => {
    const one = buildZoneAdjacency(shells, layoutPond(shells, { side: 'bottom', discards: discards(1) }));
    expect(one.map(sides)).toEqual(['']);

    const five = buildZoneAdjacency(shells, layoutPond(shells, { side: 'bottom', discards: discards(5) }));
    // One row of five: two ends with one neighbour each, three with both.
    expect(five.map(sides).sort()).toEqual([
      'left',
      'left,right',
      'left,right',
      'left,right',
      'right',
    ]);

    const plain = Array.from({ length: 18 }, () => ({ face: '1m' as const }));
    const eighteen = buildZoneAdjacency(
      shells,
      layoutPond(shells, { side: 'bottom', discards: plain }),
    );
    expect(eighteen).toHaveLength(18);
    // Three rows of six: only the middle row's four inner tiles see all four
    // neighbours, and the four table corners see exactly two.
    expect(eighteen.filter((entry) => sides(entry) === 'left,right,top,bottom')).toHaveLength(4);
    // The four table corners see two neighbours; the first and last rows'
    // inner tiles and the middle row's ends see three. 4 + 10 + 4 = 18.
    expect(eighteen.filter((entry) => sides(entry).split(',').length === 2)).toHaveLength(4);
    expect(eighteen.filter((entry) => sides(entry).split(',').length === 3)).toHaveLength(10);
    // The first and last rows keep one horizontal side open on their ends and
    // one vertical side open along their whole length.
    expect(eighteen.filter((entry) => entry.top === null)).toHaveLength(6);
    expect(eighteen.filter((entry) => entry.bottom === null)).toHaveLength(6);
  });

  it('turns a sideways river tile’s crevices with its own plate', () => {
    const pond = layoutPond(shells, {
      side: 'bottom',
      discards: Array.from({ length: 7 }, (_, index) => ({
        face: '1m' as const,
        riichi: index === 6,
      })),
    });
    const adjacency = buildZoneAdjacency(shells, pond);
    const turned = pond.bodies.findIndex((tile) => tile.shell === 'shell_flat_sideways');
    expect(turned).toBeGreaterThanOrEqual(0);
    // The turned tile is the newest discard in row 1: it has the tile above it
    // and the row gap to its own right, and its plate is rotated, so the sides
    // it reports are its own, not the screen's.
    expect(sides(adjacency[turned])).not.toBe('');
  });

  it('gives the drawn hand tile no crevice at all', () => {
    const hand = layoutHand(shells, {
      faces: ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '3p', '4p'],
      draw: '5p',
    });
    const adjacency = buildZoneAdjacency(shells, hand);
    const drawIndex = hand.bodies.findIndex((tile) => tile.shell === 'shell_hand_slot_draw');
    expect(sides(adjacency[drawIndex])).toBe('');
    // The row's ends keep one open side each.
    expect(adjacency.filter((entry) => sides(entry) === 'right' || sides(entry) === 'left')).toHaveLength(2);
  });

  it('keys a wall’s crevices off the live stacks only', () => {
    const wall = layoutWall(shells, { wall: 'front', count: 3, startIndex: 7 });
    const adjacency = buildZoneAdjacency(shells, wall);
    // Three stacks, two tiers: the run has two gaps, each drawn twice.
    const horizontal = adjacency.filter((entry) => entry.left !== null || entry.right !== null);
    expect(horizontal).toHaveLength(6);
    // The tier crevice is the stack decal's job, not an AO mask.
    expect(adjacency.every((entry) => entry.top === null && entry.bottom === null)).toBe(true);
  });

  it('treats a meld as a single row', () => {
    const meld = layoutMeld(shells, { faces: ['1m', '2m', '3m'], calledIndex: 2 });
    const adjacency = buildZoneAdjacency(shells, meld);
    // Three tiles, two crevices, each drawn on both facing plates: a path, and
    // nothing leaves the row. The called tile's sideways plate puts its one
    // neighbour on its own v axis, so the *side name* differs from the row's.
    const count = adjacency.reduce((total, entry) => total + (sides(entry) === '' ? 0 : sides(entry).split(',').length), 0);
    expect(count).toBe(4);
    expect(adjacency.filter((entry) => sides(entry) === '').length).toBe(0);
  });
});

describe('shadow plan', () => {
  it('draws one mat shadow per occupied slot, not one per tier', () => {
    const wall = layoutWall(shells, { wall: 'front', count: 17 });
    const board = boardOf([wall]);
    const plan = planOf(board);
    expect(wall.bodies).toHaveLength(34);
    expect(plan.mat).toHaveLength(17);
    expect(plan.mat.every((draw) => draw.bucket.startsWith('wall_horiz_'))).toBe(true);
  });

  it('draws a stack decal only while the upper tier is present', () => {
    const wall = layoutWall(shells, { wall: 'back', count: 3, startIndex: 7 });
    const withTier = planOf(boardOf([wall]));
    expect(withTier.stacks).toHaveLength(3);
    expect(new Set(withTier.stacks.map((draw) => draw.seat))).toEqual(new Set(['north']));
    expect(withTier.stacks.every((draw) => draw.textureFile === 'shadows/shadow_wall_stack_north.png')).toBe(true);

    // A stack whose upper tile is gone from the plan (drawn off the wall) has
    // no decal: the pass reads the live cells, it is not baked.
    const broken: LayoutZone = {
      ...wall,
      bodies: wall.bodies.filter((tile) => !(tile.cell?.tier === 1 && tile.cell.slot === 8)),
    };
    const without = planOf(boardOf([broken]));
    expect(without.stacks).toHaveLength(2);
    expect(without.stacks.some((draw) => draw.bodyIndex === 2)).toBe(false);
  });

  it('anchors a wall stack decal at the lower tier, under the upper body', () => {
    const wall = layoutWall(shells, { wall: 'front', count: 1, startIndex: 8 });
    const board = boardOf([wall]);
    const plan = planOf(board);
    const lower = wall.bodies.find((tile) => tile.cell?.tier === 0);
    const stack = plan.stacks[0];
    const record = shadows.wallStack.seats.south;
    expect(lower).toBeDefined();
    expect(stack.bodyIndex).toBe(0);
    expect(stack.x).toBeCloseTo(lower!.gridX - record.pivot.x / record.pixelRatio, 6);
    expect(stack.y).toBeCloseTo(lower!.gridY - record.pivot.y / record.pixelRatio, 6);
  });

  it('draws one crevice band per joint, on the lit edge of the pair', () => {
    const one = planOf(boardOf([layoutPond(shells, { side: 'bottom', discards: discards(1) })]));
    expect(one.seams).toHaveLength(0);

    const row = layoutPond(shells, { side: 'bottom', discards: discards(5) });
    const grown = planOf(boardOf([row]));
    // Five in a row: four joints, one band each — never two on the same seam.
    expect(grown.seams).toHaveLength(4);
    // The flat bucket's left ring is the bright one (measured 219 vs 187 on the
    // right), so the tile that has a neighbour to its left takes the band.
    expect(grown.seams.every((draw) => draw.side === 'left')).toBe(true);
    const bodies = new Set(grown.seams.map((draw) => draw.bodyIndex));
    expect(bodies.has(4)).toBe(false); // the row's left end has no left neighbour
    expect(bodies.size).toBe(4);
    // One band per joint: no body+side pair repeats.
    const keys = new Set(grown.seams.map((draw) => `${draw.zoneIndex}:${draw.bodyIndex}:${draw.side}`));
    expect(keys.size).toBe(grown.seams.length);

    // A whole pond: 15 in-row joints + 2 row gaps x 6 columns.
    const full = planOf(boardOf([layoutPond(shells, { side: 'bottom', discards: discards(18) })]));
    expect(full.seams).toHaveLength(27);
    // Vertical joints land on the tile below (its top ring is lit, the upper
    // tile's bottom ring measures 10 luma).
    expect(full.seams.filter((draw) => draw.side === 'top').length).toBe(12);

    // Hands and melds pair the same way: 13 tiles -> 12 joints.
    expect(planOf(boardOf([hand13()])).seams).toHaveLength(12);
    expect(planOf(boardOf([layoutMeld(shells, { faces: ['1m', '2m', '3m'], calledIndex: 2 })])).seams).toHaveLength(2);
  });

  it('lifts a hand tile’s shadow without moving it and drops its crevices', () => {
    const hand = layoutHand(shells, {
      faces: ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '3p', '4p'],
      draw: '5p',
    });
    const board = boardOf([hand]);
    const resting = planOf(board);
    const lifted = planOf(board, { zoneId: 'hand-bottom', bodyIndex: 4 });

    const tile = hand.bodies[4];
    const restingDraw = resting.mat.find((draw) => draw.bodyIndex === 4 && draw.zoneIndex === 0)!;
    const liftedDraw = lifted.mat.find((draw) => draw.bodyIndex === 4 && draw.zoneIndex === 0)!;
    expect(liftedDraw.lifted).toBe(true);
    expect(liftedDraw.opacity).toBe(LIFTED_SHADOW_OPACITY);
    expect(liftedDraw.width).toBeCloseTo(restingDraw.width * LIFTED_SHADOW_SCALE, 6);
    // The shadow keeps the resting anchor: the sprite shrinks toward its pivot,
    // so the pivot point is unmoved while the body rises by HAND_LIFT_PX.
    const record = shadows.matShadows[restingDraw.bucket];
    const pivotX = record.pivot.x / record.pixelRatio;
    const pivotY = record.pivot.y / record.pixelRatio;
    expect(liftedDraw.x + pivotX * LIFTED_SHADOW_SCALE).toBeCloseTo(
      restingDraw.x + pivotX,
      6,
    );
    expect(liftedDraw.y + pivotY * LIFTED_SHADOW_SCALE).toBeCloseTo(
      restingDraw.y + pivotY,
      6,
    );
    // …and that anchor is the tile's own resting grid anchor, not its lift.
    expect(restingDraw.x + pivotX).toBeCloseTo(tile.gridX, 6);
    expect(restingDraw.y + pivotY).toBeCloseTo(tile.gridY, 6);
    expect(HAND_LIFT_PX).toBeCloseTo(27, 6);

    const seamsOf = (plan: typeof resting, index: number): string =>
      plan.seams
        .filter((draw) => draw.zoneIndex === 0 && draw.bodyIndex === index)
        .map((draw) => draw.side)
        .sort()
        .join(',');
    // At rest every body to the right of a neighbour carries that joint's band.
    expect(resting.seams).toHaveLength(12);
    expect(seamsOf(resting, 4)).toBe('left');
    // Lifted: its own two joints vanish (12 -> 10) and no neighbour takes over
    // the shaded side of those joints.
    expect(lifted.seams).toHaveLength(10);
    expect(seamsOf(lifted, 4)).toBe('');
    expect(seamsOf(lifted, 2)).toBe('left');
    expect(seamsOf(lifted, 6)).toBe('');
    // A tile two slots away is untouched.
    expect(seamsOf(lifted, 0)).toBe('');
  });

  it('fails loudly when a bucket has no baked mat shadow', () => {
    const broken: ShadowsManifest = {
      ...shadows,
      matShadows: { ...shadows.matShadows, flat_center: undefined as never },
    };
    delete (broken.matShadows as Record<string, unknown>).flat_center;
    const board = boardOf([layoutPond(shells, { side: 'bottom', discards: discards(1) })]);
    expect(() =>
      planShadows(shells, broken, board, {
        seamBands: (shell, side) => seamOverlays.bandFor(shell, side),
      }),
    ).toThrow(/no mat shadow for bucket flat_center/);
  });
});

describe('mat shadow compositing', () => {
  it('merges overlapping penumbras at max alpha instead of double-darkening', () => {
    const row = layoutPond(shells, { side: 'bottom', discards: discards(5) });
    const all = boardOf([row]);

    /**
     * The same board with only the named columns occupied. The zone keeps the
     * full row's normalised bounds, so every sample lands on the same pixels
     * whatever subset is drawn.
     */
    const only = (columns: readonly number[]): ShadowBoard => ({
      zones: [
        {
          zone: {
            ...row,
            bodies: row.bodies.filter((body) => columns.includes(body.cell?.column ?? -1)),
            shadows: row.shadows.filter((body) => columns.includes(body.cell?.column ?? -1)),
          },
          x: 0,
          y: 0,
          scale: 1,
        },
      ],
      width: all.width,
      height: all.height,
    });

    const merged = render(all);
    const pair = render(only([2, 3]));
    const first = render(only([2]));
    const second = render(only([3]));

    // Sample every pixel where the two single-tile shadows overlap.
    let compared = 0;
    let worst = 0;
    for (let y = 0; y < all.height; y += 1) {
      for (let x = 0; x < all.width; x += 1) {
        const a = first.luma(x, y);
        const b = second.luma(x, y);
        if (a === 255 || b === 255) continue;
        compared += 1;
        const darkestOfOne = Math.min(a, b);
        worst = Math.max(worst, Math.abs(pair.luma(x, y) - darkestOfOne));
        // The growing row may never darken a pixel past the darkest single
        // tile's own shadow — that is what "no double darkening" means.
        expect(merged.luma(x, y)).toBeGreaterThanOrEqual(darkestOfOne - 1);
      }
    }
    expect(compared).toBeGreaterThan(100);
    expect(worst).toBeLessThanOrEqual(2);
  });

  it('composites with the measured multiply model', () => {
    const pond = layoutPond(shells, { side: 'bottom', discards: discards(1) });
    const board = boardOf([pond]);
    const { luma } = render(board);
    const record = shadows.matShadows.flat_center;
    let min = 255;
    for (let y = 0; y < board.height; y += 1) {
      for (let x = 0; x < board.width; x += 1) min = Math.min(min, luma(x, y));
    }
    // `alpha = 1 - shadowed/lit`, drawn as a multiply: on white the darkest
    // pixel is 255 * (1 - peak).
    expect(min).toBeCloseTo(255 * (1 - record.alpha.peakAlpha), -0.5);
    // Far from the tile the felt is untouched.
    expect(luma(board.width - 2, board.height - 2)).toBe(255);
  });

  it('fades a lifted tile’s shadow to 0.75 of its own darkness', () => {
    const hand = layoutHand(shells, {
      faces: ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '3p', '4p'],
      draw: '5p',
    });
    const board = boardOf([hand]);
    const resting = render(board);
    const lifted = render(board, { lifted: { zoneId: 'hand-bottom', bodyIndex: 4 } });
    const tile = hand.bodies[4];
    // The shadow sits at the resting anchor in both renders: sample its core.
    const x = board.zones[0].x + tile.gridX;
    const y = board.zones[0].y + tile.gridY + 40;
    const before = resting.luma(x, y);
    const after = lifted.luma(x, y);
    expect(before).toBeLessThan(240);
    // `255 - after` is 0.75 of `255 - before`, allowing for the 0.92 scale.
    expect((255 - after) / (255 - before)).toBeGreaterThan(0.6);
    expect((255 - after) / (255 - before)).toBeLessThan(0.85);
  });

  it('renders at 2x without changing the darkening', () => {
    const pond = layoutPond(shells, { side: 'bottom', discards: discards(3) });
    const board = boardOf([pond]);
    const one = render(board, { ratio: 1 });
    const two = render(board, { ratio: 2 });
    const x = board.zones[0].x + pond.bodies[0].gridX;
    const y = board.zones[0].y + pond.bodies[0].gridY + 30;
    expect(Math.abs(one.luma(x, y) - two.luma(x, y))).toBeLessThanOrEqual(3);
  });

  it('reallocates a mask that grows with the river instead of clipping it', () => {
    const five = layoutPond(shells, { side: 'bottom', discards: discards(5) });
    const board = boardOf([five]);
    const renderer = new BoardShadowRenderer({
      createCanvas: createShadowCanvas,
      board,
      manifest: shells,
      shadows,
      seamOverlays,
      imageFor,
    });
    renderer.update();
    const first = boardCanvas(board);
    renderer.drawMatShadowPass(first.ctx);

    // A sixth discard widens the row, and with it the zone's mask.
    const six = layoutPond(shells, { side: 'bottom', discards: discards(6) });
    const grown = boardOf([six]);
    renderer.setBoard(grown);
    const wide = boardCanvas(grown);
    renderer.drawMatShadowPass(wide.ctx);
    expect(renderer.stats.zoneMasksPainted).toBe(2);

    // The newest tile's shadow reaches past where the five-tile mask ended. A
    // reused, too-small mask would leave that region untouched (255).
    const newest = six.bodies.find((tile) => tile.cell?.column === 5)!;
    const originX = grown.zones[0].x + newest.gridX;
    const originY = grown.zones[0].y + newest.gridY;
    let darkest = 255;
    for (let y = -20; y <= 40; y += 2) {
      for (let x = -30; x <= 40; x += 2) {
        darkest = Math.min(darkest, wide.luma(originX + x, originY + y));
      }
    }
    expect(darkest).toBeLessThan(200);

    // An incrementally grown zone must render exactly what a fresh renderer
    // does: a mask reused at the wrong size would stretch, not just clip.
    const fresh = new BoardShadowRenderer({
      createCanvas: createShadowCanvas,
      board: grown,
      manifest: shells,
      shadows,
      seamOverlays,
      imageFor,
    });
    fresh.update();
    const freshCanvas = boardCanvas(grown);
    fresh.drawMatShadowPass(freshCanvas.ctx);
    const pixels = (target: AtlasCanvas): Uint8ClampedArray =>
      (target.getContext('2d') as unknown as ShadowContext2D).getImageData(
        0,
        0,
        target.width,
        target.height,
      ).data;
    const incremental = pixels(wide.canvas);
    const expected = pixels(freshCanvas.canvas);
    expect(incremental.length).toBe(expected.length);
    let worst = 0;
    for (let index = 0; index < incremental.length; index += 1) {
      worst = Math.max(worst, Math.abs(incremental[index] - expected[index]));
    }
    expect(worst).toBeLessThanOrEqual(1);
  });

  it('repaints only the zone that changed', () => {    const pond = layoutPond(shells, { side: 'bottom', discards: discards(6) });
    const wall = layoutWall(shells, { wall: 'front', count: 4, startIndex: 6 });
    const board = boardOf([pond, wall]);
    const renderer = new BoardShadowRenderer({
      createCanvas: createShadowCanvas,
      board,
      manifest: shells,
      shadows,
      seamOverlays,
      imageFor,
    });
    renderer.update();
    expect(renderer.stats.zoneMasksPainted).toBe(2);
    // A redraw of the same board paints nothing new.
    renderer.update();
    expect(renderer.stats.zoneMasksPainted).toBe(2);

    // One discard lands: only the pond's mask is repainted.
    const grown = layoutPond(shells, { side: 'bottom', discards: discards(7) });
    renderer.setBoard({ ...board, zones: [{ ...board.zones[0], zone: grown }, board.zones[1]] });
    expect(renderer.stats.zoneMasksPainted).toBe(3);
    // Lifting a hand tile does not touch either of these zones.
    renderer.update({ lifted: null });
    expect(renderer.stats.zoneMasksPainted).toBe(3);
    expect(renderer.currentPlan?.mat).toHaveLength(7 + 4);
  });
});

describe('bevel bands', () => {
  const flat = shells.shells.shell_flat_upright;

  it('reads each ring from the sprite edge to the face plate', () => {
    const left = seamBandRect(flat, 'left');
    const right = seamBandRect(flat, 'right');
    const top = seamBandRect(flat, 'top');
    expect(left.x).toBe(flat.padding.left + 1);
    // Starts one pixel in from the silhouette's anti-aliasing, ends at the plate.
    expect(left.width).toBeCloseTo(flat.faceQuad[0][0] - flat.padding.left - 1, 6);
    expect(right.x + right.width).toBe(flat.texWidth - flat.padding.right - 1);
    // The near reveal is 41 px; a contact only shades the chamfer, so it trims.
    expect(seamBandRect(flat, 'bottom').height).toBe(SEAM_BAND_MAX_PX);
    // The top ring is thinner than the minimum band, so it takes the floor.
    expect(top.height).toBe(SEAM_BAND_MIN_PX);
    // Every ring is narrow: a band can never reach the middle of the face.
    for (const side of ['left', 'right', 'top', 'bottom'] as SpriteSide[]) {
      const rect = seamBandRect(flat, side);
      expect(Math.min(rect.width, rect.height)).toBeLessThanOrEqual(SEAM_BAND_MAX_PX);
    }
  });

  it('measures the lit edge, so a joint has one bright side to darken', () => {
    const leftBand = seamOverlays.bandFor(flat, 'left');
    const rightBand = seamOverlays.bandFor(flat, 'right');
    expect(leftBand).not.toBeNull();
    expect(rightBand).not.toBeNull();
    // The committed shell lights the left chamfer; the right one is in shade.
    expect(leftBand!.ringLuma).toBeGreaterThan(rightBand!.ringLuma);
    expect(leftBand!.ringLuma).toBeGreaterThan(SEAM_MIN_RING_LUMA);
    expect(leftBand!.ringCoverage).toBeGreaterThan(0.5);
    // A side wall seen edge-on has no axis-aligned ring on its long edge, so
    // that side yields no band at all instead of inking the transparent margin.
    expect(seamOverlays.bandFor(shells.shells.shell_wall_side_left, 'left')).toBeNull();
  });

  it('maps the mask across the band, band outward and fade inward', () => {
    // One realistic band per side: a thin strip along the edge it names.
    const rects: Record<SpriteSide, { x: number; y: number; width: number; height: number }> = {
      left: { x: 2, y: 2, width: 6, height: 40 },
      right: { x: 32, y: 2, width: 6, height: 40 },
      top: { x: 2, y: 2, width: 40, height: 6 },
      bottom: { x: 2, y: 32, width: 40, height: 6 },
    };
    const shade = (side: SpriteSide): ((x: number, y: number) => number) => {
      const canvas = createShadowCanvas(60, 60);
      const ctx = canvas.getContext('2d') as unknown as ShadowContext2D;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 60, 60);
      const record = seams.seams[side];
      drawMaskInBand(ctx, record, imageFor(record.textureFile)!, rects[side], side, SEAM_OPACITY);
      return (x, y) => {
        const data = ctx.getImageData(x, y, 1, 1).data;
        return Math.round((data[0] + data[1] + data[2]) / 3);
      };
    };
    // Each band is darkest at its outer edge and gone at its inner one.
    const left = shade('left');
    expect(left(2, 20)).toBeLessThan(245);
    expect(left(9, 20)).toBe(255);
    const right = shade('right');
    expect(right(37, 20)).toBeLessThan(245);
    expect(right(30, 20)).toBe(255);
    const top = shade('top');
    expect(top(20, 2)).toBeLessThan(245);
    expect(top(20, 9)).toBe(255);
    const bottom = shade('bottom');
    expect(bottom(20, 37)).toBeLessThan(245);
    expect(bottom(20, 30)).toBe(255);
  });

  it('keeps every band pixel inside the tile’s own silhouette', () => {
    for (const shellId of [
      'shell_flat_upright',
      'shell_flat_sideways',
      'shell_hand_slot_06',
      'shell_wall_side_left',
      'shell_hand_side_left',
    ] as const) {
      const shell = shells.shells[shellId];
      const sprite = imageFor(shell.textureFile)!;
      for (const side of ['left', 'right', 'top', 'bottom'] as SpriteSide[]) {
        const overlay = seamOverlays.overlayFor(shell, side);
        if (!overlay) continue;
        const ctx = overlay!.canvas.getContext('2d') as unknown as ShadowContext2D;
        const band = ctx.getImageData(0, 0, overlay!.canvas.width, overlay!.canvas.height).data;
        const source = createShadowCanvas(shell.texWidth, shell.texHeight);
        const sourceCtx = source.getContext('2d') as unknown as ShadowContext2D;
        sourceCtx.drawImage(sprite as never, 0, 0, shell.texWidth, shell.texHeight);
        const alpha = sourceCtx.getImageData(0, 0, shell.texWidth, shell.texHeight).data;
        let inkPixels = 0;
        let outsideBody = 0;
        let peak = 0;
        let inkOnBody = 0;
        for (let index = 0; index < band.length; index += 4) {
          if (band[index + 3] === 0) continue;
          inkPixels += 1;
          inkOnBody += alpha[index + 3];
          // Nothing may land where the tile is not: the band has to sit on the
          // sprite's own pixels, never on the felt around them.
          if (alpha[index + 3] === 0) outsideBody += 1;
          peak = Math.max(peak, band[index + 3]);
        }
        expect(inkPixels, `${shellId} ${side} drew nothing`).toBeGreaterThan(40);
        expect(outsideBody, `${shellId} ${side} spilled off the body`).toBe(0);
        // …the ink sits on pixels the tile actually covers. A lying tile's top
        // edge is only a couple of pixels of silhouette anti-aliasing, so this
        // is a mean, not a promise that every inked pixel is fully opaque.
        expect(inkOnBody / inkPixels, `${shellId} ${side} sits on the fringe`).toBeGreaterThan(200);
        // …and it is dark enough to be a change at all.
        expect(peak, `${shellId} ${side} is a no-op`).toBeGreaterThan(12);
      }
    }
  });
});

describe('crevice acceptance', () => {
  it('changes nothing outside the bevel band — the face and the felt stay put', () => {
    const row = layoutPond(shells, { side: 'bottom', discards: discards(5) });
    const board = boardOf([row]);
    const plan = planOf(board);
    expect(plan.seams.length).toBeGreaterThan(0);

    /** Bodies + (optionally) their bands, on one canvas. */
    const compose = (withSeams: boolean): Uint8ClampedArray => {
      const canvas = createShadowCanvas(Math.ceil(board.width), Math.ceil(board.height));
      const ctx = canvas.getContext('2d') as unknown as ShadowContext2D;
      ctx.fillStyle = '#8a8a8a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const placement = board.zones[0];
      row.bodies.forEach((tile, index) => {
        const shell = shells.shells[tile.shell];
        const image = imageFor(shell.textureFile)!;
        ctx.drawImage(
          image as never,
          placement.x + tile.drawX,
          placement.y + tile.drawY,
          shell.texWidth,
          shell.texHeight,
        );
        if (!withSeams) return;
        for (const draw of plan.seams) {
          if (draw.zoneIndex !== 0 || draw.bodyIndex !== index) continue;
          const overlay = seamOverlays.overlayFor(shell, draw.side)!;
          ctx.drawImage(
            overlay.canvas as never,
            placement.x + tile.drawX,
            placement.y + tile.drawY,
            shell.texWidth,
            shell.texHeight,
          );
        }
      });
      return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    };

    const before = compose(false);
    const after = compose(true);

    // Every changed pixel must sit inside a drawn band, and every band must be
    // narrower than SEAM_BAND_MAX_PX.
    let changed = 0;
    let outsideBands = 0;
    for (let y = 0; y < board.height; y += 1) {
      for (let x = 0; x < board.width; x += 1) {
        const offset = (y * Math.floor(board.width) + x) * 4;
        if (before[offset] === after[offset]) continue;
        changed += 1;
        let inBand = false;
        for (const draw of plan.seams) {
          const tile = row.bodies[draw.bodyIndex];
          const shell = shells.shells[tile.shell];
          const band = seamOverlays.bandFor(shell, draw.side)!;
          const left = board.zones[0].x + tile.drawX + band.x;
          const top = board.zones[0].y + tile.drawY + band.y;
          if (x < left || x >= left + band.width || y < top || y >= top + band.height) continue;
          inBand = true;
          break;
        }
        if (!inBand) outsideBands += 1;
      }
    }
    expect(changed).toBeGreaterThan(200);
    expect(outsideBands).toBe(0);

    // The painted face is untouched: no changed pixel inside any plate.
    let insideFace = 0;
    for (let y = 0; y < board.height; y += 1) {
      for (let x = 0; x < board.width; x += 1) {
        const offset = (y * Math.floor(board.width) + x) * 4;
        if (before[offset] === after[offset]) continue;
        for (const tile of row.bodies) {
          const shell = shells.shells[tile.shell];
          const [tl, , , bl] = shell.faceQuad;
          const x0 = board.zones[0].x + tile.drawX + Math.min(tl[0], bl[0]) + 1;
          const x1 = board.zones[0].x + tile.drawX + Math.max(...shell.faceQuad.map((c) => c[0])) - 1;
          const y0 = board.zones[0].y + tile.drawY + Math.min(...shell.faceQuad.map((c) => c[1])) + 1;
          const y1 = board.zones[0].y + tile.drawY + Math.max(...shell.faceQuad.map((c) => c[1])) - 1;
          if (x > x0 && x < x1 && y > y0 && y < y1) insideFace += 1;
        }
      }
    }
    expect(insideFace).toBe(0);
  });
});

describe('zone masks', () => {
  it('bounds each zone mask by its own sprites', () => {
    const pond = layoutPond(shells, { side: 'bottom', discards: discards(3) });
    const wall = layoutWall(shells, { wall: 'front', count: 2, startIndex: 8 });
    const board = boardOf([pond, wall]);
    const plan = planOf(board);
    const masks = zoneShadowMasks(plan, board);
    expect(masks).toHaveLength(2);
    for (const mask of masks) {
      for (const draw of mask.draws) {
        expect(draw.x).toBeGreaterThanOrEqual(mask.x);
        expect(draw.y).toBeGreaterThanOrEqual(mask.y);
        expect(draw.x + draw.width).toBeLessThanOrEqual(mask.x + mask.width);
        expect(draw.y + draw.height).toBeLessThanOrEqual(mask.y + mask.height);
      }
    }
  });
});
