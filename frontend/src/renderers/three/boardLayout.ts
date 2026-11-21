/**
 * World-space board layout engine (3D-06).
 *
 * `layoutBoard` turns a {@link TableSnapshot} into exact world poses for every
 * tile the 3D table draws, and `frameForAspect` solves the committed camera rig
 * for a viewport aspect. Both are pure: no three.js, no DOM, no clock. The
 * renderer (`RendererHost`/`Scene`, 3D-02, and `boardMesh`, 3D-07) consumes the
 * poses and the solved frame; the DOM overlay (3D-08) projects the same poses,
 * so there is exactly one source of truth for where a tile is.
 *
 * World space (see `layoutConstants.ts`): 1 unit = 28 mm, +X right, +Y up, +Z
 * toward the human. Seat `k` sits at yaw `90k` degrees, so its frame is
 *
 *   u = outward, from the table centre toward that player,
 *   w = that player's right,
 *   v = up (world +Y),
 *
 * and a point is `centre + u·û + w·ŵ + v·ŷ`. Every zone is authored once in that
 * frame, which is why the four seats are exact rotations of each other.
 *
 * Tile pose convention, matching the tile mesh (`tileGeometry.ts`, 3D-04): the
 * face is +Z, the glyph reads with +Y up and +X right, and the body is
 * `TILE.widthUnits × TILE.heightUnits × TILE.thicknessUnits`. A pose applies
 * `Ry(yaw) · Rx(tilt) · Rz(roll)`, so
 *
 *   tilt  0  = standing upright, face toward the seat's own player,
 *   tilt -90 = lying face up (pond, meld, dora indicator),
 *   tilt +90 = lying face down (the wall),
 *   tilt -40 = the human hand, reclined 40° back from upright,
 *   roll -90 = the tile turned in its own face plane (riichi discard, called
 *              meld tile), glyph top toward the seat's right.
 *
 * Decisions this module implements, and where they come from:
 *
 * - Hand recline is the recorded user decision (40° back from upright, accepted
 *   band 30–45°, no rail). The gate is numeric: the angle between the hand's
 *   face normal and the camera's view direction must be ≤ 25° at every
 *   supported aspect (plan §2.4, §9 decision 3). See
 *   {@link handFaceToViewDeg} for exactly what that angle is.
 * - The wall is the real, depleted wall: the live wall's remaining tiles (from
 *   `compass.tilesRemaining`, drawn top tier first from the break end) plus the
 *   fixed 14-tile dead wall on the far run, separated by a felt break. The draw
 *   end is at each seat's right (`WALL.drawEndIsSeatRight`); `renderers/wall.ts`
 *   owns which live slots exist.
 * - Dead-wall positions are shifted along the far run by
 *   `WALL.deadWallGapUnits`; dora indicators replace its top-tier tiles, counting
 *   in from the draw end, so no tile is ever drawn twice (`DORA`).
 * - Ponds fill from the far row toward the player, and the four overflow cells
 *   extend the nearest row (`POND`).
 * - A seat's hand, draw and open melds are one contiguous row: the melds take
 *   the row's right end (the player's right), the concealed hand slides left,
 *   and the row stays inside the meld-free board's extents, so declaring a meld
 *   does not move the camera (261120-2225; `rowAnchorUnits`, `meldRadius`).
 * - Opponent hands are upright and face-down; only the human's concealed hand
 *   and draw are face-up (the snapshot's own `faceUp` flag is kept for the
 *   human and overridden for the other seats).
 *
 * Framing lives here too, because it is pure world-space math with no renderer
 * state: `frameForAspect` solves the committed rig's eye distance per aspect and
 * {@link referenceFrame} exposes the unsolved reference pose. The numbers are
 * gated by `frontend/scripts/check-3d-layout.mjs`, including the reference
 * agreement recorded by the retired calibration rig (git history).
 */

import type {
  Seat,
  SnapshotTile,
  TableSnapshot,
  TileFaceId,
  Zone,
} from '../contract';
import {
  CAMERA,
  COMPASS_PLATE,
  DORA,
  HAND,
  MELD,
  POND,
  SEATS,
  STICK,
  TABLE,
  TILE,
  WALL,
} from '../layoutConstants';
import { decodeWallSlot, isDeadWallSlot } from '../wall';

/** A point or vector in world space, in tile units. */
export type Vec3 = readonly [number, number, number];

/** A 4×4 matrix as 16 numbers, column-major: the layout three's `Matrix4` takes. */
export type Mat4 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** One tile's placement: where its body centre is and how it is turned. */
export interface TilePose {
  readonly position: Vec3;
  /** Rotation about world +Y, in degrees. `90k` for seat `k`. */
  readonly yawDeg: number;
  /** Rotation about the tile's own +X after yaw, in degrees (see the header). */
  readonly tiltDeg: number;
  /** Rotation about the tile's own face normal, in degrees; `-90` is sideways. */
  readonly rollDeg: number;
  /** The tile body's full extents along its own X, Y and Z axes. */
  readonly sizeUnits: Vec3;
}

/** One drawn tile: the snapshot tile it came from plus its world pose. */
export interface BoardTile {
  /** Stable across calls: `zone-seat-slot` or `zone-slot` for table-level tiles. */
  readonly id: string;
  readonly zone: Zone;
  /** Absolute seat, or null for the wall and the dora indicators. */
  readonly seat: Seat | null;
  readonly slot: number;
  /** The art id. A face-down tile keeps its face for the overlay, not the renderer. */
  readonly face: TileFaceId;
  /** Whether the renderer draws the face or the blue back. */
  readonly faceUp: boolean;
  /** Turned in its own plane: a riichi discard or a called meld tile. */
  readonly sideways: boolean;
  readonly highlighted: boolean;
  readonly dimmed: boolean;
  readonly pose: TilePose;
}

/** One riichi stick on the felt. Table furniture, not a tile. */
export interface BoardStick {
  readonly id: string;
  /**
   * The declarer whose side of the compass the stick sits on (3D-09: one stick
   * per seat whose `riichi` flag is true, exactly as `PhysicalTable` draws it).
   */
  readonly seat: Seat;
  /** Body centre; the stick lies lengthwise along its seat's edge. */
  readonly position: Vec3;
  /** Rotation about world +Y, degrees: the seat's own yaw. */
  readonly yawDeg: number;
  /** Full extents along X, Y and Z, before the yaw. */
  readonly sizeUnits: Vec3;
}

