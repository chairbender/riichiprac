import type { DualGrade } from '../types/verdict';
import { formatProbability } from '../types/ai';
import {
  mortalRecommendationLabel,
  outcomeHeadline,
  outcomeTone,
} from '../types/verdict';
import { answerDetailLine } from '../verdictText';

interface AnswerSummaryProps {
  grade: DualGrade;
  /** Open the full book-vs-Mortal comparison. */
  onDetails: () => void;
  /**
   * Whether this strip is the result's live region (the 2D dock's default).
   *
   * The 3D result card passes `false`: the HUD owns one persistent live region,
   * so mounting/unmounting the card around the verdict sheet cannot
   * re-announce the same answer (`3d_hud.md` §6.5.10).
   */
  live?: boolean;
}

/**
 * Inline verdict acknowledgement at the top of the hand dock.
 *
 * The full comparison lives in `VerdictPanel`; this strip only repeats the
 * headline and the two one-word grades at the point where the player tapped.
 * Because it sits inside the dock rather than over the table, it stays visible
 * without covering the board, action controls, or tiles.
 */
export function AnswerSummary({
  grade,
  onDetails,
  live = true,
}: AnswerSummaryProps) {
  const tone = outcomeTone(grade.outcome);

  return (
    <section
      className={`answer-summary answer-summary--${tone}`}
      aria-label="Answer result"
    >
      <span className="answer-summary-mark" aria-hidden="true">
        {toneMark(tone)}
      </span>

      <span
        className="answer-summary-text"
        role={live ? 'status' : undefined}
        aria-live={live ? 'polite' : undefined}
      >
        <span className="answer-summary-headline">
          {outcomeHeadline(grade.outcome, grade.mode)}
        </span>
        <span className="answer-summary-detail">{answerDetailLine(grade)}</span>
      </span>

      <span className="answer-summary-marks">
        {grade.book && (
          <span
            className={`answer-summary-chip answer-summary-chip--${
              bookAgrees(grade) ? 'ok' : 'no'
            }`}
            aria-label={bookMarkLabel(grade)}
          >
            {bookMarkText(grade)}
          </span>
        )}
        {grade.mortal && (
          <span
            className={`answer-summary-chip answer-summary-chip--${
              grade.mortal.agrees ? 'ok' : 'no'
            }`}
            aria-label={mortalMarkLabel(grade)}
          >
            {mortalMarkText(grade)}
          </span>
        )}
      </span>

      <button
        className="answer-summary-details"
        type="button"
        onClick={onDetails}
        aria-label={
          grade.mode === 'mortal_only'
            ? 'Show the full Mortal verdict'
            : 'Show the full book and Mortal comparison'
        }
      >
        Details
      </button>
    </section>
  );
}

function toneMark(tone: 'correct' | 'contested' | 'incorrect' | 'neutral') {
  switch (tone) {
    case 'correct':
      return '\u2713';
    case 'contested':
      return '\u00b1';
    case 'incorrect':
      return '\u2717';
    case 'neutral':
      return '\u2022';
  }
}

function bookAgrees(grade: DualGrade): boolean {
  return Boolean(
    grade.book?.is_action_correct && grade.book?.is_tile_correct,
  );
}

function bookMarkText(grade: DualGrade): string {
  if (!grade.book) return 'Book';
  if (!grade.book.is_action_correct) return 'Book \u2717';
  if (!grade.book.is_tile_correct) return 'Book tile \u2717';
  return 'Book \u2713';
}

function bookMarkLabel(grade: DualGrade): string {
  if (!grade.book) return 'Book';
  if (!grade.book.is_action_correct) return 'Book: wrong action';
  if (!grade.book.is_tile_correct) return 'Book: right action, wrong tile';
  return 'Book: correct';
}

function mortalMarkText(grade: DualGrade): string {
  if (!grade.mortal) return 'Mortal';
  const mark = grade.mortal.agrees ? '\u2713' : '\u2717';
  if (grade.mortal.top_probability > 0) {
    return `Mortal ${mark} ${formatProbability(grade.mortal.top_probability)}`;
  }
  return `Mortal ${mark}`;
}

function mortalMarkLabel(grade: DualGrade): string {
  if (!grade.mortal) return 'Mortal';
  if (grade.mortal.agrees) return 'Mortal: agrees';
  return `Mortal: recommends ${mortalRecommendationLabel(grade.mortal)}`;
}
