// @vitest-environment jsdom
/**
 * The 3D interaction overlay and its accessibility parity (3D-08).
 *
 * The parity assertions are drift tests: the same hand state is rendered by the
 * stacked/top-down `HandDock` and by the projected overlay, and the two
 * accessible button surfaces are compared — labels, order and the arguments the
 * click hands to the shared `onSelectTile`. No copy of the label text is kept in
 * this file, so an edit to one view that is not made to the other fails here.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { HandDock } from '../components/HandDock';
import { snapshotFromGameState } from './snapshot';
import { TableOverlay } from './overlay';
import type { TableOverlayProps } from './overlay';
import { frameForAspect, layoutBoard } from './three/boardLayout';
import { hitRects } from './three/hitTest';
import type { TableSnapshot } from './contract';
import type { GameState, PlayerState } from '../types/game';

// The SVG tile package bundles its own React; the labels are the subject here.
vi.mock('../components/Tile', () => ({ Tile: () => null }));

const VIEWPORT = { widthPx: 1920, heightPx: 1080 };

const HUMAN: PlayerState = {
  seat: 0,
  name: 'You',
  is_human: true,
  wind: 'East',
  score: 25000,
  // Deliberately unsorted, with a red five and a draw separate from the row.
  hand: ['9p', '1m', '5s', '2z', '3s', '5p', '4m', '6z', '7m', '1p'],
  draw: '8s',
  red_fives: ['5s'],
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
    red_fives: [],
  };
}

function gameState(human: PlayerState = HUMAN): GameState {
  return {
    category: 'fold_to_riichi',
    target_action: 'Fold',
    correct_action: { type: 'fold', discard: '1m' },
    decision: { kind: 'self_turn' },
    riichi_triggers: [],
    dama_reasons: [],
    shouminkan_triggers: [],
    hand_string: human.hand.join(''),
    tiles: [...human.hand, human.draw].filter((tile): tile is string => tile !== null),
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
    current_turn: 0,
    players: [human, otherPlayer(1), otherPlayer(2), otherPlayer(3)],
  };
}

function snapshot(locked = false, human: PlayerState = HUMAN, revision = 1): TableSnapshot {
  return snapshotFromGameState(gameState(human), revision, locked);
}

function rectsFor(table: TableSnapshot) {
  const layout = layoutBoard(table);
  const frame = frameForAspect(VIEWPORT.widthPx / VIEWPORT.heightPx, layout);
  return hitRects(layout, frame, VIEWPORT);
}

function overlayProps(overrides: Partial<TableOverlayProps> = {}): TableOverlayProps {
  const table = overrides.snapshot ?? snapshot();
  return {
    snapshot: table,
    rects: overrides.rects ?? rectsFor(table),
    onSelectTile: vi.fn(),
    ...overrides,
  };
}

function dock(overrides: Partial<ComponentProps<typeof HandDock>> = {}) {
  return (
    <HandDock
      player={HUMAN}
      grade={null}
      answer={null}
      callRiichi={false}
      callKan={false}
      aiEvaluation={null}
      onNextScenario={() => undefined}
      onShowVerdict={() => undefined}
      onToggleRiichi={() => undefined}
      onToggleKan={() => undefined}
      onSelectTile={() => undefined}
      {...overrides}
    />
  );
}

function labelsIn(view: HTMLElement): string[] {
  return within(view)
    .getAllByRole('button')
    .map((button) => button.getAttribute('aria-label') ?? '');
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('3D overlay: parity with the dock', () => {
  it('uses the same accessible names and order as HandDock', () => {
    const dockView = render(dock());
    const dockLabels = labelsIn(dockView.container);
    cleanup();

    const overlayView = render(<TableOverlay {...overlayProps()} />);
    expect(labelsIn(overlayView.container)).toEqual(dockLabels);
    expect(dockLabels).toHaveLength(11);
    // The red five, the honors and the draw all keep the dock's wording.
    expect(dockLabels).toContain('Discard R5s');
    expect(dockLabels).toContain('Discard S');
    expect(dockLabels).toContain('Discard G');
  });

  it('keeps the armed Riichi/Kan wording identical to the dock', () => {
    const dockView = render(dock({ callRiichi: true, callKan: true }));
    const dockLabels = labelsIn(dockView.container);
    cleanup();

    const overlayView = render(
      <TableOverlay {...overlayProps({ callRiichi: true, callKan: true })} />,
    );
    expect(labelsIn(overlayView.container)).toEqual(dockLabels);
    expect(dockLabels[0]).toBe('Declare Kan on 1m, with Riichi');
  });

  it('hands the same tile, display index and draw flag to the click handler', async () => {
    const dockSelect = vi.fn();
    const dockView = render(dock({ onSelectTile: dockSelect }));
    const drawButton = within(dockView.container)
      .getAllByRole('button')
      .find((button) => button.getAttribute('aria-label') === 'Discard 8s');
    if (!drawButton) throw new Error('the dock has no draw button');
    await userEvent.click(drawButton);
    const dockArgs = dockSelect.mock.calls[0];
    cleanup();

    const overlaySelect = vi.fn();
    const overlayView = render(
      <TableOverlay {...overlayProps({ onSelectTile: overlaySelect })} />,
    );
    const overlayDraw = within(overlayView.container).getByRole('button', {
      name: 'Discard 8s',
    });
    await userEvent.click(overlayDraw);

    expect(overlaySelect).toHaveBeenCalledTimes(1);
    expect(overlaySelect.mock.calls[0]).toEqual(dockArgs);
    expect(dockArgs).toEqual(['8s', 8, true]);
  });

  it('is one button per visible tile, and none once answered', () => {
    const { container, rerender } = render(<TableOverlay {...overlayProps()} />);
    expect(within(container).getAllByRole('button')).toHaveLength(11);

    rerender(<TableOverlay {...overlayProps({ snapshot: snapshot(true) })} />);
    expect(within(container).queryAllByRole('button')).toHaveLength(0);
  });
});

describe('3D overlay: keyboard and focus', () => {
  it('takes Tab in the dock’s order and discards on Enter and Space', async () => {
    const user = userEvent.setup();
    const onSelectTile = vi.fn();
    const { container } = render(
      <TableOverlay {...overlayProps({ onSelectTile })} />,
    );
    const expected = labelsIn(container);

    const visited: string[] = [];
    for (let step = 0; step < expected.length; step += 1) {
      await user.tab();
      visited.push(document.activeElement?.getAttribute('aria-label') ?? '');
    }
    expect(visited).toEqual(expected);
    expect(document.activeElement?.classList.contains('renderer-3d-tile')).toBe(true);
  });

  it('discards with Enter and leaves Escape untouched', async () => {
    const user = userEvent.setup();
    const onSelectTile = vi.fn();
    const { container } = render(
      <TableOverlay {...overlayProps({ onSelectTile })} />,
    );
    const first = within(container).getAllByRole('button')[0];
    first.focus();

    await user.keyboard('{Escape}');
    expect(onSelectTile).not.toHaveBeenCalled();

    await user.keyboard('{Enter}');
    expect(onSelectTile).toHaveBeenCalledTimes(1);
    expect(onSelectTile.mock.calls[0][0]).toBe('1m');

    await user.keyboard(' ');
    expect(onSelectTile).toHaveBeenCalledTimes(2);
  });

  it('keeps focus on the hand group when answering removes the buttons', async () => {
    const { container, rerender } = render(<TableOverlay {...overlayProps()} />);
    const button = within(container).getAllByRole('button')[0];
    button.focus();
    expect(document.activeElement).toBe(button);

    rerender(<TableOverlay {...overlayProps({ snapshot: snapshot(true, HUMAN, 2) })} />);

    const group = container.querySelector('.renderer-3d-hand');
    expect(group).not.toBeNull();
    expect(group?.getAttribute('aria-label')).toBe('Your hand');
    expect(document.activeElement).toBe(group);
  });

  it('replaces the buttons on a new snapshot, keeping no stale target', () => {
    const { container, rerender } = render(<TableOverlay {...overlayProps()} />);
    expect(within(container).getByRole('button', { name: 'Discard 1m' })).toBeTruthy();

    const next = {
      ...HUMAN,
      hand: ['2m', '3m', '4m', '2p', '3p', '4p', '2s', '3s', '4s', '1z'],
      draw: '2z',
      red_fives: [],
    };
    rerender(
      <TableOverlay
        {...overlayProps({ snapshot: snapshot(false, next, 2) })}
      />,
    );

    expect(within(container).queryByRole('button', { name: 'Discard 1m' })).toBeNull();
    expect(within(container).getByRole('button', { name: 'Discard 2m' })).toBeTruthy();
    expect(within(container).getAllByRole('button')).toHaveLength(11);
  });
});

describe('3D overlay: placement and motion', () => {
  it('positions every button on the renderer’s projected rect, at least 44 px', () => {
    const props = overlayProps();
    const { container } = render(<TableOverlay {...props} />);
    for (const button of within(container).getAllByRole('button')) {
      const zone = button.getAttribute('data-zone');
      const slot = Number(button.getAttribute('data-slot'));
      const rect = props.rects.find(
        (candidate) => candidate.zone === zone && candidate.slot === slot,
      );
      if (!rect) throw new Error('no rect for a rendered button');
      expect(button.style.left).toBe(`${rect.left}px`);
      expect(button.style.top).toBe(`${rect.top}px`);
      expect(button.style.width).toBe(`${rect.width}px`);
      expect(button.style.height).toBe(`${rect.height}px`);
      expect(rect.width).toBeGreaterThanOrEqual(44);
      expect(rect.height).toBeGreaterThanOrEqual(44);
    }
  });

  it('reports hover/focus for the lift, with motion suppressed on request', () => {
    const onHoverTile = vi.fn();
    const { container } = render(
      <TableOverlay {...overlayProps({ onHoverTile })} />,
    );
    const button = within(container).getAllByRole('button')[0];
    fireEvent.focus(button);
    expect(onHoverTile).toHaveBeenCalledTimes(1);
    expect(onHoverTile.mock.calls[0][0]).toMatchObject({
      seat: 0,
      zone: 'hand',
      code: '1m',
    });
    fireEvent.blur(button);
    expect(onHoverTile.mock.calls[1]).toEqual([null]);
    cleanup();

    const suppressed = vi.fn();
    const quiet = render(
      <TableOverlay {...overlayProps({ onHoverTile: suppressed, reducedMotion: true })} />,
    );
    const quietButton = within(quiet.container).getAllByRole('button')[0];
    fireEvent.focus(quietButton);
    fireEvent.blur(quietButton);
    expect(suppressed).not.toHaveBeenCalled();
  });

  it('renders one group named “Your hand” and no layer of its own outside it', () => {
    const { container } = render(<TableOverlay {...overlayProps()} />);
    const group = screen.getByRole('group', { name: 'Your hand' });
    expect(group).toBe(container.firstElementChild);
    expect(group.className).toBe('renderer-3d-hand');
  });
});
