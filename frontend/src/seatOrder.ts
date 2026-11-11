import type { PlayerState } from './types/game';

/** Seats around the table; seat `n + 1` is the player who acts after seat `n`. */
const SEAT_COUNT = 4;

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
