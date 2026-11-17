/**
 * A representative `GameState` for the rendered-table tests. Test-only: no app
 * module imports this file.
 *
 * It exercises every board zone family: four ponds (one with two rows and a
 * Riichi discard), a drawn tile, red fives, a Pon on the human's seat, a Chi on
 * the right seat, and a short live wall.
 */
import type { DiscardTile, GameState, PlayerState } from '../types/game';

const HAND = ['1m', '1m', '2m', '2m', '3m', '3m', '4p', '5p', '5p', '6s', '6s', '7z', '9s'];

function discard(
  tile: string,
  options: { riichi?: boolean; tsumogiri?: boolean; red?: boolean } = {},
): DiscardTile {
  return {
    tile,
    is_riichi: options.riichi === true,
    is_tsumogiri: options.tsumogiri === true,
    is_red: options.red === true,
  };
}

function player(seat: number, overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    seat,
    name: ['You', 'Shimocha', 'Toimen', 'Kamicha'][seat] ?? `Seat ${seat}`,
    is_human: seat === 0,
    wind: (['East', 'South', 'West', 'North'] as const)[seat] ?? 'East',
    score: 25000,
    hand: [...HAND],
    draw: null,
    red_fives: [],
    discards: [],
    melds: [],
    is_riichi: false,
    riichi_discard_index: null,
    ...overrides,
  };
}

/** Four players, every pond populated, a call on two seats, 70 tiles live. */
export function boardGameState(): GameState {
  const players = [
    player(0, {
      draw: '8s',
      hand: HAND,
      red_fives: ['5p'],
      discards: [
        discard('1z'),
        discard('2z', { tsumogiri: true }),
        discard('3z'),
        discard('4z'),
        discard('6z'),
        discard('7z'),
        discard('1s', { riichi: true }),
        discard('5s', { red: true }),
      ],
      is_riichi: true,
      riichi_discard_index: 6,
      melds: [{ meld_type: 'Pon', tiles: ['7z', '7z', '7z'], called_from: 1 }],
    }),
    player(1, {
      hand: [...HAND],
      discards: [discard('9m'), discard('9p'), discard('9s')],
      melds: [{ meld_type: 'Chi', tiles: ['1m', '2m', '3m'], called_from: 0 }],
    }),
    player(2, {
      hand: [...HAND],
      discards: [discard('1p'), discard('2p')],
    }),
    player(3, {
      hand: [...HAND],
      discards: [discard('3p'), discard('4p'), discard('5p'), discard('6p')],
    }),
  ];

  return {
    category: 'test',
    target_action: 'NaniKiru',
    correct_action: { type: 'discard', tile: '9s' },
    decision: { kind: 'self_turn' },
    riichi_triggers: [],
    dama_reasons: [],
    shouminkan_triggers: [],
    hand_string: HAND.join(''),
    tiles: [...HAND, '8s'],
    shanten: 1,
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
    players,
  };
}
