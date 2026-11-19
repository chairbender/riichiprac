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
 * - The wall is decorative and full: 4 runs × 17 stacks × 2 tiers minus each
 *   run's draw-end top tile, never depleted (§9 R6). The draw end is at each
 *   seat's right (`WALL.drawEndIsSeatRight`).
 * - Dora indicators replace the far wall's top-tier tiles, counting in from the
 *   draw end, so no tile is ever drawn twice (`DORA`).
 * - Ponds fill from the far row toward the player, and the four overflow cells
 *   extend the nearest row (`POND`).
 * - Opponent hands are upright and face-down; only the human's concealed hand
 *   and draw are face-up (the snapshot's own `faceUp` flag is kept for the
 *   human and overridden for the other seats).
 *
 * Framing lives here too, because it is pure world-space math with no renderer
 * state: `frameForAspect` solves the committed rig's eye distance per aspect and
 * {@link referenceFrame} exposes the unsolved reference pose. The numbers are
 * gated by `frontend/scripts/check-3d-layout.mjs`, including the reference
 * agreement that `tools/render/reference/rig/v1-baseline.json` records.
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
  /** Body centre; sticks lie flat along +X with no rotation (`STICK`). */
  readonly position: Vec3;
  /** Full extents along X, Y and Z. */
  readonly sizeUnits: Vec3;
}

