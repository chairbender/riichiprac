import { describe, expect, it } from 'vitest';
import {
  CENTRE_HALF_SIZE,
  HAND_APRON_DEPTH,
  HAND_CONCEALED_COUNT,
  HAND_DRAW_GAP,
  HAND_FACE_OFFSET,
  HAND_LEFT,
  HAND_MAX_WIDTH,
  HAND_TILE_GAP,
  ISO_DEPTH_SCALE,
  ISO_HEIGHT_SCALE,
  ISO_PITCH_DEGREES,
  SIDE_NORMAL,
  SIDE_TANGENT,
  TABLE_HALF_SIZE,
  TABLE_SIZE,
  TILE_BACK_SLIVER,
  TILE_FACE_LENGTH,
  TILE_FACE_WIDTH,
  TILE_THICKNESS,
  WALL_RING_DEPTH,
  centreCorners,
  fitProjection,
  flatTileFaces,
  handApronCorners,
  handSlots,
  project,
  projectBounds,
  seatBandCorners,
  seatBands,
  seatEdgeMidpoint,
  tableFootprintBounds,
  tablePlaneCorners,
  unproject,
  uprightTileFaces,
  wallRingCorners,
} from './iso';
import type { ProjectedBounds, TablePoint } from './iso';
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

describe('table footprint', () => {
  it('measures a projected point set into one bounding box', () => {
    const bounds = projectBounds([
      { x: -2, y: -2, z: 0 },
      { x: 2, y: -2, z: 0 },
      { x: 2, y: 2, z: 0 },
      { x: -2, y: 2, z: 0 },
    ]);

    expect(bounds.minX).toBe(-2);
    expect(bounds.maxX).toBe(2);
    // y = 2 is away from the human, i.e. up the screen (negative SVG y).
    expect(bounds.minY).toBeCloseTo(-2 * ISO_DEPTH_SCALE, 10);
    expect(bounds.maxY).toBeCloseTo(2 * ISO_DEPTH_SCALE, 10);
  });

  it('reserves a wall ring outside the play area on every side', () => {
    const play = projectBounds(tablePlaneCorners());
    const wall = projectBounds(wallRingCorners());

    expect(wall.minX).toBeCloseTo(-(TABLE_HALF_SIZE + WALL_RING_DEPTH), 10);
    expect(wall.maxX).toBeCloseTo(TABLE_HALF_SIZE + WALL_RING_DEPTH, 10);
    expect(wall.minY).toBeCloseTo(
      -(TABLE_HALF_SIZE + WALL_RING_DEPTH) * ISO_DEPTH_SCALE,
      10,
    );
    expect(wall.maxY).toBeCloseTo(
      (TABLE_HALF_SIZE + WALL_RING_DEPTH) * ISO_DEPTH_SCALE,
      10,
    );

    // Room on all four sides, not just the two the camera compresses.
    expect(wall.minX).toBeLessThan(play.minX);
    expect(wall.maxX).toBeGreaterThan(play.maxX);
    expect(wall.minY).toBeLessThan(play.minY);
    expect(wall.maxY).toBeGreaterThan(play.maxY);
  });

  it('reserves the hand apron only in front of the human', () => {
    const apron = projectBounds(handApronCorners());
    const wall = projectBounds(wallRingCorners());
    const outer = TABLE_HALF_SIZE + WALL_RING_DEPTH;

    // The apron starts at the wall's near edge and reaches the apron depth
    // towards the human (down the screen).
    expect(apron.minY).toBeCloseTo(wall.maxY, 10);
    expect(apron.maxY).toBeCloseTo(
      (outer + HAND_APRON_DEPTH) * ISO_DEPTH_SCALE,
      10,
    );
    expect(apron.minX).toBeCloseTo(wall.minX, 10);
    expect(apron.maxX).toBeCloseTo(wall.maxX, 10);
  });

  it('bounds the whole footprint, play area and reserved rails together', () => {
    const footprint = tableFootprintBounds();
    const outer = TABLE_HALF_SIZE + WALL_RING_DEPTH;

    expect(footprint.minX).toBeCloseTo(-outer, 10);
    expect(footprint.maxX).toBeCloseTo(outer, 10);
    expect(footprint.minY).toBeCloseTo(-outer * ISO_DEPTH_SCALE, 10);
    expect(footprint.maxY).toBeCloseTo(
      (outer + HAND_APRON_DEPTH) * ISO_DEPTH_SCALE,
      10,
    );

    // The apron makes the footprint reach further below the table than above
    // it, which is what keeps the table above the stage's centre line.
    expect(footprint.maxY + footprint.minY).toBeGreaterThan(0);
  });
});

