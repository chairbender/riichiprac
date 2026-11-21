// @vitest-environment jsdom
/**
 * 3D-15: the same full board answered by every view.
 *
 * The stress state is rendered by the stacked/top-down hand (`HandDock`), the
 * top-down plan (`PhysicalTable`) and the 3D overlay (`TableOverlay` /
 * `TableCompass`), and the accessible surfaces are compared as drift: labels,
 * order, the arguments a click hands the shared handler, the compass names and
 * the visible scores and wall count. Nothing here copies the wording, so an
 * edit made to one view but not the other fails.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HandDock } from '../components/HandDock';
import { PhysicalTable } from '../components/PhysicalTable';
import { TableCompass, TableOverlay } from './overlay';
import { compassBox } from './compassOverlay';
import { frameForAspect, layoutBoard } from './three/boardLayout';
import { compassPlateRect, hitRects } from './three/hitTest';
import {
  stressGameState,
  stressSnapshot,
} from './three/stressFixture';
import type { TableSnapshot } from './contract';

vi.mock('../components/Tile', () => ({ Tile: () => null }));
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

const HUMAN = stressGameState().players.find((player) => player.is_human);
if (!HUMAN) throw new Error('the stress state has no human');

function labelsIn(view: HTMLElement): string[] {
  return within(view)
    .getAllByRole('button')
    .map((button) => button.getAttribute('aria-label') ?? '');
}

function accessibleNames(view: ParentNode): string[] {
  return Array.from(view.querySelectorAll('[aria-label]')).map(
    (element) => element.getAttribute('aria-label') ?? '',
  );
}

function dock(overrides: Partial<Parameters<typeof HandDock>[0]> = {}) {
  return (
    <HandDock
      player={HUMAN!}
      grade={null}
      answer={null}
      callRiichi={false}
      callKan={false}
      aiEvaluation={null}
      targetAction="Fold"
      onNextScenario={() => undefined}
      onShowVerdict={() => undefined}
      onToggleRiichi={() => undefined}
      onToggleKan={() => undefined}
      onSelectTile={() => undefined}
      {...overrides}
    />
  );
}

function rectsFor(snapshot: TableSnapshot) {
  const board = layoutBoard(snapshot);
  const frame = frameForAspect(VIEWPORT.widthPx / VIEWPORT.heightPx, board);
  return hitRects(board, frame, VIEWPORT);
}

function compassRectFor(snapshot: TableSnapshot) {
  const board = layoutBoard(snapshot);
  const frame = frameForAspect(VIEWPORT.widthPx / VIEWPORT.heightPx, board);
  return compassPlateRect(frame, VIEWPORT);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('stress board: the 3D overlay matches the 2D hand', () => {
  it('uses the same accessible names and order as HandDock', () => {
    const snapshot = stressSnapshot();
    const dockView = render(dock());
    const dockLabels = labelsIn(dockView.container);
    cleanup();

    const overlayView = render(
      <TableOverlay
        snapshot={snapshot}
        rects={rectsFor(snapshot)}
        onSelectTile={() => undefined}
        callRiichi={false}
        callKan={false}
      />,
    );
    expect(labelsIn(overlayView.container)).toEqual(dockLabels);
    // Ten concealed tiles plus the draw, and all three red fives by name.
    expect(dockLabels).toHaveLength(11);
    for (const red of ['Discard R5m', 'Discard R5p', 'Discard R5s']) {
      expect(dockLabels).toContain(red);
    }
    // The draw sorts into its display position exactly as the dock sorts it,
    // and every name is present in both views.
    expect(dockLabels).toContain('Discard 9m');
  });

  it('hands the same tile, display index and draw flag to the handler', async () => {
    const snapshot = stressSnapshot();
    const dockSelect = vi.fn();
    const dockView = render(dock({ onSelectTile: dockSelect }));
    const dockDraw = within(dockView.container)
      .getAllByRole('button')
      .find((button) => button.getAttribute('aria-label') === 'Discard 9m');
    if (!dockDraw) throw new Error('the dock has no draw button');
    await userEvent.click(dockDraw);
    const dockArgs = dockSelect.mock.calls[0];
    cleanup();

    const overlaySelect = vi.fn();
    const overlayView = render(
      <TableOverlay
        snapshot={snapshot}
        rects={rectsFor(snapshot)}
        onSelectTile={overlaySelect}
        callRiichi={false}
        callKan={false}
      />,
    );
    await userEvent.click(
      within(overlayView.container).getByRole('button', {
        name: 'Discard 9m',
      }),
    );
    expect(overlaySelect).toHaveBeenCalledTimes(1);
    expect(overlaySelect.mock.calls[0]).toEqual(dockArgs);
  });

  it('offers no hand control once the same state is answered', () => {
    const snapshot = stressSnapshot({ answered: true });
    const overlayView = render(
      <TableOverlay
        snapshot={snapshot}
        rects={hitRects(layoutBoard(snapshot), frameForAspect(16 / 9, layoutBoard(snapshot)), VIEWPORT, {
          locked: true,
        })}
        onSelectTile={() => undefined}
        callRiichi={false}
        callKan={false}
      />,
    );
    expect(within(overlayView.container).queryAllByRole('button')).toHaveLength(0);
    expect(snapshot.locked).toBe(true);
  });
});

describe('stress board: the 3D compass matches the plan view', () => {
  it('matches PhysicalTable’s compass names, order, scores and wall count', () => {
    const state = stressGameState();
    const snapshot = stressSnapshot();
    const planView = render(<PhysicalTable state={state} />);
    const planCompass = planView.container.querySelector('.physical-center');
    if (!planCompass) throw new Error('PhysicalTable has no compass');
    // The plan compass draws a decorative stick sprite in each corner (the 3D
    // model is the marker), so compare the information-bearing names.
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

    const rect = compassRectFor(snapshot);
    if (!rect) throw new Error('no compass rect at the test viewport');
    const sceneView = render(<TableCompass snapshot={snapshot} rect={rect} />);
    const sceneCompass = sceneView.container.firstElementChild;
    if (!sceneCompass) throw new Error('the 3D compass did not render');

    expect(accessibleNames(sceneCompass)).toEqual(planNames);
    // Four declarers: the plan draws four corner sticks; the 3D compass names
    // all four and draws none (its felt sticks are the 3D marker).
    expect(planSticks).toBe(4);
    expect(
      accessibleNames(sceneCompass).filter((name) => name.includes(', riichi')),
    ).toHaveLength(4);
    expect(sceneCompass.querySelectorAll('.renderer-3d-compass-stick')).toHaveLength(
      0,
    );

    const sceneScores = Array.from(
      sceneCompass.querySelectorAll<HTMLElement>('.renderer-3d-compass-score'),
    );
    expect(sceneScores.map((element) => element.dataset.score)).toEqual(planScores);
    for (const score of sceneScores) {
      const lead = score.querySelector('.renderer-3d-compass-score-lead')?.textContent;
      const tail = score.querySelector('.renderer-3d-compass-score-tail')?.textContent;
      expect(`${lead}${tail}`).toBe(score.dataset.score);
    }
    // Compare the two halves the views actually print (the plan writes the
    // round and the wall count as separate spans too).
    const sceneRound = sceneCompass.querySelector(
      '.renderer-3d-compass-round',
    )?.textContent;
    const sceneCount = sceneCompass.querySelector(
      '.renderer-3d-compass-count',
    )?.textContent;
    expect(sceneRound).toBe(
      planCompass.querySelector('.compass-round')?.textContent,
    );
    expect(sceneCount).toBe(
      planCompass.querySelector('.compass-wall-count')?.textContent,
    );
    // The round and the tiles-left number are the same text in both views.
    expect(planWallText).toContain('14');
    expect(accessibleNames(sceneCompass).join(' ')).toContain(
      'Round South 4, 14 tiles remaining',
    );
  });

  it('sits on the projected well and carries no focus stop', () => {
    const snapshot = stressSnapshot();
    const rect = compassRectFor(snapshot);
    if (!rect) throw new Error('no compass rect at the test viewport');
    const box = compassBox(rect);
    const { container } = render(<TableCompass snapshot={snapshot} rect={rect} />);
    const group = screen.getByRole('group', { name: 'Compass' });
    expect(group.style.left).toBe(`${box.left}px`);
    expect(group.style.top).toBe(`${box.top}px`);
    expect(group.style.width).toBe(`${box.width}px`);
    expect(group.style.height).toBe(`${box.height}px`);
    expect(container.querySelectorAll('button, [tabindex]')).toHaveLength(0);
  });
});
