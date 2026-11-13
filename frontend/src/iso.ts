import { TABLE_SIDES } from './seatOrder';
import type { TableSide } from './seatOrder';

/**
 * Geometry for the isometric table view.
 *
 * Everything here is plain arithmetic: no 3D library and no perspective. The
 * camera sits at a fixed pitch above the table and looks straight along the
 * table's `y` axis, so the projected table is a 2:1 rectangle with the human's
 * edge along the bottom of the screen. That keeps every seat on an axis-aligned
 * edge (bottom, right, top, left), which is what lets the view reuse the same
 * seat placements and rotations as the top-down table.
 *
 * Table coordinates are measured in tile widths, with the origin at the centre
 * of the playing surface:
 *
 * - `x` runs across the table, positive to the human's right.
 * - `y` runs away from the human, positive towards the far side.
 * - `z` is height above the table plane, positive upwards.
 *
 * The origin is therefore the point of the table plane directly under the
 * compass.
 */

/** A point in table space, in tile widths. */
export interface TablePoint {
  /** Across the table; positive is to the human's right. */
  x: number;
  /** Away from the human; positive is the far side. */
  y: number;
  /** Height above the table plane; positive is up. */
  z: number;
}

/** A point in SVG user space, in tile widths from the projected table centre. */
export interface ScreenPoint {
  /** Screen x, positive to the right. */
  x: number;
  /** Screen y, positive downwards (SVG's own direction). */
  y: number;
}

/** The size of the area the table has to fit inside, in CSS pixels. */
export interface Viewport {
  width: number;
  height: number;
}

/**
 * An axis-aligned rectangle in projected space, in tile widths.
 *
 * This is what {@link fitProjection} scales and centres: the bounding box of
 * the whole table footprint, not just the playing surface.
 */
export interface ProjectedBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * How projected table units map onto the screen.
 *
 * `scale` is CSS pixels per tile width, and `origin` is where the projected
 * table centre (table point `0, 0, 0`) lands in CSS pixels. A projected point
 * `p` becomes `origin + p * scale`, which keeps the projection itself unitless
 * and testable while the viewport decides how large it is drawn.
 */
export interface Projection {
  scale: number;
  origin: ScreenPoint;
}

/** Four table points in drawing order: a rectangle or trapezoid on the plane. */
export type TableQuad = readonly [
  TablePoint,
  TablePoint,
  TablePoint,
  TablePoint,
];

/** The fixed camera pitch above the table plane, in degrees. */
export const ISO_PITCH_DEGREES = 30;

/**
 * How much one tile width away from the human moves a point up the screen.
 *
 * This is `sin(pitch)`, and the fixed 30° pitch puts it at about 0.5, giving
 * the familiar 2:1 isometric proportion: a square table reads twice as wide as
 * it is deep.
 */
export const ISO_DEPTH_SCALE = Math.sin((ISO_PITCH_DEGREES * Math.PI) / 180);

/**
 * How much one tile width of height lifts a point up the screen.
 *
 * This is `cos(pitch)` for the same fixed camera: a point one tile above the
 * felt appears a little less than one tile higher on screen.
 */
export const ISO_HEIGHT_SCALE = Math.cos((ISO_PITCH_DEGREES * Math.PI) / 180);

/** The playing surface's width and depth, in tile widths. */
export const TABLE_SIZE = 12;

/** Half the playing surface, i.e. the coordinate of each of its four edges. */
export const TABLE_HALF_SIZE = TABLE_SIZE / 2;

/**
 * How deep each seat's band runs inward from its edge, in tile widths.
 *
 * Three tile widths hold a river of three rows plus its margin, and leaves a
 * six-by-six centre square for the compass.
 */
export const SEAT_BAND_DEPTH = 3;

/** Half the centre square reserved for the compass, in tile widths. */
export const CENTRE_HALF_SIZE = TABLE_HALF_SIZE - SEAT_BAND_DEPTH;

/**
 * How far the wall ring reaches outside the playing surface, in tile widths.
 *
 * The ring is reserved now and drawn as an empty rail: a real wall is two rows
 * deep, and the two stacked tiles plus their slant need about this much plane
 * before the play area starts. Without it, later parts would have to shrink the
 * table to make room, shifting everything already laid out.
 */
export const WALL_RING_DEPTH = 1.5;

/**
 * How far the human's hand apron reaches in front of the wall ring, in tile
 * widths.
 *
 * The apron is the empty rail reserved for the bottom hand in a later part. It
 * is measured on the table plane, so it only ever adds to the footprint at the
 * human's edge; every other seat's hand sits inside the play area for now.
 */
export const HAND_APRON_DEPTH = 3;


/**
 * Project a table point onto the screen.
 *
 * A step away from the human moves up the screen by {@link ISO_DEPTH_SCALE},
 * and a step of height lifts the point by {@link ISO_HEIGHT_SCALE}. There is no
 * perspective divide, so parallel edges stay parallel and the projection is
 * exactly reversible for a known height (see {@link unproject}).
 */
