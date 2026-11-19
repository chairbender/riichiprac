/**
 * Capability probe, backing-store cap and the 3D feature gate (3D-01).
 *
 * Everything here is a pure input to the host's decision, not the decision
 * itself: `RendererHost` (3D-02) mounts the view, and the View control gains a
 * fourth value only in 3D-14. This module exists so the gate is testable
 * without a GPU, a browser or three.js.
 *
 * The probe never keeps a live WebGL2 context: it creates one, reads the two
 * facts it needs, asks the `WEBGL_lose_context` extension to release it, and
 * drops its reference. In a browser this matters because a leaked probing
 * context counts against the page's (small) WebGL context budget.
 */

import type { DebugMode, QualityTier, RendererCapabilities } from './contract';

/**
 * Whether the 3D view may be offered from the persistent View control.
 *
 * Decision 1 (2026-11-18): the view stays reachable only by `?renderer=3d`
 * until 3D-15 signs it off. Nothing may flip this except that sign-off, and the
 * view is never the default even then.
 */
export const RENDERED3D_EXPOSED = false;

/** The device-pixel-ratio ceiling before the area cap applies. */
export const MAX_DEVICE_PIXEL_RATIO = 2;

/**
 * The backing-store area ceiling: 8.29 MP (the plan's "3840 x 2160" cap).
 * A 4K display therefore renders at DPR 1, not at the 33.2 MP a raw DPR-2
 * `devicePixelRatio` would ask for.
 */
export const BACKING_STORE_MAX_PIXELS = 8_290_000;

/**
 * The multisample count the context asks for (3D-20), and what it costs.
 *
 * Plan §2.6 originally committed `antialias: false` because "4× MSAA at an
 * 8.3 MP backing store is a fill-rate and memory cost with nothing to buy".
 * 3D-20 measured the thing it buys: the tile's committed bevel is 0.055 units
 * (4.1 px at the reference 16:9 solve) and a groove's face plateau edges land
 * 0.0604 units apart each side — so without MSAA every silhouette and plateau
 * edge is a hard 1-px step and the groove is a single unblended pixel row. The
 * cost is buffers, not shader work: MSAA runs the fragment shader once per
 * *pixel* (per-sample coverage only), so the 12-step POM march is not
 * multiplied. At the 8.29 MP cap that is
 *
 *   colour   4 B x 8.29 MP x 4 = 132.6 MB (vs 33.2 MB)
 *   depth   3 B x 8.29 MP x 4 =  99.5 MB (vs 24.9 MB)
 *   total                         232.1 MB (vs 58.1 MB), +174 MB
 *
 * which is why the `compat` tier (phones, weak GPUs) keeps `antialias: false`.
 */
export const MSAA_SAMPLES = 4;

/** Whether a tier asks the WebGL2 context for MSAA (see {@link MSAA_SAMPLES}). */
export function antiAliasFor(tier: QualityTier): boolean {
  return tier !== 'compat';
}

/** The colour+depth bytes a backing store of `pixels` costs, with/without MSAA. */
export function backingStoreBytes(
  pixels: number,
  antialias: boolean,
): { readonly colour: number; readonly depth: number; readonly total: number } {
  const samples = antialias ? MSAA_SAMPLES : 1;
  const colour = pixels * 4 * samples;
  const depth = pixels * 3 * samples;
  return { colour, depth, total: colour + depth };
}

/** The query-selected debug view list, in the plan's order. */
export const DEBUG_MODES: readonly DebugMode[] = [
  'albedo',
  'height',
  'normal',
  'steps',
  'flags',
  'shadow',
  'pom-off',
  'shadow-off',
  'wireframe',
  'hero',
];

/** The quality tiers a user may pin with `?quality=`. */
const QUALITY_TIERS: readonly QualityTier[] = ['high', 'balanced', 'compat'];

/** Narrow an arbitrary value to a {@link QualityTier}. */
export function isQualityTier(value: unknown): value is QualityTier {
  return (
    typeof value === 'string' &&
    (QUALITY_TIERS as readonly string[]).includes(value)
  );
}

/** Narrow an arbitrary value to a {@link DebugMode}. */
export function isDebugMode(value: unknown): value is DebugMode {
  return (
    typeof value === 'string' &&
    (DEBUG_MODES as readonly string[]).includes(value)
  );
}

