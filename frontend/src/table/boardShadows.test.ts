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
  SEAM_OPACITY,
  buildZoneAdjacency,
  drawMaskOnQuad,
  faceAxes,
  faceSideOf,
  planShadows,
  zoneShadowMasks,
} from './boardShadows';
import type { ShadowBoard, ShadowContext2D, ShadowImage, ShadowZonePlacement } from './boardShadows';
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
    seams,
    imageFor,
    pixelRatio: options.ratio ?? 1,
  });
  renderer.update({ lifted: options.lifted ?? null });
  const { ctx, luma } = boardCanvas(board);
  renderer.drawMatShadowPass(ctx);
  return { renderer, ctx, luma };
}

describe('face axes and sides', () => {
  it('reads a shell plate’s local axes from its quad', () => {
    expect(faceAxes(shells.shells.shell_flat_upright)).toEqual({ right: [1, 0], down: [0, 1] });
    // A 90° counter-clockwise plate: local +u points up the screen.
    expect(faceAxes(shells.shells.shell_flat_sideways)).toEqual({ right: [0, -1], down: [1, 0] });
    expect(faceAxes(shells.shells.shell_flat_sideways_270)).toEqual({ right: [0, 1], down: [-1, 0] });
  });

  it('maps a screen direction onto the plate edge it faces', () => {
    const upright = { right: [1, 0] as const, down: [0, 1] as const };
    expect(faceSideOf(upright, 50, 0)).toBe('right');
    expect(faceSideOf(upright, -50, 4)).toBe('left');
    expect(faceSideOf(upright, 0, 50)).toBe('bottom');
    expect(faceSideOf(upright, 3, -50)).toBe('top');
    const sideways = { right: [0, -1] as const, down: [1, 0] as const };
    expect(faceSideOf(sideways, 0, -50)).toBe('right');
    expect(faceSideOf(sideways, 0, 50)).toBe('left');
    expect(faceSideOf(sideways, 50, 0)).toBe('bottom');
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
    const plan = planShadows(shells, shadows, seams, board);
    expect(wall.bodies).toHaveLength(34);
    expect(plan.mat).toHaveLength(17);
    expect(plan.mat.every((draw) => draw.bucket.startsWith('wall_horiz_'))).toBe(true);
  });

  it('draws a stack decal only while the upper tier is present', () => {
    const wall = layoutWall(shells, { wall: 'back', count: 3, startIndex: 7 });
    const withTier = planShadows(shells, shadows, seams, boardOf([wall]));
    expect(withTier.stacks).toHaveLength(3);
    expect(new Set(withTier.stacks.map((draw) => draw.seat))).toEqual(new Set(['north']));
    expect(withTier.stacks.every((draw) => draw.textureFile === 'shadows/shadow_wall_stack_north.png')).toBe(true);

    // A stack whose upper tile is gone from the plan (drawn off the wall) has
    // no decal: the pass reads the live cells, it is not baked.
    const broken: LayoutZone = {
      ...wall,
      bodies: wall.bodies.filter((tile) => !(tile.cell?.tier === 1 && tile.cell.slot === 8)),
    };
    const without = planShadows(shells, shadows, seams, boardOf([broken]));
    expect(without.stacks).toHaveLength(2);
    expect(without.stacks.some((draw) => draw.bodyIndex === 2)).toBe(false);
  });

  it('anchors a wall stack decal at the lower tier, under the upper body', () => {
    const wall = layoutWall(shells, { wall: 'front', count: 1, startIndex: 8 });
    const board = boardOf([wall]);
    const plan = planShadows(shells, shadows, seams, board);
    const lower = wall.bodies.find((tile) => tile.cell?.tier === 0);
    const stack = plan.stacks[0];
    const record = shadows.wallStack.seats.south;
    expect(lower).toBeDefined();
    expect(stack.bodyIndex).toBe(0);
    expect(stack.x).toBeCloseTo(lower!.gridX - record.pivot.x / record.pixelRatio, 6);
    expect(stack.y).toBeCloseTo(lower!.gridY - record.pivot.y / record.pixelRatio, 6);
  });

  it('reports open edges as no crevice and occupied edges as one', () => {
    const pond = layoutPond(shells, { side: 'bottom', discards: discards(1) });
    const board = boardOf([pond]);
    const plan = planShadows(shells, shadows, seams, board);
    expect(plan.seams).toHaveLength(0);

    const row = layoutPond(shells, { side: 'bottom', discards: discards(5) });
    const grown = planShadows(shells, shadows, seams, boardOf([row]));
    // Five in a row: four gaps, two masks each.
    expect(grown.seams).toHaveLength(8);
    expect(grown.seams.every((draw) => draw.opacity === SEAM_OPACITY)).toBe(true);
    expect(new Set(grown.seams.map((draw) => draw.textureFile))).toEqual(
      new Set(['shadows/ao_seam_left.png', 'shadows/ao_seam_right.png']),
    );
  });

  it('lifts a hand tile’s shadow without moving it and drops its crevices', () => {
    const hand = layoutHand(shells, {
      faces: ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '3p', '4p'],
      draw: '5p',
    });
    const board = boardOf([hand]);
    const resting = planShadows(shells, shadows, seams, board);
    const lifted = planShadows(shells, shadows, seams, board, {
      lifted: { zoneId: 'hand-bottom', bodyIndex: 4 },
    });

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
    expect(seamsOf(resting, 4)).toBe('left,right');
    expect(seamsOf(lifted, 4)).toBe('');
    // Its immediate neighbours lose the crevice facing it, and keep the other:
    // body 2 sits left of the lifted tile, body 6 to its right.
    expect(seamsOf(lifted, 2)).toBe('left');
    expect(seamsOf(lifted, 6)).toBe('right');
    // A tile two slots away is untouched.
    expect(seamsOf(lifted, 0)).toBe('right');
  });

  it('fails loudly when a bucket has no baked mat shadow', () => {
    const broken: ShadowsManifest = {
      ...shadows,
      matShadows: { ...shadows.matShadows, flat_center: undefined as never },
    };
    delete (broken.matShadows as Record<string, unknown>).flat_center;
    const board = boardOf([layoutPond(shells, { side: 'bottom', discards: discards(1) })]);
    expect(() => planShadows(shells, broken, seams, board)).toThrow(/no mat shadow for bucket flat_center/);
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
      seams,
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
      seams,
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
      seams,
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

describe('crevice mask mapping', () => {
  const quad: readonly [readonly [number, number], readonly [number, number], readonly [number, number], readonly [number, number]] = [
    [10, 10],
    [70, 10],
    [70, 130],
    [10, 130],
  ];

  function draw(side: 'left' | 'right' | 'top' | 'bottom'): ReturnType<typeof boardCanvas> {
    const canvas = createShadowCanvas(80, 140);
    const ctx = canvas.getContext('2d') as unknown as ShadowContext2D;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 80, 140);
    const mask = imageFor(seams.seams[side].textureFile);
    expect(mask).not.toBeNull();
    drawMaskOnQuad(ctx, mask!, quad as never, side, 1);
    const luma = (x: number, y: number): number => {
      const data = ctx.getImageData(x, y, 1, 1).data;
      return Math.round((data[0] + data[1] + data[2]) / 3);
    };
    return { canvas, ctx, luma };
  }

  it('puts each band on the plate edge it names and leaves the rest white', () => {
    const left = draw('left');
    expect(left.luma(11, 70)).toBeLessThan(240);
    expect(left.luma(66, 70)).toBe(255);
    const right = draw('right');
    expect(right.luma(69, 70)).toBeLessThan(240);
    expect(right.luma(14, 70)).toBe(255);
    const top = draw('top');
    expect(top.luma(40, 11)).toBeLessThan(240);
    expect(top.luma(40, 126)).toBe(255);
    const bottom = draw('bottom');
    expect(bottom.luma(40, 129)).toBeLessThan(240);
    expect(bottom.luma(40, 14)).toBe(255);
  });

  it('uses the mask’s own 35 % ink at the requested share', () => {
    const canvas = createShadowCanvas(80, 140);
    const ctx = canvas.getContext('2d') as unknown as ShadowContext2D;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 80, 140);
    drawMaskOnQuad(ctx, imageFor(seams.seams.left.textureFile)!, quad as never, 'left', SEAM_OPACITY);
    const pixel = ctx.getImageData(11, 70, 1, 1).data;
    const luma = (pixel[0] + pixel[1] + pixel[2]) / 3;
    // 35 % ink at 60 % share ≈ 21 % darkening.
    expect(luma).toBeGreaterThan(255 * (1 - 0.35 * 0.8));
    expect(luma).toBeLessThan(255 * (1 - 0.35 * 0.4));
  });
});

describe('zone masks', () => {
  it('bounds each zone mask by its own sprites', () => {
    const pond = layoutPond(shells, { side: 'bottom', discards: discards(3) });
    const wall = layoutWall(shells, { wall: 'front', count: 2, startIndex: 8 });
    const board = boardOf([pond, wall]);
    const plan = planShadows(shells, shadows, seams, board);
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
