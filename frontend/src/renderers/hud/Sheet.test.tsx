// @vitest-environment jsdom
/**
 * The sheet primitive (3D-H2, 3d_hud.md §6.5).
 *
 * Each clause of the modal contract is one test: the dialog's role and name,
 * focus onto the heading, Escape, the scrim tap, the Tab cycle, focus return
 * (and its fallback), the page-scroll lock, and `inert` on the HUD background
 * and the stage. The last test is the one that matters most for the renderer:
 * opening and closing a sheet must not unmount the scene.
 *
 * jsdom has no layout and no native Tab, so this file asserts *behaviour*
 * (which element has focus, which attribute is set, which callback fired), not
 * appearance. The rects themselves are `hudLayout.test.ts`'s.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NESTED_LAYER_ATTRIBUTE, Sheet } from './Sheet';

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
});

interface HarnessProps {
  readonly initialOpen?: boolean;
  readonly onClose?: () => void;
  /** Remove the opener while the sheet is open (the "result card vanished" case). */
  readonly dropOpener?: boolean;
  /** Mark a nested popover open inside the sheet body. */
  readonly nestedOpen?: boolean;
  readonly reducedMotion?: boolean;
  readonly children?: ReactNode;
}

let sceneMounts = 0;

function Scene() {
  // Count real mounts, not renders: the scene must survive a sheet's state.
  useEffect(() => {
    sceneMounts += 1;
  }, []);
  return <div data-testid="scene">the 3d scene</div>;
}

/**
 * A trigger, the HUD background, the scene and the sheet — the same shape
 * `HudLayer` renders, so focus return and `inert` are exercised across the real
 * element boundaries.
 */
function Harness({
  initialOpen = false,
  onClose,
  dropOpener = false,
  nestedOpen = false,
  reducedMotion = false,
  children,
}: HarnessProps) {
  const [open, setOpen] = useState(initialOpen);
  const sceneRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  return (
    <div>
      <div ref={barRef} data-testid="hud-bar">
        <button type="button">Next scenario</button>
      </div>
      <div ref={sceneRef}>
        <Scene />
      </div>
      {!dropOpener && (
        <button type="button" onClick={() => setOpen(true)}>
          Open setup
        </button>
      )}
      <Sheet
        open={open}
        title="Setup"
        rect={{ left: 10, top: 20, width: 300, height: 400 }}
        inertTargets={[barRef, sceneRef]}
        fallbackFocus={barRef}
        reducedMotion={reducedMotion}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
      >
        {children ?? (
          <>
            <button type="button">Inner one</button>
            <button type="button">Inner two</button>
          </>
        )}
        {nestedOpen && (
          <div data-testid="nested" {...{ [NESTED_LAYER_ATTRIBUTE]: 'open' }}>
            picker
          </div>
        )}
      </Sheet>
    </div>
  );
}

function openSheet() {
  fireEvent.click(screen.getByRole('button', { name: 'Open setup' }));
  return screen.getByRole('dialog');
}

