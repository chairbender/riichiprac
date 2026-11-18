/**
 * The hero probes, as scripted checks (3D-05).
 *
 * Three kinds of assertion, none of which looks at an image:
 *
 * 1. **Colour science.** CIE Lab and DeltaE76 against known anchors, so a DE report
 *    means what it says.
 * 2. **The probe rules.** A synthetic pixel block proves the median, the redness
 *    presence test, every pass/fail branch and the off-screen path.
 * 3. **The probe points against the committed atlas.** `HERO_PROBE_UV.ink` is
 *    decoded out of `face_albedo.png`: it must sit deep inside the `1m` stroke
 *    (so the 5 x 5 block is ink) and the same point in Haku's cell must carry
 *    no ink at all (the white dragon has no printed mark). That is the numeric
 *    form of the handoff's "does Haku stay clean?".
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage as loadNapiImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { PINNED_RELIEF_ATLASES, RELIEF_RASTER } from './reliefAssets';
import { BODY } from './lighting';
import {
  HERO_SLOTS,
  HERO_PROBE_UV,
  heroVisibleNormal,
  probeLocalPoint,
  slotWorldPoint,
} from './hero';
import { rigPoseForAspect } from './cameraRig';
import {
  HERO_PROBES,
  PROBE_BLOCK,
  PROBE_DELTA_E_TOLERANCE,
  allProbesPass,
  deltaE76,
  predictedProbeSrgb,
  readProbes,
  rgbToHex,
  srgbBytesToLab,
} from './probes';
import type { ProbeDefinition, ProbePixelSource, ProbeProjector } from './probes';

const tableDir = fileURLToPath(new URL('../../../public/table/', import.meta.url));

/** A flat RGBA buffer of one colour, addressable the way `readPixels` is. */
function solidSource(
  rgb: readonly [number, number, number],
  width = 32,
  height = 32,
): ProbePixelSource {
  return {
    width,
    height,
    read(x, y, w, h) {
      const out = new Uint8Array(w * h * 4);
      for (let pixel = 0; pixel < w * h; pixel += 1) {
        const offset = pixel * 4;
        out[offset] = rgb[0];
        out[offset + 1] = rgb[1];
        out[offset + 2] = rgb[2];
        out[offset + 3] = 255;
      }
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      return out;
    },
  };
}

/** A projector that puts every probe at one point, or nowhere. */
function fixedProjector(point: { x: number; y: number } | null): ProbeProjector {
  return { project: () => point };
}

function definition(
  id: string,
  kind: ProbeDefinition['kind'],
  targetHex?: string,
): ProbeDefinition {
  return {
    id,
    label: id,
    kind,
    point: { slot: 'pond', uv: HERO_PROBE_UV.ink },
    targetHex,
  };
}

describe('colour science', () => {
  it('puts white at L* 100 and black at 0', () => {
    const white = srgbBytesToLab([255, 255, 255]);
    expect(white[0]).toBeCloseTo(100, 2);
    expect(Math.abs(white[1])).toBeLessThan(0.02);
    expect(Math.abs(white[2])).toBeLessThan(0.02);
    const black = srgbBytesToLab([0, 0, 0]);
    expect(black[0]).toBeCloseTo(0, 6);
  });

  it('measures 100 ΔE between white and black and 0 for a colour against itself', () => {
    expect(deltaE76(srgbBytesToLab([255, 255, 255]), srgbBytesToLab([0, 0, 0]))).toBeCloseTo(
      100,
      1,
    );
    expect(
      deltaE76(srgbBytesToLab([245, 240, 235]), srgbBytesToLab([245, 240, 235])),
    ).toBe(0);
  });

  it('formats hex', () => {
    expect(rgbToHex([245, 240, 235])).toBe('#f5f0eb');
    expect(rgbToHex([0, 8, 255])).toBe('#0008ff');
  });
});

