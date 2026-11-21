import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The answer-reset action.
 *
 * `reset` starts the next hand from nothing; `resetAnswer` is the other
 * direction: the same `GameState`, back to unanswered, so the player can retry
 * or the teacher can walk through the choice. These tests pin what it clears,
 * what it leaves alone, and that an evaluation still in flight for the old
 * answer cannot land on the reset hand.
 */

const wasmMock = vi.hoisted(() => ({
  gradedJson: JSON.stringify({
    mode: 'book_only',
    book: null,
    mortal: null,
    outcome: 'ungraded',
  }),
  gradeCalls: 0,
}));

vi.mock('riichiprac', () => ({
  grade_answer_json: vi.fn(() => {
    wasmMock.gradeCalls += 1;
    return wasmMock.gradedJson;
  }),
}));

vi.mock('../wasm', () => ({ ensureWasmReady: async () => undefined }));

import type { AiEvaluation } from '../types/ai';
import type { GameState, PlayerState } from '../types/game';
import { useGameStore } from './useGameStore';
import type { MortalClient } from '../services/mortalClient';

const HUMAN: PlayerState = {
  seat: 0,
  name: 'You',
  is_human: true,
  wind: 'East',
  score: 25000,
  hand: ['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '2z', '3z', '4z'],
  draw: '9p',
  red_fives: [],
  discards: [],
  melds: [],
  is_riichi: false,
  riichi_discard_index: null,
};

function otherPlayer(seat: 1 | 2 | 3): PlayerState {
  return {
    ...HUMAN,
    seat,
    name: `P${seat}`,
    is_human: false,
    hand: ['1m', '1m', '1m', '1m', '1m', '1m', '1m', '1m', '1m', '1m'],
    draw: null,
  };
}

/** A complete engine payload, so the store's own validation accepts it. */
function state(overrides: Partial<GameState> = {}): GameState {
  return {
    category: 'fold_to_riichi',
    target_action: 'Fold',
    correct_action: { type: 'fold', discard: '1z' },
    decision: { kind: 'react_to_discard', from: 1, tile: '5z' },
    riichi_triggers: [],
    dama_reasons: [],
    shouminkan_triggers: [],
    hand_string: HUMAN.hand.join(''),
    tiles: [...HUMAN.hand, HUMAN.draw ?? ''],
    shanten: 1,
    is_agari: false,
    decompositions_count: 1,
    ukeire_tiles: [],
    ukeire_total: 0,
    round_wind: 'East',
    hand_number: 1,
    honba: 0,
    riichi_sticks: 0,
    dora_indicators: [],
    ura_dora_indicators: [],
    tiles_remaining: 60,
    current_turn: 1,
    can_riichi: false,
    players: [HUMAN, otherPlayer(1), otherPlayer(2), otherPlayer(3)],
    ...overrides,
  };
}

function evaluation(recommended: string): AiEvaluation {
  return {
    model: 'mortal_298k.safetensors',
    expected_value: 0.1,
    recommended_action: recommended,
    riichi_discard: null,
    evaluations: [],
  };
}

/** A Mortal client whose forward passes the test resolves by hand. */
function pendingMortal() {
  let resolveFirst: ((value: AiEvaluation) => void) | null = null;
  const evaluate = vi.fn(
    () =>
      new Promise<AiEvaluation>((resolve) => {
        if (!resolveFirst) {
          resolveFirst = resolve;
          return;
        }
        resolve(evaluation('Discard_9p'));
      }),
  );
  const mortal: MortalClient = {
    init: async () => undefined,
    evaluate,
    generateHotseatPuzzle: async () => '',
    generatePuzzleWithAgreement: async () => '',
    terminate: () => undefined,
  };
  return {
    mortal,
    evaluate,
    resolveFirst: (value: AiEvaluation) => resolveFirst?.(value),
  };
}

/** Let the store's `setTimeout(0)` paint wait and its awaits settle. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  useGameStore.getState().reset();
  useGameStore.setState({ mortal: null, aiStatus: 'idle', aiError: null });
  wasmMock.gradeCalls = 0;
  wasmMock.gradedJson = JSON.stringify({
    mode: 'book_only',
    book: null,
    mortal: null,
    outcome: 'ungraded',
  });
});

describe('resetAnswer', () => {
  it('returns the same table to unanswered without re-dealing it', () => {
    useGameStore.getState().loadFromJson(JSON.stringify(state()));
    const table = useGameStore.getState().gameState;
    expect(table).not.toBeNull();

    useGameStore.setState({
      callPreview: [{ code: '1z', isRed: false }],
    });
    useGameStore.getState().submitAnswer({ action: 'fold', tile: '1z' });
    useGameStore.getState().peekMortal();

    const answered = useGameStore.getState();
    expect(answered.submittedAnswer).not.toBeNull();
    expect(answered.dualGrade).not.toBeNull();
    expect(answered.peekedBeforeAnswer).toBe(true);

    useGameStore.getState().resetAnswer();

    const reset = useGameStore.getState();
    // The same object, not a re-parsed or regenerated hand.
    expect(reset.gameState).toBe(table);
    expect(reset.submittedAnswer).toBeNull();
    expect(reset.dualGrade).toBeNull();
    expect(reset.peekedBeforeAnswer).toBe(false);
    expect(reset.callPreview).toBeNull();
    expect(reset.pendingCall).toBeNull();
    expect(reset.evaluation).toBeNull();
    expect(reset.isEvaluating).toBe(false);
  });

  it('grades the second answer normally', () => {
    useGameStore.getState().loadFromJson(JSON.stringify(state()));
    useGameStore.getState().submitAnswer({ action: 'fold', tile: '1z' });
    expect(wasmMock.gradeCalls).toBe(1);

    useGameStore.getState().resetAnswer();
    useGameStore.getState().submitAnswer({ action: 'fold', tile: '2z' });

    const after = useGameStore.getState();
    expect(wasmMock.gradeCalls).toBe(2);
    expect(after.submittedAnswer?.tile).toBe('2z');
    expect(after.dualGrade).not.toBeNull();
  });

  it('keeps an AI drill’s own ranking, which belongs to the table', () => {
    const aiDecision = {
      model: 'mortal_298k.safetensors',
      expected_value: 0.2,
      recommended_action: 'Discard_9p',
      riichi_discard: null,
      evaluations: [],
      actions: [],
    };
    useGameStore
      .getState()
      .loadFromJson(JSON.stringify(state({ ai_decision: aiDecision })));

    useGameStore.getState().submitAnswer({ action: 'fold', tile: '1z' });
    useGameStore.getState().resetAnswer();

    const reset = useGameStore.getState();
    expect(reset.submittedAnswer).toBeNull();
    expect(reset.dualGrade).toBeNull();
    // Re-seeded from `ai_decision`, so a drill can be graded again at once.
    expect(reset.evaluation?.recommended_action).toBe('Discard_9p');
  });

  it('ignores an evaluation that was in flight when the answer was reset', async () => {
    const fake = pendingMortal();
    useGameStore.setState({ mortal: fake.mortal });

    useGameStore.getState().loadFromJson(JSON.stringify(state()));
    // Let the first forward pass start and block inside the fake worker.
    await settle();
    expect(fake.evaluate).toHaveBeenCalledTimes(1);

    useGameStore.getState().submitAnswer({ action: 'fold', tile: '1z' });
    useGameStore.getState().resetAnswer();

    // The reset hand asks for its own evaluation; resolve that one first, then
    // the stale pass that belonged to the answered hand.
    await settle();
    expect(fake.evaluate).toHaveBeenCalledTimes(2);
    fake.resolveFirst(evaluation('Discard_1m'));
    await settle();

    const reset = useGameStore.getState();
    // The stale result did not land, and it could not re-grade the reset hand.
    expect(reset.evaluation?.recommended_action).toBe('Discard_9p');
    expect(reset.submittedAnswer).toBeNull();
    expect(reset.dualGrade).toBeNull();
    expect(reset.isEvaluating).toBe(false);
  });
});
