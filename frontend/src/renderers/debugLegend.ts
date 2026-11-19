/**
 * The carve debug modes' numeric legends (3D-10).
 *
 * A debug view that shows a colour without saying what the colour *is* is not
 * a measurement. This module is the single, pure source of:
 *
 * - the code each mode writes to the shader's `uDebug` uniform, and
 * - the channel legend the debug HUD prints beside the live numbers.
 *
 * It lives outside `three/` so the host can render the legend without importing
 * the lazy chunk (and without pulling three.js into the entry bundle). The
 * shader's branch order is the contract: `DEBUG_MODE_CODE` below and
 * `materials/tile.frag.ts`'s `if (uDebug …)` chain must agree, which
 * `three/debugPath.test.ts` checks against the shader source.
 *
 * `pom-off`, `shadow-off`, `wireframe` and `hero` resolve to code 0 because they
 * are not false-colour views: they change the step counts or a material flag and
 * shade normally.
 */

import type { DebugMode } from './contract';

/**
 * The numeric code the shader branches on. Keep in step order with
 * `tile.frag.ts`'s `if (uDebug < n.5)` chain; the test asserts that.
 */
export const DEBUG_MODE_CODE = {
  none: 0,
  albedo: 1,
  height: 2,
  normal: 3,
  steps: 4,
  /** `?debug=flags`: face-up, blue-body and plate-zone as a false-colour image. */
  flags: 5,
  /** `?debug=shadow`: the self-shadow's key visibility (3D-10). */
  shadow: 6,
} as const;

/** The shader debug code for a mode, or `none`. */
export function debugCodeFor(debug: DebugMode | null): number {
  if (
    debug === null ||
    debug === 'hero' ||
    debug === 'pom-off' ||
    debug === 'shadow-off' ||
    debug === 'wireframe'
  ) {
    return DEBUG_MODE_CODE.none;
  }
  return DEBUG_MODE_CODE[debug];
}

/** One mode's legend: what it draws, channel by channel, with its code. */
export interface DebugLegend {
  /** The `uDebug` value the mode writes (0 when it is a normal-shaded view). */
  readonly code: number;
  /** A short name for the HUD title. */
  readonly label: string;
  /** The numeric legend: which channel is what, and the ranges it encodes. */
  readonly legend: string;
}

/**
 * Every mode's legend. Typed as a full `Record`, so a new `DebugMode` cannot be
 * added without a legend (a compile error, not a missing panel).
 */
export const DEBUG_LEGENDS: Readonly<Record<DebugMode, DebugLegend>> = {
  albedo: {
    code: DEBUG_MODE_CODE.albedo,
    label: 'albedo',
    legend:
      'RGB = pigment (sRGB atlas sample), A = paint mask; unlit albedo, before normal, AO and lighting',
  },
  height: {
    code: DEBUG_MODE_CODE.height,
    label: 'height',
    legend:
      'grey = 1 − h; h = face_normal_depth.a (1 = open face, 0 = the carve floor at the committed depth)',
  },
  normal: {
    code: DEBUG_MODE_CODE.normal,
    label: 'normal',
    legend:
      'RGB = tangent normal × 0.5 + 0.5 (x right, y down, z out); the map as baked, normal strength 1.0',
  },
  steps: {
    code: DEBUG_MODE_CODE.steps,
    label: 'steps',
    legend:
      'R = depth steps taken ÷ the tier’s count, G = 1 − R (heat); a miss is fully green, a first-step hit red',
  },
  flags: {
    code: DEBUG_MODE_CODE.flags,
    label: 'flags',
    legend: 'R = face-up, G = blue body (else ivory), B = carved-plate zone; the glint probe reads this',
  },
  shadow: {
    code: DEBUG_MODE_CODE.shadow,
    label: 'shadow',
    legend:
      'R = key visibility (1 lit, 0 fully occluded), G = shadow term (uShadowStrength × occlusion), B = 0',
  },
  'pom-off': {
    code: DEBUG_MODE_CODE.none,
    label: 'pom-off',
    legend:
      'carve displacement off: depth steps 0, so no parallax; normal, AO and paint are still sampled',
  },
  'shadow-off': {
    code: DEBUG_MODE_CODE.none,
    label: 'shadow-off',
    legend: 'light-space self-shadow off: shadow steps 0; the depth march and every other term are unchanged',
  },
  wireframe: {
    code: DEBUG_MODE_CODE.none,
    label: 'wireframe',
    legend: 'wireframe on; the fragment shading is unchanged, so the tile count and draws are the same',
  },
  hero: {
    code: DEBUG_MODE_CODE.none,
    label: 'hero',
    legend: 'the 3D-05 hero view; its probe and parallax numbers are in the hero panel',
  },
};

/** The legend for a mode, or null when debug is off. */
export function legendFor(debug: DebugMode | null): DebugLegend | null {
  return debug === null ? null : DEBUG_LEGENDS[debug];
}
