import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { boardLayoutFromState, meldKindOf, wallPairsForRemaining } from './boardFromState';
import {
  FELT_RUNTIME,
  HAND_MELD_GAP_PX,
  MAX_WALL_PAIRS_PER_SIDE,
  POND_COLUMNS,
  POND_ROWS,
  SEAT_SIDES,
  boardMetrics,
  boardToCss,
  fitBoardToViewport,
  layoutBoard,
} from './boardLayout';
import type {
  BoardLayout,
  BoardLayoutInput,
  BoardRect,
  MeldInput,
  PondDiscardInput,
  SeatHandInput,
  SeatSide,
  TilePlacement,
} from './boardLayout';
import { parseShellsManifest } from './shellManifest';
import type { ShellsManifest } from './shellManifest';
import type { GameState, PlayerState } from '../types/game';
import type { TileFaceId } from './tiles';

const tableDir = fileURLToPath(new URL('../../public/table/', import.meta.url));
const shells = parseShellsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')),
);
const metrics = boardMetrics(shells);

const flat = shells.shells.shell_flat_upright;
const sideways = shells.shells.shell_flat_sideways;
const standing = shells.shells.shell_hand_standing;
const wallHorizontal = shells.shells.shell_wall_horizontal;
const sideLeft = shells.shells.shell_wall_side_left;
const sideRight = shells.shells.shell_wall_side_right;

/** A deterministic list of distinct faces for a hand. */
const FACE_ORDER: readonly TileFaceId[] = [
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
];

function handFaces(count: number): TileFaceId[] {
  return FACE_ORDER.slice(0, count);
}

function pond(count: number, riichiIndex: number | null = null): PondDiscardInput[] {
  return Array.from({ length: count }, (_value, index) => ({
    face: FACE_ORDER[index % FACE_ORDER.length],
    riichi: index === riichiIndex,
  }));
}

function meld(kind: MeldInput['kind'], count: number, offset = 0): MeldInput {
  return { kind, tiles: FACE_ORDER.slice(offset, offset + count) };
}

function fullBoardInput(): BoardLayoutInput {
  return {
    hand: handFaces(10),
    draw: '5p',
    melds: [meld('pon', 3, 3)],
    hands: {
      top: { hand: handFaces(10), melds: [meld('chi', 3, 6)] },
      right: { hand: handFaces(13) },
      left: { hand: handFaces(13) },
    },
    ponds: {
      bottom: pond(9, 3),
      right: pond(7, 0),
      top: pond(12, 5),
      left: pond(4),
    },
    wallPairsPerSide: MAX_WALL_PAIRS_PER_SIDE,
  };
}

const full: BoardLayout = layoutBoard(shells, fullBoardInput());

function placementsOf(layout: BoardLayout, side: SeatSide, count: number): TilePlacement[] {
  return Array.from({ length: count }, (_value, index) => {
    const placement = layout.placements.find(
      (candidate) => candidate.id === `${side}-pond:${index}`,
    );
    if (!placement) throw new Error(`missing ${side}-pond:${index}`);
    return placement;
  });
}

function wallPlacements(
  layout: BoardLayout,
  side: SeatSide,
  tier: 'lower' | 'upper',
  count = layout.wallPairsPerSide,
): TilePlacement[] {
  return Array.from({ length: count }, (_value, index) => {
    const placement = layout.placements.find(
      (candidate) => candidate.id === `${side}-wall:${tier}:${index}`,
    );
    if (!placement) throw new Error(`missing ${side}-wall:${tier}:${index}`);
    return placement;
  });
}

function seatHandPlacements(layout: BoardLayout, side: SeatSide): TilePlacement[] {
  return layout.placements.filter(
    (placement) => placement.zone === 'hand' && placement.seat === side,
  );
}

function right(rect: BoardRect): number {
  return rect.x + rect.width;
}

function bottom(rect: BoardRect): number {
  return rect.y + rect.height;
}

function rectContains(outer: BoardRect, inner: BoardRect, epsilon = 1e-6): boolean {
  return (
    inner.x >= outer.x - epsilon &&
    inner.y >= outer.y - epsilon &&
    right(inner) <= right(outer) + epsilon &&
    bottom(inner) <= bottom(outer) + epsilon
  );
}

function rectsOverlap(left: BoardRect, rightRect: BoardRect, epsilon = 1e-6): boolean {
  return (
    left.x < right(rightRect) - epsilon &&
    rightRect.x < right(left) - epsilon &&
    left.y < bottom(rightRect) - epsilon &&
    rightRect.y < bottom(left) - epsilon
  );
}

function zoneOf(layout: BoardLayout, placement: TilePlacement, seat = placement.seat): BoardRect {
  return placement.zone === 'hand'
    ? layout.metrics.zones.hand[seat]
    : placement.zone === 'pond'
      ? layout.metrics.zones.ponds[seat]
      : layout.metrics.zones.walls[seat];
}

