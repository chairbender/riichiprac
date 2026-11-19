/**
 * The hero arrangement and its parallax budget (3D-05).
 *
 * The hero view's value is that its four tiles are at the *real* committed
 * places and attitudes, so the numbers it prints are the board's numbers. These
 * tests prove that claim against 3D-06's own layout, which is the only other
 * place those poses exist:
 *
 * - the hand/pond/dora/wall poses equal `layoutBoard(boardFixture())`'s poses for
 *   the matching tiles (a drift in either module fails here);
 * - the instance matrices are rigid (orthonormal, determinant +1);
 * - the probe points sit on the plate (and on the -Z plate for the face-down
 *   slot);
 * - at every supported aspect the four slots' worst full-depth displacement is
 *   inside 8 texels, and the printed table names the slot and angle;
 * - the strict board-wide worst case (a far meld at 4:3, the one pose the hero
 *   set does not contain) is printed too, so the record shows whether the
 *   shader's clamp binds anywhere.
 */

import { describe, expect, it } from 'vitest';
import { CAMERA, HAND, POND, TILE } from '../layoutConstants';
import { boardFixture } from './boardFixture';
import { frameForAspect, layoutBoard, poseAxes, seatPoint } from './boardLayout';
import {
  HERO_PROBE_UV,
  HERO_SLOTS,
  bevelLocalPoint,
  heroInstances,
  heroParallaxAllAspects,
  heroParallaxAt,
  heroPoseMatrix,
  heroVisibleNormal,
  probeLocalPoint,
  probeWorldPoint,
  slotWorldPoint,
} from './hero';
import { POM_MAX_TEXELS, parallaxTexels } from './tileMaterial';

const layout = layoutBoard(boardFixture());

function slot(id: (typeof HERO_SLOTS)[number]['id']) {
  const entry = HERO_SLOTS.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`missing hero slot ${id}`);
  return entry;
}

function expectVecClose(
  actual: readonly number[],
  expected: readonly number[],
  tolerance = 1e-12,
): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => {
    expect(Math.abs(value - expected[index]), `axis ${index}`).toBeLessThan(tolerance);
  });
}

describe('the hero attitudes are the board attitudes', () => {
  it('puts the hand tile exactly where 3D-06 puts the human hand', () => {
    const hand = slot('hand');
    // A 13-tile hand has a centre slot; the default fixture holds a meld per
    // seat (10 concealed), so this check uses an un-called hand.
    const centerLayout = layoutBoard(boardFixture({ meldCounts: [0, 0, 0, 0] }));
    const boardHands = centerLayout.tiles.filter(
      (tile) => tile.zone === 'hand' && tile.seat === 0,
    );
    // The centre slot of the 13-tile row (the fixture's slot numbering is the
    // snapshot's, not a guaranteed index).
    const boardHand = boardHands.reduce((closest, tile) =>
      Math.abs(tile.pose.position[0]) < Math.abs(closest.pose.position[0])
        ? tile
        : closest,
    );
    expect(Math.abs(boardHand.pose.position[0])).toBeLessThan(0.4);
    expect(hand.pose.tiltDeg).toBe(-HAND.reclineDeg);
    expect(hand.pose.yawDeg).toBe(boardHand.pose.yawDeg);
    expectVecClose(hand.pose.position, boardHand.pose.position, 1e-9);
    // The reclined tile's body centre stands above the felt by the tilt's rise.
    expect(hand.pose.position[1]).toBeGreaterThan(TILE.thicknessUnits / 2);
  });

  it('puts the pond tile on the human pond nearest row', () => {
    const pond = slot('pond');
    const boardPond = layout.tiles.find(
      (tile) =>
        tile.zone === 'river' &&
        tile.seat === 0 &&
        Math.abs(tile.pose.position[2] - POND.rowRadiiUnits[POND.overflowRow]) < 1e-9,
    );
    if (!boardPond) throw new Error('the fixture has no nearest-row pond tile');
    expect(pond.pose.tiltDeg).toBe(-90);
    expect(pond.pose.position[1]).toBeCloseTo(TILE.thicknessUnits / 2, 12);
    expect(pond.pose.position[2]).toBeCloseTo(POND.rowRadiiUnits[POND.overflowRow], 12);
  });

  it('puts the dora tile on the far wall top tier, oriented to the human', () => {
    const wall = slot('wall');
    const boardDora = layout.tiles.find((tile) => tile.zone === 'dora' && tile.slot === 0);
    if (!boardDora) throw new Error('the fixture has no dora indicator');
    expect(wall.pose.position).toEqual(boardDora.pose.position);
    expect(wall.pose.tiltDeg).toBe(boardDora.pose.tiltDeg);
    expect(wall.pose.yawDeg).toBe(boardDora.pose.yawDeg);
    expect(wall.pose.position[1]).toBeGreaterThan(TILE.thicknessUnits);
  });

  it('puts the blue back on the next wall stack, face-down', () => {
    const back = slot('back');
    const boardWall = layout.tiles.find(
      (tile) =>
        tile.zone === 'wall' &&
        Math.abs(tile.pose.position[0] - back.pose.position[0]) < 1e-9 &&
        Math.abs(tile.pose.position[1] - back.pose.position[1]) < 1e-9 &&
        Math.abs(tile.pose.position[2] - back.pose.position[2]) < 1e-9,
    );
    if (!boardWall) throw new Error('the fixture has no matching wall tile');
    expect(back.pose.tiltDeg).toBe(90);
    expect(back.faceUp).toBe(false);
    expect(boardWall.faceUp).toBe(false);
    expectVecClose(back.pose.position, boardWall.pose.position, 1e-9);
  });

  it('covers all four handoff slots exactly once', () => {
    expect(HERO_SLOTS.map((entry) => entry.id)).toEqual(['hand', 'pond', 'wall', 'back']);
    expect(new Set(HERO_SLOTS.map((entry) => entry.id)).size).toBe(4);
  });
});

