// @vitest-environment jsdom
/**
 * `prefers-reduced-motion` wiring (3D-11).
 *
 * The pure read/watch pair is tested with a fake `matchMedia`; the React hook
 * is covered through the host's options and overlay tests.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  REDUCED_MOTION_QUERY,
  prefersReducedMotion,
  watchReducedMotion,
} from './motionPreference';

function fakeMatchMedia(matches: boolean) {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  return {
    query: '',
    matches,
    addEventListener: vi.fn((_type: 'change', listener: (event: { matches: boolean }) => void) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn(
      (_type: 'change', listener: (event: { matches: boolean }) => void) => {
        listeners.delete(listener);
      },
    ),
    fire(next: boolean) {
      for (const listener of listeners) listener({ matches: next });
    },
  };
}

describe('prefersReducedMotion', () => {
  it('uses the reduce media query and reads its match', () => {
    const media = fakeMatchMedia(true);
    const matchMedia = vi.fn(() => media);
    expect(prefersReducedMotion({ matchMedia })).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith(REDUCED_MOTION_QUERY);
    expect(prefersReducedMotion({ matchMedia: () => fakeMatchMedia(false) })).toBe(false);
  });

  it('returns false when the API is missing or throws', () => {
    expect(prefersReducedMotion({})).toBe(false);
    expect(
      prefersReducedMotion({
        matchMedia: () => {
          throw new Error('no media');
        },
      }),
    ).toBe(false);
  });
});

describe('watchReducedMotion', () => {
  it('forwards change events and unsubscribes', () => {
    const media = fakeMatchMedia(false);
    const listener = vi.fn();
    const stop = watchReducedMotion(listener, { matchMedia: () => media });
    media.fire(true);
    expect(listener).toHaveBeenCalledWith(true);
    stop();
    media.fire(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(media.removeEventListener).toHaveBeenCalledTimes(1);
  });

  it('falls back to the deprecated listener pair', () => {
    const listener = vi.fn();
    const listeners: ((event: { matches: boolean }) => void)[] = [];
    const remove = vi.fn();
    const query = {
      matches: false,
      addListener: (next: (event: { matches: boolean }) => void) => {
        listeners.push(next);
      },
      removeListener: remove,
    };
    const stop = watchReducedMotion(listener, { matchMedia: () => query });
    listeners[0]?.({ matches: true });
    expect(listener).toHaveBeenCalledWith(true);
    stop();
    expect(remove).toHaveBeenCalled();
  });

  it('is a no-op without a media query API', () => {
    const stop = watchReducedMotion(() => undefined, {});
    expect(() => stop()).not.toThrow();
  });
});