/** Everything the renderer needs to draw one table. */
export interface BoardLayout {
  /** The absolute seat the human is in; the wall inset and the hand poses follow it. */
  readonly humanSeat: Seat;
  /** Every tile, in a stable authoring order (not a paint order). */
  readonly tiles: readonly BoardTile[];
  /** Every wall-zone tile: the live wall plus the dead wall (dora aside). */
  readonly wall: readonly BoardTile[];
  /** Everything except the wall: hands, draws, rivers, melds and dora. */
  readonly foreground: readonly BoardTile[];
  /** One per point stick the compass reports. */
  readonly sticks: readonly BoardStick[];
}

/** An oriented box: the collision and framing shape of one tile. */
export interface OrientedBox {
  readonly centre: Vec3;
  /** Unit axes along the body's own X, Y and Z. */
  readonly axes: readonly [Vec3, Vec3, Vec3];
  readonly halfExtents: Vec3;
}

/** One solved camera placement for one viewport aspect. */
export interface CameraFrame {
  readonly aspect: number;
  /** Degrees below horizontal. */
  readonly pitchDeg: number;
  /** Eye distance along the view direction, from the target. */
  readonly distanceUnits: number;
  readonly eye: Vec3;
  readonly target: Vec3;
  /** `tan` of the half horizontal field of view (sensor fit horizontal). */
  readonly tanHalfHorizontal: number;
  /** `tan` of the half vertical field of view. */
  readonly tanHalfVertical: number;
  /** The projection's NDC-space y offset (Blender's Shift Y, in sensor widths). */
  readonly shiftNdcY: number;
}

const DEG = Math.PI / 180;

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** The committed tile body size, along its own X, Y and Z. */
const TILE_SIZE: Vec3 = [
  TILE.widthUnits,
  TILE.heightUnits,
  TILE.thicknessUnits,
];

/** A seat's yaw in degrees. Turn order is 0, 90, 180, 270 from the human. */
export function seatYawDeg(seat: Seat): number {
  return SEATS.relativeRotationDeg[seat];
}

/**
 * A seat's outward and right unit vectors in world space.
 *
 * Seat 0 (the human) sits on +Z and faces the table centre, so its right is +X;
 * each next seat is a further +90° about +Y.
 */
export function seatBasis(seat: Seat): { readonly outward: Vec3; readonly right: Vec3 } {
  const yaw = seatYawDeg(seat) * DEG;
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  return { outward: [s, 0, c], right: [c, 0, -s] };
}

/**
 * A point in a seat's frame: `w` along its right, `u` outward from the table
 * centre, `v` up.
 */
export function seatPoint(seat: Seat, w: number, u: number, v: number): Vec3 {
  const { outward, right } = seatBasis(seat);
  return [w * right[0] + u * outward[0], v, w * right[2] + u * outward[2]];
}

/**
 * The rotation matrix `Ry(yaw) · Rx(tilt) · Rz(roll)` as a column-major 4×4.
 *
 * The renderer feeds this straight into an `InstancedMesh` matrix; tests and
 * the layout gate use {@link poseAxes} instead.
 */
export function poseMatrix(pose: TilePose): Mat4 {
  const y = pose.yawDeg * DEG;
  const t = pose.tiltDeg * DEG;
  const r = pose.rollDeg * DEG;
  const cy = Math.cos(y);
  const sy = Math.sin(y);
  const ct = Math.cos(t);
  const st = Math.sin(t);
  const cr = Math.cos(r);
  const sr = Math.sin(r);

  // Rx · Rz, then Ry · (Rx · Rz).
  const m00 = cy * cr + sy * st * sr;
  const m01 = -cy * sr + sy * st * cr;
  const m02 = sy * ct;
  const m10 = ct * sr;
  const m11 = ct * cr;
  const m12 = -st;
  const m20 = -sy * cr + cy * st * sr;
  const m21 = sy * sr + cy * st * cr;
  const m22 = cy * ct;

  return [
    m00,
    m10,
    m20,
    0,
    m01,
    m11,
    m21,
    0,
    m02,
    m12,
    m22,
    0,
    pose.position[0],
    pose.position[1],
    pose.position[2],
    1,
  ];
}

/** The tile's own X (right), Y (glyph up) and Z (face normal) axes in world space. */
export function poseAxes(
  pose: TilePose,
): readonly [Vec3, Vec3, Vec3] {
  const m = poseMatrix(pose);
  return [
    [m[0], m[1], m[2]],
    [m[4], m[5], m[6]],
    [m[8], m[9], m[10]],
  ];
}

/** The tile's oriented box, for collision and framing. */
export function orientedBox(pose: TilePose): OrientedBox {
  const axes = poseAxes(pose);
  return {
    centre: pose.position,
    axes,
    halfExtents: mul(pose.sizeUnits, 0.5),
  };
}

/** The eight corners of an oriented box. */
export function orientedBoxCorners(box: OrientedBox): Vec3[] {
  const [ax, ay, az] = box.axes;
  const [hx, hy, hz] = box.halfExtents;
  const corners: Vec3[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        corners.push(
          add(
            box.centre,
            add(
              add(mul(ax, sx * hx), mul(ay, sy * hy)),
              mul(az, sz * hz),
            ),
          ),
        );
      }
    }
  }
  return corners;
}

/**
 * Separating-axis test for two oriented boxes.
 *
 * `epsilon` is the penetration depth that still counts as separated: the
 * committed 0.0107-unit grooves are far larger, so a true tolerance is never
 * reported as an overlap. The 15 candidate axes are each box's own three plus
 * the nine cross products (skipping degenerate near-parallel ones).
 */
export function orientedBoxesIntersect(
  a: OrientedBox,
  b: OrientedBox,
  epsilon = 1e-6,
): boolean {
  const axesA = a.axes;
  const axesB = b.axes;
  const candidates: Vec3[] = [...axesA, ...axesB];
  for (const ax of axesA) {
    for (const bx of axesB) {
      const c = cross(ax, bx);
      const length = Math.hypot(c[0], c[1], c[2]);
      if (length > 1e-9) candidates.push([c[0] / length, c[1] / length, c[2] / length]);
    }
  }
  const d = sub(b.centre, a.centre);
  for (const axis of candidates) {
    const ra =
      Math.abs(dot(axesA[0], axis)) * a.halfExtents[0] +
      Math.abs(dot(axesA[1], axis)) * a.halfExtents[1] +
      Math.abs(dot(axesA[2], axis)) * a.halfExtents[2];
    const rb =
      Math.abs(dot(axesB[0], axis)) * b.halfExtents[0] +
      Math.abs(dot(axesB[1], axis)) * b.halfExtents[1] +
      Math.abs(dot(axesB[2], axis)) * b.halfExtents[2];
    const distance = Math.abs(dot(d, axis));
    if (distance >= ra + rb - epsilon) return false;
  }
  return true;
}

