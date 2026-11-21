/**
 * The instruction line above the human player's hand.
 *
 * Pre-answer copy must never be derived from the scenario's answer. The
 * push/fold lesson carries `target_action` `Push` or `Fold` straight from
 * `correct_action`, so a hint that branched on it announced the answer before
 * the player had judged anything. Only player-driven state (an open call pick,
 * whether a Kan button is on screen, whether a discard is legal at all) may
 * change the wording; everything else reads the same neutral instruction.
 */

import { callPickPrompt } from './callChoices';
import type { PendingCall } from './callChoices';

export interface HandHintInput {
  /** True once a grade exists for the submitted answer. */
  isAnswered: boolean;
  /** False when the answer is a button (call lesson, reaction state). */
  canDiscard: boolean;
  /** The open call pick, or null. Its prompt owns the line while it is open. */
  pendingCall: PendingCall | null;
  /** A Kan call button is on screen for this lesson. */
  hasKanCall: boolean;
}

export function handHint({
  isAnswered,
  canDiscard,
  pendingCall,
  hasKanCall,
}: HandHintInput): string {
  if (isAnswered) {
    return 'Answer submitted';
  }
  if (pendingCall) {
    return callPickPrompt(pendingCall);
  }
  if (!canDiscard) {
    // An AI reaction or a book call lesson: the answer is a button, not a tile.
    return 'Choose a call or Pass';
  }
  if (hasKanCall) {
    return 'Tap a tile to discard, or call Kan';
  }
  return 'Tap a tile to discard';
}
