import { SIDE_ROTATION, TABLE_SIDES } from './seatOrder';
import type { SeatRotation, TableSide } from './seatOrder';

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

/**
 * Converts a table point into the fitted view's SVG user space.
 *
 * The isometric table builds one of these from its {@link Projection} and hands
 * it to the tile renderers, so every part of the scene shares one scale.
 */
export type ToScreen = (point: TablePoint) => ScreenPoint;

/** Four screen points in painting order: a projected quadrilateral. */
export type ScreenQuad = readonly [
  ScreenPoint,
  ScreenPoint,
  ScreenPoint,
  ScreenPoint,
];

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
 * A mahjong tile's face width, in table units.
 *
 * A tile is three units wide for every four it is long, the same 3:4 proportion
 * as the `riichi-mahjong-tiles` artwork (a 300x400 viewBox). One table unit is
 * therefore a tile's long side: the river rows and seat bands are sized in that
 * unit, and a face is always 0.75 of one.
 */
export const TILE_FACE_WIDTH = 0.75;

/** A tile's face length, in table units; also the height of a standing tile. */
export const TILE_FACE_LENGTH = 1;

/** A tile's thickness, in table units: the depth of its body. */
export const TILE_THICKNESS = 0.5;

/**
 * How much of an upright tile's top face reads as its blue back, as a fraction
 * of the tile's thickness.
 *
 * A true orthographic camera at this pitch would hide the back plane entirely;
 * a standing tile only shows its ivory top edge. The sliver is the deliberate
 * Tenhou-style cue that the tile is a physical slab with a coloured back, and it
 * is what makes a row of hand tiles read as tiles rather than cards. It runs
 * along the far edge of the top face, so it never eats into the artwork.
 */
export const TILE_BACK_SLIVER = 0.3;

/**
 * How far a standing hand's face is set in from the human's apron edge, in tile
 * units.
 *
 * This is the only free number in the hand layout: the tile body reaches
 * {@link TILE_THICKNESS} back towards the table and the face rises
 * {@link TILE_FACE_LENGTH} above the plane, so its projected height is
 * `0.5 + sin(30°)` units. Setting it half a unit inside the apron edge keeps the
 * whole projected tile within the apron's 1.5-unit screen band, with a sliver
 * of table in front of it.
 */
export const HAND_FRONT_MARGIN = 0.5;

/** Face-to-face gap between neighbouring concealed hand tiles, in tile units. */
export const HAND_TILE_GAP = 0.04;

/**
 * The extra gap before the drawn tile, in tile units.
 *
 * A drawn tile stands apart from the thirteen concealed tiles so the hand reads
 * as "these are kept, this one just arrived", exactly as a player sets it down.
 * The gap is measured between the last concealed tile's face and the drawn
 * tile's face.
 */
export const HAND_DRAW_GAP = 0.5;

/** How many tiles a full concealed hand holds, before any call or the draw. */
export const HAND_CONCEALED_COUNT = 13;

/**
 * The width of the widest a hand can be: thirteen concealed tiles and a drawn
 * tile, with the draw's extra gap. Every hand is laid out from this left edge,
 * so drawing a tile never shifts the tiles already in hand.
 */
export const HAND_MAX_WIDTH =
  (HAND_CONCEALED_COUNT + 1) * TILE_FACE_WIDTH +
  (HAND_CONCEALED_COUNT - 1) * HAND_TILE_GAP +
  HAND_DRAW_GAP;

/**
 * The local x of the left edge of a hand row, in table units from the seat's
 * centre line.
 *
 * The full fourteen-tile hand is centred on the seat, and a shorter hand (after
 * a call) keeps that same left edge. The empty room that leaves on the right is
 * where the called melds will sit in a later part.
 */
export const HAND_LEFT = -HAND_MAX_WIDTH / 2;

/**
 * Distance from the table centre to a standing hand's face plane, in tile
 * units, along the seat's outward normal.
 *
 * The face is the outermost plane of the tile, so the body runs
 * {@link TILE_THICKNESS} back from here. The apron's own edge is
 * {@link HAND_FRONT_MARGIN} further out.
 */
export const HAND_FACE_OFFSET =
  TABLE_HALF_SIZE + WALL_RING_DEPTH + HAND_APRON_DEPTH - HAND_FRONT_MARGIN;


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
 * One tile's place in a seat's concealed hand.
 *
 * Coordinates are already on the table: the slot's `centre` is the middle of
 * the tile's face along its bottom edge, on the table plane. The renderer raises
 * the face from there.
 */
export interface HandSlot {
  /** Index into the concealed hand, or `-1` for the drawn tile. */
  index: number;
  /** True for the tile just drawn, which stands apart from the rest. */
  isDraw: boolean;
  /** Middle of the face's bottom edge, in table coordinates. */
  centre: TablePoint;
  /** Clockwise turn of the tile from the human's own reading direction. */
  rotation: SeatRotation;
}