describe('Sheet: the dialog itself', () => {
  it('is a labelled, modal dialog at its layout rect', () => {
    render(<Harness />);
    const dialog = openSheet();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Setup' })).toBeTruthy();
    expect(dialog.style.left).toBe('10px');
    expect(dialog.style.top).toBe('20px');
    expect(dialog.style.width).toBe('300px');
    expect(dialog.style.height).toBe('400px');
    // The scrim is the whole window and contains no text.
    const scrim = document.querySelector('.hud-sheet-scrim');
    expect(scrim?.getAttribute('aria-hidden')).toBe('true');
    expect(scrim?.textContent).toBe('');
  });

  it('focuses its heading on open, not a control', () => {
    render(<Harness />);
    const dialog = openSheet();
    const heading = screen.getByRole('heading', { name: 'Setup' });
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(heading);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('renders nothing at all while closed', () => {
    render(<Harness />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('.hud-sheet-scrim')).toBeNull();
  });
});

describe('Sheet: closing', () => {
  it('closes on Escape and returns focus to the trigger', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const trigger = screen.getByRole('button', { name: 'Open setup' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on a scrim tap but not on a tap inside the panel', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const dialog = openSheet();

    fireEvent.click(screen.getByRole('heading', { name: 'Setup' }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(document.querySelector('.hud-sheet-scrim')!);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog.isConnected).toBe(false);
  });

  it('closes from its Close button and returns focus', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const trigger = screen.getByRole('button', { name: 'Open setup' });
    trigger.focus();
    fireEvent.click(trigger);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
  });

  it('sends focus to the top bar when the opener is gone', () => {
    // No trigger in the tree and nothing focused when the sheet opens: the
    // state a new deal leaves behind when the result card that opened the
    // verdict sheet is replaced.
    render(<Harness dropOpener initialOpen />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });

    // The fallback is the first control inside the top bar: Next hand.
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Next scenario' }),
    );
  });

  it('lets a nested layer consume the first Escape', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Harness onClose={onClose} initialOpen />);
    expect(screen.getByRole('dialog')).toBeTruthy();

    rerender(<Harness onClose={onClose} initialOpen nestedOpen />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();

    // With the nested layer closed, the next Escape closes the sheet.
    rerender(<Harness onClose={onClose} initialOpen />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Sheet: focus containment', () => {
  it('cycles Tab from the last control to the first', () => {
    render(<Harness />);
    openSheet();
    const close = screen.getByRole('button', { name: 'Close' });
    const last = screen.getByRole('button', { name: 'Inner two' });

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
  });

  it('cycles Shift+Tab from the first control to the last', () => {
    render(<Harness />);
    openSheet();
    const close = screen.getByRole('button', { name: 'Close' });
    const last = screen.getByRole('button', { name: 'Inner two' });

    close.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('pulls focus back when something behind the scrim takes it', () => {
    render(<Harness />);
    openSheet();
    const behind = screen.getByRole('button', { name: 'Next scenario' });

    behind.focus();
    // The guard returns focus to the sheet's first control.
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Close' }),
    );
  });
});

describe('Sheet: the page and the scene behind it', () => {
  it('locks page scroll while open and restores it after', () => {
    document.body.style.overflow = 'scroll';
    render(<Harness />);
    openSheet();
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.body.style.overflow).toBe('scroll');
  });

  it('marks the HUD background and the stage inert while open', () => {
    render(<Harness />);
    openSheet();
    expect(screen.getByTestId('hud-bar').hasAttribute('inert')).toBe(true);
    expect(screen.getByTestId('scene').parentElement?.hasAttribute('inert')).toBe(
      true,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByTestId('hud-bar').hasAttribute('inert')).toBe(false);
    expect(screen.getByTestId('scene').parentElement?.hasAttribute('inert')).toBe(
      false,
    );
  });

  it('does not unmount the scene when it opens or closes', () => {
    sceneMounts = 0;
    render(<Harness />);
    const before = screen.getByTestId('scene');
    expect(sceneMounts).toBe(1);

    openSheet();
    expect(screen.getByTestId('scene')).toBe(before);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('scene')).toBe(before);
    expect(sceneMounts).toBe(1);
  });

  it('suppresses its fade under reduced motion', () => {
    render(<Harness reducedMotion />);
    openSheet();
    expect(screen.getByRole('dialog').getAttribute('data-reduced-motion')).toBe(
      'true',
    );
    expect(
      document
        .querySelector('.hud-sheet-scrim')
        ?.getAttribute('data-reduced-motion'),
    ).toBe('true');
  });

  it('fades by default', () => {
    render(<Harness />);
    openSheet();
    expect(screen.getByRole('dialog').getAttribute('data-reduced-motion')).toBe(
      'false',
    );
  });
});
