/**
 * TypeScript mirror of the JSON returned by `WasmMortalEvaluator::evaluate`
 * (see `src/ai/wasm_bridge.rs`). Keep in sync with the Rust structs.
 */

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

export interface AiActionEvaluation {
  /** Machine-readable name, e.g. `Discard_3m` or `Riichi`. */
  action: string;
  type: AiActionType;
  /** Tile kind (0..34) for tile actions, `null` for call/riichi actions. */
  tile_index: number | null;
  /** Softmax probability over the legal actions. */
  probability: number;
}

export interface AiEvaluation {
  /** Mortal's expected-value output for the position. */
  expected_value: number;
  /** Highest-probability action name. */
  recommended_action: string;
  /** Legal actions, highest probability first. */
  evaluations: AiActionEvaluation[];
}

/** True once the model finished loading. */
export type AiStatus = 'idle' | 'loading' | 'ready' | 'error';

const SUIT_BY_BLOCK = ['m', 'p', 's'] as const;

/**
 * Converts Mortal's 0..34 tile index back to a trainer tile code
 * (`1m`..`9m`, `1p`..`9p`, `1s`..`9s`, `1z`..`7z`).
 */
export function tileCodeFromIndex(index: number | null): string | null {
  if (index === null || index < 0 || index >= 34) return null;
  if (index < 27) {
    return `${(index % 9) + 1}${SUIT_BY_BLOCK[Math.floor(index / 9)]}`;
  }
  return `${index - 26}z`;
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
    const tile = tileCodeFromIndex(action.tile_index);
    if (!tile) continue;
    probabilities.set(tile, (probabilities.get(tile) ?? 0) + action.probability);
  }
  return probabilities;
}