/**
 * A wall run's centre-line radius.
 *
 * The runs at the human's own edge and the far edge are the **end** runs: they
 * are inset so their outer face is flush with a side run's end tile
 * ({@link WALL.endRunRadiusUnits}). The two side runs stay on the committed
 * ring. Everything that places a wall tile — the live run, the shifted dead
 * block and the dora indicators — goes through this function, so they can never
 * disagree.
 */
export function wallRunRadius(run: Seat, humanSeat: Seat): number {
  const farSeat = ((humanSeat + 2) % SEATS.count) as Seat;
  return run === humanSeat || run === farSeat
    ? WALL.endRunRadiusUnits
    : WALL.radiusUnits;
}

/** The dead-wall stack a dora indicator replaces on the top tier. */
function doraStack(index: number): number {
  return WALL.drawEndSlot - DORA.firstStackFromDrawEnd - index;
}

/**
 * A stack's tangential centre line on its run, in tile units.
 *
 * The dead wall uses the same function plus {@link WALL.deadWallGapUnits}, so a
 * revealed indicator and the dead block it belongs to can never drift apart.
 */
function wallStackW(stack: number): number {
  return (stack - (WALL.stacksPerRun - 1) / 2) * WALL.stackPitchUnits;
}

/**
 * A wall tier's body-centre height above the felt.
 *
 * The bottom tier lies on the cloth (`thickness / 2`); the top tier's centre is
 * one **tier step** above it, and `WALL.tierStepUnits` already includes the
 * lower tile's full thickness plus the 0.3 mm tier gap, so the thickness is not
 * added a second time. (It was, and the top row floated 16.5 mm above the row
 * it is supposed to sit on — the board handoff's "the top row is not lined up
 * with the bottom row".) Both tiers share the same stack centre and yaw, so the
 * two bodies line up exactly; only their height differs.
 */
export function wallTierHeightUnits(tier: number): number {
  return tier === 0
    ? TILE.thicknessUnits / 2
    : WALL.tierStepUnits + TILE.thicknessUnits / 2;
}

function tileId(prefix: string, seat: Seat | null, slot: number): string {
  return seat === null ? `${prefix}-${slot}` : `${prefix}-${seat}-${slot}`;
}

function boardTile(
  tile: SnapshotTile,
  seat: Seat | null,
  pose: TilePose,
  faceUp: boolean,
): BoardTile {
  return {
    id: tileId(tile.zone, seat, tile.slot),
    zone: tile.zone,
    seat,
    slot: tile.slot,
    face: tile.face,
    faceUp,
    sideways: tile.sideways,
    highlighted: tile.highlighted === true,
    dimmed: tile.dimmed === true,
    pose,
  };
}

/** A lying tile (pond, meld, dora): face up, body centre half a thickness up. */
function lyingPose(
  seat: Seat,
  w: number,
  u: number,
  height: number,
  yawDeg: number,
  rollDeg = 0,
): TilePose {
  return {
    position: seatPoint(seat, w, u, height),
    yawDeg,
    tiltDeg: -90,
    rollDeg,
    sizeUnits: TILE_SIZE,
  };
}

/**
 * A seat's hand radius: the near/far seats sit a tile thickness closer to their
 * (inset) end run than the side seats do. Mirrors {@link wallRunRadius}, so a
 * seat's hand always faces its own run.
 */
export function handRadius(seat: Seat, humanSeat: Seat): number {
  const farSeat = ((humanSeat + 2) % SEATS.count) as Seat;
  return seat === humanSeat || seat === farSeat
    ? HAND.endSeatRadiusUnits
    : HAND.backRadiusUnits;
}

/** The human hand's reclined pose, or an opponent's upright one. */
function handPose(
  seat: Seat,
  w: number,
  reclined: boolean,
  radius: number,
): TilePose {
  const tiltDeg = reclined ? -HAND.reclineDeg : 0;
  const phi = tiltDeg * DEG;
  const u0 = TILE.thicknessUnits / 2;
  const v0 = TILE.heightUnits / 2;
  // The tile stands on its far bottom edge at the seat's hand radius and leans
  // back about that edge; the body centre moves with the tilt.
  const du = u0 * Math.cos(phi) + v0 * Math.sin(phi);
  const dv = v0 * Math.cos(phi) - u0 * Math.sin(phi);
  return {
    position: seatPoint(seat, w, radius + du, dv),
    yawDeg: seatYawDeg(seat),
    tiltDeg,
    rollDeg: 0,
    sizeUnits: TILE_SIZE,
  };
}

/**
 * The right edge a **meld-free** 13-tile hand occupies, without its draw.
 *
 * This is the anchor the whole visible row (hand, draw, melds) is laid around
 * (`rowAnchorUnits` adds the tsumogiri draw when the seat has one). A meld-free
 * row puts its draw's right edge exactly here, reproducing the committed
 * `HAND.drawOffsetUnits` draw slot to the digit.
 */
const MELD_FREE_HAND_RIGHT_UNITS =
  ((HAND.concealedCount - 1) / 2) * HAND.pitchUnits + TILE.widthUnits / 2;

/**
 * The right edge a seat's visible row is anchored to.
 *
 * A meld-free row sits exactly here. A meld row is longer than the hand and draw
 * it replaces, and that growth is split evenly: half extends past this edge, half
 * pushes the concealed hand left. Neither end leaves the board's existing
 * extents, which is what keeps the framed camera still.
 */
export function rowAnchorUnits(hasDraw: boolean): number {
  return hasDraw
    ? MELD_FREE_HAND_RIGHT_UNITS + HAND.drawGapUnits + TILE.widthUnits
    : MELD_FREE_HAND_RIGHT_UNITS;
}

/** One meld's tangential width: its tiles touch inside the slab. */
function meldWidth(meld: TableSnapshot['seats'][number]['melds'][number]): number {
  return meld.tiles.reduce(
    (sum, tile, index) =>
      sum +
      (tile.sideways ? TILE.heightUnits : TILE.widthUnits) +
      (index === 0 ? 0 : MELD.slotGapUnits),
    0,
  );
}

/** A whole meld line's width, including the felt between different melds. */
function meldLineWidth(
  melds: TableSnapshot['seats'][number]['melds'],
): number {
  if (melds.length === 0) return 0;
  return (
    melds.reduce((sum, meld) => sum + meldWidth(meld), 0) +
    (melds.length - 1) * MELD.meldGapUnits
  );
}

