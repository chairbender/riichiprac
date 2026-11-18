/**
 * The procedural felt (3D-02): deterministic bytes, the committed cloth colour,
 * and a plane that matches the mat.
 *
 * The texture is generated in code, so these assertions are exact; whether the
 * felt *reads* as felt is the user handoff, not an agent verdict.
 */

import { describe, expect, it } from 'vitest';
import { CAMERA, TABLE } from '../layoutConstants';
import { groundHit, rigPoseForAspect } from './cameraRig';
import { FELT, generateFeltPixels } from './felt';

describe('procedural felt', () => {
  it('generates an RGBA texture of the declared size', () => {
    const pixels = generateFeltPixels();
    expect(FELT.textureSize).toBe(512);
    expect(pixels).toHaveLength(FELT.textureSize * FELT.textureSize * 4);
    for (let alpha = 3; alpha < pixels.length; alpha += 4) {
      if (pixels[alpha] !== 255) {
        throw new Error(`felt pixel ${alpha} is not opaque: ${pixels[alpha]}`);
      }
    }
  });

  it('is deterministic for a seed and varies with another', () => {
    const first = generateFeltPixels(64);
    const second = generateFeltPixels(64);
    expect(second).toEqual(first);

    const different = generateFeltPixels(64, FELT.seed + 1);
    let differences = 0;
    for (let index = 0; index < first.length; index += 1) {
      if (different[index] !== first[index]) differences += 1;
    }
    expect(differences).toBeGreaterThan(first.length / 10);
  });

  it('stays on the committed felt colour and varies by a few levels', () => {
    const size = 128;
    const pixels = generateFeltPixels(size);
    const totals = [0, 0, 0];
    let min = 255;
    let max = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      totals[0] += pixels[index];
      totals[1] += pixels[index + 1];
      totals[2] += pixels[index + 2];
      min = Math.min(min, pixels[index]);
      max = Math.max(max, pixels[index]);
    }
    const count = size * size;
    const mean = totals.map((total) => total / count);
    const [baseR, baseG, baseB] = FELT.baseRgb;

    expect(mean[0]).toBeCloseTo(baseR, 0);
    expect(mean[1]).toBeCloseTo(baseG, 0);
    expect(mean[2]).toBeCloseTo(baseB, 0);
    // Green-dominant cloth, as the committed raster is.
    expect(mean[1]).toBeGreaterThan(mean[2]);
    expect(mean[2]).toBeGreaterThan(mean[0]);
    // Cloth grain, not a flat fill or visible banding.
    expect(max - min).toBeGreaterThan(8);
    expect(max - min).toBeLessThan(40);
  });

  it('covers the whole frame at every supported aspect, as one square', () => {
    expect(FELT.sizeUnits).toBeGreaterThan(TABLE.matSizeUnits);
    const half = FELT.sizeUnits / 2;
    // The plan's aspects plus the phone portraits a browser actually reports.
    const aspects = [...CAMERA.supportedAspects, 9 / 19.5, 9 / 21];

    for (const aspect of aspects) {
      const pose = rigPoseForAspect(aspect);
      for (const ndcX of [-1, 1]) {
        for (const ndcY of [-1, 1]) {
          const hit = groundHit(pose, ndcX, ndcY);
          expect(hit, `ground hit at ${aspect}`).not.toBeNull();
          if (!hit) continue;
          // Every screen corner lands on the felt, with a margin, so no
          // background shows at the top, bottom or sides.
          expect(Math.abs(hit[0]), `x at ${aspect}`).toBeLessThan(half * 0.98);
          expect(Math.abs(hit[1]), `z at ${aspect}`).toBeLessThan(half * 0.98);
        }
      }
    }
  });
});
