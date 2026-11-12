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
 * Slots of a Pon's called tile, keyed by the source's step behind the caller:
 * kamicha (3) leads, toimen (2) is in the middle, shimocha (1) is last.
 *
 * These are the same slots the tenhou.net/6 exporter writes into its naki
 * strings (`src/export/tenhou6.rs`, `naki_string`), so the table and the
 * exported log agree about where the call came from.
 */
const PON_SLOTS: Record<number, CalledTile> = {
  3: { index: 0, from: 'left' },
  2: { index: 1, from: 'across' },
  1: { index: 2, from: 'right' },
};

/**
 * Slots of an open Kan's called tile. The four tiles are all the same kind, so
 * only the slot separates a call from kamicha, toimen, and shimocha; the
 * exporter puts a shimocha call in the last slot of four, not the third.
 */
const KAN_SLOTS: Record<number, CalledTile> = {
  3: { index: 0, from: 'left' },
  2: { index: 1, from: 'across' },
  1: { index: 3, from: 'right' },
};

/**
 * The sideways tile of a call, or null when the meld is drawn all upright.
 *
 * The called tile is turned 90 degrees in the meld, and its position says who
 * discarded it: an opponent on the caller's left (kamicha, the previous seat)
 * puts it on the left, the player across puts it in the middle, and the player
 * on the right (shimocha, the next seat) puts it on the right. A Chi can only
 * claim kamicha's discard, so it is always drawn on the left.
 *
 * The state records the meld's tiles and its source, not which tile of a run
 * was claimed, which is all the sideways slot needs: Pon and Kan tiles are
 * identical, and a Chi's sideways tile is fixed at the left. An added kan and
 * an open kan have the same shape in the state, so both are drawn flat with
 * the called slot sideways.
 */
export function calledTile(meld: CalledMeld, seat: number): CalledTile | null {
  const from = meld.called_from;
  if (from == null) return null;

  const step = (((from - seat) % SEAT_COUNT) + SEAT_COUNT) % SEAT_COUNT;

  switch (meld.meld_type) {
    case 'Chi':
      // Only kamicha's discard can be claimed. The state holds the run, not
      // which tile of it was claimed, so the call is marked the way the
      // exporter marks it: the run's leftmost tile goes sideways.
      return meld.tiles.length === 3 && step === 3
        ? { index: 0, from: 'left' }
        : null;
    case 'Pon':
      return meld.tiles.length === 3 ? (PON_SLOTS[step] ?? null) : null;
    case 'Kan':
      return meld.tiles.length === 4 ? (KAN_SLOTS[step] ?? null) : null;
    case 'Ankan':
      // A closed kan has no called tile.
      return null;
  }
}
