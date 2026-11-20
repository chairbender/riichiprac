// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKING_STORE_MAX_PIXELS,
  MSAA_SAMPLES,
  MIN_DEVICE_PIXEL_RATIO,
  TIER_BACKING_STORE,
  antiAliasFor,
  autoQualityTier,
  backingStoreBytes,
  backingStorePixels,
  clearThreeFallback,
  effectiveDevicePixelRatio,
  highPerformanceHint,
  isDebugMode,
  isLargeViewport,
  isQualityTier,
  isSmallViewport,
  MAX_DEVICE_PIXEL_RATIO,
  RENDERED3D_EXPOSED,
  readStoredQualityTier,
  readThreeFallback,
  readTierEnvironment,
  rememberThreeFallback,
  resolveQualityTier,
  storeQualityTier,
  threeViewUnavailableReason,
  parseRendererQuery,
  probeCapabilities,
} from './capabilities';
import type { TierEnvironment } from './capabilities';

const MAX_TEXTURE_SIZE = 0x0d33;

interface FakeGl {
  readonly MAX_TEXTURE_SIZE: number;
  getParameter: ReturnType<typeof vi.fn>;
  getExtension: ReturnType<typeof vi.fn>;
}

function fakeGl(overrides: Partial<FakeGl> = {}): FakeGl {
  return {
    MAX_TEXTURE_SIZE,
    getParameter: vi.fn((parameter: number) =>
      parameter === MAX_TEXTURE_SIZE ? 8192 : null,
    ),
    getExtension: vi.fn(() => ({ loseContext: vi.fn() })),
    ...overrides,
  };
}

