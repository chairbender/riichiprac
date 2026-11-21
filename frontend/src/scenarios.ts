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
  /**
   * Reviewed bases this pack ships for the lesson, read from the manifest's
   * `lesson_counts` without a body. Zero when the manifest predates the field,
   * which keeps the row opt-in: the replay-first floor is measured in bases.
   */
  bases: number;
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
   * instead of generating one. A covered lesson's row is the default source
   * (RF2), and the first deal of a launch may fetch its body before anything is
   * drawn (RF4); an uncovered lesson's row stays opt-in.
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

/* -------------------------------------------------------------------------- */
/* Replay-first coverage                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Reviewed replay bases a lesson needs before replay becomes its default.
 *
 * Product decision recorded in `replay-first-rollout.md` ("Proposed coverage
 * floor"): 40 reviewed bases per lesson. Variants derive from a base and add no
 * review coverage, so `lesson_counts` counts bases only. The floor is a default,
 * not a constant to hard-code at call sites: `ReplayDefaultOptions.minReplayBases`
 * lets a caller (or a test) apply a different one.
 */
export const MIN_REPLAY_BASES = 40;

/**
 * Per-lesson replay coverage read from a pack manifest.
 *
 * Coverage is metadata only: it comes from the manifest's `lesson_counts`
 * (RF1), so the app can decide a lesson's default source **without downloading
 * a body**. A manifest published before the field existed has no counts; that
 * lesson is then treated as uncovered, which keeps the generated default.
 */
export interface LessonReplayCoverage {
  /** Reviewed bases across every published pack (variants add none). */
  bases: number;
  /** Whether {@link bases} reaches the floor that was applied. */
  covered: boolean;
  /** Pack supplying the default row: the one with the most counted bases. */
  packId: string;
  /** The lesson id the pack body uses (`PackScenario.lesson_id`). */
  lessonId: string;
  /** The namespaced picker id that pack's row uses (`replay:<pack>:<lesson>`). */
  scenarioId: ScenarioId;
}

/** Inputs that decide which lessons are dealt from replay instead of WASM. */
export interface ReplayDefaultOptions {
  /** The loaded pack manifest; null/absent means generated-only. */
  manifest?: PackManifest | null;
  /** The `preferReplay` setting; false forces the generated pool. */
  preferReplay?: boolean;
  /** Coverage floor override; defaults to {@link MIN_REPLAY_BASES}. */
  minReplayBases?: number;
}

/**
 * Read per-lesson coverage out of a manifest, keyed by the generated lesson id.
 *
 * Counts are summed across packs because a later section pack can add bases to
 * an earlier lesson; the row that supplies the replay default is the pack with
 * the largest count for that lesson (manifest order breaks ties). A missing
 * manifest or an empty `packs` array yields an empty map, never a throw.
 */
export function lessonReplayCoverage(
  manifest: PackManifest | null | undefined,
  minReplayBases: number = MIN_REPLAY_BASES,
): Map<ScenarioId, LessonReplayCoverage> {
  const coverage = new Map<ScenarioId, LessonReplayCoverage>();
  if (!manifest || manifest.packs.length === 0) return coverage;

  const floor =
    Number.isFinite(minReplayBases) && minReplayBases >= 0
      ? minReplayBases
      : MIN_REPLAY_BASES;

  /** Per lesson: the running base total and the pack with the most bases. */
  const best = new Map<string, { bases: number; packId: string; packBases: number }>();

  for (const entry of manifest.packs) {
    for (const lessonId of entry.lesson_ids) {
      const bases = entry.lesson_counts?.[lessonId] ?? 0;
      const record = best.get(lessonId);
      if (!record) {
        best.set(lessonId, { bases, packId: entry.id, packBases: bases });
        continue;
      }
      record.bases += bases;
      // A tie keeps the earlier pack, so manifest order decides.
      if (bases > record.packBases) {
        record.packId = entry.id;
        record.packBases = bases;
      }
    }
  }

  for (const [lessonId, record] of best) {
    coverage.set(lessonId, {
      bases: record.bases,
      covered: record.bases >= floor,
      packId: record.packId,
      lessonId,
      scenarioId: packScenarioId(record.packId, lessonId),
    });
  }
  return coverage;
}

/**
 * The default (`all`) pool's ids under replay-first.
 *
 * For each generated lesson:
 * - covered by the manifest's `lesson_counts` **and** `preferReplay` → the
 *   replay row's namespaced id;
 * - otherwise → the generated lesson id, exactly as before the rollout.
 *
 * The pool is defined over the generated catalogue, so a pack-only lesson (a
 * pack lesson the WASM catalogue does not publish) stays out of `all` as it did
 * before the rollout: it has no generated sibling to fall back to, and the
 * picker can still deal it by name. The generated lesson is never removed from
 * the catalogue, so an explicit `selected` pool can always drill it.
 */
