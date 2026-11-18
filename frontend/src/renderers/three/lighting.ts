/**
 * The 3D chain's one light rig, and the analytic model of it (3D-05).
 *
 * Plan §2.6 commits a rig with exactly three lights and no environment map, no
 * IBL and no post-processing:
 *
 * 1. a single key matching the 2.5D rig's authored key (`LIGHT` in
 *    `layoutConstants.ts`: azimuth 315°, elevation 55°, `#fff7ea`), so the
 *    highlight lands top-left in both views;
 * 2. a low, cool hemisphere fill (sky `#cfe0ff`, ground the scene's near-black);
 * 3. a very weak neutral ambient.
 *
 * The felt is a `MeshStandardMaterial` and takes three's own lights, which
 * `sceneLights()` builds from these numbers. The carved tile cannot: its
 * material is a hand-written shader (POM, GGX, wrapped diffuse, the carved
 * normal), so it reads the same numbers as **uniforms** instead of from three's
 * light uniforms. `tileLightingUniforms()` is that bridge, and
 * {@link predictLitColour} is the same BRDF in TypeScript so the calibration is
 * a number a test can assert before a GPU is involved.
 *
 * Calibration (the numbers, not a look). The constants are chosen so that an
 * up-facing open face — the pond and the blue back of a face-down wall tile —
 * receives a neutral `1.0` irradiance multiplier and therefore renders at its
 * authored albedo. That is what makes 3D-05's probe gate (`#f5f0eb` ivory and
 * `#132986` blue, each within ΔE 6) a check of the rig rather than a taste
 * call. The key is warm and the fill is cool; `assertNeutralIrradiance` in the
 * unit tests pins the balance, and {@link IRRADIANCE_NEUTRAL_NORMAL} names the
 * orientation it is neutral for.
 *
 * Pure module: no three import, no DOM. `Scene.ts` builds the four light
 * objects from it.
 */

import { LIGHT, TILE } from '../layoutConstants';

/** A colour in linear-light RGB, each channel nominally 0..1 (may exceed 1). */
export type LinearRgb = readonly [number, number, number];

/** A direction in 3D world space (+X right, +Y up, +Z toward the human). */
export type Direction3 = readonly [number, number, number];

/** The tile body's fixed colours and finish, from `shell-spec.json`'s tile block. */
export const BODY = {
  /** Warm ivory: the committed shell face colour (`#f5f0eb`). */
  ivoryHex: '#f5f0eb',
  /** The committed tile back (`#132986`). */
  blueHex: '#132986',
  /**
   * Un-mapped body roughness, straight from `shell-spec.json`: the face is
   * 0.16 with a 0.4 coat, the backing 0.18 with a 0.35 coat. The carved plate
   * overrides this with the relief atlas's own G channel (0.45 open resin,
   * 0.12 lacquer in the paint); `PLATE_ROUGHNESS` documents that split.
   */
  ivoryRoughness: 0.16,
  blueRoughness: 0.18,
  /** Clear-coat weight per side (`shell-spec.json` face 0.4, backing 0.35). */
  coatFace: 0.4,
  coatBack: 0.35,
  /** Clear-coat roughness, both sides. */
  coatRoughness: 0.1,
  /**
   * The white/blue gate, as a fraction of the thickness measured from the back
   * (`bake_shells.py`'s `backEdgeFraction`): the front 30 % of the side wall is
   * ivory, the back 70 % is the blue backing.
   */
  backEdgeFraction: 0.3,
} as const;

/** The light rig's committed numbers. Distances are not used (directional). */
export const LIGHTING = {
  key: {
    hex: LIGHT.keyHex,
    /**
     * `intensity / PI` is the diffuse multiplier: `2.507 / PI * 0.879` = 0.70
     * for an up-facing surface at the committed direction (0.879 is the wrapped
     * `N·L`, not the raw 0.819), which is 70 % of the neutral calibration below.
     */
    intensity: 2.507,
    direction: LIGHT.keyDirection,
  },
  fill: {
    skyHex: '#cfe0ff',
    groundHex: '#0b1512',
    /** The cool half of the neutral calibration (≈ 35 % of the multiplier). */
    intensity: 1.1,
  },
  ambient: {
    hex: '#ffffff',
    /** The neutral remainder (≈ 8 %). */
    intensity: 0.251,
  },
  /** Dielectric F0 of melamine (the carved plate is non-metallic). */
  specularF0: 0.04,
  /**
   * Subsurface wrap for the translucent ivory: `(N·L + wrap) / (1 + wrap)`.
   * 0.5 softens the terminator the way a 16.5 mm slab of melamine actually
   * scatters, without turning the tile into porcelain.
   */
  wrap: 0.5,
} as const;

/** The normal orientation the rig is calibrated neutral for (the felt plane). */
export const IRRADIANCE_NEUTRAL_NORMAL: Direction3 = [0, 1, 0];

/** `x` in the sRGB transfer function's linear segment. */
const SRGB_LINEAR_THRESHOLD = 0.04045;