/**
 * The meld line's centre radius for a seat.
 *
 * A lying meld is flat, so its **outer bottom edge** is its lowest point on
 * screen; a hand has a leaning face whose raised corners sit further out without
 * projecting as low. The reclined human hand's front face is exactly at its hand
 * radius, so the human's melds are pulled one tile height in, putting their outer
 * edge flush with that face. Otherwise the meld line would be the board's nearest
 * tile and `frameForAspect` would solve further back — the "camera zooms out on
 * melds" defect. An upright opponent hand's body already reaches half a tile
 * thickness past its radius, so a meld at the hand radius stays inside it.
 *
 * The inset keeps the line clear of the human's own (inset) end wall: the line's
 * near edge sits 7.3 mm in front of that run's face, and the hand itself keeps
 * its committed 36 mm to the run.
 */
function meldRadius(handRadiusUnits: number, isHuman: boolean): number {
  return isHuman ? handRadiusUnits - TILE.heightUnits / 2 : handRadiusUnits;
}

/**
 * One seat's whole visible row: concealed hand, drawn tile, then every meld, in
 * a single line at the seat's hand radius.
 *
 * The row is anchored to {@link rowAnchorUnits} plus half of its growth, so with
 * no melds it is the committed hand + draw layout, and each meld takes the row's
 * right end while the concealed hand and the draw slide left (the player's left).
 * Additional melds extend the line toward the hand, never into a second row, and
 * the whole assembly stays inside the board's existing world extents.
 * `cornerShiftUnits` moves the meld line alone further right, for the near/far
 * rows whose corners have viewport room; it is zero on the side rows.
 */
function placeSeatRow(
  seatState: TableSnapshot['seats'][number],
  seat: Seat,
  radius: number,
  isHuman: boolean,
  cornerShiftUnits: number,
): BoardTile[] {
  const melds = seatState.melds;
  const handWidth = seatState.concealed.length * HAND.pitchUnits;
  const drawWidth = seatState.draw ? HAND.drawGapUnits + TILE.widthUnits : 0;
  const meldBlock =
    melds.length > 0 ? MELD.rowClearanceUnits + meldLineWidth(melds) : 0;
  const meldFreeWidth =
    HAND.concealedCount * HAND.pitchUnits + drawWidth;
  const growth = handWidth + drawWidth + meldBlock - meldFreeWidth;
  // A meld replaces three concealed tiles, so the row grows by only the meld's
  // extra width. Centre that growth on the meld-free anchor: the melds take the
  // row's right end and the concealed hand slides left, but neither end has to
  // absorb all of the extra span (which would push a side hand's end toward the
  // camera and cost a little of the solved distance back at portrait aspects).
  const left =
    rowAnchorUnits(seatState.draw !== null) + growth / 2 -
    (handWidth + drawWidth + meldBlock);
  const meldRowRadius = meldRadius(radius, isHuman);

  const placed: BoardTile[] = [];
  const handFaceUp = isHuman;

  seatState.concealed.forEach((tile, index) => {
    const w = left + (index + 0.5) * HAND.pitchUnits;
    placed.push(
      boardTile(
        tile,
        seat,
        handPose(seat, w, isHuman, radius),
        handFaceUp && tile.faceUp,
      ),
    );
  });

  if (seatState.draw) {
    const w = left + handWidth + HAND.drawGapUnits + TILE.widthUnits / 2;
    placed.push(
      boardTile(
        seatState.draw,
        seat,
        handPose(seat, w, isHuman, radius),
        handFaceUp && seatState.draw.faceUp,
      ),
    );
  }

  // The melds fill the line's right end, starting after the draw with the
  // committed clearance plus the player's corner shift, and separated from each
  // other by 2.8 mm. The hand and draw stay put: only the meld line moves right.
  let cursor =
    left +
    handWidth +
    drawWidth +
    (melds.length > 0
      ? MELD.rowClearanceUnits + cornerShiftUnits
      : 0);
  melds.forEach((meld, meldIndex) => {
    if (meldIndex > 0) cursor += MELD.meldGapUnits;
    for (const tile of meld.tiles) {
      const half = tile.sideways
        ? TILE.heightUnits / 2
        : TILE.widthUnits / 2;
      placed.push(
        boardTile(
          tile,
          seat,
          lyingPose(
            seat,
            cursor + half,
            meldRowRadius,
            TILE.thicknessUnits / 2,
            seatYawDeg(seat),
            tile.sideways ? -90 : 0,
          ),
          tile.faceUp,
        ),
      );
      cursor += half * 2 + MELD.slotGapUnits;
    }
  });

  return placed;
}

/**
 * One pond row's tangential tile centres, in chronological order.
 *
 * The row's left edge is fixed at `-POND.columnCentreOffsetUnits - half a tile`,
 * which puts an all-upright row's first centre exactly on the reference's
 * `-columnCentreOffsetUnits`. A turned tile is wider along the row, so the cursor
 * advances by whichever of its two extents faces the row; there is no gap
 * (`POND.columnGapUnits` is 0), so consecutive discards touch.
 */
function placeRow(tiles: readonly SnapshotTile[]): number[] {
  let cursor = -POND.columnCentreOffsetUnits - TILE.widthUnits / 2;
  const centres: number[] = [];
  for (const tile of tiles) {
    const half = tile.sideways
      ? TILE.heightUnits / 2
      : TILE.widthUnits / 2;
    const centre = cursor + half;
    centres.push(centre);
    cursor = centre + half + POND.columnGapUnits;
  }
  return centres;
}

/** Chronological discards grouped by pond row: far row first, overflow last. */
function pondRows(
  river: readonly SnapshotTile[],
): { readonly row: number; readonly tiles: readonly SnapshotTile[] }[] {
  const rows: { row: number; tiles: SnapshotTile[] }[] = [];
  for (let index = 0; index < river.length; index += POND.columns) {
    const block = river.slice(index, index + POND.columns);
    const blockIndex = index / POND.columns;
    // Full blocks fill the far row first; the overflow anchors extend the
    // nearest row, so a final partial block stays on that row too.
    const row =
      blockIndex < POND.rows ? POND.rows - 1 - blockIndex : POND.overflowRow;
    const existing = rows.find((entry) => entry.row === row);
    if (existing) existing.tiles.push(...block);
    else rows.push({ row, tiles: [...block] });
  }
  return rows;
}

/**
 * Lay out one table snapshot.
 *
 * The snapshot is the only input: the layout never reads a clock, a random
 * source or the DOM, so the same snapshot always produces byte-identical poses
 * (the renderer relies on that to skip re-uploads).
 *
 * @throws when the snapshot holds more than {@link DORA.maxIndicators} dora
 *   indicators, which no legal game can reveal: a board that cannot be drawn
 *   honestly fails here rather than silently overlapping the wall.
 */