describe('probe rules', () => {
  it('passes the committed ivory and blue against their own targets', () => {
    const ivory = readProbes(
      solidSource([245, 240, 235]),
      fixedProjector({ x: 16, y: 16 }),
      [definition('ivory', 'ivory', BODY.ivoryHex)],
    )[0];
    expect(ivory.hex).toBe('#f5f0eb');
    expect(ivory.deltaE ?? 99).toBeLessThan(PROBE_DELTA_E_TOLERANCE);
    expect(ivory.pass).toBe(true);

    const blue = readProbes(
      solidSource([19, 41, 134]),
      fixedProjector({ x: 16, y: 16 }),
      [definition('blue', 'blue', BODY.blueHex)],
    )[0];
    expect(blue.pass).toBe(true);
    expect(blue.deltaE ?? 99).toBeLessThan(PROBE_DELTA_E_TOLERANCE);
  });

  it('fails a colour probe that is off target and says by how much', () => {
    // White is only ~4 ΔE from the ivory, so the off-target case uses ink.
    const reading = readProbes(
      solidSource([166, 12, 12]),
      fixedProjector({ x: 16, y: 16 }),
      [definition('ivory', 'ivory', BODY.ivoryHex)],
    )[0];
    expect(reading.pass).toBe(false);
    expect(reading.detail).toMatch(/ΔE .* > 6/);
  });

  it('detects paint by its contrast with the ivory, and reports redness as information', () => {
    // 1p's artwork is navy as well as crimson: the rule is ΔE from the ivory,
    // not redness, so a navy band passes and its redness stays a number in the
    // report.
    const navy = readProbes(
      solidSource([0, 0, 55]),
      fixedProjector({ x: 16, y: 16 }),
      [definition('paint', 'paint')],
    )[0];
    expect(navy.pass).toBe(true);
    expect(navy.redness).toBe(0);
    expect(navy.rgb).toEqual([0, 0, 55]);

    const crimson = readProbes(
      solidSource([166, 12, 12]),
      fixedProjector({ x: 16, y: 16 }),
      [definition('paint', 'paint')],
    )[0];
    expect(crimson.pass).toBe(true);
    expect(crimson.redness).toBe(166 - 12);
  });

  it('fails a paint probe on a clean face and a clean probe on ink', () => {
    const noInk = readProbes(
      solidSource([245, 240, 235]),
      fixedProjector({ x: 16, y: 16 }),
      [definition('paint', 'paint')],
    )[0];
    expect(noInk.pass).toBe(false);
    expect(noInk.detail).toMatch(/no paint at the probe/);

    const ink = readProbes(
      solidSource([166, 12, 12]),
      fixedProjector({ x: 16, y: 16 }),
      [definition('clean', 'clean')],
    )[0];
    expect(ink.pass).toBe(false);
    expect(ink.detail).toMatch(/paint where a clean face is expected/);
  });

  it('accepts an ivory body and rejects the blue back there', () => {
    const ivory = readProbes(
      solidSource([245, 240, 235]),
      fixedProjector({ x: 16, y: 16 }),
      [definition('body', 'body')],
    )[0];
    expect(ivory.pass).toBe(true);

    const blue = readProbes(
      solidSource([19, 41, 134]),
      fixedProjector({ x: 16, y: 16 }),
      [definition('body', 'body')],
    )[0];
    expect(blue.pass).toBe(false);
    expect(blue.detail).toMatch(/expected ivory body/);
  });

  it('reports an off-screen probe instead of throwing', () => {
    const reading = readProbes(solidSource([245, 240, 235]), fixedProjector(null), [
      definition('ivory', 'ivory', BODY.ivoryHex),
    ])[0];
    expect(reading.pass).toBe(false);
    expect(reading.detail).toMatch(/does not project/);
  });

  it('reports a block that leaves the drawing buffer', () => {
    const reading = readProbes(solidSource([245, 240, 235], 4, 4), fixedProjector({ x: 2, y: 2 }), [
      definition('ivory', 'ivory', BODY.ivoryHex),
    ])[0];
    expect(reading.pass).toBe(false);
    expect(reading.detail).toMatch(/outside the drawing buffer/);
  });

  it('aggregates pass across every reading', () => {
    expect(
      allProbesPass(
        readProbes(solidSource([245, 240, 235]), fixedProjector({ x: 16, y: 16 }), HERO_PROBES),
      ),
    ).toBe(false);
    // The two colour probes are the only ones a solid ivory block can satisfy.
    const onlyColour = HERO_PROBES.filter((probe) => probe.kind === 'ivory');
    expect(
      allProbesPass(
        readProbes(solidSource([245, 240, 235]), fixedProjector({ x: 16, y: 16 }), onlyColour),
      ),
    ).toBe(true);
  });
});

