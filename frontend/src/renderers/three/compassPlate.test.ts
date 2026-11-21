/**
 * The physical compass plate (3D-09).
 *
 * The square is table furniture, so its numbers are assertions like every other
 * object on the felt: its footprint is the committed compass well, its top is a
 * few millimetres proud of the felt (below every tile), it never meets a tile on
 * a full board, and it costs exactly one draw.
 */

import { describe, expect, it } from 'vitest';
import { POND, TILE } from '../layoutConstants';
import { boardFixture } from './boardFixture';
import { layoutBoard, orientedBox, orientedBoxesIntersect } from './boardLayout';
import {
  COMPASS_PLATE,
  compassPlateShape,
  createCompassPlate,
} from './compassPlate';

function meshBox(plate: ReturnType<typeof createCompassPlate>) {
  plate.mesh.geometry.computeBoundingBox();
  const box = plate.mesh.geometry.boundingBox;
  if (!box) throw new Error('the plate has no bounding box');
  return box;
}

describe('the compass plate', () => {
  it('is a rounded square the size of the well, lying flat on the felt', () => {
    // The outline is centred and exactly the well in both directions.
    const half = COMPASS_PLATE.sizeUnits / 2;
    const points = compassPlateShape().getPoints(24);
    expect(Math.min(...points.map((point) => point.x))).toBeCloseTo(-half, 9);
    expect(Math.max(...points.map((point) => point.x))).toBeCloseTo(half, 9);
    expect(Math.min(...points.map((point) => point.y))).toBeCloseTo(-half, 9);
    expect(Math.max(...points.map((point) => point.y))).toBeCloseTo(half, 9);
    // The corners are rounded: the outline never reaches the square corner.
    expect(
      points.some(
        (point) =>
          Math.abs(point.x) > half - 1e-9 && Math.abs(point.y) > half - 1e-9,
      ),
    ).toBe(false);

    const plate = createCompassPlate();
    const box = meshBox(plate);

    // Level: the bottom sits on y = 0 and the top is the slab plus its chamfer.
    expect(box.min.y).toBeCloseTo(0, 9);
    expect(box.max.y).toBeCloseTo(
      COMPASS_PLATE.thicknessUnits + 2 * COMPASS_PLATE.bevelUnits,
      6,
    );
    // A real square in perspective: centred on the table's origin, no lean.
    expect(box.min.x + box.max.x).toBeCloseTo(0, 9);
    expect(box.min.z + box.max.z).toBeCloseTo(0, 9);
    expect(box.max.x).toBeCloseTo(half + COMPASS_PLATE.bevelUnits, 6);
    expect(box.max.z).toBeCloseTo(box.max.x, 6);

    // Below every tile, and the physical edge touches the innermost discard row
    // (within a hair of felt) on all four sides.
    expect(box.max.y).toBeLessThan(TILE.thicknessUnits);
    const pondInnerEdge =
      POND.desktopRowRadiiUnits[POND.rows - 1] - TILE.heightUnits / 2;
    expect(box.max.x).toBeLessThan(pondInnerEdge);
    expect(pondInnerEdge - box.max.x).toBeGreaterThan(0);
    expect(pondInnerEdge - box.max.x).toBeLessThan(0.01);
    plate.dispose();
  });

  it('is one mesh: the square costs one draw', () => {
    const plate = createCompassPlate();
    expect(plate.mesh.isMesh).toBe(true);
    expect(plate.mesh.name).toBe('compass-plate');
    expect(plate.mesh.children).toHaveLength(0);
    expect(plate.mesh.material).not.toBeNull();
    plate.dispose();
  });

  it('never meets a tile on a full board', () => {
    const plate = createCompassPlate();
    const box = meshBox(plate);
    const plateBox = {
      centre: [
        (box.min.x + box.max.x) / 2,
        (box.min.y + box.max.y) / 2,
        (box.min.z + box.max.z) / 2,
      ] as const,
      axes: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ] as const,
      halfExtents: [
        (box.max.x - box.min.x) / 2,
        (box.max.y - box.min.y) / 2,
        (box.max.z - box.min.z) / 2,
      ] as const,
    };
    for (const layout of [
      layoutBoard(boardFixture()),
      layoutBoard(
        boardFixture({
          humanSeat: 2,
          riverCounts: [22, 22, 22, 22],
          meldCounts: [4, 4, 4, 4],
          kan: true,
        }),
      ),
    ]) {
      for (const tile of layout.tiles) {
        expect(
          orientedBoxesIntersect(plateBox, orientedBox(tile.pose)),
          `${tile.id} x compass plate`,
        ).toBe(false);
      }
    }
    plate.dispose();
  });

  it('is deterministic geometry', () => {
    const first = createCompassPlate();
    const second = createCompassPlate();
    expect(Array.from(first.mesh.geometry.attributes.position.array)).toEqual(
      Array.from(second.mesh.geometry.attributes.position.array),
    );
    first.dispose();
    second.dispose();
  });
});
