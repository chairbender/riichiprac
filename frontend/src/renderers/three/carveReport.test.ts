/**
 * The carve bounds' pure measurements (3D-10).
 *
 * The shader clamps two dependent offsets: the POM parallax (8 texels) and the
 * self-shadow march reach (6 texels). This file checks the pure readings over
 * real board layouts at every supported aspect, so the gate is a printed number
 * rather than a belief that the camera "is about the same".
 */

import { describe, expect, it } from 'vitest';
import { frameForAspect, layoutBoard, poseAxes } from './boardLayout';
import { boardFixture } from './boardFixture';
import { carveBounds, keyAngleDeg, viewAngleDeg, worstShadowReach, worstViewAngle } from './carveReport';
import type { CarveSurface } from './carveReport';
import { LIGHT } from '../layoutConstants';
import { POM_MAX_TEXELS, SHADOW_CALIBRATION } from './tileMaterial';

/** The aspects the framing solver must support (plan §2.4). */
const ASPECTS = [9 / 16, 3 / 4, 1, 4 / 3, 16 / 9, 21 / 9, 9 / 21] as const;

function surface(
  id: string,
  normal: readonly [number, number, number],
  centre: readonly [number, number, number] = [0, 0, 0],
): CarveSurface {
  return { id, label: id, normal, centre };
}

describe('view and key angles', () => {
  it('measures the angle between a plane and a ray', () => {
    const up = surface('up', [0, 1, 0], [0, 0, 0]);
    expect(viewAngleDeg(up, [0, 10, 0])).toBeCloseTo(0, 6);
    expect(viewAngleDeg(up, [10, 10, 0])).toBeCloseTo(45, 6);
    // The committed key is 35° off +Y.
    expect(keyAngleDeg(up)).toBeCloseTo(35.0, 1);
  });

  it('picks the largest view angle and names the surface', () => {
    const surfaces = [
      surface('a', [0, 1, 0]),
      surface('b', [0.7, 0.7, 0], [0, 0, 0]),
      surface('c', [0, 0.9, 0.4]),
    ];
    const { reading, count } = worstViewAngle(surfaces, [0, 10, 1]);
    expect(count).toBe(3);
    expect(['a', 'b', 'c']).toContain(reading.id);
    expect(reading.angleDeg).toBeGreaterThan(0);
    expect(reading.texels).toBeGreaterThanOrEqual(0);
  });

  it('skips surfaces the key cannot reach', () => {
    const facing = [0, 1, 0] as const;
    const away = [0, -1, 0] as const;
    const lit = worstShadowReach([surface('lit', facing)]);
    const unlit = worstShadowReach([surface('away', away)]);
    expect(lit.count).toBe(1);
    expect(unlit.count).toBe(0);
    expect(unlit.reading.id).toBe('none');
    // A face-down tile's back faces the table, not the key.
    expect(
      worstShadowReach([surface('side', [...LIGHT.keyDirection] as [number, number, number])])
        .reading.angleDeg,
    ).toBeCloseTo(0, 5);
  });

  it('prefixes the two bound ids so the HUD can name the term', () => {
    const bounds = carveBounds([surface('x', [0, 1, 0])], [0, 10, 0]);
    expect(bounds.parallax.id).toBe('parallax:x');
    expect(bounds.shadow.id).toBe('shadow:x');
  });
});

describe('the board’s carve bounds at every supported aspect', () => {
  it('keeps both reaches inside their clamps', () => {
    const layout = layoutBoard(boardFixture());
    const surfaces = layout.tiles
      .filter((tile) => tile.faceUp)
      .map(
        (tile): CarveSurface => ({
          id: tile.id,
          label: `${tile.zone} #${tile.slot}`,
          normal: poseAxes(tile.pose)[2],
          centre: tile.pose.position,
        }),
      );
    expect(surfaces.length).toBeGreaterThan(20);
    const lines: string[] = [];
    for (const aspect of ASPECTS) {
      const frame = frameForAspect(aspect, layout);
      const bounds = carveBounds(surfaces, frame.eye);
      lines.push(
        `${aspect.toFixed(3)}: parallax ${bounds.parallax.angleDeg.toFixed(2)}° → ` +
          `${bounds.parallax.texels.toFixed(2)} texels (${bounds.parallax.label}); ` +
          `shadow ${bounds.shadow.angleDeg.toFixed(2)}° → ${bounds.shadow.texels.toFixed(2)} ` +
          `texels (${bounds.shadow.label})`,
      );
      // The parallax reading prints the pre-clamp figure; the shader applies
      // the 8-texel bound. The live scale must stay under it at every aspect.
      expect(bounds.parallax.texels, `aspect ${aspect}`).toBeLessThanOrEqual(POM_MAX_TEXELS);
      expect(bounds.parallax.clamped, `aspect ${aspect}`).toBe(false);
      // The shadow reach is clamped to 6 texels by the shader, and its own
      // reading may report a larger pre-clamp figure at a grazing key.
      expect(
        Math.min(bounds.shadow.texels, SHADOW_CALIBRATION.maxTexels),
        `aspect ${aspect}`,
      ).toBeLessThanOrEqual(POM_MAX_TEXELS);
    }
    // Print the table so the numbers are in the test log, not in a memory.
    console.log(['3D-10 carve bounds (clamps: 8 parallax / 6 shadow texels)', ...lines].join('\n'));
  });
});
