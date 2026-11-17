/**
 * The rendered table's board: where every zone sits on screen (Phase 4).
 *
 * Phase 3's {@link LayoutZone} is a zone in its own local @1x space. This module
 * composes the zones a `GameState` needs into one board and publishes them in
 * architecture Task 4.1's strict painter order:
 *
 *   1. felt (the layer below this module; never a tile zone)
 *   2. top wall, top hand and top melds
 *   3. left and right side walls
 *   4. the four ponds around the centre compartment
 *   5. the bottom wall
 *   6. the side hands and melds
 *   7. the bottom hand and melds, drawn last
 *
 * The board is laid out around a reserved centre square, not from a shared 3D
 * camera: each zone keeps the projection Phase 1-3 approved for it. The four
 * ponds grow away from the centre; each wall sits between its pond and its
 * hand; each seat's melds sit in the corner on that player's right, between
 * the pond and the wall. The whole composition is then normalised to (0, 0)
 * and surrounded by {@link BOARD_MARGIN} px of felt.
 *
 * **Group shadows.** All four walls share one shadow group; each pond is its
 * own; each seat's hand and each seat's melds are separate (their published
 * sigmas differ: 5 standing, 12 lying). {@link BoardShadowGroup} publishes the
 * union of the hard shapes in board coordinates, already rotated by a zone's
 * whole-zone lean, so the compositor can blur each group once.
 *
 * **Walls.** The riichi wall is a full ring: 17 stacks on each of the four
 * sides, meeting at the corners from the first draw. `tiles_remaining` is the
 * live wall and does not change the physical ring.
 *
 * The module is pure geometry/data. {@link TableCompositor} draws it and
 * `RenderedTable` hosts it; neither is imported here.
 */
import { formatTileForDisplay, sortHandForDisplay } from '../display';
import { calledTile } from '../meld';
import { TABLE_SIDES, tablePlacements } from '../seatOrder';
import type { TableSide } from '../seatOrder';
import type { GameState, PlayerState } from '../types/game';
import type { ShadowShape, ShellsManifest } from './shellManifest';
import { faceIdForTile } from './tiles';
import type { TileFaceId } from './tiles';
import {
  WALL_STACKS,
  layoutHand,
  layoutMeld,
  layoutPond,
  layoutSideHand,
  layoutSideWall,
  layoutTopHand,
  layoutWall,
} from './zoneLayout';
import type { LayoutZone, PondDiscard } from './zoneLayout';

/** Felt around the outermost tile bounds, in @1x px. */
export const BOARD_MARGIN = 28;
/** Gap between adjacent zones, in @1x px. */
export const BOARD_GAP = 28;
/** Extra gap around the centre compartment so pond shadow bounds clear. */
const POND_GAP = 56;
/** The side walls sit just outside the front/back wall ends, forming a ring. */
const WALL_JOIN_GAP = 2;
/**
 * The wall run is a very long band; the published lying sigma (12) reads as a
 * hard edge at that length. The 2026-11-16 review asked for the same soft read
 * as the hand shadows, so the shared wall group blurs wider.
 */
const WALL_SHADOW_SIGMA_PX = 20;
/**
 * The side wall columns sit one wall-tile width lower than the geometric
 * centre; the review asked for the nudge so the ring's corners read level.
 */
const SIDE_WALL_Y_OFFSET = 46;
/**
 * The side hands reuse one shell down a long row, and their standing sigma (5)
 * leaves a thin hard band. The review asked for the same soft read as the
 * human hand's group, so the two side-hand groups blur wider.
 */
