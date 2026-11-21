import { describe, expect, it } from 'vitest';
import type { Seat, TableSnapshot } from '../contract';
import {
  CAMERA,
  COMPASS_PLATE,
  DORA,
  HAND,
  MELD,
  POND,
  STICK,
  TABLE,
  TILE,
  WALL,
} from '../layoutConstants';
import {
  committedShiftNdcY,
  frameForAspect,
  handTileToEyeDeg,
  handFaceToViewDeg,
  handRadius,
  layoutBoard,
  orientedBox,
  orientedBoxCorners,
  orientedBoxesIntersect,
  poseAxes,
  projectPoint,
  projectToPixels,
  referenceFrame,
  seatBasis,
  seatPoint,
  seatYawDeg,
  wallRunRadius,
  wallTierHeightUnits,
  type BoardTile,
} from './boardLayout';
import { boardFixture } from './boardFixture';
import { decodeWallSlot, isDeadWallSlot, liveWallSlots } from '../wall';

const fixture = boardFixture();
const board = layoutBoard(fixture);

/** A stable key for the multiset comparison: seat, zone, slot and face. */
function key(tile: {
  readonly seat: Seat | null;
  readonly zone: string;
  readonly slot: number;
  readonly face: string;
}): string {
  return `${tile.seat ?? 'table'}/${tile.zone}/${tile.slot}/${tile.face}`;
}

function snapshotForeground(snapshot: TableSnapshot): string[] {
  const keys: string[] = [];
  for (const seat of snapshot.seats) {
    for (const tile of seat.concealed) keys.push(key({ ...tile, seat: seat.seat }));
    if (seat.draw) keys.push(key({ ...seat.draw, seat: seat.seat }));
    for (const meld of seat.melds) {
      for (const tile of meld.tiles) {
        keys.push(key({ ...tile, seat: seat.seat }));
      }
    }
    for (const tile of seat.river) keys.push(key({ ...tile, seat: seat.seat }));
  }
  for (const tile of snapshot.dora) keys.push(key({ ...tile, seat: null }));
  return keys.sort();
}

/** The seat's outward unit vector, and a world point's distance along it. */
const outwardOf = (seat: Seat): readonly [number, number, number] =>
  seatPoint(seat, 0, 1, 0);

const radialUnits = (
  seat: Seat,
  position: readonly [number, number, number],
): number => {
  const outward = outwardOf(seat);
  return position[0] * outward[0] + position[2] * outward[2];
};

const humanHand = (source: typeof board): BoardTile[] =>
  source.foreground.filter(
    (tile) =>
      tile.seat === fixture.humanSeat &&
      (tile.zone === 'hand' || tile.zone === 'draw'),
  );

const riverOf = (
  source: typeof board,
  seat: Seat,
): BoardTile[] =>
  source.foreground.filter((tile) => tile.seat === seat && tile.zone === 'river');

describe('3D board layout: every zone is produced', () => {
  it('draws the dead wall and the live wall left by tiles_remaining', () => {
    // The default fixture publishes 69 live tiles and 14 dead ones.
    expect(fixture.compass.tilesRemaining).toBe(69);
    expect(fixture.wall).toHaveLength(WALL.deadWallTiles + 69);
    expect(board.wall).toHaveLength(
      WALL.deadWallTiles + 69 - fixture.dora.length,
    );
    for (const tile of board.wall) {
      expect(tile.zone).toBe('wall');
      expect(tile.faceUp).toBe(false);
      expect(tile.pose.tiltDeg).toBe(90);
    }
  });

  it('draws 13 concealed tiles and a separate draw for every seat', () => {
    for (const seat of [0, 1, 2, 3] as const) {
      const hand = board.foreground.filter(
        (tile) => tile.seat === seat && tile.zone === 'hand',
      );
      const draw = board.foreground.filter(
        (tile) => tile.seat === seat && tile.zone === 'draw',
      );
      // Every fixture seat opens one meld, so 13 - 3 = 10 concealed tiles.
      expect(hand).toHaveLength(10);
      expect(draw).toHaveLength(1);
    }
  });

  it('draws every river, meld and dora tile', () => {
    const rivers = board.foreground.filter((tile) => tile.zone === 'river');
    const expectedRiver = [22, 18, 14, 10].reduce((sum, count) => sum + count, 0);
    expect(rivers).toHaveLength(expectedRiver);
    expect(
      board.foreground.filter((tile) => tile.zone === 'meld'),
    ).toHaveLength(4 * 3);
    expect(
      board.foreground.filter((tile) => tile.zone === 'dora'),
    ).toHaveLength(fixture.dora.length);
  });

  it('keeps the foreground multiset exactly equal to the snapshot', () => {
    expect(board.foreground.map(key).sort()).toEqual(
      snapshotForeground(fixture),
    );
  });

  it('is deterministic', () => {
    const again = layoutBoard(fixture);
    expect(JSON.stringify(again)).toBe(JSON.stringify(board));
  });
});