/**
 * Lay a seat's concealed hand out on the table, in tile units.
 *
 * Tiles are placed edge to edge with a hairline gap so their thicknesses read
 * separately. The row is anchored at {@link HAND_LEFT}, which is the left edge
 * of a full fourteen-tile hand, so the concealed tiles never move when the draw
 * arrives; the drawn tile stands one gap further out. A hand shortened by a
 * call keeps the same left edge, leaving the room its melds will take on the
 * seat's right.
 *
 * The slots run in the seat's own reading order, from that player's left to
 * their right, and are already turned to the seat's edge: `centre` is measured
 * along the seat's tangent and outward normal, and `rotation` is its
 * {@link SIDE_ROTATION}. The bottom seat is the human's own, with a rotation of
 * zero, so its slots run left to right on screen.
 */
export function handSlots(
  side: TableSide,
  concealed: number,
  hasDraw: boolean,
): HandSlot[] {
  const count = Math.max(0, Math.floor(concealed));
  const tangent = SIDE_TANGENT[side];
  const normal = SIDE_NORMAL[side];
  const rotation = SIDE_ROTATION[side];

  const seatPoint = (localX: number): TablePoint => ({
    x: tangent.x * localX + normal.x * HAND_FACE_OFFSET,
    y: tangent.y * localX + normal.y * HAND_FACE_OFFSET,
    z: 0,
  });

  const slots: HandSlot[] = [];
  for (let index = 0; index < count; index += 1) {
    const localX = HAND_LEFT + index * (TILE_FACE_WIDTH + HAND_TILE_GAP);
    slots.push({
      index,
      isDraw: false,
      centre: seatPoint(localX + TILE_FACE_WIDTH / 2),
      rotation,
    });
  }

  if (hasDraw) {
    const drawLeft =
      count === 0
        ? HAND_LEFT
        : HAND_LEFT +
          count * TILE_FACE_WIDTH +
          (count - 1) * HAND_TILE_GAP +
          HAND_DRAW_GAP;
    slots.push({
      index: -1,
      isDraw: true,
      centre: seatPoint(drawLeft + TILE_FACE_WIDTH / 2),
      rotation,
    });
  }

  return slots;
}

/** Turn a table-plane direction clockwise by a seat rotation, in degrees. */
function rotatePlan(
  direction: { x: number; y: number },
  rotation: SeatRotation,
): { x: number; y: number } {
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: direction.x * cos + direction.y * sin,
    y: -direction.x * sin + direction.y * cos,
  };
}

/**
 * Where a standing tile's artwork face sits on screen.
 *
 * `origin` is the face's top-left corner, `across` runs along the face's width
 * to its top-right corner, and `down` runs down the face to its bottom-left
 * corner. Those three are an affine frame: mapping the 300x400 tile artwork
 * onto `origin + across * (x / 300) + down * (y / 400)` puts the art on the
 * face with its top towards the tile's top, at any seat rotation.
 */
export interface TileFaceFrame {
  origin: ScreenPoint;
  across: ScreenPoint;
  down: ScreenPoint;
}

/**
 * A tile's visible faces, in SVG user space.
 *
 * The artwork always goes on `face`; `outline` is that face's edge, and `edge`
 * is the face that shows the tile's thickness (its top when standing, its front
 * side when lying flat). `silhouette` is the union of the face and the
 * thickness, so the body is painted as one connected shape with no seam across
 * the tile's own edge.
 */
export interface TileFaces {
  /** Affine frame for the tile's artwork. */
  face: TileFaceFrame;
  /** The artwork face's outline, clockwise from its top-left. */
  outline: ScreenQuad;
  /** The tile's thickness, facing the camera. */
  edge: ScreenQuad;
  /** The whole visible body, as one closed outline. */
  silhouette: readonly ScreenPoint[];
  /**
   * The strip of blue back visible along an upright tile's far top edge, or
   * absent when the tile lies face-up and its back is against the table.
   */
  back?: ScreenQuad;
}

/** Interpolate between two screen points. */
function lerpScreen(
  from: ScreenPoint,
  to: ScreenPoint,
  amount: number,
): ScreenPoint {
  return {
    x: from.x + (to.x - from.x) * amount,
    y: from.y + (to.y - from.y) * amount,
  };
}

/**
 * Project a standing tile: its face towards its own seat, its top visible.
 *
 * A hand tile stands up on the table, so the camera sees the full artwork face
 * and a thin top face beyond it, exactly like the real tiles in front of a
 * player. The face's height is foreshortened by {@link ISO_HEIGHT_SCALE} (the
 * 30° pitch), and the top face by {@link ISO_DEPTH_SCALE}; both stay in tile
 * units, so the same code works at any fitted scale.
 *
 * `centre` is the middle of the face's bottom edge, as placed by
 * {@link handSlots}, and `rotation` turns the tile to its seat. Only the human's
 * bottom seat is drawn as a face for now; a face turned away from the camera
 * collapses to a line, which is the cue a later part needs for tile backs.
 */
