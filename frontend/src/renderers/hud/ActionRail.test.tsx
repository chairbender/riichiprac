// @vitest-environment jsdom
/**
 * The HUD action rail (3D-H3).
 *
 * The parity assertions are drift tests, not copies: the same hand state is
 * rendered by the 2D `HandDock` and by the rail, and the two control surfaces
 * are compared — labels, order, `aria-pressed` and disabled state. The rail
 * renders the same `CallToggles`/`ActionBar` components, so a change that is
 * made to one shell and not the other fails here.
 *
 * The row count is measured from the rail's height and must be reported to the
 * caller: `hudLayout()` turns it into the panel's 84 px or 128 px shape.
 */

import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { HandDock } from '../../components/HandDock';
import type { AiActionInfo, AiEvaluation } from '../../types/ai';
import type { PlayerState } from '../../types/game';
import { ActionRail } from './ActionRail';
import {
  HUD_ACTION_RAIL_GAP,
  HUD_ACTION_RAIL_ROW,
  actionRailVisible,
  railActions,
  railRowsForHeight,
} from './actionRail';
import type { ActionRailModel } from './actionRail';

// The SVG tile/Kan/Riichi art is irrelevant here; the controls are the subject.
vi.mock('../../components/Tile', () => ({ Tile: () => null }));
vi.mock('../../components/KanIcon', () => ({ KanIcon: () => null }));
vi.mock('../../components/RiichiStick', () => ({ RiichiStick: () => null }));

/** A hand holding a callable quad, so the Kan toggle is offered. */
const PLAYER: PlayerState = {
  seat: 0,
  name: 'You',
  is_human: true,
  wind: 'East',
  score: 25000,
  hand: ['1m', '1m', '1m', '1m', '2p', '3p', '4p', '5s', '6s', '7s'],
  draw: '9p',
  red_fives: [],
  discards: [],
  melds: [],
  is_riichi: false,
  riichi_discard_index: null,
};

const CHI: AiActionInfo = {
  action: 'Chi_Low',
  label: 'Chi 2p 3p on 4p',
  type: 'chi',
  tile: '4p',
  tiles: ['2p', '3p'],
};
const PASS: AiActionInfo = { action: 'Pass', label: 'Pass', type: 'pass' };
const DISCARD: AiActionInfo = {
  action: 'Discard_9p',
  label: 'Discard 9p',
  type: 'discard',
  tile: '9p',
};

const EVALUATION: AiEvaluation = {
  model: 'test',
  expected_value: 0.1,
  recommended_action: 'Kan',
  evaluations: [
    { ...CHI, probability: 0.3 },
    { action: 'Kan', label: 'Kan 1m', type: 'kan', probability: 0.25 },
    { ...PASS, probability: 0.15 },
  ],
};

function model(overrides: Partial<ActionRailModel> = {}): ActionRailModel {
  return {
    actions: [],
    canRiichi: true,
    kanTile: '1m',
    answered: false,
    isAiScenario: false,
    callRiichi: false,
    callKan: false,
    evaluation: null,
    revealMortal: false,
    onToggleRiichi: () => undefined,
    onToggleKan: () => undefined,
    onAction: () => undefined,
    ...overrides,
  };
}

interface Control {
  readonly label: string;
  readonly pressed: string | null;
  readonly disabled: boolean;
  readonly text: string;
}

/** One control's comparable surface: name, pressed state, disabled, words. */
function controls(view: ParentNode, selector: string): Control[] {
  return [...view.querySelectorAll<HTMLButtonElement>(selector)].map(
    (button) => ({
      label: button.getAttribute('aria-label') ?? '',
      pressed: button.getAttribute('aria-pressed'),
      disabled: button.disabled,
      text: (button.textContent ?? '').replace(/\s+/g, ' ').trim(),
    }),
  );
}

function dock(overrides: Partial<ComponentProps<typeof HandDock>> = {}) {
  return (
    <HandDock
      player={PLAYER}
      grade={null}
      answer={null}
      callRiichi={false}
      callKan={false}
      aiEvaluation={null}
      canRiichi
      targetAction="Kan"
      onNextScenario={() => undefined}
      onShowVerdict={() => undefined}
      onToggleRiichi={() => undefined}
      onToggleKan={() => undefined}
      onSelectTile={() => undefined}
      {...overrides}
    />
  );
}

afterEach(cleanup);

