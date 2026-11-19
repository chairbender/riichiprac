/**
 * The procedural felt (3D-02): deterministic bytes, the committed cloth colour,
 * and the square that has to reach the top and bottom of the frame.
 *
 * The texture is generated in code, so these assertions are exact; whether the
 * felt *reads* as felt is the user handoff, not an agent verdict.
 */

import { describe, expect, it } from 'vitest';
import { CAMERA, TABLE } from '../layoutConstants';
import { frameForAspect } from './boardLayout';
import { groundHit } from './cameraRig';
import { FELT, feltSizeForFrame, generateFeltPixels } from './felt';

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

  it('reaches the top and bottom edges at every aspect, as one square', () => {
    // The plan's aspects plus the phone portraits a browser actually reports.
    const aspects = [...CAMERA.supportedAspects, 9 / 19.5, 9 / 21];

    for (const aspect of aspects) {
      const frame = frameForAspect(aspect);
      const size = feltSizeForFrame(frame);
      const half = size / 2;
      expect(size, `size at ${aspect}`).toBeGreaterThan(TABLE.matSizeUnits);

      // The square is centred on the table and square by construction: the
      // near and far edges must both be at or beyond the frame's top and bottom
      // lines, at the centre line where the felt cannot rely on its width.
      const top = groundHit(frame, 0, 1);
      const bottom = groundHit(frame, 0, -1);
      expect(top, `top at ${aspect}`).not.toBeNull();
      expect(bottom, `bottom at ${aspect}`).not.toBeNull();
      if (!top || !bottom) continue;
      expect(Math.abs(top[1]), `far edge at ${aspect}`).toBeLessThanOrEqual(half);
      expect(Math.abs(bottom[1]), `near edge at ${aspect}`).toBeLessThanOrEqual(half);
      expect(top[0], 'centre line').toBeCloseTo(0, 6);
      expect(bottom[0], 'centre line').toBeCloseTo(0, 6);
    }
  });

  it('is narrower than a wide frame, so its side edges stay visible', () => {
    // A wide window is the case the user described: a square spanning the
    // height cannot also span the width, so the felt's left/right edges are
    // inside the frame. (On a tall window the same square is wider than the
    // frame, which is geometry, not a bug.)
    for (const aspect of [21 / 9, 16 / 9]) {
      const frame = frameForAspect(aspect);
      const half = feltSizeForFrame(frame) / 2;
      for (const ndcY of [-1, 1]) {
        const left = groundHit(frame, -1, ndcY);
        expect(left, `left at ${aspect}`).not.toBeNull();
        if (!left) continue;
        expect(Math.abs(left[0]), `left edge at ${aspect}`).toBeGreaterThan(half);
      }
    }
  });
});