describe('3D board layout: the hand', () => {
  it('reclines the human hand 40° and leaves opponents upright and face-down', () => {
    for (const tile of humanHand(board)) {
      expect(tile.faceUp).toBe(true);
      expect(tile.pose.tiltDeg).toBe(-HAND.reclineDeg);
      const normal = poseAxes(tile.pose)[2];
      // The face normal is 40° above horizontal: tilted up from the radial axis.
      expect(Math.asin(normal[1]) * (180 / Math.PI)).toBeCloseTo(
        HAND.reclineDeg,
        9,
      );
    }
    for (const seat of [1, 2, 3] as const) {
      const hand = board.foreground.filter(
        (tile) => tile.seat === seat && tile.zone === 'hand',
      );
      expect(hand).toHaveLength(10);
      for (const tile of hand) {
        expect(tile.faceUp).toBe(false);
        expect(tile.pose.tiltDeg).toBe(0);
        // Upright: the face normal is horizontal, pointing out at the seat.
        expect(poseAxes(tile.pose)[2][1]).toBeCloseTo(0, 12);
      }
    }
  });

  it('stands the hand on its far bottom edge at the seat\u2019s hand radius', () => {
    // The bottom far corner sits on the felt at the seat's own radius: the
    // human is an end seat, so that is HAND.endSeatRadiusUnits.
    for (const tile of humanHand(board)) {
      const [, ay, az] = poseAxes(tile.pose);
      const half = 0.5;
      const farBottom: [number, number, number] = [
        tile.pose.position[0] - ay[0] * half - az[0] * (TILE.thicknessUnits / 2),
        tile.pose.position[1] - ay[1] * half - az[1] * (TILE.thicknessUnits / 2),
        tile.pose.position[2] - ay[2] * half - az[2] * (TILE.thicknessUnits / 2),
      ];
      const radius = radialUnits(fixture.humanSeat, farBottom);
      expect(radius).toBeCloseTo(handRadius(fixture.humanSeat, fixture.humanSeat), 9);
      expect(radius).toBeCloseTo(
        HAND.backRadiusUnits - TILE.thicknessUnits,
        9,
      );
      expect(farBottom[1]).toBeCloseTo(0, 9);
    }
  });

  it('separates the drawn tile by exactly the tsumogiri gap', () => {
    const thirteen = layoutBoard(
      boardFixture({ meldCounts: [0, 0, 0, 0] }),
    );
    const hand = thirteen.foreground
      .filter(
        (tile) =>
          tile.seat === 0 && tile.zone === 'hand' && !tile.sideways,
      )
      .sort((left, right) => left.slot - right.slot);
    const draw = thirteen.foreground.find(
      (tile) => tile.seat === 0 && tile.zone === 'draw',
    );
    expect(hand).toHaveLength(HAND.concealedCount);
    expect(draw).toBeDefined();

    const maxW = Math.max(...hand.map((tile) => tile.pose.position[0]));
    const gap =
      draw!.pose.position[0] - maxW - TILE.widthUnits / 2 - TILE.widthUnits / 2;
    expect(gap).toBeCloseTo(HAND.drawGapUnits, 9);
    // The committed `drawOffsetUnits` is this 13-tile layout, to the last digit.
    expect(draw!.pose.position[0]).toBeCloseTo(HAND.drawOffsetUnits, 9);
  });

  it('follows a shortened hand with melds', () => {
    const withMelds = layoutBoard(
      boardFixture({ meldCounts: [2, 0, 0, 0] }),
    );
    const hand = withMelds.foreground.filter(
      (tile) => tile.seat === 0 && tile.zone === 'hand',
    );
    const draw = withMelds.foreground.find(
      (tile) => tile.seat === 0 && tile.zone === 'draw',
    );
    expect(hand).toHaveLength(13 - 6);
    const maxW = Math.max(...hand.map((tile) => tile.pose.position[0]));
    expect(draw!.pose.position[0] - maxW).toBeCloseTo(
      TILE.widthUnits / 2 + HAND.drawGapUnits + TILE.widthUnits / 2,
      9,
    );
  });
});

describe('3D board layout: the pond', () => {
  it('fills from the far row toward the player, then the overflow', () => {
    const river = riverOf(board, 0).sort((left, right) => left.slot - right.slot);
    const radius = (tile: BoardTile): number =>
      radialUnits(0, tile.pose.position);

    // Discards 0-5 land in the far row (radius 2.7886), 6-11 in the middle
    // row, 12-17 in the near row.
    expect(radius(river[0])).toBeCloseTo(POND.rowRadiiUnits[2], 9);
    expect(radius(river[5])).toBeCloseTo(POND.rowRadiiUnits[2], 9);
    expect(radius(river[6])).toBeCloseTo(POND.rowRadiiUnits[1], 9);
    expect(radius(river[11])).toBeCloseTo(POND.rowRadiiUnits[1], 9);
    expect(radius(river[12])).toBeCloseTo(POND.rowRadiiUnits[0], 9);
    expect(radius(river[17])).toBeCloseTo(POND.rowRadiiUnits[0], 9);
    // The overflow cells extend the nearest row, past column 5.
    expect(radius(river[18])).toBeCloseTo(POND.rowRadiiUnits[POND.overflowRow], 9);
    expect(radius(river[21])).toBeCloseTo(POND.rowRadiiUnits[POND.overflowRow], 9);
    expect(river[18].pose.position[0]).toBeGreaterThan(
      river[17].pose.position[0] + POND.columnPitchUnits * 0.9,
    );
    // An all-upright row's first tile sits on the reference's centre offset.
    expect(river[0].pose.position[0]).toBeCloseTo(
      -POND.columnCentreOffsetUnits,
      9,
    );
    expect(river[1].pose.position[0] - river[0].pose.position[0]).toBeCloseTo(
      POND.columnPitchUnits,
      9,
    );
  });

  it('turns a riichi discard sideways and widens its row slot', () => {
    const river = riverOf(board, 0).sort((left, right) => left.slot - right.slot);
    const declared = river[5];
    expect(declared.sideways).toBe(true);
    expect(declared.pose.rollDeg).toBe(-90);
    const axes = poseAxes(declared.pose);
    // The tile's long axis lies along the row (its local +Y turned horizontal).
    const longAxis = axes[1];
    expect(Math.abs(longAxis[1])).toBeLessThan(1e-9);
    // The turned tile is set one column gap from its neighbour's far edge.
    const gap =
      declared.pose.position[0] -
      TILE.heightUnits / 2 -
      (river[4].pose.position[0] + TILE.widthUnits / 2);
    expect(gap).toBeCloseTo(POND.columnGapUnits, 9);
  });
});