describe('projection fitting', () => {
  const square: ProjectedBounds = {
    minX: -1,
    maxX: 1,
    minY: -1,
    maxY: 1,
  };

  it('centres the content in the viewport', () => {
    const fit = fitProjection({ width: 1000, height: 600 }, square, 0);
    const contentCentre = { x: 0, y: 0 };
    const onScreen = {
      x: fit.origin.x + contentCentre.x * fit.scale,
      y: fit.origin.y + contentCentre.y * fit.scale,
    };

    expect(onScreen.x).toBe(500);
    expect(onScreen.y).toBe(300);
  });

  it('scales to the tighter axis and leaves the other one letterboxed', () => {
    const fit = fitProjection({ width: 1000, height: 600 }, square, 0);

    // 600 is the shorter side, so the 2-by-2 square becomes 600 by 600.
    expect(fit.scale).toBe(300);
    expect(2 * fit.scale).toBe(600);
    expect(fit.origin.x).toBe(500);
    expect(fit.origin.y).toBe(300);
  });

  it('fits a wide, short viewport by height instead of width', () => {
    const fit = fitProjection({ width: 2000, height: 400 }, square, 20);

    expect(fit.scale).toBe(180); // (400 - 2 * 20) / 2
    expect(fit.origin.x).toBe(1000);
    expect(fit.origin.y).toBe(200);
  });

  it('keeps the whole content inside the padding on both axes', () => {
    const padding = 24;
    const viewport = { width: 1440, height: 900 };
    const bounds = tableFootprintBounds();
    const fit = fitProjection(viewport, bounds, padding);

    const corners = [
      { x: bounds.minX, y: bounds.minY },
      { x: bounds.maxX, y: bounds.minY },
      { x: bounds.maxX, y: bounds.maxY },
      { x: bounds.minX, y: bounds.maxY },
    ].map((point) => ({
      x: fit.origin.x + point.x * fit.scale,
      y: fit.origin.y + point.y * fit.scale,
    }));

    for (const corner of corners) {
      expect(corner.x).toBeGreaterThanOrEqual(padding - 1e-9);
      expect(corner.x).toBeLessThanOrEqual(viewport.width - padding + 1e-9);
      expect(corner.y).toBeGreaterThanOrEqual(padding - 1e-9);
      expect(corner.y).toBeLessThanOrEqual(viewport.height - padding + 1e-9);
    }
  });

  it('fits the reserved footprint rather than only the play area', () => {
    const viewport = { width: 1200, height: 800 };
    const padding = 20;
    const footprintFit = fitProjection(
      viewport,
      tableFootprintBounds(),
      padding,
    );
    const playFit = fitProjection(
      viewport,
      projectBounds(tablePlaneCorners()),
      padding,
    );

    expect(footprintFit.scale).toBeLessThan(playFit.scale);

    // The table centre sits above the stage's centre line to make room for the
    // apron, so a later hand never pushes the plane up.
    const tableCentreY = footprintFit.origin.y;
    expect(tableCentreY).toBeLessThan(viewport.height / 2);
  });

  it('never returns a negative scale for an empty or hidden stage', () => {
    const fit = fitProjection({ width: 0, height: 0 }, tableFootprintBounds());
    expect(fit.scale).toBe(0);
    expect(Number.isFinite(fit.origin.x)).toBe(true);
    expect(Number.isFinite(fit.origin.y)).toBe(true);
  });
});

