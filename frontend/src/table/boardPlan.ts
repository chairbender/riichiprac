/**
 * The 2.5D rendered board's plan: a `GameState` turned into placed zones.
 *
 * This is the screen-space placement layer the architecture reserves for Phase
 * 4 (§13 "Phase 4 owns the compositor and the screen-space placement of the
 * zones"). It draws nothing and reads no assets: it asks `zoneLayout.ts` for
 * each zone in the zone's own local space, then puts those zones round the
 * table in one board coordinate space and returns them in painter order.
 *
 * Geometry, in @1x board px:
 *
 *                top hand
 *        ┌───────────────────────┐  back wall
 *        │   top pond            │
 *  left  │ ┌────┐        ┌────┐  │  right
 *  hand  │ │left│ compass│right│ │  hand
 *        │ └────┘        └────┘  │
 *        │   bottom pond         │
 *        └───────────────────────┘  front wall
 *                bottom hand
 *
 * **The wall ring is one closed square.** The front/back wall runs and the
 * side-wall columns are placed on the same outer square: the horizontal walls'
 * inner edges land exactly on the side columns' ends, and the side columns'
 * outer edges land exactly on the horizontal walls' outer edges, so every
 * corner is an L-shaped overlap (the side walls draw over the back wall's ends
 * and under the front wall's, per Task 4.1).
 *
 * **The four ponds share one square well.** Their long sides are scaled (each
 * pond uniformly, so its tiles keep their aspect) until bottom/top and
 * left/right have the same length = the well's side, so the first row of every
 * river forms a square with touching corners. The pond zones are the only
 * scaled zones; the walls, hands and melds stay at @1x.
 *
 * Every distance is derived from the measured zones, so a longer hand or an
 * extra meld moves its neighbours rather than overlapping them.
 *
 * Coordinates stay fractional and unrounded: the compositor scales the whole
 * board into the square felt, so rounding here would bake in a scale.
 */
import { sortHandForDisplay } from '../display';
import { calledTile } from '../meld';
import { tablePlacements } from '../seatOrder';
import type { SeatPlacement, TableSide } from '../seatOrder';
import type { CalledMeld, GameState, PlayerState } from '../types/game';
import type { ShellsManifest } from './shellManifest';
import { faceIdForTile } from './tiles';
import type { TileFaceId } from './tiles';
import {
  layoutHand,
  layoutMeld,
  layoutPond,
  layoutSideHand,
  layoutSideWall,
  layoutTopHand,
  layoutWall,
} from './zoneLayout';
import type { LayoutZone, PondDiscard } from './zoneLayout';

/** The gaps the board composition uses, in @1x px. */
export const RENDERED_BOARD_SPACING = {
  /** Breathing room between the pond block and the wall ring's inner edges. */
  pondWallGapPx: 10,
  /** Wall's outer edge to its seat's hand (or side hand) edge. */
  wallHandGapPx: 22,
  /** Hand edge to the first meld of that seat. */
  meldGapPx: 14,
  /** Gap between two of one seat's melds. */
  meldStepGapPx: 10,
} as const;

/** One zone placed on the board, in painter order. */
export interface BoardZone {
  readonly zone: LayoutZone;
  /** Board-space position of the zone's local origin (0, 0). */
  readonly x: number;
  readonly y: number;
  /** Uniform scale of the zone's local space; 1 for everything but ponds. */
  readonly scale: number;
}

export interface BoardPlan {
  /** Every zone in painter order (Task 4.1 layers, far to near within one). */
  readonly zones: readonly BoardZone[];
  /** Board bounds in @1x px, normalised so every zone starts at or after 0. */
  readonly width: number;
  readonly height: number;
  /** Extra margin each zone's blurred shadow needs around its own bounds. */
  readonly blurPadPx: number;
  /**
   * The compass well's half-width: the ponds' inner edges sit this far from
   * the centre. It is derived from the pond sizes, never smaller than the
   * published minimum.
   */
  readonly centreGapPx: number;
  /** The table centre in board coordinates (the compass sits here). */
  readonly centreX: number;
  readonly centreY: number;
}

export interface Bounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Screen axes of a seat: the player's right and toward-the-player. */
const SEAT_RIGHT: Record<TableSide, readonly [number, number]> = {
  bottom: [1, 0],
  right: [0, -1],
  top: [-1, 0],
  left: [0, 1],
};

const MAX_HAND_ROW = 13;

