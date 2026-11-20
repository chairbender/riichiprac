/**
 * The lazy 3D entry point (3D-02).
 *
 * `RendererHost` reaches this module only through `import('./three')`, and this
 * is the only shape it needs: one factory returning a {@link TableRenderer}.
 * Everything three.js-dependent lives behind this file, so the stacked,
 * top-down and 2.5D views never download a byte of it (decision D1).
 */

import type { RendererOptions, TableRenderer } from '../contract';
import type { MotionClock } from './motion';
import { TableScene } from './Scene';

/**
 * Create the 3D renderer for a canvas the host already owns.
 *
 * The host creates the canvas *before* importing this module, so a WebGL2
 * refusal is decided before any three.js code runs. A canvas that still cannot
 * produce a WebGL2 context throws here, and the host reports `failed`.
 *
 * `clock` is the motion clock (3D-12). The host omits it and the scene reads
 * `performance.now`; a test can pass a fake one so the deal-in never waits on a
 * real timer.
 */
export function createRenderer(
  canvas: HTMLCanvasElement,
  options: RendererOptions,
  clock?: MotionClock,
): TableRenderer {
  return new TableScene(canvas, options, clock);
}
