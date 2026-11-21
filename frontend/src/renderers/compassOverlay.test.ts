/**
 * The 3D compass model and its projected anchor (3D-09).
 *
 * Everything here is a number or a label, never an impression of the screen:
 * the seat/edge order, the wording `PhysicalTable` writes, the square the DOM
 * compass occupies, and — at every supported aspect — where that square lands
 * relative to the camera's own projection of the well and of the human's hand
 * buttons.
 */

import { describe, expect, it } from 'vitest';
import { CAMERA, COMPASS_PLATE } from './layoutConstants';
import { boardFixture } from './three/boardFixture';
import { frameForAspect, layoutBoard, projectToPixels } from './three/boardLayout';
import { compassPlateCorners, compassPlateRect, hitRects } from './three/hitTest';
import {
  COMPASS_SIDES,
  COMPASS_SIDE_LABELS,
  MIN_COMPASS_PX,
  MIN_COMPASS_PX_MOBILE,
  MIN_COMPASS_PX_MOBILE_WIDTH,
  compassBox,
  compassFontPx,
  compassView,
  formatCompassScore,
} from './compassOverlay';
import type { TableSnapshot } from './contract';

/** The aspect gate's own list, plus the reference and a common phone. */
const VIEWPORTS: readonly { name: string; width: number; height: number }[] = [
  { name: '21:9', width: 2520, height: 1080 },
  { name: '16:9', width: 1920, height: 1080 },
  { name: '3:2', width: 1440, height: 960 },
  { name: '4:3', width: 1280, height: 960 },
  { name: '1:1', width: 1000, height: 1000 },
  { name: '3:4', width: 900, height: 1200 },
  { name: '9:16', width: 810, height: 1440 },
  { name: 'phone 390x844', width: 390, height: 844 },
  { name: 'small phone 320x568', width: 320, height: 568 },
];

/** A snapshot with a known mix of scores, riichi and human seat. */
function compassSnapshot(humanSeat: 0 | 1 | 2 | 3): TableSnapshot {
  const base = boardFixture({ humanSeat, riichiSeats: [1, 2] });
  return {
    ...base,
    seats: base.seats.map((seat) => ({
      ...seat,
      score: 25000 + seat.seat * 1000,
    })) as unknown as TableSnapshot['seats'],
    compass: {
      ...base.compass,
      roundWind: 'South',
      handNumber: 3,
      tilesRemaining: 42,
      riichiSticks: 5,
    },
  };
}