describe('3D board layout: melds', () => {
  it('lays the melds to the right of the draw, called tile sideways', () => {
    const meld = board.foreground
      .filter((tile) => tile.seat === 0 && tile.zone === 'meld')
      .sort((left, right) => left.slot - right.slot);
    const draw = board.foreground.find(
      (tile) => tile.seat === 0 && tile.zone === 'draw',
    )!;
    expect(meld).toHaveLength(3);
    // The first meld starts one deliberate 4.2 mm clearance from the draw.
    const meldLeft = meld[0].pose.position[0] - TILE.widthUnits / 2;
    const drawRight = draw.pose.position[0] + TILE.widthUnits / 2;
    expect(meldLeft - drawRight).toBeCloseTo(MELD.rowClearanceUnits, 9);
    expect(meld[1].sideways).toBe(true);
    expect(meld[1].pose.rollDeg).toBe(-90);
    expect(meld[2].pose.position[0]).toBeGreaterThan(meld[1].pose.position[0]);
    for (const tile of meld) {
      // Lying face up, its outer edge flush with the hand's front face: the
      // human's melds sit one tile height in from the hand radius.
      expect(tile.pose.tiltDeg).toBe(-90);
      expect(tile.faceUp).toBe(true);
      expect(radialUnits(0, tile.pose.position)).toBeCloseTo(
        handRadius(0, fixture.humanSeat) - TILE.heightUnits / 2,
        9,
      );
    }
    // An upright opponent hand reaches half a tile thickness past its radius, so
    // that seat's melds stay on the hand radius.
    const opponentMeld = board.foreground.find(
      (tile) => tile.seat === 1 && tile.zone === 'meld',
    )!;
    expect(radialUnits(1, opponentMeld.pose.position)).toBeCloseTo(
      handRadius(1, fixture.humanSeat),
      9,
    );
  });

  it('shifts the concealed hand left as melds take the row’s right end', () => {
    const melded = layoutBoard(boardFixture({ meldCounts: [1, 0, 0, 0] }));
    const plain = layoutBoard(boardFixture({ meldCounts: [0, 0, 0, 0] }));
    const handLeft = (source: typeof board): number =>
      Math.min(
        ...source.foreground
          .filter((tile) => tile.seat === 0 && tile.zone === 'hand')
          .map((tile) => tile.pose.position[0] - TILE.widthUnits / 2),
      );
    expect(handLeft(melded)).toBeLessThan(handLeft(plain) - 0.1);
  });

  it('keeps every seat’s melds inside the meld-free board’s extents', () => {
    const plain = layoutBoard(boardFixture({ meldCounts: [0, 0, 0, 0] }));
    const melded = layoutBoard(
      boardFixture({ meldCounts: [4, 4, 4, 4], kan: true }),
    );
    const corners = (source: typeof board) =>
      source.tiles.flatMap((tile) =>
        orientedBoxCorners(orientedBox(tile.pose)),
      );
    const envelope = corners(plain);
    const minX = Math.min(...envelope.map((p) => p[0]));
    const maxX = Math.max(...envelope.map((p) => p[0]));
    const minZ = Math.min(...envelope.map((p) => p[2]));
    const maxZ = Math.max(...envelope.map((p) => p[2]));
    for (const seat of [0, 1, 2, 3] as const) {
      const melds = melded.foreground.filter(
        (entry) => entry.seat === seat && entry.zone === 'meld',
      );
      expect(melds.length).toBeGreaterThan(0);
      for (const tile of melds) {
        for (const corner of orientedBoxCorners(orientedBox(tile.pose))) {
          expect(corner[0]).toBeGreaterThanOrEqual(minX - 1e-9);
          expect(corner[0]).toBeLessThanOrEqual(maxX + 1e-9);
          expect(corner[2]).toBeGreaterThanOrEqual(minZ - 1e-9);
          expect(corner[2]).toBeLessThanOrEqual(maxZ + 1e-9);
        }
      }
    }
  });

  it('keeps four melds non-overlapping and on the mat', () => {
    const four = layoutBoard(
      boardFixture({
        meldCounts: [4, 0, 0, 0],
        kan: true,
      }),
    );
    const melds = four.foreground.filter(
      (tile) => tile.seat === 0 && tile.zone === 'meld',
    );
    // The fixture makes the first meld a kan and the rest three-tile pons.
    expect(melds).toHaveLength(4 + 3 * 3);
    for (const tile of melds) {
      for (const corner of orientedBoxCorners(orientedBox(tile.pose))) {
        expect(Math.abs(corner[0])).toBeLessThanOrEqual(
          TABLE.matSizeUnits / 2 + 0.5,
        );
        expect(Math.abs(corner[2])).toBeLessThanOrEqual(
          TABLE.matSizeUnits / 2 + 0.5,
        );
      }
    }
    expect(noIntersections(four)).toEqual([]);
  });
});

