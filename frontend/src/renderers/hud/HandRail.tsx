/**
 * The HUD hand rail (3D-H3, extended by 3D-H5): the hand panel's
 * always-visible hint row.
 *
 * `3d_hud.md` §4 splits `HandDock` by job. The projected buttons from 3D-08 are
 * the hand; this rail is what the dock *said* about it — the live-region hint
 * (`handHintFor`, the same function the dock uses) and the pre-answer Mortal
 * chip. It renders **no tile buttons**: the only hand controls in 3D are the
 * scene's own projected buttons, and a count test enforces that.
 *
 * Two things the dock carries are deliberately not here:
 *
 * - `AnswerSummary` is the result card (3D-H5), which replaces both panel rows
 *   after an answer; two summaries would be duplicate controls.
 * - the dock's `NextScenarioButton` is dropped: the HUD top bar's Next hand is
 *   the single control (3D-H2).
 *
 * H5 turns the Mortal chip into the verdict sheet's pre-answer trigger: Peek and
 * the pre-answer status line live in that sheet (`3d_hud.md` §3 rows 33–36).
 * The chip is the only pointer to it, and the sheet is the only place a peek
 * happens. Post-answer the chip is gone (the result card owns the marks).
 */

import type { AiStatus } from '../../types/ai';
import { mortalChip } from './handRail';

export interface HandRailProps {
  /** The hand's live-region instruction (`handHintFor`). */
  readonly hint: string;
  readonly aiStatus: AiStatus;
  readonly isEvaluating: boolean;
  /** Whether a Mortal evaluation exists for this hand. */
  readonly hasEvaluation: boolean;
  /** Mortal's line was revealed before answering. */
  readonly peeked: boolean;
  /** The hand is answered: the chip is post-answer content (result card, H5). */
  readonly answered: boolean;
  /**
   * Open the verdict sheet (H5). Supplied, the chip is a button; omitted, it is
   * informational text (the rail's standalone tests render it that way).
   */
  readonly onOpenVerdict?: () => void;
  /**
   * Whether the hint announces itself (`aria-live`). The HUD passes `false`
   * once answered: the result card's own announcement is the message there.
   */
  readonly announceHint?: boolean;
}

export function HandRail({
  hint,
  aiStatus,
  isEvaluating,
  hasEvaluation,
  peeked,
  answered,
  onOpenVerdict,
  announceHint = true,
}: HandRailProps) {
  const chip = mortalChip({
    aiStatus,
    isEvaluating,
    hasEvaluation,
    peeked,
    answered,
  });
  const chipState = {
    'data-state': chip?.state,
    'data-tone': chip?.tone,
  };

  return (
    <div className="hud-hand-rail-row">
      <span
        className="hud-hand-rail__hint"
        aria-live={announceHint ? 'polite' : undefined}
      >
        {hint}
      </span>
      {chip &&
        (onOpenVerdict ? (
          <button
            type="button"
            className="hud-mortal-chip hud-mortal-chip--trigger"
            {...chipState}
            aria-haspopup="dialog"
            aria-label={`${chip.text}: open the verdict`}
            onClick={onOpenVerdict}
          >
            {chip.text}
          </button>
        ) : (
          <span className="hud-mortal-chip" {...chipState}>
            {chip.text}
          </span>
        ))}
    </div>
  );
}
