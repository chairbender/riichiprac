/**
 * Inter-tile contact adjacency (3D-20).
 *
 * The 2.5D pipeline's approved seam recipe is *stateful*: a tile darkens only
 * the edges that actually have a neighbour against them, and an open edge keeps
 * its lit bevel (`2_5d_implementation_plan.md`, Task 4A step 3 / Task 6A pass 3:
 * "Open edges … omit the overlay so the lit bevel stays bright"). The 3D chain's
 * single instanced tile mesh has no idea which of its six faces touch something,
 * so this module derives that from the layout: one six-bit mask per tile.
 *
 * Geometry, not guesswork. Two tiles are in contact along one of a tile's own
 * axes when the projections of their oriented boxes are separated by no more
 * than {@link CONTACT.maxGapUnits} along that axis and they overlap by at least
 * {@link CONTACT.minOverlapUnits} in the two perpendicular ones. The committed
 * grooves are 0.3 mm in a row (0.0107 units), 0.2 mm between pond columns
 * (0.0071) and 0.3 mm between wall tiers, while the tsumogiri draw gap is 0.2625
 * units and a meld row steps 1.05 — so the tolerance separates "in contact"
 * from "deliberately apart" with more than 10× headroom on both sides.
 *
 * Six bits, because the wall's two tiers touch along **local Z** (the top tile's
 * face against the bottom tile's back) as well as the lateral edges, and that
 * tier line is one of the seams the unit exists for.
 *
 * Pure: no three.js, no DOM, no clock. The consumer is `boardLayout.ts` (which
 * attaches the mask to each `BoardTile`) and `boardMesh.ts` (which packs it into
 * the `aContact` instance attribute).
 */

import { orientedBox } from './boardLayout';
import type { BoardTile, OrientedBox, Vec3 } from './boardLayout';

/**
 * One bit per edge of the tile's own body, in the mesh's local frame
 * (`tileGeometry.ts`: +X width, +Y glyph up, +Z out of the face).
 */
export const CONTACT_EDGE = {
  /** The local -X edge (toward the tile's left). */
  minusX: 1,
  plusX: 2,
  minusY: 4,
  plusY: 8,
  /** Local -Z: the blue back. A wall tile's neighbour above. */
  minusZ: 16,
  /** Local +Z: the carved face. A wall tile's neighbour below. */
  plusZ: 32,
} as const;

/** The two tolerances the contact test uses, in tile units. */
export const CONTACT = {
  /**
   * The largest body-to-body separation that still counts as touching. The
   * committed row groove is 0.0107 units (0.3 mm) and the pond's tightest is
   * 0.0071 (0.2 mm); the deliberately separated drawn tile is 0.2625 away.
   * 0.02 units (0.56 mm) sits an order of magnitude from both.
   */
  maxGapUnits: 0.02,
  /**
   * The smallest lateral overlap that counts: a corner-to-corner diagonal
   * neighbour shares no edge, and two rows that merely graze must not mark each
   * other. A real neighbour shares at least one groove-free stretch; 0.2 units
   * (5.6 mm) is under a third of a tile's short side.
   */
  minOverlapUnits: 0.2,
  /**
   * How far two bodies may interpenetrate and still count as touching. The
   * layout never overlaps (its gate forbids it), so this only absorbs float
   * noise in the pose math; anything deeper is a different tile, not a
   * neighbour.
   */
  maxPenetrationUnits: 0.01,
} as const;

/** The six local axes with the bit each one's contact sets. */
const EDGES: readonly {
  readonly bit: number;
  /** Index into the tile's axes: 0 = X, 1 = Y, 2 = Z. */
  readonly axis: 0 | 1 | 2;
  readonly sign: 1 | -1;
}[] = [
  { bit: CONTACT_EDGE.minusX, axis: 0, sign: -1 },
  { bit: CONTACT_EDGE.plusX, axis: 0, sign: 1 },
  { bit: CONTACT_EDGE.minusY, axis: 1, sign: -1 },
  { bit: CONTACT_EDGE.plusY, axis: 1, sign: 1 },
  { bit: CONTACT_EDGE.minusZ, axis: 2, sign: -1 },
  { bit: CONTACT_EDGE.plusZ, axis: 2, sign: 1 },
];

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** The half-extent of an oriented box projected onto a unit axis. */
function radiusAlong(box: OrientedBox, axis: Vec3): number {
  return (
    Math.abs(dot(box.axes[0], axis)) * box.halfExtents[0] +
    Math.abs(dot(box.axes[1], axis)) * box.halfExtents[1] +
    Math.abs(dot(box.axes[2], axis)) * box.halfExtents[2]
  );
}