describe('board metrics', () => {
  it('derives the 712 x 704 board and every zone from the manifest', () => {
    expect(metrics.board).toEqual({ width: 712, height: 704 });
    expect(metrics.zones.reserve.x).toBe(244);
    expect(metrics.zones.reserve.y).toBeCloseTo(293.91, 6);
    expect(metrics.zones.reserve.width).toBe(224);
    expect(metrics.zones.reserve.height).toBe(120);
    // 6 x 35.88 + body, with a 54 px sideways tile possible anywhere.
    expect(metrics.zones.ponds.bottom.width).toBeCloseTo(233.52, 6);
    expect(metrics.zones.ponds.bottom.height).toBeCloseTo(147.2, 6);
    // Side rows run vertically: 6 x 47.10 tall, 3 rows across.
    expect(metrics.zones.ponds.left.height).toBeCloseTo(288.5, 6);
    expect(metrics.zones.ponds.left.width).toBeCloseTo(125.76, 6);
    // Hand bands: horizontal above/below the walls, vertical outside them.
    const handZone = (side: SeatSide) => metrics.zones.hand[side];
    expect(handZone('top').x).toBeCloseTo(58.24, 6);
    expect(handZone('top').y).toBe(8);
    expect(handZone('top').width).toBeCloseTo(595.76, 6);
    expect(handZone('top').height).toBe(54);
    expect(handZone('bottom').x).toBeCloseTo(58.24, 6);
    expect(handZone('bottom').y).toBeCloseTo(641.11, 6);
    expect(handZone('left').x).toBeCloseTo(8.24, 6);
    expect(handZone('left').y).toBe(8);
    expect(handZone('left').width).toBe(42);
    expect(handZone('left').height).toBe(688);
    expect(handZone('right').x).toBe(662);
    expect(handZone('right').width).toBe(42);
  });

  it('keeps every zone inside the board and pairwise disjoint at the full-board worst case', () => {
    const zones: Array<{ name: string; rect: BoardRect }> = [
      ...SEAT_SIDES.map((side) => ({ name: `hand-${side}`, rect: metrics.zones.hand[side] })),
      { name: 'reserve', rect: metrics.zones.reserve },
      ...SEAT_SIDES.map((side) => ({ name: `pond-${side}`, rect: metrics.zones.ponds[side] })),
      ...SEAT_SIDES.map((side) => ({ name: `wall-${side}`, rect: metrics.zones.walls[side] })),
    ];
    for (const zone of zones) {
      expect(rectContains({ x: 0, y: 0, ...metrics.board }, zone.rect), zone.name).toBe(true);
    }
    for (let left = 0; left < zones.length; left += 1) {
      for (let rightIndex = left + 1; rightIndex < zones.length; rightIndex += 1) {
        expect(
          rectsOverlap(zones[left].rect, zones[rightIndex].rect),
          `${zones[left].name} overlaps ${zones[rightIndex].name}`,
        ).toBe(false);
      }
    }
  });

  it('lays the board out outward-in as hand -> wall -> pond -> compass on every edge', () => {
    expect(right(metrics.zones.hand.left)).toBeLessThan(metrics.zones.walls.left.x);
    expect(right(metrics.zones.walls.left)).toBeLessThan(metrics.zones.ponds.left.x);
    expect(right(metrics.zones.ponds.left)).toBeLessThan(metrics.zones.reserve.x);
    expect(metrics.zones.walls.top.y).toBeGreaterThan(bottom(metrics.zones.hand.top));
    expect(metrics.zones.ponds.top.y).toBeGreaterThan(bottom(metrics.zones.walls.top));
    expect(metrics.zones.reserve.y).toBeGreaterThan(bottom(metrics.zones.ponds.top));
    expect(metrics.zones.ponds.bottom.y).toBeGreaterThan(bottom(metrics.zones.reserve));
    expect(metrics.zones.walls.bottom.y).toBeGreaterThan(bottom(metrics.zones.ponds.bottom));
    expect(metrics.zones.hand.bottom.y).toBeGreaterThan(bottom(metrics.zones.walls.bottom));
  });

  it('reserves a compass region but places no tile in it', () => {
    for (const placement of full.placements) {
      expect(rectsOverlap(placement.advanceRect, metrics.zones.reserve)).toBe(false);
    }
  });
});

describe('anchor mapping', () => {
  it('puts every draw position at grid minus the shell anchor, never the texture origin', () => {
    expect(full.placements.length).toBeGreaterThan(0);
    for (const placement of full.placements) {
      const shell = shells.shells[placement.shell];
      expect(placement.drawX).toBeCloseTo(placement.gridX - shell.anchorX, 10);
      expect(placement.drawY).toBeCloseTo(placement.gridY - shell.anchorY, 10);
      expect(placement.advanceRect).toEqual({
        x: placement.gridX,
        y: placement.gridY,
        width: shell.advanceWidth,
        height: shell.advanceHeight,
      });
      expect(placement.bodyRect).toBe(placement.advanceRect);
    }
  });

  it('keeps every logical body inside the board and inside its own zone', () => {
    for (const placement of full.placements) {
      expect(rectContains(zoneOf(full, placement), placement.advanceRect), placement.id).toBe(
        true,
      );
      expect(rectContains({ x: 0, y: 0, ...full.board }, placement.advanceRect)).toBe(true);
    }
  });
});

