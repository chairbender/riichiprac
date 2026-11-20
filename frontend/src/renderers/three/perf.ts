/**
 * Frame-time measurement, the one-tier downgrade and the terminal degrade
 * (3D-11).
 *
 * The rules are deliberately arithmetic, not heuristic: a rolling frame-time
 * EMA above 25 ms for two seconds downgrades exactly one tier; the same rule at
 * `compat` with a 33 ms limit reports `degrade` instead. There is no upgrade
 * path — a downgrade is for the rest of the session unless the user asks for a
 * tier explicitly.
 *
 * This module is pure: it owns no three.js object and reads no clock. The scene
 * feeds it `(nowMs, frameMs)` samples from the frame sampler, which makes the
 * whole rule testable without a GPU or real timers. The one side effect is the
 * `log` callback, called **once per decision** so a downgrade cannot spam the
 * console while the sustained window is still open.
 *
 * Measurement window. The renderer draws on demand (§2.1), so idle time between
 * frames is not frame time and must never be sampled. The scene therefore runs
 * one continuous sampling window shortly after the board mounts, feeding real
 * animation-frame deltas; that is the only continuous rendering in the view
 * until an animation or the 3D-13 perf HUD exists.
 */

import type { QualityTier } from '../contract';

/** The downgrade threshold: above this EMA for the sustained window, drop a tier. */
export const FRAME_DOWNGRADE_MS = 25;

/** The terminal threshold at `compat`: above this, the view is not viable. */
export const FRAME_DEGRADE_MS = 33;

/** How long the EMA must stay above the threshold before acting. */
export const FRAME_SUSTAIN_MS = 2000;

/**
 * The EMA weight on the new sample (0.2 ≈ a 5-frame time constant).
 *
 * Exponential rather than a mean over a fixed window so one hitch cannot flip
 * the decision, and a genuine slowdown still crosses the line within a few
 * frames instead of waiting for a full window.
 */
export const FRAME_EMA_ALPHA = 0.2;

/**
 * Samples longer than this are not frames: they are a hidden tab, a blocked
 * main thread or a gap between on-demand draws. Feeding one into the EMA would
 * downgrade a perfectly fast device after the user switched tabs.
 */
export const MAX_CREDIBLE_FRAME_MS = 250;

/** How many recent frame durations the p50/p95 statistics keep. */
export const FRAME_STAT_WINDOW = 240;

/** The tier below this one, or null at the floor. */
export function nextLowerTier(tier: QualityTier): QualityTier | null {
  if (tier === 'high') return 'balanced';
  if (tier === 'balanced') return 'compat';
  return null;
}

/** What one sample decided. `action === 'none'` is the common case. */
export interface FrameSampleResult {
  readonly action: 'none' | 'downgrade' | 'degrade';
  /** The tier now in force. */
  readonly tier: QualityTier;
  /** The rolling EMA after this sample. */
  readonly frameMsEma: number;
  /** A sentence for the host's notice/HUD, or null when nothing happened. */
  readonly reason: string | null;
}

/** The p50/p95 frame durations over the recent window. */
export interface FrameStats {
  readonly p50: number;
  readonly p95: number;
  readonly samples: number;
}

/** Tunable bounds, for tests and for a future measurement pass. */
export interface FrameTimeMonitorOptions {
  readonly downgradeMs?: number;
  readonly degradeMs?: number;
  readonly sustainedMs?: number;
  readonly alpha?: number;
  readonly maxSampleMs?: number;
  readonly log?: (message: string) => void;
}

function defaultLog(message: string): void {
  console.info(message);
}

/**
 * The rolling frame-time monitor.
 *
 * One instance per mounted scene. `sample` is called with the real animation
 * clock and the delta since the previous frame; it returns the decision and
 * updates the tier internally, so the caller cannot apply the same downgrade
 * twice.
 */
export class FrameTimeMonitor {
  private currentTier: QualityTier;
  private emaMs: number | null = null;
  private overSinceMs: number | null = null;
  private lastSampleMs: number | null = null;
  private terminal = false;
  private readonly durations: number[] = [];
  private readonly downgradeMs: number;
  private readonly degradeMs: number;
  private readonly sustainedMs: number;
  private readonly alpha: number;
  private readonly maxSampleMs: number;
  private readonly log: (message: string) => void;

  constructor(tier: QualityTier, options: FrameTimeMonitorOptions = {}) {
    this.currentTier = tier;
    this.downgradeMs = options.downgradeMs ?? FRAME_DOWNGRADE_MS;
    this.degradeMs = options.degradeMs ?? FRAME_DEGRADE_MS;
    this.sustainedMs = options.sustainedMs ?? FRAME_SUSTAIN_MS;
    this.alpha = options.alpha ?? FRAME_EMA_ALPHA;
    this.maxSampleMs = options.maxSampleMs ?? MAX_CREDIBLE_FRAME_MS;
    this.log = options.log ?? defaultLog;
  }

