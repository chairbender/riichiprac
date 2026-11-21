// @vitest-environment jsdom
/**
 * The 2D meld list and a closed kan (261121-1713).
 *
 * The 3D board lays an ankan's two outer tiles face down and shows the middle
 * two (`renderers/snapshot.ts`); the stacked and top-down views must agree. The
 * assertions are DOM/ARIA only: which slots carry a face-down back, which show
 * a face, and that a Pon keeps all three faces with its called tile sideways.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MeldList } from './MeldList';
import type { CalledMeld, PlayerState } from '../types/game';

/*
 * The tile package bundles its own React copy, and an element from React 19's
 * jsx runtime is not a valid child of this app's React 18 tree. Every export
 * becomes a plain SVG that forwards its props, so `Tile` and `TileBack` still
 * carry their aria-labels: this file tests which slots get a back, not the art.
 */
vi.mock('riichi-mahjong-tiles', async (importOriginal) => {
  const { createElement } = await import('react');
  const actual = await importOriginal<Record<string, unknown>>();
  const Glyph = (props: Record<string, unknown>) => createElement('svg', props);
  return Object.fromEntries(Object.keys(actual).map((name) => [name, Glyph]));
});

afterEach(cleanup);

function player(melds: CalledMeld[]): PlayerState {
  return {
    seat: 0,
    name: 'You',
    is_human: true,
    wind: 'East',
    score: 25_000,
    hand: [],
    draw: null,
    red_fives: [],
    discards: [],
    melds,
    is_riichi: false,
    riichi_discard_index: null,
  };
}

/** The four (or three) slots of one meld, left to right. */
function slots(meld: HTMLElement): HTMLElement[] {
  return Array.from(meld.querySelectorAll<HTMLElement>('.meld-slot'));
}

describe('MeldList closed kan', () => {
  it('sets an ankan as two face-down ends and two showing middle tiles', () => {
    render(
      <MeldList player={player([{ meld_type: 'Ankan', tiles: ['2m', '2m', '2m', '2m'], called_from: null }])} />,
    );

    const meld = screen.getByLabelText('Ankan meld');
    const [first, second, third, fourth] = slots(meld);

    // The ends are backs: no face name reaches the screen reader.
    expect(
      within(first).queryByRole('img', { name: 'face-down tile' }),
    ).not.toBeNull();
    expect(
      within(fourth).queryByRole('img', { name: 'face-down tile' }),
    ).not.toBeNull();

    // The middle two show the tile, so the meld still names its kind.
    expect(within(second).queryByRole('img', { name: '2m' })).not.toBeNull();
    expect(within(third).queryByRole('img', { name: '2m' })).not.toBeNull();

    // Exactly two of each: the concealed copies never read as a visible face.
    expect(within(meld).getAllByRole('img', { name: 'face-down tile' })).toHaveLength(2);
    expect(within(meld).getAllByRole('img', { name: '2m' })).toHaveLength(2);
    expect(first.classList.contains('meld-slot--back')).toBe(true);
    expect(fourth.classList.contains('meld-slot--back')).toBe(true);
  });

  it('leaves a Pon face up with its called tile sideways', () => {
    // Seat 3 is kamicha of seat 0, so the call is drawn on the left.
    render(
      <MeldList player={player([{ meld_type: 'Pon', tiles: ['3p', '3p', '3p'], called_from: 3 }])} />,
    );

    const meld = screen.getByLabelText(
      'Pon meld, called tile taken from the left player (kamicha)',
    );
    const [first, second, third] = slots(meld);

    expect(within(meld).queryAllByRole('img', { name: 'face-down tile' })).toHaveLength(0);
    expect(within(meld).getAllByRole('img', { name: '3p' })).toHaveLength(3);
    expect(first.classList.contains('meld-slot--called')).toBe(true);
    expect(second.classList.contains('meld-slot--called')).toBe(false);
    expect(third.classList.contains('meld-slot--called')).toBe(false);
    expect(first.classList.contains('meld-slot--back')).toBe(false);
    expect(second.classList.contains('meld-slot--back')).toBe(false);
    expect(third.classList.contains('meld-slot--back')).toBe(false);
  });

  it('leaves an open kan face up with its called tile sideways', () => {
    // A shimocha call puts the sideways tile in the last of four slots.
    render(
      <MeldList player={player([{ meld_type: 'Kan', tiles: ['7z', '7z', '7z', '7z'], called_from: 1 }])} />,
    );

    const meld = screen.getByLabelText(
      'Kan meld, called tile taken from the right player (shimocha)',
    );
    const meldSlots = slots(meld);

    expect(within(meld).queryAllByRole('img', { name: 'face-down tile' })).toHaveLength(0);
    expect(within(meld).getAllByRole('img', { name: 'R' })).toHaveLength(4);
    expect(meldSlots[3].classList.contains('meld-slot--called')).toBe(true);
    expect(
      meldSlots.filter((slot) => slot.classList.contains('meld-slot--back')),
    ).toHaveLength(0);
  });
});