describe('player hand', () => {
  it('steps concealed tiles by advanceWidth and leaves the logical body rect', () => {
    const hand = layoutBoard(shells, { hand: handFaces(13) }).placements
      .filter((placement) => placement.seat === 'bottom' && placement.kind === 'hand')
      .sort((left, rightTile) => left.gridX - rightTile.gridX);
    expect(hand).toHaveLength(13);
    expect(hand.every((placement) => placement.shell === 'shell_hand_standing')).toBe(true);
    for (let index = 1; index < hand.length; index += 1) {
      expect(hand[index].gridX - hand[index - 1].gridX).toBeCloseTo(standing.advanceWidth, 10);
      expect(hand[index].gridY).toBe(hand[0].gridY);
    }
    for (const placement of hand) {
      expect(placement.advanceRect.width).toBe(standing.advanceWidth);
      expect(placement.advanceRect.height).toBe(standing.advanceHeight);
    }
  });

  it('adds a 0.35 * advanceWidth gap before the drawn tile', () => {
    const layout = layoutBoard(shells, { hand: handFaces(13), draw: '5p' });
    const concealed = layout.placements
      .filter((placement) => placement.seat === 'bottom' && placement.kind === 'hand')
      .sort((left, rightTile) => left.gridX - rightTile.gridX);
    const draw = layout.placements.find((placement) => placement.kind === 'draw');
    expect(draw).toBeDefined();
    const lastConcealed = concealed[concealed.length - 1];
    expect(draw!.gridX).toBeCloseTo(
      lastConcealed.gridX + standing.advanceWidth + 0.35 * standing.advanceWidth,
      10,
    );
    expect(draw!.gridY).toBe(lastConcealed.gridY);
  });

  it('centres a 13-tile hand and its draw inside the hand band', () => {
    const layout = layoutBoard(shells, { hand: handFaces(13), draw: '5p' });
    const hand = seatHandPlacements(layout, 'bottom').sort(
      (left, rightTile) => left.gridX - rightTile.gridX,
    );
    const first = hand[0];
    const draw = hand[hand.length - 1];
    const band = layout.metrics.zones.hand.bottom;
    expect(first.gridX - band.x).toBeCloseTo(right(band) - right(draw.advanceRect), 10);
    expect(first.gridX - band.x).toBeGreaterThan(0);
  });

  it('puts the human calls at the right-hand end, after the draw', () => {
    const layout = layoutBoard(shells, {
      hand: handFaces(10),
      draw: '5p',
      melds: [meld('pon', 3, 3)],
    });
    const concealed = layout.placements
      .filter((placement) => placement.seat === 'bottom' && placement.kind === 'hand')
      .sort((left, rightTile) => left.gridX - rightTile.gridX);
    const draw = layout.placements.find((placement) => placement.kind === 'draw')!;
    const melds = layout.placements
      .filter((placement) => placement.kind === 'meld')
      .sort((left, rightTile) => left.gridX - rightTile.gridX);

    expect(concealed).toHaveLength(10);
    expect(melds).toHaveLength(3);
    expect(melds.every((placement) => placement.shell === 'shell_flat_upright')).toBe(true);
    expect(melds[0].gridX).toBeGreaterThan(draw.gridX);
    expect(melds[0].gridX - draw.gridX).toBeCloseTo(
      draw.advanceRect.width + HAND_MELD_GAP_PX,
      10,
    );
    // A meld is one px shorter than a standing tile and bottom-aligns.
    expect(melds[0].gridY).toBeCloseTo(
      draw.gridY + standing.advanceHeight - flat.advanceHeight,
      10,
    );
    for (let index = 1; index < melds.length; index += 1) {
      expect(melds[index].gridX - melds[index - 1].gridX).toBeCloseTo(
        Math.abs(flat.gridStepPx.x[0]),
        10,
      );
    }
  });

  it('places a drawless hand symmetrically too', () => {
    const layout = layoutBoard(shells, { hand: handFaces(13) });
    const hand = seatHandPlacements(layout, 'bottom').sort(
      (left, rightTile) => left.gridX - rightTile.gridX,
    );
    const band = layout.metrics.zones.hand.bottom;
    expect(hand).toHaveLength(13);
    expect(hand[0].gridX - band.x).toBeCloseTo(right(band) - right(hand[12].advanceRect), 10);
  });
});

