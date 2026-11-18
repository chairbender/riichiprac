import type { PackManifest, PackManifestEntry } from './services/packLoader';

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

/**
 * Where a replay-pack picker entry comes from.
 *
 * The manifest only lists lesson ids and pack-level metadata (there are no
 * per-lesson titles until a body is loaded), so the entry is merged onto the
 * WASM lesson with the same id: its label, description, book section and
 * grading annotate the replay entry. A lesson that is not in the WASM
 * catalogue still gets an entry, with the id humanised and no book section.
 */
export interface PackLessonSource {
  /** Published pack id, for the badge tooltip and the body lookup. */
  packId: string;
  /** The lesson id the pack body uses (`PackScenario.lesson_id`). */
  lessonId: string;
  /** Scenarios in the whole pack; the per-lesson count is only known after load. */
  packScenarioCount: number;
  licence: string;
  requiresModel: boolean;
  /** Book section keys the pack declares, for the merged-book fallback. */
  bookSections: string[];
}

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
  /**
   * Present when this picker entry deals a real hand from a published pack
   * instead of generating one. Pack entries are opt-in: they are not part of
   * the `all` pool, so the only bytes a first launch fetches are the manifest.
   */
  pack?: PackLessonSource | null;
}

/** Namespace that keeps a replay entry from colliding with the generated lesson. */
export const PACK_SCENARIO_PREFIX = 'replay:';

/** Stable picker/selection id for one lesson inside one pack. */
export function packScenarioId(packId: string, lessonId: string): string {
  return `${PACK_SCENARIO_PREFIX}${packId}:${lessonId}`;
}

/** True for an id minted by {@link packScenarioId}. */
export function isPackScenarioId(id: string): boolean {
  return id.startsWith(PACK_SCENARIO_PREFIX);
}

/** Split a pack entry id back into its pack and lesson, or null if malformed. */
export function parsePackScenarioId(
  id: string,
): { packId: string; lessonId: string } | null {
  if (!isPackScenarioId(id)) return null;
  const rest = id.slice(PACK_SCENARIO_PREFIX.length);
  const split = rest.indexOf(':');
  if (split <= 0 || split === rest.length - 1) return null;
  return {
    packId: rest.slice(0, split),
    lessonId: rest.slice(split + 1),
  };
}

/**
 * What the next hand is drawn from.
 *
 * `all` keeps the catalogue-wide behaviour: the generated manifest, minus AI
 * drills until the model is ready and minus replay-pack lessons (those are
 * opt-in so startup fetches only the pack manifest). `selected` is taken
 * literally because the user picked those lessons by name, replay packs
 * included.
 */
export type ScenarioSelection =
  | { kind: 'all' }
  | { kind: 'selected'; ids: ScenarioId[] };

export const ALL_SCENARIOS: ScenarioSelection = { kind: 'all' };

/** A picker section: one chapter/section of the book, or the ungrouped bucket. */
export interface ScenarioGroup {
  key: string;
  label: string;
  /** Sort order: chapter then section. `-1` sorts the ungrouped bucket first. */
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
 * that have no book tie first under "Other".
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
    ordered.unshift({
      key: UNGROUPED_GROUP_KEY,
      label: UNGROUPED_GROUP_LABEL,
      chapter: -1,
      section: 0,
      scenarios: ungrouped,
    });
  }

  return ordered;
}

/** Every id the "All scenarios" pool covers, in manifest order. */
export function allScenarioIds(
  scenarios: ScenarioOption[] = FALLBACK_SCENARIOS,
): ScenarioId[] {
  return scenarios.filter((scenario) => !scenario.pack).map((scenario) => scenario.id);
}

/**
 * Add one picker entry per replay lesson published by the manifest.
 *
 * The id is namespaced (`replay:<pack>:<lesson>`) so the generated lesson and
 * the replay hand can be selected independently. Metadata is merged from the
 * WASM entry with the same lesson id; a lesson the app does not know still gets
 * an entry, falling back to the pack's sole book section when it declares one.
 * Merging is idempotent: an existing pack entry is dropped before rebuilding,
 * so calling it on every render cannot duplicate rows.
 */