function replayDefaultIds(
  catalogue: ScenarioOption[],
  replay: ReplayDefaultOptions,
): ScenarioId[] {
  const generated = catalogue.filter((scenario) => !scenario.pack);
  const coverage = replayCoverageFor(replay);

  return generated.map((scenario) => {
    const covered = coverage?.get(scenario.id);
    return covered ? covered.scenarioId : scenario.id;
  });
}

/**
 * Covered lessons only, or null when replay cannot be the default at all (the
 * setting is off, or there is no manifest to read coverage from).
 */
function replayCoverageFor(
  replay: ReplayDefaultOptions,
): Map<ScenarioId, LessonReplayCoverage> | null {
  if (replay.preferReplay === false) return null;
  const manifest = replay.manifest;
  if (!manifest || manifest.packs.length === 0) return null;

  const coverage = lessonReplayCoverage(manifest, replay.minReplayBases);
  const covered = new Map<ScenarioId, LessonReplayCoverage>();
  for (const [lessonId, value] of coverage) {
    if (value.covered) covered.set(lessonId, value);
  }
  return covered;
}

/**
 * What the next hand is drawn from.
 *
 * `all` keeps the catalogue-wide behaviour: the generated manifest, minus AI
 * drills until the model is ready. With replay coverage (`ReplayDefaultOptions`)
 * a covered lesson's entry is its replay id instead of the generated one; with
 * no manifest it stays generated-only, byte-for-byte as before. `selected` is
 * taken literally because the user picked those lessons by name, replay packs
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

/**
 * Every id the default "All scenarios" pool covers, in manifest order.
 *
 * With `ReplayDefaultOptions` a lesson whose shipped pack covers it is drawn
 * from replay (the namespaced id); every other lesson keeps its generated id.
 * With no manifest, no coverage, or `preferReplay: false`, this is exactly the
 * generated catalogue as before the rollout.
 */
export function allScenarioIds(
  scenarios: ScenarioOption[] = FALLBACK_SCENARIOS,
  replay: ReplayDefaultOptions = {},
): ScenarioId[] {
  return replayDefaultIds(scenarios, replay);
}

/**
 * The replay row a launch opens with (RF4, strategy C in
 * `replay-first-rollout.md`).
 *
 * Strategy C makes the *first* deal replay-first instead of waiting for the
 * manifest to arrive and dealing generated until the next hand. It picks "a
 * default lesson among the prominent covered sections"; prominence here is
 * measured, not aesthetic: the covered lesson with the most reviewed bases
 * across the published packs (the rollout's coverage table ranks the same way),
 * with catalogue order — book order — breaking ties.
 *
 * Returns null whenever replay cannot be the first deal at all: the
 * `preferReplay` setting is off, there is no manifest, no lesson reaches the
 * coverage floor, or the covered lesson has no replay row in the merged
 * catalogue. The caller then deals the ordinary pool, so the launch always gets
 * a table.
 *
 * The covered lesson always has a generated sibling here, because the choice is
 * made over the generated catalogue: a pack-only lesson has no generated
 * fallback and is deliberately not picked for the first deal.
 */
