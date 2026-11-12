import { describe, expect, it } from 'vitest';
import { calledTile } from './meld';
import type { CalledMeld, MeldType } from './types/game';

function meld(
  meldType: MeldType,
  calledFrom: number | null,
  tiles: string[] = ['5z', '5z', '5z'],
): CalledMeld {
  return { meld_type: meldType, tiles, called_from: calledFrom };
}

describe('called tile placement', () => {
  it('puts a Pon called from kamicha on the left', () => {
    // Seat 3 is the player immediately before the human, i.e. on their left.
    expect(calledTile(meld('Pon', 3), 0)).toEqual({
      index: 0,
      from: 'left',
    });
  });

  it('puts a Pon called from toimen in the middle', () => {
    expect(calledTile(meld('Pon', 2), 0)).toEqual({
      index: 1,
      from: 'across',
    });
  });

  it('puts a Pon called from shimocha on the right', () => {
    expect(calledTile(meld('Pon', 1), 0)).toEqual({
      index: 2,
      from: 'right',
    });
  });

  it('reads the source relative to the caller, not the human', () => {
    // Seat 2 calling from seat 1: seat 1 is the previous seat, so kamicha.
    expect(calledTile(meld('Pon', 1), 2)).toEqual({ index: 0, from: 'left' });
    // Seat 1 calling from seat 2: seat 2 is the next seat, so shimocha.
    expect(calledTile(meld('Pon', 2), 1)).toEqual({ index: 2, from: 'right' });
    // Seat 3 calling from seat 1 wraps around the table to toimen.
    expect(calledTile(meld('Pon', 1), 3)).toEqual({
      index: 1,
      from: 'across',
    });
  });

  it('leaves Chi, open Kan, and closed Kan tiles upright', () => {
    expect(calledTile(meld('Chi', 3, ['2s', '3s', '4s']), 0)).toBeNull();
    expect(calledTile(meld('Kan', 2, ['5z', '5z', '5z', '5z']), 0)).toBeNull();
    expect(calledTile(meld('Ankan', null, ['5z', '5z', '5z', '5z']), 0)).toBeNull();
  });

  it('needs a source and three Pon tiles to place the sideways tile', () => {
    expect(calledTile(meld('Pon', null), 0)).toBeNull();
    // A malformed two-tile Pon has no middle slot to trust.
    expect(calledTile(meld('Pon', 2, ['5z', '5z']), 0)).toBeNull();
  });
});
