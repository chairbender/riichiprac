/**
 * The light rig's calibration, as numbers (3D-05).
 *
 * The carved tile's shader is hand-written, so its lighting is not covered by
 * three's own tests: the constants, the neutral calibration and the BRDF
 * prediction are this unit's responsibility. These tests pin:
 *
 * - the rig is neutral on an up-facing (pond/blue-back) normal and within 4 %
 *   of neutral on the reclined hand's normal — that is what makes the committed
 *   ivory and blue reachable at the probe points;
 * - the committed `#f5f0eb` and `#132986` predict to within ΔE 6 of themselves
 *   at the hero slots' real normals and view directions (the same tolerance the
 *   in-browser probe enforces);
 * - the wrapped diffuse is clamped, monotone and equal to the plain `N·L` at
 *   the wrap midpoint;
 * - the sRGB/linear conversions round-trip, because the probe comparison is only
 *   meaningful if the colour science is exact.
 */

import { describe, expect, it } from 'vitest';
import { LIGHT } from '../layoutConstants';
import {
  BODY,
  IRRADIANCE_NEUTRAL_NORMAL,
  LIGHTING,
  TILE_SHADE,
  diffuseIrradiance,
  hexToBytes,
  hexToLinear,
  linearToSrgb,
  linearToSrgbBytes,
  predictLitColour,
  sceneLightSpecs,
  shadeAt,
  srgbToLinear,
  wrappedDiffuse,
} from './lighting';
import type { LinearRgb } from './lighting';
import { HERO_SLOTS, heroVisibleNormal } from './hero';
import { deltaE76, predictedProbeSrgb, srgbBytesToLab } from './probes';

/** The reclined hand's face normal at the committed 40° recline. */
const HAND_NORMAL = [0, Math.sin((40 * Math.PI) / 180), Math.cos((40 * Math.PI) / 180)] as const;

function targetColour(hex: string): [number, number, number] {
  return hexToBytes(hex);
}

function deltaEFromHex(rgb: readonly [number, number, number], hex: string): number {
  return deltaE76(srgbBytesToLab(rgb), srgbBytesToLab(targetColour(hex)));
}

describe('light rig calibration', () => {
  it('is neutral (1.0 irradiance) on an up-facing normal', () => {
    const irradiance = diffuseIrradiance(IRRADIANCE_NEUTRAL_NORMAL);
    for (const channel of irradiance) {
      expect(channel).toBeGreaterThan(0.98);
      expect(channel).toBeLessThan(1.02);
    }
  });

  it('stays within 5% of neutral on the reclined hand', () => {
    // The reclined hand sees less of the cool sky than a flat pond tile, so it
    // is ~4.5% dimmer in linear light: about two sRGB steps, and 1.5 ΔE on the
    // ivory. The calibration is neutral for the felt plane, not for every pose.
    const irradiance = diffuseIrradiance(HAND_NORMAL);
    for (const channel of irradiance) {
      expect(channel).toBeGreaterThan(0.95);
      expect(channel).toBeLessThan(1.05);
    }
  });

  it('keeps the warm key and cool fill balanced, not just bright', () => {
    const [r, g, b] = diffuseIrradiance(IRRADIANCE_NEUTRAL_NORMAL);
    // The plan's key is warm (#fff7ea) and the fill cool (#cfe0ff); the sum has
    // to stay within 2% across channels or the ivory would read tinted.
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(0.02);
  });

  it('predicts the committed ivory at both face probes within ΔE 6', () => {
    // The committed camera looks down at ~50°, so a point on the table sees the
    // eye above and toward +Z. The exact per-tile ray is used by the in-browser
    // probe; this prediction only needs a plausible one.
    const VIEW = [0, 0.766, 0.643] as const;

    const pond = predictedProbeSrgb({
      hex: BODY.ivoryHex,
      normal: [0, 1, 0],
      viewDir: VIEW,
      roughness: 0.45,
    });
    expect(deltaEFromHex(pond, BODY.ivoryHex)).toBeLessThan(6);

    const hand = predictedProbeSrgb({
      hex: BODY.ivoryHex,
      normal: HAND_NORMAL,
      viewDir: VIEW,
      roughness: 0.45,
    });
    expect(deltaEFromHex(hand, BODY.ivoryHex)).toBeLessThan(6);
  });

  it('predicts the committed blue on the visible back of the face-down slot', () => {
    const back = HERO_SLOTS.find((slot) => slot.id === 'back');
    if (!back) throw new Error('the hero slots must include the blue back');
    const normal = heroVisibleNormal(back);
    // The visible back faces up: the prediction is the neutral calibration.
    expect(normal[1]).toBeGreaterThan(0.99);
    const predicted = predictedProbeSrgb({
      hex: BODY.blueHex,
      normal,
      viewDir: [0, 0.7, 0.7],
      roughness: BODY.blueRoughness,
    });
    expect(deltaEFromHex(predicted, BODY.blueHex)).toBeLessThan(6);
  });

  it('scales the prediction with albedo, not with a hidden exposure', () => {
    const dark = predictLitColour({
      albedo: hexToLinear('#404040') as LinearRgb,
      normal: [0, 1, 0],
      viewDir: [0, 0.7, 0.7],
      roughness: 0.45,
    });
    const light = predictLitColour({
      albedo: hexToLinear('#808080') as LinearRgb,
      normal: [0, 1, 0],
      viewDir: [0, 0.7, 0.7],
      roughness: 0.45,
    });
    expect(light[0]).toBeGreaterThan(dark[0] * 2);
  });
});

