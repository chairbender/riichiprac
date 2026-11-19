/**
 * The contact-shadow layer (3D-07 acceptance): one instanced quad draw, a
 * procedural rounded blob, and a material state that cannot paint over a tile.
 *
 * The pixels themselves need a GPU, so the gate here is everything numeric:
 *
 * - one quad per *grounded* tile and none for a wall top tier (whose contact is
 *   the tile beneath it, not the cloth);
 * - every quad at the same lift, above the felt and below every tile's top
 *   surface, with a footprint at least the tile's own;
 * - the alpha texture is a rounded, feathered blob: opaque in the middle, zero
 *   at every edge, deterministic;
 * - depth-tested, depth-write off, transparent, one mesh.
 *
 * AGENTS.md §6 still applies to the look: whether the rim reads as contact is
 * the user's call at `?renderer=3d`, not this file's.
 */

import { describe, expect, it } from 'vitest';
import { TILE } from '../layoutConstants';
import { boardFixture } from './boardFixture';
import { layoutBoard, orientedBox } from './boardLayout';
import {
  SHADOW,
  createShadowLayer,
  isGrounded,
  shadowAlphaAt,
  shadowAlphaPixels,
  shadowInstances,
  tileFootprint,
  tileLowestY,
} from './shadows';

const layout = layoutBoard(boardFixture());
const shadows = shadowInstances(layout);
const grounded = layout.tiles.filter(isGrounded);

describe('contact quad placement', () => {
  it('emits one quad per grounded tile and none for a raised tier', () => {
    expect(shadows).toHaveLength(grounded.length);
    expect(shadows.length).toBeLessThan(layout.tiles.length);
    const shadowIds = new Set(shadows.map((instance) => instance.id));
    for (const tile of layout.tiles) {
      expect(shadowIds.has(tile.id), tile.id).toBe(isGrounded(tile));
    }
    // A wall top-tier tile rests on the bottom tier, not on the felt.
    const topTier = layout.wall.find((tile) => tile.pose.position[1] > TILE.thicknessUnits);
    expect(topTier).toBeDefined();
    if (!topTier) return;
    expect(isGrounded(topTier)).toBe(false);
    expect(tileLowestY(topTier)).toBeGreaterThan(SHADOW.groundToleranceUnits);
    expect(shadowIds.has(topTier.id)).toBe(false);
  });

  it('keeps every quad on the felt plane, under every tile body', () => {
    for (const shadow of shadows) {
      expect(shadow.centre[1]).toBe(SHADOW.liftUnits);
      // The lift is a fraction of the thinnest dimension, so the plane is below
      // every tile's top surface: the tile body always wins the depth test.
      expect(SHADOW.liftUnits).toBeLessThan(TILE.thicknessUnits / 2);
    }
    // Grounded tiles touch the felt: their lowest point is at (or within
    // tolerance of) y = 0.
    for (const tile of grounded) {
      expect(tileLowestY(tile), tile.id).toBeLessThanOrEqual(SHADOW.groundToleranceUnits);
      expect(tileLowestY(tile), tile.id).toBeGreaterThan(-SHADOW.groundToleranceUnits);
    }
  });

  it('scales each quad to its own tile footprint plus a contact rim', () => {
    for (const tile of grounded) {
      const shadow = shadows.find((instance) => instance.id === tile.id);
      expect(shadow).toBeDefined();
      if (!shadow) continue;
      const footprint = tileFootprint(tile);
      expect(shadow.sizeUnits[0]).toBeCloseTo(footprint[0] + SHADOW.paddingUnits * 2, 9);
      expect(shadow.sizeUnits[1]).toBeCloseTo(footprint[1] + SHADOW.paddingUnits * 2, 9);
      // Centred under the tile's own body, not the table.
      expect(shadow.centre[0]).toBeCloseTo(tile.pose.position[0], 9);
      expect(shadow.centre[2]).toBeCloseTo(tile.pose.position[2], 9);
    }
    // A lying pond tile's footprint is its full 21 x 28 mm face.
    const pond = grounded.find((tile) => tile.zone === 'river');
    expect(pond).toBeDefined();
    if (!pond) return;
    const footprint = tileFootprint(pond);
    expect(Math.max(...footprint)).toBeCloseTo(TILE.heightUnits, 9);
    expect(Math.min(...footprint)).toBeCloseTo(TILE.widthUnits, 9);
  });

  it('packs finite, rigid quad matrices inside the mat', () => {
    for (const shadow of shadows) {
      expect(shadow.matrix).toHaveLength(16);
      expect(shadow.matrix.every((value) => Number.isFinite(value)), shadow.id).toBe(true);
      expect(shadow.matrix[12]).toBeCloseTo(shadow.centre[0], 9);
      expect(shadow.matrix[13]).toBeCloseTo(shadow.centre[1], 9);
      expect(shadow.matrix[14]).toBeCloseTo(shadow.centre[2], 9);
      // The plane is rotated flat: its normal (the matrix's third column) is +Y.
      expect(shadow.matrix[8]).toBeCloseTo(0, 6);
      expect(shadow.matrix[9]).toBeCloseTo(1, 6);
      expect(shadow.matrix[10]).toBeCloseTo(0, 6);
      expect(Math.abs(shadow.centre[0]) + shadow.sizeUnits[0] / 2).toBeLessThanOrEqual(12.5 + 1);
      expect(Math.abs(shadow.centre[2]) + shadow.sizeUnits[1] / 2).toBeLessThanOrEqual(12.5 + 1);
    }
    expect(orientedBox(grounded[0].pose).centre).toEqual(grounded[0].pose.position);
  });
});

