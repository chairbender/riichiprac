import { callDecisionFor } from '../callDecision';
import type { DualGrade } from '../types/verdict';
import { outcomeHeadline, outcomeTone } from '../types/verdict';
import type { SubmittedAnswer } from '../store/useGameStore';
import type { AiEvaluation } from '../types/ai';
import { formatProbability } from '../types/ai';
import { Tile } from './Tile';

interface FeedbackToastProps {
  grade: DualGrade;
  answer: SubmittedAnswer;
  /** Red-five tile codes held by the human, used to render answer tiles. */
  redFives: string[];
  /** Mortal's evaluation for this table, used for the call report. */
  evaluation: AiEvaluation | null;
}

/**
 * Compact verdict after submitting, in the shared dual-verdict vocabulary.
 *
 * Only `NeitherAgrees` may read as a failure. A split decision is "contested",
 * and a single-perspective miss is neutral: the missing perspective is stated
 * instead of being replaced with "wrong".
 */
export function FeedbackToast({
  grade,
  answer,
  redFives,
  evaluation,
}: FeedbackToastProps) {
  const tone = outcomeTone(grade.outcome);
  const isRedFive = (tile: string) => redFives.includes(tile);
  const call = callDecisionFor(evaluation);

  return (
    <div
      className={`feedback-toast feedback-toast--${tone}`}
      role="status"
      aria-live="assertive"
    >
      <span className="feedback-message">
        {outcomeHeadline(grade.outcome, grade.mode)}
      </span>
      <span className="feedback-detail">{detailLine(grade)}</span>

      <div className="feedback-grades">
        {grade.book && (
          <div
            className={
              grade.book.is_action_correct && grade.book.is_tile_correct
                ? 'feedback-grade feedback-grade--correct'
                : 'feedback-grade feedback-grade--neutral'
            }
          >
            <span className="feedback-grade-label">Book</span>
            <span className="feedback-grade-value">
              {answerLabel(answer)}
            </span>
            <span
              className="feedback-grade-mark"
              role="img"
              aria-label={
                grade.book.is_action_correct ? 'correct action' : 'wrong action'
              }
            >
              {grade.book.is_action_correct ? '\u2713' : '\u2717'}
            </span>
            {!grade.book.is_action_correct && (
              <span className="feedback-grade-correct">
                should be {actionTypeLabel(grade.book.expected_action)}
              </span>
            )}
            {grade.book.is_action_correct && !grade.book.is_tile_correct && (
              <span className="feedback-grade-correct">
                should discard
                <Tile
                  code={grade.book.expected_tile}
                  className="tile feedback-tile"
                  isRedFive={isRedFive(grade.book.expected_tile)}
                />
                <span className="feedback-code">{grade.book.expected_tile}</span>
              </span>
            )}
          </div>
        )}

        {grade.mortal && (
          <div
            className={
              grade.mortal.agrees
                ? 'feedback-grade feedback-grade--correct'
                : 'feedback-grade feedback-grade--neutral'
            }
          >
            <span className="feedback-grade-label">Mortal</span>
            <span className="feedback-grade-value">
              {grade.mortal.recommended_label}
            </span>
            <span
              className="feedback-grade-mark"
              role="img"
              aria-label={
                grade.mortal.agrees ? 'Mortal agrees' : 'Mortal disagrees'
              }
            >
              {grade.mortal.agrees ? '\u2713' : '\u2717'}
            </span>
            {grade.mortal.top_probability > 0 && (
              <span className="feedback-grade-correct">
                {formatProbability(grade.mortal.top_probability)}
              </span>
            )}
          </div>
        )}
      </div>

      {call && (
        <span className="feedback-call">
          Mortal on the call:{' '}
          {call.options
            .map(
              (option) =>
                `${option.label} ${formatProbability(option.probability)}`,
            )
            .join(' · ')}
        </span>
      )}
    </div>
  );
}

function detailLine(grade: DualGrade): string {
  const mortalPick = grade.mortal?.recommended_label ?? 'another action';

  switch (grade.outcome) {
    case 'both_agree':
      return 'The book and Mortal agree.';
    case 'book_agrees_mortal_does_not':
      return `Mortal would play ${mortalPick}.`;
    case 'mortal_agrees_book_does_not':
      return `The book says ${bookPick(grade)}.`;
    case 'neither_agrees':
      return grade.mortal?.confidence === 'low'
        ? 'Neither the book nor Mortal picks this — Mortal is nearly split.'
        : 'Neither the book nor Mortal picks this.';
    case 'only_available_agrees':
      return grade.mode === 'mortal_only'
        ? 'Mortal drill — graded by the model alone.'
        : 'Mortal isn’t loaded, so this was graded against the book only.';
    case 'only_available_disagrees':
      return grade.mode === 'mortal_only'
        ? 'Mortal drill — graded by the model alone.'
        : 'Mortal isn’t loaded, so this isn’t graded as wrong.';
    case 'ungraded':
      return 'Mortal isn’t loaded, so this hand can’t be graded yet.';
  }
}

function bookPick(grade: DualGrade): string {
  if (!grade.book) return 'something else';
  const tile = grade.book.expected_tile;
  switch (grade.book.expected_action) {
    case 'kan':
      return `Kan on ${tile}`;
    case 'discard':
      return `No Kan, discard ${tile}`;
    case 'riichi':
      return `Riichi, discarding ${tile}`;
    case 'dama':
      return `Dama, discarding ${tile}`;
    default:
      return actionTypeLabel(grade.book.expected_action);
  }
}

function actionTypeLabel(action: string): string {
  switch (action) {
    case 'riichi':
      return 'Riichi';
    case 'dama':
      return 'Dama';
    case 'kan':
      return 'Kan';
    case 'discard':
      return 'No Kan';
    default:
      return 'Mortal action';
  }
}

function answerLabel(answer: SubmittedAnswer): string {
  if (answer.action_name) return answer.action_name.replace(/_/g, ' ');
  const action = actionTypeLabel(answer.action);
  return answer.tile ? `${action} · ${answer.tile}` : action;
}
