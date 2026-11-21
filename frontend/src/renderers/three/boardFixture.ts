/**
 * A deterministic, legal-shaped {@link TableSnapshot} for the layout tests and
 * the layout gate (3D-06).
 *
 * The fixture is not produced by `snapshotFromGameState`: the layout unit owns
 * no game rules, and the gate script must be able to run without a `GameState`.
 * It builds the same shapes the adapter produces (the depleted live wall from
 * `tilesRemaining` plus the 14-tile dead wall, 13 - 3·melds concealed tiles per
 * seat, a draw, melds, rivers up to the 18 + 4 overflow capacity, dora on the
 * dead wall) so the layout is exercised at its widest and deepest.
 *
 * Pure data: no DOM, no three.js, no randomness.
 */

import type {
  Seat,
  SnapshotMeld,
  SnapshotSeat,
  SnapshotTile,
  TableSnapshot,
  TileFaceId,
} from '../contract';
import { wallSlotId, wallSlots } from '../wall';

/** Options for {@link boardFixture}; every field has a realistic default. */
export interface FixtureOptions {
  /** Which absolute seat is the human; the others are face-down opponents. */
  readonly humanSeat?: Seat;
  /** Discards per absolute seat, oldest first. Defaults to [22, 18, 14, 10]. */
  readonly riverCounts?: readonly [number, number, number, number];
  /** Open melds per absolute seat (0–4). Defaults to one per seat. */
  readonly meldCounts?: readonly [number, number, number, number];
  /** Make the first meld of every seat a four-tile kan. Defaults to false. */
  readonly kan?: boolean;
  /** Dora indicators, 0–5. Defaults to 3. */
  readonly doraCount?: number;
  /** The 1000-point pot. Defaults to 2; the 3D board does not draw it (3D-09). */
  readonly riichiSticks?: number;
  /**
   * `compass.tilesRemaining`, which is also the live wall's tile count. Defaults
   * to 69, the first decision after the deal and the dealer's draw; pass a small
   * number for a late-hand fixture. Clamped by the wall model to 0..70.
   */
  readonly tilesRemaining?: number;
  /**
   * Absolute seats that have declared riichi. Omitted, every seat whose river
   * is long enough (all four by default) has, so the per-seat sticks are all
   * drawn; `[]` gives a table with none.
   */
  readonly riichiSeats?: readonly Seat[];
  /** Whether every seat has an active draw. Defaults to true. */
  readonly draw?: boolean;
}

/** A rotating face sequence, so the same snapshot always holds the same faces. */
const FACE_ORDER: readonly TileFaceId[] = [
  '1m',
  '2m',
  '3m',
  '4m',
  '5mr',
  '6m',
  '7m',
  '8m',
  '9m',
  '1p',
  '2p',
  '3p',
  '4p',
  '5pr',
  '6p',
  '7p',
  '8p',
  '9p',
  '1s',
  '2s',
  '3s',
  '4s',
  '5sr',
  '6s',
  '7s',
  '8s',
  '9s',
  '1z',
  '2z',
  '3z',
  '4z',
  '5z',
  '6z',
  '7z',
];

function face(index: number): TileFaceId {
  return FACE_ORDER[index % FACE_ORDER.length];
}

function tile(
  zone: SnapshotTile['zone'],
  slot: number,
  index: number,
  extra: Partial<SnapshotTile> = {},
): SnapshotTile {
  return {
    face: face(index),
    zone,
    slot,
    faceUp: true,
    sideways: false,
    ...extra,
  };
}

/**
 * The wall at the fixture's live count: the fixed dead wall plus the live wall's
 * remaining slots, exactly as `snapshotFromGameState` builds it.
 */
function buildWall(tilesRemaining: number, humanSeat: Seat): SnapshotTile[] {
  return wallSlots(tilesRemaining, humanSeat).map(({ run, stack, tier }) => ({
    face: 'blank',
    zone: 'wall',
    slot: wallSlotId(run, stack, tier),
    faceUp: false,
    sideways: false,
  }));
}

/**
 * The fixture snapshot.
 *
 * Every seat's river holds a riichi discard (sideways) at index 5 and a
 * tsumogiri discard (dimmed) at index 11 when the river is long enough, so the
 * turned footprint and the dim flag are both exercised.
 */
export function boardFixture(options: FixtureOptions = {}): TableSnapshot {
  const humanSeat = options.humanSeat ?? 0;
  const riverCounts = options.riverCounts ?? ([22, 18, 14, 10] as const);
  const meldCounts = options.meldCounts ?? ([1, 1, 1, 1] as const);
  const doraCount = options.doraCount ?? 3;
  const riichiSticks = options.riichiSticks ?? 2;
  const tilesRemaining = options.tilesRemaining ?? 69;
  const draw = options.draw ?? true;
  const declared = options.riichiSeats
    ? new Set<number>(options.riichiSeats)
    : null;

  const seats = ([0, 1, 2, 3] as const).map((seat): SnapshotSeat => {
    const meldCount = meldCounts[seat];
    const concealedCount = 13 - 3 * meldCount;

    const concealed: SnapshotTile[] = Array.from(
      { length: concealedCount },
      (_, index) => tile('hand', index, seat * 14 + index),
    );

    const melds: SnapshotMeld[] = Array.from({ length: meldCount }, (_, index) => {
      const size = options.kan && index === 0 ? 4 : 3;
      return {
        kind: size === 4 ? 'Kan' : 'Pon',
        tiles: Array.from({ length: size }, (_, slot) =>
          tile('meld', slot, seat * 14 + index * size + slot, {
            sideways: slot === 1,
          }),
        ),
        calledFrom: ((seat + 3) % 4) as Seat,
      };
    });

    const riverCount = Math.min(riverCounts[seat], 18 + 4);
    // The seat the snapshot's call/ron marker names has its newest discard
    // highlighted, exactly as `snapshotFromGameState` flags it.
    const highlightSeat = riverCounts[0] > 0 ? 0 : -1;
    const highlightIndex = highlightSeat === 0 ? riverCount - 1 : -1;
    const river: SnapshotTile[] = Array.from({ length: riverCount }, (_, index) =>
      tile('river', index, seat * 14 + index, {
        sideways: index === 5,
        dimmed: index === 11,
        ...(seat === highlightSeat && index === highlightIndex
          ? { highlighted: true }
          : {}),
      }),
    );

    const declaredRiichi = declared
      ? declared.has(seat)
      : riverCount > 5;

    return {
      seat,
      wind: (['East', 'South', 'West', 'North'] as const)[seat],
      score: 25000,
      concealed,
      draw: draw ? tile('draw', concealed.length, seat * 14 + 13) : null,
      melds,
      river,
      riichi: declaredRiichi,
      riichiDiscardIndex: declaredRiichi ? 5 : null,
    };
  });

  return {
    revision: 1,
    humanSeat,
    seats: seats as unknown as TableSnapshot['seats'],
    wall: buildWall(tilesRemaining, humanSeat),
    dora: Array.from({ length: doraCount }, (_, index) =>
      tile('dora', index, 27 + index),
    ),
    compass: {
      roundWind: 'East',
      handNumber: 1,
      honba: 1,
      riichiSticks,
      tilesRemaining,
    },
    highlightDiscard:
      riverCounts[0] > 0 ? { seat: 0, index: riverCounts[0] - 1 } : null,
    locked: false,
  };
}