export function uprightTileFaces(
  centre: TablePoint,
  rotation: SeatRotation,
  toScreen: ToScreen,
): TileFaces {
  const acrossDirection = rotatePlan({ x: 1, y: 0 }, rotation);
  const inwardDirection = rotatePlan({ x: 0, y: 1 }, rotation);
  const half = TILE_FACE_WIDTH / 2;

  const corner = (
    along: number,
    inward: number,
    height: number,
  ): TablePoint => ({
    x:
      centre.x +
      acrossDirection.x * along +
      inwardDirection.x * inward,
    y:
      centre.y +
      acrossDirection.y * along +
      inwardDirection.y * inward,
    z: centre.z + height,
  });

  const bottomLeft = toScreen(corner(-half, 0, 0));
  const bottomRight = toScreen(corner(half, 0, 0));
  const topLeft = toScreen(corner(-half, 0, TILE_FACE_LENGTH));
  const topRight = toScreen(corner(half, 0, TILE_FACE_LENGTH));
  const backLeft = toScreen(
    corner(-half, TILE_THICKNESS, TILE_FACE_LENGTH),
  );
  const backRight = toScreen(
    corner(half, TILE_THICKNESS, TILE_FACE_LENGTH),
  );

  return {
    face: {
      origin: topLeft,
      across: {
        x: topRight.x - topLeft.x,
        y: topRight.y - topLeft.y,
      },
      down: {
        x: bottomLeft.x - topLeft.x,
        y: bottomLeft.y - topLeft.y,
      },
    },
    outline: [topLeft, topRight, bottomRight, bottomLeft],
    edge: [topLeft, topRight, backRight, backLeft],
    silhouette: [
      bottomLeft,
      bottomRight,
      topRight,
      backRight,
      backLeft,
      topLeft,
    ],
    back: [
      backLeft,
      backRight,
      lerpScreen(backRight, topRight, TILE_BACK_SLIVER),
      lerpScreen(backLeft, topLeft, TILE_BACK_SLIVER),
    ],
  };
}

/**
 * Project a tile lying face-up on the table, as discards and melds do.
 *
 * The artwork sits on the tile's top face, with the top of the tile away from
 * its owner so the owner reads it upright; the tile's front side is the
 * thickness band facing the camera. `centre` is the middle of the top face's
 * footprint on the table plane, and `rotation` is the owner's seat rotation.
 *
 * `sideways` turns the whole tile a quarter turn, the convention both for a
 * Riichi declaration discard and for a called tile inside a meld. Turning the
 * tile rather than only its artwork keeps the footprint truthful: a sideways
 * tile is one long by three-quarters wide, exactly as it lies on the table.
 */
export function flatTileFaces(
  centre: TablePoint,
  rotation: SeatRotation,
  toScreen: ToScreen,
  sideways = false,
): TileFaces {
  const turn = ((rotation + (sideways ? 90 : 0)) % 360) as SeatRotation;
  const acrossDirection = rotatePlan({ x: 1, y: 0 }, turn);
  const inwardDirection = rotatePlan({ x: 0, y: 1 }, turn);
  const halfWidth = TILE_FACE_WIDTH / 2;
  const halfLength = TILE_FACE_LENGTH / 2;

  const corner = (
    along: number,
    inward: number,
    height: number,
  ): TablePoint => ({
    x:
      centre.x +
      acrossDirection.x * along +
      inwardDirection.x * inward,
    y:
      centre.y +
      acrossDirection.y * along +
      inwardDirection.y * inward,
    z: centre.z + height,
  });

  const topFarLeft = toScreen(
    corner(-halfWidth, halfLength, TILE_THICKNESS),
  );
  const topFarRight = toScreen(
    corner(halfWidth, halfLength, TILE_THICKNESS),
  );
  const topNearLeft = toScreen(
    corner(-halfWidth, -halfLength, TILE_THICKNESS),
  );
  const topNearRight = toScreen(
    corner(halfWidth, -halfLength, TILE_THICKNESS),
  );
  const bottomNearLeft = toScreen(corner(-halfWidth, -halfLength, 0));
  const bottomNearRight = toScreen(corner(halfWidth, -halfLength, 0));

  return {
    face: {
      origin: topFarLeft,
      across: {
        x: topFarRight.x - topFarLeft.x,
        y: topFarRight.y - topFarLeft.y,
      },
      down: {
        x: topNearLeft.x - topFarLeft.x,
        y: topNearLeft.y - topFarLeft.y,
      },
    },
    outline: [topFarLeft, topFarRight, topNearRight, topNearLeft],
    edge: [topNearLeft, topNearRight, bottomNearRight, bottomNearLeft],
    silhouette: [
      topFarLeft,
      topFarRight,
      topNearRight,
      bottomNearRight,
      bottomNearLeft,
      topNearLeft,
    ],
  };
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
