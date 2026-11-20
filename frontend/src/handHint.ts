/**
 * The instruction line above the human player's hand.
 *
 * Pre-answer copy must never be derived from the scenario's answer. The
 * push/fold lesson carries `target_action` `Push` or `Fold` straight from
 * `correct_action`, so a hint that branched on it announced the answer before
 * the player had judged anything. Only player-driven state (a Riichi or Kan
 * they armed themselves, whether a discard is legal at all) may change the
 * wording; everything else reads the same neutral instruction whatever the
 * correct answer is.
 */

import { kanToggleTile } from './actions';
import { formatTileForDisplay } from './display';
import type { AiActionInfo } from './types/ai';
import type { PlayerState, TargetAction } from './types/game';

export interface HandHintInput {
  /** True once a grade exists for the submitted answer. */
  isAnswered: boolean;
  /** False when the answer is a button (call lesson, reaction state). */
  canDiscard: boolean;
  /** The player armed the Call Kan toggle. */
  callKan: boolean;
  /** The player armed the Call Riichi toggle. */
  callRiichi: boolean;
  /**
   * Display label of the Kan-callable tile, or null. Non-null only on a Kan
   * lesson, where the Call Kan toggle is on screen and the question is itself
   * "call the Kan, or discard?".
   */
  kanTileLabel: string | null;
}

export function handHint({
  isAnswered,
  canDiscard,
  callKan,
  callRiichi,
  kanTileLabel,
}: HandHintInput): string {
  if (isAnswered) {
    return 'Answer submitted';
  }
  if (!canDiscard) {
    // An AI reaction or a book call lesson: the answer is a button, not a tile.
    return 'Choose a call or Pass';
  }
  if (callKan) {
    return `Kan armed - tap ${kanTileLabel ?? ''} to declare Kan`;
  }
  if (callRiichi) {
    return 'Riichi selected - tap a tile to discard';
  }
  if (kanTileLabel) {
    return 'Tap a tile to discard, or arm Call Kan';
  }
  return 'Tap a tile to discard';
}

/** Everything the two shells already know about the hand, in one place. */
export interface HandHintStateInput {
  readonly player: PlayerState;
  readonly isAnswered: boolean;
  readonly canDiscard: boolean;
  readonly callRiichi: boolean;
  readonly callKan: boolean;
  /** Non-discard actions for an AI scenario; undefined for legacy lessons. */
  readonly availableActions?: AiActionInfo[];
  /** The lesson kind, used only to decide whether a Kan call is offered. */
  readonly targetAction?: TargetAction;
}

/**
 * The hint line for a whole hand state (3D-H3).
 *
 * The stacked/top-down `HandDock` and the 3D HUD's hand rail both call this, so
 * the two views cannot drift: the Kan-callable tile is derived by the same
 * `kanToggleTile` rule the toggle itself uses, and the wording by `handHint`.
 */
export function handHintFor({
  player,
  isAnswered,
  canDiscard,
  callRiichi,
  callKan,
  availableActions,
  targetAction,
}: HandHintStateInput): string {
  const kanTile = kanToggleTile(player, { availableActions, targetAction });
  return handHint({
    isAnswered,
    canDiscard,
    callKan,
    callRiichi,
    kanTileLabel: kanTile ? formatTileForDisplay(kanTile) : null,
  });
}