describe('3D action rail: the same controls as the 2D dock', () => {
  it('matches HandDock’s Riichi and Kan toggles, label for label', () => {
    const dockView = render(dock());
    const dockControls = controls(dockView.container, '.call-toggles button');
    cleanup();

    const railView = render(<ActionRail model={model()} />);
    const railControls = controls(railView.container, '.call-toggles button');

    expect(railControls).toEqual(dockControls);
    expect(railControls).toHaveLength(2);
    expect(railControls[0].label).toBe(
      'Call Riichi toggle, currently off',
    );
    expect(railControls[0].text).toBe('Call RiichiOFF');
    expect(railControls[1].label).toBe(
      'Call Kan toggle for 1m, currently off',
    );
    expect(railControls[1].text).toBe('Call Kan1mOFF');
  });

  it('keeps the armed state identical, including aria-pressed', () => {
    const dockView = render(dock({ callRiichi: true, callKan: true }));
    const dockControls = controls(dockView.container, '.call-toggles button');
    cleanup();

    const railView = render(
      <ActionRail model={model({ callRiichi: true, callKan: true })} />,
    );
    expect(controls(railView.container, '.call-toggles button')).toEqual(
      dockControls,
    );
    expect(
      controls(railView.container, '.call-toggles button').map(
        (control) => control.pressed,
      ),
    ).toEqual(['true', 'true']);
  });

  it('shows the Kan probability exactly when Mortal may be revealed', () => {
    const hidden = render(
      <ActionRail model={model({ evaluation: EVALUATION, revealMortal: false })} />,
    );
    expect(hidden.container.querySelector('.kan-toggle-probability')).toBeNull();
    cleanup();

    const shown = render(
      <ActionRail model={model({ evaluation: EVALUATION, revealMortal: true })} />,
    );
    const chip = shown.container.querySelector('.kan-toggle-probability');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute('aria-label')).toBe(
      'Mortal rates Kan 25%',
    );
  });

  it('arms and acts through the caller’s handlers', () => {
    const onToggleRiichi = vi.fn();
    const onToggleKan = vi.fn();
    const onAction = vi.fn();
    const { container } = render(
      <ActionRail
        model={model({
          actions: [CHI, PASS, DISCARD],
          onToggleRiichi,
          onToggleKan,
          onAction,
        })}
      />,
    );

    fireEvent.click(
      within(container).getByRole('button', {
        name: 'Call Riichi toggle, currently off',
      }),
    );
    expect(onToggleRiichi).toHaveBeenCalledTimes(1);

    fireEvent.click(
      within(container).getByRole('button', {
        name: 'Call Kan toggle for 1m, currently off',
      }),
    );
    expect(onToggleKan).toHaveBeenCalledTimes(1);

    // The ActionBar exposes the non-discard actions only, in the state's order.
    const actionButtons = within(container).getAllByRole('button', {
      name: /Chi 2p 3p on 4p|Pass/,
    });
    expect(actionButtons.map((button) => button.textContent)).toEqual([
      'Chi 2p 3p on 4p',
      'Pass',
    ]);
    fireEvent.click(actionButtons[1]);
    expect(onAction).toHaveBeenCalledWith(PASS);
  });
});

describe('3D action rail: what mounts and when', () => {
  it('draws the call actions and the toggles in one wrapping flow', () => {
    const { container } = render(
      <ActionRail model={model({ actions: [CHI, PASS, DISCARD] })} />,
    );
    const flow = container.querySelector('.hud-action-rail-controls');
    expect(flow).not.toBeNull();
    // A plain discard is not a rail action: it stays on the hand tiles.
    expect(controls(container, '.action-bar button')).toHaveLength(2);
    expect(flow?.querySelector('.action-bar')).not.toBeNull();
    expect(flow?.querySelector('.call-toggles')).not.toBeNull();
  });

  it('is unmounted when it would be empty, and after an answer', () => {
    // A plain discard lesson: no Riichi, no Kan, no call.
    expect(
      actionRailVisible(
        model({ actions: [], canRiichi: false, kanTile: null }),
      ),
    ).toBe(false);
    const empty = render(
      <ActionRail model={model({ actions: [], canRiichi: false, kanTile: null })} />,
    );
    expect(empty.container.firstChild).toBeNull();

    // Answered: the result slot is free for H5.
    expect(actionRailVisible(model({ answered: true }))).toBe(false);
    const answered = render(<ActionRail model={model({ answered: true })} />);
    expect(answered.container.firstChild).toBeNull();
  });

  it('an AI drill answers through its actions, never a call toggle', () => {
    const drill = model({
      isAiScenario: true,
      actions: [CHI, PASS],
      canRiichi: true,
      kanTile: '1m',
    });
    expect(actionRailVisible(drill)).toBe(true);
    const { container } = render(<ActionRail model={drill} />);
    expect(container.querySelector('.call-toggles')).toBeNull();
    expect(controls(container, '.action-bar button')).toHaveLength(2);
  });

  it('hides every control when Mortal and the call toggles have nothing', () => {
    expect(railActions([DISCARD])).toEqual([]);
    expect(
      actionRailVisible(
        model({ actions: [DISCARD], canRiichi: false, kanTile: null }),
      ),
    ).toBe(false);
  });
});

describe('3D action rail: the reported row count', () => {
  it('counts anything above one row plus half a gap as two rows', () => {
    for (const height of [0, HUD_ACTION_RAIL_ROW, HUD_ACTION_RAIL_ROW + 1]) {
      expect(railRowsForHeight(height)).toBe(1);
    }
    expect(
      railRowsForHeight(HUD_ACTION_RAIL_ROW + HUD_ACTION_RAIL_GAP / 2 + 0.5),
    ).toBe(2);
    expect(railRowsForHeight(HUD_ACTION_RAIL_ROW * 2 + HUD_ACTION_RAIL_GAP)).toBe(
      2,
    );
    // A degenerate measurement (jsdom, a hidden panel) never asks for a 128 px
    // box, and nothing reports a third row.
    expect(railRowsForHeight(Number.NaN)).toBe(1);
    expect(railRowsForHeight(5000)).toBe(2);
  });

  it('reports its measured height to the caller', () => {
    const onRowsChange = vi.fn();
    render(<ActionRail model={model()} onRowsChange={onRowsChange} />);
    // jsdom has no layout: the height is 0, which is one row.
    expect(onRowsChange).toHaveBeenCalledWith(1);
    cleanup();

    // The real measurement path: two rows' worth of height reports two, which is
    // what makes the panel reserve its 128 px shape.
    const measured = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue({
        width: 552,
        height: HUD_ACTION_RAIL_ROW * 2 + HUD_ACTION_RAIL_GAP,
      } as DOMRect);
    const wrapped = vi.fn();
    render(<ActionRail model={model()} onRowsChange={wrapped} />);
    expect(wrapped).toHaveBeenCalledWith(2);
    measured.mockRestore();
  });
});