/** The face of every tile in a player's concealed row, plus the drawn tile. */
export function handFaces(
  player: PlayerState,
): { readonly faces: TileFaceId[]; readonly draw: TileFaceId | null } {
  const display = sortHandForDisplay(player.hand, player.draw, player.red_fives);
  const row = display.filter((tile) => !tile.isDraw);
  const drawn = display.find((tile) => tile.isDraw) ?? null;
  const faces = row
    .slice(0, MAX_HAND_ROW)
    .map((tile) => faceIdForTile(tile.code, tile.isRed));
  // A concealed kan can leave 14 tiles in the row; the layout has one drawn
  // slot, so the overflow becomes the drawn tile rather than being dropped.
  const overflow = row.slice(MAX_HAND_ROW);
  const draw = drawn
    ? faceIdForTile(drawn.code, drawn.isRed)
    : overflow.length > 0
      ? faceIdForTile(overflow[overflow.length - 1].code, false)
      : null;
  return { faces, draw };
}

/** The board faces of a meld, and the called tile's sideways index. */
export function meldFaces(
  meld: CalledMeld,
  seat: number,
): { readonly faces: TileFaceId[]; readonly calledIndex: number | null } {
  return {
    faces: meld.tiles.map((code) => faceIdForTile(code, false)),
    calledIndex: calledTile(meld, seat)?.index ?? null,
  };
}

/** The pond discards for one player; a Riichi declaration tile lies sideways. */
function pondDiscards(player: PlayerState): PondDiscard[] {
  return player.discards.map((discard) => ({
    face: faceIdForTile(discard.tile, discard.is_red === true),
    riichi: discard.is_riichi,
  }));
}

/** The full pond capacity: three rows of six, the reference ring size. */
const REFERENCE_DISCARDS = 18;

const REFERENCE_FACES: readonly TileFaceId[] = [
  '1m', '2m', '3m', '4m', '5m', '6m',
  '7m', '8m', '9m', '1p', '2p', '3p',
  '4p', '5p', '6p', '7p', '8p', '9p',
];

/** A full 6 x 3 pond's size on each seat, used only for the ring geometry. */
function referencePondSizes(
  manifest: ShellsManifest,
): Record<TableSide, { readonly width: number; readonly height: number }> {
  const discards = REFERENCE_FACES.slice(0, REFERENCE_DISCARDS).map(
    (face, index) => ({
      face,
      // A turned Riichi tile is the widest row case, so the reference ring
      // reserves room for it.
      riichi: index === 5,
    }),
  );
  const size = (side: TableSide) => {
    const zone = layoutPond(manifest, { discards, side });
    return { width: zone.width, height: zone.height };
  };
  return {
    bottom: size('bottom'),
    right: size('right'),
    top: size('top'),
    left: size('left'),
  };
}

/** A seat's zones before placement. */
interface SeatZones {
  readonly placement: SeatPlacement;
  readonly side: TableSide;
  readonly hand: LayoutZone | null;
  readonly melds: LayoutZone[];
  readonly pond: LayoutZone | null;
}

/**
 * One seat's hand zone, sized to its real concealed count. The human's row is
 * face-up (14 shells, the drawn tile in its own slot); the other three seats
 * are blue backs, so their faces are placeholders of the right length.
 */
function buildHandZone(
  manifest: ShellsManifest,
  placement: SeatPlacement,
): LayoutZone | null {
  const { player, side } = placement;
  const count = Math.min(
    MAX_HAND_ROW,
    player.hand.length + (player.draw ? 1 : 0),
  );
  if (count <= 0) return null;

  if (side === 'bottom') {
    const { faces, draw } = handFaces(player);
    return layoutHand(manifest, { faces, draw });
  }
  if (side === 'top') {
    // `layoutTopHand` uses the face list only for its length: the far hand is
    // bare blue backs, so every entry is the assetless blank.
    return layoutTopHand(manifest, {
      faces: Array.from({ length: count }, () => 'blank' as TileFaceId),
    });
  }
  return layoutSideHand(manifest, { side, count });
}

/** One zone per open meld, each unique by id. */
function buildMeldZones(
  manifest: ShellsManifest,
  placement: SeatPlacement,
): LayoutZone[] {
  return placement.player.melds
    .map((meld, index) => {
      const { faces, calledIndex } = meldFaces(meld, placement.player.seat);
      if (faces.length === 0) return null;
      const zone = layoutMeld(manifest, {
        faces,
        side: placement.side,
        calledIndex,
      });
      return { ...zone, id: `${zone.id}-${index}` };
    })
    .filter((zone): zone is LayoutZone => zone !== null);
}