describe('the private-hand shade (3D-18)', () => {
  it('leaves every up-facing surface on the full key', () => {
    // The pond, the melds, the dora and the wall's backs are all N.y = 1 and the
    // five zones carry shade 0, so the effect cannot touch a single top.
    expect(shadeAt(1, TILE_SHADE.humanHand)).toBe(0);
    expect(shadeAt(1, TILE_SHADE.opponentHand)).toBe(0);
    expect(shadeAt(TILE_SHADE.topLitFull, TILE_SHADE.humanHand)).toBe(0);
    const lit = diffuseIrradiance([0, 1, 0]);
    const shaded = diffuseIrradiance([0, 1, 0], shadeAt(1, TILE_SHADE.humanHand));
    expect(shaded).toEqual(lit);
  });

  it('removes the key from the hand face and keeps the fill', () => {
    // The reclined hand's face is 40 deg off vertical: N.y = cos(40) ~ 0.64,
    // well below topLitFrom, so it takes the full zone amount.
    expect(HAND_NORMAL[1]).toBeLessThan(TILE_SHADE.topLitFrom);
    const amount = shadeAt(HAND_NORMAL[1], TILE_SHADE.humanHand);
    expect(amount).toBeCloseTo(TILE_SHADE.humanHand, 12);

    const lit = diffuseIrradiance(HAND_NORMAL);
    const shaded = diffuseIrradiance(HAND_NORMAL, amount);
    for (let channel = 0; channel < 3; channel += 1) {
      // Darker, but not off: the fill and ambient still land.
      expect(shaded[channel]).toBeGreaterThan(lit[channel] * 0.6);
      expect(shaded[channel]).toBeLessThan(lit[channel] * 0.85);
      // Cooler too: the removed term is the warm key.
      expect(shaded[channel]).toBeGreaterThan(0);
    }
    const lift = lit.map((value, index) => value - shaded[index]);
    expect(lift[0]).toBeGreaterThan(lift[2]);
  });

  it('blends between the top and the face over the committed band', () => {
    const mid = (TILE_SHADE.topLitFrom + TILE_SHADE.topLitFull) / 2;
    // A smoothstep's midpoint is half the shade.
    expect(shadeAt(mid, TILE_SHADE.humanHand)).toBeCloseTo(TILE_SHADE.humanHand / 2, 6);
    // Above the band nothing, below it everything.
    expect(shadeAt(TILE_SHADE.topLitFull, 1)).toBe(0);
    expect(shadeAt(TILE_SHADE.topLitFrom, 1)).toBeCloseTo(1, 12);
    expect(shadeAt(0, 1)).toBeCloseTo(1, 12);
    expect(shadeAt(-1, 1)).toBeCloseTo(1, 12);
    // No zone shade, no effect.
    expect(shadeAt(0, 0)).toBe(0);
  });

  it('is equal for the three opponents and milder for the player', () => {
    expect(TILE_SHADE.opponentHand).toBeGreaterThan(TILE_SHADE.humanHand);
    // The player's hand has to stay readable: it keeps most of its brightness.
    expect(TILE_SHADE.humanHand).toBeGreaterThan(0.25);
    expect(TILE_SHADE.humanHand).toBeLessThan(0.6);
    expect(TILE_SHADE.opponentHand).toBeGreaterThan(0.6);
    expect(TILE_SHADE.opponentHand).toBeLessThan(0.85);
  });

  it('scales the key specular with the shade, so no highlight survives', () => {
    const view = [0, 0.766, 0.643] as const;
    const lit = predictLitColour({
      albedo: hexToLinear(BODY.ivoryHex) as LinearRgb,
      normal: HAND_NORMAL,
      viewDir: view,
      roughness: 0.16,
    });
    const shaded = predictLitColour({
      albedo: hexToLinear(BODY.ivoryHex) as LinearRgb,
      normal: HAND_NORMAL,
      viewDir: view,
      roughness: 0.16,
      shade: TILE_SHADE.humanHand,
    });
    expect(shaded[0]).toBeLessThan(lit[0]);
    const litSrgb = linearToSrgbBytes(lit);
    const shadedSrgb = linearToSrgbBytes(shaded);
    // The handoff's target: clearly darker, still readable (>= 70 % sRGB).
    expect(shadedSrgb[0]).toBeGreaterThan(litSrgb[0] * 0.7);
    expect(shadedSrgb[0]).toBeLessThan(litSrgb[0]);
  });
});

