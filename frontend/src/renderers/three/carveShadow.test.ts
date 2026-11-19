// @vitest-environment node
/**
 * The self-shadow's magnitude on the committed carve (3D-10).
 *
 * A GPU-free model of `tile.frag.ts`'s march, run over the **committed height
 * channel** of the real `relief3d` face at the three face-up hero attitudes. It
 * answers the handoff's numeric half — "is the shadow too strong on the small
 * glyphs?" — with numbers instead of an opinion:
 *
 * - the open face's mean visibility (must be exactly 1: no self-shadow acne);
 * - the groove floor's mean visibility, i.e. how much of the key the term
 *   removes at the strongest calibration;
 * - the same split into "occluded" vs "untouched" fractions.
 *
 * The model mirrors the shader's arithmetic exactly: the same depth, the same
 * plate/cell conversion, the same 6-texel reach clamp, the same
 * `(surfaceDepth - t) - sampleDepth - bias` test and the same softness ramp.
 * Nothing here is a judgement about how the render looks; AGENTS.md §6 leaves
 * that to the user at `?debug=shadow`.
 */

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { poseAxes } from './boardLayout';
import { HERO_SLOTS } from './hero';
import { CARVE_DEPTH_UNITS, SHADOW_CALIBRATION } from './tileMaterial';
import { LIGHT } from '../layoutConstants';

interface Cell {
  readonly width: number;
  readonly height: number;
  /** Alpha channel of `face_normal_depth` in the cell, normalized 0..1. */
  readonly heights: Float32Array;
}

const requestedFace = '1p';
let cell: Cell;

beforeAll(async () => {
  const publicDir = fileURLToPath(new URL('../../../public/table/', import.meta.url));
  const manifest = JSON.parse(
    readFileSync(`${publicDir}relief3d.json`, 'utf8'),
  ) as {
    raster: { cellWidth: number; cellHeight: number; atlasWidth: number; atlasHeight: number };
    faces: Record<string, { cell: { rect: [number, number, number, number] } }>;
  };
  const entry = manifest.faces[requestedFace];
  if (!entry) throw new Error(`relief3d.json has no face ${requestedFace}`);

  const image = await loadImage(readFileSync(`${publicDir}relief3d/face_normal_depth.png`));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, image.width, image.height).data;

  const [u0, v0, u1, v1] = entry.cell.rect;
  const x0 = Math.round(u0 * manifest.raster.atlasWidth);
  const y0 = Math.round(v0 * manifest.raster.atlasHeight);
  const width = Math.round((u1 - u0) * manifest.raster.atlasWidth);
  const height = Math.round((v1 - v0) * manifest.raster.atlasHeight);
  expect(width).toBe(manifest.raster.cellWidth);
  expect(height).toBe(manifest.raster.cellHeight);

  const heights = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      heights[y * width + x] = data[((y0 + y) * image.width + (x0 + x)) * 4 + 3] / 255;
    }
  }
  cell = { width, height, heights };
});

/** Bilinear height sample in cell pixels. */
function sampleHeight(x: number, y: number): number {
  const clampX = Math.min(cell.width - 1, Math.max(0, x));
  const clampY = Math.min(cell.height - 1, Math.max(0, y));
  const x0 = Math.floor(clampX);
  const y0 = Math.floor(clampY);
  const x1 = Math.min(cell.width - 1, x0 + 1);
  const y1 = Math.min(cell.height - 1, y0 + 1);
  const fx = clampX - x0;
  const fy = clampY - y0;
  const a = cell.heights[y0 * cell.width + x0];
  const b = cell.heights[y0 * cell.width + x1];
  const c = cell.heights[y1 * cell.width + x0];
  const d = cell.heights[y1 * cell.width + x1];
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/** The shader's visibility at one pixel, in cell coordinates. */
function visibilityAt(
  x: number,
  y: number,
  rayX: number,
  rayY: number,
  steps: number,
): number {
  const surfaceHeight = sampleHeight(x, y);
  const surfaceDepth = 1 - surfaceHeight;
  let occlusion = 0;
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const sampleDepth = 1 - sampleHeight(x + rayX * t, y + rayY * t);
    const gap = surfaceDepth - t - sampleDepth - SHADOW_CALIBRATION.bias;
    occlusion = Math.max(
      occlusion,
      Math.min(1, Math.max(0, gap / SHADOW_CALIBRATION.softness)),
    );
  }
  return 1 - SHADOW_CALIBRATION.strength * occlusion;
}

interface Reading {
  readonly slot: string;
  readonly keyAngleDeg: number;
  readonly reachPx: number;
  readonly openMeanVisibility: number;
  readonly floorMeanVisibility: number;
  readonly carvedOccludedFraction: number;
  readonly meanKeyLoss: number;
}

