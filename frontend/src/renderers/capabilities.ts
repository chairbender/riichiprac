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

/** The device-pixel-ratio ceiling before the area cap applies (the `high` cap). */
export const MAX_DEVICE_PIXEL_RATIO = 2;

/**
 * The backing-store area ceiling: 8.29 MP (the plan's "3840 x 2160" cap).
 * A 4K display therefore renders at DPR 1, not at the 33.2 MP a raw DPR-2
 * `devicePixelRatio` would ask for.
 */
export const BACKING_STORE_MAX_PIXELS = 8_290_000;

/**
 * Per-tier DPR and backing-store budgets (§2.8's tier table).
 *
 * The table states three targets, and the live renderer must honour the tier it
 * is actually running: `balanced` and `compat` are the downgrade destinations,
 * so a downgrade that kept a 8.29 MP backing store would save shader work but
 * not the fill/buffer cost that made the tier slow in the first place.
 *
 * `maxPixels` is the plan's rounded MP target expressed as a real pixel count:
 * 2880 x 1620 = 4.67 MP and 1920 x 1080 = 2.07 MP. The `high` figure stays
 * {@link BACKING_STORE_MAX_PIXELS} because 3D-20's MSAA numbers and the seam
 * gate are stated against that exact cap.
 *
 * A CSS viewport larger than a tier's budget (a 5K monitor, 14.75 MP) cannot be
 * covered at DPR 1, so {@link effectiveDevicePixelRatio} may return a ratio
 * **below 1**. That is deliberate: the acceptance criterion is the cap, and a
 * 0.75 DPR frame is a better answer than a 14.75 MP one. The old `clamp(..., 1,
 * ...)` wording in §2.8 could not satisfy the cap for such a viewport; the
 * as-built note records the correction.
 */
export interface TierBackingStoreBudget {
  readonly maxDevicePixelRatio: number;
  readonly maxPixels: number;
}

/** The DPR/area budget each quality tier may use. */
export const TIER_BACKING_STORE: Readonly<Record<QualityTier, TierBackingStoreBudget>> = {
  high: { maxDevicePixelRatio: MAX_DEVICE_PIXEL_RATIO, maxPixels: BACKING_STORE_MAX_PIXELS },
  balanced: { maxDevicePixelRatio: 1.5, maxPixels: 4_665_600 },
  compat: { maxDevicePixelRatio: 1, maxPixels: 2_073_600 },
};

/**
 * The lowest ratio the area rule may choose. It only binds on absurdly large
 * CSS viewports (a 30 MP wall display at `compat`); keeping a floor prevents a
 * zero/negative pixel ratio while still honouring the 8.29 MP cap everywhere
 * the acceptance matrix reaches (up to 5120 x 2880).
 */
export const MIN_DEVICE_PIXEL_RATIO = 0.1;

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
 * The effective device pixel ratio for a CSS viewport and a tier, per §2.8:
 *
 * `dpr_eff = min(tierMaxDpr, sqrt(tierMaxPixels / (cssW * cssH)))`
 *
 * The cap is an *area* rule, so a ratio below 1 is legitimate for a CSS
 * viewport larger than the tier's budget (see {@link TIER_BACKING_STORE}). The
 * `high` tier is the 8.29 MP acceptance case: 3840 x 2160 lands at 1, a 4K
 * display with DPR 2 lands at 1, and 5120 x 2880 lands near 0.75 rather than
 * 14.75 MP.
 *
 * A nonsensical viewport (zero, negative or non-finite) falls back to 1 rather
 * than producing `Infinity` or `NaN` for the renderer.
 */
export function effectiveDevicePixelRatio(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  tier: QualityTier = 'high',
): number {
  if (
    !Number.isFinite(cssWidth) ||
    !Number.isFinite(cssHeight) ||
    cssWidth <= 0 ||
    cssHeight <= 0
  ) {
    return 1;
  }
  const budget = TIER_BACKING_STORE[tier] ?? TIER_BACKING_STORE.high;
  const dpr =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  const areaCap = Math.sqrt(budget.maxPixels / (cssWidth * cssHeight));
  return Math.max(
    MIN_DEVICE_PIXEL_RATIO,
    Math.min(Math.min(dpr, budget.maxDevicePixelRatio), areaCap),
  );
}