export function project(point: TablePoint): ScreenPoint {
  return {
    x: point.x,
    y: -(point.y * ISO_DEPTH_SCALE + point.z * ISO_HEIGHT_SCALE),
  };
}

/**
 * Recover a table point from a screen point at a known height.
 *
 * `z` defaults to the table plane, which is what picking a discard or lining
 * up a river row needs. Passing a tile's height recovers the point on that
 * tile's layer instead.
 */
export function unproject(screen: ScreenPoint, z = 0): TablePoint {
  return {
    x: screen.x,
    y: (-screen.y - z * ISO_HEIGHT_SCALE) / ISO_DEPTH_SCALE,
    z,
  };
}

/**
 * Fit projected content into a viewport.
 *
 * The content is scaled by the tighter of the horizontal and vertical ratios,
 * so nothing is ever cropped, and it is centred in the viewport in both axes.
 * `padding` is a uniform inset in CSS pixels; the returned scale never lets the
 * content cross it, and the extra room on the looser axis stays symmetrical.
 *
 * A degenerate input cannot produce `NaN` or a negative scale: a viewport with
 * no room, or content with no size, resolves to scale 0 and a centred origin.
 */
export function fitProjection(
  viewport: Viewport,
  contentBounds: ProjectedBounds,
  padding = 0,
): Projection {
  const contentWidth = Math.max(0, contentBounds.maxX - contentBounds.minX);
  const contentHeight = Math.max(0, contentBounds.maxY - contentBounds.minY);
  const availableWidth = Math.max(0, viewport.width - padding * 2);
  const availableHeight = Math.max(0, viewport.height - padding * 2);

  // An axis with no size cannot constrain the scale; use the other one.
  const scaleByWidth =
    contentWidth > 0 ? availableWidth / contentWidth : Infinity;
  const scaleByHeight =
    contentHeight > 0 ? availableHeight / contentHeight : Infinity;
  const unconstrained = Math.min(scaleByWidth, scaleByHeight);
  const scale = Number.isFinite(unconstrained) ? unconstrained : 0;

  // Map the content's centre onto the viewport's centre. This is what keeps the
  // reserved apron included: the table itself sits above centre because the
  // footprint reaches further below it than above it.
  const centreX = (contentBounds.minX + contentBounds.maxX) / 2;
  const centreY = (contentBounds.minY + contentBounds.maxY) / 2;

  return {
    scale,
    origin: {
      x: viewport.width / 2 - centreX * scale,
      y: viewport.height / 2 - centreY * scale,
    },
  };
}

/**
 * The unit vector on the table plane from the centre out through the middle of
 * each seat's edge, in table coordinates.
 */
export const SIDE_NORMAL: Record<TableSide, { x: number; y: number }> = {
  bottom: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

/**
 * The unit vector along each seat's edge, running from that player's left to
 * their right.
 *
 * This is the direction a row of that player's tiles reads, and it agrees with
 * `SIDE_ROTATION` in `seatOrder`: turning a bottom-seat tile by a seat's
 * rotation maps this direction onto the screen direction the seat's edge runs.
 * A test pins that agreement so the projection and the existing seat helpers
 * cannot drift.
 */
export const SIDE_TANGENT: Record<TableSide, { x: number; y: number }> = {
  bottom: { x: 1, y: 0 },
  right: { x: 0, y: 1 },
  top: { x: -1, y: 0 },
  left: { x: 0, y: -1 },
};

/** The four corners of the playing surface, counter-clockwise from the human's left. */
export function tablePlaneCorners(
  halfSize = TABLE_HALF_SIZE,
): TableQuad {
  return [
    { x: -halfSize, y: -halfSize, z: 0 },
    { x: halfSize, y: -halfSize, z: 0 },
    { x: halfSize, y: halfSize, z: 0 },
    { x: -halfSize, y: halfSize, z: 0 },
  ];
}

/**
 * The outer rectangle of the wall ring: the play area plus room on every side.
 *
 * The wall is drawn on the same plane as the felt, so this is a rectangle
 * rather than an offset band. The felt is painted on top of it, which leaves
 * exactly the ring visible around the play area.
 */
export function wallRingCorners(
  halfSize = TABLE_HALF_SIZE,
  depth = WALL_RING_DEPTH,
): TableQuad {
  return tablePlaneCorners(halfSize + depth);
}

/**
 * The empty rail in front of the human's edge, reserved for their hand.
 *
 * It starts where the wall ring ends and extends towards the human by
 * {@link HAND_APRON_DEPTH}. Corners run left to right along the far edge, then
 * back along the near edge, so the projected quad reads in the same order as
 * the rest of the table geometry.
 */
export function handApronCorners(
  halfSize = TABLE_HALF_SIZE,
  wallDepth = WALL_RING_DEPTH,
  apronDepth = HAND_APRON_DEPTH,
): TableQuad {
  const outer = halfSize + wallDepth;
  const far = -outer;
  const near = -outer - apronDepth;

  return [
    { x: -outer, y: far, z: 0 },
    { x: outer, y: far, z: 0 },
    { x: outer, y: near, z: 0 },
    { x: -outer, y: near, z: 0 },
  ];
}

/** The projected bounding box of a set of table points, in tile widths. */
export function projectBounds(points: readonly TablePoint[]): ProjectedBounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const point of points) {
    const screen = project(point);
    minX = Math.min(minX, screen.x);
    maxX = Math.max(maxX, screen.x);
    minY = Math.min(minY, screen.y);
    maxY = Math.max(maxY, screen.y);
  }

  // An empty set has no extent, so it collapses onto the projected origin
  // instead of returning infinities.
  if (minX === Infinity) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  }

  return { minX, maxX, minY, maxY };
}

