/**
 * The `?perf=1` HUD's reading (3D-13).
 *
 * `TableRenderer.measure()` reports raw renderer facts; this module turns them
 * into the exact numbers the HUD prints, so the report is a pure, testable
 * function rather than arithmetic spread through JSX. It lives beside the other
 * host-side pure helpers (not under `three/`) because the host imports it
 * synchronously: it must not pull any byte of three.js into the entry chunk.
 *
 * The measurement protocol (plan §2.8): the HUD is open with
 * `?renderer=3d&perf=1`, the board has reported ready, and p50/p95 are read
 * after at least `FRAME_STAT_WINDOW` (240) live samples — a warm run. The first
 * five seconds after mount are the cold window and are not quoted as a result.
 */

import type { QualityTier, RendererStats } from './contract';

/**
 * How often the HUD re-reads `measure()` while it is open.
 *
 * Slower than a frame on purpose: the HUD is a read-out, not a renderer input,
 * and four reads a second is enough for the eye while costing one React render
 * per interval. It is only ever scheduled when `perfHud` is true; with the HUD
 * off there is no interval and no continuous rendering.
 */
export const PERF_HUD_SAMPLE_INTERVAL_MS = 250;

/** What the HUD prints, derived from one `measure()` call. */
export interface PerfHudReading {
  readonly tier: QualityTier;
  /** The ratio the renderer resolved after the tier's DPR/area cap. */
  readonly devicePixelRatio: number;
  /** The backing store's area in megapixels (`8.29` at the high-tier cap). */
  readonly backingStoreMp: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly instances: number;
  /** The live depth-march steps; 0 is the un-carved path. */
  readonly pomSteps: number;
  /** The live self-shadow march steps; 0 is shadow-off. */
  readonly shadowSteps: number;
  readonly frameMsP50: number;
  readonly frameMsP95: number;
  /** How many frame durations the percentiles cover. */
  readonly frameSamples: number;
  readonly atlasBytes: number;
}

/**
 * Derive the HUD's reading.
 *
 * `backingStorePixels / 1e6` is decimal megapixels, the unit the tier budgets
 * are stated in (§2.8: 8.29 / 4.6656 / 2.0736 MP), so the HUD can be compared
 * with the plan without a conversion in the reader's head.
 */
export function perfHudReading(stats: RendererStats): PerfHudReading {
  return {
    tier: stats.tier,
    devicePixelRatio: stats.devicePixelRatio,
    backingStoreMp: stats.backingStorePixels / 1_000_000,
    drawCalls: stats.drawCalls,
    triangles: stats.triangles,
    instances: stats.instances,
    pomSteps: stats.pomSteps ?? 0,
    shadowSteps: stats.shadowSteps ?? 0,
    frameMsP50: stats.frameMsP50,
    frameMsP95: stats.frameMsP95,
    frameSamples: stats.frameSamples,
    atlasBytes: stats.atlasBytes,
  };
}
