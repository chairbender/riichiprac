import { afterEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_SCENARIOS, pickRandomScenario } from './scenarios';
import type { ScenarioOption, ScenarioGrading } from './scenarios';

function scenario(
  id: string,
  requiresAi: boolean,
  grading: ScenarioGrading,
): ScenarioOption {
  return {
    id,
    label: id,
    description: id,
    category: 'test',
    tags: [],
    requires_ai: requiresAi,
    grading,
  };
}

const bookLesson = scenario('ryanmen_protorun', false, 'book_and_mortal');
const drill = scenario('ai_best_action', true, 'mortal_only');

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
    expect(pickRandomScenario([bookLesson, drill], false)).toBe('ryanmen_protorun');
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