export function mergePackLessons(
  scenarios: ScenarioOption[],
  manifest: PackManifest | null,
): ScenarioOption[] {
  const generated = scenarios.filter((scenario) => !scenario.pack);
  if (!manifest || manifest.packs.length === 0) return generated;

  const byId = new Map(generated.map((scenario) => [scenario.id, scenario]));
  const sectionsByKey = new Map<string, BookSection>();
  for (const option of generated) {
    if (option.book) sectionsByKey.set(option.book.key, option.book);
  }

  const afterLesson = new Map<string, ScenarioOption[]>();
  const orphaned: ScenarioOption[] = [];

  for (const entry of manifest.packs) {
    for (const lessonId of entry.lesson_ids) {
      const base = byId.get(lessonId) ?? null;
      const option = replayOption(entry, lessonId, base, sectionsByKey);
      if (base) {
        const list = afterLesson.get(base.id);
        if (list) {
          list.push(option);
        } else {
          afterLesson.set(base.id, [option]);
        }
      } else {
        orphaned.push(option);
      }
    }
  }

  const merged: ScenarioOption[] = [];
  for (const option of generated) {
    merged.push(option);
    const replay = afterLesson.get(option.id);
    if (replay) merged.push(...replay);
  }
  merged.push(...orphaned);
  return merged;
}

function replayOption(
  entry: PackManifestEntry,
  lessonId: string,
  base: ScenarioOption | null,
  sectionsByKey: Map<string, BookSection>,
): ScenarioOption {
  const book = base?.book ?? soleBookSection(entry, sectionsByKey);
  return {
    id: packScenarioId(entry.id, lessonId),
    // The suffix keeps the generated and replay rows distinguishable in a
    // section list; the badge repeats it. Neither names the answer.
    label: base ? `${base.label} (replay)` : humanizeLessonId(lessonId),
    description: base
      ? `A real audited ${base.label} position from replay pack ${entry.id}.`
      : `A real audited position from replay pack ${entry.id}.`,
    category: base?.category ?? lessonId,
    tags: [...new Set([...(base?.tags ?? []), 'replay', 'pack'])],
    // The hand is shipped in the pack, so dealing it needs no model.
    requires_ai: false,
    grading: base?.grading ?? 'book_and_mortal',
    book,
    pack: {
      packId: entry.id,
      lessonId,
      packScenarioCount: entry.scenario_count,
      licence: entry.licence,
      requiresModel: entry.requires_model,
      bookSections: entry.book_sections,
    },
  };
}

function soleBookSection(
  entry: PackManifestEntry,
  sectionsByKey: Map<string, BookSection>,
): BookSection | null {
  if (entry.book_sections.length !== 1) return null;
  return sectionsByKey.get(entry.book_sections[0]) ?? null;
}

function humanizeLessonId(lessonId: string): string {
  const words = lessonId.replace(/[_-]+/g, ' ').trim();
  if (words === '') return lessonId;
  return words.charAt(0).toUpperCase() + words.slice(1);
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
    // Replay-pack lessons are opt-in: the `all` pool is the generated
    // catalogue, so a first launch never downloads a pack body.
    const pool = catalogue.filter(
      (scenario) =>
        !scenario.pack && (includeRequiresAi || !scenario.requires_ai),
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
    ids: orderedSelectionIds(scenarios, ids),
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
    ids: orderedSelectionIds(scenarios, chosen),
  };
}

/**
 * Stable order for an explicit selection: generated lessons in manifest order,
 * then opt-in replay lessons in their merged order. Replay ids are appended
 * rather than filtered out (as `allScenarioIds` does) because the user ticked
 * one of them by name.
 */
function orderedSelectionIds(
  scenarios: ScenarioOption[],
  chosen: Set<ScenarioId>,
): ScenarioId[] {
  const generated = scenarios
    .filter((scenario) => !scenario.pack)
    .map((scenario) => scenario.id);
  const replay = scenarios
    .filter((scenario) => scenario.pack)
    .map((scenario) => scenario.id);
  return [...generated, ...replay].filter((id) => chosen.has(id));
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
