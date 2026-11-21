/**
 * The call-flow review set (2026-11-21).
 *
 * `?preview=calls` deals one of these crafted positions instead of a generated
 * hand, and the top bar's Next hand walks to the next case. It exists so the
 * hover preview, the darkened pick set, the one-option shortcut, the red/plain
 * five choice and the multi-tile Chi selection can all be exercised in one
 * session without hunting for a generated board.
 *
 * These are review fixtures, not lessons: the app's generators still own real
 * game logic. Each state is a complete `GameState` payload, so it goes through
 * exactly the same store, overlay and grading path as a dealt hand.
 *
 * `?preview=calls&case=chi-multi` starts at one case; the ids are the list
 * below. The 3D / 2D views both work.
 */

import type {
  CalledMeld,
  GameState,
  PlayerState,
  Wind,
} from './types/game';

const DUMMY_HAND = [
  '1m',
  '2m',
  '3m',
  '4p',
  '5p',
  '6p',
  '7s',
  '8s',
  '9s',
  '1z',
  '2z',
  '3z',
  '4z',
];

const SEATS: readonly { readonly wind: Wind; readonly name: string }[] = [
  { wind: 'East', name: 'You' },
  { wind: 'South', name: 'Shimocha' },
  { wind: 'West', name: 'Toimen' },
  { wind: 'North', name: 'Kamicha' },
];

/**
 * The offered tile in the discarder's river, so the table reads like a real
 * call: a Pon/Chi lesson needs the tile to be visible.
 */
function discarder(seat: number, tile: string): PlayerState {
  const discards = [{ tile, is_riichi: false, is_tsumogiri: false }];
  return {
    seat,
    name: SEATS[seat].name,
    is_human: false,
    wind: SEATS[seat].wind,
    score: 25000,
    hand: [...DUMMY_HAND],
    draw: null,
    red_fives: [],
    discards,
    melds: [],
    is_riichi: false,
    riichi_discard_index: null,
  };
}

function seatPlayer(seat: number): PlayerState {
  return {
    seat,
    name: SEATS[seat].name,
    is_human: false,
    wind: SEATS[seat].wind,
    score: 25000,
    hand: [...DUMMY_HAND],
    draw: null,
    red_fives: [],
    discards: [],
    melds: [] as CalledMeld[],
    is_riichi: false,
    riichi_discard_index: null,
  };
}

interface HumanOptions {
  readonly hand: readonly string[];
  readonly draw?: string | null;
  readonly redFives?: readonly string[];
}

function human(options: HumanOptions): PlayerState {
  return {
    seat: 0,
    name: 'You',
    is_human: true,
    wind: 'East',
    score: 25000,
    hand: [...options.hand],
    draw: options.draw ?? null,
    red_fives: [...(options.redFives ?? [])],
    discards: [],
    melds: [],
    is_riichi: false,
    riichi_discard_index: null,
  };
}

function game(
  who: PlayerState,
  overrides: Partial<GameState>,
): GameState {
  return {
    category: 'call_demo',
    target_action: 'Call',
    correct_action: { type: 'pass' },
    decision: { kind: 'self_turn' },
    riichi_triggers: [],
    dama_reasons: [],
    shouminkan_triggers: [],
    hand_string: who.hand.join(''),
    tiles: [...who.hand, ...(who.draw ? [who.draw] : [])],
    shanten: 0,
    is_agari: false,
    decompositions_count: 1,
    ukeire_tiles: [],
    ukeire_total: 0,
    round_wind: 'East',
    hand_number: 1,
    honba: 0,
    riichi_sticks: 0,
    dora_indicators: [],
    ura_dora_indicators: [],
    tiles_remaining: 60,
    current_turn: 0,
    can_riichi: false,
    players: [who, seatPlayer(1), seatPlayer(2), seatPlayer(3)],
    ...overrides,
  };
}

/** The demo positions, in the order the Next hand control walks them. */
export interface CallDemoCase {
  readonly id: string;
  /** Dev-only description; the app never renders it over the board. */
  readonly title: string;
  readonly state: GameState;
}