describe('opponent hands and melds', () => {
  it('draws the top hand as a top-down row of backs above the top wall', () => {
    const top = seatHandPlacements(full, 'top')
      .filter((placement) => placement.kind === 'hand')
      .sort(
      (left, rightTile) => left.gridX - rightTile.gridX,
    );
    expect(top).toHaveLength(10);
    expect(top.every((placement) => placement.shell === 'shell_wall_horizontal')).toBe(true);
    expect(top.every((placement) => placement.kind === 'hand')).toBe(true);
    for (let index = 1; index < top.length; index += 1) {
      expect(top[index].gridX - top[index - 1].gridX).toBeCloseTo(
        Math.abs(wallHorizontal.gridStepPx.x[0]),
        10,
      );
      expect(top[index].gridY).toBe(top[0].gridY);
    }
    expect(top[0].gridY).toBe(full.metrics.zones.hand.top.y);
    expect(rectContains(full.metrics.zones.hand.top, top[0].advanceRect)).toBe(true);
  });

  it('draws the side hands as vertical columns of obliquely rolled backs', () => {
    for (const side of ['left', 'right'] as const) {
      const column = seatHandPlacements(full, side).sort(
        (left, rightTile) => left.gridY - rightTile.gridY,
      );
      const shell = side === 'left' ? sideLeft : sideRight;
      expect(column).toHaveLength(13);
      expect(column.every((placement) => placement.shell === `shell_wall_side_${side}`)).toBe(
        true,
      );
      for (let index = 1; index < column.length; index += 1) {
        expect(column[index].gridY - column[index - 1].gridY).toBeCloseTo(
          shell.gridStepPx.y[1],
          10,
        );
        expect(column[index].gridX).toBe(column[0].gridX);
      }
    }
  });

  it('puts each seat’s calls at its own right-hand end of the band', () => {
    const layout = layoutBoard(shells, {
      hands: {
        bottom: { hand: handFaces(10), melds: [meld('pon', 3)] },
        top: { hand: handFaces(10), melds: [meld('pon', 3)] },
        left: { hand: handFaces(10), melds: [meld('pon', 3)] },
        right: { hand: handFaces(10), melds: [meld('pon', 3)] },
      },
    });
    const meldOf = (side: SeatSide): TilePlacement[] =>
      layout.placements.filter(
        (placement) => placement.seat === side && placement.kind === 'meld',
      );
    const concealedOf = (side: SeatSide): TilePlacement[] =>
      layout.placements.filter(
        (placement) => placement.seat === side && placement.kind === 'hand',
      );

    const bottomMelds = meldOf('bottom');
    const bottomHand = concealedOf('bottom');
    expect(Math.min(...bottomMelds.map((placement) => placement.gridX))).toBeGreaterThan(
      Math.max(...bottomHand.map((placement) => placement.gridX)),
    );

    const topMelds = meldOf('top');
    const topHand = concealedOf('top');
    expect(Math.max(...topMelds.map((placement) => placement.gridX))).toBeLessThan(
      Math.min(...topHand.map((placement) => placement.gridX)),
    );

    const leftMelds = meldOf('left');
    const leftHand = concealedOf('left');
    expect(Math.min(...leftMelds.map((placement) => placement.gridY))).toBeGreaterThan(
      Math.max(...leftHand.map((placement) => placement.gridY)),
    );

    const rightMelds = meldOf('right');
    const rightHand = concealedOf('right');
    expect(Math.max(...rightMelds.map((placement) => placement.gridY))).toBeLessThan(
      Math.min(...rightHand.map((placement) => placement.gridY)),
    );

    for (const placement of layout.placements.filter((entry) => entry.kind === 'meld')) {
      expect(placement.shell).toBe('shell_flat_upright');
      expect(rectContains(zoneOf(layout, placement), placement.advanceRect)).toBe(true);
    }
  });

  it('fits a four-call hand plus its singleton inside every band', () => {
    const fourCalls: MeldInput[] = [
      meld('pon', 3, 0),
      meld('chi', 3, 3),
      meld('pon', 3, 6),
      meld('kan', 4, 8),
    ];
    for (const side of SEAT_SIDES) {
      const hands: Partial<Record<SeatSide, SeatHandInput>> = {
        [side]: { hand: handFaces(1), melds: fourCalls },
      };
      const layout = layoutBoard(shells, { hands, wallPairsPerSide: 0 });
      const band = layout.metrics.zones.hand[side];
      const tiles = seatHandPlacements(layout, side);
      expect(tiles).toHaveLength(14);
      for (const placement of tiles) {
        expect(rectContains(band, placement.advanceRect), `${side} ${placement.id}`).toBe(true);
      }
    }
  });

  it('compresses a pathological run instead of escaping the band', () => {
    // Six calls is not a legal hand; the layout must still contain it.
    const many = Array.from({ length: 6 }, (_value, index) => meld('kan', 4, index % 3));
    for (const side of SEAT_SIDES) {
      const layout = layoutBoard(shells, {
        hands: { [side]: { hand: handFaces(1), melds: many } },
        wallPairsPerSide: 0,
      });
      const band = layout.metrics.zones.hand[side];
      for (const placement of seatHandPlacements(layout, side)) {
        expect(rectContains(band, placement.advanceRect), `${side} ${placement.id}`).toBe(true);
      }
    }
  });

  it('counts concealed tiles, draws, calls, discards and wall tiles separately', () => {
    expect(full.counts).toEqual({
      hand: 10 + 10 + 13 + 13,
      draw: 1,
      melds: 3 + 3,
      ponds: 9 + 7 + 12 + 4,
      walls: MAX_WALL_PAIRS_PER_SIDE * 8,
    });
    expect(full.placements).toHaveLength(
      full.counts.hand + full.counts.draw + full.counts.melds + full.counts.ponds + full.counts.walls,
    );
  });
});