/** Decode one sRGB channel in `[0, 1]` to linear light. */
export function srgbToLinear(channel: number): number {
  const value = Math.min(1, Math.max(0, channel));
  return value <= SRGB_LINEAR_THRESHOLD
    ? value / 12.92
    : Math.pow((value + 0.055) / 1.055, 2.4);
}

/** Encode one linear-light channel to sRGB in `[0, 1]`. */
export function linearToSrgb(channel: number): number {
  const value = Math.min(1, Math.max(0, channel));
  return value <= 0.0031308
    ? value * 12.92
    : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

/** Encode a linear colour to 8-bit sRGB, the way the framebuffer stores it. */
export function linearToSrgbBytes(colour: LinearRgb): [number, number, number] {
  return [
    Math.round(linearToSrgb(colour[0]) * 255),
    Math.round(linearToSrgb(colour[1]) * 255),
    Math.round(linearToSrgb(colour[2]) * 255),
  ];
}

/** Parse `#rrggbb` (or `#rgb`) into 8-bit channels. Throws on anything else. */
export function hexToBytes(hex: string): [number, number, number] {
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex);
  if (!match) throw new Error(`not a hex colour: ${hex}`);
  const digits = match[1];
  if (digits.length === 3) {
    return [
      parseInt(digits[0] + digits[0], 16),
      parseInt(digits[1] + digits[1], 16),
      parseInt(digits[2] + digits[2], 16),
    ];
  }
  return [
    parseInt(digits.slice(0, 2), 16),
    parseInt(digits.slice(2, 4), 16),
    parseInt(digits.slice(4, 6), 16),
  ];
}

/** Parse a hex colour into linear light. */
export function hexToLinear(hex: string): [number, number, number] {
  const [r, g, b] = hexToBytes(hex);
  return [srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255)];
}

/** The committed values as linear colours, computed once. */
const KEY_LINEAR = hexToLinear(LIGHTING.key.hex);
const FILL_SKY_LINEAR = hexToLinear(LIGHTING.fill.skyHex);
const FILL_GROUND_LINEAR = hexToLinear(LIGHTING.fill.groundHex);
const AMBIENT_LINEAR = hexToLinear(LIGHTING.ambient.hex);

/** Every constant the carved-face shader reads, in shader-ready form. */
export interface LightingUniformValues {
  readonly keyDirection: Direction3;
  /** The key's linear colour. */
  readonly keyColor: LinearRgb;
  readonly keyIntensity: number;
  /** The hemisphere fill's linear sky colour. */
  readonly fillSky: LinearRgb;
  /** The hemisphere fill's linear ground colour. */
  readonly fillGround: LinearRgb;
  readonly fillIntensity: number;
  readonly ambientColor: LinearRgb;
  readonly ambientIntensity: number;
  readonly specularF0: number;
  readonly wrap: number;
  /** The body colours the shader mixes the plate's paint mask into. */
  readonly bodyIvory: LinearRgb;
  readonly bodyBlue: LinearRgb;
  readonly bodyIvoryRoughness: number;
  readonly bodyBlueRoughness: number;
  /** The shell's clear coat and its white/blue gate (see {@link BODY}). */
  readonly coatFace: number;
  readonly coatBack: number;
  readonly coatRoughness: number;
  readonly backEdgeFraction: number;
  readonly thicknessUnits: number;
}

/** The uniform payload `tileMaterial.ts` hands the shader. */
export const TILE_LIGHTING_UNIFORMS: LightingUniformValues = {
  keyDirection: LIGHTING.key.direction,
  keyColor: KEY_LINEAR,
  keyIntensity: LIGHTING.key.intensity,
  fillSky: FILL_SKY_LINEAR,
  fillGround: FILL_GROUND_LINEAR,
  fillIntensity: LIGHTING.fill.intensity,
  ambientColor: AMBIENT_LINEAR,
  ambientIntensity: LIGHTING.ambient.intensity,
  specularF0: LIGHTING.specularF0,
  wrap: LIGHTING.wrap,
  bodyIvory: hexToLinear(BODY.ivoryHex),
  bodyBlue: hexToLinear(BODY.blueHex),
  bodyIvoryRoughness: BODY.ivoryRoughness,
  bodyBlueRoughness: BODY.blueRoughness,
  coatFace: BODY.coatFace,
  coatBack: BODY.coatBack,
  coatRoughness: BODY.coatRoughness,
  backEdgeFraction: BODY.backEdgeFraction,
  thicknessUnits: TILE.thicknessUnits,
};

