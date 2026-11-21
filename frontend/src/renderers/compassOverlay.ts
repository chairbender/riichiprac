/**
 * The 3D view's compass model (3D-09): what the four seat groups and the centre
 * group say, derived from the renderer snapshot and nothing else.
 *
 * This module is pure data: no DOM, no three.js. It exists so the DOM compass and
 * its drift test (against `PhysicalTable`) agree on one description of the
 * table, and so the projection only has to supply a rectangle.
 *
 * The wording is `PhysicalTable`'s compass wording, character for character:
 * the accessible name of a seat corner is "East wind, 25000 points, riichi" and
 * the centre is "Round East 1, 60 tiles remaining". `overlay.test.tsx` compares
 * the rendered labels of the two views for the same state rather than trusting
 * this file to stay in step.
 *
 * The *visible* score is Tenhou's split: the hundreds in full type and the last
 * two digits small and grey (`25000` → `250` + `00`). The accessible name keeps
 * the full score, so the presentation can change without changing what a screen
 * reader hears.
 */

import type { Seat, TableSnapshot } from './contract';
import type { LayoutProfile } from './layoutConstants';
import type { Wind } from '../types/game';

/** Where a seat sits as the human reads the screen, in turn order from them. */
export type CompassSide = 'bottom' | 'right' | 'top' | 'left';

/**
 * The four sides in turn order from the human's seat: their own edge at the
 * bottom, then shimocha on the right, toimen across, kamicha on the left.
 * `TableSide`'s order, mirrored here because the 3D chain owns its types.
 */
export const COMPASS_SIDES: readonly CompassSide[] = [
  'bottom',
  'right',
  'top',
  'left',
];

/**
 * What each edge is called for assistive tech. Identical to `PhysicalTable`'s
 * `SIDE_LABELS`; the drift test compares the two views' rendered names, so this
 * copy cannot go stale silently.
 */
export const COMPASS_SIDE_LABELS: Record<CompassSide, string> = {
  bottom: 'your seat, at the bottom',
  right: 'right side, shimocha',
  top: 'across, toimen',
  left: 'left side, kamicha',
};

/**
 * How far each corner turns so its own player reads it upright. The compass
 * turns every seat's stack with its seat, exactly like the tiles on that edge
 * (the 2D plan view's `SIDE_ROTATION`).
 */
export const COMPASS_SIDE_ROTATION: Record<CompassSide, number> = {
  bottom: 0,
  right: 270,
  top: 180,
  left: 90,
};

/** One seat's corner of the compass. */
export interface CompassSeatView {
  readonly seat: Seat;
  readonly side: CompassSide;
  readonly wind: Wind;
  readonly score: number;
  /**
   * The score as the 3D compass prints it: the three-digit hundreds group in
   * full size and the trailing two digits small and grey (Tenhou's display).
   * Every legal riichi score is a multiple of 100, so the tail reads `00`.
   */
  readonly scoreText: CompassScoreText;
  readonly riichi: boolean;
  readonly isHuman: boolean;
  /** The corner's accessible name, exactly as `PhysicalTable` writes it. */
  readonly label: string;
  /** Clockwise turn of the whole stack, in degrees. */
  readonly rotationDeg: number;
}

/**
 * A score split for display: `lead` is the hundreds, `tail` the last two
 * digits. `25000` prints as `250` + `00`.
 */
export interface CompassScoreText {
  readonly lead: string;
  readonly tail: string;
}

/**
 * Split a score the way the 3D compass shows it (Tenhou's score plate): the
 * hundreds in full type and the remaining two digits small. The split is
 * lossless — `lead + tail` is the score — so the visible plate and the
 * accessible name can never disagree, and a tournament score above 99,900
 * simply grows the lead rather than being rounded.
 */
export function formatCompassScore(score: number): CompassScoreText {
  const value = Math.max(0, Math.trunc(Number.isFinite(score) ? score : 0));
  const hundreds = Math.floor(value / 100);
  const tail = value % 100;
  return {
    lead: String(hundreds).padStart(3, '0'),
    tail: String(tail).padStart(2, '0'),
  };
}

/**
 * The round winds as characters, the way a table's own display prints them
 * (user request 2026-11-21: "use the wind character rather than spelling out
 * East or South"). The accessible name keeps the spelled-out word.
 */
const ROUND_WIND_GLYPH: Record<Wind, string> = {
  East: '東',
  South: '南',
  West: '西',
  North: '北',
};

/** The whole compass: four corners plus the round / tiles-left centre. */
export interface CompassView {
  /** One entry per seat, in {@link COMPASS_SIDES} order. */
  readonly seats: readonly CompassSeatView[];
  /** The round as it is written on the table, e.g. `East 1`. */
  readonly round: string;
  readonly tilesRemaining: number;
  /** The centre group's accessible name, as `PhysicalTable` writes it. */
  readonly label: string;
}

/**
 * The compass for a snapshot.
 *
 * A seat's edge follows the human: seat `humanSeat` is the bottom, the next
 * seat in turn order the right edge, and so on. That is
 * `tablePlacements`' own rule, restated against the snapshot's absolute seats.
 */