/** World-axis-aligned bounds, for the cheap "obviously far apart" reject. */
interface Bounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

function boundsOf(box: OrientedBox): Bounds {
  const extent: Vec3 = [
    radiusAlong(box, [1, 0, 0]),
    radiusAlong(box, [0, 1, 0]),
    radiusAlong(box, [0, 0, 1]),
  ];
  return {
    min: [
      box.centre[0] - extent[0],
      box.centre[1] - extent[1],
      box.centre[2] - extent[2],
    ],
    max: [
      box.centre[0] + extent[0],
      box.centre[1] + extent[1],
      box.centre[2] + extent[2],
    ],
  };
}

/** Whether two AABBs can be within {@link CONTACT.maxGapUnits} at all. */
function nearEnough(a: Bounds, b: Bounds, gap: number): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if (a.max[axis] + gap < b.min[axis]) return false;
    if (b.max[axis] + gap < a.min[axis]) return false;
  }
  return true;
}

/**
 * Do `a` and `b` touch along `a`'s own `axis` in `sign`'s direction?
 *
 * The separation is measured between the boxes' **surfaces** along that axis,
 * so a negative value means they interpenetrate slightly (which the layout never
 * produces but the tolerance accepts, so a float noise at 1e-9 cannot flip a
 * groove into a gap). The two perpendicular overlaps use `a`'s other two axes:
 * every pose in this layout is a multiple of 90° about Y plus a tilt about X, so
 * `a`'s axes are the shared frame for its own edges, which is all this test
 * needs.
 */
function touchesAlong(a: OrientedBox, b: OrientedBox, axis: 0 | 1 | 2, sign: 1 | -1): boolean {
  const direction = a.axes[axis];
  const normal: Vec3 = [
    direction[0] * sign,
    direction[1] * sign,
    direction[2] * sign,
  ];
  const delta: Vec3 = [
    b.centre[0] - a.centre[0],
    b.centre[1] - a.centre[1],
    b.centre[2] - a.centre[2],
  ];
  const separation = dot(delta, normal) - (radiusAlong(a, normal) + radiusAlong(b, normal));
  if (
    separation > CONTACT.maxGapUnits ||
    separation < -CONTACT.maxPenetrationUnits
  ) {
    return false;
  }
  const perpendicular: (0 | 1 | 2)[] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  for (const other of perpendicular) {
    const otherAxis = a.axes[other];
    const overlap =
      radiusAlong(a, otherAxis) +
      radiusAlong(b, otherAxis) -
      Math.abs(dot(delta, otherAxis));
    if (overlap < CONTACT.minOverlapUnits) return false;
  }
  return true;
}

/**
 * One mask per tile, in the input order.
 *
 * O(n²) in tile count with an AABB reject in front: the widest board this app
 * draws is ~250 tiles, so the whole pass is a few hundred thousand cheap
 * comparisons on a snapshot change (never per frame).
 */
export function contactMasks(tiles: readonly BoardTile[]): readonly number[] {
  return contactPairs(tiles).masks;
}

/** One touching pair, as the seam probe and the tests read it. */
export interface ContactPair {
  /** The tile whose own edge the bit belongs to. */
  readonly aId: string;
  readonly bId: string;
  readonly axis: 0 | 1 | 2;
  readonly sign: 1 | -1;
  readonly bit: number;
}

/** The per-tile masks plus every touching pair, from one O(n²) sweep. */
export function contactPairs(
  tiles: readonly BoardTile[],
  options: { readonly collect?: boolean } = {},
): { readonly masks: readonly number[]; readonly pairs: readonly ContactPair[] } {
  const boxes = tiles.map((tile) => orientedBox(tile.pose));
  const bounds = boxes.map((box) => boundsOf(box));
  const masks = new Array<number>(tiles.length).fill(0);
  const pairs: ContactPair[] = [];
  const collect = options.collect ?? true;
  for (let index = 0; index < tiles.length; index += 1) {
    let mask = 0;
    for (let other = 0; other < tiles.length; other += 1) {
      if (other === index) continue;
      if (!nearEnough(bounds[index], bounds[other], CONTACT.maxGapUnits)) continue;
      for (const edge of EDGES) {
        if (mask & edge.bit) continue;
        if (touchesAlong(boxes[index], boxes[other], edge.axis, edge.sign)) {
          mask |= edge.bit;
          if (collect) {
            pairs.push({
              aId: tiles[index].id,
              bId: tiles[other].id,
              axis: edge.axis,
              sign: edge.sign,
              bit: edge.bit,
            });
          }
        }
      }
      if (mask === 63) break;
    }
    masks[index] = mask;
  }
  return { masks, pairs };
}
