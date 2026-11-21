/**
 * Tile-to-tile surface gaps (3D-20 rework).
 *
 * The 3D view's real defect is that two tiles that should be in contact leave a
 * slot the camera can look through: the eye finds the felt (or the clear colour)
 * where a closed body seam should be. The crevice shading that used to live here
 * painted over that instead of removing it, so what replaced it is a **measurement
 * of the gap itself**.
 *
 * One number per pair: the surface-to-surface separation along the pair's least
 * separated axis. For faces that should touch it is exactly 0; for the deliberate
 * separations (the tsumogiri draw gap, the meld line's own felt, pond-to-wall
 * felt, different zones) it is large. The layout gate asserts that nothing sits *between*: no
 * pair may be closer than {@link GAP.maxTouchingGapUnits} without actually
 * touching, which is the statement "there is no slot narrower than 1.4 mm that
 * is not intended".
 *
 * The measure is the largest per-axis separation (`max_k |d·n_k| - (rA_k + rB_k)`),
 * which is exact for face-to-face pairs — the ones that matter here, since every
 * pose in this layout is a quarter-turn about Y plus a tilt about X — and a lower
 * bound for diagonal ones. Pure: no three.js, no DOM.
 */

import { orientedBox } from './boardLayout';
import type { BoardTile, OrientedBox, Vec3 } from './boardLayout';
import type { Zone } from '../contract';

/** The tolerances the gap measure is read with. */
export const GAP = {
  /**
   * The widest separation that still counts as "touching". Bodies are placed at
   * exactly their own extents, so a true contact is 0 up to float noise; 1e-6
   * units (0.03 um) absorbs the summation error without hiding a real gap.
   */
  touchingUnits: 1e-6,
  /**
   * Anything narrower than this must be a bug. The smallest *intended* gap in the
   * layout is the pond's nearest row to the near wall (0.065 units, 1.8 mm), and
   * the smallest slot that used to exist was the wall ring's corner (0.039). A
   * 1.4 mm threshold separates those two families with room on both sides.
   */
  maxTouchingGapUnits: 0.05,
  /** How near two tiles must be to be reported at all, in tile units. */
  reportWithinUnits: 0.05,
} as const;

/** One pair's measured separation. */
export interface TileGap {
  readonly aId: string;
  readonly bId: string;
  readonly aZone: Zone;
  readonly bZone: Zone;
  /** Surface-to-surface distance in tile units; negative means interpenetration. */
  readonly gapUnits: number;
  /** Which of `a`'s own axes the separation is measured along. */
  readonly axis: 0 | 1 | 2;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function radiusAlong(box: OrientedBox, axis: Vec3): number {
  return (
    Math.abs(dot(box.axes[0], axis)) * box.halfExtents[0] +
    Math.abs(dot(box.axes[1], axis)) * box.halfExtents[1] +
    Math.abs(dot(box.axes[2], axis)) * box.halfExtents[2]
  );
}

/** The smallest surface separation between two oriented boxes, and its axis. */
export function surfaceGap(
  a: OrientedBox,
  b: OrientedBox,
): { readonly gapUnits: number; readonly axis: 0 | 1 | 2 } {
  const delta: Vec3 = [
    b.centre[0] - a.centre[0],
    b.centre[1] - a.centre[1],
    b.centre[2] - a.centre[2],
  ];
  let best = Number.NEGATIVE_INFINITY;
  let bestAxis: 0 | 1 | 2 = 0;
  for (const axis of [0, 1, 2] as const) {
    const direction = a.axes[axis];
    const separation =
      Math.abs(dot(delta, direction)) - (radiusAlong(a, direction) + radiusAlong(b, direction));
    if (separation > best) {
      best = separation;
      bestAxis = axis;
    }
  }
  return { gapUnits: best, axis: bestAxis };
}

/** World-axis bounds, for the cheap "obviously far apart" reject. */
function boundsOf(box: OrientedBox): { min: Vec3; max: Vec3 } {
  const x = radiusAlong(box, [1, 0, 0]);
  const y = radiusAlong(box, [0, 1, 0]);
  const z = radiusAlong(box, [0, 0, 1]);
  return {
    min: [box.centre[0] - x, box.centre[1] - y, box.centre[2] - z],
    max: [box.centre[0] + x, box.centre[1] + y, box.centre[2] + z],
  };
}

/**
 * Every pair of tiles closer than `withinUnits`, with its measured gap.
 *
 * O(n²) with an AABB reject; the widest board draws ~250 tiles, so this is a
 * snapshot-time measurement (never per frame).
 */
export function tileGaps(
  tiles: readonly BoardTile[],
  options: { readonly withinUnits?: number } = {},
): readonly TileGap[] {
  const within = options.withinUnits ?? GAP.reportWithinUnits;
  const boxes = tiles.map((tile) => orientedBox(tile.pose));
  const bounds = boxes.map((box) => boundsOf(box));
  const gaps: TileGap[] = [];
  for (let index = 0; index < tiles.length; index += 1) {
    for (let other = index + 1; other < tiles.length; other += 1) {
      const a = bounds[index];
      const b = bounds[other];
      if (
        a.max[0] + within < b.min[0] ||
        b.max[0] + within < a.min[0] ||
        a.max[1] + within < b.min[1] ||
        b.max[1] + within < a.min[1] ||
        a.max[2] + within < b.min[2] ||
        b.max[2] + within < a.min[2]
      ) {
        continue;
      }
      const gap = surfaceGap(boxes[index], boxes[other]);
      if (gap.gapUnits > within) continue;
      gaps.push({
        aId: tiles[index].id,
        bId: tiles[other].id,
        aZone: tiles[index].zone,
        bZone: tiles[other].zone,
        gapUnits: gap.gapUnits,
        axis: gap.axis,
      });
    }
  }
  return gaps;
}

/** Gaps that are neither a true contact nor a deliberate separation. */
export function slotGaps(gaps: readonly TileGap[]): readonly TileGap[] {
  return gaps.filter(
    (gap) =>
      gap.gapUnits > GAP.touchingUnits && gap.gapUnits <= GAP.maxTouchingGapUnits,
  );
}

/** Pairs whose bodies interpenetrate (the layout gate forbids this). */
export function overlaps(gaps: readonly TileGap[]): readonly TileGap[] {
  return gaps.filter((gap) => gap.gapUnits < -GAP.touchingUnits);
}

/** Pairs that touch, by zone pair, as a count. */
export function touchingByZone(gaps: readonly TileGap[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const gap of gaps) {
    if (gap.gapUnits > GAP.touchingUnits) continue;
    const key = gap.aZone === gap.bZone ? gap.aZone : `${gap.aZone}/${gap.bZone}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
