// @vitest-environment jsdom
/**
 * `HandDock`'s phone-strip variant (3d_phone_layout_plan.md §4).
 *
 * The strip must be the *same hand*, not a second one: one button per
 * concealed tile plus the draw, the dock's own labels, the caller's handler
 * with the dock's own arguments, and none of the dock's other chrome (hint,
 * call toggles, Next). Those are DOM facts, so this is a DOM test.
 */

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayerState } from '../types/game';
import { HandDock } from './HandDock';

/*
 * The tile art is an SVG package whose components do not render under jsdom
 * (the same reason no other DOM test mounts a `Tile`). This file is about the
 * button wiring, so the art is a stand-in with the same props.
 */
vi.mock('./Tile', () => ({
  Tile: ({ code, className }: { code: string; className?: string }) => (
    <span data-testid="tile-art" data-code={code} className={className} />
  ),
}));

afterEach(cleanup);

function player(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    seat: 0,
    name: 'Human',
    is_human: true,
    wind: 'East',
    score: 25000,
    hand: ['1m', '2m', '3p', '4p', '5s', '6s', '7z', '1p', '9m', '2s', '3s', '4m', '5m'],
    draw: '6m',
    red_fives: [],
    discards: [],
    melds: [],
    is_riichi: false,
    riichi_discard_index: null,
    ...overrides,
  };
}

function renderDock(variant: 'dock' | 'strip', onSelectTile = vi.fn()) {
  const result = render(
    <HandDock
      variant={variant}
      player={player()}
      grade={null}
      answer={null}
      callRiichi={false}
      callKan={false}
      aiEvaluation={null}
      canDiscard
      canRiichi={false}
      onNextScenario={() => undefined}
      onShowVerdict={() => undefined}
      onToggleRiichi={() => undefined}
      onToggleKan={() => undefined}
      onSelectTile={onSelectTile}
    />,
  );
  return { ...result, onSelectTile };
}

describe('HandDock: the phone strip variant', () => {
  it('renders exactly one button per concealed tile plus the draw', () => {
    const { container } = renderDock('strip');
    const buttons = container.querySelectorAll('.hand-tile-button');
    expect(buttons).toHaveLength(14);
    // Nothing of the dock's own chrome comes along: the HUD owns those rows.
    expect(container.querySelector('.hand-dock')).toBeNull();
    expect(container.querySelector('.hand-dock-label')).toBeNull();
    expect(container.querySelector('.hand-tile-button')?.hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('keeps the dock labels and the dock handler arguments identical', () => {
    const dock = renderDock('dock');
    const dockLabels = [...dock.container.querySelectorAll('button')].map(
      (button) => button.getAttribute('aria-label'),
    );
    cleanup();

    const strip = renderDock('strip');
    const stripButtons = [
      ...strip.container.querySelectorAll<HTMLButtonElement>('.hand-tile-button'),
    ];
    expect(stripButtons.map((button) => button.getAttribute('aria-label'))).toEqual(
      dockLabels,
    );

    // The same `onSelectTile(code, index, isDraw)` the stacked view calls.
    fireEvent.click(stripButtons[0]);
    expect(strip.onSelectTile).toHaveBeenCalledTimes(1);
    const [code, index, isDraw] = strip.onSelectTile.mock.calls[0];
    expect(typeof code).toBe('string');
    expect(index).toBe(0);
    expect(typeof isDraw).toBe('boolean');
  });

  it('disables every tile once the hand is answered', () => {
    const answered = render(
      <HandDock
        variant="strip"
        player={player()}
        grade={
          {
            book: null,
            mortal: null,
            outcome: 'correct',
          } as unknown as Parameters<typeof HandDock>[0]['grade']
        }
        answer={null}
        callRiichi={false}
        callKan={false}
        aiEvaluation={null}
        canDiscard
        canRiichi={false}
        onNextScenario={() => undefined}
        onShowVerdict={() => undefined}
        onToggleRiichi={() => undefined}
        onToggleKan={() => undefined}
        onSelectTile={vi.fn()}
      />,
    );
    const buttons = [
      ...answered.container.querySelectorAll<HTMLButtonElement>('.hand-tile-button'),
    ];
    expect(buttons).toHaveLength(14);
    expect(buttons.every((button) => button.disabled)).toBe(true);
  });
});
