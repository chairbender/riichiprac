/**
 * The hover lift for the 3D hand (3D-08 seam, 3D-12 motion).
 *
 * A hovered or focused hand tile rises straight up by half a tile height
 * (`TILE.heightUnits / 2` = 14 mm). It is the same lift for every tile and every
 * frame, so it is a pure function of the layout and the hovered reference: no
 * clock, no spring, no state. The DOM button never moves — the overlay's rect
 * comes from the un-lifted pose — so the pointer stays on the same target while
 * a 14 mm tile rises beneath it.
 *
 * Recorded user decision (2026-11-19): the amount is half a tile height, not the
 * earlier ≤ 4 mm figure in §3D-12. The lift is a discrete pose change, not an
 * animation, so it applies under every motion preference (user decision
 * 2026-11-21); reduced motion suppresses only the time-based deal-in.
 *
 * Pure data: no three.js, no DOM. `Scene` feeds the result to the instanced mesh.
 */

import type { HandTileRef } from '../contract';
import { TILE } from '../layoutConstants';
import type { BoardInstance } from './boardMesh';
import type { BoardLayout } from './boardLayout';

/** How far a hovered tile rises: half a tile height, 14 mm. */
export const HOVER_LIFT_UNITS = TILE.heightUnits / 2;

/**
 * The index of the hovered tile in the layout (and therefore in the instance
 * buffer, which `buildBoardInstances` emits in layout order), or -1.
 */
export function hoveredInstanceIndex(
  layout: BoardLayout,
  hover: HandTileRef | null,
): number {
  if (!hover) return -1;
  return layout.tiles.findIndex(
    (tile) =>
      tile.seat === hover.seat &&
      tile.zone === hover.zone &&
      tile.slot === hover.slot,
  );
}

/** The layout indexes of a set of hand references, in layout order. */
export function liftedInstanceIndexes(
  layout: BoardLayout,
  tiles: readonly HandTileRef[],
): readonly number[] {
  if (tiles.length === 0) return [];
  const wanted = new Set(
    tiles.map((tile) => `${tile.seat}:${tile.zone}:${tile.slot}`),
  );
  const indexes: number[] = [];
  layout.tiles.forEach((tile, index) => {
    if (wanted.has(`${tile.seat}:${tile.zone}:${tile.slot}`)) {
      indexes.push(index);
    }
  });
  return indexes;
}

/**
 * The board instances with every named tile lifted.
 *
 * The call preview and a multi-tile pick need more than one raised tile at
 * once, so the lift is a set rather than a single hover. A pose matrix is
 * column-major, so its translation is elements 12-14; only the world Y
 * component moves, which is what "raised up" means here.
 */
export function withLiftedTiles(
  instances: readonly BoardInstance[],
  layout: BoardLayout,
  tiles: readonly HandTileRef[],
): readonly BoardInstance[] {
  const indexes = liftedInstanceIndexes(layout, tiles);
  if (indexes.length === 0) return instances;
  const liftedByIndex = new Map<number, BoardInstance>();
  for (const index of indexes) {
    if (index < 0 || index >= instances.length) continue;
    const matrix = [...instances[index].matrix];
    matrix[13] += HOVER_LIFT_UNITS;
    liftedByIndex.set(index, { ...instances[index], matrix });
  }
  if (liftedByIndex.size === 0) return instances;
  return instances.map((instance, current) => liftedByIndex.get(current) ?? instance);
}

/**
 * The board instances with the hovered tile lifted, or the input untouched when
 * nothing is hovered (or the hovered tile is not on this board).
 */
export function withHoverLift(
  instances: readonly BoardInstance[],
  layout: BoardLayout,
  hover: HandTileRef | null,
): readonly BoardInstance[] {
  return withLiftedTiles(instances, layout, hover ? [hover] : []);
}
