// @vitest-environment jsdom
/**
 * The HUD action rail (3D-H3).
 *
 * The parity assertions are drift tests, not copies: the same hand state is
 * rendered by the 2D `HandDock` and by the rail, and the two control surfaces
 * are compared — labels, order, disabled state and the words on each button.
 * The rail renders the same `CallControls`/`ActionBar` components, so a change
 * that is made to one shell and not the other fails here.
 *
 * The row count is measured from the rail's height and must be reported to the
 * caller: `hudLayout()` turns it into the panel's 84 px or 128 px shape.
 */

import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { HandDock } from '../../components/HandDock';
import { NO_CALL_BUTTONS } from '../../callChoices';
import type { CallButtons, PendingCall } from '../../callChoices';
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

// The SVG tile art is irrelevant here; the controls are the subject.
vi.mock('../../components/Tile', () => ({ Tile: () => null }));

/** A hand holding a callable quad, so a self-turn Kan button exists. */
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

const CALLS: CallButtons = {
  calls: [
    { kind: 'chi', label: 'Chi', ariaLabel: 'Call Chi on 4p' },
    { kind: 'pon', label: 'Pon', ariaLabel: 'Call Pon 5z', action: 'Pon' },
    { kind: 'kan', label: 'Kan', ariaLabel: 'Call Kan on 1m', action: 'Kan' },
    { kind: 'riichi', label: 'Riichi', ariaLabel: 'Call Riichi' },
  ],
  pass: true,
};

const TSUMO: AiActionInfo = {
  action: 'Agari',
  label: 'Tsumo',
  type: 'agari',
};

const EVALUATION: AiEvaluation = {
  model: 'test',
  expected_value: 0.1,
  recommended_action: 'Pon',
  evaluations: [
    { action: 'Pon', label: 'Pon 5z', type: 'pon', probability: 0.25 },
    { action: 'Pass', label: 'Pass', type: 'pass', probability: 0.15 },
  ],
};

const PENDING: PendingCall = {
  kind: 'chi',
  need: 2,
  picks: [],
  options: [],
  anyTile: false,
};

function model(overrides: Partial<ActionRailModel> = {}): ActionRailModel {
  return {
    actions: [],
    callButtons: CALLS,
    pendingCall: null,
    callError: null,
    answered: false,
    evaluation: null,
    revealMortal: false,
    onBeginCall: () => undefined,
    onPass: () => undefined,
    onCancelCall: () => undefined,
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
      callButtons={CALLS}
      pendingCall={null}
      callError={null}
      aiEvaluation={null}
      onNextScenario={() => undefined}
      onShowVerdict={() => undefined}
      onBeginCall={() => undefined}
      onPass={() => undefined}
      onCancelCall={() => undefined}
      onSelectTile={() => undefined}
      {...overrides}
    />
  );
}

afterEach(cleanup);

