/**
 * The 3D HUD's verdict sheet body (3D-H5).
 *
 * The sheet primitive itself is H2's (`Sheet`: dialog, focus trap, Escape,
 * inert scene). This unit supplies the one body the post-answer (and pre-answer
 * Peek) result opens into: the 2D `VerdictPanel` unchanged — grade columns,
 * `ActionRanking`, `CallReport`, `ScenarioExplanation`, the peek card and the
 * Retry control.
 *
 * Nothing here re-grades, re-evaluates or re-deals. `VerdictPanel` reads the
 * store's existing `gameState`, `evaluation` and `dualGrade`, so opening and
 * closing the sheet is a view change only.
 */

import { VerdictPanel } from '../../components/VerdictPanel';
import type { AiEvaluation, AiStatus } from '../../types/ai';
import type { GameState } from '../../types/game';
import type { DualGrade } from '../../types/verdict';

export interface VerdictSheetProps {
  readonly state: GameState;
  /** Null before the answer: the sheet then shows the Peek/status content. */
  readonly grade: DualGrade | null;
  readonly evaluation: AiEvaluation | null;
  readonly aiStatus: AiStatus;
  readonly aiError: string | null;
  readonly isEvaluating: boolean;
  readonly peeked: boolean;
  readonly redFives: string[];
  readonly onPeek: () => void;
  readonly onRetry: () => void;
}

export function VerdictSheet(props: VerdictSheetProps) {
  return (
    <div className="hud-verdict-sheet">
      <VerdictPanel {...props} />
    </div>
  );
}