export function firstDealReplayOption(
  scenarios: ScenarioOption[] = FALLBACK_SCENARIOS,
  replay: ReplayDefaultOptions = {},
): ScenarioOption | null {
  const covered = replayCoverageFor(replay);
  if (!covered) return null;

  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  let best: ScenarioOption | null = null;
  let bestBases = -1;

  for (const generated of scenarios) {
    if (generated.pack) continue;
    const coverage = covered.get(generated.id);
    if (!coverage) continue;
    const replayOption = byId.get(coverage.scenarioId);
    if (!replayOption?.pack) continue;
    // Strictly greater: the first lesson in book order wins a tie.
    if (coverage.bases > bestBases) {
      best = replayOption;
      bestBases = coverage.bases;
    }
  }

  return best;
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
      bases: entry.lesson_counts?.[lessonId] ?? 0,
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

/* -------------------------------------------------------------------------- */
/* Picker source filter (RF3)                                                 */
/* -------------------------------------------------------------------------- */

/** Which source a picker row would deal from. */
export type ScenarioSource = 'replay' | 'generated';

/**
 * The picker's source filter.
 *
 * `both` lists every row; `replay` lists replay rows **only** (a lesson with no
 * replay row is reachable under `generated` or `both`, never under `replay`);
 * `generated` hides every replay row. The filter changes the rows listed and,
 * through `preferReplay`, what the default pool deals for a covered lesson — it
 * never changes the generated catalogue or a lesson's drill.
 */
export type ScenarioSourceFilter = 'replay' | 'generated' | 'both';

/** The filter a session starts on: every row, replay first where covered. */
export const DEFAULT_SOURCE_FILTER: ScenarioSourceFilter = 'both';

/** The source a row deals from. A namespaced pack id is always replay. */
export function scenarioSource(option: ScenarioOption): ScenarioSource {
  return option.pack ? 'replay' : 'generated';
}

/**
 * Replay rows grouped by the lesson they teach, biggest pack first so the row
 * that supplies the replay default also leads its section.
 */
function replayRowsByLesson(
  scenarios: ScenarioOption[],
): Map<string, ScenarioOption[]> {
  const byLesson = new Map<string, ScenarioOption[]>();
  for (const option of scenarios) {
    if (!option.pack) continue;
    const list = byLesson.get(option.pack.lessonId);
    if (list) {
      list.push(option);
    } else {
      byLesson.set(option.pack.lessonId, [option]);
    }
  }
  for (const list of byLesson.values()) {
    // A stable sort keeps manifest order for equal counts.
    list.sort((a, b) => (b.pack?.bases ?? 0) - (a.pack?.bases ?? 0));
  }
  return byLesson;
}

/** Reviewed bases a lesson's replay rows add up to (0 with no row). */
function replayBasesOf(siblings: ScenarioOption[]): number {
  return siblings.reduce((sum, sibling) => sum + (sibling.pack?.bases ?? 0), 0);
}

function coverageFloor(minReplayBases: number): number {
  return Number.isFinite(minReplayBases) && minReplayBases >= 0
    ? minReplayBases
    : MIN_REPLAY_BASES;
}

/**
 * The ids "All scenarios" stands for, derived from the merged picker catalogue.
 *
 * This is the picker's view of RF2's default pool: a covered lesson stands for
 * its replay row (the biggest pack), every other lesson for its generated id;
 * `preferReplay: false` makes it the generated catalogue. It exists because the
 * picker has no manifest of its own — `mergePackLessons` already copied each
 * row's reviewed-base count onto `pack.bases` — and the checkboxes must agree
 * with what a deal from "All" will actually draw.
 */
export function defaultScenarioIds(
  scenarios: ScenarioOption[] = FALLBACK_SCENARIOS,
  preferReplay = true,
  minReplayBases: number = MIN_REPLAY_BASES,
): ScenarioId[] {
  const floor = coverageFloor(minReplayBases);
  const replayByLesson = replayRowsByLesson(scenarios);

  return scenarios
    .filter((option) => !option.pack)
    .map((option) => {
      if (!preferReplay) return option.id;
      const siblings = replayByLesson.get(option.id) ?? [];
      if (siblings.length === 0 || replayBasesOf(siblings) < floor) return option.id;
      return siblings[0].id;
    });
}

/** One row the picker lists, with its lesson's replay coverage attached. */
export interface PickerScenarioRow {
  option: ScenarioOption;
  /** Which source this row deals from. */
  source: ScenarioSource;
  /** Reviewed bases for the lesson across every merged pack (0 when none). */
  replayBases: number;
  /** Whether the lesson has any replay row at all. */
  hasReplay: boolean;
  /** Whether the lesson's replay coverage reaches the applied floor. */
  covered: boolean;
  /**
   * True for the generated row of a covered lesson: it is the opt-in
   * alternative to the replay position, not the lesson's default source.
   */
  generatedAlternative: boolean;
}

/**
 * The rows a picker section lists, ordered and filtered by source.
 *
 * A covered lesson's replay row comes first and its generated row second, so
 * the default source leads and the opt-in drill trails it. A lesson below the
 * floor keeps the pre-RF2 order (generated, then its opt-in replay row).
 *
 * The filter is exclusive: `replay` lists replay rows only and `generated`
 * lists generated rows only, so a lesson with no replay row is reachable under
 * Generated or Both but never under Replay. Presentational apart from the
 * default pool's source, which the picker switches with the generated filter.
 * Ticked ids are untouched, so a row hidden by a filter is still dealt by a
 * pool that already holds it.
 */
export function pickerScenarioRows(
  scenarios: ScenarioOption[] = FALLBACK_SCENARIOS,
  filter: ScenarioSourceFilter = DEFAULT_SOURCE_FILTER,
  minReplayBases: number = MIN_REPLAY_BASES,
): PickerScenarioRow[] {
  const floor = coverageFloor(minReplayBases);
  const replayByLesson = replayRowsByLesson(scenarios);

  const generatedIds = new Set(
    scenarios.filter((option) => !option.pack).map((option) => option.id),
  );
  const rows: PickerScenarioRow[] = [];
  const emitted = new Set<string>();

  const push = (
    option: ScenarioOption,
    siblings: ScenarioOption[],
    covered: boolean,
    generatedAlternative: boolean,
  ) => {
    rows.push({
      option,
      source: scenarioSource(option),
      replayBases: replayBasesOf(siblings),
      hasReplay: siblings.length > 0,
      covered,
      generatedAlternative,
    });
    emitted.add(option.id);
  };

  for (const option of scenarios) {
    if (option.pack) continue;
    const siblings = replayByLesson.get(option.id) ?? [];
    const covered = siblings.length > 0 && replayBasesOf(siblings) >= floor;

    if (filter === 'generated') {
      // The badge still marks the generated row of a covered lesson: it is the
      // opt-in alternative even when the filter has hidden the replay row.
      push(option, siblings, covered, covered);
    } else if (filter === 'replay') {
      // Replay is exclusive: the generated row is never listed, and a lesson
      // with no replay row is left to the Generated and Both filters.
      for (const sibling of siblings) push(sibling, siblings, covered, false);
    } else if (covered) {
      for (const sibling of siblings) push(sibling, siblings, covered, false);
      push(option, siblings, covered, true);
    } else {
      // Uncovered: the generated lesson stays the default and its replay row
      // (if a pack ships below the floor) remains the opt-in that follows it.
      push(option, siblings, covered, false);
      for (const sibling of siblings) push(sibling, siblings, covered, false);
    }
  }

  // A pack lesson with no generated sibling is still reachable by name; the
  // generated filter is the one case where it is deliberately not listed.
  if (filter !== 'generated') {
    for (const option of scenarios) {
      if (!option.pack || emitted.has(option.id)) continue;
      if (generatedIds.has(option.pack.lessonId)) continue;
      const siblings = replayByLesson.get(option.pack.lessonId) ?? [option];
      push(option, siblings, replayBasesOf(siblings) >= floor, false);
    }
  }

  return rows;
}

/**
 * The ids a selection currently holds, expanded for the `all` mode.
 *
 * `all` is the replay-first default pool (see {@link defaultScenarioIds}):
 * a covered lesson stands for its replay row while `preferReplay` is on and its
 * generated id otherwise. An explicit selection is returned as-is.
 */
export function selectedScenarioIds(
  selection: ScenarioSelection,
  scenarios: ScenarioOption[] = FALLBACK_SCENARIOS,
  preferReplay = true,
): ScenarioId[] {
  return selection.kind === 'all'
    ? defaultScenarioIds(scenarios, preferReplay)
    : selection.ids;
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
  replay: ReplayDefaultOptions = {},
): ScenarioOption[] {
  const catalogue = scenarios.length > 0 ? scenarios : FALLBACK_SCENARIOS;

  if (selection.kind === 'all') {
    // The default pool. Replay coverage replaces a covered lesson's generated
    // entry with its replay row; with no manifest it stays the generated
    // catalogue, so a first launch never downloads a pack body.
    const ids = new Set(allScenarioIds(catalogue, replay));
    const pool = catalogue.filter(
      (scenario) =>
        ids.has(scenario.id) && (includeRequiresAi || !scenario.requires_ai),
    );
    return pool.length > 0 ? pool : FALLBACK_SCENARIOS;
  }

  const chosen = new Set(selection.ids);
  const pool = catalogue.filter((scenario) => chosen.has(scenario.id));
  return pool.length > 0
    ? pool
    : selectionPool(catalogue, ALL_SCENARIOS, includeRequiresAi, replay);
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
  preferReplay = true,
): ScenarioSelection {
  const ids = new Set(selectedScenarioIds(selection, scenarios, preferReplay));
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
  preferReplay = true,
): ScenarioSelection {
  const chosen = new Set(selectedScenarioIds(selection, scenarios, preferReplay));
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
  replay: ReplayDefaultOptions = {},
): ScenarioId {
  const pool = selectionPool(scenarios, selection, includeRequiresAi, replay);
  return pool[Math.floor(Math.random() * pool.length)].id;
}

/** Pick one scenario at random from the whole catalogue (replay-first aware). */
export function pickRandomScenario(
  scenarios: ScenarioOption[] = FALLBACK_SCENARIOS,
  includeRequiresAi = true,
  replay: ReplayDefaultOptions = {},
): ScenarioId {
  return pickRandomScenarioFrom(scenarios, ALL_SCENARIOS, includeRequiresAi, replay);
}