/** The whole board for one game state. */
export function buildBoardPlan(
  state: GameState,
  manifest: ShellsManifest,
): BoardPlan {
  const placements = tablePlacements(state.players);
  const bySide = new Map<TableSide, SeatPlacement>();
  for (const placement of placements) {
    // A malformed state can put two players on one edge; the board has one zone
    // per edge, so the first player keeps it (the stacked and top-down views
    // still show both).
    if (!bySide.has(placement.side)) bySide.set(placement.side, placement);
  }
  // The human always anchors the board at the bottom edge.
  const seats: SeatZones[] = [];
  for (const side of ['bottom', 'right', 'top', 'left'] as const) {
    const placement = bySide.get(side);
    if (!placement) continue;
    const discards = pondDiscards(placement.player);
    seats.push({
      placement,
      side,
      hand: buildHandZone(manifest, placement),
      melds: buildMeldZones(manifest, placement),
      pond:
        discards.length === 0
          ? null
          : layoutPond(manifest, { discards, side }),
    });
  }
  const seatOf = (side: TableSide): SeatZones | null =>
    seats.find((seat) => seat.side === side) ?? null;

  const bottom = seatOf('bottom');
  const right = seatOf('right');
  const top = seatOf('top');
  const left = seatOf('left');

  const backWall = layoutWall(manifest, { wall: 'back' });
  const frontWall = layoutWall(manifest, { wall: 'front' });
  const leftWall = layoutSideWall(manifest, { side: 'left' });
  const rightWall = layoutSideWall(manifest, { side: 'right' });

  const placed: Array<{
    zone: LayoutZone;
    x: number;
    y: number;
    scale: number;
  }> = [];
  const put = (
    zone: LayoutZone | null,
    x: number,
    y: number,
    scale = 1,
  ) => {
    if (zone) placed.push({ zone, x, y, scale });
  };

  const { pondWallGapPx, wallHandGapPx, meldGapPx, meldStepGapPx } =
    RENDERED_BOARD_SPACING;

  const reference = referencePondSizes(manifest);
  const bottomLong = Math.max(reference.bottom.width, reference.top.width);
  const sideLong = Math.max(reference.left.height, reference.right.height);
  const sideDepth = Math.max(reference.left.width, reference.right.width);
  const bottomDepth = Math.max(reference.bottom.height, reference.top.height);

  /*
   * The wall ring is one square. The side walls span the ring's inner opening
   * vertically; the front/back walls span the full outer square horizontally,
   * so their inner edges land exactly on the side columns' ends. Only the
   * horizontal walls are scaled, by a fraction of a percent, to match the ring's
   * side; the side columns are already exactly the inner opening's height.
   */
  const sideWallHalf = Math.max(leftWall.height, rightWall.height) / 2;
  const horizontalDepth = Math.max(frontWall.height, backWall.height);
  const ringHalf = sideWallHalf + horizontalDepth;
  const frontWallScale = (ringHalf * 2) / frontWall.width;
  const backWallScale = (ringHalf * 2) / backWall.width;
  const leftWallScale = (sideWallHalf * 2) / leftWall.height;
  const rightWallScale = (sideWallHalf * 2) / rightWall.height;

  // The ring's inner opening, which the ponds must fill.
  const openingHalfX =
    ringHalf -
    Math.max(
      leftWall.width * leftWallScale,
      rightWall.width * rightWallScale,
    );
  const openingHalfY =
    ringHalf -
    Math.max(
      frontWall.height * frontWallScale,
      backWall.height * backWallScale,
    );

  /*
   * The four rivers share one square well. Their long sides are scaled (each
   * pond uniformly, so its tiles keep their aspect) until bottom/top and
   * left/right have the same length: the well's side. The well is as large as
   * the ring's inner width allows, because the side ponds' row depth is what
   * limits the block's width.
   */
  const sideDepthPerLong = (2 * sideDepth) / sideLong;
  const bottomDepthPerLong = (2 * bottomDepth) / bottomLong;
  const wellHalf = Math.max(
    0,
    Math.min(
      (openingHalfX - pondWallGapPx) / (1 + sideDepthPerLong),
      (openingHalfY - pondWallGapPx) / (1 + bottomDepthPerLong),
    ),
  );
  const bottomPondScale = bottomLong > 0 ? (wellHalf * 2) / bottomLong : 1;
  const sidePondScale = sideLong > 0 ? (wellHalf * 2) / sideLong : 1;
  const centreGapPx = wellHalf;

  // Ponds: their inner edge is the well; each grows toward its own player.
  const bottomPond = bottom?.pond ?? null;
  const topPond = top?.pond ?? null;
  const leftPond = left?.pond ?? null;
  const rightPond = right?.pond ?? null;

  /*
   * Walls: the back wall's outer edge is the ring's top, the front wall's
   * bottom edge is the ring's bottom, and the side columns sit on the ring's
   * left/right outer edges, centred vertically. Their ends meet the horizontal
   * walls' inner edges exactly, so every corner is closed.
   */
  const backWallY = -ringHalf;
  const frontWallY = ringHalf - frontWall.height * frontWallScale;
  const leftWallX = -ringHalf;
  const rightWallX = ringHalf - rightWall.width * rightWallScale;
  const leftWallY = -(leftWall.height * leftWallScale) / 2;
  const rightWallY = -(rightWall.height * rightWallScale) / 2;

  // The hands sit outside the ring's outer edges.
  const bottomHand = bottom?.hand ?? null;
  const bottomHandX = bottomHand ? -bottomHand.width / 2 : 0;
  const bottomHandY = ringHalf + wallHandGapPx;

  const topHand = top?.hand ?? null;
  const topHandX = topHand ? -topHand.width / 2 : 0;
  const topHandY = -ringHalf - wallHandGapPx - (topHand?.height ?? 0);

  const leftHand = left?.hand ?? null;
  const rightHand = right?.hand ?? null;
  const leftHandX = leftHand
    ? -ringHalf - wallHandGapPx - leftHand.width
    : -ringHalf - wallHandGapPx;
  const leftHandY = leftHand ? -leftHand.height / 2 : 0;
  const rightHandX = ringHalf + wallHandGapPx;
  const rightHandY = rightHand ? -rightHand.height / 2 : 0;

  // Painter order (Task 4.1). Insertion order + the zones' own `layer` field is
  // the contract: the stable sort below only groups them.
  put(backWall, -backWall.width / 2, backWallY, backWallScale);
  put(topHand, topHandX, topHandY);
  placeMelds(put, top?.melds ?? [], 'top', topHandX, topHandY, {
    hand: topHand,
    meldGapPx,
    meldStepGapPx,
  });
  put(leftWall, leftWallX, leftWallY, leftWallScale);
  put(rightWall, rightWallX, rightWallY, rightWallScale);
  put(
    bottomPond,
    bottomPond ? -(bottomPond.width * bottomPondScale) / 2 : 0,
    centreGapPx,
    bottomPondScale,
  );
  put(
    rightPond,
    centreGapPx,
    rightPond ? -(rightPond.height * sidePondScale) / 2 : 0,
    sidePondScale,
  );
  put(
    topPond,
    topPond ? -(topPond.width * bottomPondScale) / 2 : 0,
    -centreGapPx - (topPond?.height ?? 0) * bottomPondScale,
    bottomPondScale,
  );
  put(
    leftPond,
    leftPond ? -centreGapPx - leftPond.width * sidePondScale : -centreGapPx,
    leftPond ? -(leftPond.height * sidePondScale) / 2 : 0,
    sidePondScale,
  );
  put(frontWall, -frontWall.width / 2, frontWallY, frontWallScale);
  put(leftHand, leftHandX, leftHandY);
  placeMelds(put, left?.melds ?? [], 'left', leftHandX, leftHandY, {
    hand: leftHand,
    meldGapPx,
    meldStepGapPx,
  });
  put(rightHand, rightHandX, rightHandY);
  placeMelds(put, right?.melds ?? [], 'right', rightHandX, rightHandY, {
    hand: rightHand,
    meldGapPx,
    meldStepGapPx,
  });
  placeMelds(put, bottom?.melds ?? [], 'bottom', bottomHandX, bottomHandY, {
    hand: bottomHand,
    meldGapPx,
    meldStepGapPx,
  });
  put(bottomHand, bottomHandX, bottomHandY);

  // Group by Task 4.1 layer; keep the insertion order inside one layer.
  const ordered = placed
    .map((entry, index) => ({ entry, index }))
    .sort(
      (first, second) =>
        first.entry.zone.layer - second.entry.zone.layer ||
        first.index - second.index,
    )
    .map(({ entry }) => entry);

  return normalizePlan(ordered, centreGapPx);
}