describe('3D board layout: wall, dora and sticks', () => {
  it('places the intact dead wall on the far run, shifted clear of the live wall', () => {
    const farSeat = ((fixture.humanSeat + 2) % 4) as Seat;
    const dead = board.wall.filter((tile) => isDeadWallSlot(tile.slot, fixture.humanSeat));
    expect(dead).toHaveLength(WALL.deadWallTiles - fixture.dora.length);
    const right = seatPoint(farSeat, 1, 0, 0);
    const w = (tile: BoardTile): number =>
      tile.pose.position[0] * right[0] + tile.pose.position[2] * right[2];

    const stacks = new Set(
      dead.map((tile) => Math.floor((tile.slot % WALL.slotsPerRun) / WALL.tiers)),
    );
    expect(stacks.size).toBe(WALL.deadWallStacks);
    for (const stack of stacks) {
      expect(stack).toBeGreaterThanOrEqual(WALL.deadWallStartStack);
    }
    // Every dead tile is at the far run's radius and shifted by the committed
    // break, so the block is visibly separated from the live wall.
    for (const tile of dead) {
      expect(radialUnits(farSeat, tile.pose.position)).toBeCloseTo(
        wallRunRadius(farSeat, fixture.humanSeat),
        9,
      );
      const stack = Math.floor((tile.slot % WALL.slotsPerRun) / WALL.tiers);
      expect(w(tile)).toBeCloseTo(
        (stack - (WALL.stacksPerRun - 1) / 2) * WALL.stackPitchUnits +
          WALL.deadWallGapUnits,
        9,
      );
    }

    // The nearest live wall tile is at least the committed felt break away.
    const live = board.wall.filter(
      (tile) => !isDeadWallSlot(tile.slot, fixture.humanSeat),
    );
    let nearest = Number.POSITIVE_INFINITY;
    for (const deadTile of dead) {
      for (const liveTile of live) {
        nearest = Math.min(
          nearest,
          Math.hypot(
            deadTile.pose.position[0] - liveTile.pose.position[0],
            deadTile.pose.position[1] - liveTile.pose.position[1],
            deadTile.pose.position[2] - liveTile.pose.position[2],
          ),
        );
      }
    }
    expect(nearest).toBeGreaterThanOrEqual(WALL.deadWallGapUnits - 1e-9);
  });

  it('draws exactly the live tiles the count publishes', () => {
    const live = board.wall.filter(
      (tile) => !isDeadWallSlot(tile.slot, fixture.humanSeat),
    );
    expect(live).toHaveLength(fixture.compass.tilesRemaining);
    // The count is odd, so exactly one stack at the draw edge keeps only its
    // bottom tile (the draw order takes the top first).
    const perStack = new Map<string, number[]>();
    for (const tile of live) {
      const decoded = decodeWallSlot(tile.slot);
      if (!decoded) throw new Error('bad slot');
      const key = `${decoded.run}:${decoded.stack}`;
      perStack.set(key, [...(perStack.get(key) ?? []), decoded.tier]);
    }
    const partial = [...perStack.values()].filter(
      (tiers) => tiers.length === 1,
    );
    expect(partial).toHaveLength(1);
    expect(partial[0]).toEqual([0]);
    expect(liveWallSlots(fixture.compass.tilesRemaining, fixture.humanSeat)).toHaveLength(
      fixture.compass.tilesRemaining,
    );
  });

  it('keeps the dead wall intact at a late-hand count', () => {
    const late = layoutBoard(
      boardFixture({ tilesRemaining: 12, doraCount: 5 }),
    );
    const dead = late.wall.filter((tile) =>
      isDeadWallSlot(tile.slot, late.humanSeat),
    );
    // 14 tiles, minus the 5 face-down tiles the indicators cover.
    expect(dead).toHaveLength(WALL.deadWallTiles - 5);
    const live = late.wall.filter(
      (tile) => !isDeadWallSlot(tile.slot, late.humanSeat),
    );
    expect(live).toHaveLength(12);
    // No live tile survives on the empty (dealt) side of the ring.
    for (const tile of live) {
      const decoded = decodeWallSlot(tile.slot);
      if (!decoded) throw new Error('bad slot');
      const index = liveWallSlots(12, late.humanSeat).findIndex(
        (slot) =>
          slot.run === decoded.run &&
          slot.stack === decoded.stack &&
          slot.tier === decoded.tier,
      );
      expect(index).toBeGreaterThanOrEqual(0);
    }
  });

  it('insets the front and back runs so the ring\u2019s edges line up', () => {
    // The human's and the far runs are the end runs; the other two are sides.
    expect(wallRunRadius(0, 0)).toBe(WALL.endRunRadiusUnits);
    expect(wallRunRadius(2, 0)).toBe(WALL.endRunRadiusUnits);
    expect(wallRunRadius(1, 0)).toBe(WALL.radiusUnits);
    expect(wallRunRadius(3, 0)).toBe(WALL.radiusUnits);
    // The inset follows the human: with the human at seat 1, runs 1 and 3 are
    // the end runs.
    expect(wallRunRadius(1, 1)).toBe(WALL.endRunRadiusUnits);
    expect(wallRunRadius(3, 1)).toBe(WALL.endRunRadiusUnits);
    expect(wallRunRadius(0, 1)).toBe(WALL.radiusUnits);

    // Every wall tile sits on its own run's radius.
    for (const tile of board.wall) {
      const run = Math.floor(tile.slot / WALL.slotsPerRun);
      expect(radialUnits(run as Seat, tile.pose.position)).toBeCloseTo(
        wallRunRadius(run as Seat, fixture.humanSeat),
        9,
      );
    }

    // The near end run's outer face is flush with a side run's end tile in
    // world space: both are `WALL.runHalfLengthUnits` from the centre line.
    const nearRun = board.wall.filter(
      (tile) =>
        Math.floor(tile.slot / WALL.slotsPerRun) === fixture.humanSeat &&
        tile.slot % WALL.tiers === 0,
    );
    expect(nearRun.length).toBeGreaterThan(0);
    const tile = nearRun[0];
    expect(tile.pose.position[2] + TILE.heightUnits / 2).toBeCloseTo(
      WALL.runHalfLengthUnits,
      9,
    );
    // Side runs still reach further out than that, which is why the hand ring
    // cannot move in past them.
    const sideRun = board.wall.find(
      (entry) =>
        Math.floor(entry.slot / WALL.slotsPerRun) ===
        ((fixture.humanSeat + 1) % 4),
    );
    expect(sideRun).toBeDefined();
    if (!sideRun) return;
    expect(Math.abs(sideRun.pose.position[0]) + TILE.heightUnits / 2).toBeGreaterThan(
      WALL.runHalfLengthUnits,
    );
  });

  it('reveals dora on the far wall\u2019s top tier, replacing wall tiles', () => {
    const farSeat = ((fixture.humanSeat + 2) % 4) as Seat;
    const dora = board.foreground.filter((tile) => tile.zone === 'dora');
    expect(dora).toHaveLength(fixture.dora.length);
    dora.forEach((tile, index) => {
      expect(tile.pose.tiltDeg).toBe(-90);
      expect(tile.faceUp).toBe(true);
      // The far run is an inset end run, not a side run.
      expect(radialUnits(farSeat, tile.pose.position)).toBeCloseTo(
        wallRunRadius(farSeat, fixture.humanSeat),
        9,
      );
      expect(tile.pose.position[1]).toBeCloseTo(wallTierHeightUnits(1), 9);
      // Counting in from the draw end: one stack per indicator, no gap.
      const right = seatPoint(farSeat, 1, 0, 0);
      const w =
        tile.pose.position[0] * right[0] + tile.pose.position[2] * right[2];
      expect(w).toBeCloseTo(
        (WALL.drawEndSlot - 1 - index - (WALL.stacksPerRun - 1) / 2) *
          WALL.stackPitchUnits +
          WALL.deadWallGapUnits,
        9,
      );
      // The revealed glyph reads from the human's side: its top points away
      // from the viewer, not at them.
      const glyphTop = poseAxes(tile.pose)[1];
      const humanOutward = seatPoint(fixture.humanSeat, 0, 1, 0);
      expect(
        glyphTop[0] * humanOutward[0] + glyphTop[2] * humanOutward[2],
      ).toBeLessThan(-0.99);
    });
    // No wall tile shares a dora indicator's position.
    for (const tile of board.wall) {
      for (const indicator of dora) {
        const distance = Math.hypot(
          tile.pose.position[0] - indicator.pose.position[0],
          tile.pose.position[1] - indicator.pose.position[1],
          tile.pose.position[2] - indicator.pose.position[2],
        );
        expect(distance).toBeGreaterThan(1e-6);
      }
    }
  });

  it('lays one point stick on the side of every declarer', () => {
    const declarers = fixture.seats.filter((seat) => seat.riichi);
    expect(declarers.length).toBeGreaterThan(0);
    expect(board.sticks.map((stick) => stick.seat)).toEqual(
      declarers.map((seat) => seat.seat),
    );

    for (const stick of board.sticks) {
      // The declarer's own side of the compass, lengthways along its edge.
      expect(stick.yawDeg).toBe(seatYawDeg(stick.seat));
      // Standing on the compass plate, not on the felt (3D-09 revision).
      expect(stick.position[1]).toBeCloseTo(
        COMPASS_PLATE.topUnits + STICK.heightUnits / 2,
        9,
      );
      const { outward, right } = seatBasis(stick.seat);
      const radial =
        stick.position[0] * outward[0] + stick.position[2] * outward[2];
      const tangential =
        stick.position[0] * right[0] + stick.position[2] * right[2];
      expect(radial).toBeCloseTo(STICK.radiusUnits, 9);
      expect(tangential).toBeCloseTo(0, 9);
      // Inside the plate, whose edge touches the innermost pond row.
      expect(radial + STICK.widthUnits / 2).toBeLessThan(
        COMPASS_PLATE.sizeUnits / 2,
      );
      expect(COMPASS_PLATE.sizeUnits / 2).toBeLessThan(
        POND.rowRadiiUnits[POND.rows - 1] - TILE.heightUnits / 2,
      );

      // Sticks never intersect a tile, at their own seat's yaw.
      const box = {
        centre: stick.position,
        axes: [right, [0, 1, 0] as const, outward] as const,
        halfExtents: [
          stick.sizeUnits[0] / 2,
          stick.sizeUnits[1] / 2,
          stick.sizeUnits[2] / 2,
        ] as const,
      };
      for (const tile of board.tiles) {
        expect(orientedBoxesIntersect(box, orientedBox(tile.pose))).toBe(false);
      }
    }

    // Four 65 mm bars share the compass ring; neighbouring seats' bars are a
    // quarter-turn apart, so they must never meet at the corners.
    const stickBox = (stick: (typeof board.sticks)[number]) => {
      const { outward, right } = seatBasis(stick.seat);
      return {
        centre: stick.position,
        axes: [right, [0, 1, 0] as const, outward] as const,
        halfExtents: [
          stick.sizeUnits[0] / 2,
          stick.sizeUnits[1] / 2,
          stick.sizeUnits[2] / 2,
        ] as const,
      };
    };
    for (let first = 0; first < board.sticks.length; first += 1) {
      for (let second = first + 1; second < board.sticks.length; second += 1) {
        expect(
          orientedBoxesIntersect(
            stickBox(board.sticks[first]),
            stickBox(board.sticks[second]),
          ),
          `${board.sticks[first].id} x ${board.sticks[second].id}`,
        ).toBe(false);
      }
    }
  });

  it('draws no stick for a seat that has not declared', () => {
    const only = layoutBoard(
      boardFixture({ riichiSeats: [2], riichiSticks: 3 }),
    );
    expect(only.sticks.map((stick) => stick.seat)).toEqual([2]);
  });

  it('never draws the 1000-point pot as felt sticks (3D-09)', () => {
    const potOnly = layoutBoard(
      boardFixture({ riichiSeats: [], riichiSticks: 5 }),
    );
    expect(potOnly.sticks).toEqual([]);
  });

  it('rejects more dora indicators than a game can reveal', () => {
    expect(() =>
      layoutBoard(boardFixture({ doraCount: DORA.maxIndicators + 1 })),
    ).toThrow(/dora/i);
  });
});

