/**
 * The riichi sticks (3D-07 acceptance, remodelled in 3D-09): one instanced draw,
 * a rounded capsule modelled from the score sprite, the layout's own positions,
 * and the point stick's printed face as procedural pixels.
 *
 * A stick is furniture rather than a tile, so it is the one board object with a
 * texture of its own. Everything that could go wrong here is a number: the bar
 * is a stadium of the committed size, its ends are round (no square corner), the
 * face has the sprite's grey end bands and red centre dot, and every instance
 * sits where 3D-06 placed it.
 */

import { describe, expect, it } from 'vitest';
import { COMPASS_PLATE, STICK as STICK_CONSTANTS } from '../layoutConstants';
import { boardFixture } from './boardFixture';
import { layoutBoard, seatBasis } from './boardLayout';
import {
  STICK,
  STICK_SIZE,
  createStickGeometry,
  createStickMesh,
  stickTexturePixels,
} from './sticks';

function pixelRgb(
  pixels: Uint8Array,
  width: number,
  x: number,
  y: number,
): [number, number, number] {
  const index = (y * width + x) * 4;
  return [pixels[index], pixels[index + 1], pixels[index + 2]];
}

describe('the stick texture', () => {
  it('prints a red dot, grey end bands and a white bar', () => {
    const width = STICK.textureWidth;
    const height = STICK.textureHeight;
    const pixels = stickTexturePixels();
    expect(pixels).toHaveLength(width * height * 4);

    // The dot: red at the centre.
    const [centreR, centreG, centreB] = pixelRgb(pixels, width, width / 2, height / 2);
    expect(centreR).toBeGreaterThan(180);
    expect(centreG).toBeLessThan(90);
    expect(centreB).toBeLessThan(90);

    // The bands: grey at 8-15 % and 85-92 % of the length, full width.
    for (const fraction of [0.1, 0.9]) {
      const [r, g, b] = pixelRgb(pixels, width, Math.floor(width * fraction), height / 2);
      expect(r, `band ${fraction}`).toBeGreaterThan(150);
      expect(r, `band ${fraction}`).toBeLessThan(200);
      expect(Math.abs(r - g), `band ${fraction}`).toBeLessThan(12);
      expect(Math.abs(g - b), `band ${fraction}`).toBeLessThan(12);
    }

    // The body between the band and the dot is white, and so is the very tip
    // (the sprite insets its bands from the ends).
    for (const fraction of [0.3, 0.02]) {
      const [r, g, b] = pixelRgb(pixels, width, Math.floor(width * fraction), height / 2);
      expect(r, `body ${fraction}`).toBeGreaterThan(225);
      expect(g, `body ${fraction}`).toBeGreaterThan(225);
      expect(b, `body ${fraction}`).toBeGreaterThan(225);
    }

    // The dot is a dot, not a stripe: only a small share of the texture.
    let red = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] > 180 && pixels[index + 1] < 90) red += 1;
    }
    expect(red).toBeGreaterThan(0);
    expect(red / (width * height)).toBeLessThan(0.2);
    // Opaque everywhere: a stick has no transparency.
    for (let alpha = 3; alpha < pixels.length; alpha += 4) {
      expect(pixels[alpha]).toBe(255);
    }
    // Deterministic bytes.
    expect(stickTexturePixels()).toEqual(pixels);
  });
});

