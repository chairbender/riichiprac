// @vitest-environment jsdom
/**
 * Answer reset: the Reset control after an answer, and Back/Forward.
 *
 * Two flows that must agree:
 *
 * - Reset returns the hand on screen to its unanswered state with the same
 *   `GameState` (no re-deal), so it can be answered and graded again;
 * - Back/Forward restores the table, never the finished answer: the stored
 *   snapshot's answer, verdict, peek and evaluation are stripped, and the hand
 *   is still the same table with no regeneration.
 *
 * The 3D view's copy of the control is covered alongside the HUD in
 * `App.renderer3d.hud.test.tsx`; the shared control itself in `ResultCard.test`.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wasmMock = vi.hoisted(() => ({
  generatedQueue: [] as string[],
  generatedJson: '{}',
  gradedJson: '{}',
  generateCalls: 0,
  gradeCalls: 0,
}));

vi.mock('riichiprac', () => ({
  generate_puzzle: vi.fn(() => {
    wasmMock.generateCalls += 1;
    return wasmMock.generatedQueue.shift() ?? wasmMock.generatedJson;
  }),
  list_scenarios: vi.fn(() =>
    JSON.stringify([
      {
        id: 'fold_to_riichi',
        label: 'Fold to Riichi',
        description: 'Defense: pick the safest discard against Riichi.',
        category: 'defense_decision',
        tags: ['defense', 'fold', 'discard'],
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
  ),
  grade_answer_json: vi.fn(() => {
    wasmMock.gradeCalls += 1;
    return wasmMock.gradedJson;
  }),
  parse_scenario_report: vi.fn(() => JSON.stringify({ error: 'not used' })),
}));

vi.mock('./wasm', () => ({ ensureWasmReady: async () => undefined }));

vi.mock('./services/weightLoader', () => ({
  WEIGHTS_FILENAME: 'mortal_298k.safetensors',
  loadWeights: async () => {
    throw new Error('weights unavailable in this test');
  },
}));

vi.mock('./components/Tile', () => ({ Tile: () => null }));

import { App } from './App';
import { readScenarioSnapshot } from './scenarioHistory';
import { useGameStore } from './store/useGameStore';
import { useSettingsStore } from './store/useSettingsStore';
import type { AiEvaluation } from './types/ai';
import type { GameState, PlayerState } from './types/game';

const GRADE = JSON.stringify({
  mode: 'book_only',
  book: {
    is_action_correct: true,
    is_tile_correct: true,
    expected_action: 'fold',
    expected_tile: '1z',
  },
  mortal: null,
  outcome: 'only_available_agrees',
});

const EVALUATION: AiEvaluation = {
  model: 'mortal_298k.safetensors',
  expected_value: 0.1,
  recommended_action: 'Discard_1z',
  riichi_discard: null,
  evaluations: [],
};

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

/** One complete engine payload; `hand` distinguishes the two history hands. */
function state(hand: string, overrides: Partial<GameState> = {}): GameState {
  const tiles = hand.split(/(?<=[mpsz])/);
  return {
    category: 'fold_to_riichi',
    target_action: 'Fold',
    correct_action: { type: 'fold', discard: '1z' },
    decision: { kind: 'react_to_discard', from: 1, tile: '5z' },
    riichi_triggers: [],
    dama_reasons: [],
    shouminkan_triggers: [],
    hand_string: tiles.slice(0, 13).join(''),
    tiles,
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
    players: [
      { ...HUMAN, hand: tiles.slice(0, 13), draw: tiles[13] ?? null },
      otherPlayer(1),
      otherPlayer(2),
      otherPlayer(3),
    ],
    ...overrides,
  };
}

const HAND_A = state('1m2m3m4p5p6p7s8s9s2z3z4z9p');
const HAND_B = state('2m3m4m5p6p7p8s9s1z2z3z4z1p', {
  category: 'fold_to_riichi_2',
});

async function deal(hand: GameState = HAND_A) {
  wasmMock.generatedQueue = [JSON.stringify(hand)];
  wasmMock.generatedJson = JSON.stringify(hand);
  window.history.replaceState(null, '', '/');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline in test');
    }),
  );
  const rendered = render(<App />);
  await waitFor(() => expect(useGameStore.getState().gameState).not.toBeNull());
  return rendered;
}

/** Submit the first tile from the dock, the way a player answers. */
async function answerByClick() {
  const tile = screen.getAllByRole('button', {
    name: /^Discard /,
  })[0] as HTMLButtonElement;
  await act(async () => {
    fireEvent.click(tile);
  });
}

function unansweredStore() {
  const store = useGameStore.getState();
  return {
    submittedAnswer: store.submittedAnswer,
    dualGrade: store.dualGrade,
    peekedBeforeAnswer: store.peekedBeforeAnswer,
    evaluation: store.evaluation,
  };
}

beforeEach(() => {
  useGameStore.getState().reset();
  useGameStore.setState({ mortal: null, aiStatus: 'idle', aiError: null });
  // The 2D dock path is the subject here; the 3D card is covered separately.
  useSettingsStore.setState({ view: 'stacked' });
  wasmMock.gradedJson = GRADE;
  wasmMock.generatedQueue = [];
  wasmMock.generateCalls = 0;
  wasmMock.gradeCalls = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
  useGameStore.getState().reset();
  useGameStore.setState({ mortal: null, aiStatus: 'idle', aiError: null });
  useSettingsStore.setState({ view: 'stacked' });
});

