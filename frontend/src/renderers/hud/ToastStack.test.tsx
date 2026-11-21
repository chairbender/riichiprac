// @vitest-environment jsdom
/**
 * Status and error messages as HUD toasts (3D-H3).
 *
 * The message set is a pure function (`buildHudToasts`) and the stack is a live
 * region per toast: errors are `role="alert"`, status lines `role="status"`, the
 * cap is three, and only a dismissible notice carries a control.
 */

import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HudToastStack } from './ToastStack';
import { HUD_TOAST_LIMIT, buildHudToasts } from './toastModel';

afterEach(cleanup);

describe('HUD toasts: the message set', () => {
  it('is empty when there is nothing to say', () => {
    expect(buildHudToasts({})).toEqual([]);
  });

  it('puts an error first, as an alert, and keeps a loading status last', () => {
    const toasts = buildHudToasts({
      statusMessage: 'Loading table…',
      error: 'WASM returned an invalid table state',
    });
    expect(toasts.map((toast) => [toast.id, toast.tone])).toEqual([
      ['error', 'error'],
      ['status', 'status'],
    ]);
  });

  it('caps the stack at three, dropping the least consequential first', () => {
    const toasts = buildHudToasts({
      statusMessage: 'Asking Mortal…',
      error: 'deal failed',
      fileError: 'not a position file',
      fileNotice: 'Exported hand.json',
      positionDescription: 'Dealer riichi, 3 tiles left',
    });
    expect(toasts).toHaveLength(HUD_TOAST_LIMIT);
    expect(toasts.map((toast) => toast.id)).toEqual([
      'error',
      'file-error',
      'position-description',
    ]);
  });

  it('makes file notices and imported descriptions dismissible, and errors not', () => {
    const onDismissNotice = vi.fn();
    const onDismissDescription = vi.fn();
    const toasts = buildHudToasts({
      fileError: 'not a position file',
      fileNotice: 'Exported hand.json',
      positionDescription: 'Line one\nLine two',
      onDismissNotice,
      onDismissDescription,
    });
    const byId = new Map(toasts.map((toast) => [toast.id, toast]));
    expect(byId.get('file-error')?.onDismiss).toBeUndefined();
    expect(byId.get('file-notice')?.dismissLabel).toBe('Dismiss notice');
    expect(byId.get('file-notice')?.onDismiss).toBe(onDismissNotice);
    // Only the first line toasts; the sheet (H4) holds the full text.
    expect(byId.get('position-description')?.text).toBe('Line one');
    expect(byId.get('position-description')?.onDismiss).toBe(
      onDismissDescription,
    );
  });

  it('gives the imported description a Details action into the setup sheet', () => {
    const onOpen = vi.fn();
    const toast = buildHudToasts({
      positionDescription: 'Line one\nLine two',
      onOpenPositionDescription: onOpen,
    }).find((entry) => entry.id === 'position-description');
    expect(toast?.actionLabel).toBe('Details');
    expect(toast?.onAction).toBe(onOpen);
  });

  it('is deterministic: the same state produces the same order', () => {
    const input = { statusMessage: 'Loading table…', fileNotice: 'Exported' };
    expect(buildHudToasts(input)).toEqual(buildHudToasts(input));
  });
});

describe('HUD toasts: the stack', () => {
  it('gives an error the alert role and a status line the status role', () => {
    const toasts = buildHudToasts({
      error: 'deal failed',
      statusMessage: 'Loading table…',
    });
    const { container } = render(<HudToastStack toasts={toasts} />);
    expect(within(container).getByRole('alert').textContent).toBe('deal failed');
    expect(within(container).getByRole('status').textContent).toBe(
      'Loading table…',
    );
  });

  it('renders a dismiss control only where one was asked for', () => {
    const onDismiss = vi.fn();
    const toasts = buildHudToasts({
      fileNotice: 'Exported hand.json',
      onDismissNotice: onDismiss,
    });
    const { container } = render(<HudToastStack toasts={toasts} />);
    const button = within(container).getByRole('button', {
      name: 'Dismiss notice',
    });
    fireEvent.click(button);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    cleanup();
    const plain = render(
      <HudToastStack toasts={buildHudToasts({ statusMessage: 'Loading…' })} />,
    );
    expect(within(plain.container).queryAllByRole('button')).toHaveLength(0);
  });

  it('wires the description toast’s Details action', () => {
    const onOpen = vi.fn();
    const toasts = buildHudToasts({
      positionDescription: 'Line one\nLine two',
      onDismissDescription: vi.fn(),
      onOpenPositionDescription: onOpen,
    });
    const { container } = render(<HudToastStack toasts={toasts} />);
    fireEvent.click(within(container).getByRole('button', { name: 'Details' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    // Dismiss is still its own control beside the action.
    expect(
      within(container).getByRole('button', {
        name: 'Dismiss position description',
      }),
    ).toBeTruthy();
  });

  it('never renders more than the cap, even if the caller passes more', () => {
    const toasts = Array.from({ length: 5 }, (_, index) => ({
      id: `t${index}`,
      tone: 'status' as const,
      text: `message ${index}`,
    }));
    const { container } = render(<HudToastStack toasts={toasts} />);
    expect(container.querySelectorAll('.hud-toast')).toHaveLength(
      HUD_TOAST_LIMIT,
    );
  });
});