export function layoutBoard(snapshot: TableSnapshot): BoardLayout {
  if (snapshot.dora.length > DORA.maxIndicators) {
    throw new Error(
      `3D board layout: ${snapshot.dora.length} dora indicators exceeds the ${DORA.maxIndicators} a game can reveal`,
    );
  }

  const humanSeat = snapshot.humanSeat;
  const farSeat = ((humanSeat + 2) % SEATS.count) as Seat;

  const snapshotDora = snapshot.dora;
  const dora: BoardTile[] = snapshotDora.map((tile, index) =>
    boardTile(
      tile,
      null,
      lyingPose(
        farSeat,
        wallStackW(doraStack(index)) + WALL.deadWallGapUnits,
        wallRunRadius(farSeat, humanSeat),
        wallTierHeightUnits(DORA.tier),
        // The far wall's own frame would turn the glyph away from the viewer, so
        // a revealed indicator is oriented the human's way: it is the one wall
        // tile whose face has to be read.
        seatYawDeg(humanSeat),
        0,
      ),
      tile.faceUp,
    ),
  );

  // The dead-wall tiles a dora indicator covers, keyed by stack and tier on the
  // far run: those face-down tiles are omitted so the two lists never draw twice.
  const coveredStacks = new Set(
    snapshotDora.map((_, index) => `${doraStack(index)}:${DORA.tier}`),
  );

  /*
   * Wall placement. The live tiles sit on the ring at their own run radius;
   * the fixed dead wall sits on the far run but is shifted along the run by
   * `WALL.deadWallGapUnits`, away from the live wall's far end, so the two
   * blocks are separated by a deliberate felt break. The shift is tangential,
   * so both blocks still line up radially with their run.
   */
  const wall: BoardTile[] = [];
  for (const tile of snapshot.wall) {
    const decoded = decodeWallSlot(tile.slot);
    if (!decoded) {
      throw new Error(
        `3D board layout: wall slot ${String(tile.slot)} is outside the ${WALL.runs * WALL.slotsPerRun}-slot ring`,
      );
    }
    const { run, stack, tier } = decoded;
    const dead = isDeadWallSlot(tile.slot, humanSeat);
    if (
      dead &&
      run === farSeat &&
      tier === DORA.tier &&
      coveredStacks.has(`${stack}:${tier}`)
    ) {
      continue;
    }
    const w =
      wallStackW(stack) + (dead ? WALL.deadWallGapUnits : 0);
    const height = wallTierHeightUnits(tier);
    wall.push(
      boardTile(
        tile,
        null,
        {
          position: seatPoint(
            run,
            w,
            wallRunRadius(run, humanSeat),
            height,
          ),
          yawDeg: seatYawDeg(run),
          tiltDeg: 90,
          rollDeg: 0,
          sizeUnits: TILE_SIZE,
        },
        false,
      ),
    );
  }

  const tiles: BoardTile[] = [...wall, ...dora];

  for (const seatState of snapshot.seats) {
    const seat = seatState.seat;
    const radius = handRadius(seat, humanSeat);

    // Hand, draw and melds are one line: a meld takes the row's right end and
    // slides the concealed hand left. A near/far row that faces an inset end
    // run has viewport room toward its corner, so its meld line starts a little
    // further right. The side rows are already against their vertical screen
    // edges, and a near/far row on the side radius has no inset wall behind it
    // to make room; both keep the minimum clearance.
    const horizontalRow = Math.abs(seatBasis(seat).right[0]) > 0.5;
    const hasCornerRoom = horizontalRow && radius === HAND.endSeatRadiusUnits;
    tiles.push(
      ...placeSeatRow(
        seatState,
        seat,
        radius,
        seat === humanSeat,
        hasCornerRoom ? MELD.rowShiftUnits : 0,
      ),
    );

    for (const pondRow of pondRows(seatState.river)) {
      const u = POND.rowRadiiUnits[pondRow.row];
      const centres = placeRow(pondRow.tiles);
      pondRow.tiles.forEach((tile, index) => {
        tiles.push(
          boardTile(
            tile,
            seat,
            lyingPose(
              seat,
              centres[index],
              u,
              TILE.thicknessUnits / 2,
              seatYawDeg(seat),
              tile.sideways ? -90 : 0,
            ),
            tile.faceUp,
          ),
        );
      });
    }
  }

  /*
   * One point stick per declarer (3D-09), on that seat's own side of the
   * compass and lengthwise along its edge. The 1000-point pot is deliberately
   * not drawn here: `compass.riichiSticks` is shown in the table information
   * drawer, and drawing it as a row on the felt would read as a second,
   * different count (plan 3D-09 acceptance).
   */
  const sticks: BoardStick[] = snapshot.seats
    .filter((seatState) => seatState.riichi)
    .map((seatState) => ({
      id: `stick-seat-${seatState.seat}`,
      seat: seatState.seat,
      position: seatPoint(
        seatState.seat,
        0,
        STICK.radiusUnits,
        COMPASS_PLATE.topUnits + STICK.heightUnits / 2,
      ),
      yawDeg: seatYawDeg(seatState.seat),
      sizeUnits: [
        STICK.lengthUnits,
        STICK.heightUnits,
        STICK.widthUnits,
      ] as Vec3,
    }));

  return {
    humanSeat,
    tiles,
    wall,
    foreground: tiles.filter((tile) => tile.zone !== 'wall'),
    sticks,
  };
}

/* -------------------------------------------------------------------------- */
/* Camera framing                                                             */
/* -------------------------------------------------------------------------- */

/** The horizontal and vertical half-FOV tangents for an aspect. */
function fieldOfView(aspect: number): {
  readonly tanHalfHorizontal: number;
  readonly tanHalfVertical: number;
} {
  const tanHalfHorizontal =
    CAMERA.sensorWidthMm / 2 / CAMERA.lensMm;
  return {
    tanHalfHorizontal,
    tanHalfVertical: tanHalfHorizontal / aspect,
  };
}

/**
 * The pitch the rig uses at an aspect: the committed 50° landscape preset, and
 * the steeper 62° portrait preset so the table fills the width.
 */
export function pitchForAspect(aspect: number): number {
  return aspect < CAMERA.portraitBelowAspect
    ? CAMERA.portraitPitchDeg
    : CAMERA.pitchDeg;
}

/** Build the frame for a distance, pitch and aspect; no solving. */
function frameAt(
  aspect: number,
  pitchDeg: number,
  distanceUnits: number,
  shiftNdcY: number = committedShiftNdcY(aspect),
): CameraFrame {
  const pitch = pitchDeg * DEG;
  const target: Vec3 = CAMERA.targetUnits;
  const eye: Vec3 = [
    // Shift X is zero in the committed rig; the projection handles the offset.
    target[0],
    target[1] + distanceUnits * Math.sin(pitch),
    target[2] + distanceUnits * Math.cos(pitch),
  ];
  const fov = fieldOfView(aspect);
  return {
    aspect,
    pitchDeg,
    distanceUnits,
    eye,
    target,
    tanHalfHorizontal: fov.tanHalfHorizontal,
    tanHalfVertical: fov.tanHalfVertical,
    shiftNdcY,
  };
}

