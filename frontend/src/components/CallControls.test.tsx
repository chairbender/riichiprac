// @vitest-environment jsdom
/**
 * The shared call bar: plain buttons, a visible pick step, and no armed mode.
 *
 * The component is mounted by both shells, so these tests pin the interaction
 * itself: the call order, the words, the absence of `aria-pressed`/stick art,
 * the Cancel control that owns focus while picking, and Escape returning focus
 * to the button that opened the pick.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallControls } from './CallControls';
import type { CallButtons, PendingCall } from '../callChoices';

const BUTTONS: CallButtons = {
  calls: [
    { kind: 'chi', label: 'Chi', ariaLabel: 'Call Chi on 4p' },
    { kind: 'pon', label: 'Pon', ariaLabel: 'Call Pon 5z', action: 'Pon' },
    { kind: 'kan', label: 'Kan', ariaLabel: 'Call Kan on 1m', action: 'Kan' },
    { kind: 'riichi', label: 'Riichi', ariaLabel: 'Call Riichi' },
  ],
  pass: true,
};

const PENDING: PendingCall = {
  kind: 'chi',
  need: 2,
  picks: [],
  options: [],
  anyTile: false,
};

/** A stateful host: the bar's props are the store's, as `App` wires them. */
function Harness({
  onBegin = () => undefined,
  onPass = () => undefined,
}: {
  onBegin?: () => void;
  onPass?: () => void;
}) {
  const [pending, setPending] = useState<PendingCall | null>(null);
  return (
    <CallControls
      buttons={BUTTONS}
      pending={pending}
      onBegin={() => {
        onBegin();
        setPending(PENDING);
      }}
      onPass={onPass}
      onCancel={() => setPending(null)}
    />
  );
}

const CSS = readFileSync(join(process.cwd(), 'src', 'App.css'), 'utf8');

function blockFor(selector: string): string {
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const match = new RegExp(
    `(?:^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`,
  ).exec(stripped);
  return match?.[1] ?? '';
}

afterEach(cleanup);

describe('call bar: the controls', () => {
  it('renders Chi, Pon, Kan, Riichi and Pass in that order', () => {
    const { container } = render(<CallControls buttons={BUTTONS} pending={null} onBegin={() => undefined} onPass={() => undefined} onCancel={() => undefined} />);

    expect(
      within(container)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Chi', 'Pon', 'Kan', 'Riichi', 'Pass']);
  });

  it('is not a toggle: no aria-pressed and no riichi-stick or kan icon', () => {
    const { container } = render(
      <CallControls buttons={BUTTONS} pending={null} onBegin={() => undefined} onPass={() => undefined} onCancel={() => undefined} />,
    );

    for (const button of within(container).getAllByRole('button')) {
      expect(button.getAttribute('aria-pressed')).toBeNull();
    }
    // The old toggle art (a riichi stick, a kan marker) is gone: the controls
    // are text buttons with nothing drawn inside them.
    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).not.toMatch(/\bON\b|\bOFF\b/);
  });

  it('begins the call and passes through the caller’s handlers', () => {
    const onBegin = vi.fn();
    const onPass = vi.fn();
    render(<Harness onBegin={onBegin} onPass={onPass} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pass on the call' }));
    expect(onPass).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Call Pon 5z' }));
    expect(onBegin).toHaveBeenCalledTimes(1);
  });

  it('previews the call on hover and focus, and clears on leave and blur', () => {
    const onPreview = vi.fn();
    render(
      <CallControls
        buttons={BUTTONS}
        pending={null}
        onBegin={() => undefined}
        onPass={() => undefined}
        onCancel={() => undefined}
        onPreview={onPreview}
      />,
    );
    const pon = screen.getByRole('button', { name: 'Call Pon 5z' });

    fireEvent.pointerEnter(pon);
    expect(onPreview).toHaveBeenLastCalledWith('pon');
    fireEvent.pointerLeave(pon);
    expect(onPreview).toHaveBeenLastCalledWith(null);

    fireEvent.focus(pon);
    expect(onPreview).toHaveBeenLastCalledWith('pon');
    fireEvent.blur(pon);
    expect(onPreview).toHaveBeenLastCalledWith(null);
  });

  it('lowers the preview before opening the pick', () => {
    const onPreview = vi.fn();
    render(
      <CallControls
        buttons={BUTTONS}
        pending={null}
        onBegin={() => undefined}
        onPass={() => undefined}
        onCancel={() => undefined}
        onPreview={onPreview}
      />,
    );
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Call Chi on 4p' }));
    fireEvent.click(screen.getByRole('button', { name: 'Call Chi on 4p' }));
    expect(onPreview).toHaveBeenLastCalledWith(null);
  });

  it('disables every call once the hand is answered', () => {
    render(
      <CallControls
        buttons={BUTTONS}
        pending={null}
        disabled
        onBegin={() => undefined}
        onPass={() => undefined}
        onCancel={() => undefined}
      />,
    );
    for (const button of screen.getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('shows Mortal’s chip only when the probability may be revealed', () => {
    const evaluation = {
      model: 'test',
      expected_value: 0,
      recommended_action: 'Pon',
      evaluations: [
        { action: 'Pon', label: 'Pon 5z', type: 'pon' as const, probability: 0.25 },
      ],
    };
    const hidden = render(
      <CallControls
        buttons={BUTTONS}
        pending={null}
        evaluation={evaluation}
        onBegin={() => undefined}
        onPass={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(hidden.container.querySelector('.call-button-probability')).toBeNull();
    cleanup();

    const shown = render(
      <CallControls
        buttons={BUTTONS}
        pending={null}
        evaluation={evaluation}
        revealMortal
        onBegin={() => undefined}
        onPass={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(
      shown.container.querySelector('.call-button-probability')?.textContent,
    ).toBe('25%');
  });
});

describe('call bar: the pick step', () => {
  it('prompts for tiles, shows Cancel, and focuses it', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Call Chi on 4p' }));

    expect(screen.getByText('Select 2 tiles for Chi')).toBeTruthy();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);
    // Every call is inert while the pick is open.
    for (const button of screen.getAllByRole('button')) {
      if (button === cancel) continue;
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('cancels with Escape and returns focus to the call button', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const chi = screen.getByRole('button', { name: 'Call Chi on 4p' });
    fireEvent.click(chi);
    expect(document.activeElement?.textContent).toBe('Cancel');

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(document.activeElement).toBe(chi);
  });

  it('cancels with the Cancel button and returns focus too', () => {
    render(<Harness />);
    const chi = screen.getByRole('button', { name: 'Call Chi on 4p' });
    fireEvent.click(chi);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(chi);
  });

  it('announces a rejected pick as an alert', () => {
    render(
      <CallControls
        buttons={BUTTONS}
        pending={PENDING}
        error="That tile cannot be used for this Chi."
        onBegin={() => undefined}
        onPass={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe(
      'That tile cannot be used for this Chi.',
    );
  });
});

describe('call bar: the placement rule', () => {
  it('right-aligns the row, so more calls grow towards the left', () => {
    // The shells place the row above the right side of the hand; right
    // alignment is what fixes the group's right edge as controls are added.
    const body = blockFor('.call-controls');
    expect(body).toMatch(/justify-content:\s*flex-end/);
    expect(body).toMatch(/display:\s*flex/);
  });

  it('leaves no armed-toggle styles behind', () => {
    expect(CSS).not.toMatch(/\.riichi-toggle\b/);
    expect(CSS).not.toMatch(/\.kan-toggle\b/);
  });
});
