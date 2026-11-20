// @vitest-environment jsdom
/**
 * The full-screen toggle for the full-window 3D view (3D-02).
 *
 * jsdom has no Fullscreen API, which is the first case: the control must not be
 * offered where it cannot work. The supported path is exercised with a small
 * stand-in for the API on `document` / the element.
 */

import { useRef } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FullscreenButton } from './FullscreenButton';
import { exitFullscreenIfActive } from '../fullscreen';

function Harness() {
  const shellRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={shellRef} data-testid="shell" />
      <FullscreenButton target={shellRef} />
    </>
  );
}

interface FullscreenGlobals {
  request: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
  element: HTMLElement | null;
}

const originalFullscreenElement = Object.getOwnPropertyDescriptor(
  Document.prototype,
  'fullscreenElement',
);

/**
 * Install a minimal Fullscreen API. Setting `element` and dispatching
 * `fullscreenchange` is how the browser reports a transition.
 */
function stubFullscreen(): FullscreenGlobals {
  const request = vi.fn(async () => undefined);
  const exit = vi.fn(async () => undefined);
  const globals: FullscreenGlobals = { request, exit, element: null };

  // A real browser exposes the method on Element.prototype; jsdom does not.
  Object.defineProperty(Element.prototype, 'requestFullscreen', {
    configurable: true,
    writable: true,
    value: request,
  });
  Object.defineProperty(document, 'exitFullscreen', {
    configurable: true,
    value: exit,
  });
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => globals.element,
  });
  return globals;
}

function restoreFullscreen(): void {
  delete (Element.prototype as { requestFullscreen?: unknown })
    .requestFullscreen;
  delete (document as { exitFullscreen?: unknown }).exitFullscreen;
  if (originalFullscreenElement) {
    Object.defineProperty(document, 'fullscreenElement', originalFullscreenElement);
  } else {
    delete (document as { fullscreenElement?: unknown }).fullscreenElement;
  }
}

afterEach(() => {
  cleanup();
  restoreFullscreen();
  vi.restoreAllMocks();
});

describe('FullscreenButton', () => {
  it('renders nothing where the Fullscreen API is unavailable', () => {
    render(<Harness />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('full-screens the shell, not the canvas', async () => {
    const user = userEvent.setup();
    const api = stubFullscreen();
    render(<Harness />);

    const button = screen.getByRole('button', { name: 'Full screen' });
    await user.click(button);

    expect(api.request).toHaveBeenCalledTimes(1);
    expect(api.request.mock.contexts[0]).toBe(screen.getByTestId('shell'));
    expect(api.exit).not.toHaveBeenCalled();
  });

  it('tracks the browser state and offers the way back out', async () => {
    const user = userEvent.setup();
    const api = stubFullscreen();
    render(<Harness />);
    const shell = screen.getByTestId('shell');

    api.request.mockImplementation(async () => {
      api.element = shell;
    });
    await user.click(screen.getByRole('button', { name: 'Full screen' }));

    // The browser reports the transition asynchronously, with its event.
    act(() => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(screen.getByRole('button', { name: 'Exit full screen' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Exit full screen' }));
    expect(api.exit).toHaveBeenCalledTimes(1);
  });

  it('does not claim another element’s fullscreen session', () => {
    const api = stubFullscreen();
    api.element = document.createElement('div');
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Full screen' })).toBeTruthy();
    expect(document.fullscreenElement).not.toBe(screen.getByTestId('shell'));
  });
});

describe('exitFullscreenIfActive (3D-14)', () => {
  it('leaves full screen only when the document is in it', () => {
    const api = stubFullscreen();

    // Not full screen: no call that a browser could reject.
    exitFullscreenIfActive();
    expect(api.exit).not.toHaveBeenCalled();

    api.element = document.body;
    exitFullscreenIfActive();
    expect(api.exit).toHaveBeenCalledTimes(1);
  });

  it('is a no-op without the API or without a document', () => {
    expect(() => exitFullscreenIfActive(null)).not.toThrow();
    // jsdom has no exitFullscreen; a fullscreenElement without the method must
    // not throw on the way out of the 3D view.
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => document.body,
    });
    expect(() => exitFullscreenIfActive()).not.toThrow();
  });
});
