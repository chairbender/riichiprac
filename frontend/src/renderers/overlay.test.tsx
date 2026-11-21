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
import { PhysicalTable } from '../components/PhysicalTable';
import { snapshotFromGameState } from './snapshot';
import { TableCompass, TableOverlay } from './overlay';
import type { TableOverlayProps } from './overlay';
import { compassBox } from './compassOverlay';
import { frameForAspect, layoutBoard } from './three/boardLayout';
import { compassPlateRect, hitRects } from './three/hitTest';
import type { TableSnapshot } from './contract';
import type { GameState, PlayerState } from '../types/game';

// The SVG tile package bundles its own React; the labels are the subject here.
vi.mock('../components/Tile', () => ({ Tile: () => null }));
// Same reason: the wind glyphs are the 2.5D package's own elements, so both
// compasses get a plain SVG with the same attributes.
vi.mock('riichi-mahjong-tiles', async () => {
  const { createElement } = await import('react');
  const Glyph = (props: Record<string, unknown>) => createElement('svg', props);
  return {
    RegularTon: Glyph,
    RegularNan: Glyph,
    RegularShaa: Glyph,
    RegularPei: Glyph,
  };
});

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

  it('reports hover/focus for the lift under every motion preference', () => {
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

    // The lift is a discrete pose change, not an animation (user decision
    // 2026-11-21), so the overlay no longer has a reduced-motion branch: the
    // deal-in is the animation that preference suppresses. A pointer hover
    // still reports, and leaving still clears.
    fireEvent.pointerEnter(button);
    expect(onHoverTile.mock.calls.at(-1)?.[0]).toMatchObject({ code: '1m' });
    fireEvent.pointerLeave(button);
    expect(onHoverTile.mock.calls.at(-1)).toEqual([null]);
  });

  it('clears the lift when the hovered button disappears (answered hand)', () => {
    const onHoverTile = vi.fn();
    const { container, rerender } = render(
      <TableOverlay {...overlayProps({ onHoverTile })} />,
    );
    const button = within(container).getAllByRole('button')[0];
    fireEvent.pointerEnter(button);
    expect(onHoverTile.mock.calls.at(-1)?.[0]).toMatchObject({ code: '1m' });

    // A removed element receives no pointerleave; the overlay must clear it.
    rerender(
      <TableOverlay
        {...overlayProps({ onHoverTile, snapshot: snapshot(true, HUMAN, 2) })}
      />,
    );
    expect(onHoverTile.mock.calls.at(-1)).toEqual([null]);
  });

  it('renders one group named “Your hand” and no layer of its own outside it', () => {
    const { container } = render(<TableOverlay {...overlayProps()} />);
    const group = screen.getByRole('group', { name: 'Your hand' });
    expect(group).toBe(container.firstElementChild);
    expect(group.className).toBe('renderer-3d-hand');
  });
});

/**
 * A table whose compass has known values: seats 1 and 2 declared riichi, each
 * player a different wind and score, a non-default round and a non-zero pot
 * (which the 3D compass must not duplicate).
 */
function compassState(): GameState {
  const winds = ['East', 'South', 'West', 'North'] as const;
  const players = [HUMAN, otherPlayer(1), otherPlayer(2), otherPlayer(3)].map(
    (player, index) => ({
      ...player,
      wind: winds[index],
      score: 25000 + index * 1000,
      is_riichi: index === 1 || index === 2,
      riichi_discard_index: null,
    }),
  );
  return {
    ...gameState(HUMAN),
    round_wind: 'South',
    hand_number: 3,
    tiles_remaining: 42,
    riichi_sticks: 5,
    players,
  };
}

/** Every aria-label under a subtree, in DOM order. */
function accessibleNames(view: ParentNode): string[] {
  return Array.from(view.querySelectorAll('[aria-label]')).map(
    (element) => element.getAttribute('aria-label') ?? '',
  );
}

function compassRectFor(table: TableSnapshot) {
  const frame = frameForAspect(VIEWPORT.widthPx / VIEWPORT.heightPx, layoutBoard(table));
  return compassPlateRect(frame, VIEWPORT);
}

