/**
 * Which table the app mounts (3D-02, extended by 3D-14).
 *
 * Precedence, in the order the plan states it: an explicit query parameter
 * beats the stored view, and the stored view beats the store's default
 * (`stacked`, applied by `useSettingsStore` itself). The 3D view is opt-in and
 * never the default (decision D13).
 *
 * From 3D-14 the 3D table is a real `TableView` value, so a stored
 * `rendered3d` mounts it exactly like any other stored choice — with one
 * condition the caller supplies: it may only mount while it can actually run
 * (`allowStoredThreeView`). App folds the browser's WebGL2 support and the
 * per-session close memo (3D-11) into that flag, so an unsupported or closed
 * view falls back to the default 2D view rather than a dead end.
 *
 * The query flag is deliberately not subject to that flag: `?renderer=3d`
 * still asks the host to try, and the host renders its own unsupported or
 * failed message (3D-02, 3D-11).
 *
 * Pure: no DOM, no store read, no three.js. App passes the live
 * `window.location.search` and the store's view.
 */

import { DEFAULT_TABLE_VIEW } from '../store/useSettingsStore';
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
   * Whether a stored 3D choice may mount (3D-14).
   *
   * False when the browser cannot run the view (no WebGL2) or the session
   * already closed it after a degrade; the resolver then returns the default
   * 2D view. Defaults to true, so the stored value is honoured unless the
   * caller says otherwise. An explicit `?renderer=3d` ignores it.
   */
  readonly allowStoredThreeView?: boolean;
}

/**
 * Resolve the mount point from the URL and the stored view.
 *
 * An unknown or malformed `?renderer=` value falls through to the stored view
 * (`parseRendererQuery` rejects it), so a typo can never enable a renderer.
 */
export function resolveTableMount(
  search: string,
  storedView: TableView,
  options: ResolveTableMountOptions = {},
): TableMount {
  const query = parseRendererQuery(search);
  if (query.renderer === '3d') return { kind: 'three', query };

  if (storedView === 'rendered3d') {
    if (options.allowStoredThreeView ?? true) return { kind: 'three', query };
    // The choice is kept in the store; only what is drawn falls back. Stacked
    // is the accessible default and the store's own default view.
    return { kind: '2d', view: DEFAULT_TABLE_VIEW, query };
  }

  return { kind: '2d', view: storedView, query };
}
