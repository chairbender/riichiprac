// @vitest-environment jsdom
/**
 * The 3D result card (3D-H5): the compact answer, and the only way to expand it.
 *
 * What this file proves, as DOM facts:
 *
 * - the outcome row is the 2D dock's `AnswerSummary` word for word (headline,
 *   detail, chips, Details label) for the same grade — the drift test;
 * - the card adds the book-vs-Mortal picks line and the outcome tone;
 * - the card is not a live region: the HUD's persistent announcer owns that, so
 *   mounting the card around the verdict sheet cannot re-announce;
 * - Details is the sheet trigger, and the answer's focus lands on it when the
 *   control that had focus went away with the answer.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnswerSummary } from '../../components/AnswerSummary';
import type { GameState, PlayerState } from '../../types/game';
import type { DualGrade } from '../../types/verdict';
import { ResultCard } from './ResultCard';

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

function state(overrides: Partial<GameState> = {}): GameState {
  return {
    category: 'riichi_or_dama',
    target_action: 'Riichi',
    correct_action: { type: 'riichi', discard: '9p' },
    decision: { kind: 'self_turn' },
    riichi_triggers: ['good_wait'],
    dama_reasons: [],
    shouminkan_triggers: [],
    hand_string: HUMAN.hand.join(''),
    tiles: [...HUMAN.hand, '9p'],
    shanten: 0,
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
    current_turn: 0,
    can_riichi: true,
    players: [HUMAN],
    ...overrides,
  };
}

const GRADE: DualGrade = {
  mode: 'book_and_mortal',
  outcome: 'book_agrees_mortal_does_not',
  book: {
    is_action_correct: true,
    is_tile_correct: true,
    expected_action: 'riichi',
    expected_tile: '9p',
  },
  mortal: {
    model: 'mortal_298k.safetensors',
    recommended_action: 'Discard_1m',
    recommended_base: 'Discard_1m',
    recommended_label: 'Discard 1m',
    recommended_riichi: false,
    answer_action: 'Riichi',
    matches_action: false,
    matches_tile: false,
    agrees: false,
    answer_probability: 0.12,
    top_probability: 0.64,
    confidence: 'high',
    close_second: false,
  },
};

function readSummary(root: HTMLElement) {
  return {
    headline: root.querySelector('.answer-summary-headline')?.textContent,
    detail: root.querySelector('.answer-summary-detail')?.textContent,
    chips: [...root.querySelectorAll('.answer-summary-chip')].map((chip) => ({
      text: chip.textContent,
      label: chip.getAttribute('aria-label'),
    })),
    details: {
      text: root.querySelector('.answer-summary-details')?.textContent,
      label: root
        .querySelector('.answer-summary-details')
        ?.getAttribute('aria-label'),
    },
  };
}

afterEach(cleanup);

describe('3D result card: the compact result', () => {
  it('uses the 2D answer summary’s words and labels for the same grade', () => {
    const twoD = render(
      <AnswerSummary grade={GRADE} onDetails={() => undefined} />,
    );
    const expected = readSummary(twoD.container as HTMLElement);
    cleanup();

    const card = render(
      <ResultCard grade={GRADE} state={state()} onDetails={() => undefined} onNext={() => undefined} onReset={() => undefined} />,
    );
    expect(readSummary(card.container as HTMLElement)).toEqual(expected);
  });

  it('adds the book-versus-Mortal pick line without painting an inner box', () => {
    const { container } = render(
      <ResultCard grade={GRADE} state={state()} onDetails={() => undefined} onNext={() => undefined} onReset={() => undefined} />,
    );
    const content = container.querySelector('.hud-result-card-content');
    // The outcome tone belongs to the whole panel (HudLayer), not this box: an
    // inner outline was what sat against the card's buttons.
    expect(content?.getAttribute('data-tone')).toBeNull();
    expect(container.querySelector('.hud-result-card__picks')?.textContent).toBe(
      'Book: Riichi · discard 9p · Mortal: Discard 1m',
    );
  });

  it('names only the perspective that exists', () => {
    const { container, rerender } = render(
      <ResultCard
        grade={{ ...GRADE, book: null, mortal: GRADE.mortal, outcome: 'only_available_agrees', mode: 'mortal_only' }}
        state={state({
          correct_action: {
            type: 'best',
            action: 'Discard_1m',
            label: 'Discard 1m',
          },
        })}
        onDetails={() => undefined}
        onNext={() => undefined}
        onReset={() => undefined}
      />,
    );
    expect(container.querySelector('.hud-result-card__picks')?.textContent).toBe(
      'Mortal: Discard 1m',
    );

    rerender(
      <ResultCard
        grade={{ ...GRADE, mortal: null, outcome: 'only_available_agrees', mode: 'book_only' }}
        state={state()}
        onDetails={() => undefined}
        onNext={() => undefined}
        onReset={() => undefined}
      />,
    );
    expect(container.querySelector('.hud-result-card__picks')?.textContent).toBe(
      'Book: Riichi · discard 9p',
    );
  });

  it('is not a live region: the HUD’s announcer speaks once', () => {
    const { container } = render(
      <ResultCard grade={GRADE} state={state()} onDetails={() => undefined} onNext={() => undefined} onReset={() => undefined} />,
    );
    // The summary's own polite region is suppressed in the 3D card.
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(0);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
  });

  it('opens the verdict only through Details', () => {
    const onDetails = vi.fn();
    render(<ResultCard grade={GRADE} state={state()} onDetails={onDetails} onNext={() => undefined} onReset={() => undefined} />);
    const details = screen.getByRole('button', {
      name: 'Show the full book and Mortal comparison',
    });
    fireEvent.click(details);
    expect(onDetails).toHaveBeenCalledTimes(1);
  });

  it('carries its own Next control, so the corner is not the only way on', () => {
    const onNext = vi.fn();
    const { rerender } = render(
      <ResultCard
        grade={GRADE}
        state={state()}
        onDetails={() => undefined}
        onNext={onNext}
        onReset={() => undefined}
      />,
    );
    const next = screen.getByRole('button', { name: 'Next scenario' });
    expect(next.textContent).toBe('Next Scenario');
    fireEvent.click(next);
    expect(onNext).toHaveBeenCalledTimes(1);

    rerender(
      <ResultCard
        grade={GRADE}
        state={state()}
        onDetails={() => undefined}
        onNext={onNext}
        onReset={() => undefined}
        nextDisabled
      />,
    );
    expect(
      (screen.getByRole('button', { name: 'Next scenario' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('pairs Reset with Next, so the same hand can be tried again', () => {
    const onReset = vi.fn();
    render(
      <ResultCard
        grade={GRADE}
        state={state()}
        onDetails={() => undefined}
        onNext={() => undefined}
        onReset={onReset}
      />,
    );
    const reset = screen.getByRole('button', { name: 'Reset this answer' });
    // Beside Next in the card's action row, before it: Next stays the primary
    // control at the row's end.
    const next = screen.getByRole('button', { name: 'Next scenario' });
    expect(reset.parentElement).toBe(next.parentElement);
    expect(reset.nextElementSibling).toBe(next);
    expect(reset.textContent).toBe('Reset');
    fireEvent.click(reset);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('takes focus when the answer removed the focused control', () => {
    render(<ResultCard grade={GRADE} state={state()} onDetails={() => undefined} onNext={() => undefined} onReset={() => undefined} />);
    expect(document.activeElement).toBe(
      screen.getByRole('button', {
        name: 'Show the full book and Mortal comparison',
      }),
    );
  });

  it('leaves focus alone when a valid target still holds it', () => {
    const outside = document.createElement('button');
    outside.textContent = 'elsewhere';
    document.body.append(outside);
    outside.focus();
    try {
      render(
        <ResultCard grade={GRADE} state={state()} onDetails={() => undefined} onNext={() => undefined} onReset={() => undefined} />,
      );
      expect(document.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });
});
