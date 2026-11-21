/**
 * The accessible name of one hand tile button (3D-08).
 *
 * Both the stacked/top-down `HandDock` and the 3D overlay's projected buttons
 * call this, so the two views cannot drift: the same hand state produces the
 * same words, in the same order of clauses. The drift test renders both and
 * compares the labels rather than trusting a copy.
 */

import type { CallKind } from './callChoices';
import { formatTileForDisplay } from './display';

/** The hand tile's state that changes its accessible name. */
export interface HandTileLabelInput {
  /** Engine tile code, e.g. `5s`. */
  readonly code: string;
  /** True when this copy is the red five of its suit. */
  readonly isRed?: boolean;
  /**
   * The open call pick, if any: the tile is being chosen for this call rather
   * than discarded. Null (or absent) is an ordinary discard.
   */
  readonly pick?: CallKind | null;
}

/** The button's accessible name, e.g. `Discard R5s` or `Chi with 3m`. */
export function handTileLabel({
  code,
  isRed = false,
  pick = null,
}: HandTileLabelInput): string {
  const name = formatTileForDisplay(code, isRed);
  switch (pick) {
    case 'riichi':
      return `Discard ${name} for Riichi`;
    case 'chi':
      return `Chi with ${name}`;
    case 'pon':
      return `Pon with ${name}`;
    case 'kan':
      return `Kan with ${name}`;
    default:
      return `Discard ${name}`;
  }
}
