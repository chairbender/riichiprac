import { describe, expect, it } from 'vitest';
import type {
  CalledMeld,
  DiscardTile,
  GameState,
  PlayerState,
} from '../types/game';
import { WALL } from './layoutConstants';
import { snapshotFromGameState, withPreviewRiichi } from './snapshot';

const HAND_13 = [
  '1m',
  '2m',
  '3m',
  '4m',
  '5m',
  '6m',
  '7m',
  '8m',
  '9m',
  '1p',
  '2p',
  '3p',
  '4p',
];

function player(
  overrides: Partial<PlayerState> & { seat: number },
): PlayerState {
  return {
    name: overrides.seat === 0 ? 'You' : `Seat ${overrides.seat}`,
    is_human: overrides.seat === 0,
    wind: 'East',
    score: 25000,
    hand: [...HAND_13],
    draw: null,
    red_fives: [],
    discards: [],
    melds: [],
    is_riichi: false,
    riichi_discard_index: null,
    ...overrides,
  };
}

function game(overrides: Partial<GameState> = {}): GameState {
  return {
    category: 'test',
    target_action: 'NaniKiru',
    correct_action: { type: 'dama', discard: '4p' },
    decision: { kind: 'self_turn' },
    riichi_triggers: [],
    dama_reasons: [],
    shouminkan_triggers: [],
    hand_string: '',
    tiles: [],
    shanten: 0,
    is_agari: false,
    decompositions_count: 1,
    ukeire_tiles: [],
    ukeire_total: 0,
    round_wind: 'East',
    hand_number: 1,
    honba: 0,
    riichi_sticks: 0,
    dora_indicators: ['1z'],
    ura_dora_indicators: [],
    tiles_remaining: 70,
    current_turn: 0,
    players: [player({ seat: 0 }), player({ seat: 1 }), player({ seat: 2 }), player({ seat: 3 })],
    ...overrides,
  };
}

function discard(
  tile: string,
  flags: Partial<DiscardTile> = {},
): DiscardTile {
  return {
    tile,
    is_riichi: false,
    is_tsumogiri: false,
    ...flags,
  };
}

function meld(
  meldType: CalledMeld['meld_type'],
  tiles: string[],
  calledFrom: number | null,
): CalledMeld {
  return { meld_type: meldType, tiles, called_from: calledFrom };
}

