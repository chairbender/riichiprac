// @vitest-environment jsdom
/**
 * The HUD hand rail (3D-H3): the hint row's content and its boundaries.
 *
 * What this file proves, as DOM facts:
 *
 * - the hint is the dock's own wording (`handHintFor`) in a polite live region;
 * - the pre-answer Mortal chip states Mortal's condition in two words and is
 *   gone once the answer exists (the result card owns the marks, H5);
 * - the rail renders **no buttons at all** — in 3D the only hand controls are
 *   3D-08's projected ones, and no summary or Next control is duplicated here
 *   (`3d_hud.md` §4 supersedes the draft task text on both counts).
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HandRail } from './HandRail';
import { mortalChip } from './handRail';
import type { HandRailProps } from './HandRail';

function rail(overrides: Partial<HandRailProps> = {}) {
  return (
    <HandRail
      hint="Tap a tile to discard"
      aiStatus="ready"
      isEvaluating={false}
      hasEvaluation
      peeked={false}
      answered={false}
      {...overrides}
    />
  );
}

/** The chip's state and words, or null. */
function chipFor(overrides: Partial<HandRailProps>): string | null {
  const chip = mortalChip({
    aiStatus: 'ready',
    isEvaluating: false,
    hasEvaluation: true,
    peeked: false,
    answered: false,
    ...overrides,
  });
  return chip ? `${chip.state}: ${chip.text}` : null;
}

afterEach(cleanup);

describe('3D hand rail: the hint row', () => {
  it('renders the hint as a polite live region, with the dock’s wording', () => {
    const { container } = render(rail());
    const hint = container.querySelector('.hud-hand-rail__hint');
    expect(hint).not.toBeNull();
    expect(hint?.getAttribute('aria-live')).toBe('polite');
    expect(hint?.textContent).toBe('Tap a tile to discard');
  });

  it('renders no button at all: the hand controls belong to the scene', () => {
    const { container } = render(rail());
    expect(within(container).queryAllByRole('button')).toHaveLength(0);
    // In particular no summary and no second Next control (§4).
    expect(container.querySelector('.answer-summary')).toBeNull();
    expect(container.querySelector('.new-hand-button')).toBeNull();
    expect(container.querySelector('.hand-tile-button')).toBeNull();
    expect(container.textContent).not.toMatch(/Next Scenario/);
  });

  it('carries the armed wording it is given, without rewording it', () => {
    render(rail({ hint: 'Riichi selected - tap a tile to discard' }));
    expect(
      screen.getByText('Riichi selected - tap a tile to discard'),
    ).toBeTruthy();
  });
});

describe('3D hand rail: the pre-answer Mortal chip', () => {
  it('states each condition in two words', () => {
    expect(chipFor({ aiStatus: 'error' })).toBe(
      'unavailable: Mortal unavailable',
    );
    expect(chipFor({ isEvaluating: true })).toBe('thinking: Mortal thinking…');
    expect(chipFor({ aiStatus: 'loading', hasEvaluation: false })).toBe(
      'loading: Mortal loading…',
    );
    expect(chipFor({ peeked: true })).toBe('revealed: Mortal revealed');
    expect(chipFor({})).toBe('ready: Mortal ready');
    expect(chipFor({ hasEvaluation: false })).toBe('loading: Mortal waiting');
  });

  it('is gone after the answer, where the result card owns the marks', () => {
    expect(chipFor({ answered: true })).toBeNull();
    const { container } = render(rail({ answered: true }));
    expect(container.querySelector('.hud-mortal-chip')).toBeNull();
  });

  it('is not a second live region', () => {
    const { container } = render(rail({ isEvaluating: true }));
    const chip = container.querySelector('.hud-mortal-chip');
    expect(chip?.hasAttribute('aria-live')).toBe(false);
    expect(chip?.getAttribute('role')).toBeNull();
    // Exactly one live region in the row.
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(1);
  });

  it('opens the verdict sheet from the chip (3D-H5)', () => {
    const onOpenVerdict = vi.fn();
    render(rail({ onOpenVerdict }));
    const trigger = screen.getByRole('button', {
      name: 'Mortal ready: open the verdict',
    });
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    fireEvent.click(trigger);
    expect(onOpenVerdict).toHaveBeenCalledTimes(1);
    // The only button the rail adds is the sheet trigger: no hand control.
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(trigger.classList.contains('hud-mortal-chip')).toBe(true);
  });

  it('can stop announcing the hint once the result card owns the message', () => {
    const { container } = render(rail({ answered: true, announceHint: false }));
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(0);
  });
});
