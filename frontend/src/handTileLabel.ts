/**
 * The accessible name of one hand tile button (3D-08).
 *
 * Both the stacked/top-down `HandDock` and the 3D overlay's projected buttons
 * call this, so the two views cannot drift: the same hand state produces the
 * same words, in the same order of clauses. The drift test renders both and
 * compares the labels rather than trusting a copy.
 */

import { formatTileForDisplay } from './display';

/** The hand tile's state that changes its accessible name. */
export interface HandTileLabelInput {
  /** Engine tile code, e.g. `5s`. */
  readonly code: string;
  /** True when this copy is the red five of its suit. */
  readonly isRed?: boolean;
  /** The Call Kan toggle is armed: the click declares a kan on this tile. */
  readonly callKan?: boolean;
  /** The Call Riichi toggle is armed: the discard declares Riichi. */
  readonly callRiichi?: boolean;
}

/** The button's accessible name, e.g. `Discard R5s, with Riichi`. */
export function handTileLabel({
  code,
  isRed = false,
  callKan = false,
  callRiichi = false,
}: HandTileLabelInput): string {
  const name = formatTileForDisplay(code, isRed);
  const action = callKan ? `Declare Kan on ${name}` : `Discard ${name}`;
  return callRiichi ? `${action}, with Riichi` : action;
}
