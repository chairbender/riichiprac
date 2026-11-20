import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_SCENARIOS,
  DEFAULT_SOURCE_FILTER,
  FALLBACK_SCENARIOS,
  MIN_REPLAY_BASES,
  allScenarioIds,
  defaultScenarioIds,
  groupScenarios,
  isPackScenarioId,
  lessonReplayCoverage,
  mergePackLessons,
  packScenarioId,
  parseScenarioManifest,
  parsePackScenarioId,
  pickRandomScenario,
  pickRandomScenarioFrom,
  pickerScenarioRows,
  scenarioSource,
  selectedScenarioIds,
  selectionLabel,
  selectionPool,
  setScenariosSelected,
  toggleScenario,
} from './scenarios';
import type { BookSection, ScenarioGrading, ScenarioOption } from './scenarios';
import type { PackManifest, PackManifestEntry } from './services/packLoader';

function scenario(
  id: string,
  requiresAi: boolean,
  grading: ScenarioGrading,
  book: BookSection | null = null,
): ScenarioOption {
  return {
    id,
    label: id,
    description: id,
    category: 'test',
    tags: [],
    requires_ai: requiresAi,
    grading,
    book,
  };
}

function book(
  chapter: number,
  section: number,
  key: string,
  label: string,
): BookSection {
  return {
    chapter,
    chapter_title: `Chapter ${chapter}`,
    section,
    section_title: `Section ${section}`,
    key,
    label,
  };
}

const bookLesson = scenario('ryanmen_protorun', false, 'book_and_mortal');
const drill = scenario('ai_hotseat', true, 'mortal_only');

const chapter8 = scenario(
  'push_or_fold',
  false,
  'book_and_mortal',
  book(8, 1, 'ch8.1', 'ch8.1 · To push or to fold?'),
);
const chapter8b = scenario(
  'open_hand_defense',
  false,
  'book_and_mortal',
  book(8, 4, 'ch8.4', 'ch8.4 · Defense against open hands'),
);
const chapter3 = scenario(
  'proturun_priority',
  false,
  'book_and_mortal',
  book(3, 2, 'ch3.2', 'ch3.2 · Basic building blocks'),
);
const chapter8c = scenario(
  'fold_to_riichi',
  false,
  'book_and_mortal',
  book(8, 1, 'ch8.1', 'ch8.1 · To push or to fold?'),
);
const catalogue = [chapter8b, drill, chapter3, chapter8];
/** The base catalogue plus the generated lesson the fixture pack covers. */
const replayCatalogue = [...catalogue, chapter8c];

afterEach(() => {
  vi.restoreAllMocks();
});

/** Pick the last element of the pool, so the pool contents are unambiguous. */
function pickLast(): void {
  vi.spyOn(Math, 'random').mockReturnValue(0.999999);
}

describe('pickRandomScenario', () => {
  it('draws a Mortal-only drill once the model is ready', () => {
    pickLast();
    expect(pickRandomScenario([bookLesson, drill], true)).toBe('ai_hotseat');
  });

  it('draws the drill even with the agreement filter on', () => {
    // The setting does not filter the pool: a drill has no book answer, so
    // `loadPuzzle` routes it to the evaluator instead of the agreement sampler.
    pickLast();
    expect(pickRandomScenario([bookLesson, drill], true)).toBe(drill.id);
  });

  it('still keeps AI lessons out of the pool until the model is ready', () => {
    pickLast();
    expect(pickRandomScenario([bookLesson, drill], false)).toBe(
      'ryanmen_protorun',
    );
  });

  it('reaches the drill across repeated draws instead of never drawing it', () => {
    const rolls = [0, 0.999999, 0, 0.999999];
    let call = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => rolls[call++ % rolls.length]);

    const draws = rolls.map(() => pickRandomScenario([bookLesson, drill], true));
    expect(draws).toEqual([
      'ryanmen_protorun',
      'ai_hotseat',
      'ryanmen_protorun',
      'ai_hotseat',
    ]);
  });

  it('returns the drill when it is the only candidate', () => {
    // No retry loop looking for a book lesson: the single candidate is dealt.
    pickLast();
    expect(pickRandomScenario([drill], true)).toBe('ai_hotseat');
  });

  it('falls back to the built-in lesson when every candidate needs the model', () => {
    pickLast();
    expect(pickRandomScenario([drill], false)).toBe(FALLBACK_SCENARIOS[0].id);
  });

  it('uses the fallback catalogue when no manifest is available', () => {
    pickLast();
    expect(pickRandomScenario([], false)).toBe(FALLBACK_SCENARIOS[0].id);
  });
});

