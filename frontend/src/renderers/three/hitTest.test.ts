/**
 * The 3D hand's hit-test projection (3D-08).
 *
 * These are numeric checks on pure math, not a picture: each rect is compared
 * with an independent projection of the same hand OBB through the same solved
 * frame (the drift test the plan asks for), the 44 px target rule and its
 * cell-clamped version are asserted at a desktop and a phone aspect, and the
 * answered hand is asserted to have no targets at all.
 */

import { describe, expect, it } from 'vitest';
import { HAND, TILE } from '../layoutConstants';
import { boardFixture } from './boardFixture';
import {
  frameForAspect,
  layoutBoard,
  orientedBox,
  orientedBoxCorners,
  projectToPixels,
} from './boardLayout';
import type { BoardLayout, BoardTile, CameraFrame } from './boardLayout';
import { MIN_HIT_TARGET_PX, handTileCell, hitRects } from './hitTest';
import type { ProjectedRect } from './hitTest';

const DESKTOP = { widthPx: 1920, heightPx: 1080 };
const PHONE = { widthPx: 390, heightPx: 844 };

function board(humanSeat: 0 | 1 | 2 | 3 = 0): BoardLayout {
  return layoutBoard(boardFixture({ humanSeat }));
}

/** The independent projection: the body's eight corners to a CSS AABB. */
function projectBody(
  tile: BoardTile,
  frame: CameraFrame,
  viewport: { widthPx: number; heightPx: number },
): ProjectedRect {
  const points = orientedBoxCorners(orientedBox(tile.pose)).map((corner) =>
    projectToPixels(corner, frame, viewport.widthPx, viewport.heightPx),
  );
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

function overlapArea(a: ProjectedRect, b: ProjectedRect): number {
  const width = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const height = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
}

/** The human hand's tiles in the layout, for pairing with the rects. */
function handTiles(layout: BoardLayout): BoardTile[] {
  return layout.tiles
    .filter(
      (tile) =>
        tile.seat === layout.humanSeat &&
        (tile.zone === 'hand' || tile.zone === 'draw'),
    )
    .sort((left, right) =>
      left.zone === right.zone
        ? left.slot - right.slot
        : left.zone === 'hand'
          ? -1
          : 1,
    );
}

describe('3D hit testing: projection', () => {
  const layout = board();
  const frame = frameForAspect(DESKTOP.widthPx / DESKTOP.heightPx, layout);
  const rects = hitRects(layout, frame, DESKTOP);

  it('returns exactly the human hand and draw, in slot order', () => {
    const tiles = handTiles(layout);
    expect(rects).toHaveLength(tiles.length);
    expect(rects.map((rect) => `${rect.zone}:${rect.slot}:${rect.face}`)).toEqual(
      tiles.map((tile) => `${tile.zone}:${tile.slot}:${tile.face}`),
    );
    expect(rects.every((rect) => rect.seat === layout.humanSeat)).toBe(true);
  });

  it('lands every button on its own projected body (drift test)', () => {
    const tiles = handTiles(layout);
    rects.forEach((rect, index) => {
      const body = projectBody(tiles[index], frame, DESKTOP);
      // The rect may be trimmed by a few pixels at a shared edge so neighbours
      // never overlap, but it must still cover the body's own centre and almost
      // all of its area, and it may not grow beyond the projection at 16:9.
      const bodyCentre = {
        x: body.left + body.width / 2,
        y: body.top + body.height / 2,
      };
      expect(rect.left).toBeLessThanOrEqual(bodyCentre.x);
      expect(rect.left + rect.width).toBeGreaterThanOrEqual(bodyCentre.x);
      expect(rect.top).toBeLessThanOrEqual(bodyCentre.y);
      expect(rect.top + rect.height).toBeGreaterThanOrEqual(bodyCentre.y);
      expect(overlapArea(rect, body) / (body.width * body.height)).toBeGreaterThan(0.9);
      expect(rect.width).toBeLessThanOrEqual(body.width + 0.01);
      expect(rect.height).toBeLessThanOrEqual(body.height + 0.01);
      // Vertical containment is exact: no neighbour shares this band.
      expect(rect.top).toBeCloseTo(body.top, 1);
      expect(rect.height).toBeCloseTo(body.height, 1);
    });
  });

  it('meets the 44 x 44 CSS px target at the reference aspect', () => {
    for (const rect of rects) {
      expect(rect.width).toBeGreaterThanOrEqual(MIN_HIT_TARGET_PX);
      expect(rect.height).toBeGreaterThanOrEqual(MIN_HIT_TARGET_PX);
    }
  });

  it('never lets two targets overlap', () => {
    for (let first = 0; first < rects.length; first += 1) {
      for (let second = first + 1; second < rects.length; second += 1) {
        expect(overlapArea(rects[first], rects[second])).toBe(0);
      }
    }
  });

  it('caps a phone’s expansion at the tile’s cell instead of overlapping', () => {
    const phoneFrame = frameForAspect(PHONE.widthPx / PHONE.heightPx, layout);
    const phoneRects = hitRects(layout, phoneFrame, PHONE);
    expect(phoneRects).toHaveLength(rects.length);
    for (const rect of phoneRects) {
      // Below 44 px the cell wins: the target is the largest non-overlapping
      // one rather than a wrong, overlapping one.
      expect(rect.width).toBeLessThan(MIN_HIT_TARGET_PX);
    }
    for (let first = 0; first < phoneRects.length; first += 1) {
      for (let second = first + 1; second < phoneRects.length; second += 1) {
        expect(overlapArea(phoneRects[first], phoneRects[second])).toBe(0);
      }
    }
    // Every button still sits on its body.
    const tiles = handTiles(layout);
    phoneRects.forEach((rect, index) => {
      const body = projectBody(tiles[index], phoneFrame, PHONE);
      expect(overlapArea(rect, body)).toBeGreaterThan(0);
    });
  });

  it('recomputes when the window aspect flips 16:9 <-> 9:16', () => {
    const portrait = { widthPx: DESKTOP.heightPx, heightPx: DESKTOP.widthPx };
    const portraitFrame = frameForAspect(portrait.widthPx / portrait.heightPx, layout);
    const portraitRects = hitRects(layout, portraitFrame, portrait);
    expect(portraitRects).toHaveLength(rects.length);
    expect(portraitRects[0].left).not.toBeCloseTo(rects[0].left, 0);
    expect(portraitRects[0].top).not.toBeCloseTo(rects[0].top, 0);
  });

  it('returns nothing for an answered hand', () => {
    expect(hitRects(layout, frame, DESKTOP, { locked: true })).toEqual([]);
  });

  it('returns nothing before the stage has a size', () => {
    expect(hitRects(layout, frame, { widthPx: 0, heightPx: 0 })).toEqual([]);
  });

  it('never offers an opponent’s concealed hand', () => {
    const seatTwo = board(2);
    const seatTwoFrame = frameForAspect(
      DESKTOP.widthPx / DESKTOP.heightPx,
      seatTwo,
    );
    const seatTwoRects = hitRects(seatTwo, seatTwoFrame, DESKTOP);
    expect(seatTwoRects.every((rect) => rect.seat === 2)).toBe(true);
    expect(seatTwoRects).toHaveLength(handTiles(seatTwo).length);
  });
});

describe('3D hit testing: cell geometry', () => {
  it('gives the draw a wider cell than a hand slot', () => {
    const layout = board();
    const tiles = handTiles(layout);
    const hand = tiles.find((tile) => tile.zone === 'hand');
    const draw = tiles.find((tile) => tile.zone === 'draw');
    expect(hand).toBeDefined();
    expect(draw).toBeDefined();
    expect(handTileCell(hand!).halfExtents[0]).toBeCloseTo(
      HAND.pitchUnits / 2,
      9,
    );
    expect(handTileCell(draw!).halfExtents[0]).toBeCloseTo(
      (HAND.drawGapUnits + TILE.widthUnits) / 2,
      9,
    );
    // The draw's cell includes half the tsumogiri gap on each side, and stops at
    // the gap's midpoint: it never reaches into the last hand tile's slot.
    expect(handTileCell(draw!).halfExtents[0]).toBeGreaterThan(
      handTileCell(hand!).halfExtents[0],
    );
  });
});
