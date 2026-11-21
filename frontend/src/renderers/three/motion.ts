/**
 * Motion for the 3D table (3D-12): the bounded deal-in, the injectable clock and
 * the reserved draw/discard/meld/flip flight seam.
 *
 * The rule this module exists to enforce is the diff rule (plan §2.3): a new
 * snapshot `revision` is a **cut**, never a move. Every `GameState` the app
 * hands the renderer is a new position — there is no discard/draw stream in the
 * app — so animating a diff between two snapshots would invent moves that never
 * happened. The only motion allowed on a revision change is a single bounded
 * deal-in (≤ {@link DEAL_IN_MS}); a same-revision update (answering, a highlight)
 * is a no-op for positions.
 *
 * The event seam is the exception that proves the rule: `flightWaypoints` and
 * `sampleFlight` give a future live/replay source deterministic, damped-spring
 * tile flight for `draw`/`discard`/`meld`/`flip`, but nothing calls them in v1.
 * `Scene.playEvents()` stays a no-op and the host never invokes it (a test in
 * `RendererHost.test.tsx` pins that).
 *
 * Everything here is pure data and arithmetic: no three.js, no DOM, no timers.
 * The clock is an injected function (`MotionClock.now`) so the tests drive time
 * by hand and never wait on a real animation frame.
 */

import type { RendererEvent } from '../contract';
import { TILE, WALL } from '../layoutConstants';
import type { BoardLayout, BoardTile, TilePose } from './boardLayout';
import type { BoardInstance } from './boardMesh';

/** A world-space point, as `boardLayout` publishes it. */
export type Vec3 = readonly [number, number, number];

/** The deal-in's bound: under 400 ms (plan §3D-12). */
export const DEAL_IN_MS = 400;

/**
 * How far the board starts above its rest pose: half a tile height (14 mm), the
 * same amount as a hover lift, so the settle is the size of one deliberate
 * motion. Every frame of the deal-in is a lift **above** the layout, never
 * through the felt plane.
 */
export const DEAL_IN_LIFT_UNITS = TILE.heightUnits / 2;

/** The felt: the plane the deal-in must never sink through. */
export const FELT_PLANE_Y = 0;

/** One animated event flight's duration, including the spring's tail. */
export const EVENT_FLIGHT_MS = 450;

/** The flight's vertical hop at mid-path, in world units (≈ 24 mm). */
export const EVENT_FLIGHT_ARC_UNITS = 0.85;

/**
 * The answered board's move bound (261121-1206): under 400 ms, the same bound
 * as the deal-in. Every tile that changes pose after an answer reaches its new
 * pose within this window; reduced motion applies the new layout immediately.
 */
export const ANSWER_MOVE_MS = 340;

/**
 * The critically damped spring's normalised rate.
 *
 * `1 - (1 + k·t)·e^{-k·t}` is the step response of a critically damped spring:
 * strictly increasing, never past 1 (so a tile can never overshoot its target or
 * swing through the felt), and 99.9 % settled at `t = 1` for `k = 9`.
 */
export const SPRING_RATE = 9;

/** A monotonic clock, in milliseconds. Injected so tests never wait. */
export interface MotionClock {
  now(): number;
}

/** The browser clock: `performance.now` when present, else `Date.now`. */
export function systemMotionClock(): MotionClock {
  return {
    now(): number {
      const performanceNow = globalThis.performance?.now;
      return typeof performanceNow === 'function'
        ? performanceNow.call(globalThis.performance)
        : Date.now();
    },
  };
}

/**
 * True when a snapshot change is a cut that may play the deal-in once.
 *
 * The very first snapshot is not a change (and the board's atlases load
 * asynchronously after it, so its arrival is already over); a repeated revision
 * is the same position with different flags (an answer, a highlight) and must
 * leave every tile exactly where it is.
 */
export function shouldDealIn(
  previousRevision: number | null,
  nextRevision: number,
): boolean {
  return previousRevision !== null && nextRevision !== previousRevision;
}