describe('selectionPool', () => {
  it('draws only from an explicit subset, in manifest order', () => {
    const pool = selectionPool(catalogue, {
      kind: 'selected',
      ids: ['open_hand_defense', 'proturun_priority'],
    });
    expect(pool.map((option) => option.id)).toEqual([
      'open_hand_defense',
      'proturun_priority',
    ]);
  });

  it('takes a selected AI drill literally, even before the model is ready', () => {
    const pool = selectionPool(
      catalogue,
      { kind: 'selected', ids: ['ai_hotseat'] },
      false,
    );
    expect(pool.map((option) => option.id)).toEqual(['ai_hotseat']);
  });

  it('keeps AI drills out of the all pool until the model is ready', () => {
    const pool = selectionPool(catalogue, ALL_SCENARIOS, false);
    expect(pool.map((option) => option.id)).not.toContain('ai_hotseat');
  });

  it('falls back to the catalogue when the subset matches nothing', () => {
    const pool = selectionPool(catalogue, { kind: 'selected', ids: ['gone'] });
    expect(pool).toEqual(catalogue);
  });
});

describe('pickRandomScenarioFrom', () => {
  it('draws from the selected subset instead of the whole catalogue', () => {
    pickLast();
    expect(
      pickRandomScenarioFrom(catalogue, {
        kind: 'selected',
        ids: ['proturun_priority', 'push_or_fold'],
      }),
    ).toBe('push_or_fold');

    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(
      pickRandomScenarioFrom(catalogue, {
        kind: 'selected',
        ids: ['proturun_priority', 'push_or_fold'],
      }),
    ).toBe('proturun_priority');
  });
});

describe('groupScenarios', () => {
  it('puts Other first, then orders groups by chapter and section', () => {
    const groups = groupScenarios(catalogue);
    expect(groups.map((group) => group.key)).toEqual([
      'ungrouped',
      'ch3.2',
      'ch8.1',
      'ch8.4',
    ]);
    expect(groups[0].label).toBe('Other');
    expect(groups[0].scenarios.map((s) => s.id)).toEqual(['ai_hotseat']);
  });

  it('keeps the manifest order inside a group', () => {
    const groups = groupScenarios([chapter8c, chapter8, chapter8b]);
    expect(groups.map((group) => group.key)).toEqual(['ch8.1', 'ch8.4']);
    expect(groups[0].scenarios.map((s) => s.id)).toEqual([
      'fold_to_riichi',
      'push_or_fold',
    ]);
  });
});