/**
 * The projected bounds of everything the isometric view reserves room for:
 * the playing surface, the wall ring around it, and the human's hand apron.
 *
 * This is the content {@link fitProjection} must fit, not the 12-by-12 play
 * area. Fitting the smaller rectangle would let later wall and hand parts spill
 * off the stage, and reserving the footprint now means adding them can never
 * move the play area.
 */
export function tableFootprintBounds(
  halfSize = TABLE_HALF_SIZE,
  wallDepth = WALL_RING_DEPTH,
  apronDepth = HAND_APRON_DEPTH,
): ProjectedBounds {
  return projectBounds([
    ...wallRingCorners(halfSize, wallDepth),
    ...handApronCorners(halfSize, wallDepth, apronDepth),
  ]);
}

/**
 * The centre square reserved for the compass.
 *
 * It is the hole left by the four seat bands, so its corners sit exactly where
 * the bands' inner corners meet.
 */
export function centreCorners(halfSize = CENTRE_HALF_SIZE): TableQuad {
  return tablePlaneCorners(halfSize);
}

/** The midpoint of a seat's outer edge, in table coordinates. */
export function seatEdgeMidpoint(
  side: TableSide,
  halfSize = TABLE_HALF_SIZE,
): TablePoint {
  const normal = SIDE_NORMAL[side];
  return { x: normal.x * halfSize, y: normal.y * halfSize, z: 0 };
}

/**
 * A seat's band: the trapezoid between the table edge and the centre square.
 *
 * The four bands miter at the corners, so together they tile the ring around
 * the centre with no overlap and no gaps. Corners run from the seat's own left
 * along its edge to its right, then back to the centre.
 */
export function seatBandCorners(
  side: TableSide,
  halfSize = TABLE_HALF_SIZE,
  depth = SEAT_BAND_DEPTH,
): TableQuad {
  const normal = SIDE_NORMAL[side];
  const tangent = SIDE_TANGENT[side];
  const edge = seatEdgeMidpoint(side, halfSize);
  const innerHalf = halfSize - depth;

  const outerLeft: TablePoint = {
    x: edge.x - tangent.x * halfSize,
    y: edge.y - tangent.y * halfSize,
    z: 0,
  };
  const outerRight: TablePoint = {
    x: edge.x + tangent.x * halfSize,
    y: edge.y + tangent.y * halfSize,
    z: 0,
  };
  const innerRight: TablePoint = {
    x: edge.x + tangent.x * innerHalf - normal.x * depth,
    y: edge.y + tangent.y * innerHalf - normal.y * depth,
    z: 0,
  };
  const innerLeft: TablePoint = {
    x: edge.x - tangent.x * innerHalf - normal.x * depth,
    y: edge.y - tangent.y * innerHalf - normal.y * depth,
    z: 0,
  };

  return [outerLeft, outerRight, innerRight, innerLeft];
}

/** Every seat's band, in turn order from the human's seat. */
export function seatBands(
  halfSize = TABLE_HALF_SIZE,
  depth = SEAT_BAND_DEPTH,
): Record<TableSide, TableQuad> {
  const bands = {} as Record<TableSide, TableQuad>;
  for (const side of TABLE_SIDES) {
    bands[side] = seatBandCorners(side, halfSize, depth);
  }
  return bands;
}

/**
 * The shared pseudo-lighting for the table, in tile widths.
 *
 * The light comes from above and to the viewer's left, so every tile's shadow
 * falls down and to the right. These are deliberately not real light transport:
 * they are the flat, fixed Tenhou-style cues that make a row of tiles read as
 * solid objects. Keeping them here means every seat shades the same way.
 */
export const ISO_LIGHT = {
  /** Horizontal shadow offset, in tile widths; positive is to the right. */
  shadowOffsetX: 0.12,
  /** Vertical shadow offset, in tile widths; positive is down the screen. */
  shadowOffsetY: 0.07,
  /** Shadow blur radius, in tile widths. */
  shadowBlur: 0.1,
  /** Opacity of a tile's shadow where it is darkest. */
  shadowOpacity: 0.36,
} as const;

/**
 * Brightness multipliers for a tile's faces, relative to its top face.
 *
 * The top face catches the light; the camera-facing vertical face is in shade.
 * A second, side-facing vertical face, where the artwork is turned so its side
 * shows, sits between the two.
 */
export const ISO_FACE_BRIGHTNESS = {
  top: 1,
  front: 0.74,
  side: 0.58,
} as const;
