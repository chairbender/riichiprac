/**
 * The contact-shadow layer (3D-07 acceptance): one instanced draw, a
 * procedural blob per lying tile, and the 2.5D hand-group band.
 *
 * The pixels need a GPU, so the gate is everything numeric:
 *
 * - one quad per grounded tile, with **the human's** hand row and drawn tile
 *   unioned into a single band (the other hands stand on the table and keep
 *   their per-tile blobs);
 * - every quad at the same lift, above the felt and below every tile's top
 *   surface, with a footprint at least the tile's own;
 * - the band's footprint is anchored on the hand's contact line, 0.7 deep, moved
 *   0.35 toward the viewer, spread 0.24 at both row ends, with σ 0.45 across and
 *   0.22 along (the v13 recipe, widened for this camera);
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
import { TILE, WALL } from '../layoutConstants';
import { boardFixture } from './boardFixture';
import {
  layoutBoard,
  orientedBox,
  orientedBoxCorners,
  seatBasis,
  wallRunRadius,
} from './boardLayout';
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
  it('unions every hand into one band, and shadows only the occupied wall', () => {
    const bands = shadows.filter((instance) => instance.kind === SHADOW_KIND.band);
    const blobs = shadows.filter((instance) => instance.kind === SHADOW_KIND.blob);
    // With 69 live tiles the default fixture's wall occupies the human's run
    // (stacks 9..16), the right run (all 17) and the far run's live half plus the
    // dead block (two stretches, split by the dead wall's felt break). The left
    // run is empty (the deal came from it), so it casts nothing; only the right
    // run still reaches its player-facing end.
    expect(bands.map((band) => band.id).sort()).toEqual(
      [
        `hand-group-${layout.humanSeat}`,
        'wall-cast-0-0',
        'wall-cast-1-0',
        'wall-cast-2-0',
        'wall-cast-2-1',
        'wall-end-cast-1',
        'hand-cast-1',
        'hand-cast-2',
        'hand-cast-3',
      ].sort(),
    );

    const handTiles = grounded.filter(
      (tile) => tile.zone === 'hand' || tile.zone === 'draw',
    );
    const blobIds = new Set(blobs.map((blob) => blob.id));
    for (const tile of handTiles) {
      expect(blobIds.has(tile.id), tile.id).toBe(false);
    }
    for (const tile of grounded) {
      if (tile.zone === 'hand' || tile.zone === 'draw') continue;
      expect(blobIds.has(tile.id), tile.id).toBe(true);
    }
    expect(blobs).toHaveLength(grounded.length - handTiles.length);
    expect(shadows).toHaveLength(blobs.length + bands.length);
  });

  it('follows the human seat', () => {
    const shifted = layoutBoard(boardFixture({ humanSeat: 2 }));
    const ids = shadowInstances(shifted)
      .filter((instance) => instance.kind === SHADOW_KIND.band)
      .map((band) => band.id)
      .sort();
    expect(ids).toEqual(
      [
        'hand-group-2',
        'hand-cast-0',
        'hand-cast-1',
        'hand-cast-3',
        // The far run (from seat 2) is run 0: its live half plus the dead block.
        'wall-cast-0-0',
        'wall-cast-0-1',
        'wall-cast-2-0',
        // The run to seat 2's right (run 3) carries the live wall and reaches its
        // player-facing end; run 1 is empty, so it has neither band nor end cap.
        'wall-cast-3-0',
        'wall-end-cast-3',
      ].sort(),
    );
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
    // Row: the contact span plus the rig's spread at both ends...
    expect(group.innerHalfUnits[0]).toBeCloseTo(
      (maxX - minX) / 2 + SHADOW.hand.spreadUnits,
      9,
    );
    expect(group.centre[0]).toBeCloseTo((minX + maxX) / 2, 9);
    // ...and the depth rect: exactly `depthUnits` deep with its south edge
    // `offsetUnits` past the contact edge and its north edge under the hand.
    expect(group.innerHalfUnits[1]).toBeCloseTo(SHADOW.hand.depthUnits / 2, 9);
    const south = group.centre[2] + group.innerHalfUnits[1];
    const north = group.centre[2] - group.innerHalfUnits[1];
    expect(south).toBeCloseTo(contactZ + SHADOW.hand.offsetUnits, 9);
    expect(north).toBeCloseTo(
      contactZ - (SHADOW.hand.depthUnits - SHADOW.hand.offsetUnits),
      9,
    );
    // The quad carries a fade margin outside the rect on both axes, so the
    // profile reaches 0 before the geometry ends. Without it the band is cut off
    // at 0.5 alpha and reads as a solid rectangle (the handoff's complaint).
    expect(group.sizeUnits[0]).toBeCloseTo(
      group.innerHalfUnits[0] * 2 + 2 * SHADOW.hand.sigmaAlongUnits * SHADOW.marginSigmas,
      9,
    );
    expect(group.sizeUnits[1]).toBeCloseTo(
      group.innerHalfUnits[1] * 2 + 2 * SHADOW.hand.sigmaAcrossUnits * SHADOW.marginSigmas,
      9,
    );
    // Alpha at the quad's own edge is 0, and 0 at the fade-out distance beyond
    // the rect too, so nothing is clipped.
    const halfAtEdge: [number, number] = [group.sizeUnits[0] / 2, group.sizeUnits[1] / 2];
    expect(bandAlphaAt(halfAtEdge, group.innerHalfUnits, group.sigmaUnits)).toBeCloseTo(0, 6);
    const fadeOut = [
      group.innerHalfUnits[0] + SHADOW.hand.sigmaAlongUnits,
      group.innerHalfUnits[1] + SHADOW.hand.sigmaAcrossUnits,
    ] as const;
    expect(bandAlphaAt(fadeOut, group.innerHalfUnits, group.sigmaUnits)).toBeCloseTo(0, 6);
    // The handoff moved it down half a tile thickness beyond the first pass.
    expect(SHADOW.hand.offsetUnits).toBeGreaterThan(0.35);
    expect(SHADOW.hand.offsetUnits).toBeLessThan(0.35 + TILE.thicknessUnits);
    // Dark where the hand meets the felt: v13's core alpha over the felt.
    expect(
      bandAlphaAt(
        [0, contactZ - group.centre[2]],
        group.innerHalfUnits,
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

  /** Where a band's visible shadow ends on its depth axis. */
  function castReach(
    instance: {
      centre: readonly number[];
      innerHalfUnits: readonly [number, number];
      sigmaUnits: readonly [number, number];
    },
    rowIsX: boolean,
    sign: number,
  ): number {
    const depthCentre = rowIsX ? instance.centre[2] : instance.centre[0];
    const depthHalf = rowIsX ? instance.innerHalfUnits[1] : instance.innerHalfUnits[0];
    const sigma = rowIsX ? instance.sigmaUnits[1] : instance.sigmaUnits[0];
    return depthCentre + sign * (depthHalf + sigma);
  }

  it('throws the opponents\u2019 shadows directly away from the table centre', () => {
    const expectCast = (seat: number, rowIsX: boolean, sign: number) => {
      const band = shadows.find((instance) => instance.id === `hand-cast-${seat}`);
      expect(band, `seat ${seat}`).toBeDefined();
      if (!band) return;
      // The seat's own contact edge, from its contact corners.
      const tiles = grounded.filter(
        (tile) => tile.seat === seat && (tile.zone === 'hand' || tile.zone === 'draw'),
      );
      let contact = sign > 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
      for (const tile of tiles) {
        for (const corner of orientedBoxCorners(orientedBox(tile.pose))) {
          if (corner[1] > SHADOW.groundToleranceUnits) continue;
          const depth = rowIsX ? corner[2] : corner[0];
          contact = sign > 0 ? Math.max(contact, depth) : Math.min(contact, depth);
        }
      }
      // The visible reach is exactly `cast.lengthUnits` past that edge.
      expect(castReach(band, rowIsX, sign)).toBeCloseTo(
        contact + sign * SHADOW.cast.lengthUnits,
        9,
      );
      // And the band is a real rect on both axes (it starts under the body).
      expect(band.innerHalfUnits[0]).toBeGreaterThan(0);
      expect(band.innerHalfUnits[1]).toBeGreaterThan(0);
    };
    expectCast(2, true, -1);
    expectCast(1, false, 1);
    expectCast(3, false, -1);
  });

  it('casts each occupied wall stretch outward, and nothing where the wall is gone', () => {
    const wallTiles = layout.wall.filter((tile) => tile.zone === 'wall');
    // One band for the human's run, the right run, and two on the far run (its
    // live half and the dead block, split by the dead wall's felt break). The
    // left run is empty.
    const bandIds = shadows
      .filter((instance) => instance.id.startsWith('wall-cast-'))
      .map((instance) => instance.id)
      .sort();
    expect(bandIds).toEqual(
      [
        'wall-cast-0-0',
        'wall-cast-1-0',
        'wall-cast-2-0',
        'wall-cast-2-1',
      ].sort(),
    );

    for (let run = 0; run < 4; run += 1) {
      const runTiles = wallTiles.filter(
        (tile) => Math.floor(tile.slot / WALL.slotsPerRun) === run,
      );
      const runBands = shadows.filter((instance) =>
        instance.id.startsWith(`wall-cast-${run}-`),
      );
      if (runTiles.length === 0) {
        expect(runBands).toHaveLength(0);
        continue;
      }
      const seat = run as 0 | 1 | 2 | 3;
      const { outward, right } = seatBasis(seat);
      const rowIsX = Math.abs(right[0]) > Math.abs(right[2]);
      const sign = rowIsX ? Math.sign(outward[2]) : Math.sign(outward[0]);
      const outerFace =
        sign * (wallRunRadius(seat, layout.humanSeat) + TILE.heightUnits / 2);
      const rows = runTiles
        .map((tile) => tile.pose.position[0] * right[0] + tile.pose.position[2] * right[2])
        .sort((left, rightValue) => left - rightValue);
      // Every band's outward reach is the run's outer face plus the cast length.
      for (const band of runBands) {
        expect(castReach(band, rowIsX, sign)).toBeCloseTo(
          outerFace + sign * SHADOW.cast.lengthUnits,
          9,
        );
        const rowHalf = rowIsX ? band.innerHalfUnits[0] : band.innerHalfUnits[1];
        expect(rowHalf).toBeGreaterThan(0);
        expect(rowHalf).toBeLessThanOrEqual(WALL.runHalfLengthUnits + 1e-9);
      }
      // One band per contiguous stretch, and every occupied row inside a band.
      const stretches: { min: number; max: number }[] = [];
      for (const row of rows) {
        const current = stretches[stretches.length - 1];
        if (current && row - current.max <= WALL.stackPitchUnits + 0.05) {
          current.max = row;
        } else {
          stretches.push({ min: row, max: row });
        }
      }
      expect(runBands).toHaveLength(stretches.length);
      const rowCentre = (band: (typeof runBands)[number]): number =>
        rowIsX ? band.centre[0] : band.centre[2];
      const rowHalf = (band: (typeof runBands)[number]): number =>
        rowIsX ? band.innerHalfUnits[0] : band.innerHalfUnits[1];
      for (const row of rows) {
        expect(
          runBands.some(
            (band) => Math.abs(row - rowCentre(band)) <= rowHalf(band) + 1e-9,
          ),
        ).toBe(true);
      }
    }
  });

  it('casts a side run\u2019s player-facing end only while it reaches that end', () => {
    // A side run's outward band goes sideways, which leaves the strip of felt in
    // front of its end face unshadowed; the end band fills that notch, exactly
    // as long as the near run's cast and exactly as wide as the wall is thick.
    // At 69 live tiles only the right run (run 1) reaches its near end; the left
    // run is empty, so it casts neither a band nor an end notch.
    const band = shadows.find((instance) => instance.id === 'wall-end-cast-1');
    expect(band, 'run 1').toBeDefined();
    if (!band) return;
    // Its visible reach is `cast.lengthUnits` beyond the run's end, toward +Z.
    const south = band.centre[2] + band.innerHalfUnits[1] + band.sigmaUnits[1];
    expect(south).toBeCloseTo(
      WALL.runHalfLengthUnits + SHADOW.cast.lengthUnits,
      9,
    );
    // Its width is the run's own radial footprint (28 mm), no spread.
    expect(band.innerHalfUnits[0] * 2).toBeCloseTo(TILE.heightUnits, 9);
    // It meets the near run's band: the near band ends at the run end in X,
    // this one starts at the side run's inner face.
    const { outward } = seatBasis(1);
    const sign = Math.sign(outward[0]);
    const inner = band.centre[0] - sign * band.innerHalfUnits[0];
    expect(Math.abs(inner)).toBeCloseTo(
      wallRunRadius(1, layout.humanSeat) - TILE.heightUnits / 2,
      9,
    );

    expect(shadows.some((instance) => instance.id === 'wall-end-cast-3')).toBe(false);
    // The near and far runs need no end band: their outward cast already covers
    // the player-facing side.
    expect(shadows.some((instance) => instance.id === 'wall-end-cast-0')).toBe(false);
    expect(shadows.some((instance) => instance.id === 'wall-end-cast-2')).toBe(false);
  });

  it('assigns the sigmas across and along the human band', () => {
    // The human's row runs along world X, so the across-sigma is on Z.
    const human = handGroupFor(0);
    expect(human?.sigmaUnits).toEqual([
      SHADOW.hand.sigmaAlongUnits,
      SHADOW.hand.sigmaAcrossUnits,
    ]);
    // Blob quads carry no analytic sigma.
    for (const blob of shadows.filter((entry) => entry.kind === SHADOW_KIND.blob)) {
      expect(blob.sigmaUnits).toEqual([0, 0]);
    }
    // The numbers the handoff settled on, checked as a table.
    expect(SHADOW.hand).toEqual({
      depthUnits: 1.1,
      offsetUnits: 0.65,
      spreadUnits: 0.24,
      sigmaAcrossUnits: 0.5,
      sigmaAlongUnits: 0.3,
    });
    expect(SHADOW.marginSigmas).toBe(1.5);
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
      // The human band reaches past the row, so allow that in the bounds.
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
    for (const attribute of ['aHalfExtents', 'aInnerHalf', 'aSigma', 'aKind']) {
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
