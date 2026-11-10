/**
 * TypeScript mirror of the `GameState` payload serialized by the Rust/WASM
 * engine (`src/state.rs`). Keep this in sync with the Rust structs.
 */

export type Wind = 'East' | 'South' | 'West' | 'North';

export type MeldType = 'Chi' | 'Pon' | 'Kan' | 'Ankan';

export type TargetAction = 'Riichi' | 'Dama' | 'Push' | 'Fold' | 'NaniKiru';

/** Action kinds the trainer can expect. */
export type CorrectActionType = 'discard';

/** The expected answer for the current scenario. */
export interface CorrectAction {
  type: CorrectActionType;
  /** Tile code the player should discard. */
  tile: string;
}

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
  discards: DiscardTile[];
  melds: CalledMeld[];
  is_riichi: boolean;
  riichi_discard_index: number | null;
}

export interface GameState {
  category: string;
  target_action: TargetAction;
  correct_action: CorrectAction;

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