describe('discard ponds', () => {
  it('wraps every seat after six columns and steps toward the compass', () => {
    for (const side of SEAT_SIDES) {
      const layout = layoutBoard(shells, { ponds: { [side]: pond(14) } });
      const cells = placementsOf(layout, side, 14);
      const zone = layout.metrics.zones.ponds[side];
      const frame = layout.metrics.ponds[side];
      const at = (index: number) => ({
        x: frame.originX + (index % POND_COLUMNS) * frame.alongPitchPx * frame.alongX +
          Math.floor(index / POND_COLUMNS) * frame.awayPitchPx * frame.awayX,
        y: frame.originY + (index % POND_COLUMNS) * frame.alongPitchPx * frame.alongY +
          Math.floor(index / POND_COLUMNS) * frame.awayPitchPx * frame.awayY,
      });

      expect(cells[0].gridX).toBeCloseTo(at(0).x, 10);
      expect(cells[0].gridY).toBeCloseTo(at(0).y, 10);
      expect(cells[5].gridX).toBeCloseTo(at(5).x, 10);
      expect(cells[5].gridY).toBeCloseTo(at(5).y, 10);
      // The 7th discard starts a new row at column 0.
      expect(cells[6].gridX).toBeCloseTo(at(6).x, 10);
      expect(cells[6].gridY).toBeCloseTo(at(6).y, 10);
      expect(cells[13].gridX).toBeCloseTo(at(13).x, 10);
      expect(cells[13].gridY).toBeCloseTo(at(13).y, 10);
      expect(Math.floor(13 / POND_COLUMNS)).toBe(POND_ROWS - 1);

      expect(cells[5].gridX - cells[4].gridX).toBeCloseTo(
        frame.axis === 'horizontal' ? frame.alongPitchPx : 0,
        10,
      );
      expect(cells[5].gridY - cells[4].gridY).toBeCloseTo(
        frame.axis === 'vertical' ? frame.alongPitchPx : 0,
        10,
      );
      expect(cells[6].gridX - cells[0].gridX).toBeCloseTo(frame.axis === 'horizontal' ? 0 : frame.awayPitchPx * frame.awayX, 10);
      expect(cells[6].gridY - cells[0].gridY).toBeCloseTo(frame.axis === 'horizontal' ? frame.awayPitchPx * frame.awayY : 0, 10);
      expect(rectContains(zone, cells[13].advanceRect)).toBe(true);
    }
  });

  it('lays out the same tile identically in all four seats (uniform shell and size)', () => {
    for (const side of SEAT_SIDES) {
      const layout = layoutBoard(shells, { ponds: { [side]: pond(6) } });
      const cells = placementsOf(layout, side, 6);
      for (const cell of cells) {
        expect(cell.shell).toBe('shell_flat_upright');
        expect(cell.advanceRect.width).toBe(flat.advanceWidth);
        expect(cell.advanceRect.height).toBe(flat.advanceHeight);
      }
      // Every seat's pond block uses the same six tile pitches.
      for (let index = 1; index < cells.length; index += 1) {
        expect(cells[index].gridX - cells[index - 1].gridX).toBeCloseTo(
          layout.metrics.ponds[side].axis === 'horizontal'
            ? layout.metrics.ponds[side].alongPitchPx
            : 0,
          10,
        );
        expect(cells[index].gridY - cells[index - 1].gridY).toBeCloseTo(
          layout.metrics.ponds[side].axis === 'vertical'
            ? layout.metrics.ponds[side].alongPitchPx
            : 0,
          10,
        );
      }
    }
  });

  it('advances a Riichi tile by the sideways shell and shifts the rest of the row', () => {
    const normal = placementsOf(layoutBoard(shells, { ponds: { bottom: pond(9) } }), 'bottom', 9);
    const layout = layoutBoard(shells, { ponds: { bottom: pond(9, 1) } });
    const riichi = placementsOf(layout, 'bottom', 9);

    expect(riichi[1].shell).toBe('shell_flat_sideways');
    expect(riichi[1].advanceRect).toMatchObject({
      width: sideways.advanceWidth,
      height: sideways.advanceHeight,
    });
    expect(riichi[1].gridX).toBeCloseTo(normal[1].gridX, 10);
    const shift = Math.abs(sideways.gridStepPx.y[0]) - Math.abs(flat.gridStepPx.x[0]);
    expect(shift).toBeCloseTo(16.12, 6);
    for (let index = 2; index < 6; index += 1) {
      expect(riichi[index].gridX - normal[index].gridX).toBeCloseTo(shift, 6);
    }
    // The new row is unaffected by a Riichi tile in the previous row.
    expect(riichi[6].gridX).toBeCloseTo(normal[6].gridX, 10);
    expect(riichi[6].gridY).toBeCloseTo(normal[6].gridY, 10);
  });

  it('advances a Riichi tile down a side pond and keeps it sideways in every seat', () => {
    const normal = placementsOf(layoutBoard(shells, { ponds: { left: pond(9) } }), 'left', 9);
    const layout = layoutBoard(shells, { ponds: { left: pond(9, 1) } });
    const riichi = placementsOf(layout, 'left', 9);
    expect(riichi[1].shell).toBe('shell_flat_sideways');
    const shift = Math.abs(sideways.gridStepPx.x[1]) - Math.abs(flat.gridStepPx.y[1]);
    expect(shift).toBeCloseTo(-8.69, 6);
    for (let index = 2; index < 6; index += 1) {
      expect(riichi[index].gridY - normal[index].gridY).toBeCloseTo(shift, 6);
    }
    expect(riichi[6].gridY).toBeCloseTo(normal[6].gridY, 10);

    for (const side of SEAT_SIDES) {
      const seatLayout = layoutBoard(shells, { ponds: { [side]: pond(6, 0) } });
      const first = placementsOf(seatLayout, side, 6)[0];
      expect(first.shell).toBe('shell_flat_sideways');
      expect(first.advanceRect).toMatchObject({
        width: sideways.advanceWidth,
        height: sideways.advanceHeight,
      });
    }
  });

  it('paints a Riichi tile after its neighbours so its face is never clipped', () => {
    for (const side of SEAT_SIDES) {
      const layout = layoutBoard(shells, { ponds: { [side]: pond(18, 7) } });
      const cells = placementsOf(layout, side, 18);
      const riichi = cells[7];
      expect(riichi.shell).toBe('shell_flat_sideways');
      for (let index = 0; index < cells.length; index += 1) {
        if (index === 7) continue;
        expect(riichi.drawOrder).toBeGreaterThan(cells[index].drawOrder);
      }
    }
  });

  it('keeps every pond body inside its max-extent zone, even with a Riichi tile', () => {
    for (const side of SEAT_SIDES) {
      const layout = layoutBoard(shells, {
        ponds: { [side]: pond(POND_COLUMNS * POND_ROWS, POND_ROWS * POND_COLUMNS - 1) },
      });
      for (const cell of placementsOf(layout, side, POND_COLUMNS * POND_ROWS)) {
        expect(rectContains(layout.metrics.zones.ponds[side], cell.advanceRect)).toBe(true);
      }
    }
  });
});