/**
 * The committed rig's own projection offset.
 *
 * Blender measures Shift Y against the sensor width, and a negative Shift Y
 * moves the image up. In NDC (one frame height = 2) the offset is
 * `-2 * shiftY * aspect`; at 16:9 with the committed -0.02 that is the
 * reference's 38.4 px rise on a 1080-high frame, which the retired calibration
 * rig confirmed exactly (git history).
 */
export function committedShiftNdcY(aspect: number): number {
  return -2 * CAMERA.shiftY * aspect;
}

const CAMERA_RIGHT: Vec3 = [1, 0, 0];

/** The camera's view axes: right, up and forward (unit vectors). */
export function cameraAxes(frame: CameraFrame): {
  readonly right: Vec3;
  readonly up: Vec3;
  readonly forward: Vec3;
} {
  const pitch = frame.pitchDeg * DEG;
  const forward: Vec3 = [0, -Math.sin(pitch), -Math.cos(pitch)];
  const right = CAMERA_RIGHT;
  return {
    right,
    up: cross(right, forward),
    forward,
  };
}

/** Project a world point to NDC (-1..1 in both axes, +y up). */
export function projectPoint(
  point: Vec3,
  frame: CameraFrame,
): { readonly x: number; readonly y: number; readonly depth: number } {
  const { right, up, forward } = cameraAxes(frame);
  const relative = sub(point, frame.eye);
  const depth = dot(relative, forward);
  const x = dot(relative, right) / depth / frame.tanHalfHorizontal;
  const y = dot(relative, up) / depth / frame.tanHalfVertical + frame.shiftNdcY;
  return { x, y, depth };
}

/** Project a world point to CSS pixels in a `widthPx × heightPx` frame. */
export function projectToPixels(
  point: Vec3,
  frame: CameraFrame,
  widthPx: number,
  heightPx: number,
): { readonly x: number; readonly y: number } {
  const ndc = projectPoint(point, frame);
  return {
    x: (ndc.x * 0.5 + 0.5) * widthPx,
    y: (0.5 - ndc.y * 0.5) * heightPx,
  };
}

/**
 * The projected band of `points` in NDC: horizontal reach and vertical extent.
 *
 * The vertical fit is expressed as a half-extent around the band's centre,
 * because the solver is allowed to place the band vertically (see
 * {@link safeAreaNudge}); only its *height* constrains the distance.
 */
function projectedBand(
  points: readonly Vec3[],
  frame: CameraFrame,
): { readonly maxAbsX: number; readonly low: number; readonly high: number } {
  let maxAbsX = 0;
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    const ndc = projectPoint(point, frame);
    if (!(ndc.depth > 0)) {
      return { maxAbsX: Number.POSITIVE_INFINITY, low: -1, high: 1 };
    }
    maxAbsX = Math.max(maxAbsX, Math.abs(ndc.x));
    low = Math.min(low, ndc.y);
    high = Math.max(high, ndc.y);
  }
  return { maxAbsX, low, high };
}

/** The normalized extent of the band, where 1 is the safe-area edge. */
function normalizedExtent(
  points: readonly Vec3[],
  frame: CameraFrame,
  margin: number,
): number {
  const band = projectedBand(points, frame);
  // NDC spans 2 over the frame, so a margin expressed as a fraction of the
  // frame dimension is `2 * margin` in NDC.
  return (
    Math.max(band.maxAbsX, (band.high - band.low) / 2) / (1 - 2 * margin)
  );
}

/** The smallest eye distance that fits `points` inside the safe area. */
function solvingDistance(
  aspect: number,
  pitchDeg: number,
  points: readonly Vec3[],
  margin: number,
): number {
  let low = 5;
  let high = 400;
  for (let step = 0; step < 48; step += 1) {
    const mid = (low + high) / 2;
    const frame = frameAt(aspect, pitchDeg, mid);
    if (normalizedExtent(points, frame, margin) <= 1) high = mid;
    else low = mid;
  }
  return high;
}

/**
 * The smallest vertical nudge that puts the band inside the safe area.
 *
 * The committed Shift Y already places the table the signed-off reference's
 * way (the far rim high in the frame), so the solver only moves the projection
 * as far as the safe area actually requires — never re-centring a frame that is
 * already legal. A band taller than the safe area cannot be fixed by moving it;
 * the distance solve prevents that case.
 */
function safeAreaNudge(
  band: { readonly low: number; readonly high: number },
  margin: number,
): number {
  const limit = 1 - 2 * margin;
  if (band.low < -limit) return -limit - band.low;
  if (band.high > limit) return limit - band.high;
  return 0;
}

/**
 * The framing target: every tile the board draws.
 *
 * The mat is **not** part of the fit. The felt is a procedural square sized from
 * the solved frame, so the cloth can (and does) run off the frame edges; what
 * must be framed is the table itself. Fitting the 25-unit mat instead makes the
 * tiles small and leaves a wide empty border — the board handoff (2026-11-18)
 * asked for the board to fill the frame, with the human hand only a sliver above
 * the bottom edge. The safe area still keeps every tile corner 2 % inside the
 * frame, so the wall ring and the near hand sit that far from the edges.
 */
export function framingPoints(layout: BoardLayout): Vec3[] {
  const points: Vec3[] = [];
  for (const tile of layout.tiles) {
    points.push(...orientedBoxCorners(orientedBox(tile.pose)));
  }
  return points;
}

/**
 * The committed rig, unsolved: the reference pose for an aspect.
 *
 * This is the retired whole-table calibration rig — 75 mm, the preset
 * pitch, {@link CAMERA.distanceUnits} and the committed Shift Y — with no
 * safe-area nudge. `check-3d-layout.mjs` prints its mat-corner pixels next to
 * the reference's so the lens/pitch agreement stays visible; the shipped frame
 * is solved closer than this because it frames the board, not the mat.
 */
export function referenceFrame(aspect: number): CameraFrame {
  return frameAt(aspect, pitchForAspect(aspect), CAMERA.distanceUnits);
}