describe('compass model', () => {
  it('turns the four seats with the human, in turn order', () => {
    for (const humanSeat of [0, 1, 2, 3] as const) {
      const view = compassView(compassSnapshot(humanSeat));
      expect(view.seats.map((seat) => seat.side)).toEqual(COMPASS_SIDES);
      expect(view.seats[0].seat).toBe(humanSeat);
      expect(view.seats[1].seat).toBe((humanSeat + 1) % 4);
      expect(view.seats[2].seat).toBe((humanSeat + 2) % 4);
      expect(view.seats[3].seat).toBe((humanSeat + 3) % 4);
      expect(view.seats[0].isHuman).toBe(true);
      expect(view.seats.filter((seat) => seat.isHuman)).toHaveLength(1);
    }
  });

  it('writes the corners and the centre label as PhysicalTable does', () => {
    const view = compassView(compassSnapshot(0));
    // Character-for-character the strings in PhysicalTable's CompassSeat and
    // compass-wall (the drift test below compares the rendered DOM as well).
    expect(view.seats.map((seat) => seat.label)).toEqual([
      'East wind, 25000 points',
      'South wind, 26000 points, riichi',
      'West wind, 27000 points, riichi',
      'North wind, 28000 points',
    ]);
    // Desktop is the default profile: the round keeps its spelled word. The
    // mobile composition prints the wind character instead (below).
    expect(view.round).toBe('South 3');
    expect(view.tilesRemaining).toBe(42);
    expect(view.label).toBe('Round South 3, 42 tiles remaining');
    // Tenhou's split plate, lossless: lead + tail is the score.
    expect(
      view.seats.map((seat) => `${seat.scoreText.lead}${seat.scoreText.tail}`),
    ).toEqual(['25000', '26000', '27000', '28000']);
    expect(view.seats.map((seat) => seat.scoreText.lead)).toEqual([
      '250',
      '260',
      '270',
      '280',
    ]);
    expect(view.seats.map((seat) => seat.scoreText.tail)).toEqual([
      '00',
      '00',
      '00',
      '00',
    ]);
    expect(COMPASS_SIDE_LABELS).toEqual({
      bottom: 'your seat, at the bottom',
      right: 'right side, shimocha',
      top: 'across, toimen',
      left: 'left side, kamicha',
    });
  });

  it('never turns the 1000-point pot into corner markers', () => {
    // The pot is deliberately not part of the compass model (3D-09): only a
    // seat's own `riichi` flag puts a marker on that corner.
    const view = compassView(compassSnapshot(0));
    expect(view.seats.filter((seat) => seat.riichi).map((seat) => seat.seat)).toEqual([
      1, 2,
    ]);
  });

  it('splits a score into large hundreds and a small trailing pair', () => {
    expect(formatCompassScore(25000)).toEqual({ lead: '250', tail: '00' });
    expect(formatCompassScore(12300)).toEqual({ lead: '123', tail: '00' });
    expect(formatCompassScore(500)).toEqual({ lead: '005', tail: '00' });
    expect(formatCompassScore(0)).toEqual({ lead: '000', tail: '00' });
    // Not a legal riichi score, but the split must stay lossless for any input.
    expect(formatCompassScore(12345)).toEqual({ lead: '123', tail: '45' });
    // Above 99,900 the lead grows instead of the score being rounded away.
    expect(formatCompassScore(103000)).toEqual({ lead: '1030', tail: '00' });
    expect(formatCompassScore(-100)).toEqual({ lead: '000', tail: '00' });
    expect(formatCompassScore(Number.NaN)).toEqual({ lead: '000', tail: '00' });
  });

  it('sizes the DOM box from the well, centred on it', () => {
    const rect = {
      left: 100,
      top: 40,
      width: 300,
      height: 180,
      centreX: 250,
      centreY: 130,
    };
    // Desktop (the default) keeps the committed square: the well's shorter
    // side. Mobile follows the plate's rectangle per axis (2026-11-21), because
    // its score corners are what run out of room first.
    const box = compassBox(rect);
    expect(box).toEqual({ left: 160, top: 40, width: 180, height: 180 });
    /*
     * Mobile follows the well's rectangle and ends 8 px inside its edge (user
     * request 2026-11-22), with a 118 px minimum width for the corner rows and a
     * 56 px height floor. Here: 300 x 172, centred.
     */
    const mobile = compassBox(rect, 'mobile');
    expect(mobile).toEqual({ left: 100, top: 44, width: 300, height: 172 });
    const mobileSmall = compassBox(
      { left: 0, top: 0, width: 91, height: 69, centreX: 50, centreY: 40 },
      'mobile',
    );
    expect(mobileSmall.width).toBe(MIN_COMPASS_PX_MOBILE_WIDTH);
    // 69 - 8 = 61, above the 56 px floor.
    expect(mobileSmall.height).toBe(61);
    expect(mobile.left + mobile.width / 2).toBe(250);
    expect(mobile.top + mobile.height / 2).toBe(130);
    // The type follows the shorter axis, inside a legible pair of bounds.
    expect(compassFontPx(box)).toBeCloseTo(180 * 0.08, 9);
    // The mobile box's shorter side is its height (172 px here).
    expect(compassFontPx(mobile, 'mobile')).toBeCloseTo(172 * 0.08, 9);
    // The floor is 11 px on desktop and 9 px in the mobile box.
    expect(compassFontPx({ ...box, width: 20, height: 20 })).toBe(11);
    expect(compassFontPx({ ...box, width: 20, height: 20 }, 'mobile')).toBe(9);
    expect(compassFontPx({ ...box, width: 2000, height: 2000 })).toBe(30);

    // A stage whose well projects below the floor keeps a legible box, still
    // centred on the well (a 390 x 844 phone's 78 x 68 well).
    const tiny = compassBox({
      left: 156,
      top: 384,
      width: 78,
      height: 68,
      centreX: 195,
      centreY: 418,
    });
    expect(tiny.width).toBe(MIN_COMPASS_PX);
    expect(tiny.height).toBe(MIN_COMPASS_PX);
    expect(tiny.left + tiny.width / 2).toBe(195);
    expect(tiny.top + tiny.height / 2).toBe(418);
    // The mobile box has its own, smaller floor and follows the well's axes.
    const tinyMobile = compassBox(
      { left: 156, top: 384, width: 78, height: 68, centreX: 195, centreY: 418 },
      'mobile',
    );
    expect(tinyMobile.width).toBe(MIN_COMPASS_PX_MOBILE_WIDTH);
    // 68 - 8 = 60, still above the 56 px floor.
    expect(tinyMobile.height).toBe(60);
  });
});

