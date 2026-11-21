/**
 * The deterministic full-board stress state (3D-15).
 *
 * `boardFixture` is the layout gate's *widest* board: four melds per seat,
 * 22-discard rivers and five dora. This fixture answers a different question —
 * can the exposed 3D view draw a **complete, busy table** honestly: every zone
 * carrying content, every one of the 37 tile faces on the board at least once,
 * four Riichi declarations, a closed kan per seat, three-row rivers, a claimed
 * discard, and the same state before and after it is answered.
 *
 * It is a `GameState`, not a `TableSnapshot`, on purpose: the snapshot adapter
 * is the only producer of a table (decision D3), so the stress board reaches
 * the scene by the same path a dealt hand does, and the same state can be handed
 * to the stacked and top-down views for the accessibility parity test.
 *
 * It is a rendering fixture, not a lesson. The hand shapes are legal in the
 * narrow sense the renderer cares about (13 tiles per seat counting a closed
 * kan as three, a declaration discard in each river, 18 discards = the 3 x 6
 * pond), but the scoring situation is synthetic on purpose. Nothing here is
 * given to the engine or graded.
 */

import type {
  CalledMeld,
  DiscardTile,
  GameState,
  PlayerState,
  Wind,
} from '../../types/game';
import { snapshotFromGameState } from '../snapshot';
import type { TableSnapshot } from '../contract';

/** Discards per seat: exactly the 3 x 6 pond, so all three rows are full. */
export const STRESS_RIVER_LENGTH = 18;

/** Dora indicators: the most a game can reveal. */
export const STRESS_DORA = 5;

/**
 * The 37 faces the board must show: the 34 standard faces plus the three red
 * fives. `blank` is the assetless back and is deliberately not in this list.
 */
export const STRESS_FACES = [
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
  '5p',
  '6p',
  '7p',
  '8p',
  '9p',
  '1s',
  '2s',
  '3s',
  '4s',
  '5s',
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
  '5mr',
  '5pr',
  '5sr',
] as const;

/** A river code sequence, so a discard is a real tile and not a placeholder. */
const RIVER_CODES = [
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
  '5p',
  '6p',
  '7p',
  '8p',
  '9p',
  '1s',
  '2s',
  '3s',
  '4s',
  '5s',
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
] as const;

const WINDS: readonly Wind[] = ['East', 'South', 'West', 'North'];
const SCORES = [25000, 32000, 18500, 41000] as const;

/** The tile claimed out of seat 1's river (the human is offered a ron). */
export const CLAIMED_TILE = '9p';
export const CLAIMED_SEAT = 1 as const;
export const CLAIMED_INDEX = STRESS_RIVER_LENGTH - 1;

/**
 * One seat's concealed hand + draw, chosen so the four hands, four melds and
 * three red fives together put all 37 faces on the table before a single river
 * tile is counted (the test asserts that, not this comment).
 */
const HANDS: readonly (readonly string[])[] = [
  ['5m', '5p', '5s', '1m', '2m', '3m', '4m', '6m', '7m', '8m'],
  ['2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p', '1s', '2s'],
  ['4s', '5s', '6s', '7s', '8s', '9s', '2z', '3z', '4z', '5z'],
  ['7z', '1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m'],
] as const;

const DRAWS: readonly string[] = ['9m', '3s', '6z', '1p'] as const;

/** Each seat's closed kan: a four-tile meld that is legal under Riichi. */
const KAN_TILES: readonly string[] = ['1p', '1z', '2p', '3s'] as const;

/** The red five in each of the human's hand; the other 34 faces are plain. */
const HUMAN_RED_FIVES = ['5m', '5p', '5s'] as const;

/** The five dora indicators, one per rev and suit for easy reading. */
const DORA = ['3m', '7p', '2s', '4z', '6z'] as const;

function river(seat: number): DiscardTile[] {
  return Array.from({ length: STRESS_RIVER_LENGTH }, (_, index) => {
    // A red-five discard, for the art path that only rivers can carry. The
    // code must be a five: `faceIdForTile` rejects a red flag on any other.
    const isRed = seat === 0 && index === 3;
    const code = isRed
      ? '5p'
      : RIVER_CODES[(seat * 5 + index) % RIVER_CODES.length];
    const claimed =
      seat === CLAIMED_SEAT && index === CLAIMED_INDEX
        ? CLAIMED_TILE
        : code;
    return {
      tile: claimed,
      // Index 5 is the declaration in every river, so all four sticks and all
      // four turned declaration discards are exercised at once.
      is_riichi: index === 5,
      // Index 11 is a tsumogiri, which the river dims.
      is_tsumogiri: index === 11,
      is_red: isRed,
    };
  });
}

function meld(kind: CalledMeld['meld_type'], tiles: readonly string[]): CalledMeld {
  return { meld_type: kind, tiles: [...tiles], called_from: null };
}

function player(seat: number): PlayerState {
  return {
    seat,
    name: seat === 0 ? 'You' : `P${seat}`,
    is_human: seat === 0,
    wind: WINDS[seat],
    score: SCORES[seat],
    hand: [...HANDS[seat]],
    draw: DRAWS[seat],
    red_fives: seat === 0 ? [...HUMAN_RED_FIVES] : [],
    discards: river(seat),
    melds: [meld('Ankan', [KAN_TILES[seat], KAN_TILES[seat], KAN_TILES[seat], KAN_TILES[seat]])],
    // All four seats have declared: four felt sticks and four turned discards.
    is_riichi: true,
    riichi_discard_index: 5,
  };
}

/**
 * The stress `GameState`.
 *
 * Deterministic: no clock, no RNG, no environment. Every call returns a fresh,
 * structurally equal object so a test can mutate one without touching another.
 */
export function stressGameState(): GameState {
  const human = player(0);
  const handAndDraw = [...human.hand, human.draw].filter(
    (tile): tile is string => tile !== null,
  );
  return {
    category: 'fold_to_riichi',
    target_action: 'Fold',
    correct_action: { type: 'fold', discard: '9m' },
    decision: { kind: 'react_to_discard', from: CLAIMED_SEAT, tile: CLAIMED_TILE },
    riichi_triggers: [],
    dama_reasons: [],
    shouminkan_triggers: [],
    hand_string: human.hand.join(''),
    tiles: handAndDraw,
    shanten: 1,
    is_agari: false,
    decompositions_count: 1,
    ukeire_tiles: [],
    ukeire_total: 0,
    round_wind: 'South',
    hand_number: 4,
    honba: 2,
    riichi_sticks: 3,
    dora_indicators: [...DORA],
    ura_dora_indicators: ['1m', '2p', '3s', '5z', '7z'],
    tiles_remaining: 14,
    current_turn: 1,
    can_riichi: false,
    players: [player(0), player(1), player(2), player(3)],
  };
}

/** Options for {@link stressSnapshot}. */
export interface StressSnapshotOptions {
  /** True once the hand is answered: input is locked in every view. */
  readonly answered?: boolean;
  /** Snapshot revision; defaults to 1. */
  readonly revision?: number;
}

/** The stress board through the one snapshot adapter the app uses. */
export function stressSnapshot(
  options: StressSnapshotOptions = {},
): TableSnapshot {
  return snapshotFromGameState(
    stressGameState(),
    options.revision ?? 1,
    options.answered ?? false,
  );
}