/**
 * Solve the committed lens for one aspect.
 *
 * The **lens and pitch are the reference's** (75 mm on 36 mm, 50° landscape /
 * 62° portrait); only the distance is solved, and it is the smallest distance
 * that fits every tile corner inside the safe area. There is deliberately no
 * floor at the reference's 76 units any more: that floor existed because the
 * subject was the reference's mat-plus-hand, and with the board as the subject
 * it would pin the camera back and shrink the tiles (the handoff's "too far
 * away / tiles too small"). The committed Shift Y is the reference's framing;
 * the solver only adds the smallest vertical offset the safe area needs at the
 * solved distance, which is what places the human hand a sliver above the
 * bottom edge.
 */
export function frameForAspect(
  aspect: number,
  layout?: BoardLayout,
): CameraFrame {
  if (!Number.isFinite(aspect) || aspect <= 0) {
    throw new Error(`3D board layout: invalid aspect ${String(aspect)}`);
  }
  const points = layout ? framingPoints(layout) : defaultFramingPoints();
  const pitch = pitchForAspect(aspect);
  const margin = CAMERA.safeAreaMargin;

  const distance = solvingDistance(aspect, pitch, points, margin);
  const frame = frameAt(aspect, pitch, distance);
  const band = projectedBand(points, frame);
  const nudge = safeAreaNudge(band, margin);
  return frameAt(
    aspect,
    pitch,
    distance,
    committedShiftNdcY(aspect) + nudge,
  );
}

/** The framing target without a board: the mat corners only. */
function defaultFramingPoints(): Vec3[] {
  const half = TABLE.matSizeUnits / 2;
  return [
    [-half, 0, -half],
    [half, 0, -half],
    [half, 0, half],
    [-half, 0, half],
  ];
}

/**
 * The hand's face-to-view angle at a frame, in degrees.
 *
 * The hand is reclined `HAND.reclineDeg` back from upright, so its face normal
 * sits `reclineDeg` above horizontal in the human's vertical plane; the camera's
 * view direction sits `pitchDeg` above horizontal in the same plane, pointing
 * back at the eye. The angle between them is how far the hand is from facing
 * the camera, and the readability gate is ≤
 * {@link HAND.maxFaceToViewDeg}. It is aspect-independent by construction,
 * because the layout is world space and only the frame changes: 10° at the 50°
 * landscape preset, 22° at the 62° portrait preset.
 */
export function handFaceToViewDeg(frame: CameraFrame): number {
  return Math.abs(frame.pitchDeg - HAND.reclineDeg);
}

/**
 * The exact angle between a hand tile's face normal and the ray from that tile
 * to the eye, in degrees, as an informational figure.
 *
 * A perspective camera's ray through a near-edge tile is steeper than its
 * central axis, so this number is larger than {@link handFaceToViewDeg} — at
 * the 62° portrait preset it reaches the low thirties. The gate is defined
 * against the view direction (the same "40° recline against a 50° camera"
 * reading the 2.5D rig tuned), and this function exists so the check can print
 * the strict per-tile number instead of hiding it.
 */
export function handTileToEyeDeg(tile: BoardTile, frame: CameraFrame): number {
  const normal = poseAxes(tile.pose)[2];
  const toEye = sub(frame.eye, tile.pose.position);
  const length = Math.hypot(toEye[0], toEye[1], toEye[2]);
  const unit: Vec3 = [toEye[0] / length, toEye[1] / length, toEye[2] / length];
  const cosine = Math.min(1, Math.max(-1, dot(normal, unit)));
  return Math.acos(cosine) / DEG;
}

/* -------------------------------------------------------------------------- */
/* The hand band (screen-space hand)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Where the human's hand sits when it is lifted off the table.
 *
 * The hand used to be a row of tiles on the mat's south edge, projected by the
 * table camera, which made it ~17 px wide on a phone. On a phone the hand is now
 * a row held up in front of the viewer at the bottom of the frame: still the
 * same carved 3D tiles, still lit and shadowed by the same rig, but placed in
 * **screen space** so their size is a fraction of the viewport instead of a
 * consequence of the camera's distance.
 *
 * The two fractions cannot both hold exactly for a 3:4 tile — a projected tile
 * is always at least `height/width = 28/21` tall — so the row width is the
 * target and the tile height is what a 3:4 tile gives at that width. Both are
 * reported by the layout gate.
 */
export interface HandBandSpec {
  /** The concealed hand + draw row, as a fraction of the viewport width. */
  readonly widthFraction: number;
  /** One tile's projected height, as a fraction of the viewport height. */
  readonly heightFraction: number;
  /** The row's bottom edge, as a fraction of the viewport height above the bottom. */
  readonly bottomFraction: number;
}

/** The gap between the banded hand and the meld line it sits beside, in px. */
const HUD_GAP_PX = 8;

/** The band's committed numbers (user request 2026-11-21). */
export const HAND_BAND: HandBandSpec = {
  widthFraction: 0.66,
  heightFraction: 1 / 8,
  bottomFraction: 0.02,
};

/**
 * How far a banded tile is turned away from square-on to the camera, in
 * degrees. Small enough to keep the projected height near the tile's 28/21
 * ratio, large enough that the top face still catches the key light.
 */
export const HAND_BAND_FACE_TO_VIEW_DEG = 10;

/**
 * The band for a viewport.
 *
 * The 3D view is landscape-only: on a phone held in portrait the shell is
 * rotated a quarter turn (see `useForcedLandscape`), so the stage this is called
 * with is always a landscape box. Portrait is what the 2D views are for.
 */
export function handBandSpecFor(): HandBandSpec {
  return HAND_BAND;
}

/** The human's hand + draw tiles, in hand-row order (concealed, then the draw). */
function handRowTiles(layout: BoardLayout): BoardTile[] {
  return layout.tiles
    .filter(
      (tile) =>
        tile.seat === layout.humanSeat &&
        (tile.zone === 'hand' || tile.zone === 'draw'),
    )
    .sort((left, right) =>
      left.zone === right.zone
        ? left.slot - right.slot
        : left.zone === 'hand'
          ? -1
          : 1,
    );
}

/**
 * Re-pose the human's concealed hand and draw into a screen-space band at the
 * bottom of the frame.
 *
 * Pure: it returns a new layout and never touches the camera. The tiles keep
 * their own geometry, material and orientation convention — only their world
 * position moves, to a plane `depth` in front of the eye where the row is
 * `widthFraction` of the viewport wide and its bottom edge is
 * `bottomFraction` above the frame's bottom.
 *
 * `frame` must be the frame solved for the *table* (the band tiles excluded from
 * the framing target), or the camera would reserve room for a hand that is no
 * longer on the mat.
 */
