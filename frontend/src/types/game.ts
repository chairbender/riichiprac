/**
 * TypeScript mirror of the `GameState` payload serialized by the Rust/WASM
 * engine (`src/state.rs`). Keep this in sync with the Rust structs.
 */

import type { AiDecision } from './ai';

export type Wind = 'East' | 'South' | 'West' | 'North';

export type MeldType = 'Chi' | 'Pon' | 'Kan' | 'Ankan';

export type TargetAction =
  | 'Riichi'
  | 'Dama'
  | 'Push'
  | 'Fold'
  | 'NaniKiru'
  | 'Kan'
  | 'Best'
  | 'Defend';

/** Reasons a scenario recommends declaring Riichi. */
export type RiichiTrigger =
  | 'dealer'
  | 'has_extra_han'
  | 'good_wait'
  | 'three_live_winning_tiles'
  | 'honor_terminal_wait'
  | 'tanyao'
  | 'red_five_wait'
  | 'suji_trap'
  | 'immediate_suji_trap'
  | 'wait_outside_456'
  | 'score_below_mangan';

/** Reasons a scenario recommends staying in dama. */
export type DamaReason =
  | 'not_dealer'
  | 'bad_wait'
  | 'no_extra_han'
  | 'few_live_winning_tiles'
  | 'genbutsu_wait'
  | 'no_tanyao'
  | 'middle_wait'
  | 'no_red_five_wait'
  | 'no_suji_trap'
  | 'mangan';

/** Reasons a scenario recommends upgrading an open Pon to an Added Kan. */
export type ShouminkanTrigger =
  | 'good_wait_and_value'
  | 'late_game'
  | 'placement_desperation'
  | 'losing_badly'
  | 'needs_dora';

/** Action kinds the trainer can expect alongside the discard. */
export type CorrectActionType =
  | 'riichi'
  | 'dama'
  | 'fold'
  | 'kan'
  | 'discard'
  | 'best';

/**
 * The expected answer for the current scenario.
 *
 * Riichi/dama/fold puzzles carry the discard in `discard`; `fold` is the
 * pure-defense "safest discard" answer, where no declaration is expected. Kan
 * puzzles carry the tile in `tile`, where `"kan"` means add the fourth tile to
 * an open Pon and `"discard"` means pass on the Kan and discard normally. AI
 * scenarios use `best` with the model's Mortal action name.
 */
export type CorrectAction =
  | { type: 'riichi' | 'dama' | 'fold'; discard: string }
  | { type: 'kan' | 'discard'; tile: string }
  | {
      type: 'best';
      action: string;
      label: string;
      tile?: string | null;
      tiles?: string[];
    };

/** What kind of decision the state presents. */
export type DecisionContext =
  | { kind: 'self_turn' }
  | { kind: 'react_to_discard'; from: number; tile: string }
  | { kind: 'react_to_kan'; from: number; tile: string };

/** A Riichi Book 1 reference for one rule. */
export interface BookCitation {
  book: string;
  chapter: number;
  chapter_title: string;
  section: string;
  source_file: string;
  source_line: number;
  /** Verbatim substring used by the Rust source-drift test. */
  source_needle: string;
}

/** Short provenance label for a citation chip. */
export function citationLabel(citation: BookCitation): string {
  return `ch${citation.chapter} · ${citation.section}`;
}

/** One rule the book states for this answer. */
export interface BookRule {
  /** Trigger id, e.g. `dealer` or `good_wait_and_value`. */
  id: string;
  rule: string;
  quote: string;
  citation: BookCitation;
  /** Why this hand satisfies the rule. */
  applies: string;
}

/** A Riichi justification that does not hold for this hand. */
export interface AbsentBookRule {
  id: string;
  note: string;
}

/** The book's side of the verdict, rendered from the trigger lists. */
export interface BookRationale {
  summary: string;
  rules: BookRule[];
  absent?: AbsentBookRule[];
  source: BookCitation;
  caveats?: string[];
}

export interface DiscardTile {
  /** Tile code such as "1m", "5p", or "7z". */
  tile: string;
  /** True when this discard was the Riichi declaration tile. */
  is_riichi: boolean;
  /** True when the tile was discarded straight off the draw. */
  is_tsumogiri: boolean;
  /** True when this was the red five of its suit (defaults to false). */
  is_red?: boolean;
}

export interface CalledMeld {
  meld_type: MeldType;
  tiles: string[];
  called_from: number | null;
}

export interface PlayerState {
  /** 0 = human, 1 = shimocha (right), 2 = toimen (across), 3 = kamicha (left). */
  seat: number;
  name: string;
  is_human: boolean;
  wind: Wind;
  score: number;
  /** Concealed tiles; the active draw is separate. */
  hand: string[];
  draw: string | null;
  /** Tile codes in the hand/draw that are red fives. */
  red_fives: string[];
  discards: DiscardTile[];
  melds: CalledMeld[];
  is_riichi: boolean;
  riichi_discard_index: number | null;
}

export interface GameState {
  category: string;
  target_action: TargetAction;
  correct_action: CorrectAction;
  /**
   * Tiles graded as the same answer as `correct_action`.
   *
   * A shape lesson can have two interchangeable tiles (either tile of a
   * closed-wait protorun is the same discard); the engine names the drawn one
   * and lists its twin here. Empty or absent for one-tile answers.
   */
  equivalent_tiles?: string[];
  /** What kind of decision this state presents. */
  decision: DecisionContext;
  /**
   * One-line situation note a lesson needs on screen before the answer, such
   * as a planned Pon that is not visible on the table. It never names the
   * answer tile.
   */
  scenario_note?: string | null;
  /** Model-derived answer and full ranking for AI scenarios. */
  ai_decision?: AiDecision | null;
  /** Heuristics that justify Riichi for this scenario. */
  riichi_triggers: RiichiTrigger[];
  /** Conditions that justify staying in dama for this scenario. */
  dama_reasons: DamaReason[];
  /** Heuristics that justify declaring an Added Kan for this scenario. */
  shouminkan_triggers: ShouminkanTrigger[];
  /**
   * Book-side rationale: the rule, quote, and citation for each trigger, plus
   * the justifications that do not apply. Derived and recomputed by Rust.
   */
  book_rationale?: BookRationale | null;
  /**
   * Whether the human may declare Riichi right now. Derived by Rust from the
   * same legal-action source the Mortal mask uses, so an open hand, an
   * already-declared Riichi, or a non-tenpai hand cannot offer the toggle.
   * Absent only on old payloads that predate the field.
   */
  can_riichi?: boolean;

  hand_string: string;
  tiles: string[];
  shanten: number;
  is_agari: boolean;
  decompositions_count: number;
  ukeire_tiles: string[];
  ukeire_total: number;

  round_wind: Wind;
  hand_number: number;
  honba: number;
  riichi_sticks: number;
  dora_indicators: string[];
  ura_dora_indicators: string[];
  tiles_remaining: number;

  current_turn: number;
  players: PlayerState[];
}
