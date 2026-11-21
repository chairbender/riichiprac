/**
 * The HUD action rail (3D-H3).
 *
 * The floating hand panel's action row: `ActionBar`'s non-discard actions and
 * the Riichi / Kan declaration toggles, in the 2D dock's order and with the 2D
 * dock's labels, `aria-pressed` state and disabled handling — because it renders
 * the same components (`ActionBar`, `CallToggles`) with the same props, not a
 * copy of them.
 *
 * Two rules from `3d_hud.md`:
 *
 * - The toggles are *decisions*, not hand chrome (§4). Arming one changes the
 *   next hand-tile click — including 3D-08's projected buttons, which carry the
 *   armed wording through `handTileLabel` — and the answer itself goes through
 *   the store's `selectTile`, so nothing here depends on the renderer.
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
import { CallToggles } from '../../components/CallToggles';
import {
  actionRailVisible,
  railActions,
  railRowsForHeight,
} from './actionRail';
import type { ActionRailModel } from './actionRail';
import { useHudCollapse } from './hudBand';

export interface ActionRailProps {
  readonly model: ActionRailModel;
  /** Reports the wrapped row count so the panel can reserve 1 or 2 rows. */
  readonly onRowsChange?: (rows: 1 | 2) => void;
}

/**
 * The action row's controls, or nothing.
 *
 * The two groups are siblings inside one wrapping flow, so a narrow stage wraps
 * between controls rather than stacking separate bars.
 */
export function ActionRail({ model, onRowsChange }: ActionRailProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  /*
   * §5's decorations are the band's, not the rail's own choice: square hides
   * the probability badges, portrait draws labels only. The `aria-pressed`
   * state and the accessible names are unaffected.
   */
  const { actionProbabilities, actionStates } = useHudCollapse();

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
  const showToggles =
    !model.isAiScenario && (model.canRiichi || model.kanTile !== null);

  return (
    <div className="hud-action-rail-controls" ref={contentRef}>
      {actions.length > 0 && (
        <ActionBar
          actions={[...model.actions]}
          // The 2D strip only exists before the answer; the rail hides then too.
          disabled={model.answered}
          riichiArmed={model.callRiichi}
          evaluation={model.evaluation ?? null}
          revealMortal={model.revealMortal ?? false}
          showProbability={actionProbabilities}
          showState={actionStates}
          onToggleRiichi={model.onToggleRiichi}
          onAction={model.onAction}
        />
      )}
      {showToggles && (
        <CallToggles
          canRiichi={model.canRiichi}
          kanTile={model.kanTile}
          callRiichi={model.callRiichi}
          callKan={model.callKan}
          disabled={model.answered}
          evaluation={model.evaluation ?? null}
          revealMortal={model.revealMortal ?? false}
          showProbability={actionProbabilities}
          showState={actionStates}
          onToggleRiichi={model.onToggleRiichi}
          onToggleKan={model.onToggleKan}
        />
      )}
    </div>
  );
}