describe('3D overlay: compass (3D-09)', () => {
  it('matches PhysicalTable’s compass names, order and text for the same state', () => {
    const state = compassState();
    const table = snapshotFromGameState(state, 1, false);

    const planView = render(<PhysicalTable state={state} />);
    const planCompass = planView.container.querySelector('.physical-center');
    if (!planCompass) throw new Error('PhysicalTable has no compass');
    // The 2D compass draws a decorative stick sprite in each corner; the 3D
    // compass deliberately does not (the 3D model is the marker), so compare
    // the names that carry information and ignore the sprite's own label.
    const planNames = accessibleNames(planCompass).filter(
      (name) => name !== 'Riichi stick',
    );
    const planScores = Array.from(planCompass.querySelectorAll('.compass-score')).map(
      (element) => (element.textContent ?? '').replace(/\D/g, ''),
    );
    const planWallText = planCompass
      .querySelector('.compass-wall')
      ?.textContent?.replace(/\s+/g, '');
    const planSticks = planCompass.querySelectorAll('.compass-stick').length;
    cleanup();

    const rect = compassRectFor(table);
    if (!rect) throw new Error('no compass rect at the test viewport');
    const sceneView = render(<TableCompass snapshot={table} rect={rect} />);
    const sceneCompass = sceneView.container.firstElementChild;
    if (!sceneCompass) throw new Error('the 3D compass did not render');

    // A drift test, not a copy: the two views agree for the same state.
    expect(accessibleNames(sceneCompass)).toEqual(planNames);
    // The plate prints `250` + small `00`; the value is still the same score,
    // and the accessible name above already carries it in full.
    const sceneScores = Array.from(
      sceneCompass.querySelectorAll<HTMLElement>('.renderer-3d-compass-score'),
    );
    expect(sceneScores.map((element) => element.dataset.score)).toEqual(planScores);
    for (const score of sceneScores) {
      const lead = score.querySelector('.renderer-3d-compass-score-lead')?.textContent;
      const tail = score.querySelector('.renderer-3d-compass-score-tail')?.textContent;
      expect(`${lead}${tail}`).toBe(score.dataset.score);
      expect(tail).toBe('00');
    }
    expect(
      sceneCompass.querySelector('.renderer-3d-compass-wall')?.textContent?.replace(
        /\s+/g,
        '',
      ),
    ).toBe(planWallText);
    // No stick icon in the 3D compass: the 3D models on the felt are the
    // markers, and the corner names below still announce the declaration.
    expect(sceneCompass.querySelectorAll('.renderer-3d-compass-stick')).toHaveLength(
      0,
    );
    expect(
      sceneCompass.querySelectorAll('[aria-label="Riichi stick"]'),
    ).toHaveLength(0);
    // The 2D view still uses its sprite, and both views name the same two
    // declarers. The 1000-point pot (5) is not drawn on either compass.
    expect(planSticks).toBe(2);
    expect(
      accessibleNames(sceneCompass).filter((name) => name.includes(', riichi')),
    ).toHaveLength(planSticks);
    expect(accessibleNames(sceneCompass).join(' ')).not.toContain('5 sticks');
  });

  it('sits on the projected well and keeps the well’s own centre', () => {
    const table = snapshotFromGameState(compassState(), 1, false);
    const rect = compassRectFor(table);
    if (!rect) throw new Error('no compass rect at the test viewport');
    const box = compassBox(rect);

    render(<TableCompass snapshot={table} rect={rect} />);
    const group = screen.getByRole('group', { name: 'Compass' });
    expect(group.style.left).toBe(`${box.left}px`);
    expect(group.style.top).toBe(`${box.top}px`);
    expect(group.style.width).toBe(`${box.width}px`);
    expect(group.style.height).toBe(`${box.height}px`);
    expect(group.getAttribute('data-centre-x')).toBe(`${rect.centreX}`);
    expect(group.getAttribute('data-centre-y')).toBe(`${rect.centreY}`);
    // Within 2 % of the window of the well's projected centre.
    expect(Math.abs(box.left + box.width / 2 - rect.centreX)).toBeLessThanOrEqual(
      VIEWPORT.widthPx * 0.02,
    );
    expect(Math.abs(box.top + box.height / 2 - rect.centreY)).toBeLessThanOrEqual(
      VIEWPORT.heightPx * 0.02,
    );
  });

  it('renders nothing without a projection, and no controls of its own', () => {
    const table = snapshotFromGameState(compassState(), 1, false);
    const empty = render(<TableCompass snapshot={table} rect={null} />);
    expect(empty.container.firstElementChild).toBeNull();
    cleanup();

    const rect = compassRectFor(table);
    if (!rect) throw new Error('no compass rect at the test viewport');
    const { container } = render(<TableCompass snapshot={table} rect={rect} />);
    const group = container.firstElementChild as HTMLElement;
    // Informational only: no buttons, no focus stops (pointer-events are the
    // stylesheet's job: the layer passes them through except on its labels).
    expect(group.querySelectorAll('button, [tabindex]')).toHaveLength(0);
    expect(group.getAttribute('role')).toBe('group');
  });
});