describe('selection helpers', () => {
  it('expands the all selection to the full catalogue', () => {
    expect(selectedScenarioIds(ALL_SCENARIOS, catalogue)).toEqual([
      'open_hand_defense',
      'ai_hotseat',
      'proturun_priority',
      'push_or_fold',
    ]);
  });

  it('labels all, one, many and empty pools', () => {
    expect(selectionLabel(ALL_SCENARIOS, catalogue)).toBe(
      'All scenarios (random)',
    );
    expect(
      selectionLabel({ kind: 'selected', ids: ['push_or_fold'] }, catalogue),
    ).toBe('push_or_fold');
    expect(
      selectionLabel(
        { kind: 'selected', ids: ['push_or_fold', 'chapter3'] },
        catalogue,
      ),
    ).toBe('2 scenarios (random)');
    expect(selectionLabel({ kind: 'selected', ids: [] }, catalogue)).toBe(
      'No scenarios selected',
    );
  });

  it('turns the all selection into a subset when one box is unticked', () => {
    const next = toggleScenario(catalogue, ALL_SCENARIOS, 'push_or_fold');
    expect(next).toEqual({
      kind: 'selected',
      ids: ['open_hand_defense', 'ai_hotseat', 'proturun_priority'],
    });
  });

  it('ticks a single scenario without disturbing the rest', () => {
    const next = toggleScenario(
      catalogue,
      { kind: 'selected', ids: ['push_or_fold'] },
      'proturun_priority',
    );
    expect(next).toEqual({
      kind: 'selected',
      ids: ['proturun_priority', 'push_or_fold'],
    });
  });

  it('selects and clears a whole group', () => {
    const cleared = setScenariosSelected(
      catalogue,
      ALL_SCENARIOS,
      ['open_hand_defense'],
      false,
    );
    expect(cleared).toEqual({
      kind: 'selected',
      ids: ['ai_hotseat', 'proturun_priority', 'push_or_fold'],
    });

    const reselected = setScenariosSelected(
      catalogue,
      { kind: 'selected', ids: ['push_or_fold'] },
      ['open_hand_defense'],
      true,
    );
    expect(reselected).toEqual({
      kind: 'selected',
      ids: ['open_hand_defense', 'push_or_fold'],
    });
  });
});

