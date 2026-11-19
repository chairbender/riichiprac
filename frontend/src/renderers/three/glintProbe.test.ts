/**
 * The glint probe (3D-20 follow-up).
 *
 * The point of this probe is that it does not infer which surface a bright pixel
 * belongs to: the second frame *is* the shader's own branch state. These tests
 * pin that contract with synthetic frames, including the misattribution that a
 * geometry-only instrument makes (a face-up plate in front of a wall) and the
 * measured before/after counts from the real render.
 */

import { describe, expect, it } from 'vitest';

import {
  GLINT_BODY_MAX_FRACTION,
  GLINT_THRESHOLD,
  classifyGlintFrame,
} from './glintProbe';
import type { GlintFrame } from './glintProbe';

/** A frame of `width x height` painted by a per-pixel callback. */
function frame(
  width: number,
  height: number,
  at: (x: number, y: number) => readonly [number, number, number],
): GlintFrame {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = at(x, y);
      const index = (y * width + x) * 4;
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      data[index + 3] = 255;
    }
  }
  return { data, width, height };
}

/** The flags frame's encoding: R face-up, G blue body, B plate zone. */
const FLAGS = {
  plate: [255, 0, 255] as const,
  blueBody: [0, 255, 0] as const,
  ivoryBand: [0, 0, 0] as const,
};

/** Lit values: a dark blue backing, a saturated glint, an ivory surface. */
const LIT = {
  blue: [19, 41, 134] as const,
  glint: [250, 250, 250] as const,
  ivory: [245, 240, 235] as const,
};

describe('3D glint probe (3D-20 follow-up)', () => {
  it('attributes a bright pixel to the surface the shader says drew it', () => {
    // Left half: a blue wall bevel with a white rim. Right half: a face-up plate
    // that is bright because it is ivory. A geometry-only probe mistakes the
    // second for the first; the flags frame cannot.
    const flags = frame(8, 2, (x) => (x < 4 ? FLAGS.blueBody : FLAGS.plate));
    const lit = frame(8, 2, (x) => {
      if (x === 3) return LIT.glint;
      return x < 4 ? LIT.blue : LIT.ivory;
    });
    const report = classifyGlintFrame(lit, flags);
    expect(report.blueBody.coverage).toBe(8);
    expect(report.blueBody.bright).toBe(2); // the two glint pixels on the bevel
    expect(report.plate.coverage).toBe(8);
    expect(report.plate.bright).toBe(8); // ivory plates are bright, and that is fine
    expect(report.ivoryBody.coverage).toBe(0);
    // 2/8 is 25 %: far above the bound, so this frame fails.
    expect(report.pass).toBe(false);
  });

  it('passes when the body is dark and only plates are bright', () => {
    const flags = frame(4, 4, (x) => (x < 2 ? FLAGS.blueBody : FLAGS.plate));
    const lit = frame(4, 4, (x) => (x < 2 ? LIT.blue : LIT.ivory));
    const report = classifyGlintFrame(lit, flags);
    expect(report.blueBody.bright).toBe(0);
    expect(report.plate.bright).toBe(8);
    expect(report.pass).toBe(true);
  });

  it('reports the ivory band separately from the blue body', () => {
    const flags = frame(2, 1, (x) => (x === 0 ? FLAGS.blueBody : FLAGS.ivoryBand));
    const lit = frame(2, 1, () => LIT.ivory);
    const report = classifyGlintFrame(lit, flags);
    expect(report.blueBody).toEqual({ coverage: 1, bright: 1 });
    expect(report.ivoryBody).toEqual({ coverage: 1, bright: 1 });
    expect(report.plate).toEqual({ coverage: 0, bright: 0 });
  });

  it('honours the threshold it was given', () => {
    const flags = frame(1, 1, () => FLAGS.blueBody);
    const dim = frame(1, 1, () => [90, 90, 90]);
    expect(classifyGlintFrame(dim, flags, 100).blueBody.bright).toBe(0);
    expect(classifyGlintFrame(dim, flags, 80).blueBody.bright).toBe(1);
  });

  it('refuses frames that disagree about their size', () => {
    const flags = frame(4, 4, () => FLAGS.blueBody);
    const lit = frame(2, 8, () => LIT.blue);
    expect(() => classifyGlintFrame(lit, flags)).toThrow(/differ in size/);
    const short = { data: new Uint8Array(4), width: 2, height: 8 };
    expect(() => classifyGlintFrame(lit, short)).toThrow(/wrong byte length/);
  });

  it('carries the measured rule and its before/after margins', () => {
    expect(GLINT_THRESHOLD).toBe(200);
    expect(GLINT_BODY_MAX_FRACTION).toBe(0.001);
    // The measured defect: 276/141862 = 0.195 % on the blue body before the fix,
    // 24/141862 = 0.017 % after. The rule sits between them.
    expect(276 / 141862).toBeGreaterThan(GLINT_BODY_MAX_FRACTION);
    expect(24 / 141862).toBeLessThan(GLINT_BODY_MAX_FRACTION);
  });
});