describe('instance data', () => {
  it('builds a rigid matrix for each slot', () => {
    const instances = heroInstances(() => ({ rect: [0, 0.1, 0.25, 0.2] as const }));
    expect(instances).toHaveLength(HERO_SLOTS.length);
    for (const instance of instances) {
      const axes = poseAxes(instance.slot.pose);
      for (const axis of axes) {
        expect(Math.hypot(axis[0], axis[1], axis[2])).toBeCloseTo(1, 9);
      }
      // Orthogonal axes (a rotation, not a skew or a scale).
      expect(axes[0][0] * axes[1][0] + axes[0][1] * axes[1][1] + axes[0][2] * axes[1][2]).toBeCloseTo(0, 9);
      expect(axes[0][0] * axes[2][0] + axes[0][1] * axes[2][1] + axes[0][2] * axes[2][2]).toBeCloseTo(0, 9);
      const determinant =
        axes[0][0] * (axes[1][1] * axes[2][2] - axes[1][2] * axes[2][1]) -
        axes[0][1] * (axes[1][0] * axes[2][2] - axes[1][2] * axes[2][0]) +
        axes[0][2] * (axes[1][0] * axes[2][1] - axes[1][1] * axes[2][0]);
      expect(determinant).toBeCloseTo(1, 9);
      expect(instance.matrix).toEqual(heroPoseMatrix(instance.slot));
    }
  });

  it('gives each face-up slot its atlas rect and the back the neutral one', () => {
    const instances = heroInstances((face) =>
      face === '1p' ? { rect: [0, 0, 0.1666, 0.1428] as const } : { rect: [0.5, 0.5, 0.6, 0.6] as const },
    );
    const hand = instances.find((instance) => instance.slot.id === 'hand');
    expect(hand?.atlasRect).toEqual([0, 0, 0.1666, 0.1428]);
    const back = instances.find((instance) => instance.slot.id === 'back');
    expect(back?.atlasRect).toEqual([0, 0, 1, 1]);
  });

  it('falls back to the neutral rect when a face has no baked art', () => {
    const instances = heroInstances(() => null);
    for (const instance of instances) {
      expect(instance.atlasRect).toEqual([0, 0, 1, 1]);
    }
  });
});

