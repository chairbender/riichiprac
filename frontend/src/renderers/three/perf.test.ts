/**
 * The frame-time EMA, the one-tier downgrade and the terminal degrade (3D-11).
 *
 * Every assertion is arithmetic on the monitor's public results: no real
 * timers, no GPU and no rendering. The scene feeds the same samples from
 * animation-frame deltas.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  FRAME_DEGRADE_MS,
  FRAME_DOWNGRADE_MS,
  FRAME_EMA_ALPHA,
  FRAME_SUSTAIN_MS,
  MAX_CREDIBLE_FRAME_MS,
  FrameTimeMonitor,
  nextLowerTier,
} from './perf';

/** Feed `frameMs` frames for `durationMs`, returning the decisions seen. */
function run(
  monitor: FrameTimeMonitor,
  startMs: number,
  frameMs: number,
  durationMs: number,
): ReturnType<FrameTimeMonitor['sample']>[] {
  const decisions: ReturnType<FrameTimeMonitor['sample']>[] = [];
  let now = startMs;
  const end = startMs + durationMs;
  while (now <= end) {
    now += frameMs;
    const decision = monitor.sample(now, frameMs);
    if (decision.action !== 'none') decisions.push(decision);
  }
  return decisions;
}

describe('FrameTimeMonitor', () => {
  it('downgrades exactly one tier after 2 s above 25 ms and logs once', () => {
    const log = vi.fn();
    const monitor = new FrameTimeMonitor('high', { log });
    const decisions = run(monitor, 0, 30, FRAME_SUSTAIN_MS + 100);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      action: 'downgrade',
      tier: 'balanced',
    });
    expect(monitor.tier).toBe('balanced');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/quality reduced from high to balanced/);
  });

  it('does not act before the sustained window closes', () => {
    const log = vi.fn();
    const monitor = new FrameTimeMonitor('high', { log });
    expect(run(monitor, 0, 30, FRAME_SUSTAIN_MS - 200)).toHaveLength(0);
    expect(monitor.tier).toBe('high');
    expect(log).not.toHaveBeenCalled();
  });

  it('stays at high when the frame time is under the threshold', () => {
    const monitor = new FrameTimeMonitor('high');
    expect(run(monitor, 0, 16, 5000)).toHaveLength(0);
    expect(monitor.tier).toBe('high');
    expect(monitor.frameMsEma).toBeCloseTo(16, 3);
  });

  it('takes a second sustained window to reach compat, then one to degrade', () => {
    const log = vi.fn();
    const monitor = new FrameTimeMonitor('high', { log });
    const decisions = run(monitor, 0, 40, FRAME_SUSTAIN_MS * 3 + 300);
    expect(decisions.map((decision) => decision.action)).toEqual([
      'downgrade',
      'downgrade',
      'degrade',
    ]);
    expect(decisions.map((decision) => decision.tier)).toEqual([
      'balanced',
      'compat',
      'compat',
    ]);
    expect(monitor.tier).toBe('compat');
    expect(monitor.degraded).toBe(true);
    // One line per decision, not per sample.
    expect(log).toHaveBeenCalledTimes(3);
  });

  it('never upgrades, even after the frames get fast again', () => {
    const monitor = new FrameTimeMonitor('high', { log: () => undefined });
    run(monitor, 0, 30, FRAME_SUSTAIN_MS + 100);
    expect(monitor.tier).toBe('balanced');
    expect(run(monitor, 10_000, 8, 5000)).toHaveLength(0);
    expect(monitor.tier).toBe('balanced');
  });

  it('ignores a hidden-tab gap rather than treating it as a slow frame', () => {
    const monitor = new FrameTimeMonitor('high', { log: () => undefined });
    run(monitor, 0, 16, 500);
    expect(monitor.sample(30_000, MAX_CREDIBLE_FRAME_MS + 1).action).toBe('none');
    expect(monitor.tier).toBe('high');
    // The sustained clock was reset, so two more seconds are needed.
    expect(run(monitor, 30_000, 30, FRAME_SUSTAIN_MS - 100)).toHaveLength(0);
    expect(monitor.tier).toBe('high');
  });

  it('ignores invalid and zero frame times', () => {
    const monitor = new FrameTimeMonitor('high');
    expect(monitor.sample(0, 0).action).toBe('none');
    expect(monitor.sample(0, -5).action).toBe('none');
    expect(monitor.sample(0, Number.NaN).action).toBe('none');
    expect(monitor.sample(Number.NaN, 30).action).toBe('none');
    expect(monitor.tier).toBe('high');
    expect(monitor.frameMsEma).toBeNull();
  });

  it('uses the 33 ms limit at compat and stops after the terminal degrade', () => {
    const monitor = new FrameTimeMonitor('compat', { log: () => undefined });
    // 30 ms is under compat's 33 ms limit.
    expect(run(monitor, 0, 30, FRAME_SUSTAIN_MS + 100)).toHaveLength(0);
    expect(monitor.tier).toBe('compat');

    const decisions = run(monitor, 3000, 40, FRAME_SUSTAIN_MS + 100);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('degrade');
    expect(monitor.degraded).toBe(true);
    // Terminal: further slow frames decide nothing.
    expect(run(monitor, 6000, 40, FRAME_SUSTAIN_MS + 100)).toHaveLength(0);
  });

  it('re-bases on an explicit tier and clears the terminal state', () => {
    const monitor = new FrameTimeMonitor('compat', { log: () => undefined });
    run(monitor, 0, 40, FRAME_SUSTAIN_MS + 100);
    expect(monitor.degraded).toBe(true);
    monitor.reset('high');
    expect(monitor.tier).toBe('high');
    expect(monitor.degraded).toBe(false);
    expect(monitor.frameMsEma).toBeNull();
  });

  it('reports p50/p95 over the recent samples', () => {
    const monitor = new FrameTimeMonitor('high', { log: () => undefined });
    for (let index = 0; index < 100; index += 1) {
      monitor.sample(index * 16, 16);
    }
    const stats = monitor.stats();
    expect(stats.samples).toBe(100);
    expect(stats.p50).toBeCloseTo(16, 5);
    expect(stats.p95).toBeCloseTo(16, 5);
    for (let index = 0; index < 10; index += 1) {
      monitor.sample(1600 + index * 40, 40);
    }
    expect(monitor.stats().p95).toBeCloseTo(40, 5);
  });

  it('states the constants the acceptance criteria name', () => {
    expect(FRAME_DOWNGRADE_MS).toBe(25);
    expect(FRAME_DEGRADE_MS).toBe(33);
    expect(FRAME_SUSTAIN_MS).toBe(2000);
    expect(FRAME_EMA_ALPHA).toBeGreaterThan(0);
    expect(FRAME_EMA_ALPHA).toBeLessThan(1);
    expect(nextLowerTier('high')).toBe('balanced');
    expect(nextLowerTier('balanced')).toBe('compat');
    expect(nextLowerTier('compat')).toBeNull();
  });
});
