import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_SCENARIOS,
  FALLBACK_SCENARIOS,
  groupScenarios,
  parseScenarioManifest,
  pickRandomScenario,
  pickRandomScenarioFrom,
  selectedScenarioIds,
  selectionLabel,
  selectionPool,
  setScenariosSelected,
  toggleScenario,
} from './scenarios';
import type { BookSection, ScenarioGrading, ScenarioOption } from './scenarios';

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
const drill = scenario('ai_best_action', true, 'mortal_only');

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
    expect(pickRandomScenario([bookLesson, drill], true)).toBe('ai_best_action');
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
      'ai_best_action',
      'ryanmen_protorun',
      'ai_best_action',
    ]);
  });

  it('returns the drill when it is the only candidate', () => {
    // No retry loop looking for a book lesson: the single candidate is dealt.
    pickLast();
    expect(pickRandomScenario([drill], true)).toBe('ai_best_action');
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
      { kind: 'selected', ids: ['ai_best_action'] },
      false,
    );
    expect(pool.map((option) => option.id)).toEqual(['ai_best_action']);
  });

  it('keeps AI drills out of the all pool until the model is ready', () => {
    const pool = selectionPool(catalogue, ALL_SCENARIOS, false);
    expect(pool.map((option) => option.id)).not.toContain('ai_best_action');
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
  it('orders groups by chapter and section, with Other last', () => {
    const groups = groupScenarios(catalogue);
    expect(groups.map((group) => group.key)).toEqual([
      'ch3.2',
      'ch8.1',
      'ch8.4',
      'ungrouped',
    ]);
    expect(groups[groups.length - 1].label).toBe('Other');
    expect(groups[groups.length - 1].scenarios.map((s) => s.id)).toEqual([
      'ai_best_action',
    ]);
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
      'ai_best_action',
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
      ids: ['open_hand_defense', 'ai_best_action', 'proturun_priority'],
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
      ids: ['ai_best_action', 'proturun_priority', 'push_or_fold'],
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
          id: 'ai_best_action',
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