const SIDE_HAND_SHADOW_SIGMA_PX = 20;
/** The reserved centre compartment (compass) side, in @1x px. */
export const COMPASS_SIZE = 180;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One zone placed on the board, in Task 4.1 painter order. */
export interface BoardZone {
  /** Zone id; unique even when one seat has several melds. */
  readonly id: string;
  readonly zone: LayoutZone;
  /** Task 4.1 layer; this is what `board.zones` is sorted on. */
  readonly layer: number;
  /** Top-left of the zone's unrotated local box, in board px. */
  readonly x: number;
  readonly y: number;
  /**
   * Transparent margin a lean needs so a rotated body is not clipped by its
   * own offscreen layer. Zero for an unrotated zone.
   */
  readonly rotationPad: number;
  /** Axis-aligned bounds after the zone's lean, used for board extents. */
  readonly bounds: Rect;
}

/** A hard shadow footprint in board coordinates, after the zone's lean. */
export interface BoardShadowShape {
  readonly centreX: number;
  readonly centreY: number;
  readonly halfX: number;
  readonly halfY: number;
  readonly radiusPx: number;
  readonly angleDeg: number;
}

/** One blurred union: all four walls, one pond, or one seat's hand/melds. */
export interface BoardShadowGroup {
  readonly id: string;
  /** Bounds of the hard footprints, in board px. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Transparent tail the Gaussian needs outside `width`/`height`. */
  readonly pad: number;
  readonly sigmaPx1x: number;
  readonly coreAlpha: number;
  readonly colorHex: string;
  /** Group-local shapes: subtract `x`/`y` before drawing them. */
  readonly shapes: readonly BoardShadowShape[];
  /** Zones that contribute to this union, in painter order. */
  readonly zoneIds: readonly string[];
}

export interface Board {
  /** Full board size in @1x px, including felt margin. */
  readonly width: number;
  readonly height: number;
  /** Every body zone, in Task 4.1 painter order. */
  readonly zones: readonly BoardZone[];
  /** Every shadow group, in first-use order. */
  readonly groups: readonly BoardShadowGroup[];
  /** The reserved centre compartment, in board px. */
  readonly compass: Rect;
}

const rad = (degrees: number): number => (degrees * Math.PI) / 180;

/** Rotate a point clockwise (screen coordinates) about a pivot. */
function rotatePoint(
  x: number,
  y: number,
  pivotX: number,
  pivotY: number,
  degrees: number,
): [number, number] {
  if (degrees === 0) return [x, y];
  const angle = rad(degrees);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = x - pivotX;
  const dy = y - pivotY;
  return [pivotX + dx * cos - dy * sin, pivotY + dx * sin + dy * cos];
}

/** Axis-aligned bounds of a rotated rectangle. */
function rotatedRectBounds(
  x: number,
  y: number,
  width: number,
  height: number,
  degrees: number,
  pivotX: number,
  pivotY: number,
): Rect {
  if (degrees === 0) return { x, y, width, height };
  const corners = [
    rotatePoint(x, y, pivotX, pivotY, degrees),
    rotatePoint(x + width, y, pivotX, pivotY, degrees),
    rotatePoint(x + width, y + height, pivotX, pivotY, degrees),
    rotatePoint(x, y + height, pivotX, pivotY, degrees),
  ];
  const xs = corners.map(([px]) => px);
  const ys = corners.map(([, py]) => py);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    x: left,
    y: top,
    width: Math.max(...xs) - left,
    height: Math.max(...ys) - top,
  };
}

/**
 * The riichi wall is a full ring for the whole hand: 17 stacks on each of the
 * four sides. `tiles_remaining` is the live wall and does not change the
 * physical ring; the wall's ends meet at the four corners from the first draw.
 */
export function wallStacksFor(tilesRemaining: number): number {
  return Number.isFinite(tilesRemaining) ? WALL_STACKS : 0;
}

/** The wall's first slot; a full ring starts at slot 0. */
export function wallStartIndex(stacks: number): number {
  return Math.max(0, Math.floor((WALL_STACKS - Math.min(WALL_STACKS, stacks)) / 2));
}

/** Transparent margin a whole-zone lean needs around its local box. */
function rotationPadOf(zone: LayoutZone): number {
  if (zone.rotationDeg === 0) return 0;
  return Math.ceil(Math.abs(Math.sin(rad(zone.rotationDeg))) * Math.hypot(zone.width, zone.height)) + 2;
}

