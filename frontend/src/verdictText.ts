/**
 * Player-facing verdict wording, shared by every shell (3D-H5).
 *
 * The 2D dock's `AnswerSummary`, the 2D `VerdictPanel`, and the 3D HUD's result
 * card and live-region announcement all describe the same `DualGrade`. Keeping
 * the sentences here is what stops them drifting: a wording change lands once
 * and every surface that says it changes together.
 *
 * The wording is presentation only. Nothing here decides a grade, reads the
 * store, or touches the DOM.
 */

import { formatTileForDisplay } from './display';
import type { GameState } from './types/game';
import type { BookGrade, DualGrade } from './types/verdict';
import {
  acceptedAlternativeNote,
  formatAcceptedTiles,
  mortalRecommendationLabel,
  outcomeHeadline,
} from './types/verdict';

/**
 * The book's answer as one line, naming every accepted tile.
 *
 * A shape lesson accepts two interchangeable discards ("discard 5p or 3p"), so
 * the response never hides the half the player did not pick; a one-tile answer
 * reads exactly as before.
 */
export function describeBookAnswer(
  state: GameState,
  book: BookGrade | null,
): string {
  const accepted = formatAcceptedTiles(book);
  switch (state.correct_action.type) {
    case 'riichi':
      return `Riichi · discard ${accepted}`;
    case 'dama':
      // The ryanmen lesson asks which tile to discard; calling it "Dama" would
      // mislabel a tile-efficiency drill as a Riichi-vs-dama decision. The
      // push/fold lesson uses the dama carrier for a hand that is not ready at
      // all, so it names the decision instead.
      if (state.target_action === 'NaniKiru') {
        return `Discard ${accepted}`;
      }
      if (state.target_action === 'Push') {
        return `Push · discard ${accepted}`;
      }
      return `Dama · discard ${accepted}`;
    case 'fold':
      return `Fold · discard ${accepted}`;
    case 'kan':
      // Covers both Kan lessons: an Added Kan on a Pon and a concealed quad.
      return `Kan on ${accepted}`;
    case 'discard':
      return `No Kan · discard ${accepted}`;
    case 'pass': {
      const offer = state.call_offer;
      // The open-quad lesson declines a Kan, not a Pon/Chi: name what is kept.
      if (offer?.action === 'Kan') {
        return `Pass · keep the three ${formatTileForDisplay(offer.tile)}`;
      }
      return `Pass on ${offer?.label ?? 'the call'}`;
    }
    case 'best':
      return state.correct_action.label;
  }
}

/**
 * The book's answer in the answer-summary's short vocabulary.
 *
 * `AnswerSummary` names the action family explicitly ("Riichi, discarding 9m")
 * because its detail line sits under the headline; the full panel's
 * `describeBookAnswer` uses the interpunct form. Both are shared so each surface
 * has one source.
 */
export function answerBookPick(grade: DualGrade): string {
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

/** The answer summary's one-line explanation of the outcome. */
export function answerDetailLine(grade: DualGrade): string {
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
      return `The book says ${answerBookPick(grade)}.`;
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

/**
 * The 3D result card's one line: the book answer against Mortal's choice
 * (`3d_hud.md` §2, rows 37 and 39). Empty when neither perspective has a pick.
 */
export function verdictPicksLine(state: GameState, grade: DualGrade): string {
  const book = grade.book ? describeBookAnswer(state, grade.book) : null;
  const mortal = grade.mortal ? mortalRecommendationLabel(grade.mortal) : null;
  if (book && mortal) return `Book: ${book} · Mortal: ${mortal}`;
  if (book) return `Book: ${book}`;
  if (mortal) return `Mortal: ${mortal}`;
  return '';
}

/**
 * The result's live-region announcement (3D-H5).
 *
 * The HUD owns one persistent `role="status"` node, so this sentence is set
 * when the answer lands and never re-set while the same grade is on screen:
 * opening and closing the verdict sheet cannot re-announce it.
 */
export function answerAnnouncement(grade: DualGrade): string {
  return `Result: ${outcomeHeadline(grade.outcome, grade.mode)}. ${answerDetailLine(grade)}`;
}