/**
 * What `?renderer=3d&quality=…&debug=…&perf&preview=…` asks for.
 *
 * Every field rejects unknown values independently: `?renderer=4d` leaves
 * `renderer` null rather than enabling a different renderer, and a typo in
 * `quality` must not silently pin a tier. Absent `quality` means "let the
 * capability probe and viewport choose" (3D-11).
 */
export interface RendererQuery {
  readonly renderer: '3d' | null;
  readonly quality: QualityTier | null;
  readonly debug: DebugMode | null;
  /** True for a bare `?perf`, `?perf=1` or `?perf=true`; every other value is off. */
  readonly perf: boolean;
  /**
   * A debug-only preview of a state the current hand may not contain, for
   * visual inspection (3D-09). `sticks` marks every seat riichi so the per-seat
   * felt sticks and compass markers can be reviewed on any hand; null is the
   * real state. It never changes the game state or the answer.
   */
  readonly preview: 'sticks' | null;
}

/**
 * Parse the URL search string (with or without its leading `?`).
 *
 * Strict and non-throwing: this runs before the app decides whether to draw a
 * table, so a bad link must fall back to the default view, never crash it.
 */
export function parseRendererQuery(search: string): RendererQuery {
  const params = new URLSearchParams(
    search.startsWith('?') ? search.slice(1) : search,
  );

  const renderer = params.get('renderer');
  const quality = params.get('quality');
  const debug = params.get('debug');
  const perf = params.get('perf');
  const preview = params.get('preview');

  return {
    renderer: renderer === '3d' ? '3d' : null,
    quality: isQualityTier(quality) ? quality : null,
    debug: isDebugMode(debug) ? debug : null,
    perf:
      perf !== null && (perf === '' || perf === '1' || perf === 'true'),
    preview: preview === 'sticks' ? 'sticks' : null,
  };
}

/** `devicePixelRatio`, defaulting to 1 where the browser does not expose one. */
function readDevicePixelRatio(): number {
  const value = (globalThis as { devicePixelRatio?: unknown }).devicePixelRatio;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 1;
}

/**
 * The effective device pixel ratio for a CSS viewport, per §2.8:
 *
 * `dpr_eff = clamp(min(dpr, 2), 1, sqrt(8.29e6 / (cssW * cssH)))`
 *
 * A nonsensical viewport (zero, negative or non-finite) falls back to 1 rather
 * than producing `Infinity` or `NaN` for the renderer.
 */
export function effectiveDevicePixelRatio(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): number {
  if (
    !Number.isFinite(cssWidth) ||
    !Number.isFinite(cssHeight) ||
    cssWidth <= 0 ||
    cssHeight <= 0
  ) {
    return 1;
  }
  const dpr =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  const areaCap = Math.sqrt(BACKING_STORE_MAX_PIXELS / (cssWidth * cssHeight));
  return Math.max(1, Math.min(Math.min(dpr, MAX_DEVICE_PIXEL_RATIO), areaCap));
}

/**
 * Probe what the current browser can do, without leaking a WebGL2 context.
 *
 * `doc` is injectable so Node tests can run the probe without a DOM; production
 * callers pass nothing. The function never throws: a missing DOM, a browser
 * that refuses a context, or a throwing fake all become
 * `{ webgl2: false }` with a reason in `unavailable`.
 */
export function probeCapabilities(
  doc: Document | null = typeof document === 'undefined' ? null : document,
): RendererCapabilities {
  const devicePixelRatio = readDevicePixelRatio();
  const unsupported = (unavailable: string): RendererCapabilities => ({
    webgl2: false,
    maxTextureSize: 0,
    devicePixelRatio,
    unavailable,
  });

  if (!doc || typeof doc.createElement !== 'function') {
    return unsupported('WebGL2 is not available in this environment');
  }

  let gl: WebGL2RenderingContext | null = null;
  try {
    const canvas = doc.createElement('canvas');
    gl = canvas.getContext('webgl2');
  } catch {
    gl = null;
  }
  if (!gl) {
    return unsupported('WebGL2 is not available in this browser');
  }

  let maxTextureSize = 0;
  try {
    const reported = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (typeof reported === 'number' && Number.isFinite(reported)) {
      maxTextureSize = reported;
    }
  } catch {
    maxTextureSize = 0;
  }

  // Release the probing context: it was only ever asked for two numbers.
  try {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    // A driver that refuses the extension still lets the context be collected.
  }

  return { webgl2: true, maxTextureSize, devicePixelRatio, unavailable: null };
}
