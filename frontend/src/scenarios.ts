/** Scenario IDs understood by the WASM `generate_puzzle` dispatcher. */
export type ScenarioId = string;

export type ScenarioSelection = 'all' | ScenarioId;

export interface ScenarioOption {
  id: ScenarioId;
  label: string;
  description: string;
  category: string;
  tags: string[];
}

/**
 * Minimal fallback used only if the WASM manifest cannot be loaded. The Rust
 * `list_scenarios()` export is the source of truth for the full catalogue.
 */
export const FALLBACK_SCENARIOS: ScenarioOption[] = [
  {
    id: 'ryanmen_protorun',
    label: 'Ryanmen Protorun',
    description: 'Block theory: choose the discard that keeps the ryanmen wait.',
    category: 'tile_efficiency',
    tags: ['block_theory', 'discard', 'ryanmen'],
  },
];

/** Parse the JSON catalogue returned by the WASM `list_scenarios()` export. */
export function parseScenarioManifest(json: string): ScenarioOption[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((entry): entry is ScenarioOption => {
      if (typeof entry !== 'object' || entry === null) return false;
      const candidate = entry as Partial<ScenarioOption>;
      return (
        typeof candidate.id === 'string' &&
        typeof candidate.label === 'string' &&
        typeof candidate.description === 'string' &&
        typeof candidate.category === 'string' &&
        Array.isArray(candidate.tags) &&
        candidate.tags.every((tag) => typeof tag === 'string')
      );
    });
  } catch {
    return [];
  }
}

/** Human-readable label for a scenario ID. */
export function scenarioLabel(
  category: string,
  scenarios: ScenarioOption[] = FALLBACK_SCENARIOS,
): string {
  return scenarios.find((scenario) => scenario.id === category)?.label ?? category;
}

/** Pick one real scenario at random for the "All scenarios" option. */
export function pickRandomScenario(
  scenarios: ScenarioOption[] = FALLBACK_SCENARIOS,
): ScenarioId {
  const pool = scenarios.length > 0 ? scenarios : FALLBACK_SCENARIOS;
  return pool[Math.floor(Math.random() * pool.length)].id;
}