describe('the procedural blob', () => {
  it('is opaque at the centre, zero at every edge, and symmetric', () => {
    expect(shadowAlphaAt(0.5, 0.5)).toBeCloseTo(1, 6);
    for (const value of [0, 1]) {
      expect(shadowAlphaAt(value, 0.5)).toBe(0);
      expect(shadowAlphaAt(0.5, value)).toBe(0);
      expect(shadowAlphaAt(value, value)).toBe(0);
    }
    expect(shadowAlphaAt(0.25, 0.5)).toBeCloseTo(shadowAlphaAt(0.75, 0.5), 12);
    expect(shadowAlphaAt(0.5, 0.25)).toBeCloseTo(shadowAlphaAt(0.5, 0.75), 12);
    // Monotone from the centre outward along an axis.
    let previous = 1;
    for (let step = 0; step <= 10; step += 1) {
      const alpha = shadowAlphaAt(0.5 + (step / 10) * 0.5, 0.5);
      expect(alpha).toBeLessThanOrEqual(previous + 1e-12);
      previous = alpha;
    }
  });

  it('generates a deterministic RGBA texture with a bright core', () => {
    const size = SHADOW.textureSize;
    const pixels = shadowAlphaPixels();
    expect(pixels).toHaveLength(size * size * 4);
    expect(shadowAlphaPixels()).toEqual(pixels);

    const alphaAt = (x: number, y: number) => pixels[(y * size + x) * 4 + 3];
    expect(alphaAt(size / 2, size / 2)).toBe(255);
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(size - 1, 0)).toBe(0);
    expect(alphaAt(0, size - 1)).toBe(0);
    expect(alphaAt(size - 1, size - 1)).toBe(0);
    // Black body: the material supplies the tint and the opacity.
    expect(pixels[0]).toBe(0);
    expect(pixels[1]).toBe(0);
    expect(pixels[2]).toBe(0);
  });
});

describe('the shadow layer', () => {
  it('is one transparent, depth-tested, non-writing instanced draw', () => {
    const layer = createShadowLayer(shadows);
    expect(layer.mesh.isInstancedMesh).toBe(true);
    expect(layer.count).toBe(shadows.length);
    const material = layer.mesh.material as {
      transparent: boolean;
      depthTest: boolean;
      depthWrite: boolean;
      opacity: number;
    };
    expect(material.transparent).toBe(true);
    expect(material.depthTest).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.opacity).toBe(SHADOW.opacity);
    // Transparent materials are drawn after the opaque tiles; this order plus
    // the depth test is what keeps a quad off a tile body.
    expect(layer.mesh.renderOrder).toBeGreaterThan(0);
    layer.dispose();
  });

  it('reserves the tile capacity and re-syncs in place', () => {
    const layer = createShadowLayer(shadows);
    expect(SHADOW.capacity).toBeGreaterThanOrEqual(shadows.length);
    expect(layer.mesh.instanceMatrix.count).toBe(SHADOW.capacity);
    const buffer = (layer.mesh.instanceMatrix.array as Float32Array).buffer;
    layer.sync(shadows.slice(0, 5));
    expect(layer.count).toBe(5);
    expect((layer.mesh.instanceMatrix.array as Float32Array).buffer).toBe(buffer);
    layer.dispose();
  });

  it('refuses an over-capacity layer rather than dropping shadows', () => {
    const small = createShadowLayer([], 2);
    expect(() =>
      small.sync(Array.from({ length: 3 }, (_, index) => shadows[index])),
    ).toThrow(/exceed the 2-quad capacity/);
    small.dispose();
  });
});