describe('wrapped diffuse', () => {
  it('matches N·L at the wrap midpoint and clamps at the extremes', () => {
    expect(wrappedDiffuse([0, 1, 0], [0, 1, 0])).toBeCloseTo(1, 6);
    expect(wrappedDiffuse([0, 1, 0], [0, -1, 0])).toBeCloseTo(0, 6);
    // Light exactly at the horizon: the wrap already lights part of the term
    // (wrap / (1 + wrap) = 0.3 / 1.3).
    expect(wrappedDiffuse([0, 1, 0], [1, 0, 0])).toBeCloseTo(LIGHTING.wrap / (1 + LIGHTING.wrap), 6);
  });

  it('is monotone in N·L', () => {
    const values = [0, 0.25, 0.5, 0.75, 1].map((dot) =>
      wrappedDiffuse([0, 1, 0], [0, dot, Math.sqrt(Math.max(0, 1 - dot * dot))]),
    );
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index]).toBeGreaterThanOrEqual(values[index - 1]);
    }
  });
});

describe('colour conversions', () => {
  it('round-trips sRGB and linear', () => {
    for (const value of [0, 0.02, 0.04045, 0.2, 0.5, 0.9, 1]) {
      expect(linearToSrgb(srgbToLinear(value))).toBeCloseTo(value, 6);
    }
  });

  it('parses hex colours and refuses anything else', () => {
    expect(hexToBytes('#f5f0eb')).toEqual([245, 240, 235]);
    expect(hexToBytes('#fff')).toEqual([255, 255, 255]);
    expect(() => hexToBytes('f5f0eb')).toThrow();
    expect(() => hexToBytes('#f5f0e')).toThrow();
  });

  it('encodes the ivory at 1.0 irradiance back to its own bytes', () => {
    const linear = hexToLinear(BODY.ivoryHex) as LinearRgb;
    expect(linearToSrgbBytes(linear)).toEqual([245, 240, 235]);
  });
});

describe('scene lights', () => {
  it('is exactly the committed key, fill and ambient', () => {
    const specs = sceneLightSpecs();
    expect(specs.map((spec) => spec.kind)).toEqual(['key', 'fill', 'ambient']);
    const key = specs[0];
    expect(key.colorHex).toBe(LIGHT.keyHex);
    expect(key.intensity).toBe(LIGHTING.key.intensity);
    expect(key.direction).toEqual(LIGHT.keyDirection);
    expect(specs[1].groundHex).toBe(LIGHTING.fill.groundHex);
    expect(specs[2].colorHex).toBe(LIGHTING.ambient.hex);
  });

  it('has no environment map, no shadow and no second key', () => {
    expect(sceneLightSpecs()).toHaveLength(3);
  });
});
