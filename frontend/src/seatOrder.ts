import type { PlayerState } from './types/game';

/** Seats around the table; seat `n + 1` is the player who acts after seat `n`. */
const SEAT_COUNT = 4;

/** The four edges of the flat table, as the human sees them. */
export type TableSide = 'bottom' | 'right' | 'top' | 'left';

/** Clockwise rotation, in degrees, of a tile drawn for the bottom seat. */
export type SeatRotation = 0 | 90 | 180 | 270;

/**
 * The table's sides in turn order, starting from the human's seat.
 *
 * Play runs counter-clockwise, so from the human's seat the next player is on
 * the right, then across, then on the left.
 */
export const TABLE_SIDES: readonly TableSide[] = [
  'bottom',
  'right',
  'top',
  'left',
];

/**
 * How a seat's tiles are turned in the plan view.
 *
 * A tile is drawn upright for the bottom seat. Every other seat sits on a
 * different edge, so its tiles are turned the same way the whole seat is: the
 * player across sees them upside down, and the side seats see them sideways
 * with the tile's top edge pointing away from them, exactly as a tile lying on
 * a real table would read from above.
 */
export const SIDE_ROTATION: Record<TableSide, SeatRotation> = {
  bottom: 0,
  right: 270,
  top: 180,
  left: 90,
};

/** One player's place in the top-down table view. */
export interface SeatPlacement {
  player: PlayerState;
  /** Which edge of the table the player sits on. */
  side: TableSide;
  /** Clockwise rotation to apply to this seat's tiles, in degrees. */
  rotation: SeatRotation;
}

/**
 * Where each player sits in the top-down table view.
 *
 * The human — the player whose decision the puzzle asks for — is anchored at
 * the bottom edge, above the hand dock, and the other seats go around the
 * table in turn order: shimocha on the right, toimen across, kamicha on the
 * left. Rotating the whole plan view onto the human's seat keeps their own
 * side at the bottom of the screen, so an imported report that places the
 * human on another seat index still reads the same way.
 *
 * A malformed table can repeat or skip seats; keying by seat keeps the first
 * player for each seat. A seat that is not one of the four places round the
 * table joins the human's edge rather than disappearing from the view.
 */
export function tablePlacements(players: PlayerState[]): SeatPlacement[] {
  const human = players.find((player) => player.is_human);
  const anchor = human?.seat ?? 0;

  const bySeat = new Map<number, PlayerState>();
  for (const player of players) {
    if (!bySeat.has(player.seat)) {
      bySeat.set(player.seat, player);
    }
  }

  const placements: SeatPlacement[] = [];
  for (let step = 0; step < SEAT_COUNT; step += 1) {
    const seat = (anchor + step) % SEAT_COUNT;
    const player = bySeat.get(seat);
    if (!player) continue;
    bySeat.delete(seat);

    const side = TABLE_SIDES[step];
    placements.push({ player, side, rotation: SIDE_ROTATION[side] });
  }

  // Never drop a player: a seat outside the four places round the table shares
  // the human's edge.
  for (const player of bySeat.values()) {
    placements.push({ player, side: 'bottom', rotation: 0 });
  }

  return placements;
}

/**
 * The table's player rows, from the top row to the bottom row.
 *
 * The human — the player whose decision the puzzle asks for — is anchored at
 * the bottom, directly above the hand dock. The other seats stack above it in
 * turn order, so reading the rows downwards continues around the table: for a
 * human on seat 0 the rows are Shimocha, Toimen, Kamicha, then the human. A
 * player whose seat wind is South therefore sees West at the top, then North,
 * then East, then themselves at the bottom.
 *
 * Seat indices increase in turn order and are relative to the human, so
 * anchoring on the human's own seat keeps the stack correct for imported
 * reports that place the human on another seat.
 */
export function stackOrder(players: PlayerState[]): PlayerState[] {
  const human = players.find((player) => player.is_human);
  const anchor = human?.seat ?? 0;

  // A malformed table can repeat or skip seats; keying by seat keeps the first
  // row for each seat and leaves anything unmatched for the tail below.
  const bySeat = new Map<number, PlayerState>();
  for (const player of players) {
    if (!bySeat.has(player.seat)) {
      bySeat.set(player.seat, player);
    }
  }

  const ordered: PlayerState[] = [];
  // Steps 1..=3 are the opponents in turn order; the last step wraps back to
  // the human, who takes the bottom row.
  for (let step = 1; step <= SEAT_COUNT; step += 1) {
    const seat = (anchor + step) % SEAT_COUNT;
    const player = bySeat.get(seat);
    if (!player) continue;
    bySeat.delete(seat);
    ordered.push(player);
  }

  // Never drop a row: unknown seats keep their arrival order at the bottom.
  ordered.push(...bySeat.values());
  return ordered;
}