describe('probe targets are reachable at the hero slots', () => {
  const frame = rigPoseForAspect(16 / 9);

  function viewDir(id: 'hand' | 'pond' | 'wall' | 'back'): [number, number, number] {
    const slot = HERO_SLOTS.find((entry) => entry.id === id);
    if (!slot) throw new Error(`missing hero slot ${id}`);
    const uv = id === 'back' ? HERO_PROBE_UV.centre : HERO_PROBE_UV.ink;
    const point = slotWorldPoint(slot, probeLocalPoint(slot, uv));
    const toEye = [
      frame.eyeUnits[0] - point[0],
      frame.eyeUnits[1] - point[1],
      frame.eyeUnits[2] - point[2],
    ];
    const length = Math.hypot(toEye[0], toEye[1], toEye[2]);
    return [toEye[0] / length, toEye[1] / length, toEye[2] / length];
  }

  it('predicts the ivory at the pond (Haku) and the hand within ΔE 6', () => {
    for (const id of ['pond', 'hand'] as const) {
      const slot = HERO_SLOTS.find((entry) => entry.id === id);
      if (!slot) throw new Error(`missing hero slot ${id}`);
      const predicted = predictedProbeSrgb({
        hex: BODY.ivoryHex,
        normal: heroVisibleNormal(slot),
        viewDir: viewDir(id),
        roughness: 0.45,
      });
      const delta = deltaE76(
        srgbBytesToLab(predicted),
        srgbBytesToLab([245, 240, 235]),
      );
      expect(delta, `${id} ivory`).toBeLessThan(PROBE_DELTA_E_TOLERANCE);
    }
  });

  it('predicts the blue at the face-down wall tile within ΔE 6', () => {
    const slot = HERO_SLOTS.find((entry) => entry.id === 'back');
    if (!slot) throw new Error('missing the blue back slot');
    const predicted = predictedProbeSrgb({
      hex: BODY.blueHex,
      normal: heroVisibleNormal(slot),
      viewDir: viewDir('back'),
      roughness: BODY.blueRoughness,
    });
    const delta = deltaE76(
      srgbBytesToLab(predicted),
      srgbBytesToLab([19, 41, 134]),
    );
    expect(delta).toBeLessThan(PROBE_DELTA_E_TOLERANCE);
  });
});

describe('probe points against the committed atlas', () => {
  it('puts the ink probe inside the 1p disk and finds Haku ink-free there', async () => {
    const file = join(tableDir, PINNED_RELIEF_ATLASES.face_albedo.file);
    const image = await loadNapiImage(readFileSync(file));
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);

    const cellX = Math.floor(HERO_PROBE_UV.ink.u * RELIEF_RASTER.cellWidth);
    const cellY = Math.floor(HERO_PROBE_UV.ink.v * RELIEF_RASTER.cellHeight);

    // The hero hand is 1p: atlas cell 13 (column 3, row 1). Haku (5z) is cell
    // 34 (column 4, row 5).
    const pin = context.getImageData(
      3 * RELIEF_RASTER.cellWidth,
      1 * RELIEF_RASTER.cellHeight,
      RELIEF_RASTER.cellWidth,
      RELIEF_RASTER.cellHeight,
    );
    const pinOffset = (cellY * RELIEF_RASTER.cellWidth + cellX) * 4;
    expect(pin.data[pinOffset + 3]).toBeGreaterThanOrEqual(200);

    // Every texel within 8 of the point is ink too, so a 5 x 5 read-back cannot
    // land on a stroke's edge.
    const clearance = 8;
    for (let dy = -clearance; dy <= clearance; dy += 1) {
      for (let dx = -clearance; dx <= clearance; dx += 1) {
        const x = cellX + dx;
        const y = cellY + dy;
        const offset = (y * RELIEF_RASTER.cellWidth + x) * 4;
        expect(pin.data[offset + 3], `ink at ${x},${y}`).toBeGreaterThanOrEqual(200);
      }
    }

    const hakuCell = context.getImageData(
      4 * RELIEF_RASTER.cellWidth,
      5 * RELIEF_RASTER.cellHeight,
      RELIEF_RASTER.cellWidth,
      RELIEF_RASTER.cellHeight,
    );
    const hakuOffset = (cellY * RELIEF_RASTER.cellWidth + cellX) * 4;
    expect(hakuCell.data[hakuOffset + 3]).toBeLessThanOrEqual(5);
    let painted = 0;
    for (let index = 3; index < hakuCell.data.length; index += 4) {
      if (hakuCell.data[index] > 10) painted += 1;
    }
    expect(painted).toBe(0);

    expect(PROBE_BLOCK).toBe(5);
  });
});