describe('Reset after an answer (2D dock)', () => {
  it('shows Reset beside Next and returns the same hand to unanswered', async () => {
    const { container } = await deal();
    const table = useGameStore.getState().gameState;
    const dealsBefore = wasmMock.generateCalls;

    // Reset only exists after an answer.
    expect(
      screen.queryByRole('button', { name: 'Reset this answer' }),
    ).toBeNull();

    await answerByClick();
    expect(useGameStore.getState().dualGrade).not.toBeNull();
    expect(container.querySelector('.answer-summary')).not.toBeNull();

    const dock = container.querySelector('.hand-dock') as HTMLElement;
    const reset = within(dock).getByRole('button', {
      name: 'Reset this answer',
    });
    const next = within(dock).getByRole('button', { name: 'Next scenario' });
    // One control row, Reset first and Next keeping the primary slot.
    expect(reset.parentElement).toBe(next.parentElement);
    expect(reset.nextElementSibling).toBe(next);

    await act(async () => {
      fireEvent.click(reset);
    });

    expect(unansweredStore()).toEqual({
      submittedAnswer: null,
      dualGrade: null,
      peekedBeforeAnswer: false,
      evaluation: null,
    });
    // No re-deal: the very same table object is still on screen.
    expect(useGameStore.getState().gameState).toBe(table);
    expect(wasmMock.generateCalls).toBe(dealsBefore);
    expect(container.querySelector('.answer-summary')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Reset this answer' }),
    ).toBeNull();
    // The hand is tappable again.
    const tiles = screen.getAllByRole('button', { name: /^Discard / });
    expect(tiles.every((tile) => !(tile as HTMLButtonElement).disabled)).toBe(
      true,
    );
  });

  it('grades the second answer normally', async () => {
    await deal();
    await answerByClick();
    const gradesAfterFirst = wasmMock.gradeCalls;

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reset this answer' }));
    });
    await answerByClick();

    expect(wasmMock.gradeCalls).toBe(gradesAfterFirst + 1);
    expect(useGameStore.getState().dualGrade).not.toBeNull();
    expect(useGameStore.getState().submittedAnswer).not.toBeNull();
  });
});

describe('Back/Forward restores the hand unanswered', () => {
  it('lands on the same table with no verdict, peek or evaluation, and no re-deal', async () => {
    const { container } = await deal(HAND_A);

    // Answer hand A and keep the answered history state the browser would
    // navigate back to.
    await answerByClick();
    await act(async () => {
      useGameStore.setState({
        evaluation: EVALUATION,
        peekedBeforeAnswer: true,
      });
    });
    const answeredA = window.history.state;

    // Deal hand B and answer it too.
    wasmMock.generatedQueue = [JSON.stringify(HAND_B)];
    const header = container.querySelector('.app-header') as HTMLElement;
    await act(async () => {
      fireEvent.click(
        within(header).getByRole('button', { name: 'Next scenario' }),
      );
    });
    await waitFor(() =>
      expect(useGameStore.getState().gameState?.category).toBe(
        'fold_to_riichi_2',
      ),
    );
    await answerByClick();
    const answeredB = window.history.state;
    const dealsBefore = wasmMock.generateCalls;

    expect(readScenarioSnapshot(answeredA)?.dualGrade).not.toBeNull();
    expect(readScenarioSnapshot(answeredA)?.peekedBeforeAnswer).toBe(true);
    expect(readScenarioSnapshot(answeredB)?.dualGrade).not.toBeNull();

    // Back to A: the browser supplies A's entry, answered.
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: answeredA }));
    });
    await waitFor(() =>
      expect(useGameStore.getState().gameState?.category).toBe(
        'fold_to_riichi',
      ),
    );
    expect(unansweredStore()).toEqual({
      submittedAnswer: null,
      dualGrade: null,
      peekedBeforeAnswer: false,
      evaluation: null,
    });
    expect(container.querySelector('.answer-summary')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Reset this answer' }),
    ).toBeNull();

    // Forward to B: answered on the way in, unanswered on arrival.
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: answeredB }));
    });
    await waitFor(() =>
      expect(useGameStore.getState().gameState?.category).toBe(
        'fold_to_riichi_2',
      ),
    );
    expect(unansweredStore()).toEqual({
      submittedAnswer: null,
      dualGrade: null,
      peekedBeforeAnswer: false,
      evaluation: null,
    });
    // No regeneration and no fresh Mortal pass for either restore.
    expect(wasmMock.generateCalls).toBe(dealsBefore);
    // The entry now describes the hand on screen unanswered, so another
    // Back/Forward cannot bring the finished answer back.
    const rewritten = readScenarioSnapshot(window.history.state);
    expect(rewritten?.json).toBe(JSON.stringify(HAND_B));
    expect(rewritten?.submittedAnswer).toBeNull();
    expect(rewritten?.dualGrade).toBeNull();
  });
});