describe('walls', () => {
  it('stacks two tiers with dx = 0 and dy = -wallStepY', () => {
    for (const side of SEAT_SIDES) {
      const lower = wallPlacements(full, side, 'lower');
      const upper = wallPlacements(full, side, 'upper');
      expect(lower).toHaveLength(MAX_WALL_PAIRS_PER_SIDE);
      expect(upper).toHaveLength(MAX_WALL_PAIRS_PER_SIDE);
      const step = metrics.wallTierStepPx[side];
      for (let index = 0; index < lower.length; index += 1) {
        expect(upper[index].gridX - lower[index].gridX).toBeCloseTo(0, 10);
        expect(upper[index].gridY - lower[index].gridY).toBeCloseTo(-step, 10);
        expect(upper[index].shell).toBe(lower[index].shell);
      }
      expect(step).toBeCloseTo(0.1 * Math.abs(shells.shells[metrics.wall.shell[side]].gridStepPx.y[1]), 10);
    }
  });

  it('uses the horizontal shell for top/bottom and the oblique shells for the sides', () => {
    expect(wallPlacements(full, 'top', 'lower')[0].shell).toBe('shell_wall_horizontal');
    expect(wallPlacements(full, 'bottom', 'lower')[0].shell).toBe('shell_wall_horizontal');
    expect(wallPlacements(full, 'left', 'lower')[0].shell).toBe('shell_wall_side_left');
    expect(wallPlacements(full, 'right', 'lower')[0].shell).toBe('shell_wall_side_right');
  });

  it('steps horizontal runs right-to-left and side runs top-to-bottom, centred on the board', () => {
    const top = wallPlacements(full, 'top', 'lower').sort((a, b) => a.gridX - b.gridX);
    for (let index = 1; index < top.length; index += 1) {
      expect(top[index].gridX - top[index - 1].gridX).toBeCloseTo(
        metrics.wall.pitchPx.horizontal,
        10,
      );
    }
    expect(right(top[top.length - 1].advanceRect) - top[0].gridX).toBeCloseTo(
      (top.length - 1) * metrics.wall.pitchPx.horizontal + top[0].advanceRect.width,
      10,
    );
    expect((top[0].gridX + right(top[top.length - 1].advanceRect)) / 2).toBeCloseTo(
      full.board.width / 2,
      10,
    );

    const left = wallPlacements(full, 'left', 'lower').sort((a, b) => a.gridY - b.gridY);
    for (let index = 1; index < left.length; index += 1) {
      expect(left[index].gridY - left[index - 1].gridY).toBeCloseTo(
        metrics.wall.pitchPx.vertical,
        10,
      );
    }
    expect((left[0].gridY + bottom(left[left.length - 1].advanceRect)) / 2).toBeCloseTo(
      metrics.zones.reserve.y + metrics.zones.reserve.height / 2,
      10,
    );
    for (const placement of [...top, ...left]) {
      expect(rectContains({ x: 0, y: 0, ...full.board }, placement.advanceRect)).toBe(true);
    }
  });

  it('paints the whole lower tier before the upper tier', () => {
    for (const side of SEAT_SIDES) {
      const lower = wallPlacements(full, side, 'lower');
      const upper = wallPlacements(full, side, 'upper');
      expect(Math.max(...lower.map((placement) => placement.drawOrder))).toBeLessThan(
        Math.min(...upper.map((placement) => placement.drawOrder)),
      );
    }
  });

  it('clamps the requested stack count to the board and honours zero', () => {
    expect(layoutBoard(shells, { wallPairsPerSide: 100 }).wallPairsPerSide).toBe(
      MAX_WALL_PAIRS_PER_SIDE,
    );
    expect(layoutBoard(shells, { wallPairsPerSide: 3 }).counts.walls).toBe(4 * 3 * 2);
    expect(layoutBoard(shells, { wallPairsPerSide: 0 }).counts.walls).toBe(0);
    expect(layoutBoard(shells, { wallPairsPerSide: -4 }).counts.walls).toBe(0);
  });
});

describe('paint order', () => {
  it('is unique, contiguous and runs top hand -> top wall -> side walls -> ponds -> bottom wall -> side hands -> bottom hand', () => {
    const orders = full.placements.map((placement) => placement.drawOrder);
    expect(new Set(orders).size).toBe(orders.length);
    expect(orders).toEqual(orders.map((_value, index) => index));

    const orderOf = (predicate: (placement: TilePlacement) => boolean): [number, number] => {
      const orders = full.placements.filter(predicate).map((placement) => placement.drawOrder);
      return [Math.min(...orders), Math.max(...orders)];
    };
    const topHand = orderOf((placement) => placement.seat === 'top' && placement.zone === 'hand');
    const topWall = orderOf((placement) => placement.seat === 'top' && placement.zone === 'wall');
    const sideWalls = orderOf(
      (placement) =>
        placement.zone === 'wall' && (placement.seat === 'left' || placement.seat === 'right'),
    );
    const ponds = orderOf((placement) => placement.zone === 'pond');
    const bottomWall = orderOf(
      (placement) => placement.seat === 'bottom' && placement.zone === 'wall',
    );
    const sideHands = orderOf(
      (placement) =>
        placement.zone === 'hand' && (placement.seat === 'left' || placement.seat === 'right'),
    );
    const bottomHand = orderOf(
      (placement) => placement.seat === 'bottom' && placement.zone === 'hand',
    );

    expect(topHand[1]).toBeLessThan(topWall[0]);
    expect(topWall[1]).toBeLessThan(sideWalls[0]);
    expect(sideWalls[1]).toBeLessThan(ponds[0]);
    expect(ponds[1]).toBeLessThan(bottomWall[0]);
    expect(bottomWall[1]).toBeLessThan(sideHands[0]);
    expect(sideHands[1]).toBeLessThan(bottomHand[0]);
  });

  it('paints the left wall before the right wall, each top of screen to bottom', () => {
    const left = full.placements
      .filter((placement) => placement.seat === 'left' && placement.zone === 'wall')
      .sort((a, b) => a.drawOrder - b.drawOrder);
    const right = full.placements
      .filter((placement) => placement.seat === 'right' && placement.zone === 'wall')
      .sort((a, b) => a.drawOrder - b.drawOrder);
    expect(Math.max(...left.map((placement) => placement.drawOrder))).toBeLessThan(
      Math.min(...right.map((placement) => placement.drawOrder)),
    );
    // Within each tier the column steps down the screen.
    const tiers = ['lower', 'upper'] as const;
    for (const tier of tiers) {
      const column = left
        .filter((placement) => placement.id.includes(`:${tier}:`))
        .sort((a, b) => a.drawOrder - b.drawOrder);
      for (let index = 1; index < column.length; index += 1) {
        expect(column[index].gridY).toBeGreaterThan(column[index - 1].gridY);
      }
    }
  });

  it('paints rows right-to-left / bottom-to-top and rows away from the light', () => {
    for (const side of SEAT_SIDES) {
      const layout = layoutBoard(shells, { ponds: { [side]: pond(POND_COLUMNS * POND_ROWS) } });
      const cells = placementsOf(layout, side, POND_COLUMNS * POND_ROWS);
      const frame = layout.metrics.ponds[side];
      // Within a row, the tile against the shadow direction is painted first.
      expect(cells[0].drawOrder).toBeGreaterThan(cells[1].drawOrder);

      // Across rows, the row nearer the top-left light is painted first:
      // screen top-to-bottom for horizontal rows, left-to-right for vertical
      // rows, independent of which seat owns the pond.
      for (let first = 0; first < POND_ROWS; first += 1) {
        for (let second = 0; second < POND_ROWS; second += 1) {
          const firstCell = cells[first * POND_COLUMNS];
          const secondCell = cells[second * POND_COLUMNS];
          const firstAxis = frame.axis === 'horizontal' ? firstCell.gridY : firstCell.gridX;
          const secondAxis = frame.axis === 'horizontal' ? secondCell.gridY : secondCell.gridX;
          if (firstAxis < secondAxis) {
            expect(firstCell.drawOrder).toBeLessThan(secondCell.drawOrder);
          }
        }
      }
    }
  });

  it('paints the drawn tile first, then the concealed hand right-to-left', () => {
    const bottom = full.placements.filter(
      (placement) => placement.seat === 'bottom' && placement.zone === 'hand',
    );
    const draw = bottom.find((placement) => placement.kind === 'draw')!;
    for (const placement of bottom) {
      if (placement.kind !== 'hand') continue;
      expect(draw.drawOrder).toBeLessThan(placement.drawOrder);
    }
    const hand = bottom
      .filter((placement) => placement.kind === 'hand')
      .sort((left, rightTile) => rightTile.gridX - left.gridX);
    for (let index = 1; index < hand.length; index += 1) {
      expect(hand[index - 1].drawOrder).toBeLessThan(hand[index].drawOrder);
    }
  });

  it('paints each hand horizontally right-to-left and each side hand top-to-bottom', () => {
    for (const side of ['top', 'bottom'] as const) {
      const row = seatHandPlacements(full, side).sort(
        (left, rightTile) => left.drawOrder - rightTile.drawOrder,
      );
      for (let index = 1; index < row.length; index += 1) {
        expect(row[index].gridX).toBeLessThan(row[index - 1].gridX);
      }
    }
    for (const side of ['left', 'right'] as const) {
      const column = seatHandPlacements(full, side).sort(
        (left, rightTile) => left.drawOrder - rightTile.drawOrder,
      );
      for (let index = 1; index < column.length; index += 1) {
        expect(column[index].gridY).toBeGreaterThan(column[index - 1].gridY);
      }
    }
  });
});

