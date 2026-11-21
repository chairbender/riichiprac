/**
 * Whether the 3D view should render in forced landscape.
 *
 * The 3D table is **landscape-only** (user decision 2026-11-21): a portrait
 * phone is not a supported shape for it — the hand, the rivers and the compass
 * cannot all be legible in a 390 px-wide window — and a player who wants
 * portrait has the stacked and top-down views.
 *
 * So a phone held in portrait still gets the landscape stage: the 3D shell is
 * rotated a quarter turn (`.app-shell--3d[data-forced-landscape='true']`), which
 * makes the whole 3D mount — canvas, HUD, sheets — report the landscape box it
 * was designed for. The player turns the phone to read it, exactly as they would
 * for any landscape-only game.
 *
 * A desktop window that happens to be taller than it is wide is **not**
 * rotated: this is a phone rule, so it needs a coarse pointer. That keeps a
 * narrow desktop window usable and avoids fighting a resizable window.
 */

import { useEffect, useState } from 'react';

function readForcedLandscape(): boolean {
  if (typeof window === 'undefined') return false;
  const coarse =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: coarse)').matches
      : false;
  /*
   * A touch screen counts even when a mouse or pen is the primary pointer
   * (2026-11-22): a phone with a Bluetooth mouse reports `(pointer: fine)` and
   * was being left in portrait. A desktop with no touch points at all is still
   * never turned.
   */
  const touch =
    typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 0;
  return (coarse || touch) && window.innerHeight > window.innerWidth;
}

export function useForcedLandscape(): boolean {
  const [forced, setForced] = useState<boolean>(readForcedLandscape);

  useEffect(() => {
    const update = () => setForced(readForcedLandscape());
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  return forced;
}