/** Everything the renderer needs to draw one table. */
export interface BoardLayout {
  /** Every tile, in a stable authoring order (not a paint order). */
  readonly tiles: readonly BoardTile[];
  /** The decorative wall only. */
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

/** Is `slot` under a dora indicator on the far run's top tier? */
function doraStack(index: number): number {
  return WALL.drawEndSlot - DORA.firstStackFromDrawEnd - index;
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

/** The human hand's reclined pose, or an opponent's upright one. */
function handPose(seat: Seat, w: number, reclined: boolean): TilePose {
  const tiltDeg = reclined ? -HAND.reclineDeg : 0;
  const phi = tiltDeg * DEG;
  const u0 = TILE.thicknessUnits / 2;
  const v0 = TILE.heightUnits / 2;
  // The tile stands on its far bottom edge at HAND.backRadiusUnits and leans
  // back about that edge; the body centre moves with the tilt.
  const du = u0 * Math.cos(phi) + v0 * Math.sin(phi);
  const dv = v0 * Math.cos(phi) - u0 * Math.sin(phi);
  return {
    position: seatPoint(seat, w, HAND.backRadiusUnits + du, dv),
    yawDeg: seatYawDeg(seat),
    tiltDeg,
    rollDeg: 0,
    sizeUnits: TILE_SIZE,
  };
}

/** Where a hand row sits: tile centres and the right edge of the row. */
function handRow(count: number): {
  readonly centres: number[];
  readonly rightEdge: number;
} {
  if (count === 0) {
    return { centres: [], rightEdge: -TILE.widthUnits / 2 };
  }
  const half = (count - 1) / 2;
  const centres = Array.from(
    { length: count },
    (_, index) => (index - half) * HAND.pitchUnits,
  );
  return {
    centres,
    rightEdge: half * HAND.pitchUnits + TILE.widthUnits / 2,
  };
}

/**
 * One pond row's tangential tile centres, in chronological order.
 *
 * The row's left edge is fixed at `-POND.columnCentreOffsetUnits - half a tile`,
 * which puts an all-upright row's first centre exactly on the reference's
 * `-columnCentreOffsetUnits` and steps every later tile by
 * `POND.columnPitchUnits`. A turned tile is wider along the row, so it is set
 * out from its neighbour's far edge by the column gap and advances the cursor by
 * its long axis (the reference's `turned` step).
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
    cursor =
      centre +
      half +
      (tile.sideways ? TILE.gapUnits : POND.columnGapUnits);
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

/** One seat's melds, laid out along the row to its right. */
function placeMelds(
  melds: TableSnapshot['seats'][number]['melds'],
  seat: Seat,
): BoardTile[] {
  const placed: BoardTile[] = [];
  let row = 0;
  /** Tangential distance from the row start to the next tile's near edge. */
  let cursor = 0;
  // Extra rows step *toward the player* (away from the wall ring), which is what
  // the committed `MELD` doc says and what keeps them clear of the wall now that
  // the hands sit at 8.35: stepping inward would put rows 2-3 inside the ring.
  const rowRadius = (index: number): number =>
    MELD.rowRadiusUnits +
    Math.min(index, MELD.rowCount - 1) * MELD.rowPitchUnits;

  for (const meld of melds) {
    const width = meld.tiles.reduce(
      (sum, tile, index) =>
        sum +
        (tile.sideways ? TILE.heightUnits : TILE.widthUnits) +
        (index === 0 ? 0 : MELD.slotGapUnits),
      0,
    );
    // Keep a whole meld on one row: wrap before its first tile rather than
    // splitting it across two rows.
    if (cursor > 0 && MELD.rowStartUnits + cursor + width > MELD.maxRowUnits) {
      row += 1;
      cursor = 0;
    }
    for (const tile of meld.tiles) {
      const half = tile.sideways
        ? TILE.heightUnits / 2
        : TILE.widthUnits / 2;
      const centre = MELD.rowStartUnits + cursor + half;
      placed.push(
        boardTile(
          tile,
          seat,
          lyingPose(
            seat,
            centre,
            rowRadius(row),
            TILE.thicknessUnits / 2,
            seatYawDeg(seat),
            tile.sideways ? -90 : 0,
          ),
          tile.faceUp,
        ),
      );
      cursor += half * 2 + MELD.slotGapUnits;
    }
  }
  return placed;
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
        (doraStack(index) - (WALL.stacksPerRun - 1) / 2) * WALL.stackPitchUnits,
        WALL.radiusUnits,
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

  // The wall tiles a dora indicator covers, keyed by stack and tier on the far
  // run: those decorative tiles are omitted so the two lists never draw twice.
  const coveredStacks = new Set(
    snapshotDora.map((_, index) => `${doraStack(index)}:${DORA.tier}`),
  );

  const wall: BoardTile[] = [];
  for (const tile of snapshot.wall) {
    if (
      !Number.isInteger(tile.slot) ||
      tile.slot < 0 ||
      tile.slot >= WALL.runs * WALL.slotsPerRun
    ) {
      throw new Error(
        `3D board layout: wall slot ${String(tile.slot)} is outside the ${WALL.runs * WALL.slotsPerRun}-slot ring`,
      );
    }
    const run = Math.floor(tile.slot / WALL.slotsPerRun);
    const withinRun = tile.slot % WALL.slotsPerRun;
    const stack = Math.floor(withinRun / WALL.tiers);
    const tier = withinRun % WALL.tiers;
    if (
      run === farSeat &&
      tier === DORA.tier &&
      coveredStacks.has(`${stack}:${tier}`)
    ) {
      continue;
    }
    const w = (stack - (WALL.stacksPerRun - 1) / 2) * WALL.stackPitchUnits;
    const height = wallTierHeightUnits(tier);
    wall.push(
      boardTile(
        tile,
        null,
        {
          position: seatPoint(run as Seat, w, WALL.radiusUnits, height),
          yawDeg: seatYawDeg(run as Seat),
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
    const isHuman = seat === humanSeat;
    const row = handRow(seatState.concealed.length);
    const handFaceUp = isHuman;

    seatState.concealed.forEach((tile, index) => {
      tiles.push(
        boardTile(
          tile,
          seat,
          handPose(seat, row.centres[index], isHuman),
          handFaceUp && tile.faceUp,
        ),
      );
    });

    if (seatState.draw) {
      const w =
        row.rightEdge + HAND.drawGapUnits + TILE.widthUnits / 2;
      tiles.push(
        boardTile(
          seatState.draw,
          seat,
          handPose(seat, w, isHuman),
          handFaceUp && seatState.draw.faceUp,
        ),
      );
    }

    tiles.push(...placeMelds(seatState.melds, seat));

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

  const sticks: BoardStick[] = Array.from(
    { length: snapshot.compass.riichiSticks },
    (_, index) => {
      const count = snapshot.compass.riichiSticks;
      return {
        id: `stick-${index}`,
        position: [
          (index - (count - 1) / 2) * STICK.pitchUnits,
          STICK.heightUnits / 2,
          STICK.radiusUnits,
        ] as Vec3,
        sizeUnits: [
          STICK.lengthUnits,
          STICK.heightUnits,
          STICK.widthUnits,
        ] as Vec3,
      };
    },
  );

  return {
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
 * reference's 38.4 px rise on a 1080-high frame, which
 * `tools/render/reference/rig/v1-baseline.json` confirms exactly.
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
 * This is `tools/render/table-reference-spec.json`'s rig — 75 mm, the preset
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
