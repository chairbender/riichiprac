import { describe, expect, it } from 'vitest';
import {
  CENTRE_HALF_SIZE,
  ISO_DEPTH_SCALE,
  ISO_HEIGHT_SCALE,
  ISO_PITCH_DEGREES,
  SIDE_NORMAL,
  SIDE_TANGENT,
  TABLE_HALF_SIZE,
  TABLE_SIZE,
  centreCorners,
  project,
  seatBandCorners,
  seatBands,
  seatEdgeMidpoint,
  tablePlaneCorners,
  unproject,
} from './iso';
import type { TablePoint } from './iso';
import { SIDE_ROTATION, TABLE_SIDES } from './seatOrder';

/** Screen direction of a table-plane vector, normalised so lengths compare. */
function screenDirection(vector: { x: number; y: number }) {
  const projected = project({ x: vector.x, y: vector.y, z: 0 });
  const length = Math.hypot(projected.x, projected.y);
  return { x: projected.x / length, y: projected.y / length };
}

describe('isometric projection', () => {
  it('uses a fixed 30° camera, giving a 2:1 table', () => {
    expect(ISO_PITCH_DEGREES).toBe(30);
    expect(ISO_DEPTH_SCALE).toBeCloseTo(0.5, 10);
    expect(ISO_HEIGHT_SCALE).toBeCloseTo(Math.sqrt(3) / 2, 10);
  });

  it('puts the table centre at the screen origin', () => {
    const centre = project({ x: 0, y: 0, z: 0 });
    expect(centre.x).toBe(0);
    expect(centre.y).toBeCloseTo(0, 10);
  });

  it('projects edge midpoints to the four screen directions', () => {
    const bottom = project(seatEdgeMidpoint('bottom'));
    expect(bottom.x).toBe(0);
    expect(bottom.y).toBeCloseTo(TABLE_HALF_SIZE * ISO_DEPTH_SCALE, 10);

    const top = project(seatEdgeMidpoint('top'));
    expect(top.x).toBe(0);
    expect(top.y).toBeCloseTo(-TABLE_HALF_SIZE * ISO_DEPTH_SCALE, 10);

    const right = project(seatEdgeMidpoint('right'));
    expect(right.x).toBe(TABLE_HALF_SIZE);
    expect(right.y).toBeCloseTo(0, 10);

    const left = project(seatEdgeMidpoint('left'));
    expect(left.x).toBe(-TABLE_HALF_SIZE);
    expect(left.y).toBeCloseTo(0, 10);
  });

  it('draws the table twice as wide as it is deep', () => {
    const corners = tablePlaneCorners().map(project);
    const width = Math.max(...corners.map((c) => c.x)) -
      Math.min(...corners.map((c) => c.x));
    const depth = Math.max(...corners.map((c) => c.y)) -
      Math.min(...corners.map((c) => c.y));

    expect(width).toBeCloseTo(TABLE_SIZE, 10);
    expect(depth).toBeCloseTo(TABLE_SIZE * ISO_DEPTH_SCALE, 10);
    expect(width / depth).toBeCloseTo(2, 10);
  });

  it('lifts a raised point up the screen without moving it sideways', () => {
    const raised = project({ x: 2, y: -3, z: 1 });
    const grounded = project({ x: 2, y: -3, z: 0 });

    expect(raised.x).toBe(grounded.x);
    expect(raised.y).toBeCloseTo(grounded.y - ISO_HEIGHT_SCALE, 10);
  });

  it('projects the near edge below the centre and the far edge above it', () => {
    const near = project({ x: 0, y: -TABLE_HALF_SIZE, z: 0 });
    const far = project({ x: 0, y: TABLE_HALF_SIZE, z: 0 });

    // SVG y grows downwards, so "below the centre" is a positive screen y.
    expect(near.y).toBeGreaterThan(0);
    expect(far.y).toBeLessThan(0);
  });
});

