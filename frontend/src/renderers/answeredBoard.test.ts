/**
 * The answered board (261121-1206): for every answer family, the position the
 * 3D table shows after the answer, asserted as table facts rather than pixels.
 *
 * Each case runs the same two steps the app runs: the answer is turned into a
 * presentation delta from the state the player saw (`answerPresentationFor`),
 * then applied to that state's snapshot (`answeredBoard`). The fixture therefore
 * pins the hand count, the river, the meld, the Riichi flags and the next turn
 * for a discard, every call, both kan shapes and a pass.
 */

import { describe, expect, it } from 'vitest';
import { answerPresentationFor } from '../answerPresentation';
import type { SubmittedAnswerLike } from '../answerPresentation';
import type {
  CallOffer,
  CalledMeld,
  DecisionContext,
  DiscardTile,
  GameState,
  PlayerState,
} from '../types/game';
import { answeredBoard, type AnsweredAction } from './answeredBoard';
import { snapshotFromGameState } from './snapshot';

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

/** A thirteen-tile hand that can Chi 3m off kamicha (it holds 1m and 2m). */
const CHI_HAND = [
  '1m',
  '2m',
  '3m',
  '4m',
  '5m',
  '6m',
  '7m',
  '8m',
  '1p',
  '2p',
  '5z',
  '6z',
  '9s',
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

function discard(tile: string, overrides: Partial<DiscardTile> = {}): DiscardTile {
  return { tile, is_riichi: false, is_tsumogiri: false, ...overrides };
}

function game(overrides: Partial<GameState> = {}): GameState {
  return {
    category: 'test',
    target_action: 'NaniKiru',
    correct_action: { type: 'dama', discard: '1m' },
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
    tiles_remaining: 69,
    current_turn: 0,
    players: [
      player({ seat: 0 }),
      player({ seat: 1 }),
      player({ seat: 2 }),
      player({ seat: 3 }),
    ],
    ...overrides,
  };
}

const selfTurn = (overrides: Partial<GameState> = {}): GameState =>
  game({ decision: { kind: 'self_turn' }, current_turn: 0, ...overrides });

/** A table where seat `from` has just discarded `tile`. */
function reacting(
  from: number,
  tile: string,
  options: {
    offer?: CallOffer;
    correctAction?: GameState['correct_action'];
    human?: Partial<PlayerState>;
    melds?: CalledMeld[];
    river?: DiscardTile[];
  } = {},
): GameState {
  const decision: DecisionContext = {
    kind: 'react_to_discard',
    from,
    tile,
  };
  return game({
    decision,
    current_turn: from,
    call_offer: options.offer,
    correct_action: options.correctAction ?? { type: 'pass' },
    players: [
      player({ seat: 0, ...options.human, melds: options.melds ?? [] }),
      player({
        seat: 1,
        discards: from === 1 ? (options.river ?? [discard(tile)]) : [],
      }),
      player({
        seat: 2,
        discards: from === 2 ? (options.river ?? [discard(tile)]) : [],
      }),
      player({
        seat: 3,
        discards: from === 3 ? (options.river ?? [discard(tile)]) : [],
      }),
    ],
  });
}

function answered(
  state: GameState,
  answer: SubmittedAnswerLike,
  picks: Parameters<typeof answerPresentationFor>[2] = [],
) {
  const base = snapshotFromGameState(state, 3, false);
  const action = answerPresentationFor(state, answer, picks);
  return { base, action, board: answeredBoard(base, action) };
}

describe('answered board: a discard', () => {
  it('moves the chosen tile to the river and folds the draw back into the hand', () => {
    const state = selfTurn({
      players: [
        player({ seat: 0, draw: '9p' }),
        player({ seat: 1 }),
        player({ seat: 2 }),
        player({ seat: 3 }),
      ],
    });
    const { base, board } = answered(state, { action: 'dama', tile: '1m' });

    const human = board.seats[0];
    expect(human.concealed).toHaveLength(13);
    expect(human.draw).toBeNull();
    expect(human.river).toHaveLength(1);
    expect(human.river[0]).toMatchObject({
      face: '1m',
      sideways: false,
      dimmed: false,
    });
    // The remaining draw is now part of the hand, in display order.
    expect(human.concealed.map((tile) => tile.face)).toContain('9p');
    expect(board.currentTurn).toBe(1);
    expect(board.highlightDiscard).toBeNull();
    expect(board.transition).toBe('answered');
    expect(board.locked).toBe(true);
    expect(base.seats[0].draw).not.toBeNull();
  });

  it('marks a tsumogiri discard dimmed and removes the draw without changing the hand', () => {
    const state = selfTurn({
      players: [
        player({ seat: 0, draw: '9p' }),
        player({ seat: 1 }),
        player({ seat: 2 }),
        player({ seat: 3 }),
      ],
    });
    const { board } = answered(state, {
      action: 'dama',
      tile: '9p',
      is_tsumogiri: true,
    });

    const human = board.seats[0];
    expect(human.concealed).toHaveLength(13);
    expect(human.draw).toBeNull();
    expect(human.concealed.map((tile) => tile.face)).not.toContain('9p');
    expect(human.river[0]).toMatchObject({ face: '9p', dimmed: true });
  });

  it('keeps one physical identity from the hand to the river', () => {
    const { base, board } = answered(selfTurn(), {
      action: 'dama',
      tile: '1m',
    });
    const handUid = base.seats[0].concealed[0].uid;
    expect(handUid).toBeDefined();
    expect(board.seats[0].river[0].uid).toBe(handUid);
    // Every remaining tile keeps its own identity as the hand re-flows.
    const before = new Map(
      base.seats[0].concealed.map((tile) => [tile.uid, tile.face]),
    );
    for (const tile of board.seats[0].concealed) {
      if (tile.uid === handUid) continue;
      expect(before.get(tile.uid)).toBe(tile.face);
    }
  });

  it('leaves the other seats untouched', () => {
    const { base, board } = answered(selfTurn(), {
      action: 'dama',
      tile: '1m',
    });
    for (const seat of [1, 2, 3] as const) {
      expect(board.seats[seat].concealed).toEqual(base.seats[seat].concealed);
      expect(board.seats[seat].river).toEqual(base.seats[seat].river);
      expect(board.seats[seat].melds).toEqual(base.seats[seat].melds);
    }
  });
});

describe('answered board: a Riichi declaration', () => {
  it('lays the declaration tile sideways and raises the seat’s riichi state', () => {
    const state = selfTurn({
      players: [
        player({ seat: 0, draw: '9p' }),
        player({ seat: 1 }),
        player({ seat: 2 }),
        player({ seat: 3 }),
      ],
    });
    const { board } = answered(state, {
      action: 'riichi',
      tile: '4p',
    });
    const human = board.seats[0];
    expect(human.riichi).toBe(true);
    expect(human.riichiDiscardIndex).toBe(0);
    expect(human.river[0]).toMatchObject({ face: '4p', sideways: true });
    expect(human.concealed).toHaveLength(13);
    expect(human.draw).toBeNull();
    expect(board.currentTurn).toBe(1);
  });
});

describe('answered board: calls', () => {
    it('claims a Chi discard, forms the run and re-flows the hand', () => {
    const state = reacting(3, '3m', {
      offer: { action: 'Chi', label: 'Chi 3m', tile: '3m', tiles: ['1m', '2m'] },
      human: { hand: CHI_HAND },
    });
    const { base, board } = answered(state, {
      action: 'call',
      tile: '',
      action_name: 'Chi',
    });

    const human = board.seats[0];
    expect(human.concealed).toHaveLength(11);
    expect(human.melds).toHaveLength(1);
    const meld = human.melds[0];
    expect(meld.kind).toBe('Chi');
    expect(meld.tiles.map((tile) => tile.face)).toEqual(['1m', '2m', '3m']);
    // The committed Chi convention marks the run's leftmost tile sideways.
    expect(meld.tiles.map((tile) => tile.sideways)).toEqual([true, false, false]);
    expect(meld.calledFrom).toBe(3);
    expect(board.seats[3].river).toHaveLength(0);
    expect(board.currentTurn).toBe(0);
    expect(base.seats[3].river).toHaveLength(1);
    // The claimed discard keeps its identity into the meld.
    expect(meld.tiles[2].uid).toBe(base.seats[3].river[0].uid);
  });

  it('claims a Pon discard and turns the called tile sideways at its slot', () => {
    const state = reacting(1, '5z', {
      offer: { action: 'Pon', label: 'Pon 5z', tile: '5z' },
      human: { hand: [...CHI_HAND.slice(0, 11), '5z', '5z'] },
    });
    const { board } = answered(state, {
      action: 'call',
      tile: '',
      action_name: 'Pon',
    });

    const human = board.seats[0];
    expect(human.concealed).toHaveLength(11);
    const meld = human.melds[0];
    expect(meld.kind).toBe('Pon');
    expect(meld.tiles).toHaveLength(3);
    // Shimocha's pon sits in the last slot; only that tile is sideways.
    expect(meld.tiles.map((tile) => tile.sideways)).toEqual([false, false, true]);
    expect(board.seats[1].river).toHaveLength(0);
    expect(board.currentTurn).toBe(0);
  });

  it('reads an AI drill’s Kan on a discard as an open kan', () => {
    const state = reacting(1, '5z', {
      correctAction: { type: 'best', action: 'Kan', label: 'Kan' },
      human: { hand: [...CHI_HAND.slice(0, 10), '5z', '5z', '5z'] },
    });
    const { base, board } = answered(state, {
      action: 'best',
      tile: '5z',
      action_name: 'Kan',
    });

    const meld = board.seats[0].melds[0];
    expect(meld.kind).toBe('Kan');
    expect(meld.tiles).toHaveLength(4);
    expect(meld.calledFrom).toBe(1);
    expect(board.seats[1].river).toHaveLength(0);
    expect(base.seats[1].river).toHaveLength(1);
    expect(board.currentTurn).toBe(0);
  });

  it('forms the Pon from one picked copy, which is all the pick step names', () => {
    const state = reacting(1, '5z', {
      offer: { action: 'Pon', label: 'Pon 5z', tile: '5z' },
      human: { hand: [...CHI_HAND.slice(0, 11), '5z', '5z'] },
    });
    const { board } = answered(
      state,
      { action: 'call', tile: '', action_name: 'Pon' },
      [{ code: '5z', isRed: false }],
    );

    const meld = board.seats[0].melds[0];
    expect(meld.kind).toBe('Pon');
    expect(meld.tiles).toHaveLength(3);
    expect(board.seats[0].concealed).toHaveLength(11);
    expect(board.currentTurn).toBe(0);
  });

  it('uses both fives of a red+plain Pon, keeping the picked red one', () => {
    const state = reacting(1, '5m', {
      offer: { action: 'Pon', label: 'Pon 5m', tile: '5m' },
      human: {
        hand: ['5m', '5m', ...CHI_HAND.slice(0, 11)],
        red_fives: ['5m'],
      },
    });
    const { board } = answered(
      state,
      { action: 'call', tile: '', action_name: 'Pon' },
      [{ code: '5m', isRed: true }],
    );

    const meld = board.seats[0].melds[0];
    expect(meld.tiles).toHaveLength(3);
    expect(meld.tiles.map((tile) => tile.face).sort()).toEqual([
      '5m',
      '5m',
      '5mr',
    ]);
  });

  it('claims an open Kan discard and shows the four-tile meld', () => {    const state = reacting(3, '7z', {
      offer: { action: 'Kan', label: 'Kan 7z', tile: '7z' },
      correctAction: { type: 'kan', tile: '7z' },
      human: { hand: [...CHI_HAND.slice(0, 10), '7z', '7z', '7z'] },
    });
    const { base, board } = answered(state, {
      action: 'kan',
      tile: '7z',
    });

    const human = board.seats[0];
    expect(human.concealed).toHaveLength(10);
    const meld = human.melds[0];
    expect(meld.kind).toBe('Kan');
    expect(meld.tiles).toHaveLength(4);
    // Kamicha's open kan is claimed in the first slot.
    expect(meld.tiles.map((tile) => tile.sideways)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(board.seats[3].river).toHaveLength(0);
    expect(board.currentTurn).toBe(0);
    expect(base.seats[3].river).toHaveLength(1);
  });

  it('grows an open Pon into an added Kan', () => {
    const state = selfTurn({
      target_action: 'Kan',
      correct_action: { type: 'kan', tile: 'kan' },
      players: [
        player({
          seat: 0,
          hand: [...CHI_HAND.slice(0, 9), '7z'],
          melds: [{ meld_type: 'Pon', tiles: ['7z', '7z', '7z'], called_from: 1 }],
        }),
        player({ seat: 1 }),
        player({ seat: 2 }),
        player({ seat: 3 }),
      ],
    });
    const { board } = answered(state, {
      action: 'kan',
      tile: '7z',
      action_name: 'Kan',
    });

    const human = board.seats[0];
    expect(human.melds).toHaveLength(1);
    const meld = human.melds[0];
    expect(meld.kind).toBe('Kan');
    expect(meld.tiles).toHaveLength(4);
    // Shimocha's four-tile kan marks the last slot sideways.
    expect(meld.tiles.map((tile) => tile.sideways)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(meld.calledFrom).toBe(1);
    expect(human.concealed).toHaveLength(9);
    expect(board.currentTurn).toBe(0);
  });

  it('forms a closed Kan from four concealed copies', () => {
    const state = selfTurn({
      target_action: 'Kan',
      correct_action: { type: 'kan', tile: 'kan' },
      players: [
        player({ seat: 0, hand: [...CHI_HAND.slice(0, 9), '7z', '7z', '7z', '7z'] }),
        player({ seat: 1 }),
        player({ seat: 2 }),
        player({ seat: 3 }),
      ],
    });
    const { board } = answered(state, {
      action: 'kan',
      tile: '7z',
    });

    const human = board.seats[0];
    expect(human.concealed).toHaveLength(9);
    const meld = human.melds[0];
    expect(meld.kind).toBe('Ankan');
    expect(meld.tiles).toHaveLength(4);
    // A closed kan sets its two outer tiles face down and shows the middle two.
    expect(meld.tiles.map((tile) => tile.faceUp)).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect(meld.tiles.every((tile) => !tile.sideways)).toBe(true);
    expect(meld.calledFrom).toBeNull();
    expect(board.currentTurn).toBe(0);
  });
});

describe('answered board: a pass and a no-op', () => {
  it('moves no tile and passes play after the discarder', () => {
    const state = reacting(2, '5z', {
      offer: { action: 'Pon', label: 'Pon 5z', tile: '5z' },
      human: { hand: [...CHI_HAND.slice(0, 11), '5z', '5z'] },
    });
    const base = snapshotFromGameState(state, 5, false);
    const action = answerPresentationFor(state, { action: 'pass', tile: '' });
    const board = answeredBoard(base, action);

    expect(action.family).toBe('pass');
    expect(board.seats[0].concealed).toEqual(base.seats[0].concealed);
    expect(board.seats[0].river).toEqual(base.seats[0].river);
    expect(board.seats[2].river).toEqual(base.seats[2].river);
    expect(board.highlightDiscard).toBeNull();
    expect(board.currentTurn).toBe(3);
  });

  it('treats an AI win as no board change at all', () => {
    const action: AnsweredAction = { family: 'none' };
    const base = snapshotFromGameState(selfTurn(), 6, false);
    expect(answeredBoard(base, action)).toBe(base);
  });
});
