// @vitest-environment jsdom
/**
 * The landscape-only rule for the 3D view (user decision 2026-11-21).
 *
 * A phone held in portrait still gets the landscape stage: the shell is turned
 * a quarter turn, so the rule is "coarse pointer and taller than it is wide".
 * A narrow desktop window must not be turned — the player can resize it, and
 * the 2D views are the portrait answer.
 */

import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useForcedLandscape } from './useForcedLandscape';

const matchMedia = vi.fn();

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: matchMedia,
  });
  matchMedia.mockImplementation((query: string) => ({
    matches: query === '(pointer: coarse)',
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

afterEach(() => {
  cleanup();
  matchMedia.mockReset();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
});

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

describe('useForcedLandscape', () => {
  it('turns a coarse-pointer stage that is taller than it is wide', () => {
    setViewport(390, 844);
    const { result } = renderHook(() => useForcedLandscape());
    expect(result.current).toBe(true);
  });

  it('leaves an already-landscape phone alone', () => {
    setViewport(844, 390);
    const { result } = renderHook(() => useForcedLandscape());
    expect(result.current).toBe(false);
  });

  it('never turns a desktop window, however tall it is', () => {
    matchMedia.mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    setViewport(600, 900);
    const { result } = renderHook(() => useForcedLandscape());
    expect(result.current).toBe(false);
  });
});

describe('useForcedLandscape: the touch fallback (2026-11-22)', () => {
  it('turns a touch screen in portrait even when the pointer is fine', () => {
    // A phone with a Bluetooth mouse reports `(pointer: fine)`; the touch points
    // are what still make it a phone.
    matchMedia.mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    Object.defineProperty(navigator, 'maxTouchPoints', {
      configurable: true,
      value: 5,
    });
    setViewport(412, 915);
    const { result } = renderHook(() => useForcedLandscape());
    expect(result.current).toBe(true);
    Object.defineProperty(navigator, 'maxTouchPoints', {
      configurable: true,
      value: 0,
    });
  });
});
