import { describe, expect, it } from 'vitest';
import { callDecisionFor } from './callDecision';
import type { AiEvaluation } from './types/ai';
import type { GameState } from './types/game';

/** A riichi judgement state: the drill asks Riichi or dama, not Kan. */
const riichiState = {
  target_action: 'Riichi',
  call_offer: null,
  ai_decision: null,
} as unknown as GameState;

/** A closed-quad lesson: the Kan is the decision the state asks about. */
const kanLessonState = {
  target_action: 'Kan',
  call_offer: null,
  ai_decision: null,
} as unknown as GameState;

/** The open-quad lesson: the offered Kan is the call being declined. */
const offeredKanState = {
  target_action: 'Call',
  call_offer: {
    action: 'Kan',
    label: 'Kan Wh',
    tile: '5z',
    tiles: [],
  },
  ai_decision: null,
} as unknown as GameState;

/** The AI drill renders every legal action, including a self-turn ankan. */
const drillState = {
  target_action: 'Best',
  call_offer: null,
  ai_decision: { actions: [{ action: 'Kan', label: 'Ankan 2p', type: 'kan' }] },
} as unknown as GameState;

/** An evaluation of one ankan plus two ordinary discards. */
function evaluationWithKan(): AiEvaluation {
  return {
    model: 'mortal_298k.safetensors',
    expected_value: 0,
    recommended_action: 'Discard_7p',
    evaluations: [
      {
        action: 'Discard_7p',
        label: 'Discard 7p',
        type: 'discard',
        tile: '7p',
        probability: 0.7,
      },
      {
        action: 'Kan',
        label: 'Ankan 2p',
        type: 'kan',
        tile: '2p',
        kan_kind: 'ankan',
        probability: 0.2,
      },
      {
        action: 'Discard_4p',
        label: 'Discard 4p',
        type: 'discard',
        tile: '4p',
        probability: 0.1,
      },
    ],
  } as unknown as AiEvaluation;
}

describe('call decision report', () => {
  it('ignores a hand quad when the lesson does not offer the Kan', () => {
    // The reported bug: 2222p in a Riichi-judgement hand made Mortal evaluate
    // an ankan while the hand dock showed no Call Kan toggle.
    expect(callDecisionFor(evaluationWithKan(), riichiState)).toBeNull();
  });

  it('reports the Kan on a closed-quad lesson', () => {
    const call = callDecisionFor(evaluationWithKan(), kanLessonState);

    expect(call?.title).toBe('Kan decision');
    expect(call?.options.map((option) => option.action)).toEqual([
      'Kan',
      '__decline',
    ]);
    expect(call?.options[0].label).toBe('Ankan 2p');
    expect(call?.options[1].label).toBe('No Kan');
    expect(call?.focusActions).toEqual(['Kan']);
  });

  it('reports the offered Kan on the open-quad lesson', () => {
    const call = callDecisionFor(evaluationWithKan(), offeredKanState);

    expect(call?.title).toBe('Kan decision');
    expect(call?.options.some((option) => option.action === 'Kan')).toBe(true);
  });

  it('reports the Kan when the AI drill lists it as a legal action', () => {
    const call = callDecisionFor(evaluationWithKan(), drillState);

    expect(call?.title).toBe('Kan decision');
    expect(call?.focusActions).toEqual(['Kan']);
  });

  it('returns no report when Mortal found no call at all', () => {
    const evaluation = evaluationWithKan();
    evaluation.evaluations = evaluation.evaluations.filter(
      (action) => action.type === 'discard',
    );

    expect(callDecisionFor(evaluation, riichiState)).toBeNull();
  });
});