/**
 * The deal-in's remaining lift, in world units, `elapsedMs` after the cut.
 *
 * A cubic ease-out from {@link DEAL_IN_LIFT_UNITS} to exactly 0: monotone
 * decreasing, never negative, and exactly zero for every reading at or past
 * {@link DEAL_IN_MS}, so the scene settles to precisely the layout's transforms.
 */
export function dealInLiftUnits(
  elapsedMs: number,
  durationMs: number = DEAL_IN_MS,
): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs >= durationMs) return 0;
  if (elapsedMs <= 0) return DEAL_IN_LIFT_UNITS;
  const remaining = 1 - elapsedMs / durationMs;
  return DEAL_IN_LIFT_UNITS * remaining ** 3;
}

/** One reading of the deal-in: how much lift is left, and whether it is over. */
export interface DealInSample {
  readonly liftUnits: number;
  readonly done: boolean;
}

/**
 * The deal-in's state: which revision is on the table and when its cut started.
 *
 * Owned by `Scene` and driven by the injected clock. `cut()` is the only way a
 * deal-in can start, and it starts only for a genuine revision change — so a
 * non-revision snapshot update is a position no-op by construction.
 */
export class DealInMotion {
  private startedAtMs: number | null = null;
  private revision: number | null = null;

  constructor(
    private readonly clock: MotionClock = systemMotionClock(),
    private readonly reducedMotion = false,
  ) {}

  /**
   * Record a snapshot revision. Returns true when it is a cut that started a
   * deal-in (a new revision, motion allowed, and a previous revision known).
   */
  cut(nextRevision: number): boolean {
    const started = shouldDealIn(this.revision, nextRevision) && !this.reducedMotion;
    this.revision = nextRevision;
    if (started) this.startedAtMs = this.clock.now();
    return started;
  }

  /** The current lift, clearing the animation once it has run out. */
  sample(): DealInSample {
    if (this.startedAtMs === null) return { liftUnits: 0, done: true };
    const elapsed = this.clock.now() - this.startedAtMs;
    if (!Number.isFinite(elapsed) || elapsed >= DEAL_IN_MS) {
      this.startedAtMs = null;
      return { liftUnits: 0, done: true };
    }
    return { liftUnits: dealInLiftUnits(elapsed), done: false };
  }

  /** Whether a deal-in is running (and the scene should keep drawing frames). */
  get active(): boolean {
    return this.startedAtMs !== null;
  }

  /** The revision currently on the table. */
  get shownRevision(): number | null {
    return this.revision;
  }

  /** Stop any running deal-in (reduced motion, teardown). */
  cancel(): void {
    this.startedAtMs = null;
  }
}

/**
 * Raise every instance by `liftUnits` along world +Y, or return the input
 * untouched when there is nothing to do.
 *
 * Returning the same array for a zero lift is what makes the settled frame
 * **exactly** the layout: the caller can assert identity, not a tolerance. A
 * pose matrix is column-major, so its translation is elements 12–14.
 */
export function withVerticalLift(
  instances: readonly BoardInstance[],
  liftUnits: number,
): readonly BoardInstance[] {
  if (!(liftUnits > 0) || !Number.isFinite(liftUnits)) return instances;
  return instances.map((instance) => {
    const matrix = [...instance.matrix];
    matrix[13] += liftUnits;
    return { ...instance, matrix };
  });
}

/**
 * The answered board's motion (261121-1206).
 *
 * `plannedMoves` pairs two layouts by the snapshot's stable `uid` and keeps the
 * tiles whose pose changed; `withMoveProgress` rewrites exactly those poses at
 * one sampled instant, leaving every other tile byte-identical. At progress 1
 * it returns the layout itself, so the settled frame **is** the layout rather
 * than a tolerance match.
 */

/** One tile's change of pose across an answered transition. */
export interface TileMove {
  /** The physical tile's stable identity (the snapshot's `uid`). */
  readonly uid: string;
  readonly from: TilePose;
  readonly to: TilePose;
  /** Vertical hop at mid-path; 0 for a same-zone slide (a hand re-flow). */
  readonly arcUnits: number;
}

