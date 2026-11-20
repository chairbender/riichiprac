/**
 * The HUD action rail's content model (3D-H3).
 *
 * The rail is the hand panel's action row (`3d_hud.md` §2, §4): `ActionBar`'s
 * non-discard actions, plus the Riichi and Kan toggles that the 2D hand dock
 * keeps at the top of the hand. Both shells render the same components
 * (`components/ActionBar.tsx`, `components/CallToggles.tsx`), so this module is
 * only the decision *what the rail shows* — never a second copy of a control.
 *
 * It lives in a `.ts` module (not the component) because `App` needs the same
 * answer to decide whether the panel reserves the action row at all: an empty
 * row is unmounted, not reserved (§7.1), and a hint-only panel is `40 px`.
 *
 * Pure data: no React, no DOM.
 */

import type { AiActionInfo, AiEvaluation } from '../../types/ai';

/**
 * The rail's height model, in CSS px (§5/§8): one control row is `44 px` (the
 * `--hud-tap` floor) and rows are `4 px` apart — the same gap the panel puts
 * between its hint row and the action row, so the two-row panel's `128 px` is
 * exactly `8 + 24 + 4 + 44 + 4 + 44`. The panel's own heights (84/128) are
 * `hudLayout()`'s.
 */
export const HUD_ACTION_RAIL_ROW = 44;
export const HUD_ACTION_RAIL_GAP = 4;

export interface ActionRailModel {
  /** The state's non-discard actions (App's `actionBarActions`). */
  readonly actions: readonly AiActionInfo[];
  /** Whether Riichi is a legal declaration for this hand (Rust-derived). */
  readonly canRiichi: boolean;
  /** The Kan-callable tile for this lesson, or null (`kanToggleTile`). */
  readonly kanTile: string | null;
  /** The hand is answered: the rail hides and the result slot is free. */
  readonly answered: boolean;
  /**
   * The state is an AI drill: its answer is one of `actions`, never a call
   * toggle (the dock has always hidden the toggles there).
   */
  readonly isAiScenario: boolean;
  readonly callRiichi: boolean;
  readonly callKan: boolean;
  readonly evaluation?: AiEvaluation | null;
  /** Whether Mortal's probability may be shown (answered, or deliberately peeked). */
  readonly revealMortal?: boolean;
  readonly onToggleRiichi: () => void;
  readonly onToggleKan: () => void;
  readonly onAction: (action: AiActionInfo) => void;
}

/** The actions the rail draws: everything but a plain discard. */
export function railActions(actions: readonly AiActionInfo[]): AiActionInfo[] {
  return actions.filter((action) => action.type !== 'discard');
}

/**
 * Whether the rail has anything to show.
 *
 * `App` uses this to pass `undefined` instead of an empty node, so the panel
 * falls back to its `40 px` hint-only shape rather than reserving an empty row.
 */
export function actionRailVisible(model: ActionRailModel): boolean {
  if (model.answered) return false;
  if (railActions(model.actions).length > 0) return true;
  return !model.isAiScenario && (model.canRiichi || model.kanTile !== null);
}

/**
 * How many rows the rail wrapped to, from its measured height.
 *
 * The rail's job is only to report this number: `hudLayout()` owns what it
 * means (the panel is `84 px` for one row and `128 px` for two). Anything above
 * a single row and its gap counts as two, and the composition never allows a
 * third.
 */
export function railRowsForHeight(heightPx: number): 1 | 2 {
  if (!Number.isFinite(heightPx)) return 1;
  return heightPx > HUD_ACTION_RAIL_ROW + HUD_ACTION_RAIL_GAP / 2 ? 2 : 1;
}
