// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKING_STORE_MAX_PIXELS,
  MSAA_SAMPLES,
  antiAliasFor,
  backingStoreBytes,
  MAX_DEVICE_PIXEL_RATIO,
  RENDERED3D_EXPOSED,
  effectiveDevicePixelRatio,
  isDebugMode,
  isQualityTier,
  parseRendererQuery,
  probeCapabilities,
} from './capabilities';

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
  it('stays behind the query flag until 3D-15 signs it off', () => {
    expect(RENDERED3D_EXPOSED).toBe(false);
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
    });
    expect(parseRendererQuery('?renderer=3d&renderer=25d').renderer).toBe('3d');
  });

  it('rejects unknown values independently instead of throwing', () => {
    expect(
      parseRendererQuery('?renderer=nope&quality=nope&debug=nope&perf=nope'),
    ).toEqual({
      renderer: null,
      quality: null,
      debug: null,
      perf: false,
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
    expect(dpr).toBeGreaterThanOrEqual(1);
    expect(dpr).toBeLessThan(1.0001);
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

  it('never returns less than 1 and never returns a nonsensical value', () => {
    expect(effectiveDevicePixelRatio(3000, 3000, 2)).toBe(1);
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
