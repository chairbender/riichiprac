/**
 * The HUD action rail (3D-H3).
 *
 * The floating hand panel's action row: `ActionBar`'s remaining non-discard
 * actions and the shared `CallControls` bar, in the 2D dock's order and with the
 * 2D dock's words and disabled handling — because it renders the same
 * components (`ActionBar`, `CallControls`) with the same props, not a copy of
 * them.
 *
 * Two rules from `3d_hud.md`:
 *
 * - The calls are *decisions*, not hand chrome (§4). Pressing one either
 *   submits it (one legal way to make it) or opens a pick step whose tiles come
 *   from the projected hand: 3D-08's buttons call the store's `selectTile`, so
 *   nothing here depends on the renderer.
 * - When the row would be empty it is **unmounted**, leaving the hint-only
 *   panel (§7.1). `App` asks `actionRailVisible()` before mounting this, and the
 *   component returns null for the same reason so no caller can reserve it.
 *
 * The row can wrap to two on a narrow stage. The panel's height is
 * `hudLayout()`'s arithmetic, so this component measures its own rendered
 * height and reports the row count; it never sets a height of its own.
 */

import { useCallback, useLayoutEffect, useRef } from 'react';
import { ActionBar } from '../../components/ActionBar';
import { CallControls } from '../../components/CallControls';
import {
  actionRailVisible,
  railActions,
  railRowsForHeight,
} from './actionRail';
import type { ActionRailModel } from './actionRail';

export interface ActionRailProps {
  readonly model: ActionRailModel;
  /** Reports the wrapped row count so the panel can reserve 1 or 2 rows. */
  readonly onRowsChange?: (rows: 1 | 2) => void;
}

/**
 * The action row's controls, or nothing.
 *
 * The two groups are siblings inside one wrapping flow, so a narrow stage wraps
 * between controls rather than stacking separate bars. The call bar is the
 * right-aligned group: the row grows towards the left as calls are added.
 */
export function ActionRail({ model, onRowsChange }: ActionRailProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  const measure = useCallback(() => {
    const element = contentRef.current;
    if (!element) return;
    const height = element.getBoundingClientRect().height;
    onRowsChange?.(railRowsForHeight(height));
  }, [onRowsChange]);

  useLayoutEffect(() => {
    measure();
    if (typeof ResizeObserver !== 'function' || !contentRef.current) return;
    const observer = new ResizeObserver(measure);
    observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [measure]);

  if (!actionRailVisible(model)) return null;

  const actions = railActions(model.actions);

  return (
    <div className="hud-action-rail-controls" ref={contentRef}>
      {actions.length > 0 && (
        <ActionBar
          actions={[...model.actions]}
          disabled={model.answered}
          evaluation={model.evaluation ?? null}
          revealMortal={model.revealMortal ?? false}
          onAction={model.onAction}
        />
      )}
      <CallControls
        buttons={model.callButtons}
        pending={model.pendingCall}
        error={model.callError}
        disabled={model.answered}
        evaluation={model.evaluation ?? null}
        revealMortal={model.revealMortal ?? false}
        onBegin={model.onBeginCall}
        onPass={model.onPass}
        onCancel={model.onCancelCall}
        onPreview={model.onPreviewCall}
      />
    </div>
  );
}