/** The flight's mid-path hop, in world units. */
const MOVE_ARC_UNITS = 0.55;

function samePose(left: TilePose, right: TilePose): boolean {
  return (
    left.position[0] === right.position[0] &&
    left.position[1] === right.position[1] &&
    left.position[2] === right.position[2] &&
    left.yawDeg === right.yawDeg &&
    left.tiltDeg === right.tiltDeg &&
    left.rollDeg === right.rollDeg
  );
}

/**
 * Every tile whose pose changed between two layouts, paired by `uid`.
 *
 * A tile present in both layouts but moved is one move. A tile that only
 * appears or only disappears (none in the answered transition: a discard, a
 * call and a kan all move tiles) is not animated, so a mismatch can never
 * invent a flight. The per-tile arc is reserved for a zone change (hand → river,
 * river → meld); a hand's own re-flow slides along the row.
 */
export function plannedMoves(
  previous: BoardLayout,
  next: BoardLayout,
): readonly TileMove[] {
  const before = new Map(previous.tiles.map((tile) => [tile.uid, tile]));
  const moves: TileMove[] = [];
  for (const tile of next.tiles) {
    const from = before.get(tile.uid);
    if (!from || samePose(from.pose, tile.pose)) continue;
    moves.push({
      uid: tile.uid,
      from: from.pose,
      to: tile.pose,
      arcUnits: from.zone !== tile.zone ? MOVE_ARC_UNITS : 0,
    });
  }
  return moves;
}

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/** Shortest-arc interpolation between two yaw angles, in degrees. */
function lerpAngle(from: number, to: number, t: number): number {
  const delta = (((to - from + 540) % 360) + 360) % 360 - 180;
  return from + delta * t;
}

/** One move's pose at `progress` in [0, 1]. Exactly `from` at 0, `to` at 1. */
export function movedPose(move: TileMove, progress: number): TilePose {
  const t = clamp01(progress);
  if (t === 0) return move.from;
  if (t === 1) return move.to;
  const [fx, fy, fz] = move.from.position;
  const [tx, ty, tz] = move.to.position;
  return {
    position: [
      fx + (tx - fx) * t,
      fy + (ty - fy) * t + move.arcUnits * Math.sin(Math.PI * t),
      fz + (tz - fz) * t,
    ],
    yawDeg: lerpAngle(move.from.yawDeg, move.to.yawDeg, t),
    tiltDeg: move.from.tiltDeg + (move.to.tiltDeg - move.from.tiltDeg) * t,
    rollDeg: move.from.rollDeg + (move.to.rollDeg - move.from.rollDeg) * t,
    sizeUnits: move.to.sizeUnits,
  };
}

/**
 * The layout with every planned move's pose interpolated at `progress`.
 *
 * Every derived view (`wall`, `foreground`) is rebuilt from the same tile
 * objects, because the shadow layer reads them too: a discarded tile's contact
 * shadow has to travel with the tile rather than snap to the pond.
 */
export function withMoveProgress(
  layout: BoardLayout,
  moves: readonly TileMove[],
  progress: number,
): BoardLayout {
  if (moves.length === 0 || progress >= 1) return layout;
  const byUid = new Map(moves.map((move) => [move.uid, move]));
  const tiles = layout.tiles.map((tile) => {
    const move = byUid.get(tile.uid);
    return move ? { ...tile, pose: movedPose(move, progress) } : tile;
  });
  const byId = new Map(tiles.map((tile) => [tile.id, tile]));
  return {
    ...layout,
    tiles,
    wall: layout.wall.map((tile) => byId.get(tile.id) ?? tile),
    foreground: layout.foreground.map((tile) => byId.get(tile.id) ?? tile),
  };
}

/** One reading of the answered board's move. */
export interface MoveSample {
  readonly active: boolean;
  readonly progress: number;
  readonly done: boolean;
}

/**
 * The answered transition's animation state.
 *
 * `start` computes the moves once and stamps the clock; `sample` is a pure
 * reading afterwards, clearing itself at {@link ANSWER_MOVE_MS}. Reduced motion
 * never starts one, so the new layout is applied as an instant cut.
 */