describe('the stick geometry', () => {
  it('is a rounded capsule of the committed size, centred on its origin', () => {
    const geometry = createStickGeometry();
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (!box) throw new Error('the stick has no bounding box');

    // The finished bar is exactly the layout's length x height x width.
    // The quadratic end caps approximate a semicircle to within 0.04 um.
    expect(box.max.x - box.min.x).toBeCloseTo(STICK_CONSTANTS.lengthUnits, 4);
    expect(box.max.y - box.min.y).toBeCloseTo(STICK_CONSTANTS.heightUnits, 4);
    expect(box.max.z - box.min.z).toBeCloseTo(STICK_CONSTANTS.widthUnits, 4);
    expect(box.max.x + box.min.x).toBeCloseTo(0, 6);
    expect(box.max.y + box.min.y).toBeCloseTo(0, 6);
    expect(box.max.z + box.min.z).toBeCloseTo(0, 6);
    expect(box.max.y - box.min.y).toBeCloseTo(STICK_SIZE.heightUnits, 4);

    // Round ends: no vertex sits at the extreme length AND the extreme width
    // (that would be a square corner); the end cap is a semicircle instead.
    const position = geometry.getAttribute('position');
    let squareCorner = false;
    for (let index = 0; index < position.count; index += 1) {
      if (
        Math.abs(position.getX(index)) > STICK_CONSTANTS.lengthUnits / 2 - 1e-6 &&
        Math.abs(position.getZ(index)) > STICK_CONSTANTS.widthUnits / 2 - 1e-6
      ) {
        squareCorner = true;
      }
    }
    expect(squareCorner).toBe(false);

    // The caps carry the printed face; the side wall samples plain ivory.
    const uv = geometry.getAttribute('uv');
    const normal = geometry.getAttribute('normal');
    for (let index = 0; index < uv.count; index += 1) {
      if (Math.abs(normal.getY(index)) > 0.9) {
        expect(uv.getX(index)).toBeGreaterThanOrEqual(0);
        expect(uv.getX(index)).toBeLessThanOrEqual(1);
        expect(uv.getY(index)).toBeGreaterThanOrEqual(0);
        expect(uv.getY(index)).toBeLessThanOrEqual(1);
      } else {
        expect(uv.getX(index)).toBeCloseTo(0.3, 6);
        expect(uv.getY(index)).toBeCloseTo(0.5, 6);
      }
    }
  });
});

describe('the stick layer', () => {
  const layout = layoutBoard(boardFixture());

  it('is one instanced draw at the layout positions', () => {
    const layer = createStickMesh(layout.sticks);
    expect(layer.mesh.isInstancedMesh).toBe(true);
    expect(layer.mesh.name).toBe('riichi-sticks');
    expect(layer.count).toBe(layout.sticks.length);
    expect(layout.sticks.length).toBeGreaterThan(0);

    const matrix = layer.mesh.instanceMatrix.array as Float32Array;
    layout.sticks.forEach((stick, index) => {
      const offset = index * 16;
      expect(matrix[offset + 12]).toBeCloseTo(stick.position[0], 6);
      expect(matrix[offset + 13]).toBeCloseTo(stick.position[1], 6);
      expect(matrix[offset + 14]).toBeCloseTo(stick.position[2], 6);
      // The geometry is already full-size, so the instance is a pure rotation:
      // column 0 is the box's +X (its length) turned by the declarer's yaw.
      const { right } = seatBasis(stick.seat);
      expect(matrix[offset]).toBeCloseTo(right[0], 6);
      expect(matrix[offset + 1]).toBeCloseTo(0, 6);
      expect(matrix[offset + 2]).toBeCloseTo(right[2], 6);
      expect(STICK_CONSTANTS.lengthUnits).toBe(stick.sizeUnits[0]);
      expect(STICK_CONSTANTS.heightUnits).toBe(stick.sizeUnits[1]);
      expect(STICK_CONSTANTS.widthUnits).toBe(stick.sizeUnits[2]);
      // Standing on the compass plate.
      expect(stick.position[1]).toBeCloseTo(
        COMPASS_PLATE.topUnits + STICK_CONSTANTS.heightUnits / 2,
        9,
      );
    });
    layer.dispose();
  });

  it('draws nothing when no seat has declared riichi', () => {
    const empty = layoutBoard(boardFixture({ riichiSeats: [] }));
    const layer = createStickMesh(empty.sticks);
    expect(layer.count).toBe(0);
    expect(layer.mesh.instanceMatrix.count).toBe(STICK.capacity);
    layer.dispose();
  });

  it('re-syncs in place and refuses an over-capacity row', () => {
    const layer = createStickMesh(layout.sticks);
    const buffer = (layer.mesh.instanceMatrix.array as Float32Array).buffer;
    layer.sync(layout.sticks.slice(0, 1));
    expect(layer.count).toBe(1);
    expect((layer.mesh.instanceMatrix.array as Float32Array).buffer).toBe(buffer);

    const small = createStickMesh([], 1);
    const many = layoutBoard(boardFixture({ riichiSeats: [0, 1, 2, 3] })).sticks;
    expect(() => small.sync(many)).toThrow(/exceed the 1-stick capacity/);
    small.dispose();
    layer.dispose();
  });
});