describe('isometric unprojection', () => {
  it('round-trips points on the table plane', () => {
    const points: TablePoint[] = [
      { x: 0, y: 0, z: 0 },
      { x: TABLE_HALF_SIZE, y: -TABLE_HALF_SIZE, z: 0 },
      { x: -TABLE_HALF_SIZE, y: TABLE_HALF_SIZE, z: 0 },
      { x: 3.25, y: -1.5, z: 0 },
      { x: -2, y: 4, z: 0 },
    ];

    for (const point of points) {
      const roundTrip = unproject(project(point));
      expect(roundTrip.x).toBeCloseTo(point.x, 10);
      expect(roundTrip.y).toBeCloseTo(point.y, 10);
      expect(roundTrip.z).toBe(point.z);
    }
  });

  it('round-trips points at a known height', () => {
    const points: TablePoint[] = [
      { x: 1, y: 2, z: 1.5 },
      { x: -4.5, y: 0.25, z: 0.75 },
      { x: 0, y: -TABLE_HALF_SIZE, z: 2 },
    ];

    for (const point of points) {
      const roundTrip = unproject(project(point), point.z);
      expect(roundTrip.x).toBeCloseTo(point.x, 10);
      expect(roundTrip.y).toBeCloseTo(point.y, 10);
      expect(roundTrip.z).toBe(point.z);
    }
  });

  it('round-trips a screen point through the ground plane', () => {
    const screen = { x: 2, y: -2.3660254037844384 };
    const ground = unproject(screen, 0);
    const back = project(ground);

    expect(ground.z).toBe(0);
    expect(back.x).toBeCloseTo(screen.x, 10);
    expect(back.y).toBeCloseTo(screen.y, 10);
  });
});

describe('table geometry', () => {
  it('reserves a six-by-six centre square for the compass', () => {
    expect(CENTRE_HALF_SIZE).toBe(3);
    expect(centreCorners()).toEqual([
      { x: -3, y: -3, z: 0 },
      { x: 3, y: -3, z: 0 },
      { x: 3, y: 3, z: 0 },
      { x: -3, y: 3, z: 0 },
    ]);
  });

  it('lays each seat band along its own edge, mitering at the corners', () => {
    expect(seatBandCorners('bottom')).toEqual([
      { x: -6, y: -6, z: 0 },
      { x: 6, y: -6, z: 0 },
      { x: 3, y: -3, z: 0 },
      { x: -3, y: -3, z: 0 },
    ]);
    expect(seatBandCorners('right')).toEqual([
      { x: 6, y: -6, z: 0 },
      { x: 6, y: 6, z: 0 },
      { x: 3, y: 3, z: 0 },
      { x: 3, y: -3, z: 0 },
    ]);
    expect(seatBandCorners('top')).toEqual([
      { x: 6, y: 6, z: 0 },
      { x: -6, y: 6, z: 0 },
      { x: -3, y: 3, z: 0 },
      { x: 3, y: 3, z: 0 },
    ]);
    expect(seatBandCorners('left')).toEqual([
      { x: -6, y: 6, z: 0 },
      { x: -6, y: -6, z: 0 },
      { x: -3, y: -3, z: 0 },
      { x: -3, y: 3, z: 0 },
    ]);
  });

  it('gives every seat a band on the plane, in table turn order', () => {
    const bands = seatBands();

    expect(Object.keys(bands)).toEqual(
      expect.arrayContaining([...TABLE_SIDES]),
    );
    for (const side of TABLE_SIDES) {
      expect(bands[side]).toHaveLength(4);
      for (const corner of bands[side]) {
        expect(corner.z).toBe(0);
      }
    }
  });

  it('points each side its own way on screen, with the human at the bottom', () => {
    expect(screenDirection(SIDE_NORMAL.bottom).y).toBeGreaterThan(0);
    expect(screenDirection(SIDE_NORMAL.top).y).toBeLessThan(0);
    expect(screenDirection(SIDE_NORMAL.right).x).toBeGreaterThan(0);
    expect(screenDirection(SIDE_NORMAL.left).x).toBeLessThan(0);
  });

  it('agrees with the seat rotations the top-down table already uses', () => {
    for (const side of TABLE_SIDES) {
      const rotation = (SIDE_ROTATION[side] * Math.PI) / 180;
      // SVG rotates clockwise in a y-down space: (1, 0) turns to (cos, sin).
      const rotated = { x: Math.cos(rotation), y: Math.sin(rotation) };
      const tangent = screenDirection(SIDE_TANGENT[side]);

      expect(tangent.x).toBeCloseTo(rotated.x, 10);
      expect(tangent.y).toBeCloseTo(rotated.y, 10);
    }
  });
});