function mockGetContext(value: unknown) {
  const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
  spy.mockReturnValue(value as never);
  return spy;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('3D feature gate', () => {
  it('offers the 3D view and makes it the default (2026-11-20 decision)', () => {
    expect(RENDERED3D_EXPOSED).toBe(true);
  });

  it('accepts exactly the 3d renderer', () => {
    expect(parseRendererQuery('').renderer).toBeNull();
    expect(parseRendererQuery('?renderer=3d').renderer).toBe('3d');
    expect(parseRendererQuery('renderer=3d').renderer).toBe('3d');
    expect(parseRendererQuery('?renderer=25d').renderer).toBeNull();
    expect(parseRendererQuery('?renderer=3D').renderer).toBeNull();
    expect(parseRendererQuery('?renderer=4d').renderer).toBeNull();
    expect(parseRendererQuery('?renderer=').renderer).toBeNull();
    expect(parseRendererQuery('?renderer').renderer).toBeNull();
  });

  it('accepts the three quality tiers and rejects every other value', () => {
    expect(parseRendererQuery('?quality=high').quality).toBe('high');
    expect(parseRendererQuery('?quality=balanced').quality).toBe('balanced');
    expect(parseRendererQuery('?quality=compat').quality).toBe('compat');
    expect(parseRendererQuery('?quality=ultra').quality).toBeNull();
    expect(parseRendererQuery('?quality=auto').quality).toBeNull();
    expect(parseRendererQuery('').quality).toBeNull();
    expect(isQualityTier('high')).toBe(true);
    expect(isQualityTier('low')).toBe(false);
  });

  it('accepts the committed debug modes and rejects every other value', () => {
    for (const mode of [
      'albedo',
      'height',
      'normal',
      'steps',
      'pom-off',
      'wireframe',
      'hero',
    ] as const) {
      expect(parseRendererQuery(`?debug=${mode}`).debug).toBe(mode);
      expect(isDebugMode(mode)).toBe(true);
    }
    expect(parseRendererQuery('?debug=bloom').debug).toBeNull();
    expect(parseRendererQuery('?debug=ALBEDO').debug).toBeNull();
    expect(parseRendererQuery('').debug).toBeNull();
  });

  it('treats a bare or truthy perf flag as on and everything else as off', () => {
    expect(parseRendererQuery('?perf').perf).toBe(true);
    expect(parseRendererQuery('?perf=1').perf).toBe(true);
    expect(parseRendererQuery('?perf=true').perf).toBe(true);
    expect(parseRendererQuery('?perf=0').perf).toBe(false);
    expect(parseRendererQuery('?perf=false').perf).toBe(false);
    expect(parseRendererQuery('?perf=yes').perf).toBe(false);
    expect(parseRendererQuery('').perf).toBe(false);
  });

  it('parses a full link and lets the first value win', () => {
    expect(
      parseRendererQuery('?renderer=3d&quality=compat&debug=albedo&perf=1'),
    ).toEqual({
      renderer: '3d',
      quality: 'compat',
      debug: 'albedo',
      perf: true,
      preview: null,
    });
    expect(parseRendererQuery('?renderer=3d&renderer=25d').renderer).toBe('3d');
  });

  it('reads the sticks preview flag, and nothing else, as a preview', () => {
    expect(parseRendererQuery('?renderer=3d&preview=sticks').preview).toBe(
      'sticks',
    );
    expect(parseRendererQuery('?preview=sticks').preview).toBe('sticks');
    // 3D-12's `deal` aid was retired in 3D-H2 with the real Next Scenario
    // control; the value is no longer a preview, it is just an unknown word.
    expect(parseRendererQuery('?renderer=3d&preview=deal').preview).toBeNull();
    expect(parseRendererQuery('?preview=deal').preview).toBeNull();
    expect(parseRendererQuery('?preview=all').preview).toBeNull();
    expect(parseRendererQuery('?preview=').preview).toBeNull();
    expect(parseRendererQuery('').preview).toBeNull();
  });

  it('rejects unknown values independently instead of throwing', () => {
    expect(
      parseRendererQuery('?renderer=nope&quality=nope&debug=nope&perf=nope'),
    ).toEqual({
      renderer: null,
      quality: null,
      debug: null,
      perf: false,
      preview: null,
    });
  });
});

describe('backing-store cap', () => {
  it('caps the device pixel ratio at 2 before the area rule', () => {
    expect(MAX_DEVICE_PIXEL_RATIO).toBe(2);
    expect(BACKING_STORE_MAX_PIXELS).toBe(8_290_000);
    // 1920 x 1080 at DPR 2 is 8.29 MP, so the area rule lands a hair under 2.
    expect(effectiveDevicePixelRatio(1920, 1080, 3)).toBeCloseTo(2, 2);
    expect(effectiveDevicePixelRatio(1600, 900, 3)).toBe(2);
    expect(effectiveDevicePixelRatio(1366, 768, 3)).toBe(2);
  });

  it('shrinks the backing store at 4K instead of quadrupling it', () => {
    const dpr = effectiveDevicePixelRatio(3840, 2160, 2);
    // 3840 x 2160 is a hair above the 8.29 MP cap, so the ratio lands a hair
    // under 1 rather than at 1.
    expect(dpr).toBeCloseTo(1, 2);
    expect(3840 * 2160 * dpr * dpr).toBeLessThanOrEqual(
      BACKING_STORE_MAX_PIXELS + 5000,
    );
  });

  it('applies the area rule between DPR 1 and 2', () => {
    const dpr = effectiveDevicePixelRatio(2880, 2160, 2);
    expect(dpr).toBeGreaterThan(1);
    expect(dpr).toBeLessThan(2);
    expect(2880 * 2160 * dpr * dpr).toBeCloseTo(BACKING_STORE_MAX_PIXELS, -2);
  });

  it('can drop below DPR 1 to hold the area cap on a very large viewport', () => {
    const dpr = effectiveDevicePixelRatio(3000, 3000, 2);
    expect(dpr).toBeLessThan(1);
    expect(3000 * 3000 * dpr * dpr).toBeLessThanOrEqual(
      BACKING_STORE_MAX_PIXELS + 5000,
    );
    expect(effectiveDevicePixelRatio(800, 600, 1)).toBe(1);
    expect(effectiveDevicePixelRatio(0, 600, 2)).toBe(1);
    expect(effectiveDevicePixelRatio(800, -1, 2)).toBe(1);
    expect(effectiveDevicePixelRatio(Number.NaN, 600, 2)).toBe(1);
    expect(effectiveDevicePixelRatio(800, 600, Number.NaN)).toBe(1);
  });
});

describe('probeCapabilities', () => {
  it('reports WebGL2 as unavailable without a DOM and never throws', () => {
    const capabilities = probeCapabilities(null);
    expect(capabilities.webgl2).toBe(false);
    expect(capabilities.maxTextureSize).toBe(0);
    expect(capabilities.unavailable).toBeTruthy();
    expect(capabilities.devicePixelRatio).toBeGreaterThan(0);
  });

  it('reports WebGL2 as unavailable under jsdom\u2019s real canvas', () => {
    // jsdom has no canvas implementation and reports that through its virtual
    // console; the probe must absorb it, not surface it. Silence the expected
    // message so the test log stays clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const capabilities = probeCapabilities();
    expect(capabilities.webgl2).toBe(false);
    expect(capabilities.maxTextureSize).toBe(0);
    expect(capabilities.unavailable).toMatch(/WebGL2/);
  });

  it('reports a refused context without throwing', () => {
    mockGetContext(null);
    const capabilities = probeCapabilities();
    expect(capabilities.webgl2).toBe(false);
    expect(capabilities.maxTextureSize).toBe(0);
    expect(capabilities.unavailable).toMatch(/WebGL2/);
  });

  it('reports a throwing context request as unavailable', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => {
        throw new Error('no context for you');
      },
    );
    const capabilities = probeCapabilities();
    expect(capabilities.webgl2).toBe(false);
    expect(capabilities.unavailable).toBeTruthy();
  });

  it('reads the texture limit and releases the probing context', () => {
    const loseContext = vi.fn();
    const gl = fakeGl({
      getExtension: vi.fn(() => ({ loseContext })),
    });
    const getContext = mockGetContext(gl);

    const capabilities = probeCapabilities();

    expect(capabilities).toEqual({
      webgl2: true,
      maxTextureSize: 8192,
      devicePixelRatio: globalThis.devicePixelRatio ?? 1,
      unavailable: null,
    });
    expect(getContext).toHaveBeenCalledTimes(1);
    expect(getContext).toHaveBeenCalledWith('webgl2');
    expect(gl.getExtension).toHaveBeenCalledWith('WEBGL_lose_context');
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it('still succeeds when the loss extension is missing or throws', () => {
    mockGetContext(fakeGl({ getExtension: vi.fn(() => null) }));
    expect(probeCapabilities()).toMatchObject({
      webgl2: true,
      maxTextureSize: 8192,
      unavailable: null,
    });

    mockGetContext(
      fakeGl({
        getExtension: vi.fn(() => {
          throw new Error('extension unavailable');
        }),
      }),
    );
    expect(probeCapabilities().webgl2).toBe(true);
  });

  it('reports an unknown texture limit as 0 rather than NaN', () => {
    mockGetContext(
      fakeGl({ getParameter: vi.fn(() => 'big' as never) }),
    );
    expect(probeCapabilities().maxTextureSize).toBe(0);

    mockGetContext(
      fakeGl({
        getParameter: vi.fn(() => {
          throw new Error('driver exploded');
        }),
      }),
    );
    expect(probeCapabilities().maxTextureSize).toBe(0);
  });
});

describe('the MSAA decision (3D-20)', () => {
  it('asks for MSAA above the compat tier and never on it', () => {
    expect(antiAliasFor('high')).toBe(true);
    expect(antiAliasFor('balanced')).toBe(true);
    expect(antiAliasFor('compat')).toBe(false);
    expect(MSAA_SAMPLES).toBe(4);
  });

  it('states the backing-store cost the decision trades', () => {
    const off = backingStoreBytes(BACKING_STORE_MAX_PIXELS, false);
    const on = backingStoreBytes(BACKING_STORE_MAX_PIXELS, true);
    // Colour: 4 bytes per pixel per sample; depth: 3 bytes (24-bit).
    expect(off.colour).toBe(BACKING_STORE_MAX_PIXELS * 4);
    expect(off.depth).toBe(BACKING_STORE_MAX_PIXELS * 3);
    expect(on.colour).toBe(off.colour * MSAA_SAMPLES);
    expect(on.depth).toBe(off.depth * MSAA_SAMPLES);
    // The plan's numbers: ~58 MB without MSAA, ~232 MB with it at the cap.
    expect(Math.round(off.total / 1e6)).toBe(58);
    expect(Math.round(on.total / 1e6)).toBe(232);
  });
});

describe('per-tier DPR/area cap (3D-11 acceptance)', () => {
  const viewports: readonly [number, number][] = [
    [320, 640],
    [375, 667],
    [768, 1024],
    [1280, 720],
    [1920, 1080],
    [2560, 1440],
    [3840, 2160],
    [5120, 2880],
  ];
  const ratios = [1, 1.5, 2, 3] as const;
  const tiers = ['high', 'balanced', 'compat'] as const;

  it('never exceeds the tier budget across the viewport/DPR matrix', () => {
    for (const tier of tiers) {
      const budget = TIER_BACKING_STORE[tier];
      for (const [width, height] of viewports) {
        for (const dpr of ratios) {
          const pixels = backingStorePixels(width, height, dpr, tier);
          const label = `${tier} ${width}x${height}@${dpr}`;
          expect(pixels, label).toBeLessThanOrEqual(budget.maxPixels + 5000);
          expect(pixels, label).toBeLessThanOrEqual(
            BACKING_STORE_MAX_PIXELS + 5000,
          );
        }
      }
    }
  });

  it('states the plan table’s three tier budgets', () => {
    expect(TIER_BACKING_STORE.high).toEqual({
      maxDevicePixelRatio: MAX_DEVICE_PIXEL_RATIO,
      maxPixels: BACKING_STORE_MAX_PIXELS,
    });
    expect(TIER_BACKING_STORE.balanced).toEqual({
      maxDevicePixelRatio: 1.5,
      maxPixels: 4_665_600,
    });
    expect(TIER_BACKING_STORE.compat).toEqual({
      maxDevicePixelRatio: 1,
      maxPixels: 2_073_600,
    });
    expect(MIN_DEVICE_PIXEL_RATIO).toBeGreaterThan(0);
  });

  it('applies the tier DPR ceiling before the area rule', () => {
    expect(effectiveDevicePixelRatio(800, 600, 3, 'high')).toBe(2);
    expect(effectiveDevicePixelRatio(800, 600, 3, 'balanced')).toBe(1.5);
    expect(effectiveDevicePixelRatio(800, 600, 3, 'compat')).toBe(1);
  });

  it('reports 0 pixels for a nonsensical viewport rather than NaN', () => {
    expect(backingStorePixels(0, 600, 2, 'high')).toBe(0);
    expect(backingStorePixels(Number.NaN, 600, 2, 'high')).toBe(0);
  });
});

function environment(overrides: Partial<TierEnvironment> = {}): TierEnvironment {
  return {
    viewport: { width: 1440, height: 900 },
    touchPrimary: false,
    deviceMemoryGb: 8,
    hardwareConcurrency: 8,
    ...overrides,
  };
}

describe('tier resolution, URL > stored > auto (3D-11)', () => {
  it('lets an explicit ?quality= always win', () => {
    expect(
      resolveQualityTier({
        queryTier: 'compat',
        storedTier: 'high',
        environment: environment(),
      }),
    ).toEqual({ tier: 'compat', source: 'url' });
  });

  it('prefers the stored tier over automatic tiering', () => {
    expect(
      resolveQualityTier({
        queryTier: null,
        storedTier: 'balanced',
        environment: environment({ touchPrimary: true }),
      }),
    ).toEqual({ tier: 'balanced', source: 'stored' });
  });

  it('starts a touch-primary device at compat', () => {
    expect(
      resolveQualityTier({
        queryTier: null,
        storedTier: null,
        environment: environment({ touchPrimary: true }),
      }),
    ).toEqual({ tier: 'compat', source: 'auto' });
  });

  it('starts a small viewport at compat even with a mouse', () => {
    expect(
      autoQualityTier(
        environment({ viewport: { width: 768, height: 1024 } }),
      ),
    ).toBe('compat');
    expect(isSmallViewport({ width: 899, height: 1200 })).toBe(true);
    expect(isSmallViewport({ width: 1200, height: 599 })).toBe(true);
    expect(isSmallViewport({ width: 900, height: 600 })).toBe(false);
  });

  it('starts a large high-performance device at high', () => {
    expect(
      autoQualityTier(
        environment({ viewport: { width: 1920, height: 1080 } }),
      ),
    ).toBe('high');
    expect(isLargeViewport({ width: 1280, height: 720 })).toBe(true);
    expect(highPerformanceHint(environment())).toBe(true);
  });

  it('uses balanced for a large viewport without the hardware hint', () => {
    expect(
      autoQualityTier(
        environment({
          viewport: { width: 1920, height: 1080 },
          deviceMemoryGb: 4,
          hardwareConcurrency: 4,
        }),
      ),
    ).toBe('balanced');
    expect(
      autoQualityTier(
        environment({
          viewport: { width: 1920, height: 1080 },
          deviceMemoryGb: null,
          hardwareConcurrency: null,
        }),
      ),
    ).toBe('balanced');
  });

  it('reads a coarse pointer, memory and cores from the environment', () => {
    const read = readTierEnvironment({
      innerWidth: 390,
      innerHeight: 844,
      navigator: { maxTouchPoints: 5, deviceMemory: 4, hardwareConcurrency: 6 },
      matchMedia: (query) => ({ matches: query === '(pointer: coarse)' }),
    });
    expect(read).toEqual({
      viewport: { width: 390, height: 844 },
      touchPrimary: true,
      deviceMemoryGb: 4,
      hardwareConcurrency: 6,
    });
  });

  it('does not call a touch laptop touch-primary when it has a fine pointer', () => {
    const read = readTierEnvironment({
      innerWidth: 1440,
      innerHeight: 900,
      navigator: { maxTouchPoints: 10 },
      matchMedia: (query) => ({ matches: query === '(pointer: fine)' }),
    });
    expect(read.touchPrimary).toBe(false);
  });

  it('survives a missing or throwing matchMedia', () => {
    expect(
      readTierEnvironment({ innerWidth: 1000, innerHeight: 800, navigator: {} })
        .touchPrimary,
    ).toBe(false);
    expect(
      readTierEnvironment({
        matchMedia: () => {
          throw new Error('no media');
        },
      }).touchPrimary,
    ).toBe(false);
  });
});

describe('stored tier preference and the session fallback memo (3D-11)', () => {
  afterEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('round-trips a stored tier and ignores corrupt values', () => {
    expect(readStoredQualityTier()).toBeNull();
    storeQualityTier('balanced');
    expect(readStoredQualityTier()).toBe('balanced');
    storeQualityTier(null);
    expect(readStoredQualityTier()).toBeNull();
    window.localStorage.setItem('riichiprac.3d.quality', JSON.stringify({ tier: 'high' }));
    expect(readStoredQualityTier()).toBeNull();
  });

  it('round-trips the session fallback and validates its reason', () => {
    expect(readThreeFallback()).toBeNull();
    rememberThreeFallback('context-lost', window.sessionStorage, 1234);
    expect(readThreeFallback()).toEqual({ reason: 'context-lost', at: 1234 });
    rememberThreeFallback('degraded', window.sessionStorage, 5678);
    expect(readThreeFallback()).toEqual({ reason: 'degraded', at: 5678 });
    clearThreeFallback();
    expect(readThreeFallback()).toBeNull();
    window.sessionStorage.setItem(
      'riichiprac.3d.fallback',
      JSON.stringify({ reason: 'bored', at: 1 }),
    );
    expect(readThreeFallback()).toBeNull();
  });
});

describe('the unavailable explanation (3D-11)', () => {
  it('is null when WebGL2 exists and a full sentence when it does not', () => {
    expect(
      threeViewUnavailableReason({
        webgl2: true,
        maxTextureSize: 8192,
        devicePixelRatio: 1,
        unavailable: null,
      }),
    ).toBeNull();
    expect(
      threeViewUnavailableReason({
        webgl2: false,
        maxTextureSize: 0,
        devicePixelRatio: 1,
        unavailable: 'WebGL2 is not available in this browser',
      }),
    ).toBe('3D view unavailable: WebGL2 is not available in this browser.');
    expect(
      threeViewUnavailableReason({
        webgl2: false,
        maxTextureSize: 0,
        devicePixelRatio: 1,
        unavailable: null,
      }),
    ).toMatch(/not supported in this browser/);
  });
});