/** Project a table point with the fitted scale left at one unit per tile. */
function unitProject(point: TablePoint) {
  return project(point);
}

describe('hand layout', () => {
  it('uses the same 3:4 face as the top-down tile artwork', () => {
    expect(TILE_FACE_WIDTH).toBe(0.75);
    expect(TILE_FACE_LENGTH).toBe(1);
    expect(TILE_FACE_WIDTH / TILE_FACE_LENGTH).toBeCloseTo(0.75, 10);
    // The body is thinner than the face is wide, so tiles read as slabs.
    expect(TILE_THICKNESS).toBeLessThan(TILE_FACE_WIDTH);
  });

  it('lays a full hand out from one fixed left edge', () => {
    const slots = handSlots('bottom', HAND_CONCEALED_COUNT, true);
    expect(slots).toHaveLength(HAND_CONCEALED_COUNT + 1);
    expect(slots.filter((slot) => !slot.isDraw)).toHaveLength(
      HAND_CONCEALED_COUNT,
    );
    expect(slots[slots.length - 1].isDraw).toBe(true);

    // The first face starts at the row's anchor, so a draw cannot shift it.
    expect(slots[0].centre.x - TILE_FACE_WIDTH / 2).toBeCloseTo(
      HAND_LEFT,
      10,
    );

    // Concealed tiles sit one hairline apart, edge to edge.
    for (let index = 1; index < HAND_CONCEALED_COUNT; index += 1) {
      expect(slots[index].centre.x - slots[index - 1].centre.x).toBeCloseTo(
        TILE_FACE_WIDTH + HAND_TILE_GAP,
        10,
      );
    }

    // The draw stands off the hand's right edge by the draw gap.
    const lastConcealed = slots[HAND_CONCEALED_COUNT - 1];
    const draw = slots[HAND_CONCEALED_COUNT];
    expect(
      draw.centre.x -
        TILE_FACE_WIDTH / 2 -
        (lastConcealed.centre.x + TILE_FACE_WIDTH / 2),
    ).toBeCloseTo(HAND_DRAW_GAP, 10);

    // A full hand is centred on the seat: equal margins either side.
    expect(draw.centre.x + TILE_FACE_WIDTH / 2).toBeCloseTo(-HAND_LEFT, 10);
    expect(HAND_MAX_WIDTH).toBeCloseTo(-HAND_LEFT * 2, 10);
  });

  it('never moves the tiles in hand when the draw arrives', () => {
    const withoutDraw = handSlots('bottom', HAND_CONCEALED_COUNT, false);
    const withDraw = handSlots('bottom', HAND_CONCEALED_COUNT, true);

    expect(withoutDraw).toHaveLength(HAND_CONCEALED_COUNT);
    expect(withDraw.slice(0, HAND_CONCEALED_COUNT)).toEqual(withoutDraw);
  });

  it('keeps the row anchored after a call, leaving room for melds', () => {
    const slots = handSlots('bottom', 10, true);
    expect(slots).toHaveLength(11);
    expect(slots[0].centre.x - TILE_FACE_WIDTH / 2).toBeCloseTo(
      HAND_LEFT,
      10,
    );

    const draw = slots[slots.length - 1];
    expect(draw.isDraw).toBe(true);
    // The drawn tile stops well short of the right edge a full hand reaches,
    // which is where the called melds will be laid out.
    expect(draw.centre.x + TILE_FACE_WIDTH / 2).toBeLessThan(
      -HAND_LEFT - TILE_FACE_WIDTH,
    );
  });

  it('puts the whole hand inside the reserved apron', () => {
    const slots = handSlots('bottom', HAND_CONCEALED_COUNT, true);
    const firstLeft = slots[0].centre.x - TILE_FACE_WIDTH / 2;
    const lastRight = slots[slots.length - 1].centre.x + TILE_FACE_WIDTH / 2;

    expect(firstLeft).toBeGreaterThan(-(TABLE_HALF_SIZE + WALL_RING_DEPTH));
    expect(lastRight).toBeLessThan(TABLE_HALF_SIZE + WALL_RING_DEPTH);
  });

  it('turns each seat’s hand to that seat’s edge', () => {
    for (const side of TABLE_SIDES) {
      const slots = handSlots(side, 1, false);
      expect(slots).toHaveLength(1);

      const [slot] = slots;
      const normal = SIDE_NORMAL[side];
      const tangent = SIDE_TANGENT[side];
      const along = HAND_LEFT + TILE_FACE_WIDTH / 2;

      expect(slot.rotation).toBe(SIDE_ROTATION[side]);
      expect(slot.centre.x).toBeCloseTo(
        normal.x * HAND_FACE_OFFSET + tangent.x * along,
        10,
      );
      expect(slot.centre.y).toBeCloseTo(
        normal.y * HAND_FACE_OFFSET + tangent.y * along,
        10,
      );
      expect(slot.centre.z).toBe(0);
    }
  });

  it('places the face plane inside the apron, not on its edge', () => {
    const apronFar = TABLE_HALF_SIZE + WALL_RING_DEPTH;
    expect(HAND_FACE_OFFSET).toBeGreaterThan(apronFar);
    expect(HAND_FACE_OFFSET).toBeLessThan(apronFar + HAND_APRON_DEPTH);
  });
});