/** Kept for the top-seat meld offset below; see `placeMelds`. */
interface MeldPlacement {
  readonly hand: LayoutZone | null;
  readonly meldGapPx: number;
  readonly meldStepGapPx: number;
}

/**
 * Stack a seat's melds along that player's right (the same edge the top-down
 * view puts melds on), starting just past the hand's right end. A meld that
 * would run further along the row simply extends it; nothing overlaps the hand.
 */
function placeMelds(
  put: (zone: LayoutZone | null, x: number, y: number) => void,
  melds: readonly LayoutZone[],
  side: TableSide,
  handX: number,
  handY: number,
  placement: MeldPlacement,
): void {
  const { hand, meldGapPx, meldStepGapPx } = placement;
  if (melds.length === 0) return;
  const handWidth = hand?.width ?? 0;
  const handHeight = hand?.height ?? 0;
  const right = SEAT_RIGHT[side];
  let cursor = 0;
  for (const meld of melds) {
    if (right[0] === 1) {
      // Player's right is screen right (the human).
      put(meld, handX + handWidth + meldGapPx + cursor, handY + handHeight - meld.height);
      cursor += meld.width + meldStepGapPx;
    } else if (right[0] === -1) {
      // Player's right is screen left (the far seat).
      put(meld, handX - meldGapPx - meld.width - cursor, handY + handHeight - meld.height);
      cursor += meld.width + meldStepGapPx;
    } else if (right[1] === -1) {
      // Player's right is up the screen (the right seat).
      put(meld, handX + handWidth - meld.width, handY - meldGapPx - meld.height - cursor);
      cursor += meld.height + meldStepGapPx;
    } else {
      // Player's right is down the screen (the left seat).
      put(meld, handX, handY + handHeight + meldGapPx + cursor);
      cursor += meld.height + meldStepGapPx;
    }
  }
}