interface BodyInsets {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

/** The opaque body box inside a zone's local space (the wall body edges). */
function bodyInsets(zone: LayoutZone): BodyInsets | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const tile of zone.bodies) {
    left = Math.min(left, tile.gridX);
    top = Math.min(top, tile.gridY);
    right = Math.max(right, tile.gridX + tile.hitBox.width);
    bottom = Math.max(bottom, tile.gridY + tile.hitBox.height);
  }
  if (!Number.isFinite(left)) return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function placeZone(zone: LayoutZone, x: number, y: number): BoardZone {
  // Composite positions are whole @1x px; the zone's internal grid and hit box
  // stay fractional. A half-pixel blit would anti-alias every tile edge.
  const px = Math.round(x);
  const py = Math.round(y);
  const pivotX = px + zone.pivotX;
  const pivotY = py + zone.pivotY;
  return {
    id: zone.id,
    zone,
    layer: zone.layer,
    x: px,
    y: py,
    rotationPad: rotationPadOf(zone),
    bounds: rotatedRectBounds(px, py, zone.width, zone.height, zone.rotationDeg, pivotX, pivotY),
  };
}

/** A seat's hand faces, plus the drawn tile placed after the row gap. */
function displayHand(player: PlayerState): {
  readonly faces: readonly TileFaceId[];
  readonly draw: TileFaceId | null;
} {
  const tiles = sortHandForDisplay(player.hand, player.draw, player.red_fives);
  const drawTile = tiles.find((tile) => tile.isDraw) ?? null;
  const faces = tiles
    .filter((tile) => !tile.isDraw)
    .map((tile) => faceIdForTile(tile.code, tile.isRed));
  const draw = drawTile
    ? faceIdForTile(drawTile.code, drawTile.isRed)
    : faces.length > 13
      ? (faces.pop() ?? null)
      : null;
  return { faces, draw };
}

function pondDiscards(player: PlayerState): PondDiscard[] {
  return player.discards.map((discard, index) => ({
    face: faceIdForTile(discard.tile, discard.is_red === true),
    riichi: discard.is_riichi || player.riichi_discard_index === index,
  }));
}

/** One seat's melds, each as its own zone so a call is a separate rebuild. */
function meldZones(
  manifest: ShellsManifest,
  player: PlayerState,
  side: TableSide,
): LayoutZone[] {
  const zones: LayoutZone[] = [];
  player.melds.forEach((meld, index) => {
    const faces = meld.tiles.map((code) => faceIdForTile(code));
    const called = calledTile(meld, player.seat);
    const zone = layoutMeld(manifest, {
      faces,
      side,
      calledIndex: called ? called.index : null,
    });
    if (zone.bodies.length === 0) return;
    zones.push({ ...zone, id: `melds-${side}-${index}` });
  });
  return zones;
}

