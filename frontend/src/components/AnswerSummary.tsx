import type { DualGrade } from '../types/verdict';
import { formatProbability } from '../types/ai';
import {
  acceptedAlternativeNote,
  formatAcceptedTiles,
  mortalRecommendationLabel,
  outcomeHeadline,
  outcomeTone,
} from '../types/verdict';

interface AnswerSummaryProps {
  grade: DualGrade;
  /** Scroll to the full book-vs-Mortal comparison. */
  onDetails: () => void;
}

/**
 * Inline verdict acknowledgement at the top of the hand dock.
 *
 * The full comparison lives in `VerdictPanel`; this strip only repeats the
 * headline and the two one-word grades at the point where the player tapped.
 * Because it sits inside the dock rather than over the table, it stays visible
 * without covering the board, action controls, or tiles.
 */
export function AnswerSummary({ grade, onDetails }: AnswerSummaryProps) {
  const tone = outcomeTone(grade.outcome);

  return (
    <section
      className={`answer-summary answer-summary--${tone}`}
      aria-label="Answer result"
    >
      <span className="answer-summary-mark" aria-hidden="true">
        {toneMark(tone)}
      </span>

      <span className="answer-summary-text" role="status" aria-live="polite">
        <span className="answer-summary-headline">
          {outcomeHeadline(grade.outcome, grade.mode)}
        </span>
        <span className="answer-summary-detail">{detailLine(grade)}</span>
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
        aria-label="Show the full book and Mortal comparison"
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

function detailLine(grade: DualGrade): string {
  const mortalPick = mortalRecommendationLabel(grade.mortal ?? null);

  switch (grade.outcome) {
    case 'both_agree':
      return 'The book and Mortal agree.';
    case 'book_agrees_mortal_does_not':
      return (
        acceptedAlternativeNote(grade.book, grade.mortal) ??
        `Mortal would play ${mortalPick}.`
      );
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
  // A tied shape lesson names both accepted discards: "discarding 5p or 3p".
  const tiles = formatAcceptedTiles(grade.book);
  switch (grade.book.expected_action) {
    case 'kan':
      return `Kan on ${tiles}`;
    case 'discard':
      return `No Kan, discard ${tiles}`;
    case 'riichi':
      return `Riichi, discarding ${tiles}`;
    case 'dama':
      return `Dama, discarding ${tiles}`;
    case 'fold':
      return `Fold, discarding ${tiles}`;
    case 'pass':
      return 'Pass on the call';
    case 'call':
      return 'Take the call';
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
    case 'fold':
      return 'Fold';
    case 'kan':
      return 'Kan';
    case 'discard':
      return 'No Kan';
    case 'pass':
      return 'Pass';
    case 'call':
      return 'Call';
    default:
      return 'Mortal action';
  }
}
