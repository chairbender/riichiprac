/**
 * 3D-15: the full-board stress state, drawn.
 *
 * `boardFixture` (3D-06) proves the layout survives its widest *legal* board.
 * This file proves the exposed view draws a **complete** one: all four seats
 * full, all 37 faces, four Riichi, a closed kan per seat, three-row rivers, a
 * claimed discard, unanswered and answered. Every assertion prints numbers or
 * compares structures — none of them is a look at an image (AGENTS.md §6).
 *
 * The five-aspect matrix runs the real solver (`frameForAspect`) and the real
 * projection (`hitRects`, `handBandRect`, `compassPlateRect`) at each supported
 * aspect, so a NaN, an off-screen tile, an unreachable hand button or a
 * collapsed compass fails here rather than in a browser.
 */

import { describe, expect, it } from 'vitest';
import { compassView } from '../compassOverlay';
import { CAMERA, HAND, POND, WALL } from '../layoutConstants';
import {
  frameForAspect,
  handFaceToViewDeg,
  layoutBoard,
  orientedBox,
  orientedBoxCorners,
  orientedBoxesIntersect,
  projectPoint,
  seatBasis,
} from './boardLayout';
import type { BoardLayout } from './boardLayout';
import {
  MIN_HIT_TARGET_PX,
  compassPlateRect,
  handBandRect,
  hitRects,
} from './hitTest';
import {
  CLAIMED_INDEX,
  CLAIMED_SEAT,
  CLAIMED_TILE,
  STRESS_DORA,
  STRESS_FACES,
  STRESS_RIVER_LENGTH,
  stressGameState,
  stressSnapshot,
} from './stressFixture';

/** The stage each supported aspect is measured on: the window's own height. */
const STAGE_HEIGHT = 1000;
const STAGES = CAMERA.supportedAspects.map((aspect) => ({
  aspect,
  width: STAGE_HEIGHT * aspect,
  height: STAGE_HEIGHT,
}));

/** Every face a foreground tile carries, as a set. */
function foregroundFaces(layout: BoardLayout): Set<string> {
  return new Set(layout.foreground.map((tile) => tile.face));
}

/** All numbers in a tile pose, for the finite check. */
function poseNumbers(layout: BoardLayout): number[] {
  const numbers: number[] = [];
  for (const tile of layout.tiles) {
    numbers.push(
      ...tile.pose.position,
      tile.pose.yawDeg,
      tile.pose.tiltDeg,
      tile.pose.rollDeg,
      ...tile.pose.sizeUnits,
    );
    for (const corner of orientedBoxCorners(orientedBox(tile.pose))) {
      numbers.push(...corner);
    }
  }
  for (const stick of layout.sticks) {
    numbers.push(...stick.position, stick.yawDeg, ...stick.sizeUnits);
  }
  return numbers;
}