export function compassView(
  snapshot: TableSnapshot,
  profile: LayoutProfile = 'desktop',
): CompassView {
  const seats = snapshot.seats.map((seatState): CompassSeatView => {
    const step = (seatState.seat - snapshot.humanSeat + 4) % 4;
    const side = COMPASS_SIDES[step];
    const score = seatState.score;
    return {
      seat: seatState.seat,
      side,
      wind: seatState.wind,
      score,
      scoreText: formatCompassScore(score),
      riichi: seatState.riichi,
      isHuman: seatState.seat === snapshot.humanSeat,
      label: `${seatState.wind} wind, ${score} points${
        seatState.riichi ? ', riichi' : ''
      }`,
      rotationDeg: COMPASS_SIDE_ROTATION[side],
    };
  });
  // The four sides are unique for four legal seats, so this is the side order;
  // sorting also keeps a malformed snapshot from reordering the compass.
  seats.sort(
    (left, right) =>
      COMPASS_SIDES.indexOf(left.side) - COMPASS_SIDES.indexOf(right.side),
  );

  const { roundWind, handNumber, tilesRemaining } = snapshot.compass;
  return {
    seats,
    // Mobile prints the wind character (2026-11-21); desktop keeps the word.
    round:
      profile === 'mobile'
        ? `${ROUND_WIND_GLYPH[roundWind]}${handNumber}`
        : `${roundWind} ${handNumber}`,
    tilesRemaining,
    label: `Round ${roundWind} ${handNumber}, ${tilesRemaining} tiles remaining`,
  };
}

/** A CSS-pixel box, in the full-window stage. */
export interface CompassBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The smallest compass the DOM draws.
 *
 * A stage whose plate projects smaller than this would put the four score rows
 * on top of each other, so the square stops shrinking here and simply overhangs
 * the plate's projected corners. It is still centred on the plate and still
 * clear of the hand.
 *
 * 2026-11-21: 132 → 84. The plate itself shrank a tile width per side (user
 * request) so the discards could run in to it, and the readout followed: the
 * visible round is now a wind **glyph** (`東1`) rather than "East 1", which is
 * what buys the width back. A landscape phone projects the plate at 76–83 px,
 * so the square now sits just over its corners instead of a third larger than
 * them.
 */
export const MIN_COMPASS_PX = 132;

/** The mobile floor (2026-11-21): the smaller plate's readout still has to fit. */
export const MIN_COMPASS_PX_MOBILE = 84;

/**
 * The mobile box's minimum **width**.
 *
 * The mobile plate is a tile width smaller per side than the desktop one, which
 * leaves the left and right score corners 36 px of column at the plate's own
 * projected width. The DOM box may overhang the plate (it always has), so the
 * mobile box keeps 118 px of width: two ~50 px columns for the corner rows,
 * with the same 84 px height floor. This is what replaced "grow the plate back"
 * as the answer to a cramped readout.
 */
export const MIN_COMPASS_PX_MOBILE_WIDTH = 118;

/**
 * The DOM compass box, centred on the projected plate.
 *
 * The projected plate is a trapezoid (a perspective square viewed at a pitch),
 * so its stated box is a bounding rectangle — **wider than tall** on a
 * landscape stage. The readout follows that rectangle rather than being forced
 * square (2026-11-21): the left and right score corners are what run out of room
 * first, and the plate's own footprint has the width to give them. Each axis
 * stops at {@link MIN_COMPASS_PX} rather than shrinking into illegibility, so a
 * very small plate overhangs the plate's corners equally on both axes.
 *
 * The 3×3 grid inside is unchanged, and the box stays centred on the plate's
 * centre, so the table's centre remains the middle of the display.
 */
export function compassBox(
  rect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
    readonly centreX: number;
    readonly centreY: number;
  },
  profile: LayoutProfile = 'desktop',
): CompassBox {
  if (profile === 'mobile') {
    // The phone readout follows the plate's rectangle and its own floor.
    const width = Math.max(rect.width, MIN_COMPASS_PX_MOBILE_WIDTH);
    const height = Math.max(rect.height, MIN_COMPASS_PX_MOBILE);
    return {
      left: rect.centreX - width / 2,
      top: rect.centreY - height / 2,
      width,
      height,
    };
  }
  // Desktop keeps the committed square: the plate's shorter side, floored.
  const size = Math.max(Math.min(rect.width, rect.height), MIN_COMPASS_PX);
  return {
    left: rect.centreX - size / 2,
    top: rect.centreY - size / 2,
    width: size,
    height: size,
  };
}

/**
 * The compass's own type size for a box, in CSS pixels.
 *
 * Every part of the display is sized in `em` from this one number, the way
 * `PhysicalTable` sizes its compass from the plan's lane width, so the whole
 * overlay grows and shrinks with the projected plate instead of staying a fixed
 * stamp. The user asked for the numbers to be bigger (2026-11-19), so this base
 * is 8 % of the square and the score lead is 1.5 em on top of it. The floor
 * keeps the smallest supported stage legible; the ceiling keeps a very large
 * stage from turning the centre of the table into a billboard.
 */
export function compassFontPx(
  box: CompassBox,
  profile: LayoutProfile = 'desktop',
): number {
  /*
   * The *shorter* axis drives the type, because the rows and the score corners
   * both have to fit: a wide, short box must not print type a tall one could
   * not. The mobile floor is 9 px (2026-11-21), which is what keeps the score
   * digits and the round character distinct in the smaller box; desktop keeps
   * the committed 11 px.
   */
  const floor = profile === 'mobile' ? 9 : 11;
  return Math.min(30, Math.max(floor, Math.min(box.width, box.height) * 0.08));
}
