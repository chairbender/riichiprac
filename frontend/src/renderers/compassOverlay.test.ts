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
    // The visible round is the wind character (2026-11-21); the accessible
    // name keeps the spelled-out word, which is what the drift test compares.
    expect(view.round).toBe('南3');
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

  it('sizes the DOM box from the well, per axis, centred on it', () => {
    const box = compassBox({
      left: 100,
      top: 40,
      width: 300,
      height: 180,
      centreX: 250,
      centreY: 130,
    });
    // The projected plate is a trapezoid, so its box is wider than tall and the
    // readout follows it (2026-11-21): the left and right corners are the ones
    // that run out of room first.
    expect(box).toEqual({ left: 100, top: 40, width: 300, height: 180 });
    expect(box.left + box.width / 2).toBe(250);
    expect(box.top + box.height / 2).toBe(130);
    // The type follows the shorter axis, inside a legible pair of bounds.
    expect(compassFontPx(box)).toBeCloseTo(180 * 0.08, 9);
    expect(compassFontPx({ ...box, width: 20, height: 20 })).toBe(9);
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

      // The box follows the well's rectangle — each axis independent, because
      // the projected plate is wider than tall — and clamps to the legibility
      // floor per axis. Above the floor it never spills past the well.
      expect(box.width, viewport.name).toBeCloseTo(
        Math.max(well.width, MIN_COMPASS_PX),
        6,
      );
      expect(box.height, viewport.name).toBeCloseTo(
        Math.max(well.height, MIN_COMPASS_PX),
        6,
      );
      if (well.width >= MIN_COMPASS_PX) {
        expect(box.left, viewport.name).toBeGreaterThanOrEqual(well.left - 1e-6);
        expect(box.left + box.width, viewport.name).toBeLessThanOrEqual(
          well.left + well.width + 1e-6,
        );
      }
      if (well.height >= MIN_COMPASS_PX) {
        expect(box.top, viewport.name).toBeGreaterThanOrEqual(well.top - 1e-6);
        expect(box.top + box.height, viewport.name).toBeLessThanOrEqual(
          well.top + well.height + 1e-6,
        );
      }

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
