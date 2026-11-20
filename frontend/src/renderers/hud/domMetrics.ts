/**
 * The two DOM reads the HUD's layout needs (3D-H2): the stage's size and the
 * device's safe-area insets.
 *
 * Both are injected as values into the pure `hudLayout()`, so the arithmetic is
 * testable in Node with `{ width: 1920, height: 1080 }` and `NO_INSETS`, and a
 * device with a notch changes only what these two functions return.
 *
 * Everything here is defensive: a missing element, a browser that reports
 * nothing, or a value that is not a positive finite number resolves to 0, and a
 * zero-size stage keeps the HUD unpositioned rather than placing a panel at
 * `NaN`.
 */

import type { HudInsets, StageSize } from './hudLayout';
import { NO_INSETS } from './hudLayout';

/** Parse a computed CSS length; anything unusable is 0. */
function cssPx(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * The live safe-area insets.
 *
 * `probe` is the HUD's own hidden element, whose CSS padding is
 * `env(safe-area-inset-*)` (see `Hud.css`). Reading its **computed** padding
 * gives the used pixel values, which `env()` inside a custom property cannot
 * promise across browsers, and it makes "no notch" literally 0. jsdom returns
 * empty strings, so tests see {@link NO_INSETS}.
 */
export function readSafeAreaInsets(probe: Element | null): HudInsets {
  if (!probe || typeof getComputedStyle !== 'function') return NO_INSETS;
  try {
    const style = getComputedStyle(probe);
    return {
      top: cssPx(style.paddingTop),
      right: cssPx(style.paddingRight),
      bottom: cssPx(style.paddingBottom),
      left: cssPx(style.paddingLeft),
    };
  } catch {
    return NO_INSETS;
  }
}

/**
 * The stage's size in CSS px.
 *
 * The HUD root is `position: fixed; inset: 0`, so its own box is the stage; the
 * window is the fallback for a browser that has not laid it out yet, and a
 * zero result means "do not position anything".
 */
export function readStageSize(element: Element | null): StageSize {
  let width = 0;
  let height = 0;
  if (element && typeof element.getBoundingClientRect === 'function') {
    const box = element.getBoundingClientRect();
    width = Number.isFinite(box.width) && box.width > 0 ? box.width : 0;
    height = Number.isFinite(box.height) && box.height > 0 ? box.height : 0;
  }
  if (width <= 0 || height <= 0) {
    const view = typeof window === 'undefined' ? null : window;
    if (view) {
      if (width <= 0) width = cssPx(String(view.innerWidth));
      if (height <= 0) height = cssPx(String(view.innerHeight));
    }
  }
  return { width, height };
}
