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
 *              back wall
 *   left hand   top pond    right hand
 *   left wall   (compass)   right wall
 *               bottom pond
 *              front wall
 *                bottom hand
 *
 * The four ponds sit round the central compass well, the walls ring the ponds,
 * and each seat's hand (plus its melds, on the player's right) sits outside its
 * wall. Every distance is derived from the measured zones, so a longer hand, an
 * extra pond row or a second meld moves its neighbours rather than overlapping
 * them.
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
  /** Half the compass well: the ponds' inner edges sit this far from centre. */
  centreGapPx: 104,
  /** Pond edge to its wall's inner edge. */
  pondWallGapPx: 26,
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

  const placed: Array<{ zone: LayoutZone; x: number; y: number }> = [];
  const put = (zone: LayoutZone | null, x: number, y: number) => {
    if (zone) placed.push({ zone, x, y });
  };

  const { pondWallGapPx, wallHandGapPx, meldGapPx, meldStepGapPx } =
    RENDERED_BOARD_SPACING;

  /*
   * The compass well has to be at least as wide as one pond's long side, or the
   * four rivers overlap in the corners: a 6-column bottom pond spans half its
   * width either side of the seat's centre line.
   */
  const reference = referencePondSizes(manifest);
  const pondHalfSpan =
    Math.max(
      reference.bottom.width,
      reference.top.width,
      reference.left.height,
      reference.right.height,
    ) / 2;
  const centreGapPx = Math.max(
    RENDERED_BOARD_SPACING.centreGapPx,
    Math.ceil(pondHalfSpan) + 8,
  );

  // Ponds: their inner edge is one centre gap from the compass centre.
  const bottomPond = bottom?.pond ?? null;
  const topPond = top?.pond ?? null;
  const leftPond = left?.pond ?? null;
  const rightPond = right?.pond ?? null;

  /*
   * The ring is measured from a *full* reference pond, not the current one: a
   * pond that grows as discards land would move the walls, hands and board
   * bounds on every discard. The actual pond keeps its far/near edge on the
   * reference and grows toward its player, exactly like a real river.
   *
   * The side walls are 17 stacks tall, taller than a short pond band, so the
   * band is at least half a side wall: the front/back walls move out to meet
   * the side walls instead of the side walls crossing them.
   */
  const sideWallHalf = Math.max(leftWall.height, rightWall.height) / 2;
  const ringHalf = Math.max(
    sideWallHalf,
    centreGapPx + Math.max(reference.top.height, reference.bottom.height) + pondWallGapPx,
  );
  const leftPondOuter = centreGapPx + reference.left.width;
  const rightPondOuter = centreGapPx + reference.right.width;

  // The bottom hand: its far edge clears the front wall.
  const frontWallY = ringHalf;
  const frontWallNear = frontWallY + frontWall.height;
  const bottomHand = bottom?.hand ?? null;
  const bottomHandY = frontWallNear + wallHandGapPx;
  const bottomHandX = bottomHand ? -bottomHand.width / 2 : 0;

  // The top hand: its near edge clears the back wall.
  const backWallNear = -ringHalf;
  const backWallY = backWallNear - backWall.height;
  const topHand = top?.hand ?? null;
  const topHandY = backWallY - wallHandGapPx - (topHand?.height ?? 0);
  const topHandX = topHand ? -topHand.width / 2 : 0;

  // The side walls ring the ponds horizontally; the side hands sit outside.
  const leftWallX = -(leftPondOuter + pondWallGapPx) - leftWall.width;
  const rightWallX = rightPondOuter + pondWallGapPx;
  const leftWallY = -leftWall.height / 2;
  const rightWallY = -rightWall.height / 2;
  const leftHand = left?.hand ?? null;
  const rightHand = right?.hand ?? null;
  const leftHandX = leftHand
    ? leftWallX - wallHandGapPx - leftHand.width
    : leftWallX - wallHandGapPx;
  const leftHandY = leftHand ? -leftHand.height / 2 : 0;
  const rightHandX = rightWallX + rightWall.width + wallHandGapPx;
  const rightHandY = rightHand ? -rightHand.height / 2 : 0;

  // Painter order (Task 4.1). Insertion order + the zones' own `layer` field is
  // the contract: the stable sort below only groups them.
  put(backWall, -backWall.width / 2, backWallY);
  put(topHand, topHandX, topHandY);
  placeMelds(put, top?.melds ?? [], 'top', topHandX, topHandY, {
    hand: topHand,
    meldGapPx,
    meldStepGapPx,
  });
  put(leftWall, leftWallX, leftWallY);
  put(rightWall, rightWallX, rightWallY);
  put(bottomPond, bottomPond ? -bottomPond.width / 2 : 0, centreGapPx);
  put(rightPond, centreGapPx, rightPond ? -rightPond.height / 2 : 0);
  put(topPond, topPond ? -topPond.width / 2 : 0, -centreGapPx - (topPond?.height ?? 0));
  put(leftPond, leftPond ? -centreGapPx - leftPond.width : -centreGapPx, leftPond ? -leftPond.height / 2 : 0);
  put(frontWall, -frontWall.width / 2, frontWallY);
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
export function zoneVisualBounds(zone: LayoutZone): Bounds {
  let left = 0;
  let top = 0;
  let right = zone.width;
  let bottom = zone.height;
  if (zone.rotationDeg !== 0) {
    const radians = (zone.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const corners: Array<readonly [number, number]> = [
      [0, 0],
      [zone.width, 0],
      [zone.width, zone.height],
      [0, zone.height],
    ];
    left = Infinity;
    top = Infinity;
    right = -Infinity;
    bottom = -Infinity;
    for (const [x, y] of corners) {
      const dx = x - zone.pivotX;
      const dy = y - zone.pivotY;
      const rx = zone.pivotX + dx * cos - dy * sin;
      const ry = zone.pivotY + dx * sin + dy * cos;
      left = Math.min(left, rx);
      top = Math.min(top, ry);
      right = Math.max(right, rx);
      bottom = Math.max(bottom, ry);
    }
  }
  const pad = zone.blurPad;
  return {
    left: left - pad,
    top: top - pad,
    right: right + pad,
    bottom: bottom + pad,
  };
}

/** Shift every zone so the board's visual bounds start at (0, 0). */
function normalizePlan(
  zones: Array<{ zone: LayoutZone; x: number; y: number }>,
  centreGapPx: number,
): BoardPlan {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  let blurPadPx = 0;
  for (const entry of zones) {
    const bounds = zoneVisualBounds(entry.zone);
    left = Math.min(left, entry.x + bounds.left);
    top = Math.min(top, entry.y + bounds.top);
    right = Math.max(right, entry.x + bounds.right);
    bottom = Math.max(bottom, entry.y + bounds.bottom);
    blurPadPx = Math.max(blurPadPx, entry.zone.blurPad);
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