  /** The tier the monitor currently allows. */
  get tier(): QualityTier {
    return this.currentTier;
  }

  /** The rolling EMA, or null before the first credible sample. */
  get frameMsEma(): number | null {
    return this.emaMs;
  }

  /** True once the terminal degrade fired; no further downgrade is possible. */
  get degraded(): boolean {
    return this.terminal;
  }

  /**
   * Feed one frame delta and return the decision.
   *
   * Invalid, zero or implausibly long deltas are ignored: they are not frame
   * time, and counting them would let a hidden tab or a debugger pause degrade
   * the view.
   */
  sample(nowMs: number, frameMs: number): FrameSampleResult {
    const unchanged = (): FrameSampleResult => ({
      action: 'none',
      tier: this.currentTier,
      frameMsEma: this.emaMs ?? 0,
      reason: null,
    });
    if (
      this.terminal ||
      !Number.isFinite(nowMs) ||
      !Number.isFinite(frameMs) ||
      frameMs <= 0
    ) {
      return unchanged();
    }
    if (frameMs > this.maxSampleMs) {
      // A gap, not a frame. Keep the EMA but stop the sustained clock: the
      // device has not been asked to render for two continuous seconds.
      this.overSinceMs = null;
      this.lastSampleMs = nowMs;
      return unchanged();
    }
    // A long gap between credible samples (an idle stretch, a hidden tab that
    // resumed, a debugger pause) also breaks the sustained window even though
    // the frame itself was plausible.
    if (
      this.lastSampleMs !== null &&
      nowMs - this.lastSampleMs > this.maxSampleMs
    ) {
      this.overSinceMs = null;
    }
    this.lastSampleMs = nowMs;

    this.durations.push(frameMs);
    if (this.durations.length > FRAME_STAT_WINDOW) this.durations.shift();
    this.emaMs =
      this.emaMs === null
        ? frameMs
        : this.alpha * frameMs + (1 - this.alpha) * this.emaMs;

    const limit =
      this.currentTier === 'compat' ? this.degradeMs : this.downgradeMs;
    if (this.emaMs <= limit) {
      this.overSinceMs = null;
      return unchanged();
    }

    if (this.overSinceMs === null) {
      this.overSinceMs = nowMs;
      return unchanged();
    }
    if (nowMs - this.overSinceMs < this.sustainedMs) return unchanged();

    // The sustained window closed. Reset it before returning, so a caller that
    // ignores the result still cannot see the same decision twice.
    this.overSinceMs = null;
    const ema = this.emaMs;
    if (this.currentTier === 'compat') {
      this.terminal = true;
      const reason =
        `Frame time held above ${this.degradeMs} ms for ${this.sustainedMs / 1000} s ` +
        'at the lowest quality tier.';
      this.log(`[3d] ${reason} The host will close the 3D view for this session.`);
      return { action: 'degrade', tier: this.currentTier, frameMsEma: ema, reason };
    }

    const previous = this.currentTier;
    const next = nextLowerTier(previous) ?? previous;
    this.currentTier = next;
    const reason =
      `Frame time held above ${this.downgradeMs} ms for ${this.sustainedMs / 1000} s; ` +
      `quality reduced from ${previous} to ${next}.`;
    this.log(`[3d] ${reason} (EMA ${ema.toFixed(1)} ms.)`);
    return { action: 'downgrade', tier: next, frameMsEma: ema, reason };
  }

  /**
   * Re-base the monitor on a tier the user chose explicitly.
   *
   * Clears the sustained window and any terminal state: an explicit choice is
   * a fresh start, and the no-oscillation rule is about automatic changes, not
   * about refusing the user's own request.
   */
  reset(tier: QualityTier = this.currentTier): void {
    this.currentTier = tier;
    this.emaMs = null;
    this.overSinceMs = null;
    this.lastSampleMs = null;
    this.terminal = false;
    this.durations.length = 0;
  }

  /** The recent frame durations' median and 95th percentile, in milliseconds. */
  stats(): FrameStats {
    if (this.durations.length === 0) return { p50: 0, p95: 0, samples: 0 };
    const sorted = [...this.durations].sort((a, b) => a - b);
    const at = (fraction: number): number => {
      const index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.round((sorted.length - 1) * fraction)),
      );
      return sorted[index];
    };
    return { p50: at(0.5), p95: at(0.95), samples: sorted.length };
  }
}
