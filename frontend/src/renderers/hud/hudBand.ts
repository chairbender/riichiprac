/**
 * The HUD's aspect band, as React context (3D-H6, `3d_hud.md` §5).
 *
 * `hudLayout()` is the one place the band is derived, from the live stage size.
 * The top-bar and call-row controls are built by `App` but rendered inside
 * `HudLayer`, so the layer publishes the band here and each control reads it
 * with `useHudCollapse()` — no second aspect calculation, no `window` reads in a
 * component, and no prop drilling through `App` (which never knows the stage
 * size).
 *
 * The default is `wide`, the uncollapsed form: a control rendered outside the
 * layer (a unit test, a review page) keeps every label and badge, which is what
 * the 2D components' optional props default to as well.
 */

import { createContext, useContext } from 'react';
import { hudCollapse } from './hudLayout';
import type { HudBand, HudCollapse } from './hudLayout';

/** The band published by the nearest `HudLayer`; `wide` outside one. */
export const HudBandContext = createContext<HudBand>('wide');

/** The band in force for this control. */
export function useHudBand(): HudBand {
  return useContext(HudBandContext);
}

/** §5's collapse rules for the band in force. */
export function useHudCollapse(): HudCollapse {
  return hudCollapse(useHudBand());
}