describe('probe points', () => {
  it('maps the plate UV into the plate rectangle', () => {
    const pond = slot('pond');
    const centre = probeLocalPoint(pond, { u: 0.5, v: 0.5 });
    expect(centre[0]).toBeCloseTo(0, 12);
    expect(centre[1]).toBeCloseTo(0, 12);
    expect(centre[2]).toBeCloseTo(TILE.thicknessUnits / 2, 12);

    const topLeft = probeLocalPoint(pond, { u: 0, v: 0 });
    expect(topLeft[0]).toBeCloseTo(-TILE.facePlateWidthUnits / 2, 12);
    expect(topLeft[1]).toBeCloseTo(TILE.facePlateHeightUnits / 2, 12);

    // Every probe UV stays inside the plate.
    for (const uv of [HERO_PROBE_UV.ink, HERO_PROBE_UV.centre]) {
      expect(Math.abs(uv.u - 0.5)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(uv.v - 0.5)).toBeLessThanOrEqual(0.5);
    }
  });

  it('puts the face-down slot probe on its blue back, not its hidden face', () => {
    const back = slot('back');
    const point = probeLocalPoint(back, HERO_PROBE_UV.centre);
    expect(point[2]).toBeCloseTo(-TILE.thicknessUnits / 2, 12);
    // The visible normal is the opposite of the hidden face's normal.
    const normal = heroVisibleNormal(back);
    const face = poseAxes(back.pose)[2];
    expect(normal[0]).toBeCloseTo(-face[0], 12);
    expect(normal[1]).toBeCloseTo(-face[1], 12);
    expect(normal[2]).toBeCloseTo(-face[2], 12);
  });

  it('keeps the bevel probe outside the plate and inside the body', () => {
    const bevel = bevelLocalPoint();
    expect(Math.abs(bevel[0])).toBeLessThanOrEqual(TILE.widthUnits / 2);
    expect(Math.abs(bevel[0])).toBeGreaterThan(TILE.facePlateWidthUnits / 2);
    expect(bevel[2]).toBeGreaterThan(TILE.thicknessUnits / 2 - TILE.bevelUnits);
  });

  it('projects every probe to a world point above the felt', () => {
    for (const probe of [
      { slot: 'hand' as const, uv: HERO_PROBE_UV.ink },
      { slot: 'pond' as const, uv: HERO_PROBE_UV.ink },
      { slot: 'wall' as const, uv: HERO_PROBE_UV.ink },
      { slot: 'back' as const, uv: HERO_PROBE_UV.centre },
      { slot: 'hand' as const, bevel: true },
    ]) {
      const world = probeWorldPoint(probe);
      expect(world[1]).toBeGreaterThan(0);
      expect(Number.isFinite(world[0])).toBe(true);
    }
    // The hand's probe is at the hand's own world position, not the pond's.
    const hand = probeWorldPoint({ slot: 'hand', uv: HERO_PROBE_UV.ink });
    const pond = probeWorldPoint({ slot: 'pond', uv: HERO_PROBE_UV.ink });
    expect(Math.abs(hand[2] - pond[2])).toBeGreaterThan(1);
  });

  it('rejects an unknown slot', () => {
    expect(() => probeWorldPoint({ slot: 'nope' as never, uv: HERO_PROBE_UV.ink })).toThrow();
  });

  it('agrees with boardLayout on the hand centre', () => {
    const hand = slot('hand');
    expect(slotWorldPoint(hand, [0, 0, 0])).toEqual(hand.pose.position);
    expect(hand.pose.position).toEqual(seatPoint(0, 0, hand.pose.position[2], hand.pose.position[1]));
  });
});

