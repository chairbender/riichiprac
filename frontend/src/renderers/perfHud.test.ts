/**
 * The `?perf=1` HUD's reading (3D-13).
 *
 * Pure arithmetic over a `RendererStats`, so the HUD's numbers are tested
 * without a browser, a GPU or React.
 */

import { describe, expect, it } from 'vitest';
import type { RendererStats } from './contract';
import { PERF_HUD_SAMPLE_INTERVAL_MS, perfHudReading } from './perfHud';

function stats(overrides: Partial<RendererStats> = {}): RendererStats {
  return {
    tier: 'high',
    drawCalls: 5,
    triangles: 153_600,
    instances: 249,
    devicePixelRatio: 1.5,
    backingStorePixels: 4_665_600,
    atlasBytes: 58_490_880,
    relief: 'relief3d',
    reliefVerification: 'webcrypto',
    pomSteps: 12,
    shadowSteps: 4,
    frameMsP50: 12.5,
    frameMsP95: 15.75,
    frameSamples: 240,
    ...overrides,
  };
}

describe('perfHudReading', () => {
  it('reports every field the HUD prints', () => {
    expect(perfHudReading(stats())).toEqual({
      tier: 'high',
      devicePixelRatio: 1.5,
      backingStoreMp: 4.6656,
      drawCalls: 5,
      triangles: 153_600,
      instances: 249,
      pomSteps: 12,
      shadowSteps: 4,
      frameMsP50: 12.5,
      frameMsP95: 15.75,
      frameSamples: 240,
      atlasBytes: 58_490_880,
    });
  });

  it('uses decimal megapixels, the unit of the tier budgets', () => {
    // §2.8: 3840 x 2160 = 8.2944 MP, stated rounded as 8.29 MP.
    const reading = perfHudReading(stats({ backingStorePixels: 8_294_400 }));
    expect(reading.backingStoreMp).toBeCloseTo(8.2944, 6);
  });

  it('reports zero steps before a view reports them', () => {
    const reading = perfHudReading(
      stats({ pomSteps: undefined, shadowSteps: undefined }),
    );
    expect(reading.pomSteps).toBe(0);
    expect(reading.shadowSteps).toBe(0);
  });

  it('samples the HUD four times a second', () => {
    expect(PERF_HUD_SAMPLE_INTERVAL_MS).toBe(250);
  });
});