/** The backing-store pixel count a CSS viewport and DPR resolve to. */
export function backingStorePixels(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  tier: QualityTier = 'high',
): number {
  if (
    !Number.isFinite(cssWidth) ||
    !Number.isFinite(cssHeight) ||
    cssWidth <= 0 ||
    cssHeight <= 0
  ) {
    return 0;
  }
  const ratio = effectiveDevicePixelRatio(
    cssWidth,
    cssHeight,
    devicePixelRatio,
    tier,
  );
  return cssWidth * cssHeight * ratio * ratio;
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

/**
 * A CSS viewport, in pixels.
 *
 * Kept as a plain pair rather than a `DOMRect`/`Window` so the tier rules are
 * testable without a browser.
 */
export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

/** The browser/environment facts automatic tiering reads. */
export interface TierEnvironment {
  readonly viewport: ViewportSize;
  /** The primary pointer is coarse (a phone/tablet), per `(pointer: coarse)`. */
  readonly touchPrimary: boolean;
  /** `navigator.deviceMemory`, in GB, when the browser exposes it. */
  readonly deviceMemoryGb: number | null;
  /** `navigator.hardwareConcurrency`, when the browser exposes it. */
  readonly hardwareConcurrency: number | null;
}

/** The structural subset of `globalThis` {@link readTierEnvironment} needs. */
export interface TierEnvironmentSource {
  readonly innerWidth?: number;
  readonly innerHeight?: number;
  readonly navigator?: {
    readonly maxTouchPoints?: number;
    readonly deviceMemory?: number;
    readonly hardwareConcurrency?: number;
  };
  readonly matchMedia?: (query: string) => { readonly matches: boolean };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function mediaMatches(
  source: TierEnvironmentSource,
  query: string,
): boolean {
  try {
    return source.matchMedia?.(query).matches === true;
  } catch {
    return false;
  }
}

/**
 * Read the viewport, pointer type and two hardware hints.
 *
 * There is no reliable browser query for "discrete GPU": `WEBGL_debug_renderer_info`
 * is privacy-gated and spoofable, and `powerPreference` is a request, not a
 * fact. The hint is therefore the conservative pair `deviceMemory >= 8` **and**
 * `hardwareConcurrency >= 8`, which phones and low-end laptops do not report.
 * A device that hides either value simply resolves to `balanced`, never `high`.
 */
export function readTierEnvironment(
  source: TierEnvironmentSource = globalThis as unknown as TierEnvironmentSource,
): TierEnvironment {
  const navigator = source.navigator;
  const width = finiteOrNull(source.innerWidth) ?? 0;
  const height = finiteOrNull(source.innerHeight) ?? 0;
  const coarse = mediaMatches(source, '(pointer: coarse)');
  const fine = mediaMatches(source, '(pointer: fine)');
  const touchPoints = finiteOrNull(navigator?.maxTouchPoints) ?? 0;
  // A touch-capable laptop with a mouse reports `(pointer: fine)` and must not
  // be pushed to compat, so a coarse pointer wins and a fine pointer vetoes the
  // touch-point fallback.
  const touchPrimary = coarse || (touchPoints > 0 && !fine);
  return {
    viewport: { width, height },
    touchPrimary,
    deviceMemoryGb: finiteOrNull(navigator?.deviceMemory),
    hardwareConcurrency: finiteOrNull(navigator?.hardwareConcurrency),
  };
}

/** A viewport narrower than this (or shorter than the height below) is "small". */
export const SMALL_VIEWPORT_MAX_WIDTH = 900;
/** A viewport shorter than this (or narrower than the width above) is "small". */
export const SMALL_VIEWPORT_MAX_HEIGHT = 600;
/** A viewport at least this wide (and the height below) can start at `high`. */
export const LARGE_VIEWPORT_MIN_WIDTH = 1280;
/** A viewport at least this tall (and the width above) can start at `high`. */
export const LARGE_VIEWPORT_MIN_HEIGHT = 720;
/** The memory (GB) a high-performance hint needs. */
export const HIGH_PERFORMANCE_MIN_MEMORY_GB = 8;
/** The core count a high-performance hint needs. */
export const HIGH_PERFORMANCE_MIN_CORES = 8;

/** True for a phone-sized or short viewport. */
export function isSmallViewport(viewport: ViewportSize): boolean {
  return (
    !(viewport.width >= SMALL_VIEWPORT_MAX_WIDTH) ||
    !(viewport.height >= SMALL_VIEWPORT_MAX_HEIGHT)
  );
}

/** True for a viewport large enough that `high` is worth starting on. */
export function isLargeViewport(viewport: ViewportSize): boolean {
  return (
    viewport.width >= LARGE_VIEWPORT_MIN_WIDTH &&
    viewport.height >= LARGE_VIEWPORT_MIN_HEIGHT
  );
}

/** True when both exposed hardware hints mark a high-performance device. */
export function highPerformanceHint(environment: TierEnvironment): boolean {
  return (
    environment.deviceMemoryGb !== null &&
    environment.deviceMemoryGb >= HIGH_PERFORMANCE_MIN_MEMORY_GB &&
    environment.hardwareConcurrency !== null &&
    environment.hardwareConcurrency >= HIGH_PERFORMANCE_MIN_CORES
  );
}

/**
 * The automatic tier: a phone-class device starts at `compat`, a large
 * high-performance device at `high`, and everything else at `balanced`.
 *
 * This is only the fallback when neither the URL nor a stored preference names
 * a tier; {@link resolveQualityTier} owns that precedence.
 */
export function autoQualityTier(environment: TierEnvironment): QualityTier {
  if (environment.touchPrimary || isSmallViewport(environment.viewport)) {
    return 'compat';
  }
  if (highPerformanceHint(environment) && isLargeViewport(environment.viewport)) {
    return 'high';
  }
  return 'balanced';
}

/** Where the resolved tier came from. */
export type QualityTierSource = 'url' | 'stored' | 'auto';

/** The resolved tier and the rule that chose it. */
export interface QualityTierResolution {
  readonly tier: QualityTier;
  readonly source: QualityTierSource;
}

/** Inputs to {@link resolveQualityTier}. */
export interface TierResolutionInput {
  /** The `?quality=` value, or null when the link did not pin one. */
  readonly queryTier: QualityTier | null;
  /** The stored preference, or null when the browser has none. */
  readonly storedTier: QualityTier | null;
  readonly environment: TierEnvironment;
}

/**
 * Resolve the render tier: **URL > stored > auto** (3D-11).
 *
 * Explicit `?quality=` always wins so a link can force a tier for a review; a
 * stored preference survives a reload; otherwise the environment decides.
 */
export function resolveQualityTier(
  input: TierResolutionInput,
): QualityTierResolution {
  if (isQualityTier(input.queryTier)) {
    return { tier: input.queryTier, source: 'url' };
  }
  if (isQualityTier(input.storedTier)) {
    return { tier: input.storedTier, source: 'stored' };
  }
  return { tier: autoQualityTier(input.environment), source: 'auto' };
}

/** `localStorage` key holding a user-pinned 3D tier. */
export const QUALITY_TIER_STORAGE_KEY = 'riichiprac.3d.quality';

function defaultStorage(kind: 'localStorage' | 'sessionStorage'): Storage | null {
  try {
    return globalThis[kind] ?? null;
  } catch {
    return null;
  }
}

/** Read a stored tier preference; a corrupt or absent value is null. */
export function readStoredQualityTier(
  storage: Storage | null = defaultStorage('localStorage'),
): QualityTier | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(QUALITY_TIER_STORAGE_KEY);
    return isQualityTier(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Persist (or clear, with null) a user-pinned tier. */
export function storeQualityTier(
  tier: QualityTier | null,
  storage: Storage | null = defaultStorage('localStorage'),
): void {
  if (!storage) return;
  try {
    if (tier === null) storage.removeItem(QUALITY_TIER_STORAGE_KEY);
    else storage.setItem(QUALITY_TIER_STORAGE_KEY, tier);
  } catch {
    // Storage disabled or full: the session still runs on the resolved tier.
  }
}

/**
 * Why the 3D view was closed for the rest of this browser session.
 *
 * `context-lost` is terminal: two WebGL context losses in one session mean the
 * driver is not going to be a good host. `degraded` is only remembered so an
 * **automatic** mount does not immediately try the same failing tier again; an
 * explicit `?quality=` or a stored preference may still ask for the view.
 */
export type ThreeFallbackReason = 'context-lost' | 'degraded';

/** The session record written when the 3D view is closed. */
export interface ThreeFallbackRecord {
  readonly reason: ThreeFallbackReason;
  /** `Date.now()` when the record was written (diagnostics only). */
  readonly at: number;
}

/** `sessionStorage` key holding the per-session 3D fallback record. */
export const THREE_FALLBACK_STORAGE_KEY = 'riichiprac.3d.fallback';

function isThreeFallbackReason(value: unknown): value is ThreeFallbackReason {
  return value === 'context-lost' || value === 'degraded';
}

/** Read the session's 3D fallback record, or null when there is none. */
export function readThreeFallback(
  storage: Storage | null = defaultStorage('sessionStorage'),
): ThreeFallbackRecord | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(THREE_FALLBACK_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (!isThreeFallbackReason(record.reason)) return null;
    return {
      reason: record.reason,
      at: typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : 0,
    };
  } catch {
    return null;
  }
}

/** Remember why the 3D view was closed, for the rest of this session. */
export function rememberThreeFallback(
  reason: ThreeFallbackReason,
  storage: Storage | null = defaultStorage('sessionStorage'),
  now: number = Date.now(),
): void {
  if (!storage) return;
  try {
    storage.setItem(
      THREE_FALLBACK_STORAGE_KEY,
      JSON.stringify({ reason, at: now } satisfies ThreeFallbackRecord),
    );
  } catch {
    // Storage disabled: the current mount still falls back; only the next
    // mount's memo is lost.
  }
}

/** Forget the session's 3D fallback record (tests, or an explicit retry). */
export function clearThreeFallback(
  storage: Storage | null = defaultStorage('sessionStorage'),
): void {
  if (!storage) return;
  try {
    storage.removeItem(THREE_FALLBACK_STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/**
 * The reason text the View control disables the 3D option with (3D-14 reads
 * this; the host also prints it when a link asks for 3D on an unsupported
 * browser). Null means the view is supported.
 */
export function threeViewUnavailableReason(
  capabilities: RendererCapabilities,
): string | null {
  if (capabilities.webgl2) return null;
  const detail = capabilities.unavailable?.trim();
  return detail
    ? `3D view unavailable: ${detail.replace(/\.$/, '')}.`
    : '3D view unavailable: WebGL2 is not supported in this browser.';
}
