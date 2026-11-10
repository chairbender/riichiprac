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
  | 'Best';

/** Reasons a scenario recommends declaring Riichi. */
export type RiichiTrigger =
  | 'dealer'
  | 'tanyao'
  | 'red_five_wait'
  | 'suji_trap'
  | 'wait_outside_456'
  | 'score_below_mangan';

/** Reasons a scenario recommends staying in dama. */
export type DamaReason =
  | 'not_dealer'
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
  | 'losing_badly';

/** Action kinds the trainer can expect alongside the discard. */
export type CorrectActionType = 'riichi' | 'dama' | 'kan' | 'discard' | 'best';

/**
 * The expected answer for the current scenario.
 *
 * Riichi/dama puzzles carry the discard in `discard`. Kan puzzles carry the
 * tile in `tile`, where `"kan"` means add the fourth tile to an open Pon and
 * `"discard"` means pass on the Kan and discard normally. AI scenarios use
 * `best` with the model's Mortal action name.
 */
export type CorrectAction =
  | { type: 'riichi' | 'dama'; discard: string }
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

export interface DiscardTile {
  /** Tile code such as "1m", "5p", or "7z". */
  tile: string;
  /** True when this discard was the Riichi declaration tile. */
  is_riichi: boolean;
  /** True when the tile was discarded straight off the draw. */
  is_tsumogiri: boolean;
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
  /** What kind of decision this state presents. */
  decision: DecisionContext;
  /** Model-derived answer and full ranking for AI scenarios. */
  ai_decision?: AiDecision | null;
  /** Heuristics that justify Riichi for this scenario. */
  riichi_triggers: RiichiTrigger[];
  /** Conditions that justify staying in dama for this scenario. */
  dama_reasons: DamaReason[];
  /** Heuristics that justify declaring an Added Kan for this scenario. */
  shouminkan_triggers: ShouminkanTrigger[];

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
