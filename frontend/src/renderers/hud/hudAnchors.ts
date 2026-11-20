/**
 * The scene's projection, published for the floating HUD (3D-H2).
 *
 * The HUD is mounted by `App` as a sibling of the stage, but its layout is a
 * function of what the renderer projected: the hand/draw band
 * (`TableRenderer.handBandRect()`) and the compass plate
 * (`TableRenderer.compassRect()`). `RendererHost` owns the renderer and
 * publishes both here whenever it re-projects; `HudLayer` subscribes and
 * recomputes `hudLayout()`.
 *
 * One tiny external store rather than a prop chain: the projection changes on
 * resize, on a new snapshot and on the board becoming current, all inside
 * `RendererHost`'s effects, and routing that through `App` state would re-render
 * the whole 2D app on every resize of the 3D view. App's seam stays the single
 * `<HudLayer>` element (3d_hud.md §9).
 *
 * Rules:
 *
 * - One publisher at a time. A mount publishes under its own owner token, and
 *   an unmount clears only while it still owns the values, so a late effect from
 *   a disposed host cannot blank a live one.
 * - Values, not DOM. Everything here is a number pair; the module has no DOM
 *   access, which is what lets the layout be unit-tested in Node.
 * - Identical numbers publish nothing, so a resize that changes nothing does not
 *   wake the HUD.
 */

import { useSyncExternalStore } from 'react';
import type { HudAnchors } from './hudLayout';

/** No board: the HUD mounts its top bar and nothing anchored to the hand. */
export const NO_HUD_ANCHORS: HudAnchors = { handBand: null, compass: null };

let published: HudAnchors = NO_HUD_ANCHORS;
let owner: object | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function sameRect(
  left: { readonly left: number; readonly top: number; readonly width: number; readonly height: number } | null,
  right: { readonly left: number; readonly top: number; readonly width: number; readonly height: number } | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.left === right.left &&
    left.top === right.top &&
    left.width === right.width &&
    left.height === right.height
  );
}

function sameAnchors(left: HudAnchors, right: HudAnchors): boolean {
  const compassSame =
    left.compass === null || right.compass === null
      ? left.compass === right.compass
      : sameRect(left.compass, right.compass) &&
        left.compass.centreX === right.compass.centreX &&
        left.compass.centreY === right.compass.centreY;
  return compassSame && sameRect(left.handBand, right.handBand);
}

/**
 * Publish a new projection for `token`'s mount.
 *
 * A second publisher is ignored while the first still owns the values: two live
 * renderers are not a supported state (3D-14's one-table rule), and a half-torn
 * down host must not win the race. The active host's own unmount clears the
 * values, after which the next mount may publish.
 */
export function publishHudAnchors(token: object, anchors: HudAnchors): void {
  if (owner !== null && owner !== token) return;
  owner = token;
  if (sameAnchors(published, anchors)) return;
  published = anchors;
  emit();
}

/** Clear the projection when its mount goes away, if it still owns it. */
export function clearHudAnchors(token: object): void {
  if (owner !== token) return;
  owner = null;
  published = NO_HUD_ANCHORS;
  emit();
}

/** The current projection; a stable reference until it actually changes. */
export function hudAnchorsSnapshot(): HudAnchors {
  return published;
}

/** Subscribe to projection changes (React's `useSyncExternalStore` contract). */
export function subscribeHudAnchors(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The live projection, for `HudLayer` and the tests that seed it. */
export function useHudAnchors(): HudAnchors {
  return useSyncExternalStore(
    subscribeHudAnchors,
    hudAnchorsSnapshot,
    hudAnchorsSnapshot,
  );
}