/** Every pair of tiles whose oriented boxes overlap, as `id` pairs. */
function noIntersections(source: typeof board): string[] {
  const overlaps: string[] = [];
  const boxes = source.tiles.map((tile) => orientedBox(tile.pose));
  for (let left = 0; left < source.tiles.length; left += 1) {
    for (let right = left + 1; right < source.tiles.length; right += 1) {
      if (orientedBoxesIntersect(boxes[left], boxes[right])) {
        overlaps.push(
          `${source.tiles[left].id} x ${source.tiles[right].id}`,
        );
      }
    }
  }
  return overlaps;
}

describe('3D board layout: separation', () => {
  it('never lets two tiles overlap, wall tiers included', () => {
    expect(noIntersections(board)).toEqual([]);
  });

  it('holds up on the widest legal board', () => {
    const widest = layoutBoard(
      boardFixture({
        humanSeat: 2,
        riverCounts: [22, 22, 22, 22],
        meldCounts: [4, 4, 4, 4],
        kan: true,
        doraCount: 5,
        riichiSticks: 6,
      }),
    );
    expect(noIntersections(widest)).toEqual([]);
  });
});

describe('3D board layout: seats are rotations', () => {
  it('turns each seat by its committed yaw about the table centre', () => {
    const pondTile = (seat: Seat): BoardTile =>
      board.foreground.find(
        (tile) => tile.seat === seat && tile.zone === 'river' && tile.slot === 0,
      )!;
    const first = pondTile(0);
    for (const seat of [1, 2, 3] as const) {
      const next = pondTile(seat);
      expect(next.pose.yawDeg - first.pose.yawDeg).toBe(90 * seat);
      expect(next.pose.position[1]).toBeCloseTo(first.pose.position[1], 9);
      // Rotating seat 0's pose 90° about +Y maps (x, y, z) to (z, y, -x).
      let x = first.pose.position[0];
      let z = first.pose.position[2];
      for (let turn = 0; turn < seat; turn += 1) [x, z] = [z, -x];
      expect(next.pose.position[0]).toBeCloseTo(x, 9);
      expect(next.pose.position[2]).toBeCloseTo(z, 9);
    }
  });
});