export class MoveMotion {
  private startedAtMs: number | null = null;
  private moveList: readonly TileMove[] = [];

  constructor(
    private readonly clock: MotionClock = systemMotionClock(),
    private readonly reducedMotion = false,
  ) {}

  /**
   * Begin animating `previous` → `next`. Returns true when a move is running.
   * A reduced-motion or identical board starts nothing and returns false.
   */
  start(previous: BoardLayout, next: BoardLayout): boolean {
    if (this.reducedMotion) {
      this.cancel();
      return false;
    }
    const moves = plannedMoves(previous, next);
    if (moves.length === 0) {
      this.cancel();
      return false;
    }
    this.moveList = moves;
    this.startedAtMs = this.clock.now();
    return true;
  }

  /** The moves being animated (empty when idle). */
  get plans(): readonly TileMove[] {
    return this.moveList;
  }

  sample(): MoveSample {
    if (this.startedAtMs === null) {
      return { active: false, progress: 1, done: true };
    }
    const elapsed = this.clock.now() - this.startedAtMs;
    if (!Number.isFinite(elapsed) || elapsed >= ANSWER_MOVE_MS) {
      this.startedAtMs = null;
      return { active: false, progress: 1, done: true };
    }
    return {
      active: true,
      progress: springProgress(elapsed, ANSWER_MOVE_MS),
      done: false,
    };
  }

  get active(): boolean {
    return this.startedAtMs !== null;
  }

  cancel(): void {
    this.startedAtMs = null;
    this.moveList = [];
  }
}

/** One event's start and end points, plus the shape of the flight between them. */
export interface FlightWaypoints {
  readonly from: Vec3;
  readonly to: Vec3;
  /** Vertical hop at mid-path; 0 for a flip, which stays in place. */
  readonly arcUnits: number;
  /** Rotation about the tile's own vertical axis by the end, in degrees. */
  readonly turnDeg: number;
}

function seatZoneTiles(
  layout: BoardLayout,
  seat: number,
  zone: BoardTile['zone'],
): BoardTile[] {
  return layout.tiles.filter((tile) => tile.seat === seat && tile.zone === zone);
}

/** The newest discard of a seat (highest river slot), or undefined. */
function newestDiscard(layout: BoardLayout, seat: number): BoardTile | undefined {
  let newest: BoardTile | undefined;
  for (const tile of seatZoneTiles(layout, seat, 'river')) {
    if (!newest || tile.slot > newest.slot) newest = tile;
  }
  return newest;
}

/**
 * A seat's own draw-end stack bottom tile, when the depleted wall still has it.
 *
 * The live wall is now one arc with a single draw edge (`renderers/wall.ts`), so
 * this is only the reserved event seam's cheap landing point: a real draw flight
 * would start at `nextLiveWallSlot`. The fallback in `flightWaypoints` is the
 * draw slot itself, so a missing tile never breaks the animation seam.
 */
function drawEndTile(layout: BoardLayout, seat: number): BoardTile | undefined {
  const slot = seat * WALL.slotsPerRun + WALL.drawEndSlot * WALL.tiers;
  return layout.wall.find((tile) => tile.slot === slot);
}

/**
 * Resolve one renderer event to the two transforms a future live/replay source
 * would interpolate between, or null when the current board cannot show it.
 *
 * - `draw` flies from the seat's wall draw end to its draw slot;
 * - `discard` flies from the hand tile of that face (or the draw) to the seat's
 *   newest pond cell;
 * - `meld` flies the called tile from the caller's newest pond cell to the new
 *   meld tile; a closed kan has no travel;
 * - `flip` stays exactly where it is and turns half a revolution.
 *
 * Unused in v1: no source emits `RendererEvent`s and `playEvents()` is a no-op.
 */