function measureSlot(slot: (typeof HERO_SLOTS)[number]): Reading {
  const [, , normal] = poseAxes(slot.pose);
  const [t, b, n] = poseAxes(slot.pose);
  const light = LIGHT.keyDirection;
  const dot = (a: readonly number[], v: readonly number[]): number =>
    a[0] * v[0] + a[1] * v[1] + a[2] * v[2];
  const lightTangent = [dot(light, t), dot(light, b), dot(light, n)];
  const keyAngleDeg = (Math.acos(Math.min(1, Math.max(-1, dot(light, normal)))) * 180) / Math.PI;
  expect(lightTangent[2]).toBeGreaterThan(0.05);

  let rayX =
    (CARVE_DEPTH_UNITS * lightTangent[0]) / lightTangent[2] / 0.64 * cell.width;
  let rayY =
    (CARVE_DEPTH_UNITS * lightTangent[1]) / lightTangent[2] / 0.89 * cell.height;
  const reachPx = Math.hypot(rayX, rayY);
  if (reachPx > SHADOW_CALIBRATION.maxTexels) {
    rayX *= SHADOW_CALIBRATION.maxTexels / reachPx;
    rayY *= SHADOW_CALIBRATION.maxTexels / reachPx;
  }

  // Stay a reach inside the cell so the model never samples a neighbour's cell.
  const margin = Math.ceil(SHADOW_CALIBRATION.maxTexels) + 1;
  const steps = 4;
  let openSum = 0;
  let openCount = 0;
  let floorSum = 0;
  let floorCount = 0;
  let carvedCount = 0;
  let carvedOccluded = 0;
  let allSum = 0;
  let allCount = 0;
  for (let y = margin; y < cell.height - margin; y += 1) {
    for (let x = margin; x < cell.width - margin; x += 1) {
      const h = cell.heights[y * cell.width + x];
      const visibility = visibilityAt(x, y, rayX, rayY, steps);
      allSum += visibility;
      allCount += 1;
      if (h >= 0.995) {
        openSum += visibility;
        openCount += 1;
      }
      if (h <= 0.5) {
        floorSum += visibility;
        floorCount += 1;
      }
      if (h < 0.995) {
        carvedCount += 1;
        if (visibility < 0.995) carvedOccluded += 1;
      }
    }
  }
  const floorMean = floorCount > 0 ? floorSum / floorCount : 1;
  return {
    slot: slot.id,
    keyAngleDeg,
    reachPx: Math.min(reachPx, SHADOW_CALIBRATION.maxTexels),
    openMeanVisibility: openCount > 0 ? openSum / openCount : 1,
    floorMeanVisibility: floorMean,
    carvedOccludedFraction: carvedCount > 0 ? carvedOccluded / carvedCount : 0,
    meanKeyLoss: 1 - allSum / allCount,
  };
}

describe('the self-shadow on the committed `1p` carve', () => {
  it('never shadows the open face, and darkens the groove floor by a bounded amount', () => {
    const readings = HERO_SLOTS.filter((slot) => slot.faceUp).map(measureSlot);
    const lines = readings.map(
      (reading) =>
        `${reading.slot}: key ${reading.keyAngleDeg.toFixed(2)}°, reach ` +
        `${reading.reachPx.toFixed(2)} px · open face visibility ` +
        `${reading.openMeanVisibility.toFixed(4)} · floor visibility ` +
        `${reading.floorMeanVisibility.toFixed(3)} · carved pixels touched ` +
        `${(reading.carvedOccludedFraction * 100).toFixed(1)}% · key lost ` +
        `${(reading.meanKeyLoss * 100).toFixed(2)}%`,
    );
    console.log(
      [
        '3D-10 self-shadow calibration (strength ' +
          `${SHADOW_CALIBRATION.strength}, bias ${SHADOW_CALIBRATION.bias}, softness ` +
          `${SHADOW_CALIBRATION.softness}, reach clamp ${SHADOW_CALIBRATION.maxTexels} px)`,
        ...lines,
      ].join('\n'),
    );

    for (const reading of readings) {
      // The open face can never shadow itself: its ray starts at depth 0 and
      // the bias is larger than the map's quantization.
      expect(reading.openMeanVisibility, `${reading.slot} open face`).toBeCloseTo(1, 6);
      // The groove floor is darkened, but not blacked out, and not untouched.
      expect(reading.floorMeanVisibility, `${reading.slot} floor`).toBeGreaterThan(0.55);
      expect(reading.floorMeanVisibility, `${reading.slot} floor`).toBeLessThan(0.995);
      // The term is a groove effect: most of the cell's area is open face.
      expect(reading.meanKeyLoss, `${reading.slot} whole cell`).toBeLessThan(0.2);
    }

    // The lying pond sees the key further off its normal than the reclined
    // hand, so its march is at least as long and its floor no brighter.
    const hand = readings.find((reading) => reading.slot === 'hand');
    const pond = readings.find((reading) => reading.slot === 'pond');
    expect(hand).toBeDefined();
    expect(pond).toBeDefined();
    expect(pond?.keyAngleDeg ?? 0).toBeGreaterThan(hand?.keyAngleDeg ?? 0);
    expect(pond?.reachPx ?? 0).toBeGreaterThan(hand?.reachPx ?? 0);
    expect(pond?.floorMeanVisibility ?? 1).toBeLessThanOrEqual(hand?.floorMeanVisibility ?? 0);
  });
});