describe('3D board layout: camera framing', () => {
  const expectedAspects = [21 / 9, 16 / 9, 3 / 2, 4 / 3, 1, 3 / 4, 9 / 16];
  const requiredAspects = [9 / 16, 3 / 4, 1, 16 / 9, 21 / 9];
  const matCorners = (): [number, number, number][] => {
    const half = TABLE.matSizeUnits / 2;
    return [
      [-half, 0, -half],
      [half, 0, -half],
      [half, 0, half],
      [-half, 0, half],
    ];
  };

  it('keeps the committed lens and pitch, solved closer for the board', () => {
    // Decision 2 (2026-11-18) adopted the reference's 75 mm lens and 50° pitch;
    // the board handoff (also 2026-11-18) asked for the camera to come in, so the
    // distance is the board's own fit, strictly inside the reference's 76 units.
    const frame = frameForAspect(16 / 9, board);
    expect(frame.pitchDeg).toBe(CAMERA.pitchDeg);
    expect(frame.tanHalfHorizontal).toBeCloseTo(18 / 75, 12);
    expect(frame.distanceUnits).toBeLessThan(CAMERA.distanceUnits);
    expect(frame.eye[0]).toBeCloseTo(0, 12);
    const pitch = 50 * (Math.PI / 180);
    expect(frame.eye[1]).toBeCloseTo(
      CAMERA.targetUnits[1] + frame.distanceUnits * Math.sin(pitch),
      9,
    );
    expect(frame.eye[2]).toBeCloseTo(frame.distanceUnits * Math.cos(pitch), 9);
    // The committed Shift Y is the reference's, and the solver only nudges it
    // far enough to reach the safe area. With melds no longer the board's nearest
    // content the hand is, and it lands within a pixel or two of the 2 % margin,
    // so the nudge is a small part of the committed offset (and may now be
    // downward, because the band is a touch high rather than a touch low).
    expect(
      Math.abs(frame.shiftNdcY - committedShiftNdcY(16 / 9)),
    ).toBeLessThan(0.02);
  });

  it('projects the unsolved reference frame onto the signed-off pixels', () => {
    // the retired calibration rig's v1-baseline record (the 76-unit whole-table
    // rig this chain adopts) puts the mat corners here at 1920 x 1080; the
    // committed constant must keep reproducing them.
    const frame = referenceFrame(16 / 9);
    const corners = matCorners().map((corner) =>
      projectToPixels(corner, frame, 1920, 1080),
    );
    const rounded = corners.map((point) => [
      Math.round(point.x),
      Math.round(point.y),
    ]);
    expect(rounded).toEqual([
      [367, 58],
      [1553, 58],
      [1693, 1076],
      [227, 1076],
    ]);
  });

  it('covers every supported aspect', () => {
    expect([...CAMERA.supportedAspects].sort((a, b) => a - b)).toEqual(
      expectedAspects.sort((a, b) => a - b),
    );
  });

  it('frames the board, not the mat, at every aspect', () => {
    // Since the board handoff the fit subject is the tiles (the felt is a
    // procedural square that runs off the frame), so the mat corners are allowed
    // to crop while every tile keeps the committed safe area.
    const height = 1000;
    let cropped = 0;
    for (const aspect of [...CAMERA.supportedAspects, ...requiredAspects]) {
      const frame = frameForAspect(aspect, board);
      const width = height * aspect;
      const margin = CAMERA.safeAreaMargin;
      for (const corner of matCorners()) {
        const pixel = projectToPixels(corner, frame, width, height);
        if (pixel.x < 0 || pixel.x > width || pixel.y < 0 || pixel.y > height) {
          cropped += 1;
        }
      }
      for (const tile of humanHand(board)) {
        for (const corner of orientedBoxCorners(orientedBox(tile.pose))) {
          const ndc = projectPoint(corner, frame);
          expect(1 - Math.abs(ndc.x) * 0.5, `tile x at ${aspect}`).toBeGreaterThanOrEqual(margin);
          expect(1 - Math.abs(ndc.y) * 0.5, `tile y at ${aspect}`).toBeGreaterThanOrEqual(margin);
        }
      }
    }
    // The mat is not framing subject any more: at landscape aspects its corners
    // leave the frame, which is the "tiles too small" fix.
    expect(cropped).toBeGreaterThan(0);
  });

  it('puts the human hand a sliver above the bottom edge at 16:9', () => {
    const height = 1000;
    const width = height * (16 / 9);
    const frame = frameForAspect(16 / 9, board);
    let bottom = 1;
    for (const tile of humanHand(board)) {
      for (const corner of orientedBoxCorners(orientedBox(tile.pose))) {
        const pixel = projectToPixels(corner, frame, width, height);
        bottom = Math.min(bottom, 1 - pixel.y / height);
      }
    }
    // The meld lines are pinned inside the meld-free hand's footprint, so the
    // hand (not a side player's melds) is the board's nearest content and sits
    // right on the 2 % safe-area edge.
    expect(bottom).toBeGreaterThanOrEqual(CAMERA.safeAreaMargin - 1e-9);
    expect(bottom).toBeLessThanOrEqual(0.03);
  });

  it('holds the solved distance when every seat declares four melds', () => {
    // The defect this task fixes: a side player's meld line used to run past the
    // hand's end and become the board's nearest content, so the camera solved up
    // to 28 units further back. The melds are now inside the meld-free board's
    // extents, and the row's small extra width (four melds replacing twelve
    // concealed tiles) costs under 2 % of the solve at the narrowest aspects and
    // nothing at the wide ones.
    for (const humanSeat of [0, 1, 2, 3] as const) {
      const plain = layoutBoard(
        boardFixture({ humanSeat, meldCounts: [0, 0, 0, 0] }),
      );
      const heavy = layoutBoard(
        boardFixture({ humanSeat, meldCounts: [4, 4, 4, 4], kan: true }),
      );
      for (const aspect of CAMERA.supportedAspects) {
        const before = frameForAspect(aspect, plain).distanceUnits;
        const after = frameForAspect(aspect, heavy).distanceUnits;
        expect(
          Math.abs(after - before),
          `human seat ${humanSeat} at ${aspect}`,
        ).toBeLessThanOrEqual(0.02 * before + 1e-9);
      }
      // At the reference aspect the two frames are the same solve, to the digit.
      expect(
        frameForAspect(16 / 9, heavy).distanceUnits,
        `human seat ${humanSeat} at 16:9`,
      ).toBeCloseTo(frameForAspect(16 / 9, plain).distanceUnits, 9);
    }
  });

  it('keeps every tile inside the safe area at every aspect', () => {
    for (const aspect of CAMERA.supportedAspects) {
      const frame = frameForAspect(aspect, board);
      for (const tile of board.tiles) {
        for (const corner of orientedBoxCorners(orientedBox(tile.pose))) {
          const ndc = projectPoint(corner, frame);
          expect(1 - Math.abs(ndc.x) * 0.5).toBeGreaterThanOrEqual(
            CAMERA.safeAreaMargin,
          );
          expect(1 - Math.abs(ndc.y) * 0.5).toBeGreaterThanOrEqual(
            CAMERA.safeAreaMargin,
          );
        }
      }
    }
  });

  it('keeps the hand face within 25° of the view at every aspect', () => {
    for (const aspect of CAMERA.supportedAspects) {
      const frame = frameForAspect(aspect, board);
      expect(handFaceToViewDeg(frame)).toBeLessThanOrEqual(
        HAND.maxFaceToViewDeg,
      );
      expect(handFaceToViewDeg(frame)).toBe(
        Math.abs(frame.pitchDeg - HAND.reclineDeg),
      );
    }
  });

  it('keeps the hand\u2019s long axis readable at the reference aspect', () => {
    const height = 1000;
    const aspect = CAMERA.framingAspect;
    const frame = frameForAspect(aspect, board);
    const width = height * aspect;
    const tile = humanHand(board)[6];
    const axes = poseAxes(tile.pose);
    const top: [number, number, number] = [
      tile.pose.position[0] + axes[1][0] * 0.5,
      tile.pose.position[1] + axes[1][1] * 0.5,
      tile.pose.position[2] + axes[1][2] * 0.5,
    ];
    const bottom: [number, number, number] = [
      tile.pose.position[0] - axes[1][0] * 0.5,
      tile.pose.position[1] - axes[1][1] * 0.5,
      tile.pose.position[2] - axes[1][2] * 0.5,
    ];
    const a = projectToPixels(top, frame, width, height);
    const b = projectToPixels(bottom, frame, width, height);
    const longAxis = Math.hypot(a.x - b.x, a.y - b.y) / height;
    expect(longAxis).toBeGreaterThanOrEqual(
      CAMERA.handLongAxisMinViewportFraction,
    );
    // A landscape 4:3 frame is the tightest other case and stays above 4.5 %.
    const fourThree = frameForAspect(4 / 3, board);
    const c = projectToPixels(top, fourThree, height * (4 / 3), height);
    const d = projectToPixels(bottom, fourThree, height * (4 / 3), height);
    expect(Math.hypot(c.x - d.x, c.y - d.y) / height).toBeGreaterThan(0.045);
  });

  it('uses the steeper portrait preset', () => {
    for (const aspect of [9 / 16, 3 / 4]) {
      expect(frameForAspect(aspect, board).pitchDeg).toBe(
        CAMERA.portraitPitchDeg,
      );
    }
    for (const aspect of [1, 16 / 9, 21 / 9]) {
      expect(frameForAspect(aspect, board).pitchDeg).toBe(CAMERA.pitchDeg);
    }
  });

  it('reports the strict per-tile ray for the hand, as information', () => {
    for (const aspect of CAMERA.supportedAspects) {
      const frame = frameForAspect(aspect, board);
      for (const tile of humanHand(board)) {
        const strict = handTileToEyeDeg(tile, frame);
        expect(strict).toBeGreaterThan(0);
        expect(strict).toBeLessThan(90);
      }
    }
  });

  it('rejects an invalid aspect', () => {
    expect(() => frameForAspect(0)).toThrow(/aspect/);
    expect(() => frameForAspect(Number.NaN)).toThrow(/aspect/);
  });
});