export function placeHandBand(
  layout: BoardLayout,
  frame: CameraFrame,
  viewport: { readonly widthPx: number; readonly heightPx: number },
  spec: HandBandSpec = HAND_BAND,
): BoardLayout {
  const row = handRowTiles(layout);
  if (row.length === 0) return layout;
  if (!(viewport.widthPx > 0) || !(viewport.heightPx > 0)) return layout;

  /*
   * The row is sized for a **full 14-tile hand** (`HAND.concealedCount` + the
   * draw), whatever this hand actually holds. Sizing it to the tiles in hand
   * would grow every tile when a meld takes three away, and the hand would jump
   * size on a call. A shorter hand sits centred in the same pitch.
   */
  const nominalTiles = HAND.concealedCount + 1;
  const nominalUnits =
    (nominalTiles - 1) * HAND.pitchUnits + TILE.widthUnits + HAND.drawGapUnits;
  const pxPerUnit = (spec.widthFraction * viewport.widthPx) / nominalUnits;
  /*
   * `pxPerUnit = H / (2 · depth · tanHalfVertical)` for a length perpendicular
   * to the view axis, which is what a tile width and height both are once the
   * tile is turned to face the camera.
   */
  const depth = viewport.heightPx / (2 * pxPerUnit * frame.tanHalfVertical);
  if (!(depth > CAMERA.clipStartUnits * 2)) return layout;

  const { right, up, forward } = cameraAxes(frame);
  const planeCentre = add(frame.eye, mul(forward, depth));

  /*
   * The row's tile centres along `right`, centred on the frame for now. The
   * actual row is centred, not the nominal 14-tile one: a melded hand is
   * shorter, and hanging it off the nominal row's left edge (the first version)
   * pushed a two-tile hand over the left player's melds.
   */
  const rowUnits =
    (row.length - 1) * HAND.pitchUnits +
    TILE.widthUnits +
    (row.some((tile) => tile.zone === 'draw') ? HAND.drawGapUnits : 0);
  const offsets: number[] = [];
  let cursor = -rowUnits / 2;
  for (const tile of row) {
    if (tile.zone === 'draw') cursor += HAND.drawGapUnits;
    offsets.push(cursor + TILE.widthUnits / 2);
    cursor += TILE.widthUnits;
  }

  const poseAt = (offset: number): TilePose => ({
    position: add(planeCentre, mul(right, offset)),
    yawDeg: 0,
    /*
     * The tile faces the camera, less {@link HAND_BAND_FACE_TO_VIEW_DEG} so the
     * top edge stays visible and it still reads as a body rather than a decal.
     * Turning it by the rest of the pitch would flatten its projected height
     * (and hide the top face), which is the one thing that would let a 3:4 tile
     * get closer to the 1/8 height the numbers ask for.
     */
    tiltDeg: -(frame.pitchDeg - HAND_BAND_FACE_TO_VIEW_DEG),
    rollDeg: 0,
    sizeUnits: TILE_SIZE,
  });

  /** The row's projected left and right edges, before any shift. */
  const rowEdgesPx = (): { left: number; right: number } => {
    let left = Number.POSITIVE_INFINITY;
    let rightEdge = Number.NEGATIVE_INFINITY;
    row.forEach((_, index) => {
      for (const corner of orientedBoxCorners(orientedBox(poseAt(offsets[index])))) {
        const pixel = projectToPixels(corner, frame, viewport.widthPx, viewport.heightPx);
        left = Math.min(left, pixel.x);
        rightEdge = Math.max(rightEdge, pixel.x);
      }
    });
    return { left, right: rightEdge };
  };

  /*
   * Horizontal placement: the hand sits **immediately left of the player's own
   * meld line**, which is where the table puts it (hand → draw → melds). A
   * melded hand therefore reads as one row with its melds, and it no longer
   * reaches across the frame into the left player's melds. With no melds the
   * row is centred.
   */
  const centred = rowEdgesPx();
  const meldLeftPx = (() => {
    const melds = layout.tiles.filter(
      (tile) => tile.seat === layout.humanSeat && tile.zone === 'meld',
    );
    if (melds.length === 0) return null;
    let left = Number.POSITIVE_INFINITY;
    for (const tile of melds) {
      for (const corner of orientedBoxCorners(orientedBox(tile.pose))) {
        left = Math.min(
          left,
          projectToPixels(corner, frame, viewport.widthPx, viewport.heightPx).x,
        );
      }
    }
    return Number.isFinite(left) ? left : null;
  })();
  const targetRightPx =
    meldLeftPx !== null
      ? Math.min(meldLeftPx - HUD_GAP_PX, viewport.widthPx - HUD_GAP_PX)
      : viewport.widthPx / 2 + (centred.right - centred.left) / 2;
  const shiftPx = targetRightPx - centred.right;
  const shiftUnits = shiftPx / pxPerUnit;

  /*
   * Vertical placement: project one probe tile at the plane and move the whole
   * row along `up` until its lowest corner sits `bottomFraction` above the
   * frame's bottom. The shift is exact because `up` is perpendicular to the view
   * axis, so a shift moves every corner's NDC y by the same amount.
   */
  const probe = orientedBoxCorners(orientedBox(poseAt(0)));
  let lowestPx = Number.NEGATIVE_INFINITY;
  for (const corner of probe) {
    lowestPx = Math.max(lowestPx, projectToPixels(corner, frame, viewport.widthPx, viewport.heightPx).y);
  }
  const targetPx = viewport.heightPx * (1 - spec.bottomFraction);
  const risePx = targetPx - lowestPx;
  const upUnits = (-risePx * 2 * depth * frame.tanHalfVertical) / viewport.heightPx;
  const lift = add(mul(up, upUnits), mul(right, shiftUnits));

  const newPoses = new Map<string, TilePose>();
  row.forEach((tile, index) => {
    const pose = poseAt(offsets[index]);
    newPoses.set(tile.id, { ...pose, position: add(pose.position, lift) });
  });

  const tiles = layout.tiles.map((tile) => {
    const pose = newPoses.get(tile.id);
    return pose ? { ...tile, pose } : tile;
  });
  return {
    ...layout,
    tiles,
    foreground: tiles.filter((tile) => tile.zone !== 'wall'),
  };
}

/**
 * The layout without the human's concealed hand and draw.
 *
 * Used twice: as the camera's framing target (the hand is in the band, not on
 * the mat, so the solved distance must not reserve room for it) and as the
 * shadow source (a hand held up in front of the viewer has no contact shadow on
 * the felt).
 */
export function withoutHandBandTiles(layout: BoardLayout): BoardLayout {
  const tiles = layout.tiles.filter(
    (tile) =>
      !(
        tile.seat === layout.humanSeat &&
        (tile.zone === 'hand' || tile.zone === 'draw')
      ),
  );
  return {
    ...layout,
    tiles,
    foreground: tiles.filter((tile) => tile.zone !== 'wall'),
  };
}