describe('3D action rail: the same controls as the 2D dock', () => {
  it('matches HandDock’s call buttons, label for label', () => {
    const dockView = render(dock());
    const dockControls = controls(dockView.container, '.call-controls button');
    cleanup();

    const railView = render(<ActionRail model={model()} />);
    const railControls = controls(railView.container, '.call-controls button');

    expect(railControls).toEqual(dockControls);
    expect(railControls.map((control) => control.text)).toEqual([
      'Chi',
      'Pon',
      'Kan',
      'Riichi',
      'Pass',
    ]);
  });

  it('never exposes an armed toggle: no aria-pressed and no ON/OFF word', () => {
    const dockView = render(dock());
    const all = controls(dockView.container, 'button');
    cleanup();

    const railView = render(<ActionRail model={model()} />);
    for (const control of [...all, ...controls(railView.container, 'button')]) {
      expect(control.pressed).toBeNull();
      expect(control.text).not.toMatch(/\bON\b|\bOFF\b/);
    }
  });

  it('keeps the open pick identical, prompt and Cancel included', () => {
    const dockView = render(dock({ pendingCall: PENDING }));
    const dockControls = controls(dockView.container, '.call-controls button');
    cleanup();

    const railView = render(<ActionRail model={model({ pendingCall: PENDING })} />);
    expect(controls(railView.container, '.call-controls button')).toEqual(
      dockControls,
    );
    // Every call is inert while the pick is open; Cancel is the one target.
    const cancel = within(railView.container).getByRole('button', {
      name: 'Cancel',
    });
    expect((cancel as HTMLButtonElement).disabled).toBe(false);
    expect(
      railView.container.querySelector('.call-controls-prompt')?.textContent,
    ).toBe('Select 2 tiles for Chi');
  });

  it('shows the probability chip exactly when Mortal may be revealed', () => {
    const hidden = render(
      <ActionRail model={model({ evaluation: EVALUATION, revealMortal: false })} />,
    );
    expect(hidden.container.querySelector('.call-button-probability')).toBeNull();
    cleanup();

    const shown = render(
      <ActionRail model={model({ evaluation: EVALUATION, revealMortal: true })} />,
    );
    const chip = shown.container.querySelector('.call-button-probability');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute('aria-label')).toBe('Mortal rates Pon 25%');
  });

  it('begins and cancels through the caller’s handlers', () => {
    const onBeginCall = vi.fn();
    const onCancelCall = vi.fn();
    const onPass = vi.fn();
    const { container, rerender } = render(
      <ActionRail
        model={model({ onBeginCall, onCancelCall, onPass })}
      />,
    );

    fireEvent.click(within(container).getByRole('button', { name: 'Call Pon 5z' }));
    expect(onBeginCall).toHaveBeenCalledWith('pon');

    fireEvent.click(within(container).getByRole('button', { name: 'Pass on the call' }));
    expect(onPass).toHaveBeenCalledTimes(1);

    rerender(
      <ActionRail
        model={model({ pendingCall: PENDING, onBeginCall, onCancelCall, onPass })}
      />,
    );
    fireEvent.click(within(container).getByRole('button', { name: 'Cancel' }));
    expect(onCancelCall).toHaveBeenCalledTimes(1);
  });

  it('keeps the drill’s other actions in the ActionBar, not in the call bar', () => {
    const onAction = vi.fn();
    const { container } = render(
      <ActionRail model={model({ actions: [TSUMO], onAction })} />,
    );
    expect(controls(container, '.action-bar button')).toHaveLength(1);
    fireEvent.click(within(container).getByRole('button', { name: 'Tsumo' }));
    expect(onAction).toHaveBeenCalledWith(TSUMO);
  });
});

describe('3D action rail: what mounts and when', () => {
  it('draws the actions and the calls in one wrapping flow', () => {
    const { container } = render(
      <ActionRail model={model({ actions: [TSUMO] })} />,
    );
    const flow = container.querySelector('.hud-action-rail-controls');
    expect(flow).not.toBeNull();
    expect(flow?.querySelector('.action-bar')).not.toBeNull();
    expect(flow?.querySelector('.call-controls')).not.toBeNull();
  });

  it('is unmounted when it would be empty, and after an answer', () => {
    // A plain discard lesson: no Riichi, no Kan, no call, no drill action.
    expect(
      actionRailVisible(model({ actions: [], callButtons: NO_CALL_BUTTONS })),
    ).toBe(false);
    const empty = render(
      <ActionRail model={model({ actions: [], callButtons: NO_CALL_BUTTONS })} />,
    );
    expect(empty.container.firstChild).toBeNull();

    // Answered: the result slot is free for H5.
    expect(actionRailVisible(model({ answered: true }))).toBe(false);
    const answered = render(<ActionRail model={model({ answered: true })} />);
    expect(answered.container.firstChild).toBeNull();
  });

  it('hides when only a plain discard is left', () => {
    expect(
      railActions([
        {
          action: 'Discard_9p',
          label: 'Discard 9p',
          type: 'discard',
          tile: '9p',
        },
      ]),
    ).toEqual([]);
    expect(
      actionRailVisible(model({ actions: [], callButtons: NO_CALL_BUTTONS })),
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