describe('3D-15 stress state: the table is full', () => {
  it('puts content in every zone at the expected counts', () => {
    const snapshot = stressSnapshot();
    const board = layoutBoard(snapshot);

    // The snapshot's decorative wall is the fixed 132-tile set; the layout omits
    // the five tiles the dora indicators cover, so the two lists never draw
    // twice (3D-06).
    expect(snapshot.wall).toHaveLength(WALL.tileCount);
    expect(board.wall).toHaveLength(WALL.tileCount - STRESS_DORA);
    expect(snapshot.dora).toHaveLength(STRESS_DORA);
    expect(board.foreground.filter((tile) => tile.zone === 'dora')).toHaveLength(
      STRESS_DORA,
    );

    // Every seat: 10 concealed + draw + a four-tile kan + an 18-discard river.
    for (const seat of snapshot.seats) {
      expect(seat.concealed).toHaveLength(10);
      expect(seat.draw).not.toBeNull();
      expect(seat.melds).toHaveLength(1);
      expect(seat.melds[0].tiles).toHaveLength(4);
      expect(seat.river).toHaveLength(STRESS_RIVER_LENGTH);
    }

    const foreground = 4 * (10 + 1 + 4 + STRESS_RIVER_LENGTH) + STRESS_DORA;
    expect(foreground).toBe(137);
    expect(board.foreground).toHaveLength(foreground);
    expect(board.tiles).toHaveLength(foreground + board.wall.length);
    expect(board.tiles).toHaveLength(264);

    // The board's own zone census, not just the snapshot's.
    const zones = new Map<string, number>();
    for (const tile of board.tiles) {
      zones.set(tile.zone, (zones.get(tile.zone) ?? 0) + 1);
    }
    expect(Object.fromEntries(zones)).toEqual({
      wall: WALL.tileCount - STRESS_DORA,
      dora: STRESS_DORA,
      hand: 40,
      draw: 4,
      meld: 16,
      river: 4 * STRESS_RIVER_LENGTH,
    });
  });

  it('shows all 37 faces, and the blank only where a tile is face-down', () => {
    const board = layoutBoard(stressSnapshot());
    const faces = foregroundFaces(board);
    for (const face of STRESS_FACES) {
      expect(faces.has(face), `missing ${face}`).toBe(true);
    }
    expect(faces.size).toBe(STRESS_FACES.length);
    expect(faces.has('blank')).toBe(false);
    // The decorative wall is face-down, so it is the only blank carrier.
    expect(
      board.wall.every((tile) => tile.face === 'blank' && !tile.faceUp),
    ).toBe(true);
  });

  it('fills three river rows per seat, with the declaration and tsumogiri marked', () => {
    const board = layoutBoard(stressSnapshot());
    expect(STRESS_RIVER_LENGTH).toBe(POND.rows * POND.columns);

    for (const seat of [0, 1, 2, 3]) {
      const river = board.foreground
        .filter((tile) => tile.seat === seat && tile.zone === 'river')
        .sort((left, right) => left.slot - right.slot);
      expect(river, `seat ${seat}`).toHaveLength(STRESS_RIVER_LENGTH);

      // Every discard has its own cell: 18 distinct positions, no overlap
      // hiding two discards in one pond slot.
      const positions = new Set(
        river.map(
          (tile) =>
            tile.pose.position[0].toFixed(6) +
            ',' +
            tile.pose.position[2].toFixed(6),
        ),
      );
      expect(positions.size).toBe(STRESS_RIVER_LENGTH);

      // The declaration discard at index 5 is turned sideways and rolled -90.
      const declared = river[5];
      expect(declared.sideways).toBe(true);
      expect(declared.pose.rollDeg).toBe(-90);
      // The tsumogiri at index 11 is dimmed.
      expect(river[11].dimmed).toBe(true);
    }

    // The three row centre lines, from the committed pond table: a first,
    // seventh and thirteenth discard sit on the far, middle and near rows
    // (row radii count outward from the far row, so the distance grows).
    // Distance is measured along the seat's outward axis, not from the origin:
    // a row is 6 columns wide, so its cells are not all one radius.
    const outward = seatBasis(0).outward;
    const rows = [0, 6, 12].map((slot) => {
      const tile = board.foreground.find(
        (candidate) =>
          candidate.seat === 0 &&
          candidate.zone === 'river' &&
          candidate.slot === slot,
      );
      if (!tile) throw new Error(`no discard ${slot}`);
      return (
        tile.pose.position[0] * outward[0] +
        tile.pose.position[2] * outward[2]
      );
    });
    expect(rows[0]).toBeLessThan(rows[1]);
    expect(rows[1]).toBeLessThan(rows[2]);
  });

  it('declares Riichi for all four seats, with a closed kan and a claimed discard', () => {
    const snapshot = stressSnapshot();
    const board = layoutBoard(snapshot);

    expect(snapshot.seats.filter((seat) => seat.riichi)).toHaveLength(4);
    expect(board.sticks).toHaveLength(4);
    expect(board.sticks.map((stick) => stick.seat).sort()).toEqual([0, 1, 2, 3]);

    // A kan, per seat: four tiles, closed, so no called tile is turned.
    for (const seat of snapshot.seats) {
      expect(seat.melds[0].kind).toBe('Ankan');
      expect(seat.melds[0].calledFrom).toBeNull();
      expect(seat.melds[0].tiles.every((tile) => !tile.sideways)).toBe(true);
    }

    // The claimed discard: one highlighted tile, seat 1's newest, face 9p.
    const highlighted = board.foreground.filter((tile) => tile.highlighted);
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]).toMatchObject({
      seat: CLAIMED_SEAT,
      zone: 'river',
      slot: CLAIMED_INDEX,
      face: CLAIMED_TILE,
    });
    expect(snapshot.highlightDiscard).toEqual({
      seat: CLAIMED_SEAT,
      index: CLAIMED_INDEX,
    });
  });

  it('is deterministic', () => {
    expect(stressGameState()).toEqual(stressGameState());
    expect(JSON.stringify(stressSnapshot())).toBe(
      JSON.stringify(stressSnapshot()),
    );
    expect(JSON.stringify(layoutBoard(stressSnapshot()))).toBe(
      JSON.stringify(layoutBoard(stressSnapshot())),
    );
  });

  it('reports the same compass numbers in the model', () => {
    const view = compassView(stressSnapshot());
    expect(view.round).toBe('South 4');
    expect(view.tilesRemaining).toBe(14);
    expect(view.label).toBe('Round South 4, 14 tiles remaining');
    expect(view.seats.map((seat) => seat.wind)).toEqual([
      'East',
      'South',
      'West',
      'North',
    ]);
    expect(view.seats.map((seat) => seat.score)).toEqual([
      25000, 32000, 18500, 41000,
    ]);
    expect(view.seats.every((seat) => seat.riichi)).toBe(true);
    expect(view.seats[0].side).toBe('bottom');
  });
});