describe('compass projection', () => {
  const layout = layoutBoard(boardFixture());

  it('projects the physical compass plate', () => {
    const half = COMPASS_PLATE.sizeUnits / 2;
    expect(compassPlateCorners()).toEqual([
      [-half, 0, -half],
      [half, 0, -half],
      [half, 0, half],
      [-half, 0, half],
    ]);
  });

  it('centres the compass on the projected well at every supported aspect', () => {
    expect(VIEWPORTS.map((viewport) => viewport.width / viewport.height)).toEqual(
      expect.arrayContaining([...CAMERA.supportedAspects]),
    );

    for (const viewport of VIEWPORTS) {
      const { width, height } = viewport;
      const aspect = width / height;
      const frame = frameForAspect(aspect, layout);
      const well = compassPlateRect(frame, { widthPx: width, heightPx: height });
      if (!well) throw new Error(`no compass rect at ${viewport.name}`);
      const box = compassBox(well);

      // The overlay's own centre is the well's projected centre.
      expect(box.left + box.width / 2, viewport.name).toBeCloseTo(well.centreX, 9);
      expect(box.top + box.height / 2, viewport.name).toBeCloseTo(well.centreY, 9);

      // Independent check: the table's centre (world origin) projects inside
      // the compass, and the compass centre is within 2 % of the window of it.
      const origin = projectToPixels([0, 0, 0], frame, width, height);
      expect(Math.abs(well.centreX - origin.x), viewport.name).toBeLessThanOrEqual(
        width * 0.02,
      );
      expect(Math.abs(well.centreY - origin.y), viewport.name).toBeLessThanOrEqual(
        height * 0.02,
      );
      expect(origin.x, viewport.name).toBeGreaterThanOrEqual(box.left);
      expect(origin.x, viewport.name).toBeLessThanOrEqual(box.left + box.width);
      expect(origin.y, viewport.name).toBeGreaterThanOrEqual(box.top);
      expect(origin.y, viewport.name).toBeLessThanOrEqual(box.top + box.height);

      // Desktop keeps the committed square: the well's shorter side, floored.
      const wellMin = Math.min(well.width, well.height);
      expect(box.width, viewport.name).toBeCloseTo(
        Math.max(wellMin, MIN_COMPASS_PX),
        6,
      );
      expect(box.height, viewport.name).toBeCloseTo(
        Math.max(wellMin, MIN_COMPASS_PX),
        6,
      );
      if (wellMin >= MIN_COMPASS_PX) {
        expect(box.left, viewport.name).toBeGreaterThanOrEqual(well.left - 1e-6);
        expect(box.top, viewport.name).toBeGreaterThanOrEqual(well.top - 1e-6);
        expect(box.left + box.width, viewport.name).toBeLessThanOrEqual(
          well.left + well.width + 1e-6,
        );
        expect(box.top + box.height, viewport.name).toBeLessThanOrEqual(
          well.top + well.height + 1e-6,
        );
      }

      // The mobile box follows the well's rectangle per axis, with its own
      // smaller floor (2026-11-21).
      const mobile = compassBox(well, 'mobile');
      expect(mobile.width, viewport.name).toBeCloseTo(
        Math.max(well.width, MIN_COMPASS_PX_MOBILE_WIDTH),
        6,
      );
      // The height stays inside the plate's near edge, where the first discard
      // row begins (2026-11-22).
      expect(mobile.height, viewport.name).toBeCloseTo(
        Math.max(MIN_COMPASS_PX_MOBILE, well.height - 8),
        6,
      );

      // And it stays on stage.
      expect(box.left, viewport.name).toBeGreaterThanOrEqual(0);
      expect(box.top, viewport.name).toBeGreaterThanOrEqual(0);
      expect(box.left + box.width, viewport.name).toBeLessThanOrEqual(width);
      expect(box.top + box.height, viewport.name).toBeLessThanOrEqual(height);
    }
  });

  it('never covers a hand or draw button at any supported aspect', () => {
    for (const viewport of VIEWPORTS) {
      const { width, height } = viewport;
      const frame = frameForAspect(width / height, layout);
      const well = compassPlateRect(frame, { widthPx: width, heightPx: height });
      if (!well) throw new Error(`no compass rect at ${viewport.name}`);
      const box = compassBox(well);
      const right = box.left + box.width;
      const bottom = box.top + box.height;

      const rects = hitRects(layout, frame, { widthPx: width, heightPx: height });
      expect(rects.length, viewport.name).toBeGreaterThan(0);
      for (const rect of rects) {
        const overlaps =
          rect.left < right &&
          rect.left + rect.width > box.left &&
          rect.top < bottom &&
          rect.top + rect.height > box.top;
        expect(overlaps, `${viewport.name} hand slot ${rect.slot}`).toBe(false);
      }
    }
  });

  it('is deterministic and empty before the stage has a size', () => {
    const frame = frameForAspect(16 / 9, layout);
    expect(compassPlateRect(frame, { widthPx: 0, heightPx: 1080 })).toBeNull();
    expect(compassPlateRect(frame, { widthPx: 1920, heightPx: 0 })).toBeNull();
    expect(compassPlateRect(frame, { widthPx: 1920, heightPx: 1080 })).toEqual(
      compassPlateRect(frame, { widthPx: 1920, heightPx: 1080 }),
    );
  });
});
