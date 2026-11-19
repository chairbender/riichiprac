/**
 * The riichi sticks (3D-07, remodelled in 3D-09): one instanced draw, the real
 * 65 x 7 x 3.5 mm polystyrene bar with rounded long edges, and a red pip that
 * is a painted engraving rather than a decal.
 *
 * Everything that can go wrong here is a number: the bar's extents and rounded
 * edges, the pip's albedo/normal/cavity maps, the sprite-matching palette, and
 * every instance's place on the compass plate.
 */

import { MeshPhysicalMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import {
  COMPASS_PLATE,
  STICK as STICK_CONSTANTS,
  STICK_MM,
  UNIT_MM,
} from '../layoutConstants';
import { boardFixture } from './boardFixture';
import { layoutBoard, seatBasis } from './boardLayout';
import { STICK, STICK_SIZE, createStickGeometry, createStickMesh } from './sticks';
import {
  STICK_CARVE,
  stickAlbedoPixels,
  stickNormalPixels,
  stickRoughnessPixels,
} from './stickMaps';

function pixel(
  pixels: Uint8Array,
  width: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const index = (y * width + x) * 4;
  return [
    pixels[index],
    pixels[index + 1],
    pixels[index + 2],
    pixels[index + 3],
  ];
}

/** One texel of the plan-projected face map. */
function facePixel(
  pixels: Uint8Array,
  u: number,
  v: number,
): [number, number, number, number] {
  return pixel(
    pixels,
    STICK_CARVE.textureWidth,
    Math.floor(u * STICK_CARVE.textureWidth),
    Math.floor(v * STICK_CARVE.textureHeight),
  );
}

describe('the stick’s real dimensions', () => {
  it('is the user’s 65 x 7 x 3.5 mm polystyrene bar', () => {
    expect(STICK_MM).toEqual({ length: 65, width: 7, thickness: 3.5 });
    expect(STICK_SIZE.lengthUnits).toBeCloseTo(65 / UNIT_MM, 12);
    expect(STICK_SIZE.widthUnits).toBeCloseTo(7 / UNIT_MM, 12);
    expect(STICK_SIZE.heightUnits).toBeCloseTo(3.5 / UNIT_MM, 12);
    expect(STICK_CONSTANTS.lengthUnits).toBe(STICK_SIZE.lengthUnits);
    expect(STICK_CONSTANTS.widthUnits).toBe(STICK_SIZE.widthUnits);
    expect(STICK_CONSTANTS.heightUnits).toBe(STICK_SIZE.heightUnits);
    // The carve atlas uses the same bar as the layout.
    expect(STICK_CARVE.lengthUnits).toBeCloseTo(STICK_SIZE.lengthUnits, 12);
    expect(STICK_CARVE.widthUnits).toBeCloseTo(STICK_SIZE.widthUnits, 12);
  });
});

describe('the carved pip', () => {
  it('paints one red pip on a white body, with no end bands', () => {
    const pixels = stickAlbedoPixels();
    // The pip: red at the face's centre.
    const [r, g, b, a] = facePixel(pixels, 0.5, 0.5);
    expect(r).toBeGreaterThan(180);
    expect(g).toBeLessThan(90);
    expect(b).toBeLessThan(90);
    expect(a).toBe(255);
    // The body: white both near the ends and mid-bar.
    for (const u of [0.08, 0.25, 0.75, 0.92]) {
      const [bodyR, bodyG, bodyB] = facePixel(pixels, u, 0.5);
      expect(bodyR, `body at ${u}`).toBeGreaterThan(225);
      expect(bodyG, `body at ${u}`).toBeGreaterThan(225);
      expect(bodyB, `body at ${u}`).toBeGreaterThan(225);
      // No grey bands: the three channels stay close to each other and bright.
      expect(Math.abs(bodyR - bodyG), `body at ${u}`).toBeLessThan(8);
    }
    // The border of the map (the bar's curved sides) is plain ivory too.
    const side = facePixel(pixels, 0.2, 0.98);
    expect(side[0]).toBeGreaterThan(225);
    expect(side[1]).toBeGreaterThan(225);
    // Opaque everywhere, deterministic bytes.
    for (let alpha = 3; alpha < pixels.length; alpha += 4) {
      expect(pixels[alpha]).toBe(255);
    }
    expect(stickAlbedoPixels()).toEqual(pixels);
  });

  it('carves a wall between the painted floor and the open face', () => {
    const pixels = stickNormalPixels();
    const flat: [number, number, number, number] = [128, 128, 255, 255];
    // Flat on the pip's floor, on the open face and on the side wall.
    expect(facePixel(pixels, 0.5, 0.5)).toEqual(flat);
    expect(facePixel(pixels, 0.2, 0.5)).toEqual(flat);
    expect(facePixel(pixels, 0.2, 0.98)).toEqual(flat);

    // On the +u wall the normal tilts toward the centre (R < 128); on the -u
    // wall it tilts the other way (R > 128). The bar's length is much larger
    // than its width, so the u offset is in face units through `pipDistance`.
    const lengthUnits = STICK_SIZE.lengthUnits;
    const wallU = 0.5 + (STICK_CARVE.pipRadiusUnits + STICK_CARVE.wallUnits * 0.5) / lengthUnits;
    const plus = facePixel(pixels, wallU, 0.5);
    const minus = facePixel(pixels, 1 - wallU, 0.5);
    expect(plus[0]).toBeLessThan(126);
    expect(minus[0]).toBeGreaterThan(130);
    expect(plus[2]).toBeGreaterThan(128);
    expect(plus[2]).toBeLessThan(255);
  });

  it('makes the lacquered pip glossier than the moulded body', () => {
    const pixels = stickRoughnessPixels();
    const [pip] = facePixel(pixels, 0.5, 0.5);
    const [body] = facePixel(pixels, 0.2, 0.5);
    expect(pip).toBe(Math.round(STICK_CARVE.paintRoughness * 255));
    expect(body).toBe(Math.round(STICK_CARVE.bodyRoughness * 255));
    expect(pip).toBeLessThan(body);
    const [side] = facePixel(pixels, 0.2, 0.98);
    expect(side).toBe(Math.round(STICK_CARVE.bodyRoughness * 255));
  });
});

describe('the stick geometry', () => {
  it('is the bar’s exact size, centred on its origin', () => {
    const geometry = createStickGeometry();
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (!box) throw new Error('the stick has no bounding box');

    // The finished bar is exactly 65 x 3.5 x 7 mm (the quadratic end caps
    // approximate a semicircle to a few hundredths of a micron).
    expect(box.max.x - box.min.x).toBeCloseTo(STICK_SIZE.lengthUnits, 4);
    expect(box.max.y - box.min.y).toBeCloseTo(STICK_SIZE.heightUnits, 4);
    expect(box.max.z - box.min.z).toBeCloseTo(STICK_SIZE.widthUnits, 4);
    expect(box.max.x + box.min.x).toBeCloseTo(0, 6);
    expect(box.max.y + box.min.y).toBeCloseTo(0, 6);
    expect(box.max.z + box.min.z).toBeCloseTo(0, 6);
  });

  it('has an elliptical 7 x 3.5 mm cross-section at every point', () => {
    const geometry = createStickGeometry();
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (!box) throw new Error('the stick has no bounding box');
    const position = geometry.getAttribute('position');
    const semiWidth = STICK_SIZE.widthUnits / 2;
    const semiHeight = STICK_SIZE.heightUnits / 2;

    // The user's shape rule: looking down the long axis, the outline is an
    // ellipse. Every surface point must sit on (or inside) that ellipse — no
    // flat face, no square edge — and the widest/tallest points must reach it.
    let reachesTop = false;
    let reachesSide = false;
    for (let index = 0; index < position.count; index += 1) {
      const y = position.getY(index) / semiHeight;
      const z = position.getZ(index) / semiWidth;
      expect(y * y + z * z, `vertex ${index}`).toBeLessThanOrEqual(1 + 1e-6);
      if (Math.abs(y) > 0.999) reachesTop = true;
      if (Math.abs(z) > 0.999) reachesSide = true;
    }
    expect(reachesTop).toBe(true);
    expect(reachesSide).toBe(true);

    // The cross-section is the same ellipse along the straight middle: take a
    // ring near the centre and check each of its vertices is exactly on it.
    let onCentreRing = 0;
    for (let index = 0; index < position.count; index += 1) {
      if (Math.abs(position.getX(index)) > 1e-6) continue;
      const y = position.getY(index) / semiHeight;
      const z = position.getZ(index) / semiWidth;
      expect(y * y + z * z).toBeCloseTo(1, 5);
      onCentreRing += 1;
    }
    expect(onCentreRing).toBe(STICK.aroundSegments);

    // The plan ends are rounded (the sprite's semicircles): beyond the
    // straight middle the cross-section shrinks, and the tips are poles.
    const straightHalf = STICK_SIZE.lengthUnits / 2 - semiWidth;
    let maxWidthAtCap = 0;
    for (let index = 0; index < position.count; index += 1) {
      if (Math.abs(position.getX(index)) <= straightHalf + 1e-6) continue;
      maxWidthAtCap = Math.max(maxWidthAtCap, Math.abs(position.getZ(index)));
    }
    expect(maxWidthAtCap).toBeGreaterThan(0);
    expect(maxWidthAtCap).toBeLessThan(semiWidth);
  });

  it('projects the plan UVs across the elliptical surface', () => {
    const geometry = createStickGeometry();
    const uv = geometry.getAttribute('uv');
    const position = geometry.getAttribute('position');
    const length = STICK_SIZE.lengthUnits;
    const width = STICK_SIZE.widthUnits;
    for (let index = 0; index < uv.count; index += 1) {
      expect(uv.getX(index)).toBeCloseTo(
        (position.getX(index) + length / 2) / length,
        5,
      );
      expect(uv.getY(index)).toBeCloseTo(
        0.5 + position.getZ(index) / width,
        5,
      );
      expect(uv.getX(index)).toBeGreaterThanOrEqual(0);
      expect(uv.getX(index)).toBeLessThanOrEqual(1);
      expect(uv.getY(index)).toBeGreaterThanOrEqual(0);
      expect(uv.getY(index)).toBeLessThanOrEqual(1);
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
      // column 0 is the bar's +X (its length) turned by the declarer's yaw.
      const { right } = seatBasis(stick.seat);
      expect(matrix[offset]).toBeCloseTo(right[0], 6);
      expect(matrix[offset + 1]).toBeCloseTo(0, 6);
      expect(matrix[offset + 2]).toBeCloseTo(right[2], 6);
      // Standing on the compass plate.
      expect(stick.position[1]).toBeCloseTo(
        COMPASS_PLATE.topUnits + STICK_CONSTANTS.heightUnits / 2,
        9,
      );
    });
    layer.dispose();
  });

  it('is a glossy physical material with a carved face', () => {
    const layer = createStickMesh(layout.sticks);
    const material = layer.mesh.material as MeshPhysicalMaterial;
    expect(material.isMeshPhysicalMaterial).toBe(true);
    expect(material.map).not.toBeNull();
    expect(material.normalMap).not.toBeNull();
    expect(material.roughnessMap).not.toBeNull();
    expect(material.clearcoat).toBeGreaterThan(0.3);
    expect(material.clearcoatRoughness).toBeLessThan(0.2);
    expect(material.ior).toBeCloseTo(1.59, 2);
    expect(material.roughness).toBe(1);
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
