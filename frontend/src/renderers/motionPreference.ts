/**
 * `prefers-reduced-motion` wiring for the 3D view (3D-11).
 *
 * The host passes the resolved flag into `RendererOptions` and the DOM overlay.
 * 3D-12 owns the motion itself (the deal-in and the hover lift); this module
 * only makes sure the flag follows the operating-system setting, including when
 * the user changes it while the table is open.
 *
 * Both halves are guarded: `matchMedia` is absent under jsdom and in some
 * embeds, and a throwing implementation must not break the table. A missing
 * query means "motion allowed", which is the browser's default.
 */

import { useEffect, useState } from 'react';

/** The media query the app follows. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** The structural subset of `MediaQueryList` the watcher uses. */
export interface MediaQueryListLike {
  readonly matches: boolean;
  addEventListener?: (type: 'change', listener: (event: { matches: boolean }) => void) => void;
  removeEventListener?: (type: 'change', listener: (event: { matches: boolean }) => void) => void;
  /** Safari before 14 used the deprecated pair. */
  addListener?: (listener: (event: { matches: boolean }) => void) => void;
  removeListener?: (listener: (event: { matches: boolean }) => void) => void;
}

/** The structural subset of `globalThis` the preference reads. */
export interface MediaQuerySource {
  matchMedia?: (query: string) => MediaQueryListLike;
}

function readQuery(source: MediaQuerySource): MediaQueryListLike | null {
  try {
    return source.matchMedia?.(REDUCED_MOTION_QUERY) ?? null;
  } catch {
    return null;
  }
}

/** Read the current preference; false when no media query API exists. */
export function prefersReducedMotion(
  source: MediaQuerySource = globalThis as unknown as MediaQuerySource,
): boolean {
  return readQuery(source)?.matches === true;
}

/**
 * Call `listener` whenever the preference changes, and return an unsubscribe.
 *
 * Modern browsers use `addEventListener('change')`; the deprecated
 * `addListener` is kept for Safari 13 and below because a subscription that
 * throws is worse than one extra fallback branch.
 */
export function watchReducedMotion(
  listener: (reduced: boolean) => void,
  source: MediaQuerySource = globalThis as unknown as MediaQuerySource,
): () => void {
  const query = readQuery(source);
  if (!query) return () => undefined;
  const onChange = (event: { matches: boolean }) => listener(event.matches);
  try {
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange);
      return () => query.removeEventListener?.('change', onChange);
    }
    if (typeof query.addListener === 'function') {
      query.addListener(onChange);
      return () => query.removeListener?.(onChange);
    }
  } catch {
    // A driver/browser that refuses the subscription still gets the initial value.
  }
  return () => undefined;
}

/** React state that tracks the preference for the component's lifetime. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => prefersReducedMotion());
  useEffect(() => watchReducedMotion(setReduced), []);
  return reduced;
}