describe('the 8-texel parallax budget at every supported aspect', () => {
  const reports = heroParallaxAllAspects(CAMERA.supportedAspects);

  it('stays inside the budget at every aspect', () => {
    const table = reports
      .map(
        (report) =>
          `${report.aspect.toFixed(3)}: ${report.slots
            .map((entry) => `${entry.slot} ${entry.angleDeg.toFixed(2)}° → ${entry.texels.toFixed(2)} texels`)
            .join(', ')}`,
      )
      .join('\n');
    // Printed for the record; the assertion is what gates it.
    console.log(`3D-05 hero parallax bound (clamp ${POM_MAX_TEXELS} texels)\n${table}`);
    for (const report of reports) {
      expect(report.worst.texels, `aspect ${report.aspect}`).toBeLessThanOrEqual(POM_MAX_TEXELS);
      expect(report.worst.clamped).toBe(false);
    }
  });

  it('names the far-wall dora as the steepest face-up plate', () => {
    // The dora indicator sits on the far wall's top tier, further below the eye
    // relative to its distance than the near pond: ~44.5° against ~37°.
    expect(heroParallaxAt(16 / 9).worst.slot).toBe('wall');
    expect(heroParallaxAt(9 / 16).worst.slot).toBe('wall');
  });

  it('sees the pond near 40° and the hand near the readability gate', () => {
    const landscape = heroParallaxAt(16 / 9);
    const pond = landscape.slots.find((entry) => entry.slot === 'pond');
    const hand = landscape.slots.find((entry) => entry.slot === 'hand');
    if (!pond || !hand) throw new Error('missing hero slots');
    expect(pond.angleDeg).toBeGreaterThan(35);
    expect(pond.angleDeg).toBeLessThan(40);
    expect(hand.angleDeg).toBeGreaterThan(10);
    expect(hand.angleDeg).toBeLessThan(pond.angleDeg);
    // The per-tile ray is steeper than the view-axis gate, which is the number
    // boardLayout's readability check uses; it still keeps the hand readable.
    expect(hand.angleDeg).toBeLessThan(HAND.maxFaceToViewDeg + 10);
    // A face-down tile has no carving to displace.
    expect(landscape.slots.find((entry) => entry.slot === 'back')?.texels).toBe(0);
  });

  it('prints the strict board-wide worst case, the pose the hero set omits', () => {
    // The hero set has no far meld, which is the steepest face-up plate on a
    // real board. Compute it from the layout so the record is complete.
    let worst = { angle: 0, id: '' };
    for (const aspect of CAMERA.supportedAspects) {
      // From 3D-07 on, `frameForAspect` (§2.4) is the only projection source,
      // so the hero view and this board-wide check share one camera.
      const eye = frameForAspect(aspect, layout).eye;
      for (const tile of layout.tiles) {
        if (!tile.faceUp) continue;
        const normal = poseAxes(tile.pose)[2];
        const toEye = [
          eye[0] - tile.pose.position[0],
          eye[1] - tile.pose.position[1],
          eye[2] - tile.pose.position[2],
        ];
        const length = Math.hypot(toEye[0], toEye[1], toEye[2]);
        const cosine = Math.min(
          1,
          Math.max(
            -1,
            (normal[0] * toEye[0] + normal[1] * toEye[1] + normal[2] * toEye[2]) / length,
          ),
        );
        const angle = (Math.acos(cosine) * 180) / Math.PI;
        if (angle > worst.angle) worst = { angle, id: `${aspect.toFixed(2)} ${tile.id}` };
      }
    }
    const reading = parallaxTexels(worst.angle);
    const physical = parallaxTexels(worst.angle, { heightScale: 1 });
    const heroRigWorst = Math.max(
      ...CAMERA.supportedAspects.map((aspect) => heroParallaxAt(aspect).worst.texels),
    );
    console.log(
      `3D-05 strict board worst (frameForAspect): ${worst.id} at ${worst.angle.toFixed(2)}° → ` +
        `${reading.texels.toFixed(2)} texels at the live scale (physical ${physical.texels.toFixed(2)}); ` +
        `hero view worst (same frame): ${heroRigWorst.toFixed(2)}`,
    );
    // The live scale keeps even the steepest face well inside the bound; the
    // physical depth would cross it, which is what the shader's clamp covers.
    expect(reading.texels).toBeLessThan(POM_MAX_TEXELS);
    expect(reading.clamped).toBe(false);
    expect(physical.clamped).toBe(physical.texels > POM_MAX_TEXELS);
  });
});
