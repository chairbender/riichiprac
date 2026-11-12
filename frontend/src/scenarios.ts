/** Scenario IDs understood by the WASM `generate_puzzle` dispatcher. */
export type ScenarioId = string;

/**
 * The book section a lesson teaches, as published by the Rust
 * `list_scenarios()` manifest. `key` is the stable grouping key (`ch8.4`) and
 * `label` is the ready-made display label used by the picker.
 */
export interface BookSection {
  chapter: number;
  chapter_title: string;
  section: number;
  section_title: string;
  key: string;
  label: string;
}

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
  /** The book section this lesson teaches; null for lessons with no book tie. */
  book: BookSection | null;
}

/**
 * What the next hand is drawn from.
 *
 * `all` keeps the catalogue-wide behaviour: the whole manifest, minus AI drills
 * until the model is ready. `selected` is taken literally because the user
 * picked those lessons by name.
 */
export type ScenarioSelection =
  | { kind: 'all' }
  | { kind: 'selected'; ids: ScenarioId[] };

export const ALL_SCENARIOS: ScenarioSelection = { kind: 'all' };

/** A picker section: one chapter/section of the book, or the ungrouped bucket. */
export interface ScenarioGroup {
  key: string;
  label: string;
  /** Sort order: chapter then section. `Infinity` for the ungrouped bucket. */
  chapter: number;
  section: number;
  scenarios: ScenarioOption[];
}

/** Key and label of the bucket for lessons with no book section. */
export const UNGROUPED_GROUP_KEY = 'ungrouped';
export const UNGROUPED_GROUP_LABEL = 'Other';

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
    book: {
      chapter: 4,
      chapter_title: 'The five-block method',
      section: 1,
      section_title: 'Finding a redundant tile',
      key: 'ch4.1',
      label: 'ch4.1 · Finding a redundant tile',
    },
  },
];

