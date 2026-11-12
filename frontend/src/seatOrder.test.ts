import { describe, expect, it } from 'vitest';
import {
  SIDE_ROTATION,
  TABLE_SIDES,
  stackOrder,
  tablePlacements,
} from './seatOrder';
import type { PlayerState } from './types/game';

function player(seat: number, isHuman = false, name = `Seat ${seat}`): PlayerState {
  return {
    seat,
    name,
    is_human: isHuman,
    wind: 'East',
    score: 25000,
    hand: [],
    draw: null,
    red_fives: [],
    discards: [],
    melds: [],
    is_riichi: false,
    riichi_discard_index: null,
  };
}

/** Seat index → side, as the top-down view places them. */
function sidesBySeat(players: PlayerState[]): Record<number, string> {
  const sides: Record<number, string> = {};
  for (const placement of tablePlacements(players)) {
    sides[placement.player.seat] = placement.side;
  }
  return sides;
}

describe('top-down table placement', () => {
  it('puts the human at the bottom and the opponents round in turn order', () => {
    const players = [
      player(0, true),
      player(1),
      player(2),
      player(3),
    ];

    expect(sidesBySeat(players)).toEqual({
      0: 'bottom',
      1: 'right',
      2: 'top',
      3: 'left',
    });
  });

  it('reads counter-clockwise, matching the seat stack and the real table', () => {
    const players = [
      player(0, true),
      player(1),
      player(2),
      player(3),
    ];

    expect(TABLE_SIDES).toEqual(['bottom', 'right', 'top', 'left']);
    // The stack lists the same seats from the top row down: shimocha, toimen,
    // kamicha, human.
    expect(stackOrder(players).map((seat) => seat.seat)).toEqual([1, 2, 3, 0]);
  });

  it('rotates the whole table onto the human seat', () => {
    // An imported report can put the human on seat 2; the turn order then
    // wraps 2 → 3 → 0 → 1, and the human still sits at the bottom.
    const players = [
      player(0),
      player(1),
      player(2, true),
      player(3),
    ];

    expect(sidesBySeat(players)).toEqual({
      2: 'bottom',
      3: 'right',
      0: 'top',
      1: 'left',
    });
  });

  it('turns each seat to face its owner', () => {
    expect(SIDE_ROTATION).toEqual({
      bottom: 0,
      right: 270,
      top: 180,
      left: 90,
    });

    const players = [
      player(0, true),
      player(1),
      player(2),
      player(3),
    ];
    const rotations = Object.fromEntries(
      tablePlacements(players).map((placement) => [
        placement.player.seat,
        placement.rotation,
      ]),
    );

    expect(rotations).toEqual({ 0: 0, 1: 270, 2: 180, 3: 90 });
  });

  it('keeps an incomplete table to the seats that exist', () => {
    const players = [player(0, true), player(2)];

    const placements = tablePlacements(players);

    expect(placements.map((p) => p.side)).toEqual(['bottom', 'top']);
  });

  it('keeps a repeated seat once and puts an unknown seat on the human edge', () => {
    const players = [
      player(0, true),
      player(1, false, 'Shimocha'),
      player(1, false, 'Duplicate shimocha'),
      player(7, false, 'Unknown seat'),
    ];

    const placements = tablePlacements(players);

    // A repeated seat is not a second place at the table, so the first player
    // holding it wins, exactly as the stacked view keeps the first row.
    expect(placements.map((p) => [p.player.name, p.side])).toEqual([
      ['Seat 0', 'bottom'],
      ['Shimocha', 'right'],
      ['Unknown seat', 'bottom'],
    ]);
  });

  it('anchors on seat 0 when no player is marked human', () => {
    const players = [player(0), player(1), player(2), player(3)];

    expect(sidesBySeat(players)).toEqual({
      0: 'bottom',
      1: 'right',
      2: 'top',
      3: 'left',
    });
  });
});
