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
 * earlier ≤ 4 mm figure in §3D-12. It is applied on top of the button's CSS tint.
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

/**
 * The board instances with the hovered tile lifted, or the input untouched when
 * nothing is hovered (or the hovered tile is not on this board).
 *
 * A pose matrix is column-major, so its translation is elements 12-14; only the
 * world Y component moves, which is what "raised up" means here.
 */
export function withHoverLift(
  instances: readonly BoardInstance[],
  layout: BoardLayout,
  hover: HandTileRef | null,
): readonly BoardInstance[] {
  const index = hoveredInstanceIndex(layout, hover);
  if (index < 0 || index >= instances.length) return instances;
  const lifted = [...instances[index].matrix];
  lifted[13] += HOVER_LIFT_UNITS;
  return instances.map((instance, current) =>
    current === index ? { ...instance, matrix: lifted } : instance,
  );
}
