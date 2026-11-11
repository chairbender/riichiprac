/**
 * TypeScript mirror of the dual verdict in `src/verdict.rs`.
 *
 * The book heuristic and the Mortal policy each grade the answer; `outcome` is
 * the single label the UI renders. Only `neither_agrees` may be called wrong.
 */

export type AnswerOutcome =
  | 'both_agree'
  | 'book_agrees_mortal_does_not'
  | 'mortal_agrees_book_does_not'
  | 'neither_agrees'
  | 'only_available_agrees'
  | 'only_available_disagrees'
  | 'ungraded';

export type GradingMode =
  | 'book_and_mortal'
  | 'book_only'
  | 'mortal_only'
  | 'ungraded';

export type MortalConfidence = 'high' | 'medium' | 'low' | 'unknown';

export type BookGrade = {
  is_action_correct: boolean;
  is_tile_correct: boolean;
  expected_action: 'riichi' | 'dama' | 'fold' | 'kan' | 'discard' | 'best';
  expected_tile: string;
};

export interface MortalGrade {
  /** Exact model identity, e.g. `mortal_298k.safetensors`. */
  model: string;
  /** Raw argmax action name, including a red-five suffix. */
  recommended_action: string;
  /** Red-five-normalized argmax. */
  recommended_base: string;
  /** Human-readable label for the recommendation. */
  recommended_label: string;
  /** True when Mortal's top action is a Riichi declaration. */
  recommended_riichi: boolean;
  /** The discard Mortal declares Riichi on, when the second pass resolved it. */
  recommended_discard?: string | null;
  /** The submitted answer expressed in Mortal's action vocabulary. */
  answer_action: string;
  matches_action: boolean;
  matches_tile: boolean;
  /** True only when the answer is the model's top action. */
  agrees: boolean;
  answer_probability: number;
  top_probability: number;
  confidence: MortalConfidence;
  /** Rejected answer is within a few points of the top; display only. */
  close_second: boolean;
}

export interface DualGrade {
  mode: GradingMode;
  /** Absent for a Mortal drill, which has no book rule. */
  book: BookGrade | null;
  /** Absent when no evaluation exists for a book lesson. */
  mortal: MortalGrade | null;
  outcome: AnswerOutcome;
}

/** True only when both perspectives reject the answer. */
export function outcomeIsWrong(outcome: AnswerOutcome): boolean {
  return outcome === 'neither_agrees';
}

/** Coarse tone used for the toast and the outcome chip. */
export function outcomeTone(
  outcome: AnswerOutcome,
): 'correct' | 'contested' | 'incorrect' | 'neutral' {
  switch (outcome) {
    case 'both_agree':
      return 'correct';
    case 'book_agrees_mortal_does_not':
    case 'mortal_agrees_book_does_not':
      return 'contested';
    case 'neither_agrees':
      return 'incorrect';
    case 'only_available_agrees':
      return 'correct';
    case 'only_available_disagrees':
    case 'ungraded':
      return 'neutral';
  }
}

/**
 * Chip and toast headline for each outcome, in the shared vocabulary.
 *
 * A single-perspective result never says "Correct": it names the perspective
 * that agreed, so the missing one is not silently implied.
 */
export function outcomeHeadline(
  outcome: AnswerOutcome,
  mode?: GradingMode,
): string {
  switch (outcome) {
    case 'both_agree':
      return 'Correct';
    case 'book_agrees_mortal_does_not':
      return 'Book answer';
    case 'mortal_agrees_book_does_not':
      return "Mortal's line";
    case 'neither_agrees':
      return 'Incorrect';
    case 'only_available_agrees':
      return mode === 'mortal_only' ? 'Matches Mortal' : 'Book answer';
    case 'only_available_disagrees':
      return mode === 'mortal_only' ? 'Off Mortal’s line' : 'Not the book’s line';
    case 'ungraded':
      return 'Not graded yet';
  }
}

/** Short chip label, used above the outcome sentence. */
export function outcomeChip(outcome: AnswerOutcome): string {
  switch (outcome) {
    case 'both_agree':
      return 'Both agree';
    case 'book_agrees_mortal_does_not':
      return 'Book answer';
    case 'mortal_agrees_book_does_not':
      return "Mortal's line";
    case 'neither_agrees':
      return 'Off both lines';
    case 'only_available_agrees':
      return 'Book answer';
    case 'only_available_disagrees':
      return 'Not the book’s line';
    case 'ungraded':
      return 'Not graded';
  }
}

/** Whether a Mortal recommendation carries a discard tile. */
export function mortalRecommendedTile(
  grade: MortalGrade | null,
): string | null {
  if (!grade) return null;
  if (grade.recommended_riichi) {
    return grade.recommended_discard ?? null;
  }
  const action = grade.recommended_action;
  if (!action.startsWith('Discard_')) return null;
  const tile = action.slice('Discard_'.length);
  return tile.endsWith('r') ? tile.slice(0, -1) : tile;
}

/** Whether a Mortal recommendation is a Riichi declaration. */
export function mortalRecommendedRiichi(grade: MortalGrade | null): boolean {
  return grade?.recommended_riichi === true;
}

/**
 * One-line label for Mortal's recommendation, including the discard it would
 * declare Riichi on. Falls back to the evaluator's label when the tile is
 * unknown (an old payload, or a first pass without the second pass).
 */
export function mortalRecommendationLabel(grade: MortalGrade | null): string {
  if (!grade) return 'another action';
  if (grade.recommended_riichi && grade.recommended_discard) {
    return `Riichi · discard ${grade.recommended_discard}`;
  }
  return grade.recommended_label || grade.recommended_action;
}
