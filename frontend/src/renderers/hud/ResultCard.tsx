/**
 * The 3D HUD's compact result card (3D-H5).
 *
 * `3d_hud.md` §2 and §4: after an answer the hand panel's two rows are replaced
 * by one fixed-shape card. It is the 2D dock's `AnswerSummary` — the same
 * mark, headline, detail, Book/Mortal chips and Details affordance — plus the
 * one line naming the book's answer and Mortal's choice. It never expands on
 * its own: the only way into the full verdict is the card's Details button
 * (user decision 2026-11-19).
 *
 * Two HUD-specific details:
 *
 * - the card is **not** a live region. The HUD owns one persistent announcer
 *   (`HudLayer`'s `announcement` slot), so unmounting the card while the verdict
 *   sheet is open cannot announce the same answer twice;
 * - the answer removed the control that had focus (a projected tile, or a rail
 *   action), so the card takes focus to its Details affordance. That is a valid
 *   target and does not re-read the whole result, which the announcer already
 *   spoke once.
 *
 * Its height is fixed by `hudLayout()` (`104 px`); the gate checks the card and
 * its trigger against the hand band and the compass at every supported aspect.
 */

import { useEffect, useRef } from 'react';
import { AnswerSummary } from '../../components/AnswerSummary';
import { NextScenarioButton } from '../../components/NextScenarioButton';
import type { GameState } from '../../types/game';
import type { DualGrade } from '../../types/verdict';
import { outcomeTone } from '../../types/verdict';
import { verdictPicksLine } from '../../verdictText';

export interface ResultCardProps {
  /** The dual verdict for the submitted answer. */
  readonly grade: DualGrade;
  /** The current table, so the book's pick can be named exactly. */
  readonly state: GameState;
  /** Open the verdict sheet: the only way to expand the result. */
  readonly onDetails: () => void;
  /**
   * Deal the next hand (user request 2026-11-20).
   *
   * The top bar keeps its Next, but the card is where the player is looking
   * after an answer, so it carries its own copy rather than sending them to the
   * corner. The sheet header carries a third one for the same reason.
   */
  readonly onNext: () => void;
  /** True while the next hand is being generated. */
  readonly nextDisabled?: boolean;
}

/** True when nothing that can receive focus survived the answer. */
function focusWasLost(): boolean {
  const active = document.activeElement;
  return (
    active === null ||
    active === document.body ||
    active === document.documentElement ||
    (active instanceof HTMLElement && !active.isConnected)
  );
}

export function ResultCard({
  grade,
  state,
  onDetails,
  onNext,
  nextDisabled = false,
}: ResultCardProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusWasLost()) return;
    rootRef.current
      ?.querySelector<HTMLElement>('.answer-summary-details')
      ?.focus();
  }, []);

  const picks = verdictPicksLine(state, grade);

  return (
    <div
      ref={rootRef}
      className="hud-result-card-content"
      data-tone={outcomeTone(grade.outcome)}
    >
      <AnswerSummary grade={grade} onDetails={onDetails} live={false} />
      <div className="hud-result-card-actions">
        {picks && <p className="hud-result-card__picks">{picks}</p>}
        <NextScenarioButton onClick={onNext} disabled={nextDisabled} />
      </div>
    </div>
  );
}
