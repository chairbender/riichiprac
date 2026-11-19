/**
 * The contact-shadow layer (3D-07 acceptance): one instanced draw, a
 * procedural blob per lying tile, and the 2.5D hand-group band.
 *
 * The pixels need a GPU, so the gate is everything numeric:
 *
 * - one quad per grounded non-hand tile, and exactly **one** hand group per seat
 *   (the concealed row and the drawn tile unioned), whether the seat has 13 + 1
 *   tiles or 1 + 0;
 * - every quad at the same lift, above the felt and below every tile's top
 *   surface, with a footprint at least the tile's own;
 * - the hand group's footprint is the union of its tiles' footprints spread by
 *   the v13 rig's 0.18 and moved 0.18 toward the viewer, with σ 0.26 across and
 *   0.10 along the band;
 * - the tile blob's alpha texture is a rounded, feathered blob (opaque in the
 *   middle, zero at every edge, deterministic), and the band's profile is 0.5
 *   on its edge, 1 a ring width inside and 0 a ring width outside;
 * - depth-tested, depth-write off, transparent, one mesh.
 *
 * AGENTS.md §6 still applies to the look: whether the band reads as a hand
 * resting on the table is the user's call at `?renderer=3d`, not this file's.
 */

import { ShaderMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { TILE } from '../layoutConstants';
import { boardFixture } from './boardFixture';
import { layoutBoard, orientedBox, orientedBoxCorners } from './boardLayout';
import {
  SHADOW,
  SHADOW_KIND,
  bandAlphaAt,
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
const handGroupFor = (seat: number) =>
  shadows.find((instance) => instance.id === `hand-group-${seat}`);

describe('contact quad placement', () => {
  it('emits one hand group per seat and one blob per other grounded tile', () => {
    const groups = shadows.filter((instance) => instance.kind === SHADOW_KIND.band);
    const blobs = shadows.filter((instance) => instance.kind === SHADOW_KIND.blob);
    expect(groups).toHaveLength(4);
    expect(groups.map((group) => group.id).sort()).toEqual([
      'hand-group-0',
      'hand-group-1',
      'hand-group-2',
      'hand-group-3',
    ]);

    // Every grounded hand/draw tile is covered by its seat's group, and no
    // hand/draw tile has a blob of its own any more.
    const handTiles = grounded.filter(
      (tile) => tile.zone === 'hand' || tile.zone === 'draw',
    );
    expect(handTiles.length).toBeGreaterThan(0);
    for (const tile of handTiles) {
      expect(blobs.some((blob) => blob.id === tile.id), tile.id).toBe(false);
    }
    const blobIds = new Set(blobs.map((blob) => blob.id));
    for (const tile of grounded) {
      if (tile.zone === 'hand' || tile.zone === 'draw') continue;
      expect(blobIds.has(tile.id), tile.id).toBe(true);
    }
    // Fewer quads than grounded tiles now that each hand is one quad.
    expect(shadows.length).toBeLessThan(grounded.length);
  });

  it('anchors one band on the hand row + drawn tile contact line (v13)', () => {
    const group = handGroupFor(0);
    expect(group).toBeDefined();
    if (!group) return;
    const handTiles = grounded.filter(
      (tile) => tile.seat === 0 && (tile.zone === 'hand' || tile.zone === 'draw'),
    );
    // The band is built from the tiles' *contact* corners, not their boxes: a
    // reclined hand overhangs its contact edge, and using the body's footprint
    // would make the band twice as deep as the signed-off 0.5.
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let contactZ = Number.NEGATIVE_INFINITY;
    for (const tile of handTiles) {
      for (const corner of orientedBoxCorners(orientedBox(tile.pose))) {
        if (corner[1] > SHADOW.groundToleranceUnits) continue;
        minX = Math.min(minX, corner[0]);
        maxX = Math.max(maxX, corner[0]);
        contactZ = Math.max(contactZ, corner[2]);
      }
    }
    // Row: the contact span plus the rig's 0.18 at both ends.
    expect(group.sizeUnits[0]).toBeCloseTo(
      maxX - minX + SHADOW.hand.spreadUnits * 2,
      9,
    );
    expect(group.centre[0]).toBeCloseTo((minX + maxX) / 2, 9);
    // Depth: exactly the rig's 0.5, with its south edge 0.18 past the contact
    // edge and its north edge 0.32 under the body.
    expect(group.sizeUnits[1]).toBeCloseTo(SHADOW.hand.depthUnits, 9);
    const south = group.centre[2] + group.sizeUnits[1] / 2;
    const north = group.centre[2] - group.sizeUnits[1] / 2;
    expect(south).toBeCloseTo(contactZ + SHADOW.hand.offsetUnits, 9);
    expect(north).toBeCloseTo(
      contactZ - (SHADOW.hand.depthUnits - SHADOW.hand.offsetUnits),
      9,
    );
    // Dark where the hand meets the felt: v13's core alpha over the felt.
    expect(
      bandAlphaAt(
        [0, contactZ - group.centre[2]],
        [group.sizeUnits[0] / 2, group.sizeUnits[1] / 2],
        group.sigmaUnits,
      ),
    ).toBeGreaterThan(0.9);
    // The drawn tile is inside the band, and so is the tsumogiri gap.
    const draw = handTiles.find((tile) => tile.zone === 'draw');
    expect(draw).toBeDefined();
    if (!draw) return;
    expect(draw.pose.position[0]).toBeLessThan(group.centre[0] + group.sizeUnits[0] / 2);
    expect(draw.pose.position[0]).toBeGreaterThan(group.centre[0] - group.sizeUnits[0] / 2);
  });

  it('mirrors the band for the across player and runs the side bands along their rows', () => {
    // The across seat faces the camera, so its contact edge is its nearest (max)
    // z and the band is south of it, exactly like the player's.
    const across = handGroupFor(2);
    expect(across).toBeDefined();
    if (!across) return;
    const acrossTiles = grounded.filter(
      (tile) => tile.seat === 2 && (tile.zone === 'hand' || tile.zone === 'draw'),
    );
    let contactZ = Number.NEGATIVE_INFINITY;
    for (const tile of acrossTiles) {
      for (const corner of orientedBoxCorners(orientedBox(tile.pose))) {
        if (corner[1] > SHADOW.groundToleranceUnits) continue;
        contactZ = Math.max(contactZ, corner[2]);
      }
    }
    expect(across.centre[2] + across.sizeUnits[1] / 2).toBeCloseTo(
      contactZ + SHADOW.hand.offsetUnits,
      9,
    );
    // A side seat's row runs along Z, so its band's long axis is Z too.
    const right = handGroupFor(1);
    expect(right).toBeDefined();
    if (!right) return;
    expect(right.sizeUnits[1]).toBeGreaterThan(right.sizeUnits[0] * 4);
  });

  it('uses the rig\u2019s sigmas across and along the band', () => {
    // The human's row runs along world X, so the across-sigma is on Z.
    const human = handGroupFor(0);
    expect(human?.sigmaUnits).toEqual([
      SHADOW.hand.sigmaAlongUnits,
      SHADOW.hand.sigmaAcrossUnits,
    ]);
    // Seat 1's row runs along Z, so the axes swap.
    const right = handGroupFor(1);
    expect(right?.sigmaUnits).toEqual([
      SHADOW.hand.sigmaAcrossUnits,
      SHADOW.hand.sigmaAlongUnits,
    ]);
    // The rig's numbers, copied (v13-shadow-darker.handShadow).
    expect(SHADOW.hand).toEqual({
      depthUnits: 0.5,
      offsetUnits: 0.18,
      spreadUnits: 0.18,
      sigmaAcrossUnits: 0.26,
      sigmaAlongUnits: 0.1,
    });
    // Blob quads carry no analytic sigma.
    for (const blob of shadows.filter((entry) => entry.kind === SHADOW_KIND.blob)) {
      expect(blob.sigmaUnits).toEqual([0, 0]);
    }
  });

  it('emits nothing for a raised tier, and everything at the same lift', () => {
    const topTier = layout.wall.find((tile) => tile.pose.position[1] > TILE.thicknessUnits);
    expect(topTier).toBeDefined();
    if (!topTier) return;
    expect(isGrounded(topTier)).toBe(false);
    expect(tileLowestY(topTier)).toBeGreaterThan(SHADOW.groundToleranceUnits);
    expect(shadows.some((instance) => instance.id === topTier.id)).toBe(false);

    for (const shadow of shadows) {
      expect(shadow.centre[1]).toBe(SHADOW.liftUnits);
    }
    // The lift is below every tile's top surface: the body always wins the
    // depth test, so no quad can paint over a tile.
    expect(SHADOW.liftUnits).toBeLessThan(TILE.thicknessUnits / 2);
    for (const tile of grounded) {
      expect(tileLowestY(tile), tile.id).toBeLessThanOrEqual(SHADOW.groundToleranceUnits);
      expect(tileLowestY(tile), tile.id).toBeGreaterThan(-SHADOW.groundToleranceUnits);
    }
  });

  it('scales each tile blob to its own footprint plus a contact rim', () => {
    for (const blob of shadows.filter((entry) => entry.kind === SHADOW_KIND.blob)) {
      const tile = grounded.find((entry) => entry.id === blob.id);
      expect(tile, blob.id).toBeDefined();
      if (!tile) continue;
      const footprint = tileFootprint(tile);
      expect(blob.sizeUnits[0]).toBeCloseTo(footprint[0] + SHADOW.paddingUnits * 2, 9);
      expect(blob.sizeUnits[1]).toBeCloseTo(footprint[1] + SHADOW.paddingUnits * 2, 9);
      expect(blob.centre[0]).toBeCloseTo(tile.pose.position[0], 9);
      expect(blob.centre[2]).toBeCloseTo(tile.pose.position[2], 9);
    }
    // A lying pond tile's footprint is its full 21 x 28 mm face.
    const pond = grounded.find((tile) => tile.zone === 'river');
    expect(pond).toBeDefined();
    if (!pond) return;
    const footprint = tileFootprint(pond);
    expect(Math.max(...footprint)).toBeCloseTo(TILE.heightUnits, 9);
    expect(Math.min(...footprint)).toBeCloseTo(TILE.widthUnits, 9);
  });

  it('packs finite, rigid quad matrices on the felt', () => {
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
      // The hand groups reach 0.18 past the row, so allow that in the bounds.
      const slack = 12.5 + SHADOW.hand.spreadUnits + SHADOW.hand.offsetUnits;
      expect(Math.abs(shadow.centre[0]) + shadow.sizeUnits[0] / 2).toBeLessThanOrEqual(slack);
      expect(Math.abs(shadow.centre[2]) + shadow.sizeUnits[1] / 2).toBeLessThanOrEqual(slack);
    }
    expect(orientedBox(grounded[0].pose).centre).toEqual(grounded[0].pose.position);
  });
});

describe('the procedural profiles', () => {
  it('blob: opaque at the centre, zero at every edge, and symmetric', () => {
    expect(shadowAlphaAt(0.5, 0.5)).toBeCloseTo(1, 6);
    for (const value of [0, 1]) {
      expect(shadowAlphaAt(value, 0.5)).toBe(0);
      expect(shadowAlphaAt(0.5, value)).toBe(0);
      expect(shadowAlphaAt(value, value)).toBe(0);
    }
    expect(shadowAlphaAt(0.25, 0.5)).toBeCloseTo(shadowAlphaAt(0.75, 0.5), 12);
    expect(shadowAlphaAt(0.5, 0.25)).toBeCloseTo(shadowAlphaAt(0.5, 0.75), 12);
    let previous = 1;
    for (let step = 0; step <= 10; step += 1) {
      const alpha = shadowAlphaAt(0.5 + (step / 10) * 0.5, 0.5);
      expect(alpha).toBeLessThanOrEqual(previous + 1e-12);
      previous = alpha;
    }
  });

  it('blob: a deterministic RGBA texture with a bright core', () => {
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
    expect(pixels[0]).toBe(0);
    expect(pixels[1]).toBe(0);
    expect(pixels[2]).toBe(0);
  });

  it('band: 1 inside, 0.5 on the edge, 0 outside, in world units', () => {
    const half: [number, number] = [6, 0.5];
    const sigma: [number, number] = [0.1, 0.26];
    expect(bandAlphaAt([0, 0], half, sigma)).toBeCloseTo(1, 6);
    // On the long edge (z = 0.5) the alpha is exactly the edge value.
    expect(bandAlphaAt([0, 0.5], half, sigma)).toBeCloseTo(0.5, 6);
    expect(bandAlphaAt([6, 0], half, sigma)).toBeCloseTo(0.5, 6);
    // A ring width inside/outside is 1/0.
    expect(bandAlphaAt([0, 0.24], half, sigma)).toBeCloseTo(1, 6);
    expect(bandAlphaAt([0, 0.76], half, sigma)).toBeCloseTo(0, 6);
    expect(bandAlphaAt([5.9, 0], half, sigma)).toBeCloseTo(1, 6);
    expect(bandAlphaAt([6.1, 0], half, sigma)).toBeCloseTo(0, 6);
    // Monotone outward across the band, so the gradient has no shelf.
    let previous = 1;
    for (let step = 0; step <= 10; step += 1) {
      const alpha = bandAlphaAt([0, (step / 10) * 0.76], half, sigma);
      expect(alpha).toBeLessThanOrEqual(previous + 1e-12);
      previous = alpha;
    }
  });
});

describe('the shadow layer', () => {
  it('is one transparent, depth-tested, non-writing instanced draw', () => {
    const layer = createShadowLayer(shadows);
    expect(layer.mesh.isInstancedMesh).toBe(true);
    expect(layer.count).toBe(shadows.length);
    const material = layer.mesh.material as ShaderMaterial;
    expect(material.isShaderMaterial).toBe(true);
    expect(material.transparent).toBe(true);
    expect(material.depthTest).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.uniforms.uOpacity.value).toBe(SHADOW.opacity);
    // Transparent materials are drawn after the opaque tiles; this order plus
    // the depth test is what keeps a quad off a tile body.
    expect(layer.mesh.renderOrder).toBeGreaterThan(0);
    // The per-instance attributes the shader reads.
    for (const attribute of ['aHalfExtents', 'aSigma', 'aKind']) {
      expect(layer.mesh.geometry.getAttribute(attribute), attribute).toBeDefined();
    }
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