describe('viewport fitting and the felt', () => {
  const viewports = [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 1440, height: 900 },
    { width: 320, height: 480 },
    { width: 1024, height: 768 },
    { width: 712, height: 704 },
  ];

  it('contains and centres the board at every aspect ratio', () => {
    for (const viewport of viewports) {
      const fit = fitBoardToViewport(viewport, metrics.board);
      expect(fit.scale).toBeCloseTo(
        Math.min(viewport.width / metrics.board.width, viewport.height / metrics.board.height),
        10,
      );
      const widthPx = metrics.board.width * fit.scale;
      const heightPx = metrics.board.height * fit.scale;
      expect(widthPx).toBeLessThanOrEqual(viewport.width + 1e-9);
      expect(heightPx).toBeLessThanOrEqual(viewport.height + 1e-9);
      expect(
        Math.abs(widthPx - viewport.width) < 1e-9 || Math.abs(heightPx - viewport.height) < 1e-9,
      ).toBe(true);
      expect(fit.offsetX).toBeCloseTo((viewport.width - widthPx) / 2, 10);
      expect(fit.offsetY).toBeCloseTo((viewport.height - heightPx) / 2, 10);
      expect(fit.offsetX).toBeGreaterThanOrEqual(-1e-9);
      expect(fit.offsetY).toBeGreaterThanOrEqual(-1e-9);

      const topLeft = boardToCss(fit, { x: 0, y: 0 });
      expect(topLeft).toEqual({ x: fit.offsetX, y: fit.offsetY });
      const bottomRight = boardToCss(fit, { x: metrics.board.width, y: metrics.board.height });
      expect(bottomRight.x).toBeCloseTo(widthPx + fit.offsetX, 10);
      expect(bottomRight.y).toBeCloseTo(heightPx + fit.offsetY, 10);
    }
  });

  it('returns a zero fit for a degenerate viewport instead of NaN', () => {
    const fit = fitBoardToViewport({ width: 0, height: 0 }, metrics.board);
    expect(fit).toEqual({ scale: 0, offsetX: 0, offsetY: 0, boardWidth: 712, boardHeight: 704 });
  });

  it('stretches the felt rather than cropping it', () => {
    expect(FELT_RUNTIME.backgroundSize).toBe('100% 100%');
    expect(FELT_RUNTIME.backgroundSize).not.toBe('cover');
  });
});