describe('parseScenarioManifest', () => {
  it('keeps a serialized book section', () => {
    const parsed = parseScenarioManifest(
      JSON.stringify([
        {
          id: 'push_or_fold',
          label: 'Push or Fold',
          description: 'desc',
          category: 'defense_decision',
          tags: ['defense'],
          requires_ai: false,
          grading: 'book_and_mortal',
          book: {
            chapter: 8,
            chapter_title: 'Defense judgement',
            section: 1,
            section_title: 'To push or to fold?',
            key: 'ch8.1',
            label: 'ch8.1 · To push or to fold?',
          },
        },
      ]),
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0].book?.key).toBe('ch8.1');
  });

  it('defaults a missing book section to null', () => {
    const parsed = parseScenarioManifest(
      JSON.stringify([
        {
          id: 'ai_hotseat',
          label: 'AI',
          description: 'desc',
          category: 'ai_decision',
          tags: ['ai'],
          requires_ai: true,
          grading: 'mortal_only',
        },
      ]),
    );

    expect(parsed[0].book).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Replay-pack picker entries                                                 */
/* -------------------------------------------------------------------------- */

function packEntry(overrides: Partial<PackManifestEntry> = {}): PackManifestEntry {
  return {
    id: 'replay.fixture.2026-11',
    path: 'replay.fixture.2026-11-8aa259ff85d4.json.gz',
    sha256: '8aa259ff85d470e434226beed84acd3d5cbe2d0864ab1e6b46148a802c8a2fcb',
    bytes: 3572,
    scenario_count: 2,
    lesson_ids: ['fold_to_riichi', 'ryanmen_protorun'],
    book_sections: ['ch4.1', 'ch8.1'],
    licence: 'CC-BY-4.0',
    requires_model: true,
    data_commercial_use: true,
    ...overrides,
  };
}

function manifest(entry: PackManifestEntry = packEntry()): PackManifest {
  return {
    schema: 'riichiprac.scenario-pack-manifest',
    version: 1,
    updated_at: '2026-11-17T00:00:00Z',
    packs: [entry],
  };
}

describe('pack lesson ids', () => {
  it('round-trips a pack and lesson', () => {
    const id = packScenarioId('replay.fixture.2026-11', 'fold_to_riichi');
    expect(id).toBe('replay:replay.fixture.2026-11:fold_to_riichi');
    expect(isPackScenarioId(id)).toBe(true);
    expect(parsePackScenarioId(id)).toEqual({
      packId: 'replay.fixture.2026-11',
      lessonId: 'fold_to_riichi',
    });
  });

  it('rejects ids that are not a complete pack/lesson pair', () => {
    for (const id of [
      'fold_to_riichi',
      'replay:',
      'replay:only-a-pack',
      'replay::lesson',
      'replay:pack:',
    ]) {
      expect(isPackScenarioId(id)).toBe(id.startsWith('replay:'));
      expect(parsePackScenarioId(id)).toBeNull();
    }
  });
});

describe('mergePackLessons', () => {
  const packCatalogue = mergePackLessons(replayCatalogue, manifest());
  const replayFold = packScenarioId('replay.fixture.2026-11', 'fold_to_riichi');
  const replayRyanmen = packScenarioId('replay.fixture.2026-11', 'ryanmen_protorun');

  it('adds one replay entry per manifest lesson, next to its generated lesson', () => {
    const ids = packCatalogue.map((option) => option.id);
    expect(ids).toEqual([
      'open_hand_defense',
      'ai_hotseat',
      'proturun_priority',
      'push_or_fold',
      'fold_to_riichi',
      replayFold,
      // ryanmen_protorun is not in this catalogue, so its replay entry is
      // appended at the end with no generated sibling.
      replayRyanmen,
    ]);
  });

  it('merges the WASM lesson metadata into the replay entry', () => {
    const replay = packCatalogue.find((option) => option.id === replayFold);
    expect(replay).toBeDefined();
    expect(replay?.label).toBe('fold_to_riichi (replay)');
    expect(replay?.category).toBe('test');
    expect(replay?.book).toEqual(chapter8.book);
    expect(replay?.grading).toBe('book_and_mortal');
    expect(replay?.requires_ai).toBe(false);
    expect(replay?.tags).toContain('pack');
    expect(replay?.pack).toMatchObject({
      packId: 'replay.fixture.2026-11',
      lessonId: 'fold_to_riichi',
      packScenarioCount: 2,
      licence: 'CC-BY-4.0',
    });
  });

  it('keeps the answer out of the picker label and description', () => {
    const replay = packCatalogue.find((option) => option.id === replayFold);
    expect(replay?.label.toLowerCase()).not.toContain('7m');
    expect(replay?.description).toContain('replay.fixture.2026-11');
    expect(replay?.description.toLowerCase()).not.toContain('7m');
  });

  it('groups a replay entry with its generated lesson', () => {
    const groups = groupScenarios(packCatalogue);
    const section = groups.find((group) => group.key === 'ch8.1');
    expect(section?.scenarios.map((option) => option.id)).toEqual([
      'push_or_fold',
      'fold_to_riichi',
      replayFold,
    ]);
  });

  it('humanises a replay lesson the catalogue does not know', () => {
    const unknown = packEntry({
      lesson_ids: ['replay_speed_value'],
      book_sections: [],
      scenario_count: 1,
    });
    const merged = mergePackLessons(catalogue, manifest(unknown));
    const replay = merged.find(
      (option) => option.id === packScenarioId(unknown.id, 'replay_speed_value'),
    );
    expect(replay?.label).toBe('Replay speed value');
    expect(replay?.book).toBeNull();
    expect(replay?.pack?.lessonId).toBe('replay_speed_value');
    expect(
      groupScenarios(merged).find((group) => group.key === 'ungrouped')?.scenarios,
    ).toContainEqual(replay);
  });

  it('is idempotent when the merged catalogue is merged again', () => {
    const twice = mergePackLessons(packCatalogue, manifest());
    expect(twice.map((option) => option.id)).toEqual(
      packCatalogue.map((option) => option.id),
    );
  });

  it('returns the generated catalogue when there is no manifest or no pack', () => {
    expect(mergePackLessons(catalogue, null)).toEqual(catalogue);
    expect(
      mergePackLessons(catalogue, {
        schema: 'riichiprac.scenario-pack-manifest',
        version: 1,
        updated_at: '2026-11-17T00:00:00Z',
        packs: [],
      }),
    ).toEqual(catalogue);
  });
});

describe('replay entries and the all pool', () => {
  const merged = mergePackLessons(replayCatalogue, manifest());
  const replayFold = packScenarioId('replay.fixture.2026-11', 'fold_to_riichi');

  it('keeps replay lessons out of All when the manifest carries no coverage', () => {
    expect(selectedScenarioIds(ALL_SCENARIOS, merged)).toEqual([
      'open_hand_defense',
      'ai_hotseat',
      'proturun_priority',
      'push_or_fold',
      'fold_to_riichi',
    ]);
    const pool = selectionPool(merged, ALL_SCENARIOS, true);
    expect(pool.every((option) => !option.pack)).toBe(true);
    expect(pool.map((option) => option.id)).not.toContain(replayFold);
  });

  it('deals a replay lesson when it is explicitly selected', () => {
    const pool = selectionPool(merged, { kind: 'selected', ids: [replayFold] });
    expect(pool.map((option) => option.id)).toEqual([replayFold]);
  });

  it('adds a replay lesson to an explicit pool instead of dropping it', () => {
    // Ticking a replay box while All is checked opts in: it must not be
    // interpreted as "this id was already in All, so untick it".
    const next = toggleScenario(merged, ALL_SCENARIOS, replayFold);
    expect(next.kind).toBe('selected');
    expect(next.kind === 'selected' && next.ids).toEqual([
      'open_hand_defense',
      'ai_hotseat',
      'proturun_priority',
      'push_or_fold',
      'fold_to_riichi',
      replayFold,
    ]);
  });

  it('labels a replay selection with its merged label', () => {
    expect(selectionLabel({ kind: 'selected', ids: [replayFold] }, merged)).toBe(
      'fold_to_riichi (replay)',
    );
  });

  it('never draws a replay lesson from All, even at the last candidate', () => {
    pickLast();
    for (let draw = 0; draw < 20; draw += 1) {
      expect(pickRandomScenarioFrom(merged, ALL_SCENARIOS, true)).not.toBe(
        replayFold,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Replay-first default pool (RF2)                                            */
/* -------------------------------------------------------------------------- */

/** One manifest entry with reviewed-base counts, with lesson_ids derived. */
function countedEntry(
  counts: Record<string, number>,
  overrides: Partial<PackManifestEntry> = {},
): PackManifestEntry {
  return packEntry({
    lesson_ids: Object.keys(counts),
    lesson_counts: counts,
    scenario_count: Object.values(counts).reduce((sum, count) => sum + count, 0),
    ...overrides,
  });
}

describe('lessonReplayCoverage', () => {
  it('reads reviewed bases per lesson without a pack body', () => {
    const coverage = lessonReplayCoverage(
      manifest(countedEntry({ fold_to_riichi: 731, push_or_fold: 12 })),
    );

    expect(coverage.get('fold_to_riichi')).toMatchObject({
      bases: 731,
      covered: true,
      packId: 'replay.fixture.2026-11',
      lessonId: 'fold_to_riichi',
      scenarioId: packScenarioId('replay.fixture.2026-11', 'fold_to_riichi'),
    });
    expect(coverage.get('push_or_fold')?.bases).toBe(12);
    expect(coverage.get('push_or_fold')?.covered).toBe(false);
  });

  it('treats a manifest without lesson_counts as uncovered', () => {
    const coverage = lessonReplayCoverage(manifest());
    expect(coverage.get('fold_to_riichi')).toMatchObject({ bases: 0, covered: false });
  });

  it('counts a lesson across packs and defaults to the biggest row', () => {
    const coverage = lessonReplayCoverage({
      schema: 'riichiprac.scenario-pack-manifest',
      version: 1,
      updated_at: '2026-11-19T00:00:00Z',
      packs: [
        countedEntry({ fold_to_riichi: 30 }, { id: 'replay.small.2026-11' }),
        countedEntry({ fold_to_riichi: 35 }, { id: 'replay.big.2026-11' }),
      ],
    });

    expect(coverage.get('fold_to_riichi')).toMatchObject({
      bases: 65,
      covered: true,
      packId: 'replay.big.2026-11',
      scenarioId: packScenarioId('replay.big.2026-11', 'fold_to_riichi'),
    });
  });

  it('applies the configured floor instead of the 40-base default', () => {
    const counts = countedEntry({ fold_to_riichi: 20 });

    expect(MIN_REPLAY_BASES).toBe(40);
    expect(lessonReplayCoverage(manifest(counts)).get('fold_to_riichi')?.covered).toBe(
      false,
    );
    expect(
      lessonReplayCoverage(manifest(counts), 10).get('fold_to_riichi')?.covered,
    ).toBe(true);
  });

  it('returns nothing for a missing or empty manifest', () => {
    expect(lessonReplayCoverage(null).size).toBe(0);
    expect(lessonReplayCoverage(undefined).size).toBe(0);
    expect(
      lessonReplayCoverage({
        schema: 'riichiprac.scenario-pack-manifest',
        version: 1,
        updated_at: '2026-11-19T00:00:00Z',
        packs: [],
      }).size,
    ).toBe(0);
  });
});

describe('replay-first default pool', () => {
  const replayFold = packScenarioId('replay.fixture.2026-11', 'fold_to_riichi');
  const covered = manifest(countedEntry({ fold_to_riichi: MIN_REPLAY_BASES }));
  const merged = mergePackLessons(replayCatalogue, covered);

  it('deals a covered lesson from its replay row', () => {
    expect(allScenarioIds(merged, { manifest: covered })).toEqual([
      'open_hand_defense',
      'ai_hotseat',
      'proturun_priority',
      'push_or_fold',
      replayFold,
    ]);

    const pool = selectionPool(merged, ALL_SCENARIOS, true, { manifest: covered });
    expect(pool.map((option) => option.id)).toContain(replayFold);
    expect(pool.map((option) => option.id)).not.toContain('fold_to_riichi');
  });

  it('keeps an uncovered lesson on its generated row', () => {
    const thin = manifest(countedEntry({ fold_to_riichi: MIN_REPLAY_BASES - 1 }));
    const thinMerged = mergePackLessons(replayCatalogue, thin);

    // The replay row still exists in the picker; only the default pool ignores
    // it until coverage reaches the floor.
    expect(thinMerged.map((option) => option.id)).toContain(replayFold);
    expect(allScenarioIds(thinMerged, { manifest: thin })).toEqual([
      'open_hand_defense',
      'ai_hotseat',
      'proturun_priority',
      'push_or_fold',
      'fold_to_riichi',
    ]);
  });

  it('returns the generated ids when preferReplay is off', () => {
    expect(
      allScenarioIds(merged, { manifest: covered, preferReplay: false }),
    ).toEqual(selectedScenarioIds(ALL_SCENARIOS, merged, false));
    // Omitting the flag keeps replay as the default: the settings store owns
    // the on-by-default value, so an unset option must not mean "off".
    expect(allScenarioIds(merged, { manifest: covered })).toContain(replayFold);
  });

  it('leaves the pool untouched when there is no manifest or no pack', () => {
    const generated = selectedScenarioIds(ALL_SCENARIOS, merged, false);
    expect(allScenarioIds(merged, { manifest: null })).toEqual(generated);
    expect(allScenarioIds(merged, { manifest: undefined })).toEqual(generated);
    expect(
      allScenarioIds(merged, {
        manifest: {
          schema: 'riichiprac.scenario-pack-manifest',
          version: 1,
          updated_at: '2026-11-19T00:00:00Z',
          packs: [],
        },
      }),
    ).toEqual(generated);
    // No options at all is the pre-RF2 call shape and must not change either.
    expect(allScenarioIds(merged)).toEqual(generated);
  });

  it('honours a floor override on the pool', () => {
    const thin = manifest(countedEntry({ fold_to_riichi: 10 }));
    const thinMerged = mergePackLessons(replayCatalogue, thin);

    expect(
      allScenarioIds(thinMerged, { manifest: thin, minReplayBases: 10 }),
    ).toContain(replayFold);
    expect(allScenarioIds(thinMerged, { manifest: thin })).not.toContain(replayFold);
  });

  it('keeps the generated row selectable for a covered lesson', () => {
    const pool = selectionPool(merged, {
      kind: 'selected',
      ids: ['fold_to_riichi'],
    });
    expect(pool.map((option) => option.id)).toEqual(['fold_to_riichi']);
  });

  it('keeps a pack-only lesson out of the default pool', () => {
    // ryanmen_protorun has no generated sibling in this catalogue. It stays
    // reachable by name from the picker, but `all` cannot deal it: there is no
    // generated lesson to fall back to when its body fails.
    const onlyPack = manifest(
      countedEntry(
        { ryanmen_protorun: MIN_REPLAY_BASES },
        { lesson_ids: ['ryanmen_protorun'] },
      ),
    );
    const replayRyanmen = packScenarioId('replay.fixture.2026-11', 'ryanmen_protorun');
    const packOnly = mergePackLessons(replayCatalogue, onlyPack);

    expect(allScenarioIds(packOnly, { manifest: onlyPack })).toEqual(
      selectedScenarioIds(ALL_SCENARIOS, packOnly),
    );
    expect(allScenarioIds(packOnly, { manifest: onlyPack })).not.toContain(
      replayRyanmen,
    );
    expect(
      selectionPool(packOnly, { kind: 'selected', ids: [replayRyanmen] }).map(
        (option) => option.id,
      ),
    ).toEqual([replayRyanmen]);
  });

  it('draws the replay row from All once covered', () => {
    pickLast();
    expect(
      pickRandomScenarioFrom(merged, ALL_SCENARIOS, true, { manifest: covered }),
    ).toBe(replayFold);
  });
});

/* -------------------------------------------------------------------------- */
/* Picker source filter (RF3)                                                 */
/* -------------------------------------------------------------------------- */

describe('picker source rows', () => {
  const replayFold = packScenarioId('replay.fixture.2026-11', 'fold_to_riichi');
  const replayPush = packScenarioId('replay.fixture.2026-11', 'push_or_fold');
  const coveredManifest = manifest(
    countedEntry({ fold_to_riichi: 731, push_or_fold: 12 }),
  );
  const merged = mergePackLessons(replayCatalogue, coveredManifest);

  it('records a replay row’s reviewed bases from the manifest', () => {
    expect(merged.find((option) => option.id === replayFold)?.pack?.bases).toBe(
      731,
    );
    // A manifest published before lesson_counts keeps the row opt-in.
    expect(
      mergePackLessons(replayCatalogue, manifest()).find(
        (option) => option.id === replayFold,
      )?.pack?.bases,
    ).toBe(0);
  });

  it('reports the source of a generated and a replay row', () => {
    expect(scenarioSource(chapter8c)).toBe('generated');
    const replay = merged.find((option) => option.id === replayFold);
    expect(replay && scenarioSource(replay)).toBe('replay');
  });

  it('leads a covered lesson with its replay row and badges the generated alternative', () => {
    const rows = pickerScenarioRows(merged);
    const ids = rows.map((row) => row.option.id);

    expect(ids.indexOf(replayFold) + 1).toBe(ids.indexOf('fold_to_riichi'));
    expect(rows.find((row) => row.option.id === replayFold)).toMatchObject({
      source: 'replay',
      replayBases: 731,
      hasReplay: true,
      covered: true,
      generatedAlternative: false,
    });
    expect(rows.find((row) => row.option.id === 'fold_to_riichi')).toMatchObject({
      source: 'generated',
      replayBases: 731,
      hasReplay: true,
      covered: true,
      generatedAlternative: true,
    });
  });

  it('keeps a below-floor lesson generated-first and unbadged', () => {
    const thin = mergePackLessons(
      replayCatalogue,
      manifest(countedEntry({ fold_to_riichi: MIN_REPLAY_BASES - 1 })),
    );
    const rows = pickerScenarioRows(thin);
    const ids = rows.map((row) => row.option.id);

    expect(ids.indexOf('fold_to_riichi') + 1).toBe(ids.indexOf(replayFold));
    expect(rows.find((row) => row.option.id === 'fold_to_riichi')).toMatchObject({
      covered: false,
      hasReplay: true,
      generatedAlternative: false,
    });
  });

  it('filters to replay rows, keeping generated rows only where no replay exists', () => {
    const rows = pickerScenarioRows(merged, 'replay');
    expect(rows.map((row) => row.option.id)).toEqual([
      'open_hand_defense',
      'ai_hotseat',
      'proturun_priority',
      replayPush,
      replayFold,
    ]);
    expect(rows.every((row) => row.source === 'replay' || !row.hasReplay)).toBe(
      true,
    );
  });

  it('hides every replay row under the generated filter', () => {
    const rows = pickerScenarioRows(merged, 'generated');
    expect(rows.map((row) => row.option.id)).toEqual([
      'open_hand_defense',
      'ai_hotseat',
      'proturun_priority',
      'push_or_fold',
      'fold_to_riichi',
    ]);
    expect(rows.every((row) => row.source === 'generated')).toBe(true);
  });

  it('defaults to both and applies a floor override', () => {
    expect(DEFAULT_SOURCE_FILTER).toBe('both');
    const rows = pickerScenarioRows(merged, 'both', MIN_REPLAY_BASES);
    expect(rows.map((row) => row.option.id)).toEqual([
      'open_hand_defense',
      'ai_hotseat',
      'proturun_priority',
      'push_or_fold',
      replayPush,
      replayFold,
      'fold_to_riichi',
    ]);
  });

  it('orders multiple packs by reviewed bases and sums their coverage', () => {
    const twoPacks: PackManifest = {
      schema: 'riichiprac.scenario-pack-manifest',
      version: 1,
      updated_at: '2026-11-19T00:00:00Z',
      packs: [
        countedEntry({ fold_to_riichi: 20 }, { id: 'replay.small.2026-11' }),
        countedEntry({ fold_to_riichi: 20 }, { id: 'replay.big.2026-11' }),
      ],
    };
    const rows = pickerScenarioRows(
      mergePackLessons(replayCatalogue, twoPacks),
    ).filter((row) => row.option.pack);

    expect(rows.map((row) => row.option.id)).toEqual([
      packScenarioId('replay.small.2026-11', 'fold_to_riichi'),
      packScenarioId('replay.big.2026-11', 'fold_to_riichi'),
    ]);
    expect(rows[0]).toMatchObject({ replayBases: 40, covered: true });
  });

  it('lists a pack-only lesson until the generated filter hides it', () => {
    const orphan = mergePackLessons(
      replayCatalogue,
      manifest(
        countedEntry(
          { ryanmen_protorun: MIN_REPLAY_BASES },
          { lesson_ids: ['ryanmen_protorun'] },
        ),
      ),
    );
    const orphanId = packScenarioId(
      'replay.fixture.2026-11',
      'ryanmen_protorun',
    );

    expect(pickerScenarioRows(orphan, 'replay').map((row) => row.option.id)).toContain(
      orphanId,
    );
    expect(
      pickerScenarioRows(orphan, 'generated').map((row) => row.option.id),
    ).not.toContain(orphanId);
  });
});

describe('defaultScenarioIds (picker All expansion)', () => {
  const replayFold = packScenarioId('replay.fixture.2026-11', 'fold_to_riichi');
  const coveredManifest = manifest(countedEntry({ fold_to_riichi: 731 }));
  const merged = mergePackLessons(replayCatalogue, coveredManifest);

  it('stands for the replay row of a covered lesson', () => {
    expect(defaultScenarioIds(merged)).toEqual([
      'open_hand_defense',
      'ai_hotseat',
      'proturun_priority',
      'push_or_fold',
      replayFold,
    ]);
    expect(selectedScenarioIds(ALL_SCENARIOS, merged)).toEqual(
      defaultScenarioIds(merged),
    );
  });

  it('falls back to generated ids without coverage or preference', () => {
    expect(defaultScenarioIds(merged, false)).toEqual([
      'open_hand_defense',
      'ai_hotseat',
      'proturun_priority',
      'push_or_fold',
      'fold_to_riichi',
    ]);
    expect(defaultScenarioIds(mergePackLessons(replayCatalogue, manifest()))).toEqual(
      defaultScenarioIds(merged, false),
    );
  });

  it('agrees with allScenarioIds over the same manifest', () => {
    expect(defaultScenarioIds(merged)).toEqual(
      allScenarioIds(merged, { manifest: coveredManifest }),
    );
  });
});