function isBookSection(value: unknown): value is BookSection {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<BookSection>;
  return (
    typeof candidate.chapter === 'number' &&
    typeof candidate.chapter_title === 'string' &&
    typeof candidate.section === 'number' &&
    typeof candidate.section_title === 'string' &&
    typeof candidate.key === 'string' &&
    typeof candidate.label === 'string'
  );
}

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
            candidate.grading === 'mortal_only') &&
          (candidate.book === undefined ||
            candidate.book === null ||
            isBookSection(candidate.book))
        );
      })
      .map((scenario) => ({
        ...scenario,
        requires_ai: scenario.requires_ai ?? false,
        grading: scenario.grading ?? 'book_and_mortal',
        book: scenario.book ?? null,
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
 * Group the catalogue by book chapter/section, in book order, with the lessons
 * that have no book tie last under "Other".
 */
export function groupScenarios(
  scenarios: ScenarioOption[] = FALLBACK_SCENARIOS,
): ScenarioGroup[] {
  const groups = new Map<string, ScenarioGroup>();
  const ungrouped: ScenarioOption[] = [];

  for (const scenario of scenarios) {
    const book = scenario.book;
    if (!book) {
      ungrouped.push(scenario);
      continue;
    }

    const existing = groups.get(book.key);
    if (existing) {
      existing.scenarios.push(scenario);
      continue;
    }

    groups.set(book.key, {
      key: book.key,
      label: book.label,
      chapter: book.chapter,
      section: book.section,
      scenarios: [scenario],
    });
  }

  const ordered = [...groups.values()].sort(
    (a, b) => a.chapter - b.chapter || a.section - b.section,
  );

  if (ungrouped.length > 0) {
    ordered.push({
      key: UNGROUPED_GROUP_KEY,
      label: UNGROUPED_GROUP_LABEL,
      chapter: Number.POSITIVE_INFINITY,
      section: 0,
      scenarios: ungrouped,
    });
  }

  return ordered;
}

/** Every catalogue id, in manifest order. */
export function allScenarioIds(
  scenarios: ScenarioOption[] = FALLBACK_SCENARIOS,
): ScenarioId[] {
  return scenarios.map((scenario) => scenario.id);
}

/** The ids a selection currently holds, expanded for the `all` mode. */
export function selectedScenarioIds(
  selection: ScenarioSelection,
  scenarios: ScenarioOption[] = FALLBACK_SCENARIOS,
): ScenarioId[] {
  return selection.kind === 'all' ? allScenarioIds(scenarios) : selection.ids;
}

/**
 * The scenarios a selection may draw from.
 *
 * In `all` mode AI drills stay out until the model is ready, so a first launch
 * does not block on the weights. A subset is honoured as picked, and an empty
 * or stale subset falls back to the catalogue rather than dealing nothing.
 */
export function selectionPool(
  scenarios: ScenarioOption[] = FALLBACK_SCENARIOS,
  selection: ScenarioSelection = ALL_SCENARIOS,
  includeRequiresAi = true,
): ScenarioOption[] {
  const catalogue = scenarios.length > 0 ? scenarios : FALLBACK_SCENARIOS;

  if (selection.kind === 'all') {
    const pool = catalogue.filter(
      (scenario) => includeRequiresAi || !scenario.requires_ai,
    );
    return pool.length > 0 ? pool : FALLBACK_SCENARIOS;
  }

  const chosen = new Set(selection.ids);
  const pool = catalogue.filter((scenario) => chosen.has(scenario.id));
  return pool.length > 0
    ? pool
    : selectionPool(catalogue, ALL_SCENARIOS, includeRequiresAi);
}

/** One-line description of the committed pool for the picker trigger. */
export function selectionLabel(
  selection: ScenarioSelection,
  scenarios: ScenarioOption[] = FALLBACK_SCENARIOS,
): string {
  if (selection.kind === 'all') return 'All scenarios (random)';
  if (selection.ids.length === 0) return 'No scenarios selected';
  if (selection.ids.length === 1) {
    return scenarioLabel(selection.ids[0], scenarios);
  }
  return `${selection.ids.length} scenarios (random)`;
}

/** Add or remove one scenario from a selection. */
export function toggleScenario(
  scenarios: ScenarioOption[],
  selection: ScenarioSelection,
  id: ScenarioId,
): ScenarioSelection {
  const ids = new Set(selectedScenarioIds(selection, scenarios));
  if (ids.has(id)) {
    ids.delete(id);
  } else {
    ids.add(id);
  }
  return {
    kind: 'selected',
    ids: allScenarioIds(scenarios).filter((scenarioId) => ids.has(scenarioId)),
  };
}

/** Select or clear every scenario in a group. */
export function setScenariosSelected(
  scenarios: ScenarioOption[],
  selection: ScenarioSelection,
  ids: ScenarioId[],
  selected: boolean,
): ScenarioSelection {
  const chosen = new Set(selectedScenarioIds(selection, scenarios));
  for (const id of ids) {
    if (selected) {
      chosen.add(id);
    } else {
      chosen.delete(id);
    }
  }
  return {
    kind: 'selected',
    ids: allScenarioIds(scenarios).filter((scenarioId) =>
      chosen.has(scenarioId),
    ),
  };
}

/**
 * Pick one real scenario at random from a selection's pool.
 *
 * A drill has no book answer, so the "Mortal must agree" filter is not applied
 * to it — `loadPuzzle` routes it to the evaluator instead. The verdict panel
 * renders it as a single-perspective drill rather than pretending a book
 * perspective exists.
 */
export function pickRandomScenarioFrom(
  scenarios: ScenarioOption[] = FALLBACK_SCENARIOS,
  selection: ScenarioSelection = ALL_SCENARIOS,
  includeRequiresAi = true,
): ScenarioId {
  const pool = selectionPool(scenarios, selection, includeRequiresAi);
  return pool[Math.floor(Math.random() * pool.length)].id;
}

/** Pick one scenario at random from the whole catalogue. */
export function pickRandomScenario(
  scenarios: ScenarioOption[] = FALLBACK_SCENARIOS,
  includeRequiresAi = true,
): ScenarioId {
  return pickRandomScenarioFrom(scenarios, ALL_SCENARIOS, includeRequiresAi);
}