export function flightWaypoints(
  layout: BoardLayout,
  event: RendererEvent,
): FlightWaypoints | null {
  switch (event.kind) {
    case 'draw': {
      const target = layout.tiles.find(
        (tile) => tile.seat === event.seat && tile.zone === 'draw',
      );
      if (!target) return null;
      const source = drawEndTile(layout, event.seat) ?? target;
      return {
        from: source.pose.position,
        to: target.pose.position,
        arcUnits: EVENT_FLIGHT_ARC_UNITS,
        turnDeg: 0,
      };
    }
    case 'discard': {
      const target = newestDiscard(layout, event.seat);
      if (!target) return null;
      const hand = seatZoneTiles(layout, event.seat, 'hand');
      const source =
        hand.find((tile) => tile.face === event.face) ??
        layout.tiles.find(
          (tile) => tile.seat === event.seat && tile.zone === 'draw',
        ) ??
        hand[hand.length - 1];
      if (!source) return null;
      return {
        from: source.pose.position,
        to: target.pose.position,
        arcUnits: EVENT_FLIGHT_ARC_UNITS,
        turnDeg: 0,
      };
    }
    case 'meld': {
      const meldTiles = seatZoneTiles(layout, event.seat, 'meld');
      if (meldTiles.length === 0) return null;
      const target = meldTiles.reduce((newest, tile) =>
        tile.slot > newest.slot ? tile : newest,
      );
      const source =
        event.meld.calledFrom === null
          ? target
          : newestDiscard(layout, event.meld.calledFrom) ?? target;
      return {
        from: source.pose.position,
        to: target.pose.position,
        arcUnits: event.meld.calledFrom === null ? 0 : EVENT_FLIGHT_ARC_UNITS,
        turnDeg: event.meld.kind === 'Ankan' ? 180 : 90,
      };
    }
    case 'flip': {
      const tile =
        layout.tiles.find(
          (candidate) => candidate.zone === 'dora' && candidate.face === event.face,
        ) ?? layout.foreground.find((candidate) => candidate.face === event.face);
      if (!tile) return null;
      return {
        from: tile.pose.position,
        to: tile.pose.position,
        arcUnits: 0,
        turnDeg: 180,
      };
    }
  }
}

/**
 * The damped-spring step response over one flight: 0 at the start, 1 at the
 * end, strictly increasing in between and never above 1.
 */
export function springProgress(
  elapsedMs: number,
  durationMs: number = EVENT_FLIGHT_MS,
): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  if (!(durationMs > 0) || elapsedMs >= durationMs) return 1;
  const t = elapsedMs / durationMs;
  const response = 1 - (1 + SPRING_RATE * t) * Math.exp(-SPRING_RATE * t);
  return Math.min(1, Math.max(0, response));
}

/** One sampled flight frame. */
export interface FlightSample {
  readonly position: Vec3;
  /** Rotation about the tile's own vertical axis so far, in degrees. */
  readonly turnDeg: number;
  /** True once the flight has reached its end transform exactly. */
  readonly done: boolean;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Sample a flight at `elapsedMs` from its start.
 *
 * The horizontal path is the spring-eased straight line between the two
 * transforms; the vertical path adds the arc on top, so it can only ever be at
 * or above the lower endpoint. With both endpoints on the table and the arc
 * positive, every sample has `y >= FELT_PLANE_Y`: the flight cannot overshoot
 * through the felt. The first sample is exactly `from` and every sample at or
 * past `EVENT_FLIGHT_MS` is exactly `to`.
 */
export function sampleFlight(
  flight: FlightWaypoints,
  elapsedMs: number,
  durationMs: number = EVENT_FLIGHT_MS,
): FlightSample {
  if (!Number.isFinite(elapsedMs) || elapsedMs >= durationMs) {
    return { position: flight.to, turnDeg: flight.turnDeg, done: true };
  }
  const t = springProgress(elapsedMs, durationMs);
  const [fx, fy, fz] = flight.from;
  const [tx, ty, tz] = flight.to;
  const position: Vec3 = [
    lerp(fx, tx, t),
    lerp(fy, ty, t) + flight.arcUnits * Math.sin(Math.PI * t),
    lerp(fz, tz, t),
  ];
  return { position, turnDeg: flight.turnDeg * t, done: false };
}
