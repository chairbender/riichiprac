/**
 * The 3D view's DOM overlay (3D-08): the first part of the floating UI layer.
 *
 * The canvas is an `aria-hidden` picture (3D-02). Everything a user can act on
 * is a real `<button>` here, positioned over the scene with the rectangles the
 * renderer's pure `hitRects()` produced. The layer is absolutely positioned over
 * the full-window stage and never in the document flow (user guidance
 * 2026-11-18, plan §2.1/§2.7).
 *
 * Parity rules this file implements (plan §2.7, 3D-08 acceptance):
 *
 * - one button per concealed hand tile plus the draw, and zero once the hand is
 *   answered;
 * - labels and DOM order identical to `HandDock`'s buttons for the same state
 *   (both use `handTileLabel` and the same `sortHandForDisplay` ordering);
 * - only the buttons take pointer events; the layer itself is
 *   `pointer-events: none`, so the felt and every later chrome control stay
 *   reachable;
 * - the same `onSelectTile` handler the stacked/top-down views call, with the
 *   same arguments;
 * - visible focus, and focus kept somewhere valid when the answered hand
 *   removes the buttons;
 * - hover/focus reported through `onHoverTile` for 3D-12's bounded lift, with
 *   the motion suppressed under `prefers-reduced-motion`. The buttons never move
 *   for it: their rects come from the camera, not from interaction state.
 */

import { useLayoutEffect, useMemo, useRef } from 'react';
import { handTileLabel } from '../handTileLabel';
import { hitRectKey } from './contract';
import type { HitRect, TableSnapshot } from './contract';
import { overlayHandTiles } from './handOverlay';
import type { OverlayHandTile } from './handOverlay';

/** Props for {@link TableOverlay}. */
export interface TableOverlayProps {
  /** The table whose hand is interactive. */
  readonly snapshot: TableSnapshot;
  /** The renderer's current projection, one entry per interactive tile. */
  readonly rects: readonly HitRect[];
  /** Call Riichi is armed, changing the hand buttons' labels. */
  readonly callRiichi?: boolean;
  /** Call Kan is armed, changing the hand buttons' labels. */
  readonly callKan?: boolean;
  /** Suppress the hover/focus lift (the focus ring still shows). */
  readonly reducedMotion?: boolean;
  /** The handler every table view calls for a hand-tile click. */
  readonly onSelectTile: (tile: string, index?: number, isDraw?: boolean) => void;
  /** Report the pointer/focus tile for 3D-12's lift, or null for none. */
  readonly onHoverTile?: (tile: OverlayHandTile | null) => void;
}

/**
 * The hand buttons for the 3D stage.
 *
 * The surrounding group is always present while the view is live, even with
 * zero buttons, so answering (which removes every button) can keep focus on a
 * valid element instead of dropping it onto `document.body`.
 */
export function TableOverlay({
  snapshot,
  rects,
  callRiichi = false,
  callKan = false,
  reducedMotion = false,
  onSelectTile,
  onHoverTile,
}: TableOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  /** The tile key focus/pointer last landed on, so a removal can be noticed. */
  const focusedKeyRef = useRef<string | null>(null);
  /** The tile key currently reported as hovered, so a removal can clear it. */
  const hoveredKeyRef = useRef<string | null>(null);

  const tiles = useMemo(() => overlayHandTiles(snapshot), [snapshot]);
  const rectByKey = useMemo(() => {
    const map = new Map<string, HitRect>();
    for (const rect of rects) map.set(hitRectKey(rect), rect);
    return map;
  }, [rects]);

  const buttons = snapshot.locked
    ? []
    : tiles.flatMap((tile) => {
        const rect = rectByKey.get(hitRectKey(tile));
        return rect ? [{ tile, rect }] : [];
      });

  const keys = buttons.map(({ tile }) => hitRectKey(tile)).join('|');

  /*
   * Keep focus valid. Answering removes the buttons, and a new snapshot replaces
   * them; either way, a focused button that no longer exists must hand its focus
   * to the hand group rather than to the document. The same effect covers a
   * button that survived the change (same key): focus stays on it.
   */
  useLayoutEffect(() => {
    const key = focusedKeyRef.current;
    if (key === null) return;
    const stillThere = keys.split('|').includes(key);
    if (stillThere) return;
    focusedKeyRef.current = null;
    containerRef.current?.focus();
  }, [keys, snapshot.locked]);

  /*
   * Drop a lift whose button has gone. Answering removes every button and a new
   * snapshot may replace the hovered one; a removed element gets no
   * `pointerleave`, so the renderer would otherwise keep that tile raised
   * forever. Null is always reported, even under reduced motion: it only
   * clears, and clearing must never be suppressed.
   */
  useLayoutEffect(() => {
    const key = hoveredKeyRef.current;
    if (key === null) return;
    if (keys.split('|').includes(key)) return;
    hoveredKeyRef.current = null;
    onHoverTile?.(null);
  }, [keys, onHoverTile]);

  const hover = (tile: OverlayHandTile | null, key: string | null = null) => {
    hoveredKeyRef.current = tile ? key : null;
    // Suppress the lift under reduced motion; report the clear regardless so a
    // stale raised tile can never survive.
    if (tile && reducedMotion) return;
    onHoverTile?.(tile);
  };

  return (
    <div
      ref={containerRef}
      className="renderer-3d-hand"
      role="group"
      aria-label="Your hand"
      tabIndex={-1}
      data-interactive-tiles={buttons.length}
    >
      {buttons.map(({ tile, rect }) => {
        const key = hitRectKey(tile);
        const label = handTileLabel({
          code: tile.code,
          isRed: tile.isRed,
          callKan,
          callRiichi,
        });
        return (
          <button
            key={key}
            type="button"
            className="renderer-3d-tile"
            style={{
              left: `${rect.left}px`,
              top: `${rect.top}px`,
              width: `${rect.width}px`,
              height: `${rect.height}px`,
            }}
            aria-label={label}
            data-tile={tile.face}
            data-zone={tile.zone}
            data-slot={tile.slot}
            onClick={() => onSelectTile(tile.code, tile.index, tile.isDraw)}
            onFocus={() => {
              focusedKeyRef.current = key;
              hover(tile, key);
            }}
            onBlur={(event) => {
              // Focus moved deliberately to something outside the hand: do not
              // steal it back later. A null relatedTarget (an element being
              // removed) keeps the key so answering can restore focus.
              const next = event.relatedTarget;
              if (next instanceof Node && !containerRef.current?.contains(next)) {
                focusedKeyRef.current = null;
              }
              // Leaving the hand: clear any lift.
              hover(null);
            }}
            onPointerEnter={() => hover(tile, key)}
            onPointerLeave={() => hover(null)}
          />
        );
      })}
    </div>
  );
}
