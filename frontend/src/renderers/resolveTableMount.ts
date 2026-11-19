/**
 * Which table the app mounts (3D-02).
 *
 * Precedence, in the order the plan states it: an explicit query parameter
 * beats the stored view, and the stored view beats the store's default
 * (`stacked`, applied by `useSettingsStore` itself). The 3D view is opt-in and
 * never the default (decision D13), so only `?renderer=3d` selects it while
 * `RENDERED3D_EXPOSED` is false; the persistent View control gains a fourth
 * value in 3D-14, and that unit extends this resolver rather than App.
 *
 * Pure: no DOM, no store read, no three.js. App passes the live
 * `window.location.search` and the store's view.
 */

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

/**
 * Resolve the mount point from the URL and the stored view.
 *
 * An unknown or malformed `?renderer=` value falls through to the stored view
 * (`parseRendererQuery` rejects it), so a typo can never enable a renderer.
 */
export function resolveTableMount(search: string, storedView: TableView): TableMount {
  const query = parseRendererQuery(search);
  if (query.renderer === '3d') return { kind: 'three', query };
  return { kind: '2d', view: storedView, query };
}