function dot(a: Direction3, b: Direction3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** `(N·L + wrap) / (1 + wrap)`, clamped: the shader's wrapped diffuse. */
export function wrappedDiffuse(normal: Direction3, light: Direction3, wrap = LIGHTING.wrap): number {
  const ndl = dot(normal, light);
  return Math.min(1, Math.max(0, (ndl + wrap) / (1 + wrap)));
}

/**
 * The diffuse irradiance multiplier for a normal, before albedo — the shader's
 * `key*wrapped + hemisphere fill + ambient` with the `/PI` folded in, exactly
 * as the fragment shader computes it.
 */
export function diffuseIrradiance(normal: Direction3): LinearRgb {
  const wrapped = wrappedDiffuse(normal, LIGHTING.key.direction);
  const up = Math.min(1, Math.max(0, 0.5 + 0.5 * normal[1]));
  const channels = [0, 1, 2] as const;
  const out = channels.map((channel) => {
    const key = KEY_LINEAR[channel] * LIGHTING.key.intensity * wrapped;
    const fill =
      (FILL_GROUND_LINEAR[channel] +
        (FILL_SKY_LINEAR[channel] - FILL_GROUND_LINEAR[channel]) * up) *
      LIGHTING.fill.intensity;
    const ambient = AMBIENT_LINEAR[channel] * LIGHTING.ambient.intensity;
    return (key + fill + ambient) / Math.PI;
  });
  return [out[0], out[1], out[2]];
}

/**
 * The same lighting model the carved-face shader implements, in TypeScript:
 * wrapped Lambert diffuse plus two GGX key lobes — the substrate and the
 * shell's clear coat — with **no** shadow term and no AO (the caller passes the
 * sampled AO). The probe test asserts this prediction against the committed
 * colours; the in-browser probe asserts the shader agrees with it.
 */
export function predictLitColour(options: {
  readonly albedo: LinearRgb;
  readonly normal: Direction3;
  readonly viewDir: Direction3;
  readonly roughness: number;
  /** Clear-coat weight for this surface (0 disables the coat lobe). */
  readonly coat?: number;
  /** Sampled cavity AO, default 1 (an open face). */
  readonly ao?: number;
}): LinearRgb {
  const { albedo, normal, viewDir, roughness } = options;
  const ao = options.ao ?? 1;
  const coat = options.coat ?? BODY.coatFace;
  const irradiance = diffuseIrradiance(normal).map((value) => value * ao) as unknown as LinearRgb;

  const light = LIGHTING.key.direction;
  const half = normalise([
    light[0] + viewDir[0],
    light[1] + viewDir[1],
    light[2] + viewDir[2],
  ]);
  const ndl = Math.min(1, Math.max(0, dot(normal, light)));
  const ndv = Math.min(1, Math.max(1e-4, dot(normal, viewDir)));
  const ndh = Math.min(1, Math.max(0, dot(normal, half)));
  const vdh = Math.min(1, Math.max(0, dot(viewDir, half)));
  const lobe = (surfaceRoughness: number): number => {
    const alpha = Math.max(surfaceRoughness * surfaceRoughness, 0.0016);
    const alpha2 = alpha * alpha;
    const denominator = ndh * ndh * (alpha2 - 1) + 1;
    const distribution = alpha2 / (Math.PI * denominator * denominator);
    const k = alpha * 0.5;
    const geometry = (ndv / (ndv * (1 - k) + k)) * (ndl / (ndl * (1 - k) + k));
    const fresnel = LIGHTING.specularF0 + (1 - LIGHTING.specularF0) * Math.pow(1 - vdh, 5);
    return (distribution * geometry * fresnel) / (4 * ndv * Math.max(ndl, 1e-4)) * ndl;
  };
  const specularScale =
    lobe(roughness) + coat * lobe(BODY.coatRoughness);
  return [
    albedo[0] * irradiance[0] + KEY_LINEAR[0] * LIGHTING.key.intensity * specularScale,
    albedo[1] * irradiance[1] + KEY_LINEAR[1] * LIGHTING.key.intensity * specularScale,
    albedo[2] * irradiance[2] + KEY_LINEAR[2] * LIGHTING.key.intensity * specularScale,
  ];
}

function normalise(v: Direction3): Direction3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** The light rig as plain values, so `Scene.ts` can build three objects from it. */
export interface SceneLightSpec {
  readonly kind: 'key' | 'fill' | 'ambient';
  readonly colorHex: string;
  readonly groundHex?: string;
  readonly intensity: number;
  readonly direction?: Direction3;
}

/**
 * The four light values `Scene.ts` turns into `DirectionalLight`,
 * `HemisphereLight` and `AmbientLight`. The key's position is `direction * 30`
 * (a directional light only uses the direction, and 30 units keeps the position
 * inside the scene's bounds for debugging).
 */
export function sceneLightSpecs(): readonly SceneLightSpec[] {
  return [
    {
      kind: 'key',
      colorHex: LIGHTING.key.hex,
      intensity: LIGHTING.key.intensity,
      direction: LIGHTING.key.direction,
    },
    {
      kind: 'fill',
      colorHex: LIGHTING.fill.skyHex,
      groundHex: LIGHTING.fill.groundHex,
      intensity: LIGHTING.fill.intensity,
    },
    {
      kind: 'ambient',
      colorHex: LIGHTING.ambient.hex,
      intensity: LIGHTING.ambient.intensity,
    },
  ];
}
