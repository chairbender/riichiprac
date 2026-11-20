// @vitest-environment jsdom
/**
 * The 3D verdict sheet body (3D-H5).
 *
 * The sheet primitive is H2's and is tested there (dialog, focus trap, Escape,
 * inert scene). This file proves the body is the 2D `VerdictPanel` unchanged:
 *
 * - the same grade columns, `ActionRanking`, `CallReport`,
 *   `ScenarioExplanation`, outcome band and peek/retry content;
 * - pre-answer it shows the status line and Peek, and calling Peek does not
 *   submit or grade anything;
 * - post-answer it is literally the same panel markup a 2D view would render.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VerdictPanel } from '../../components/VerdictPanel';
import type { AiEvaluation } from '../../types/ai';
import type { BookCitation, GameState, PlayerState } from '../../types/game';
import type { DualGrade } from '../../types/verdict';
import { VerdictSheet } from './VerdictSheet';
import type { VerdictSheetProps } from './VerdictSheet';

const HUMAN: PlayerState = {
  seat: 0,
  name: 'You',
  is_human: true,
  wind: 'East',
  score: 25000,
  hand: ['2m', '3m', '4m', '5p', '6p', '7p', '3s', '4s', '5s', '6z', '6z', '1z'],
  draw: '2z',
  red_fives: [],
  discards: [],
  melds: [],
  is_riichi: false,
  riichi_discard_index: null,
};

const CITATION: BookCitation = {
  book: 'Riichi Book 1',
  chapter: 9,
  chapter_title: 'Call decisions',
  section: '1',
  source_file: 'RiichiBook1-ch9-call.tex',
  source_line: 42,
  source_needle: 'Pon',
};

function state(overrides: Partial<GameState> = {}): GameState {
  return {
    category: 'call_pon_or_pass',
    target_action: 'Call',
    correct_action: { type: 'pass' },
    call_offer: { action: 'Pon', label: 'Pon 6z', tile: '6z' },
    decision: { kind: 'react_to_discard', from: 2, tile: '6z' },
    riichi_triggers: [],
    dama_reasons: [],
    shouminkan_triggers: [],
    hand_string: HUMAN.hand.join(''),
    tiles: [...HUMAN.hand, '2z'],
    shanten: 2,
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
    tiles_remaining: 42,
    current_turn: 2,
    can_riichi: false,
    players: [HUMAN],
    book_rationale: {
      summary: 'The Pon leaves the hand further from ready than passing does.',
      rules: [
        {
          id: 'keep_the_shape',
          rule: 'Do not call when the call does not bring the hand closer to ready.',
          quote: 'A call that does not improve the hand is a loss of tempo.',
          citation: CITATION,
          applies: 'The Pon would consume the only honour pair.',
        },
      ],
      absent: [{ id: 'dealer', note: 'Not the dealer.' }],
      source: CITATION,
      caveats: ['Assumes no riichi on the table.'],
    },
    ...overrides,
  };
}

const EVALUATION: AiEvaluation = {
  model: 'mortal_298k.safetensors',
  expected_value: 0.31,
  recommended_action: 'Pass',
  evaluations: [
    { action: 'Pass', label: 'Pass', type: 'pass', probability: 0.71 },
    { action: 'Pon', label: 'Pon 6z', type: 'pon', probability: 0.24 },
    { action: 'Discard_1z', label: 'Discard 1z', type: 'discard', probability: 0.05 },
  ],
};

const GRADE: DualGrade = {
  mode: 'book_and_mortal',
  outcome: 'both_agree',
  book: {
    is_action_correct: true,
    is_tile_correct: true,
    expected_action: 'pass',
    expected_tile: '',
  },
  mortal: {
    model: 'mortal_298k.safetensors',
    recommended_action: 'Pass',
    recommended_base: 'Pass',
    recommended_label: 'Pass',
    recommended_riichi: false,
    answer_action: 'Pass',
    matches_action: true,
    matches_tile: true,
    agrees: true,
    answer_probability: 0.71,
    top_probability: 0.71,
    confidence: 'high',
    close_second: false,
  },
};

function props(overrides: Partial<VerdictSheetProps> = {}): VerdictSheetProps {
  return {
    state: state(),
    grade: GRADE,
    evaluation: EVALUATION,
    aiStatus: 'ready',
    aiError: null,
    isEvaluating: false,
    peeked: false,
    redFives: [],
    onPeek: () => undefined,
    onRetry: () => undefined,
    ...overrides,
  };
}

afterEach(cleanup);

describe('3D verdict sheet body', () => {
  it('is the 2D VerdictPanel, unchanged, for the same grade', () => {
    const sheet = render(<VerdictSheet {...props()} />);
    const fromSheet = sheet.container.querySelector('.verdict-panel')?.outerHTML;
    cleanup();

    const direct = render(<VerdictPanel {...props()} />);
    const fromPanel = direct.container.querySelector('.verdict-panel')?.outerHTML;
    expect(fromSheet).toBe(fromPanel);
  });

  it('carries the grade columns, ranking, call report, explanation and band', () => {
    const { container } = render(<VerdictSheet {...props()} />);
    expect(container.querySelectorAll('.verdict-column')).toHaveLength(2);
    expect(container.querySelector('.verdict-column--book')).not.toBeNull();
    expect(container.querySelector('.verdict-column--mortal')).not.toBeNull();
    expect(container.querySelector('.book-rationale')).not.toBeNull();
    expect(container.querySelector('.book-rule-quote')?.textContent).toContain(
      'A call that does not improve the hand',
    );
    expect(container.querySelector('.call-report')).not.toBeNull();
    expect(container.querySelector('.verdict-ranking')).not.toBeNull();
    expect(container.querySelector('.verdict-band-chip')?.textContent).toBe(
      'Both agree',
    );
    expect(container.querySelectorAll('.verdict-mark')).toHaveLength(3);
  });

  it('pre-answer shows the status line and Peek, and Peek only reveals', () => {
    const onPeek = vi.fn();
    render(<VerdictSheet {...props({ grade: null, onPeek })} />);
    expect(
      screen.getByText('Mortal has an opinion about this hand. Answer first, or peek.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Peek' }));
    expect(onPeek).toHaveBeenCalledTimes(1);
    // Peeking is a view change; the sheet does not grade.
    expect(screen.queryByText('Both agree')).toBeNull();
  });

  it('offers Retry when Mortal is unavailable, before or after the answer', () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <VerdictSheet
        {...props({
          grade: null,
          aiStatus: 'error',
          aiError: 'weights missing',
          onRetry,
        })}
      />,
    );
    expect(screen.getByText(/Mortal unavailable/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    // Post-answer with no Mortal grade: the book column still grades, and the
    // Mortal column offers Retry instead of a recommendation.
    rerender(
      <VerdictSheet
        {...props({
          grade: { ...GRADE, mortal: null, outcome: 'only_available_agrees', mode: 'book_only' },
          aiStatus: 'error',
          onRetry,
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(2);
  });
});
