/**
 * Motion for the 3D table (3D-12 acceptance).
 *
 * Everything here is arithmetic over the layout and an injected clock, so the
 * "new revision = cut" rule, the bounded deal-in and the reserved flight seam
 * are verified as numbers without a GPU, a canvas or a real timer.
 */

import { describe, expect, it } from 'vitest';
import type { RendererEvent, TableSnapshot } from '../contract';
import { TILE, WALL } from '../layoutConstants';
import { boardFixture } from './boardFixture';
import { layoutBoard, poseMatrix } from './boardLayout';
import { buildBoardInstances, NEUTRAL_ATLAS_RECT } from './boardMesh';
import {
  DEAL_IN_LIFT_UNITS,
  DEAL_IN_MS,
  DealInMotion,
  EVENT_FLIGHT_MS,
  FELT_PLANE_Y,
  dealInLiftUnits,
  flightWaypoints,
  sampleFlight,
  shouldDealIn,
  springProgress,
  withVerticalLift,
} from './motion';

const snapshot = boardFixture();
const layout = layoutBoard(snapshot);
const instances = buildBoardInstances(layout, () => ({
  rect: NEUTRAL_ATLAS_RECT,
}));

/** A hand-driven clock, so no test waits on a frame or a timer. */
function fakeClock(start = 1000): {
  clock: { now: () => number };
  advance: (ms: number) => void;
} {
  let now = start;
  return {
    clock: { now: () => now },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('3D-12 diff rule: a new revision is a cut', () => {
  it('starts a deal-in only for a genuine revision change', () => {
    // The first snapshot is the mount, not a change: its atlases load after it
    // and its arrival would already be over.
    expect(shouldDealIn(null, 1)).toBe(false);
    // Answering, highlighting or unlocking is the same position with new flags.
    expect(shouldDealIn(1, 1)).toBe(false);
    // A new hand is a cut, in either direction of the counter.
    expect(shouldDealIn(1, 2)).toBe(true);
    expect(shouldDealIn(2, 1)).toBe(true);
  });

  it('never restarts the deal-in for a same-revision update', () => {
    const { clock, advance } = fakeClock();
    const dealIn = new DealInMotion(clock);

    expect(dealIn.cut(1)).toBe(false);
    expect(dealIn.sample()).toEqual({ liftUnits: 0, done: true });

    expect(dealIn.cut(2)).toBe(true);
    expect(dealIn.sample().liftUnits).toBe(DEAL_IN_LIFT_UNITS);
    advance(150);

    // Answering mid-deal-in sends the same revision again: not a new cut.
    expect(dealIn.cut(2)).toBe(false);
    // Time keeps running from the original cut rather than restarting.
    advance(DEAL_IN_MS);
    expect(dealIn.sample()).toEqual({ liftUnits: 0, done: true });
    expect(dealIn.active).toBe(false);
  });

  it('leaves every pose identical when only the answered flag changes', () => {
    // The host bumps `locked` on an answer without touching the revision. That
    // is the "non-revision snapshot change" the acceptance criterion names: the
    // layout must be byte-for-byte the same picture, so nothing can animate.
    const answered = layoutBoard({ ...snapshot, locked: true });
    expect(answered.tiles).toHaveLength(layout.tiles.length);
    layout.tiles.forEach((tile, index) => {
      const other = answered.tiles[index];
      expect(other.id).toBe(tile.id);
      expect(other.pose).toEqual(tile.pose);
    });

    const answeredInstances = buildBoardInstances(answered, () => ({
      rect: NEUTRAL_ATLAS_RECT,
    }));
    answeredInstances.forEach((instance, index) => {
      expect(instance.matrix).toEqual(instances[index].matrix);
    });
  });
});

describe('3D-12 bounded deal-in', () => {
  it('is bounded at 400 ms and starts at half a tile height', () => {
    expect(DEAL_IN_MS).toBe(400);
    expect(DEAL_IN_MS).toBeLessThanOrEqual(400);
    expect(DEAL_IN_LIFT_UNITS).toBe(TILE.heightUnits / 2);
  });

  it('decays monotonically to exactly zero and never sinks', () => {
    expect(dealInLiftUnits(0)).toBe(DEAL_IN_LIFT_UNITS);
    let previous = dealInLiftUnits(0);
    for (let elapsed = 1; elapsed <= DEAL_IN_MS; elapsed += 1) {
      const lift = dealInLiftUnits(elapsed);
      expect(lift, `lift at ${elapsed} ms`).toBeGreaterThanOrEqual(0);
      expect(lift, `lift at ${elapsed} ms`).toBeLessThanOrEqual(previous);
      previous = lift;
    }
    expect(dealInLiftUnits(DEAL_IN_MS)).toBe(0);
    expect(dealInLiftUnits(DEAL_IN_MS + 10_000)).toBe(0);
    expect(dealInLiftUnits(Number.NaN)).toBe(0);
  });

  it('lifts every instance by the same amount and settles exactly', () => {
    // A zero lift is not a copy: it is the settled frame itself, which is what
    // lets the scene prove it returned to the layout's transforms.
    expect(withVerticalLift(instances, 0)).toBe(instances);

    const lifted = withVerticalLift(instances, DEAL_IN_LIFT_UNITS);
    lifted.forEach((instance, index) => {
      const base = instances[index];
      expect(instance.matrix[12]).toBe(base.matrix[12]);
      expect(instance.matrix[13]).toBeCloseTo(
        base.matrix[13] + DEAL_IN_LIFT_UNITS,
        12,
      );
      expect(instance.matrix[14]).toBe(base.matrix[14]);
      expect(instance.face).toBe(base.face);
      expect(instance.flags).toBe(base.flags);
    });
    // Every lifted tile is still above the felt (the lift is always upward).
    lifted.forEach((instance) => {
      expect(instance.matrix[13]).toBeGreaterThan(FELT_PLANE_Y);
    });
  });

  it('settles back onto exactly the layout matrices', () => {
    layout.tiles.forEach((tile, index) => {
      const settled = poseMatrix(tile.pose);
      expect(instances[index].matrix).toEqual(settled);
      expect(withVerticalLift(instances, 0)[index].matrix).toEqual(settled);
    });
  });

  it('plays nothing under reduced motion', () => {
    const { clock, advance } = fakeClock();
    const dealIn = new DealInMotion(clock, true);
    expect(dealIn.cut(1)).toBe(false);
    advance(100);
    expect(dealIn.cut(2)).toBe(false);
    expect(dealIn.active).toBe(false);
    expect(dealIn.sample()).toEqual({ liftUnits: 0, done: true });
  });
});

describe('3D-12 event seam (reserved: not called in v1)', () => {
  /** Resolve one event and assert the invariants every flight kind shares. */
  function resolve(event: RendererEvent): NonNullable<ReturnType<typeof flightWaypoints>> {
    const flight = flightWaypoints(layout, event);
    expect(flight, `${event.kind} resolves on this board`).not.toBeNull();
    if (!flight) throw new Error(`no waypoints for ${event.kind}`);

    expect(sampleFlight(flight, 0)).toEqual({
      position: flight.from,
      turnDeg: 0,
      done: false,
    });
    const end = sampleFlight(flight, EVENT_FLIGHT_MS);
    expect(end.done).toBe(true);
    expect(end.position).toEqual(flight.to);
    expect(end.turnDeg).toBe(flight.turnDeg);

    // No overshoot through the felt, and no dip below either endpoint.
    const floor = Math.min(flight.from[1], flight.to[1]);
    let previous = -1;
    for (let elapsed = 0; elapsed <= EVENT_FLIGHT_MS; elapsed += 5) {
      const sample = sampleFlight(flight, elapsed);
      expect(sample.position[1]).toBeGreaterThanOrEqual(FELT_PLANE_Y);
      expect(sample.position[1]).toBeGreaterThanOrEqual(floor - 1e-12);
      // Monotonic time: the eased progress never goes backwards.
      const progress = springProgress(elapsed);
      expect(progress).toBeGreaterThanOrEqual(previous);
      expect(progress).toBeLessThanOrEqual(1);
      previous = progress;
    }
    return flight;
  }

  it('flies a draw from the seat’s wall draw end to its draw slot', () => {
    const flight = resolve({ kind: 'draw', seat: 0, face: '1m' });
    const draw = layout.tiles.find(
      (tile) => tile.seat === 0 && tile.zone === 'draw',
    );
    const drawEnd = layout.wall.find(
      (tile) => tile.slot === WALL.drawEndSlot * WALL.tiers,
    );
    expect(flight.to).toEqual(draw?.pose.position);
    expect(flight.from).toEqual(drawEnd?.pose.position);
  });

  it('flies a discard from the hand (or draw) to the newest pond cell', () => {
    const seat = 2;
    const hand = layout.tiles.filter(
      (tile) => tile.seat === seat && tile.zone === 'hand',
    );
    const handTile = hand[0];
    if (!handTile) throw new Error('the fixture has no seat 2 hand');
    const flight = resolve({
      kind: 'discard',
      seat: 2,
      face: handTile.face,
      riichi: false,
    });
    const newest = layout.tiles
      .filter((tile) => tile.seat === seat && tile.zone === 'river')
      .reduce((latest, tile) => (tile.slot > latest.slot ? tile : latest));
    expect(flight.to).toEqual(newest.pose.position);
    expect(flight.from).toEqual(handTile.pose.position);
  });

  it('flies a called meld tile from the caller’s pond to the meld', () => {
    const meld = snapshot.seats[1].melds[0];
    const flight = resolve({ kind: 'meld', seat: 1, meld });
    const meldTile = layout.tiles
      .filter((tile) => tile.seat === 1 && tile.zone === 'meld')
      .reduce((latest, tile) => (tile.slot > latest.slot ? tile : latest));
    expect(flight.from).not.toEqual(flight.to);
    expect(flight.to).toEqual(meldTile.pose.position);
    expect(flight.turnDeg).toBe(90);
  });

  it('keeps a closed kan in place, turning the tiles over', () => {
    const kan = {
      ...snapshot.seats[0].melds[0],
      kind: 'Ankan' as const,
      calledFrom: null,
    };
    const flight = resolve({ kind: 'meld', seat: 0, meld: kan });
    expect(flight.from).toEqual(flight.to);
    expect(flight.turnDeg).toBe(180);
  });

  it('flips a revealed tile in place', () => {
    const dora = snapshot.dora[0];
    const flight = resolve({ kind: 'flip', face: dora.face });
    const doraTile = layout.tiles.find((tile) => tile.zone === 'dora');
    expect(flight.from).toEqual(doraTile?.pose.position);
    expect(flight.to).toEqual(doraTile?.pose.position);
    expect(flight.arcUnits).toBe(0);
    const halfway = sampleFlight(flight, EVENT_FLIGHT_MS / 2);
    expect(halfway.position).toEqual(flight.from);
    expect(halfway.turnDeg).toBeGreaterThan(0);
    expect(halfway.turnDeg).toBeLessThan(180);
  });

  it('has no waypoints for an event the board cannot show', () => {
    // A snapshot dealt without a draw has nowhere for a draw flight to land.
    const noDraw: TableSnapshot = {
      ...snapshot,
      seats: snapshot.seats.map((seat) => ({
        ...seat,
        draw: null,
      })) as unknown as TableSnapshot['seats'],
    };
    expect(
      flightWaypoints(layoutBoard(noDraw), { kind: 'draw', seat: 0, face: '1m' }),
    ).toBeNull();
  });
});
