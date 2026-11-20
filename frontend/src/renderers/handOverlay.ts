/**
 * The hand's display order for the 3D overlay (3D-08).
 *
 * The snapshot already carries the concealed hand in display order (the adapter
 * sorts it once, so the canvas and the buttons agree). `HandDock` sorts the
 * engine's hand itself; this module derives the same order — suits, then ranks,
 * then the draw — and the same `index` the dock passes to `onSelectTile`. The
 * sort here is therefore the tab-order guarantee for a hand-edited snapshot as
 * well, and it keeps the draw in its rank position exactly as the dock does.
 *
 * Pure data: no React, no DOM, no camera. `overlay.tsx` renders the result.
 */

import { tileSortValue } from '../display';
import type { Seat, SnapshotTile, TableSnapshot, TileFaceId } from './contract';

/**
 * One interactive hand tile, in the order `HandDock` shows it.
 *
 * `index` is the position in that display order, which is exactly what
 * `HandDock` passes to `onSelectTile`; `isDraw` is the tile's own flag.
 */
export interface OverlayHandTile {
  readonly seat: Seat;
  readonly zone: 'hand' | 'draw';
  readonly slot: number;
  readonly face: TileFaceId;
  readonly code: string;
  readonly isRed: boolean;
  readonly isDraw: boolean;
  readonly index: number;
}

/** The engine code of a face id, and whether it is an aka-dora copy. */
function tileCode(face: TileFaceId): { code: string; isRed: boolean } {
  return face.endsWith('r')
    ? { code: face.slice(0, -1), isRed: true }
    : { code: face, isRed: false };
}

/**
 * The human's interactive tiles in the text order the dock uses.
 *
 * The sort key and the draw's position match `sortHandForDisplay` exactly
 * (`tileSortValue`, then the source slot), so tab order and the accessible
 * reading order agree with the stacked/top-down hand.
 */
export function overlayHandTiles(snapshot: TableSnapshot): OverlayHandTile[] {
  const human = snapshot.humanSeat;
  const seat = snapshot.seats[human];
  if (!seat) return [];

  const entries: { tile: SnapshotTile }[] = [
    ...seat.concealed.map((tile) => ({ tile })),
    ...(seat.draw ? [{ tile: seat.draw }] : []),
  ];

  const tiles = entries.map(({ tile }) => {
    const { code, isRed } = tileCode(tile.face);
    return {
      seat: human,
      zone: tile.zone as 'hand' | 'draw',
      slot: tile.slot,
      face: tile.face,
      code,
      isRed,
      isDraw: tile.zone === 'draw',
      index: 0,
    };
  });

  tiles.sort(
    (left, right) =>
      tileSortValue(left.code) - tileSortValue(right.code) ||
      left.slot - right.slot,
  );
  return tiles.map((tile, index) => ({ ...tile, index }));
}
