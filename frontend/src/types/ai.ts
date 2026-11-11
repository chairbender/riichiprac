/**
 * TypeScript mirror of the JSON returned by `WasmMortalEvaluator::evaluate`
 * and the model-derived payload attached to AI scenarios
 * (see `src/ai/wasm_bridge.rs` and `src/decision.rs`).
 */

import { formatTileForDisplay } from '../display';

/** Coarse action family produced by the Mortal policy head. */
export type AiActionType =
  | 'discard'
  | 'riichi'
  | 'chi'
  | 'pon'
  | 'kan'
  | 'agari'
  | 'ryukyoku'
  | 'pass';

/** Which shape of kan a `kan` action represents. */
export type AiKanKind = 'daiminkan' | 'ankan' | 'kakan';

/** One legal action with everything needed to render and grade it. */
export interface AiActionInfo {
  /** Machine-readable name, e.g. `Discard_3m`, `Chi_Low`, or `Pon`. */
  action: string;
  /** Human-readable label, e.g. `Discard 3m` or `Chi 2m 3m on 4m`. */
  label: string;
  /** Coarse action family. */
  type: AiActionType;
  /** Tile kind (0..=33) for tile actions, absent for calls. */
  tile_index?: number | null;
  /** Base tile code for tile actions. */
  tile?: string | null;
  /** Additional tiles consumed by a call (chi). */
  tiles?: string[];
  /** Which kan shape is offered, when relevant. */
  kan_kind?: AiKanKind | null;
}

export interface AiActionEvaluation extends AiActionInfo {
  /** Softmax probability over the legal actions. */
  probability: number;
}

export interface AiEvaluation {
  /** Exact model identity, e.g. `mortal_298k.safetensors`. */
  model: string;
  /** Mortal's expected-value output for the position. */
  expected_value: number;
  /** Highest-probability action name. */
  recommended_action: string;
  /**
   * When the top action is Riichi, the discard Mortal declares on.
   *
   * Mortal's action space has one tile-less `Riichi` action, so this comes from
   * the evaluator's second pass. Absent for every other recommendation and for
   * payloads captured before the second pass existed.
   */
  riichi_discard?: string | null;
  /** Legal actions, highest probability first. */
  evaluations: AiActionEvaluation[];
}

/** Model-derived decision attached to an AI scenario payload. */
export interface AiDecision {
  model: string;
  /** Optional model-provided explanation. */
  reasoning?: string | null;
  expected_value: number;
  recommended_action: string;
  /** The discard Mortal declares Riichi on, when it chose Riichi. */
  riichi_discard?: string | null;
  evaluations: AiActionEvaluation[];
  /** Every legal action with render/grade details, no probabilities. */
  actions: AiActionInfo[];
}

/** True once the model finished loading. */
export type AiStatus = 'idle' | 'loading' | 'ready' | 'error';

const SUIT_BY_BLOCK = ['m', 'p', 's'] as const;

/**
 * Converts Mortal's 0..=33 tile index back to a trainer tile code
 * (`1m`..`9m`, `1p`..`9p`, `1s`..`9s`, `1z`..`7z`).
 */
export function tileCodeFromIndex(index: number | null | undefined): string | null {
  if (index === null || index === undefined || index < 0 || index >= 34) {
    return null;
  }
  if (index < 27) {
    return `${(index % 9) + 1}${SUIT_BY_BLOCK[Math.floor(index / 9)]}`;
  }
  return `${index - 26}z`;
}

/** Human-readable label, using the Rust-provided label when present. */
export function actionLabel(action: AiActionInfo): string {
  if (action.label) return action.label;
  if (action.type === 'discard') {
    const tile = action.tile ?? tileCodeFromIndex(action.tile_index);
    const red = action.action.endsWith('r');
    return tile
      ? `Discard ${formatTileForDisplay(tile, red)}`
      : action.action;
  }
  if (action.type === 'agari') return 'Win (agari)';
  if (action.type === 'ryukyoku') return 'Draw (ryukyoku)';
  return action.action.replace(/_/g, ' ');
}

/** Formats a probability as a whole percentage, with a floor at 1%. */
export function formatProbability(probability: number): string {
  const percent = probability * 100;
  if (percent > 0 && percent < 1) return '<1%';
  return `${Math.round(percent)}%`;
}

/**
 * Probability per tile code for discards, summing the regular and red-five
 * variants of a tile (the policy predicts them separately).
 */
export function discardProbabilitiesByTile(
  evaluation: AiEvaluation | null,
): Map<string, number> {
  const probabilities = new Map<string, number>();
  if (!evaluation) return probabilities;

  for (const action of evaluation.evaluations) {
    if (action.type !== 'discard') continue;
    const tile = action.tile ?? tileCodeFromIndex(action.tile_index);
    if (!tile) continue;
    probabilities.set(tile, (probabilities.get(tile) ?? 0) + action.probability);
  }
  return probabilities;
}
