/**
 * Which table the app mounts (3D-02, extended by 3D-14 and the 2026-11-20
 * default).
 *
 * Precedence, in the order the plan states it: an explicit query parameter
 * beats the chosen view, and the chosen view beats nothing else — the store
 * itself answers with {@link DEFAULT_TABLE_VIEW}, which is the 3D table (user
 * request 2026-11-20, superseding decision D13's "opt-in, never default").
 *
 * The 3D table is a real `TableView` value, so a chosen `rendered3d` mounts it
 * exactly like any other choice — with one condition the caller supplies: it may
 * only mount while it can actually run (`allowThreeView`). App folds the
 * browser's WebGL2 support and the per-session close memo (3D-11) into that
 * flag, so an unsupported or closed view falls back to the 2D
 * {@link FALLBACK_TABLE_VIEW} rather than a dead end. The choice is not
 * rewritten: only what is drawn falls back.
 *
 * The query flag is deliberately not subject to that flag: `?renderer=3d`
 * still asks the host to try, and the host renders its own unsupported or
 * failed message (3D-02, 3D-11).
 *
 * Pure: no DOM, no store read, no three.js. App passes the live
 * `window.location.search` and the store's view.
 */

import { FALLBACK_TABLE_VIEW } from '../store/useSettingsStore';
import type { TableView } from '../store/useSettingsStore';
import { parseRendererQuery } from './capabilities';
import type { RendererQuery } from './capabilities';

/** The selected mount point for the table slot. */
export type TableMount =
  | { readonly kind: 'three'; readonly query: RendererQuery }
  | {
      readonly kind: '2d';
      readonly view: TableView;
      readonly query: RendererQuery;
    };

/** Inputs {@link resolveTableMount} cannot read for itself. */
export interface ResolveTableMountOptions {
  /**
   * Whether the chosen 3D view may mount (3D-14).
   *
   * False when the browser cannot run the view (no WebGL2) or the session
   * already closed it after a degrade; the resolver then returns the 2D
   * fallback. Defaults to true, so the choice is honoured unless the caller
   * says otherwise. An explicit `?renderer=3d` ignores it.
   */
  readonly allowThreeView?: boolean;
}

/**
 * Resolve the mount point from the URL and the chosen view.
 *
 * An unknown or malformed `?renderer=` value falls through to the chosen view
 * (`parseRendererQuery` rejects it), so a typo can never enable a renderer.
 */
export function resolveTableMount(
  search: string,
  chosenView: TableView,
  options: ResolveTableMountOptions = {},
): TableMount {
  const query = parseRendererQuery(search);
  if (query.renderer === '3d') return { kind: 'three', query };

  if (chosenView === 'rendered3d') {
    if (options.allowThreeView ?? true) return { kind: 'three', query };
    // The choice is kept in the store; only what is drawn falls back. Stacked
    // is the accessible four-row layout, and it is never persisted from here.
    return { kind: '2d', view: FALLBACK_TABLE_VIEW, query };
  }

  return { kind: '2d', view: chosenView, query };
}