describe('3D-15 stress state: geometry and projection', () => {
  it('places every tile and stick on finite numbers', () => {
    const numbers = poseNumbers(layoutBoard(stressSnapshot()));
    expect(numbers.length).toBeGreaterThan(2000);
    expect(numbers.every((value) => Number.isFinite(value))).toBe(true);
  });

  it('separates every pair of tiles on the full board', () => {
    const board = layoutBoard(stressSnapshot());
    const boxes = board.tiles.map((tile) => orientedBox(tile.pose));
    const collisions: string[] = [];
    for (let left = 0; left < boxes.length; left += 1) {
      for (let right = left + 1; right < boxes.length; right += 1) {
        if (orientedBoxesIntersect(boxes[left], boxes[right])) {
          collisions.push(`${board.tiles[left].id} x ${board.tiles[right].id}`);
        }
      }
    }
    expect(collisions).toEqual([]);
    // The union of the layout is exactly the snapshot's tiles, no double-draw.
    expect(board.foreground).toHaveLength(
      new Set(board.foreground.map((tile) => tile.id)).size,
    );
  });

  it('keeps every tile inside the 2 % safe area at every supported aspect', () => {
    const board = layoutBoard(stressSnapshot());
    const results: string[] = [];
    for (const stage of STAGES) {
      const frame = frameForAspect(stage.aspect, board);
      let margin = 1;
      for (const tile of board.tiles) {
        for (const corner of orientedBoxCorners(orientedBox(tile.pose))) {
          const ndc = projectPoint(corner, frame);
          margin = Math.min(
            margin,
            (1 - Math.abs(ndc.x)) / 2,
            (1 - Math.abs(ndc.y)) / 2,
          );
        }
      }
      results.push(`${stage.aspect.toFixed(3)}: ${(margin * 100).toFixed(2)}%`);
      expect(
        margin + 1e-9 >= CAMERA.safeAreaMargin,
        `${stage.aspect}: ${(margin * 100).toFixed(2)}% < ${(CAMERA.safeAreaMargin * 100).toFixed(0)}%`,
      ).toBe(true);
      // The hand's readable angle holds on the full board at every aspect.
      expect(
        handFaceToViewDeg(frame),
        `${stage.aspect}: hand face-to-view`,
      ).toBeLessThanOrEqual(HAND.maxFaceToViewDeg);
    }
    // Visible in the failure message and the gate's own printout.
    expect(results).toHaveLength(STAGES.length);
  });

  it('keeps every projected hand button reachable, and inside the stage', () => {
    const board = layoutBoard(stressSnapshot());
    for (const stage of STAGES) {
      const frame = frameForAspect(stage.aspect, board);
      const viewport = { widthPx: stage.width, heightPx: stage.height };
      const rects = hitRects(board, frame, viewport);

      // 10 concealed tiles + the draw, every one a live target.
      expect(rects, `${stage.aspect}: hand buttons`).toHaveLength(11);
      for (const rect of rects) {
        expect(Number.isFinite(rect.left + rect.top + rect.width + rect.height)).toBe(
          true,
        );
        // Positive size inside the stage: the tile's own cell is the floor on a
        // small stage (hitTest's rule), so only the stage bounds are asserted
        // here. The 44 px target is the reference-aspect row below.
        expect(rect.width, `${stage.aspect}: width`).toBeGreaterThan(0);
        expect(rect.height, `${stage.aspect}: height`).toBeGreaterThan(0);
        expect(rect.left).toBeGreaterThanOrEqual(-0.51);
        expect(rect.top).toBeGreaterThanOrEqual(-0.51);
        expect(rect.left + rect.width).toBeLessThanOrEqual(stage.width + 0.51);
        expect(rect.top + rect.height).toBeLessThanOrEqual(stage.height + 0.51);
      }
      // No two buttons overlap: each is its own tap target (§3D-08).
      for (let left = 0; left < rects.length; left += 1) {
        for (let right = left + 1; right < rects.length; right += 1) {
          const a = rects[left];
          const b = rects[right];
          const overlapX =
            Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
          const overlapY =
            Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
          expect(
            overlapX > 0.01 && overlapY > 0.01,
            `${stage.aspect}: ${a.slot} overlaps ${b.slot}`,
          ).toBe(false);
        }
      }
      if (Math.abs(stage.aspect - 16 / 9) < 1e-9) {
        for (const rect of rects) {
          expect(rect.width).toBeGreaterThanOrEqual(MIN_HIT_TARGET_PX);
          expect(rect.height).toBeGreaterThanOrEqual(MIN_HIT_TARGET_PX);
        }
      }

      const band = handBandRect(board, frame, viewport);
      expect(band, `${stage.aspect}: band`).not.toBeNull();
      if (band) {
        expect(band.left).toBeGreaterThanOrEqual(-0.51);
        expect(band.top).toBeGreaterThanOrEqual(-0.51);
        expect(band.left + band.width).toBeLessThanOrEqual(stage.width + 0.51);
        expect(band.top + band.height).toBeLessThanOrEqual(stage.height + 0.51);
      }

      const compass = compassPlateRect(frame, viewport);
      expect(compass, `${stage.aspect}: compass`).not.toBeNull();
      if (compass) {
        expect(compass.width).toBeGreaterThan(0);
        expect(compass.height).toBeGreaterThan(0);
        expect(compass.centreX).toBeGreaterThan(0);
        expect(compass.centreX).toBeLessThan(stage.width);
        expect(compass.centreY).toBeGreaterThan(0);
        expect(compass.centreY).toBeLessThan(stage.height);
      }
    }
  });

  it('answers the same table without moving the band or the compass', () => {
    const unanswered = stressSnapshot();
    const answered = stressSnapshot({ answered: true });
    expect(unanswered.locked).toBe(false);
    expect(answered.locked).toBe(true);
    // The answer changes one flag, not the position.
    expect({ ...answered, locked: false }).toEqual(unanswered);

    const board = layoutBoard(unanswered);
    for (const stage of STAGES) {
      const frame = frameForAspect(stage.aspect, board);
      const viewport = { widthPx: stage.width, heightPx: stage.height };
      const before = handBandRect(board, frame, viewport);
      const after = handBandRect(
        layoutBoard(answered),
        frame,
        viewport,
      );
      expect(after, `${stage.aspect}: band after the answer`).toEqual(before);
      expect(hitRects(board, frame, viewport)).toHaveLength(11);
      expect(
        hitRects(layoutBoard(answered), frame, viewport, { locked: true }),
        `${stage.aspect}: no buttons once answered`,
      ).toHaveLength(0);
    }
  });
});