function unionBounds(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function shadowShapeBounds(shape: BoardShadowShape): Rect {
  const angle = rad(shape.angleDeg);
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  const halfX = shape.halfX * cos + shape.halfY * sin;
  const halfY = shape.halfX * sin + shape.halfY * cos;
  return {
    x: shape.centreX - halfX,
    y: shape.centreY - halfY,
    width: halfX * 2,
    height: halfY * 2,
  };
}

/** Keep a rectangle angle in (-90, 90]; a half-turn is the same rectangle. */
function normalizeShadowAngle(degrees: number): number {
  let angle = ((degrees % 180) + 180) % 180;
  if (angle > 90) angle -= 180;
  return angle;
}

/**
 * The hard shape's angle in board space. A side wall and a side hand reuse one
 * shell down a full row, so their published base-strip angle is the *tile's*
 * angle, not the row's. The row direction turns the footprint: the side wall
 * runs down an oblique column, so its long axis is the column normal; the side
 * hand is a flush vertical row, so its footprint is axis-aligned. Without this
 * the repeated axis-aligned rectangles make a staircase instead of one long
 * blur band. The rotated pond lean is added on top.
 */
function shadowAngleFor(zone: LayoutZone, shape: ShadowShape): number {
  if (
    (zone.kind === 'wall' || zone.kind === 'hand') &&
    (zone.side === 'left' || zone.side === 'right')
  ) {
    const [first, second] = zone.shadows;
    if (first && second) {
      const dx = second.gridX - first.gridX;
      const dy = second.gridY - first.gridY;
      if (dx !== 0 || dy !== 0) {
        return normalizeShadowAngle(
          (Math.atan2(dy, dx) * 180) / Math.PI + 90 + zone.rotationDeg,
        );
      }
    }
  }
  return shape.angleDeg + zone.rotationDeg;
}

/**
 * The shadow groups for the board, in the order their first zone appears.
 * A group's shapes have the zone's lean baked into their centre and angle, so
 * the compositor never needs to know which zone a shape came from.
 */
function buildShadowGroups(
  manifest: ShellsManifest,
  zones: readonly BoardZone[],
): BoardShadowGroup[] {
  const groups: BoardShadowGroup[] = [];
  const seen = new Set<string>();

  for (const placement of zones) {
    const groupId = placement.zone.shadowGroup;
    if (seen.has(groupId)) continue;
    seen.add(groupId);

    const members = zones.filter((entry) => entry.zone.shadowGroup === groupId);
    const shapes: BoardShadowShape[] = [];
    let sigmaPx1x = 0;
    let coreAlpha = 0;
    let colorHex = '#0b1418';

    for (const member of members) {
      const { zone } = member;
      const pivotX = member.x + zone.pivotX;
      const pivotY = member.y + zone.pivotY;
      for (const tile of zone.shadows) {
        const shell = manifest.shells[tile.shell];
        if (!shell) continue;
        const shape: ShadowShape = shell.shadowShape;
        const [centreX, centreY] = rotatePoint(
          member.x + tile.gridX + shape.centrePx[0],
          member.y + tile.gridY + shape.centrePx[1],
          pivotX,
          pivotY,
          zone.rotationDeg,
        );
        shapes.push({
          centreX,
          centreY,
          halfX: shape.halfPx[0],
          halfY: shape.halfPx[1],
          radiusPx: shape.radiusPx,
          angleDeg: shadowAngleFor(zone, shape),
        });
        sigmaPx1x = shape.sigmaPx1x;
        coreAlpha = shape.coreAlpha;
        colorHex = shape.colorHex;
      }
    }

    if (shapes.length === 0) continue;
    const bounds = unionBounds(shapes.map(shadowShapeBounds));
    if (!bounds) continue;
    const sigma =
      groupId === 'walls'
        ? Math.max(sigmaPx1x, WALL_SHADOW_SIGMA_PX)
        : groupId === 'seat-left-hand' || groupId === 'seat-right-hand'
          ? Math.max(sigmaPx1x, SIDE_HAND_SHADOW_SIGMA_PX)
          : sigmaPx1x;
    const originX = Math.floor(bounds.x);
    const originY = Math.floor(bounds.y);
    const width = Math.max(1, Math.ceil(bounds.x + bounds.width) - originX);
    const height = Math.max(1, Math.ceil(bounds.y + bounds.height) - originY);
    groups.push({
      id: groupId,
      x: originX,
      y: originY,
      width,
      height,
      pad: Math.ceil(3 * sigma) + 2,
      sigmaPx1x: sigma,
      coreAlpha,
      colorHex,
      shapes: shapes.map((shape) => ({
        ...shape,
        centreX: shape.centreX - originX,
        centreY: shape.centreY - originY,
      })),
      zoneIds: members.map((member) => member.id),
    });
  }

  return groups;
}

interface Shift {
  readonly x: number;
  readonly y: number;
}

function shiftRect(rect: Rect, shift: Shift): Rect {
  return {
    x: rect.x - shift.x,
    y: rect.y - shift.y,
    width: rect.width,
    height: rect.height,
  };
}

/** Normalise to (0, 0) plus the felt margin and publish integer extents. */
function normalize(
  zones: readonly BoardZone[],
  groups: readonly BoardShadowGroup[],
  compass: Rect,
): Board {
  const rects: Rect[] = [
    ...zones.map((zone) => zone.bounds),
    ...groups.map((group) => ({
      x: group.x - group.pad,
      y: group.y - group.pad,
      width: group.width + group.pad * 2,
      height: group.height + group.pad * 2,
    })),
    compass,
  ];
  const union = unionBounds(rects) ?? { x: 0, y: 0, width: 0, height: 0 };
  const left = Math.floor(union.x) - BOARD_MARGIN;
  const top = Math.floor(union.y) - BOARD_MARGIN;
  const right = Math.ceil(union.x + union.width) + BOARD_MARGIN;
  const bottom = Math.ceil(union.y + union.height) + BOARD_MARGIN;
  const shift: Shift = { x: left, y: top };
  return {
    width: right - left,
    height: bottom - top,
    zones: zones.map((zone) => ({
      ...zone,
      x: zone.x - shift.x,
      y: zone.y - shift.y,
      bounds: shiftRect(zone.bounds, shift),
    })),
    groups: groups.map((group) => ({
      ...group,
      x: group.x - shift.x,
      y: group.y - shift.y,
    })),
    compass: shiftRect(compass, shift),
  };
}

/**
 * Compose the board for a game state.
 *
 * The human is anchored at the bottom, as in the top-down view. Positions are
 * relative to a centre point until the final normalisation; a missing pond or
 * wall falls back to the centre or the pond so the remaining zones still line
 * up.
 */
export function buildBoard(manifest: ShellsManifest, state: GameState): Board {
  const placements = tablePlacements(state.players);
  const bySide = new Map<TableSide, PlayerState>();
  for (const placement of placements) bySide.set(placement.side, placement.player);

  const stacks = wallStacksFor(state.tiles_remaining);
  const startIndex = wallStartIndex(stacks);
  const half = COMPASS_SIZE / 2;

  // Ponds first: every later ring is anchored to the pond in front of it.
  const pondZones = new Map<TableSide, LayoutZone>();
  for (const side of TABLE_SIDES) {
    const player = bySide.get(side);
    if (!player) continue;
    const discards = pondDiscards(player);
    if (discards.length === 0) continue;
    pondZones.set(side, layoutPond(manifest, { discards, side }));
  }

  const ponds = new Map<TableSide, BoardZone>();
  for (const side of TABLE_SIDES) {
    const zone = pondZones.get(side);
    if (!zone) continue;
    let x = -zone.width / 2;
    let y = -zone.height / 2;
    if (side === 'bottom') y = half + POND_GAP;
    if (side === 'top') y = -half - POND_GAP - zone.height;
    if (side === 'left') x = -half - POND_GAP - zone.width;
    if (side === 'right') x = half + POND_GAP;
    ponds.set(side, placeZone(zone, x, y));
  }

  const rightOf = (zone: BoardZone | undefined, fallback: number): number =>
    zone ? zone.x + zone.zone.width : fallback;
  const bottomOf = (zone: BoardZone | undefined, fallback: number): number =>
    zone ? zone.y + zone.zone.height : fallback;

  // Walls: all four share one shadow group and form a ring. The front/back
  // walls are centred over their ponds; the side walls sit just outside their
  // x ends, so the four runs meet at the corners instead of clipping through.
  const walls = new Map<TableSide, BoardZone>();
  if (stacks > 0) {
    const back = layoutWall(manifest, { wall: 'back', count: stacks, startIndex });
    const topPond = ponds.get('top');
    const topAnchor = topPond ? topPond.y : -half - BOARD_GAP;
    const backPlacement = placeZone(
      back,
      -back.width / 2,
      topAnchor - BOARD_GAP - back.height,
    );
    const front = layoutWall(manifest, { wall: 'front', count: stacks, startIndex });
    const bottomPond = ponds.get('bottom');
    const bottomAnchor = bottomPond ? bottomPond.y + bottomPond.zone.height : half + BOARD_GAP;
    const frontPlacement = placeZone(
      front,
      -front.width / 2,
      bottomAnchor + BOARD_GAP,
    );
    walls.set('top', backPlacement);
    walls.set('bottom', frontPlacement);

    const backInsets = bodyInsets(back);
    const frontInsets = bodyInsets(front);
    if (!backInsets || !frontInsets) {
      // A bodyless wall cannot happen with a real manifest; leave the ring out.
      walls.set('top', backPlacement);
      walls.set('bottom', frontPlacement);
    } else {
      walls.set('top', backPlacement);
      walls.set('bottom', frontPlacement);
      const ringBodyLeft = Math.min(
        backPlacement.x + backInsets.left,
        frontPlacement.x + frontInsets.left,
      );
      const ringBodyRight = Math.max(
        backPlacement.x + backInsets.right,
        frontPlacement.x + frontInsets.right,
      );
      const left = layoutSideWall(manifest, {
        side: 'left',
        count: stacks,
        startIndex,
      });
      const right = layoutSideWall(manifest, {
        side: 'right',
        count: stacks,
        startIndex,
      });
      const leftInsets = bodyInsets(left);
      const rightInsets = bodyInsets(right);
      if (leftInsets && rightInsets) {
        walls.set(
          'left',
          placeZone(
            left,
            ringBodyLeft - WALL_JOIN_GAP - leftInsets.width - leftInsets.left,
            -left.height / 2 + SIDE_WALL_Y_OFFSET,
          ),
        );
        walls.set(
          'right',
          placeZone(
            right,
            ringBodyRight + WALL_JOIN_GAP - rightInsets.left,
            -right.height / 2 + SIDE_WALL_Y_OFFSET,
          ),
        );
      }
    }
  }

  // Hands outside the wall ring; the drawn tile is part of the human's zone.
  const handZones = new Map<TableSide, LayoutZone>();
  for (const side of TABLE_SIDES) {
    const player = bySide.get(side);
    if (!player) continue;
    const count = Math.min(13, player.hand.length);
    if (side === 'bottom') {
      const { faces, draw } = displayHand(player);
      if (faces.length === 0 && !draw) continue;
      handZones.set(side, layoutHand(manifest, { faces, draw }));
    } else if (side === 'top') {
      if (count === 0) continue;
      handZones.set(
        side,
        layoutTopHand(manifest, { faces: Array.from({ length: count }, () => 'blank' as TileFaceId) }),
      );
    } else {
      if (count === 0) continue;
      handZones.set(side, layoutSideHand(manifest, { side, count }));
    }
  }

  const hands = new Map<TableSide, BoardZone>();
  for (const side of TABLE_SIDES) {
    const zone = handZones.get(side);
    if (!zone) continue;
    const wall = walls.get(side);
    const pond = ponds.get(side);
    if (side === 'bottom') {
      const anchor = wall ? wall.y + wall.zone.height : pond ? pond.y + pond.zone.height : half;
      hands.set(side, placeZone(zone, -zone.width / 2, anchor + BOARD_GAP));
    } else if (side === 'top') {
      const anchor = wall ? wall.y : pond ? pond.y : -half;
      hands.set(side, placeZone(zone, -zone.width / 2, anchor - BOARD_GAP - zone.height));
    } else if (side === 'left') {
      const anchor = wall ? wall.x : pond ? pond.x : -half;
      hands.set(side, placeZone(zone, anchor - BOARD_GAP - zone.width, -zone.height / 2));
    } else {
      const anchor = wall ? wall.x + wall.zone.width : pond ? pond.x + pond.zone.width : half;
      hands.set(side, placeZone(zone, anchor + BOARD_GAP, -zone.height / 2));
    }
  }

  // Melds sit beside the seat's hand, on that player's right and stacking
  // further that way, exactly like the top-down plan. They are outside the wall
  // ring: the compact ring has no inside lane wide enough for a lying meld, and
  // a real player lays calls by their own hand.
  const melds = new Map<TableSide, BoardZone[]>();
  for (const side of TABLE_SIDES) {
    const player = bySide.get(side);
    if (!player) continue;
    const zones = meldZones(manifest, player, side);
    if (zones.length === 0) continue;
    const placed: BoardZone[] = [];
    const pond = ponds.get(side);
    const wall = walls.get(side);
    const hand = hands.get(side);
    zones.forEach((zone, index) => {
      if (side === 'bottom') {
        const x = hand
          ? hand.x + hand.zone.width + BOARD_GAP + index * (zone.width + BOARD_GAP)
          : rightOf(pond, half + BOARD_GAP) + BOARD_GAP;
        const y = hand ? hand.y + hand.zone.height - zone.height : bottomOf(pond, half);
        placed.push(placeZone(zone, x, y));
      } else if (side === 'top') {
        const x = hand
          ? hand.x - BOARD_GAP - zone.width - index * (zone.width + BOARD_GAP)
          : (pond ? pond.x : -half) - BOARD_GAP - zone.width;
        const y = hand ? hand.y : pond ? pond.y : -half;
        placed.push(placeZone(zone, x, y));
      } else if (side === 'left') {
        const x = hand
          ? hand.x - BOARD_GAP - zone.width - index * (zone.width + BOARD_GAP)
          : (pond ? pond.x : -half) - BOARD_GAP - zone.width;
        const y = hand
          ? hand.y + (hand.zone.height - zone.height) / 2
          : -zone.height / 2;
        placed.push(placeZone(zone, x, y));
      } else {
        const x = hand
          ? hand.x + hand.zone.width + BOARD_GAP + index * (zone.width + BOARD_GAP)
          : (wall ? wall.x + wall.zone.width : pond ? pond.x + pond.zone.width : half) +
            BOARD_GAP;
        const y = hand
          ? hand.y + (hand.zone.height - zone.height) / 2
          : -zone.height / 2;
        placed.push(placeZone(zone, x, y));
      }
    });
    melds.set(side, placed);
  }

  // Task 4.1/4.2 global painter order. Within one layer the sub-order is fixed
  // and explicit, so a future zone can never silently move in front of a seat.
  const zones: BoardZone[] = [];
  const push = (zone: BoardZone | undefined) => {
    if (zone) zones.push(zone);
  };
  const pushAll = (list: readonly BoardZone[] | undefined) => {
    if (list) zones.push(...list);
  };

  push(walls.get('top'));
  pushAll(melds.get('top'));
  push(hands.get('top'));
  push(walls.get('left'));
  push(walls.get('right'));
  push(ponds.get('bottom'));
  push(ponds.get('right'));
  push(ponds.get('top'));
  push(ponds.get('left'));
  push(walls.get('bottom'));
  pushAll(melds.get('left'));
  push(hands.get('left'));
  pushAll(melds.get('right'));
  push(hands.get('right'));
  pushAll(melds.get('bottom'));
  push(hands.get('bottom'));

  const groups = buildShadowGroups(manifest, zones);
  const compass: Rect = {
    x: -half,
    y: -half,
    width: COMPASS_SIZE,
    height: COMPASS_SIZE,
  };
  return normalize(zones, groups, compass);
}

/** Display label for a placed face, used by the accessible hit layer. */
export function faceLabel(face: TileFaceId | null): string {
  if (!face) return 'face-down tile';
  if (face === 'blank') return 'blank tile';
  if (face.endsWith('r')) {
    return formatTileForDisplay(face.slice(0, 2), true);
  }
  return formatTileForDisplay(face);
}