function demos(): CallDemoCase[] {
  const ponSingle = game(
    human({
      hand: ['5z', '5z', '1m', '2m', '3m', '4m', '6m', '7p', '8p', '9p', '2s', '3s', '4s'],
    }),
    {
      decision: { kind: 'react_to_discard', from: 1, tile: '5z' },
      call_offer: { action: 'Pon', label: 'Pon Wh', tile: '5z' },
      players: [
        human({
          hand: ['5z', '5z', '1m', '2m', '3m', '4m', '6m', '7p', '8p', '9p', '2s', '3s', '4s'],
        }),
        discarder(1, '5z'),
        seatPlayer(2),
        seatPlayer(3),
      ],
    },
  );

  const ponRed = game(
    human({
      hand: ['5m', '5m', '1m', '2m', '3m', '6p', '7p', '8p', '2s', '3s', '4s', '9m', '1z'],
      redFives: ['5m'],
    }),
    {
      decision: { kind: 'react_to_discard', from: 1, tile: '5m' },
      call_offer: { action: 'Pon', label: 'Pon 5m', tile: '5m' },
      players: [
        human({
          hand: ['5m', '5m', '1m', '2m', '3m', '6p', '7p', '8p', '2s', '3s', '4s', '9m', '1z'],
          redFives: ['5m'],
        }),
        discarder(1, '5m'),
        seatPlayer(2),
        seatPlayer(3),
      ],
    },
  );

  const chiSingleHand = [
    '2p',
    '3p',
    '1m',
    '2m',
    '3m',
    '6m',
    '7m',
    '8m',
    '1s',
    '2s',
    '3s',
    '9s',
    '1z',
  ];
  const chiSingle = game(human({ hand: chiSingleHand }), {
    decision: { kind: 'react_to_discard', from: 3, tile: '4p' },
    call_offer: {
      action: 'Chi',
      label: 'Chi 2p 3p on 4p',
      tile: '4p',
      tiles: ['2p', '3p'],
    },
    players: [
      human({ hand: chiSingleHand }),
      seatPlayer(1),
      seatPlayer(2),
      discarder(3, '4p'),
    ],
  });

  const chiMultiHand = [
    '2p',
    '3p',
    '5p',
    '6p',
    '1m',
    '2m',
    '3m',
    '7m',
    '8m',
    '1s',
    '2s',
    '3s',
    '9s',
  ];
  const chiMulti = game(human({ hand: chiMultiHand }), {
    decision: { kind: 'react_to_discard', from: 3, tile: '4p' },
    // No `tiles`: the UI derives all three runs the 4p completes.
    call_offer: { action: 'Chi', label: 'Chi on 4p', tile: '4p' },
    players: [
      human({ hand: chiMultiHand }),
      seatPlayer(1),
      seatPlayer(2),
      discarder(3, '4p'),
    ],
  });

  const kanSingle = game(
    human({
      hand: ['1m', '1m', '1m', '1m', '2p', '3p', '4p', '5s', '6s', '7s', '2z', '3z', '9p'],
      draw: '9p',
    }),
    {
      target_action: 'Kan',
      decision: { kind: 'self_turn' },
      correct_action: { type: 'kan', tile: '1m' },
    },
  );

  // The engine lists exactly one legal declaration here (verified against
  // `riichi_discards_json`: only 9s keeps the hand tenpai).
  const riichiOneHand = ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '1s', '1s', '2p', '2p', '2p'];
  const riichiOne = game(human({ hand: riichiOneHand, draw: '9s' }), {
    target_action: 'Riichi',
    decision: { kind: 'self_turn' },
    correct_action: { type: 'riichi', discard: '9s' },
    can_riichi: true,
  });

  const riichiManyHand = ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '1p', '2p', '2p'];
  const riichiMany = game(human({ hand: riichiManyHand, draw: '3p' }), {
    target_action: 'Dama',
    decision: { kind: 'self_turn' },
    correct_action: { type: 'dama', discard: '3p' },
    can_riichi: true,
  });

  const drillChi = game(human({ hand: chiMultiHand }), {
    target_action: 'Best',
    decision: { kind: 'react_to_discard', from: 3, tile: '4p' },
    correct_action: {
      type: 'best',
      action: 'Chi_Low',
      label: 'Chi 2p 3p on 4p',
      tile: '4p',
      tiles: ['2p', '3p'],
    },
    ai_decision: {
      model: 'call_demo',
      expected_value: 0.1,
      recommended_action: 'Chi_Low',
      evaluations: [],
      actions: [
        {
          action: 'Chi_Low',
          label: 'Chi 2p 3p on 4p',
          type: 'chi',
          tile: '4p',
          tiles: ['2p', '3p'],
        },
        {
          action: 'Chi_Mid',
          label: 'Chi 3p 5p on 4p',
          type: 'chi',
          tile: '4p',
          tiles: ['3p', '5p'],
        },
        {
          action: 'Chi_High',
          label: 'Chi 5p 6p on 4p',
          type: 'chi',
          tile: '4p',
          tiles: ['5p', '6p'],
        },
        { action: 'Pass', label: 'Pass', type: 'pass' },
      ],
    },
    players: [
      human({ hand: chiMultiHand }),
      seatPlayer(1),
      seatPlayer(2),
      discarder(3, '4p'),
    ],
  });

  return [
    { id: 'pon-single', title: 'Pon, one copy (press completes it)', state: ponSingle },
    { id: 'pon-red', title: 'Pon 5m with a red five (both copies are used)', state: ponRed },
    { id: 'chi-single', title: 'Chi, one run (press completes it)', state: chiSingle },
    { id: 'chi-multi', title: 'Chi, three runs (pick two; toggle/roll)', state: chiMulti },
    { id: 'kan-single', title: 'Self-turn Kan, four copies (press completes it)', state: kanSingle },
    { id: 'riichi-one', title: 'Riichi, one legal discard (press completes it)', state: riichiOne },
    { id: 'riichi-many', title: 'Riichi, three legal discards (pick one)', state: riichiMany },
    { id: 'drill-chi', title: 'Drill with three Chi actions and Pass', state: drillChi },
  ];
}

export const CALL_DEMO_CASES: readonly CallDemoCase[] = demos();

/**
 * The demo index a query string asks for, or null when the review mode is off.
 *
 * `?preview=calls` starts at the first case; `&case=<id>` starts at that one.
 * An unknown id falls back to the first case rather than an error: this is a
 * review aid, and a typo should still show something.
 */
export function callDemoStartIndex(search: string): number | null {
  const params = new URLSearchParams(search);
  if (params.get('preview') !== 'calls') return null;
  const id = params.get('case');
  if (!id) return 0;
  const index = CALL_DEMO_CASES.findIndex((entry) => entry.id === id);
  return index >= 0 ? index : 0;
}

/** The demo the review mode deals after the one at `index`. */
export function nextCallDemoIndex(index: number): number {
  return (index + 1) % CALL_DEMO_CASES.length;
}