describe('isometric tile faces', () => {
  it('stands a hand tile upright with its top edge visible', () => {
    const centre = { x: 0, y: -HAND_FACE_OFFSET, z: 0 };
    const faces = uprightTileFaces(centre, 0, unitProject);

    // The face is exactly one tile wide and one tile tall, foreshortened by
    // the camera pitch.
    expect(faces.face.across.x).toBeCloseTo(TILE_FACE_WIDTH, 10);
    expect(faces.face.across.y).toBeCloseTo(0, 10);
    expect(faces.face.down.x).toBeCloseTo(0, 10);
    expect(faces.face.down.y).toBeCloseTo(
      TILE_FACE_LENGTH * ISO_HEIGHT_SCALE,
      10,
    );

    // The artwork's top-left is the face's top-left.
    expect(faces.face.origin.x).toBeCloseTo(-TILE_FACE_WIDTH / 2, 10);
    expect(faces.face.origin.y).toBeCloseTo(
      -(-HAND_FACE_OFFSET * ISO_DEPTH_SCALE +
        TILE_FACE_LENGTH * ISO_HEIGHT_SCALE),
      10,
    );

    // The top edge reaches back across the thickness, compressed by depth.
    expect(faces.edge[0]).toEqual(faces.outline[0]);
    expect(faces.edge[2].y).toBeCloseTo(
      faces.outline[0].y - TILE_THICKNESS * ISO_DEPTH_SCALE,
      10,
    );
    expect(faces.edge[2].x).toBeCloseTo(
      faces.outline[0].x + TILE_FACE_WIDTH,
      10,
    );
  });

  it('makes the tile one connected body with a thin blue back sliver', () => {
    const faces = uprightTileFaces(
      { x: 0, y: -HAND_FACE_OFFSET, z: 0 },
      0,
      unitProject,
    );

    // The silhouette is the face and its top edge as a single outline, so
    // there is no seam across the tile's own top edge.
    for (const corner of faces.outline) {
      expect(faces.silhouette).toContain(corner);
    }
    expect(faces.silhouette).toContain(faces.edge[2]);
    expect(faces.silhouette).toContain(faces.edge[3]);

    // The back sliver starts on the silhouette's far top edge and reaches a
    // fixed fraction of the way down the top face.
    const back = faces.back;
    expect(back).toBeDefined();
    if (!back) return;

    expect(back[0]).toEqual(faces.edge[3]);
    expect(back[1]).toEqual(faces.edge[2]);
    expect(back[2].y).toBeGreaterThan(back[1].y);
    expect(back[2].y).toBeLessThan(faces.outline[1].y);
    expect(
      (back[2].y - back[1].y) /
        (faces.outline[1].y - back[1].y),
    ).toBeCloseTo(TILE_BACK_SLIVER, 10);
  });

  it('keeps the projected hand inside the apron band', () => {
    const apron = projectBounds(handApronCorners());

    for (const slot of handSlots('bottom', HAND_CONCEALED_COUNT, true)) {
      const faces = uprightTileFaces(
        slot.centre,
        slot.rotation,
        unitProject,
      );
      const points = [
        ...faces.outline,
        ...faces.edge,
        ...faces.silhouette,
        ...(faces.back ?? []),
      ];
      for (const point of points) {
        expect(point.y).toBeGreaterThanOrEqual(apron.minY - 1e-9);
        expect(point.y).toBeLessThanOrEqual(apron.maxY + 1e-9);
      }
    }
  });

  it('turns a standing tile’s face to its seat', () => {
    for (const side of TABLE_SIDES) {
      const [slot] = handSlots(side, 1, false);
      const faces = uprightTileFaces(
        slot.centre,
        slot.rotation,
        unitProject,
      );
      const length = Math.hypot(
        faces.face.across.x,
        faces.face.across.y,
      );
      const across = {
        x: faces.face.across.x / length,
        y: faces.face.across.y / length,
      };
      const tangent = screenDirection(SIDE_TANGENT[side]);

      expect(across.x).toBeCloseTo(tangent.x, 10);
      expect(across.y).toBeCloseTo(tangent.y, 10);
    }
  });

  it('lays a flat tile face-up, with its thickness towards the player', () => {
    const centre = { x: 0, y: -4, z: 0 };
    const faces = flatTileFaces(centre, 0, unitProject);

    // The artwork's top sits on the far edge, so it reads upright to the player.
    expect(faces.face.origin.x).toBeCloseTo(-TILE_FACE_WIDTH / 2, 10);
    expect(faces.face.origin.y).toBeCloseTo(
      -(
        (centre.y + TILE_FACE_LENGTH / 2) * ISO_DEPTH_SCALE +
        TILE_THICKNESS * ISO_HEIGHT_SCALE
      ),
      10,
    );
    expect(faces.face.across.x).toBeCloseTo(TILE_FACE_WIDTH, 10);
    expect(faces.face.across.y).toBeCloseTo(0, 10);
    // Top (far) to bottom (near) runs down the screen.
    expect(faces.face.down.x).toBeCloseTo(0, 10);
    expect(faces.face.down.y).toBeCloseTo(
      TILE_FACE_LENGTH * ISO_DEPTH_SCALE,
      10,
    );

    // The front side is a band of the tile's thickness below the near edge.
    expect(faces.edge[0]).toEqual(faces.outline[3]);
    expect(faces.edge[0].y).toBeCloseTo(
      -(-4.5 * ISO_DEPTH_SCALE + TILE_THICKNESS * ISO_HEIGHT_SCALE),
      10,
    );
    expect(faces.edge[2].y).toBeCloseTo(
      faces.edge[0].y + TILE_THICKNESS * ISO_HEIGHT_SCALE,
      10,
    );

    // A face-up tile's back is against the table, so only the body and its
    // front side are visible, again as one connected outline.
    expect(faces.back).toBeUndefined();
    expect(faces.silhouette).toContain(faces.edge[2]);
    expect(faces.silhouette).toContain(faces.edge[3]);
    expect(faces.silhouette).toContain(faces.outline[0]);
  });

  it('turns a flat tile sideways for Riichi and called tiles', () => {
    const centre = { x: 0, y: -4, z: 0 };
    const upright = flatTileFaces(centre, 0, unitProject);
    const sideways = flatTileFaces(centre, 0, unitProject, true);

    // A quarter turn swaps the footprint: the face is now one long across the
    // player's view and three quarters deep.
    expect(upright.face.across.x).toBeCloseTo(TILE_FACE_WIDTH, 10);
    expect(sideways.face.across.y).toBeCloseTo(
      TILE_FACE_WIDTH * ISO_DEPTH_SCALE,
      10,
    );
    // The art's top points to the player's right, the top-down convention.
    expect(sideways.face.down.x).toBeCloseTo(-TILE_FACE_LENGTH, 10);
    expect(sideways.face.down.y).toBeCloseTo(0, 10);
  });
});

