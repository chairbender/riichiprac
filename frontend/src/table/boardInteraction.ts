/**
 * Phase 5 pointer geometry: logical body rects, lift, hit-testing, and the
 * board ↔ screen maps.
 *
 * The tile sprite has transparent shadow/AO padding on its right and bottom
 * (`shells.json` `padding`). That margin is *not* part of the tile and must
 * never take a pointer: the hit target is the shell's logical body box
 * `[gridX, gridY, advanceWidth, advanceHeight]`, shifted up by the current lift
 * when the tile is drawn lifted.
 *
 * The rect is half-open (`x <= point.x < x + width`), so two tight neighbours
 * that share an edge have exactly one owner. That mirrors DOM hit-testing and
 * keeps the scripted edge-case table unambiguous.
 *
 * ## Sticky hover
 *
 * A lifted tile moves its body up, so a pointer resting in the bottom few px of
 * the baseline body would fall out of the lifted rect, drop the tile, fall back
 * in, and buzz. `hitTestBoard` therefore accepts a `stickyId`: while that tile is
 * already hovered, its baseline body also counts. It is still the logical body,
 * not the texture margin, and it only applies to the tile already under the
 * pointer.
 */
import { fitBoardToViewport } from './boardLayout';
import type {
  BoardFit,
  BoardLayout,
  BoardPoint,
  BoardRect,
  TilePlacement,
} from './boardLayout';
import type { PlayerState } from '../types/game';

/** Upward draw offset of a hovered/selected hand tile, in board px. */
export const DEFAULT_LIFT_PX = 12;

/** Extra width the secondary shadow is scaled by on each side, in board px. */
export const LIFT_SHADOW_SPREAD_PX = 3;

/** A tile's logical body at a given lift. */
export function placementBodyRect(
  placement: TilePlacement,
  liftPx = 0,
): BoardRect {
  return {
    x: placement.gridX,
    y: placement.gridY - liftPx,
    width: placement.advanceRect.width,
    height: placement.advanceRect.height,
  };
}

/** Half-open point-in-rect. */
export function pointInRect(point: BoardPoint, rect: BoardRect): boolean {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  );
}

/** Map a point in board px to CSS px in the fitted viewport. */
export function boardPointToScreen(point: BoardPoint, fit: BoardFit): BoardPoint {
  return {
    x: fit.offsetX + point.x * fit.scale,
    y: fit.offsetY + point.y * fit.scale,
  };
}

/** Map a CSS point inside the fitted viewport back to board px. */
export function screenPointToBoard(point: BoardPoint, fit: BoardFit): BoardPoint {
  if (fit.scale === 0) return { x: 0, y: 0 };
  return {
    x: (point.x - fit.offsetX) / fit.scale,
    y: (point.y - fit.offsetY) / fit.scale,
  };
}

/** A board rect in CSS px, at a given lift. */
export function boardRectToScreen(
  rect: BoardRect,
  fit: BoardFit,
  liftPx = 0,
): BoardRect {
  return {
    x: fit.offsetX + rect.x * fit.scale,
    y: fit.offsetY + (rect.y - liftPx) * fit.scale,
    width: rect.width * fit.scale,
    height: rect.height * fit.scale,
  };
}

/** The fit used by both the renderer and the DOM hitboxes. */
export function fitRenderedViewport(
  viewport: { width: number; height: number },
  board: { width: number; height: number },
  reservedBottomPx = 0,
): BoardFit {
  const usableHeight = Math.max(1, viewport.height - reservedBottomPx);
  return fitBoardToViewport(
    { width: Math.max(1, viewport.width), height: usableHeight },
    board,
  );
}

export interface HitTestOptions {
  /** Lift applied to ids in {@link liftedIds}. Defaults to {@link DEFAULT_LIFT_PX}. */
  readonly liftPx?: number;
  readonly liftedIds?: ReadonlySet<string>;
  /** A tile already under the pointer; its un-lifted body stays sticky. */
  readonly stickyId?: string | null;
}

export type BoardHitTester = (
  point: BoardPoint,
  options?: HitTestOptions,
) => TilePlacement | null;