describe('layout inputs, purity and the texture boundary', () => {
  it('is deterministic and does not depend on DOM globals', () => {
    const first = layoutBoard(shells, fullBoardInput());
    const second = layoutBoard(shells, fullBoardInput());
    expect(first).toEqual(second);
  });

  it('never reads texWidth/texHeight: mutating them leaves the layout unchanged', () => {
    const mutated = JSON.parse(JSON.stringify(shells)) as ShellsManifest;
    for (const shell of Object.values(mutated.shells)) {
      (shell as { texWidth: number }).texWidth = 9999;
      (shell as { texHeight: number }).texHeight = 9999;
    }
    const baseline = layoutBoard(shells, fullBoardInput());
    const inflated = layoutBoard(mutated, fullBoardInput());
    expect(inflated.placements).toEqual(baseline.placements);
    expect(inflated.metrics.board).toEqual(baseline.metrics.board);

    const source = readFileSync(fileURLToPath(new URL('./boardLayout.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/\.texWidth\b/);
    expect(source).not.toMatch(/\.texHeight\b/);
  });

  it('clamps pond discards to the 6 x 3 board and ignores missing seats', () => {
    const layout = layoutBoard(shells, { ponds: { top: pond(40) } });
    expect(layout.counts.ponds).toBe(POND_COLUMNS * POND_ROWS);
    expect(layout.counts.hand).toBe(0);
    expect(layout.counts.walls).toBe(MAX_WALL_PAIRS_PER_SIDE * 8);
  });

  it('places no hand tiles when no seat has a hand', () => {
    const layout = layoutBoard(shells, {});
    expect(layout.counts.hand).toBe(0);
    expect(layout.counts.draw).toBe(0);
    expect(layout.counts.melds).toBe(0);
    expect(layout.placements.filter((placement) => placement.zone === 'hand')).toEqual([]);
  });
});

function player(overrides: Partial<PlayerState> & { seat: number }): PlayerState {
  return {
    name: `player ${overrides.seat}`,
    is_human: false,
    wind: 'East',
    score: 25000,
    hand: [],
    draw: null,
    red_fives: [],
    discards: [],
    melds: [],
    is_riichi: false,
    riichi_discard_index: null,
    ...overrides,
  };
}

describe('GameState adapter', () => {
  it('maps hands, red fives, calls and the four seat ponds', () => {
    const state = {
      tiles_remaining: 66,
      players: [
        player({
          seat: 0,
          is_human: true,
          hand: ['1m', '5m'],
          draw: '3m',
          red_fives: ['5m'],
          melds: [{ meld_type: 'Pon', tiles: ['7p', '7p', '7p'], called_from: 2 }],
          discards: [
            { tile: '5m', is_riichi: false, is_tsumogiri: false, is_red: true },
            { tile: '7z', is_riichi: true, is_tsumogiri: false },
          ],
        }),
        player({
          seat: 1,
          discards: [{ tile: '2p', is_riichi: false, is_tsumogiri: true }],
          melds: [{ meld_type: 'Chi', tiles: ['1s', '2s', '3s'], called_from: 0 }],
        }),
        player({ seat: 2, hand: ['1z', '2z'], discards: [] }),
        player({ seat: 3, discards: [{ tile: '9s', is_riichi: false, is_tsumogiri: false }] }),
      ],
    } as unknown as GameState;

    const layout = boardLayoutFromState(shells, state);
    expect(layout.counts.hand).toBe(4);
    expect(layout.counts.draw).toBe(1);
    expect(layout.counts.melds).toBe(6);
    expect(layout.counts.ponds).toBe(4);
    expect(layout.wallPairsPerSide).toBe(9);

    const hand = layout.placements.filter(
      (placement) => placement.seat === 'bottom' && placement.kind === 'hand',
    );
    // The 5m is listed in red_fives, so it resolves to the aka-dora glyph.
    expect(hand.map((placement) => placement.face).sort()).toEqual(['1m', '5mr']);
    expect(layout.placements.find((placement) => placement.kind === 'draw')!.face).toBe('3m');

    // The human's pon is a top-down meld at the right end of the bottom row.
    const humanMelds = layout.placements.filter(
      (placement) => placement.seat === 'bottom' && placement.kind === 'meld',
    );
    expect(humanMelds).toHaveLength(3);
    expect(humanMelds.every((placement) => placement.face === '7p')).toBe(true);
    expect(humanMelds.every((placement) => placement.shell === 'shell_flat_upright')).toBe(true);

    // By discard index, not paint order: the sideways tile paints first in
    // its row, so filter order is right-to-left.
    const bottomPond = [0, 1].map((index) => {
      const placement = layout.placements.find(
        (candidate) => candidate.id === `bottom-pond:${index}`,
      );
      if (!placement) throw new Error(`missing bottom-pond:${index}`);
      return placement;
    });
    expect(bottomPond.map((placement) => placement.face)).toEqual(['5mr', '7z']);
    expect(bottomPond[1].shell).toBe('shell_flat_sideways');

    // Shimocha's chi is drawn face-up in that seat's hand band.
    const rightMelds = layout.placements.filter(
      (placement) => placement.seat === 'right' && placement.kind === 'meld',
    );
    expect(rightMelds.map((placement) => placement.face)).toEqual(['1s', '2s', '3s']);
    for (const placement of rightMelds) {
      expect(rectContains(layout.metrics.zones.hand.right, placement.advanceRect)).toBe(true);
    }

    // Toimen's two concealed tiles are backs, but the layout still knows them.
    const topHand = layout.placements.filter(
      (placement) => placement.seat === 'top' && placement.zone === 'hand',
    );
    expect(topHand.map((placement) => placement.face).sort()).toEqual(['1z', '2z']);
    expect(topHand.every((placement) => placement.shell === 'shell_wall_horizontal')).toBe(true);
  });

  it('turns tiles_remaining into at most ten wall stacks a side', () => {
    expect(wallPairsForRemaining(0)).toBe(0);
    expect(wallPairsForRemaining(1)).toBe(1);
    expect(wallPairsForRemaining(8)).toBe(1);
    expect(wallPairsForRemaining(9)).toBe(2);
    expect(wallPairsForRemaining(69)).toBe(9);
    expect(wallPairsForRemaining(83)).toBe(MAX_WALL_PAIRS_PER_SIDE);
    expect(wallPairsForRemaining(200)).toBe(MAX_WALL_PAIRS_PER_SIDE);
  });

  it('maps every engine meld type to the layout vocabulary', () => {
    expect(meldKindOf('Chi')).toBe('chi');
    expect(meldKindOf('Pon')).toBe('pon');
    expect(meldKindOf('Kan')).toBe('kan');
    expect(meldKindOf('Ankan')).toBe('ankan');
  });
});