describe('3D board layout: snapshot edge cases', () => {
  it('handles a seat with no draw and no discards', () => {
    const sparse: TableSnapshot = {
      ...fixture,
      seats: fixture.seats.map((seat) =>
        seat.seat === 3
          ? { ...seat, concealed: seat.concealed, draw: null, river: [] }
          : seat,
      ) as unknown as TableSnapshot['seats'],
    };
    const placed = layoutBoard(sparse);
    expect(
      placed.foreground.filter(
        (tile) => tile.seat === 3 && tile.zone === 'draw',
      ),
    ).toHaveLength(0);
    expect(noIntersections(placed)).toEqual([]);
  });

  it('lays a hidden hand\u2019s tiles without drawing a 14th slot', () => {
    const noDraw = layoutBoard(boardFixture({ draw: false }));
    expect(
      noDraw.foreground.filter((tile) => tile.zone === 'draw'),
    ).toHaveLength(0);
    expect(noIntersections(noDraw)).toEqual([]);
  });

  it('keeps every snapshot tile in the fixture unchanged', () => {
    const tileCount = [
      ...fixture.seats.flatMap((seat) => [
        seat.concealed.length + (seat.draw ? 1 : 0) + seat.river.length,
        ...seat.melds.map((meld) => meld.tiles.length),
      ]),
    ].reduce((sum, count) => sum + count, 0);
    expect(board.foreground).toHaveLength(tileCount + fixture.dora.length);
  });
});
