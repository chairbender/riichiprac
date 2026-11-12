/** Scenario IDs understood by the WASM `generate_puzzle` dispatcher. */
export type ScenarioId = string;

export type ScenarioSelection = 'all' | ScenarioId;

export type ScenarioGrading = 'book_and_mortal' | 'mortal_only';

export interface ScenarioOption {
  id: ScenarioId;
  label: string;
  description: string;
  category: string;
  tags: string[];
  /** True when generation needs the loaded Mortal evaluator. */
  requires_ai: boolean;
  /** Which perspectives grade this lesson. */
  grading: ScenarioGrading;
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
    requires_ai: false,
    grading: 'book_and_mortal',
  },
];

/** Parse the JSON catalogue returned by the WASM `list_scenarios()` export. */
export function parseScenarioManifest(json: string): ScenarioOption[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((entry): entry is ScenarioOption => {
        if (typeof entry !== 'object' || entry === null) return false;
        const candidate = entry as Partial<ScenarioOption>;
        return (
          typeof candidate.id === 'string' &&
          typeof candidate.label === 'string' &&
          typeof candidate.description === 'string' &&
          typeof candidate.category === 'string' &&
          Array.isArray(candidate.tags) &&
          candidate.tags.every((tag) => typeof tag === 'string') &&
          (candidate.requires_ai === undefined ||
            typeof candidate.requires_ai === 'boolean') &&
          (candidate.grading === undefined ||
            candidate.grading === 'book_and_mortal' ||
            candidate.grading === 'mortal_only')
        );
      })
      .map((scenario) => ({
        ...scenario,
        requires_ai: scenario.requires_ai ?? false,
        grading: scenario.grading ?? 'book_and_mortal',
      }));
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

/**
 * Pick one real scenario at random for the "All scenarios" option.
 *
 * AI-backed lessons are excluded until the model is ready so a first launch
 * does not block on the weights; once it is, the pool is the whole catalogue,
 * Mortal-only drills included. A drill has no book answer, so the
 * "Mortal must agree" filter is not applied to it — `loadPuzzle` routes it to
 * the evaluator instead. The verdict panel renders it as a single-perspective
 * drill rather than pretending a book perspective exists.
 */
export function pickRandomScenario(
  scenarios: ScenarioOption[] = FALLBACK_SCENARIOS,
  includeRequiresAi = true,
): ScenarioId {
  const pool = (scenarios.length > 0 ? scenarios : FALLBACK_SCENARIOS).filter(
    (scenario) => includeRequiresAi || !scenario.requires_ai,
  );
  const finalPool = pool.length > 0 ? pool : FALLBACK_SCENARIOS;
  return finalPool[Math.floor(Math.random() * finalPool.length)].id;
}
