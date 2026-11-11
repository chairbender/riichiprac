/**
 * TypeScript mirror of the dual verdict in `src/verdict.rs`.
 *
 * The book heuristic and the Mortal policy each grade the answer; `outcome` is
 * the single label the UI renders. Only `neither_agrees` may be called wrong.
 */

import { formatTileForDisplay } from '../display';

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
  expected_action:
    | 'riichi'
    | 'dama'
    | 'fold'
    | 'kan'
    | 'discard'
    | 'pass'
    | 'call'
    | 'best';
  expected_tile: string;
  /**
   * Every tile the book accepts, canonical first.
   *
   * A shape lesson accepts two interchangeable tiles (either side of a
   * closed-wait protorun); a one-tile answer carries just its own tile. Empty
   * or absent for a tile-less answer (pass/call) and on older payloads.
   */
  expected_tiles?: string[];
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

/**
 * Every tile the book accepts, canonical first.
 *
 * A new grade carries the full set in `expected_tiles`, so a scenario with two
 * tied discards lists both whichever one the player picked. An older payload
 * (or a one-tile answer) carries only `expected_tile`; that tile is prepended
 * so the set is never missing the canonical answer.
 */
export function bookAcceptedTiles(book: BookGrade | null): string[] {
  if (!book) return [];
  const accepted = [...(book.expected_tiles ?? [])];
  if (book.expected_tile && !accepted.includes(book.expected_tile)) {
    accepted.unshift(book.expected_tile);
  }
  return accepted;
}

/**
 * The accepted tiles as player-facing text: `5p`, `5p or 3p`, or
 * `5p, 3p, or 1p`. Empty when the answer names no tile.
 */
export function formatAcceptedTiles(book: BookGrade | null): string {
  const tiles = bookAcceptedTiles(book).map((tile) =>
    formatTileForDisplay(tile),
  );
  if (tiles.length <= 1) return tiles[0] ?? '';
  if (tiles.length === 2) return `${tiles[0]} or ${tiles[1]}`;
  return `${tiles.slice(0, -1).join(', ')}, or ${tiles[tiles.length - 1]}`;
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
    return `Riichi · discard ${formatTileForDisplay(
      grade.recommended_discard,
    )}`;
  }
  return grade.recommended_label || grade.recommended_action;
}