/** Axis-aligned bounds of a zone's local space, including its shadow blur. */
export function zoneVisualBounds(
  zone: LayoutZone,
  scale = 1,
  includePad = true,
): Bounds {
  const width = zone.width * scale;
  const height = zone.height * scale;
  let left = 0;
  let top = 0;
  let right = width;
  let bottom = height;
  if (zone.rotationDeg !== 0) {
    const radians = (zone.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const pivotX = zone.pivotX * scale;
    const pivotY = zone.pivotY * scale;
    const corners: Array<readonly [number, number]> = [
      [0, 0],
      [width, 0],
      [width, height],
      [0, height],
    ];
    left = Infinity;
    top = Infinity;
    right = -Infinity;
    bottom = -Infinity;
    for (const [x, y] of corners) {
      const dx = x - pivotX;
      const dy = y - pivotY;
      const rx = pivotX + dx * cos - dy * sin;
      const ry = pivotY + dx * sin + dy * cos;
      left = Math.min(left, rx);
      top = Math.min(top, ry);
      right = Math.max(right, rx);
      bottom = Math.max(bottom, ry);
    }
  }
  const pad = includePad ? zone.blurPad * scale : 0;
  return {
    left: left - pad,
    top: top - pad,
    right: right + pad,
    bottom: bottom + pad,
  };
}

/** Shift every zone so the board's visual bounds start at (0, 0). */
function normalizePlan(
  zones: Array<{ zone: LayoutZone; x: number; y: number; scale: number }>,
  centreGapPx: number,
): BoardPlan {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  let blurPadPx = 0;
  for (const entry of zones) {
    const bounds = zoneVisualBounds(entry.zone, entry.scale);
    left = Math.min(left, entry.x + bounds.left);
    top = Math.min(top, entry.y + bounds.top);
    right = Math.max(right, entry.x + bounds.right);
    bottom = Math.max(bottom, entry.y + bounds.bottom);
    blurPadPx = Math.max(blurPadPx, entry.zone.blurPad * entry.scale);
  }
  if (!Number.isFinite(left)) {
    return {
      zones: [],
      width: 0,
      height: 0,
      blurPadPx,
      centreGapPx,
      centreX: 0,
      centreY: 0,
    };
  }
  return {
    zones: zones.map((entry) => ({
      zone: entry.zone,
      x: entry.x - left,
      y: entry.y - top,
      scale: entry.scale,
    })),
    width: right - left,
    height: bottom - top,
    blurPadPx,
    centreGapPx,
    // The placement space's origin is the table centre; normalisation shifted
    // every zone by (-left, -top), so that is where it moved to.
    centreX: -left,
    centreY: -top,
  };
}
