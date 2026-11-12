import type { CalledMeld } from './types/game';

/** Seats around the table; seat `n + 1` is the player who acts after seat `n`. */
const SEAT_COUNT = 4;

/** Which opponent's discard a meld claimed, seen from the caller's seat. */
export type CalledFrom = 'left' | 'across' | 'right';

/** Where a meld's called tile sits and which opponent discarded it. */
export interface CalledTile {
  /** Index into `meld.tiles` of the tile taken from the discard. */
  index: number;
  /** The seat it came from, relative to the caller. */
  from: CalledFrom;
}

/**
 * The sideways tile of a Pon, or null when the meld is not drawn that way.
 *
 * The called tile is placed sideways in the meld, and its position says who
 * discarded it: an opponent on the caller's left (kamicha, the previous seat)
 * puts it on the left, the player across puts it in the middle, and the player
 * on the right (shimocha, the next seat) puts it on the right.
 *
 * Pon tiles are all the same kind, so the position is the only place the
 * source can be shown; `called_from` is therefore enough to pick the slot.
 * Chi and Kan keep their tiles upright for now.
 */
export function calledTile(meld: CalledMeld, seat: number): CalledTile | null {
  if (meld.meld_type !== 'Pon' || meld.tiles.length !== 3) return null;

  const from = meld.called_from;
  if (from == null) return null;

  const step = (((from - seat) % SEAT_COUNT) + SEAT_COUNT) % SEAT_COUNT;
  switch (step) {
    // Kamicha, the player immediately before the caller, sits on the left.
    case 3:
      return { index: 0, from: 'left' };
    // Toimen, directly across.
    case 2:
      return { index: 1, from: 'across' };
    // Shimocha, the player immediately after the caller, sits on the right.
    case 1:
      return { index: 2, from: 'right' };
    // The caller cannot claim its own discard.
    default:
      return null;
  }
}