describe('snapshotFromGameState: seats and hands', () => {
  it('keeps a 13-tile hand with no draw at 13 slots and no draw tile', () => {
    const snapshot = snapshotFromGameState(game(), 0, false);
    const seat = snapshot.seats[0];

    expect(seat.concealed).toHaveLength(13);
    expect(seat.concealed.map((tile) => tile.slot)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(seat.concealed.every((tile) => tile.zone === 'hand')).toBe(true);
    expect(seat.draw).toBeNull();
  });

  it('puts the draw in the next hand slot', () => {
    const snapshot = snapshotFromGameState(
      game({
        players: [
          player({ seat: 0, hand: HAND_13.slice(0, 10), draw: '9p' }),
          player({ seat: 1 }),
          player({ seat: 2 }),
          player({ seat: 3 }),
        ],
      }),
      0,
      false,
    );

    expect(snapshot.seats[0].concealed).toHaveLength(10);
    expect(snapshot.seats[0].draw).toMatchObject({
      face: '9p',
      zone: 'draw',
      slot: 10,
      faceUp: true,
      sideways: false,
    });
  });

  it('reduces the concealed count by one meld (13 -> 10) and two (13 -> 7)', () => {
    const oneMeld = snapshotFromGameState(
      game({
        players: [
          player({
            seat: 0,
            hand: HAND_13.slice(0, 10),
            melds: [meld('Pon', ['1z', '1z', '1z'], 1)],
          }),
          player({ seat: 1 }),
          player({ seat: 2 }),
          player({ seat: 3 }),
        ],
      }),
      0,
      false,
    );
    expect(oneMeld.seats[0].concealed).toHaveLength(10);
    expect(oneMeld.seats[0].melds[0].tiles).toHaveLength(3);

    const twoMelds = snapshotFromGameState(
      game({
        players: [
          player({
            seat: 0,
            hand: HAND_13.slice(0, 7),
            melds: [
              meld('Pon', ['1z', '1z', '1z'], 1),
              meld('Chi', ['2m', '3m', '4m'], 3),
            ],
          }),
          player({ seat: 1 }),
          player({ seat: 2 }),
          player({ seat: 3 }),
        ],
      }),
      0,
      false,
    );
    expect(twoMelds.seats[0].concealed).toHaveLength(7);
    expect(twoMelds.seats[0].melds).toHaveLength(2);
  });

  it('keeps the engine hand order rather than sorting', () => {
    const snapshot = snapshotFromGameState(
      game({
        players: [
          player({ seat: 0, hand: ['9p', '1m', '5z'] }),
          player({ seat: 1 }),
          player({ seat: 2 }),
          player({ seat: 3 }),
        ],
      }),
      0,
      false,
    );
    expect(snapshot.seats[0].concealed.map((tile) => tile.face)).toEqual([
      '9p',
      '1m',
      '5z',
    ]);
  });

  it('indexes seats absolutely and reports the human seat', () => {
    const snapshot = snapshotFromGameState(
      game({
        players: [
          player({ seat: 0, is_human: false, wind: 'South', score: 31000 }),
          player({ seat: 1, wind: 'West', score: 24000 }),
          player({ seat: 2, is_human: true, name: 'Me', wind: 'North', score: 26000 }),
          player({ seat: 3, wind: 'East', score: 29000 }),
        ],
      }),
      3,
      false,
    );

    expect(snapshot.humanSeat).toBe(2);
    expect(snapshot.seats.map((seat) => seat.seat)).toEqual([0, 1, 2, 3]);
    expect(snapshot.seats.map((seat) => seat.wind)).toEqual([
      'South',
      'West',
      'North',
      'East',
    ]);
    expect(snapshot.seats.map((seat) => seat.score)).toEqual([
      31000, 24000, 26000, 29000,
    ]);
    expect(snapshot.seats[0].wind).toBe('South');
  });

  it('keeps the first player for a duplicated seat, like the plan view', () => {
    const snapshot = snapshotFromGameState(
      game({
        players: [
          player({ seat: 0 }),
          player({ seat: 1, score: 1000 }),
          player({ seat: 1, score: 9999 }),
          player({ seat: 2 }),
          player({ seat: 3 }),
        ],
      }),
      0,
      false,
    );
    expect(snapshot.seats[1].score).toBe(1000);
  });

  it('fails loudly when the table cannot be drawn honestly', () => {
    const missingSeat = game({
      players: [
        player({ seat: 0 }),
        player({ seat: 1 }),
        player({ seat: 2 }),
      ],
    });
    expect(() => snapshotFromGameState(missingSeat, 0, false)).toThrow(
      /no player at seat 3/,
    );

    const noHuman = game({
      players: [
        player({ seat: 0, is_human: false }),
        player({ seat: 1 }),
        player({ seat: 2 }),
        player({ seat: 3 }),
      ],
    });
    expect(() => snapshotFromGameState(noHuman, 0, false)).toThrow(
      /no human player/,
    );
  });
});

describe('snapshotFromGameState: red fives', () => {
  it('maps red_fives in hand order and leaves a plain five plain', () => {
    const snapshot = snapshotFromGameState(
      game({
        players: [
          player({
            seat: 0,
            hand: ['5m', '5m', '5p', '3s'],
            red_fives: ['5m'],
          }),
          player({ seat: 1 }),
          player({ seat: 2 }),
          player({ seat: 3 }),
        ],
      }),
      0,
      false,
    );

    expect(snapshot.seats[0].concealed.map((tile) => tile.face)).toEqual([
      '5mr',
      '5m',
      '5p',
      '3s',
    ]);
  });

  it('allocates the draw after the hand and keeps a plain 5m plain', () => {
    const snapshot = snapshotFromGameState(
      game({
        players: [
          player({ seat: 0, hand: ['5m'], red_fives: ['5m'], draw: '5m' }),
          player({ seat: 1 }),
          player({ seat: 2 }),
          player({ seat: 3 }),
        ],
      }),
      0,
      false,
    );

    expect(snapshot.seats[0].concealed[0].face).toBe('5mr');
    expect(snapshot.seats[0].draw?.face).toBe('5m');
  });

  it('maps a discarded red five from discard.is_red', () => {
    const snapshot = snapshotFromGameState(
      game({
        players: [
          player({ seat: 0 }),
          player({
            seat: 1,
            discards: [
              discard('5p', { is_red: true }),
              discard('5p'),
              discard('5m', { is_red: false }),
            ],
          }),
          player({ seat: 2 }),
          player({ seat: 3 }),
        ],
      }),
      0,
      false,
    );

    expect(snapshot.seats[1].river.map((tile) => tile.face)).toEqual([
      '5pr',
      '5p',
      '5m',
    ]);
  });
});

describe('snapshotFromGameState: river flags', () => {
  it('turns a riichi declaration tile sideways when the discard says so', () => {
    const snapshot = snapshotFromGameState(
      game({
        players: [
          player({ seat: 0 }),
          player({
            seat: 1,
            is_riichi: true,
            discards: [
              discard('2p'),
              discard('7s', { is_riichi: true }),
              discard('3m'),
            ],
          }),
          player({ seat: 2 }),
          player({ seat: 3 }),
        ],
      }),
      0,
      false,
    );

    expect(snapshot.seats[1].river.map((tile) => tile.sideways)).toEqual([
      false,
      true,
      false,
    ]);
    expect(snapshot.seats[1].riichi).toBe(true);
  });

  it('honours riichi_discard_index when the discard flag is absent', () => {
    const snapshot = snapshotFromGameState(
      game({
        players: [
          player({ seat: 0 }),
          player({
            seat: 1,
            is_riichi: true,
            riichi_discard_index: 1,
            discards: [discard('2p'), discard('7s'), discard('3m')],
          }),
          player({ seat: 2 }),
          player({ seat: 3 }),
        ],
      }),
      0,
      false,
    );

    expect(snapshot.seats[1].riichiDiscardIndex).toBe(1);
    expect(snapshot.seats[1].river.map((tile) => tile.sideways)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('drops an out-of-range riichi_discard_index instead of marking a tile', () => {
    const snapshot = snapshotFromGameState(
      game({
        players: [
          player({ seat: 0 }),
          player({
            seat: 1,
            is_riichi: true,
            riichi_discard_index: 9,
            discards: [discard('2p')],
          }),
          player({ seat: 2 }),
          player({ seat: 3 }),
        ],
      }),
      0,
      false,
    );

    expect(snapshot.seats[1].riichiDiscardIndex).toBeNull();
    expect(snapshot.seats[1].river[0].sideways).toBe(false);
  });

  it('marks a tsumogiri discard as dimmed', () => {
    const snapshot = snapshotFromGameState(
      game({
        players: [
          player({ seat: 0 }),
          player({
            seat: 1,
            discards: [
              discard('2p'),
              discard('7s', { is_tsumogiri: true }),
            ],
          }),
          player({ seat: 2 }),
          player({ seat: 3 }),
        ],
      }),
      0,
      false,
    );

    expect(snapshot.seats[1].river[0].dimmed).toBeUndefined();
    expect(snapshot.seats[1].river[1].dimmed).toBe(true);
  });
});

describe('snapshotFromGameState: melds', () => {
  it('turns the called tile sideways and keeps calledFrom absolute', () => {
    const snapshot = snapshotFromGameState(
      game({
        players: [
          player({
            seat: 0,
            hand: HAND_13.slice(0, 10),
            melds: [
              meld('Pon', ['1z', '1z', '1z'], 1),
              meld('Chi', ['2m', '3m', '4m'], 3),
            ],
          }),
          player({ seat: 1 }),
          player({ seat: 2 }),
          player({ seat: 3 }),
        ],
      }),
      0,
      false,
    );

    const [pon, chi] = snapshot.seats[0].melds;
    expect(pon.kind).toBe('Pon');
    expect(pon.calledFrom).toBe(1);
    // A Pon called from shimocha puts the called tile last.
    expect(pon.tiles.map((tile) => tile.sideways)).toEqual([
      false,
      false,
      true,
    ]);
    expect(chi.kind).toBe('Chi');
    expect(chi.calledFrom).toBe(3);
    // A Chi can only claim kamicha's discard, which sits first.
    expect(chi.tiles.map((tile) => tile.sideways)).toEqual([
      true,
      false,
      false,
    ]);
    expect(pon.tiles.every((tile) => tile.zone === 'meld')).toBe(true);
    expect(pon.tiles.map((tile) => tile.slot)).toEqual([0, 1, 2]);
  });

  it('leaves a closed kan fully upright', () => {
    const snapshot = snapshotFromGameState(
      game({
        players: [
          player({
            seat: 0,
            hand: HAND_13.slice(0, 10),
            melds: [meld('Ankan', ['4s', '4s', '4s', '4s'], null)],
          }),
          player({ seat: 1 }),
          player({ seat: 2 }),
          player({ seat: 3 }),
        ],
      }),
      0,
      false,
    );

    const [kan] = snapshot.seats[0].melds;
    expect(kan.calledFrom).toBeNull();
    expect(kan.tiles.every((tile) => !tile.sideways)).toBe(true);
  });
});

describe('snapshotFromGameState: highlight and lock', () => {
  it('highlights the newest discard a react_to_discard offer names', () => {
    const snapshot = snapshotFromGameState(
      game({
        decision: { kind: 'react_to_discard', from: 2, tile: '7s' },
        players: [
          player({ seat: 0 }),
          player({ seat: 1 }),
          player({ seat: 2, discards: [discard('2p'), discard('7s')] }),
          player({ seat: 3 }),
        ],
      }),
      0,
      false,
    );

    expect(snapshot.highlightDiscard).toEqual({ seat: 2, index: 1 });
    expect(snapshot.seats[2].river.map((tile) => tile.highlighted)).toEqual([
      undefined,
      true,
    ]);
  });

  it('is null when no offer names a claimable discard', () => {
    const noOffer = snapshotFromGameState(game(), 0, false);
    expect(noOffer.highlightDiscard).toBeNull();

    const kanOffer = snapshotFromGameState(
      game({ decision: { kind: 'react_to_kan', from: 1, tile: '5z' } }),
      0,
      false,
    );
    expect(kanOffer.highlightDiscard).toBeNull();

    const staleTile = snapshotFromGameState(
      game({
        decision: { kind: 'react_to_discard', from: 2, tile: '5z' },
        players: [
          player({ seat: 0 }),
          player({ seat: 1 }),
          player({ seat: 2, discards: [discard('7s')] }),
          player({ seat: 3 }),
        ],
      }),
      0,
      false,
    );
    expect(staleTile.highlightDiscard).toBeNull();

    const emptyRiver = snapshotFromGameState(
      game({ decision: { kind: 'react_to_discard', from: 1, tile: '7s' } }),
      0,
      false,
    );
    expect(emptyRiver.highlightDiscard).toBeNull();
  });

  it('lets the host override or clear the highlight', () => {
    const overridden = snapshotFromGameState(
      game({
        players: [
          player({ seat: 0 }),
          player({ seat: 1, discards: [discard('2p')] }),
          player({ seat: 2 }),
          player({ seat: 3 }),
        ],
      }),
      0,
      false,
      { seat: 1, index: 0 },
    );
    expect(overridden.highlightDiscard).toEqual({ seat: 1, index: 0 });
    expect(overridden.seats[1].river[0].highlighted).toBe(true);

    const clear = snapshotFromGameState(
      game({ decision: { kind: 'react_to_discard', from: 2, tile: '7s' } }),
      0,
      false,
      null,
    );
    expect(clear.highlightDiscard).toBeNull();

    const outOfRange = snapshotFromGameState(game(), 0, false, {
      seat: 2,
      index: 4,
    });
    expect(outOfRange.highlightDiscard).toBeNull();
  });

  it('carries the answered/locked flag and the revision verbatim', () => {
    expect(snapshotFromGameState(game(), 7, false).locked).toBe(false);
    expect(snapshotFromGameState(game(), 7, true).locked).toBe(true);
    expect(snapshotFromGameState(game(), 7, false).revision).toBe(7);
  });

  it('rejects a revision that is not a non-negative integer', () => {
    expect(() => snapshotFromGameState(game(), -1, false)).toThrow(/revision/);
    expect(() => snapshotFromGameState(game(), 1.5, false)).toThrow(/revision/);
    expect(() => snapshotFromGameState(game(), Number.NaN, false)).toThrow(
      /revision/,
    );
  });
});

describe('snapshotFromGameState: dora and wall', () => {
  it('places dora indicators face-up in published order', () => {
    const snapshot = snapshotFromGameState(
      game({ dora_indicators: ['3s', '5z'] }),
      0,
      false,
    );

    expect(snapshot.dora).toEqual([
      {
        face: '3s',
        zone: 'dora',
        slot: 0,
        faceUp: true,
        sideways: false,
      },
      {
        face: '5z',
        zone: 'dora',
        slot: 1,
        faceUp: true,
        sideways: false,
      },
    ]);
  });

  it('draws the fixed decorative wall: four runs, two tiers, one missing draw end each', () => {
    const snapshot = snapshotFromGameState(game(), 0, false);

    expect(snapshot.wall).toHaveLength(WALL.tileCount);
    expect(WALL.tileCount).toBe(132);
    expect(snapshot.wall.every((tile) => tile.zone === 'wall')).toBe(true);
    expect(snapshot.wall.every((tile) => tile.face === 'blank')).toBe(true);
    expect(snapshot.wall.every((tile) => !tile.faceUp)).toBe(true);

    const slots = snapshot.wall.map((tile) => tile.slot);
    expect(new Set(slots).size).toBe(WALL.tileCount);
    // The last drawn slot is the last run's stack 16 bottom tier: its top is
    // the omitted draw end, so 135 never appears.
    expect(Math.max(...slots)).toBe(
      WALL.runs * WALL.slotsPerRun - 1 - 1,
    );
    // Slot 33 of every run is stack 16, top tier: the draw end is not drawn.
    expect(slots).not.toContain(33);
    expect(slots).not.toContain(33 + WALL.slotsPerRun);
    expect(slots.some((slot) => slot % WALL.slotsPerRun === 33)).toBe(false);
  });

  it('fails loudly on an unknown dora or discard code', () => {
    expect(() =>
      snapshotFromGameState(game({ dora_indicators: ['8z'] }), 0, false),
    ).toThrow(/unknown tile code/);

    expect(() =>
      snapshotFromGameState(
        game({
          players: [
            player({ seat: 0 }),
            player({ seat: 1, discards: [discard('0p')] }),
            player({ seat: 2 }),
            player({ seat: 3 }),
          ],
        }),
        0,
        false,
      ),
    ).toThrow(/unknown tile code/);
  });
});

describe('snapshotFromGameState: immutability', () => {
  it('is deeply frozen in development', () => {
    expect(import.meta.env.DEV).toBe(true);
    const snapshot = snapshotFromGameState(
      game({
        players: [
          player({
            seat: 0,
            draw: '9p',
            melds: [meld('Pon', ['1z', '1z', '1z'], 1)],
            hand: HAND_13.slice(0, 10),
          }),
          player({ seat: 1, discards: [discard('2p')] }),
          player({ seat: 2 }),
          player({ seat: 3 }),
        ],
      }),
      0,
      false,
    );

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.seats)).toBe(true);
    expect(Object.isFrozen(snapshot.seats[0])).toBe(true);
    expect(Object.isFrozen(snapshot.seats[0].concealed)).toBe(true);
    expect(Object.isFrozen(snapshot.seats[0].concealed[0])).toBe(true);
    expect(Object.isFrozen(snapshot.seats[0].draw)).toBe(true);
    expect(Object.isFrozen(snapshot.seats[0].melds[0].tiles[0])).toBe(true);
    expect(Object.isFrozen(snapshot.seats[1].river[0])).toBe(true);
    expect(Object.isFrozen(snapshot.wall[0])).toBe(true);
    expect(Object.isFrozen(snapshot.compass)).toBe(true);
    expect(Object.isFrozen(snapshot.dora)).toBe(true);
  });
});

describe('withPreviewRiichi (3D-09 preview only)', () => {
  it('marks every seat riichi without changing anything else', () => {
    const state = game({
      players: [
        player({ seat: 0 }),
        player({ seat: 1, is_riichi: true, riichi_discard_index: 0, discards: [discard('2p', { is_riichi: true })] }),
        player({ seat: 2 }),
        player({ seat: 3 }),
      ],
    });
    const real = snapshotFromGameState(state, 7, false);
    const preview = withPreviewRiichi(real);

    expect(preview.seats.map((seat) => seat.riichi)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    // The seat that really declared keeps its recorded discard index; the
    // others keep their null, so the river is untouched.
    expect(preview.seats[1].riichiDiscardIndex).toBe(real.seats[1].riichiDiscardIndex);
    expect(preview.seats.map((seat) => seat.riichiDiscardIndex)).toEqual(
      real.seats.map((seat) => seat.riichiDiscardIndex),
    );
    // A copy, not a mutation: the real snapshot and everything else is intact.
    expect(real.seats.map((seat) => seat.riichi)).toEqual([
      false,
      true,
      false,
      false,
    ]);
    expect(preview.revision).toBe(real.revision);
    expect(preview.compass).toBe(real.compass);
    expect(preview.wall).toBe(real.wall);
    expect(preview.seats[0].concealed).toBe(real.seats[0].concealed);
    expect(preview.locked).toBe(real.locked);
  });
});
