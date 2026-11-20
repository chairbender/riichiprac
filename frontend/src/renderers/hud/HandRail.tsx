/**
 * The HUD hand rail (3D-H3): the hand panel's always-visible hint row.
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
 * The chip is informational in this unit: its state machine lives in
 * `handRail.ts`, and H5 wraps the chip in the button that opens the verdict
 * sheet. It is not a live region — the hint beside it already announces the
 * hand's state, and two live regions would double-announce.
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
}

export function HandRail({
  hint,
  aiStatus,
  isEvaluating,
  hasEvaluation,
  peeked,
  answered,
}: HandRailProps) {
  const chip = mortalChip({
    aiStatus,
    isEvaluating,
    hasEvaluation,
    peeked,
    answered,
  });

  return (
    <div className="hud-hand-rail-row">
      <span className="hud-hand-rail__hint" aria-live="polite">
        {hint}
      </span>
      {chip && (
        <span
          className="hud-mortal-chip"
          data-state={chip.state}
          data-tone={chip.tone}
        >
          {chip.text}
        </span>
      )}
    </div>
  );
}
