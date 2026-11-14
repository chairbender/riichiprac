import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { layoutBoard } from './boardLayout';
import type { BoardLayout } from './boardLayout';
import { parseShellsManifest } from './shellManifest';
import {
  DEFAULT_LIFT_PX,
  answerPlacementId,
  boardPointToScreen,
  boardRectToScreen,
  createHitTester,
  fitRenderedViewport,
  handTileSlot,
  hitTestBoard,
  interactivePlacementIds,
  placementBodyRect,
  pointInRect,
  screenPointToBoard,
} from './boardInteraction';
import type { PlayerState } from '../types/game';

const tableDir = fileURLToPath(new URL('../../public/table/', import.meta.url));
const shells = parseShellsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')),
);

const layout: BoardLayout = layoutBoard(shells, {
  hand: ['1m', '2m', '3m'],
  draw: '4m',
  hands: { top: { hand: ['1p'] } },
  melds: [{ kind: 'pon', tiles: ['7p', '7p', '7p'] }],
  wallPairsPerSide: 1,
});

function placement(id: string) {
  const found = layout.placements.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing placement ${id}`);
  return found;
}

function human(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    seat: 0,
    name: 'You',
    is_human: true,
    wind: 'East',
    score: 25000,
    hand: ['1m', '2m', '3m'],
    draw: '4m',
    red_fives: [],
    discards: [],
    melds: [{ meld_type: 'Pon', tiles: ['7p', '7p', '7p'], called_from: 1 }],
    is_riichi: false,
    riichi_discard_index: null,
    ...overrides,
  };
}

describe('logical body rects and lift', () => {
  it('uses the shell advance box, never the texture padding', () => {
    const draw = placement('bottom-hand:draw');
    const body = placementBodyRect(draw);
    expect(body).toEqual(draw.advanceRect);
    expect(body.x).toBe(draw.gridX);
    expect(body.width).toBe(shells.shells.shell_hand_standing.advanceWidth);
    expect(body.height).toBe(shells.shells.shell_hand_standing.advanceHeight);
    // The texture is 6 px wider/taller than the body; that margin is excluded.
    expect(shells.shells.shell_hand_standing.texWidth - body.width).toBe(6);
    expect(shells.shells.shell_hand_standing.texHeight - body.height).toBe(6);
  });

  it('moves only the y of a lifted body by the single lift constant', () => {
    const draw = placement('bottom-hand:draw');
    const lifted = placementBodyRect(draw, DEFAULT_LIFT_PX);
    expect(lifted.y).toBe(draw.gridY - 12);
    expect(lifted.x).toBe(draw.gridX);
    expect(lifted.width).toBe(draw.advanceRect.width);
    expect(lifted.height).toBe(draw.advanceRect.height);
  });

  it('treats the body rect as half-open on the right and bottom', () => {
    const rect = { x: 10, y: 20, width: 30, height: 40 };
    expect(pointInRect({ x: 10, y: 20 }, rect)).toBe(true);
    expect(pointInRect({ x: 39.999, y: 59.999 }, rect)).toBe(true);
    expect(pointInRect({ x: 40, y: 30 }, rect)).toBe(false);
    expect(pointInRect({ x: 20, y: 60 }, rect)).toBe(false);
    expect(pointInRect({ x: 9.999, y: 30 }, rect)).toBe(false);
  });
});

describe('hit-testing table', () => {
  const draw = placement('bottom-hand:draw');
  const body = placementBodyRect(draw);
  const centre = {
    x: body.x + body.width / 2,
    y: body.y + body.height / 2,
  };
  const table: Array<{
    name: string;
    point: { x: number; y: number };
    options?: Parameters<typeof hitTestBoard>[2];
    expected: string | null;
  }> = [
    { name: 'body centre', point: centre, expected: draw.id },
    {
      name: 'top-left corner is inside',
      point: { x: body.x, y: body.y },
      expected: draw.id,
    },
    {
      name: 'right edge is outside (half-open)',
      point: { x: body.x + body.width, y: centre.y },
      expected: null,
    },
    {
      name: 'bottom edge is outside (half-open)',
      point: { x: centre.x, y: body.y + body.height },
      expected: null,
    },
    {
      name: 'right transparent shadow margin',
      point: { x: body.x + body.width + 1, y: centre.y },
      expected: null,
    },
    {
      name: 'bottom transparent shadow margin',
      point: { x: centre.x, y: body.y + body.height + 1 },
      expected: null,
    },
    {
      name: 'top-left transparent margin',
      point: { x: body.x - 1, y: body.y - 1 },
      expected: null,
    },
    {
      name: 'lifted body around the new top',
      point: { x: centre.x, y: body.y - DEFAULT_LIFT_PX + 1 },
      options: { liftedIds: new Set([draw.id]) },
      expected: draw.id,
    },
    {
      name: 'lifted body no longer owns the baseline bottom strip',
      point: { x: centre.x, y: body.y + body.height - 2 },
      options: { liftedIds: new Set([draw.id]) },
      expected: null,
    },
    {
      name: 'sticky hover keeps the baseline bottom strip while already hovered',
      point: { x: centre.x, y: body.y + body.height - 2 },
      options: { liftedIds: new Set([draw.id]), stickyId: draw.id },
      expected: draw.id,
    },
  ];

  for (const row of table) {
    it(`row: ${row.name}`, () => {
      expect(hitTestBoard(layout, row.point, row.options)?.id ?? null).toBe(
        row.expected,
      );
    });
  }

  it('topmost paint order wins an overlap', () => {
    const tester = createHitTester(layout);
    const point = {
      x: body.x + body.width / 2,
      y: body.y + body.height / 2,
    };
    expect(tester(point)?.id).toBe(draw.id);
  });

  it('never selects an opponent tile or a meld', () => {
    const interactive = interactivePlacementIds(layout);
    for (const id of interactive) {
      const candidate = placement(id);
      expect(candidate.seat).toBe('bottom');
      expect(candidate.zone).toBe('hand');
      expect(['hand', 'draw']).toContain(candidate.kind);
    }
    expect(interactive.size).toBe(4);
    expect(interactive.has('top-hand:0')).toBe(false);
    expect(interactive.has('bottom-meld:0:0')).toBe(false);
  });
});

describe('screen mapping and fit', () => {
  it('round-trips a board point through a fitted viewport', () => {
    const fit = fitRenderedViewport({ width: 390, height: 844 }, layout.board, 0);
    const point = { x: 123.5, y: 456.25 };
    const screen = boardPointToScreen(point, fit);
    const back = screenPointToBoard(screen, fit);
    expect(back.x).toBeCloseTo(point.x, 10);
    expect(back.y).toBeCloseTo(point.y, 10);
  });

  it('reserves the measured bottom controls band above the fit', () => {
    const full = fitRenderedViewport({ width: 390, height: 844 }, layout.board, 0);
    const withControls = fitRenderedViewport(
      { width: 390, height: 844 },
      layout.board,
      180,
    );
    expect(withControls.scale).toBeLessThanOrEqual(full.scale);
    expect(withControls.offsetY).toBeLessThanOrEqual(full.offsetY);
    expect(withControls.offsetY + layout.board.height * withControls.scale).toBeLessThanOrEqual(844 - 180 + 1e-9);
  });

  it('maps a lifted body rect to CSS px with the lift included', () => {
    const fit = { scale: 0.5, offsetX: 10, offsetY: 20, boardWidth: 712, boardHeight: 704 };
    const rect = boardRectToScreen({ x: 100, y: 200, width: 40, height: 50 }, fit, 12);
    expect(rect).toEqual({ x: 60, y: 114, width: 20, height: 25 });
  });
});

describe('hand slot mapping', () => {
  it('maps hand placements and the draw back to dock indices', () => {
    expect(handTileSlot(placement('bottom-hand:0'), human())).toEqual({
      tile: '1m',
      index: 0,
      isDraw: false,
    });
    expect(handTileSlot(placement('bottom-hand:draw'), human())).toEqual({
      tile: '4m',
      index: 3,
      isDraw: true,
    });
  });

  it('resolves the answered placement by index first, then by tile', () => {
    expect(
      answerPlacementId(layout, human(), { tile: '1m', tile_index: 1 }),
    ).toBe('bottom-hand:1');
    expect(answerPlacementId(layout, human(), { tile: '4m' })).toBe(
      'bottom-hand:draw',
    );
    expect(answerPlacementId(layout, human(), null)).toBeNull();
  });
});
