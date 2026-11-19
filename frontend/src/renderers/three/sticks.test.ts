/**
 * The riichi sticks (3D-07 acceptance): one instanced draw, the layout's own
 * positions, and the point stick's red dot as procedural pixels.
 *
 * A stick is furniture rather than a tile, so it is the one board object with a
 * texture of its own. Both properties that could go wrong are numbers: the dot
 * is red in the middle and ivory at the ends, and every instance sits exactly
 * where 3D-06 placed it at the committed stick size.
 */

import { describe, expect, it } from 'vitest';
import { COMPASS_PLATE, STICK as STICK_CONSTANTS } from '../layoutConstants';
import { boardFixture } from './boardFixture';
import { layoutBoard, seatBasis } from './boardLayout';
import { STICK, createStickMesh, stickTexturePixels } from './sticks';

describe('the stick texture', () => {
  it('draws an ivory bar with one red dot in the middle', () => {
    const width = STICK.textureWidth;
    const height = STICK.textureHeight;
    const pixels = stickTexturePixels();
    expect(pixels).toHaveLength(width * height * 4);

    const rgbAt = (x: number, y: number): [number, number, number] => {
      const index = (y * width + x) * 4;
      return [pixels[index], pixels[index + 1], pixels[index + 2]];
    };
    const [centreR, centreG, centreB] = rgbAt(width / 2, height / 2);
    expect(centreR).toBeGreaterThan(150);
    expect(centreG).toBeLessThan(90);
    expect(centreB).toBeLessThan(90);

    for (const x of [0, 1, width - 1]) {
      const [r, g, b] = rgbAt(x, height / 2);
      expect(r, `x ${x}`).toBeGreaterThan(200);
      expect(g, `x ${x}`).toBeGreaterThan(200);
      expect(b, `x ${x}`).toBeGreaterThan(190);
    }
    // The dot is a dot, not a stripe: only a small share of the texture.
    let red = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] > 150 && pixels[index + 1] < 90) red += 1;
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

describe('the stick layer', () => {
  const layout = layoutBoard(boardFixture());

  it('is one instanced draw at the layout positions and sizes', () => {
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
      // Column 0 is the box's +X scaled to the stick's length, turned by the
      // declarer's own yaw so it lies lengthways along that seat's edge.
      expect(Math.hypot(matrix[offset], matrix[offset + 1], matrix[offset + 2])).toBeCloseTo(
        stick.sizeUnits[0],
        6,
      );
      const { right } = seatBasis(stick.seat);
      expect(matrix[offset]).toBeCloseTo(right[0] * stick.sizeUnits[0], 6);
      expect(matrix[offset + 1]).toBeCloseTo(0, 6);
      expect(matrix[offset + 2]).toBeCloseTo(right[2] * stick.sizeUnits[0], 6);
      expect(stick.sizeUnits[0]).toBe(STICK_CONSTANTS.lengthUnits);
      expect(stick.sizeUnits[1]).toBe(STICK_CONSTANTS.heightUnits);
      expect(stick.sizeUnits[2]).toBe(STICK_CONSTANTS.widthUnits);
      // Standing on the compass plate: its bottom is the plate's top face.
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