/**
 * Build a hit tester for one board. It caches the reverse paint order, so a
 * pointer-move handler never sorts or allocates a placement list per event.
 * Reverse paint order means the tile painted last (the topmost one, which is
 * always the human hand) wins an overlap.
 */
export function createHitTester(board: Pick<BoardLayout, 'placements'>): BoardHitTester {
  const topmostFirst = [...board.placements].sort(
    (left, right) => right.drawOrder - left.drawOrder,
  );
  const byId = new Map(topmostFirst.map((placement) => [placement.id, placement]));

  return (point, options = {}) => {
    const liftPx = options.liftPx ?? DEFAULT_LIFT_PX;
    const lifted = options.liftedIds;
    for (const placement of topmostFirst) {
      const lift = lifted?.has(placement.id) ? liftPx : 0;
      if (pointInRect(point, placementBodyRect(placement, lift))) {
        return placement;
      }
    }

    // Sticky baseline body for the tile already hovered: see the file header.
    const sticky = options.stickyId ? byId.get(options.stickyId) : undefined;
    if (sticky && pointInRect(point, placementBodyRect(sticky, 0))) {
      return sticky;
    }
    return null;
  };
}

/** One-shot variant of {@link createHitTester}, for tests and scripted checks. */
export function hitTestBoard(
  board: Pick<BoardLayout, 'placements'>,
  point: BoardPoint,
  options: HitTestOptions = {},
): TilePlacement | null {
  return createHitTester(board)(point, options);
}

/**
 * The placements whose bodies are interactive: the human's concealed hand and
 * its draw. Calls, discards and the other seats' hands are information only,
 * exactly as in the top-down view (where the dock owns the buttons).
 */
export function interactivePlacementIds(
  board: Pick<BoardLayout, 'placements'>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const placement of board.placements) {
    if (
      placement.seat === 'bottom' &&
      placement.zone === 'hand' &&
      (placement.kind === 'hand' || placement.kind === 'draw')
    ) {
      ids.add(placement.id);
    }
  }
  return ids;
}

/** The human hand placement's tile code/index, or null for another tile. */
export interface HandTileSlot {
  readonly tile: string;
  /** Index into `[...player.hand, player.draw]`, the same index the dock uses. */
  readonly index: number;
  readonly isDraw: boolean;
}

/**
 * Resolve a bottom-hand placement to the game state's tile code and index.
 *
 * `seatHandFromPlayer` copies `player.hand` in order and the draw separately,
 * so `bottom-hand:i` is `hand[i]` and `bottom-hand:draw` is the last dock index.
 */
export function handTileSlot(
  placement: TilePlacement,
  player: PlayerState,
): HandTileSlot | null {
  if (placement.seat !== 'bottom' || placement.zone !== 'hand') return null;
  if (placement.kind === 'draw') {
    const draw = player.draw;
    if (!draw) return null;
    return { tile: draw, index: player.hand.length, isDraw: true };
  }
  if (placement.kind !== 'hand') return null;

  const match = /^bottom-hand:(\d+)$/.exec(placement.id);
  if (!match) return null;
  const index = Number(match[1]);
  const tile = player.hand[index];
  if (!tile) return null;
  return { tile, index, isDraw: false };
}

/**
 * The placement a submitted answer refers to, for the answered-state tint.
 * Prefers the recorded `tile_index`; otherwise uses the first matching tile,
 * the same copy the dock marks.
 */
export function answerPlacementId(
  board: Pick<BoardLayout, 'placements'>,
  player: PlayerState,
  answer: { tile?: string | null; tile_index?: number } | null,
): string | null {
  if (!answer?.tile) return null;
  const hand = board.placements.filter(
    (placement) =>
      placement.seat === 'bottom' &&
      placement.zone === 'hand' &&
      (placement.kind === 'hand' || placement.kind === 'draw'),
  );
  if (answer.tile_index !== undefined) {
    const indexed = hand.find((placement) => {
      const slot = handTileSlot(placement, player);
      return slot?.index === answer.tile_index;
    });
    if (indexed) return indexed.id;
  }
  const matching = hand.find(
    (placement) => handTileSlot(placement, player)?.tile === answer.tile,
  );
  return matching?.id ?? null;
}
