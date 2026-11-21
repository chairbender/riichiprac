/**
 * The call-button model and its tile-pick options.
 *
 * These are pure-data tests: what the two shells will render, and which hand
 * copies a pick can use. They pin the rules the interaction depends on —
 * chi needs two tiles, pon/kan one, a red/plain five is a real choice, and a
 * call with one legal option needs no pick at all.
 */

import { describe, expect, it } from 'vitest';
import {
  callButtonsFor,
  callContextFor,
  callOptionForPicks,
  callOptionsFor,
  callPickPrompt,
  canPickCopy,
  runPairs,
  NO_CALL_BUTTONS,
} from './callChoices';
import type { CallContext } from './callChoices';
import type { AiActionInfo } from './types/ai';
import type { GameState, PlayerState } from './types/game';

function player(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    seat: 0,
    name: 'You',
    is_human: true,
    wind: 'East',
    score: 25000,
    hand: [],
    draw: null,
    red_fives: [],
    discards: [],
    melds: [],
    is_riichi: false,
    riichi_discard_index: null,
    ...overrides,
  };
}

function state(overrides: Partial<GameState> = {}): GameState {
  return {
    category: 'test',
    target_action: 'Call',
    correct_action: { type: 'pass' },
    decision: { kind: 'react_to_discard', from: 3, tile: '4p' },
    riichi_triggers: [],
    dama_reasons: [],
    shouminkan_triggers: [],
    hand_string: '',
    tiles: [],
    shanten: 1,
    is_agari: false,
    decompositions_count: 0,
    ukeire_tiles: [],
    ukeire_total: 0,
    round_wind: 'East',
    hand_number: 1,
    honba: 0,
    riichi_sticks: 0,
    dora_indicators: [],
    ura_dora_indicators: [],
    tiles_remaining: 60,
    current_turn: 1,
    can_riichi: false,
    players: [],
    ...overrides,
  };
}

const BOOK: CallContext = { isDrill: false, availableActions: [] };

describe('call buttons', () => {
  it('renders the book offer and Pass, with no declaration on a reaction', () => {
    const offer = state({
      call_offer: { action: 'Pon', label: 'Pon Wh', tile: '5z' },
      can_riichi: true,
    });

    const buttons = callButtonsFor(offer, player(), BOOK);

    expect(buttons.calls.map((call) => call.kind)).toEqual(['pon']);
    expect(buttons.calls[0].ariaLabel).toBe('Call Pon Wh');
    expect(buttons.pass).toBe(true);
    // Riichi is declared on your own turn: a reaction never offers it.
    expect(buttons.calls.some((call) => call.kind === 'riichi')).toBe(false);
  });

  it('offers Riichi and a self-turn Kan on their own lessons', () => {
    const riichi = state({
      target_action: 'Riichi',
      correct_action: { type: 'riichi', discard: '3p' },
      decision: { kind: 'self_turn' },
      can_riichi: true,
    });
    expect(callButtonsFor(riichi, player(), BOOK).calls.map((c) => c.kind)).toEqual([
      'riichi',
    ]);

    const kan = state({
      target_action: 'Kan',
      correct_action: { type: 'kan', tile: '1m' },
      decision: { kind: 'self_turn' },
      can_riichi: false,
    });
    const quad = player({ hand: ['1m', '1m', '1m', '1m', '2p'], draw: '9p' });
    expect(callButtonsFor(kan, quad, BOOK).calls.map((c) => c.kind)).toEqual([
      'kan',
    ]);
  });

  it('takes a drill’s calls from its legal-action list', () => {
    const actions: AiActionInfo[] = [
      { action: 'Riichi', label: 'Riichi', type: 'riichi' },
      { action: 'Chi_Low', label: 'Chi 2p 3p on 4p', type: 'chi', tile: '4p', tiles: ['2p', '3p'] },
      { action: 'Chi_Mid', label: 'Chi 2p 4p on 3p', type: 'chi', tile: '3p', tiles: ['2p', '4p'] },
      { action: 'Pon', label: 'Pon 5z', type: 'pon', tile: '5z' },
      { action: 'Pass', label: 'Pass', type: 'pass' },
      { action: 'Agari', label: 'Ron 4p', type: 'agari', tile: '4p' },
    ];
    const drill = state({ correct_action: { type: 'best', action: 'Pon', label: 'Pon' } });

    const buttons = callButtonsFor(
      drill,
      player(),
      { isDrill: true, availableActions: actions },
    );

    // One control per family, in the bar's order; the Agari is not a call.
    expect(buttons.calls.map((call) => call.kind)).toEqual([
      'chi',
      'pon',
      'riichi',
    ]);
    expect(buttons.pass).toBe(true);
  });

  it('renders nothing for a plain discard hand', () => {
    expect(callButtonsFor(state(), player(), BOOK)).toEqual(NO_CALL_BUTTONS);
  });
});

describe('chi options', () => {
  it('offers the two hand tiles the engine names', () => {
    const offer = state({
      decision: { kind: 'react_to_discard', from: 3, tile: '4p' },
      call_offer: { action: 'Chi', label: 'Chi 2p 3p on 4p', tile: '4p', tiles: ['2p', '3p'] },
    });
    const hand = player({ hand: ['2p', '3p', '9m', '9m', '9m', '1z', '1z'] });

    const options = callOptionsFor(offer, hand, BOOK, 'chi');

    expect(options).toHaveLength(1);
    expect(options[0].handTiles.map((copy) => copy.code)).toEqual(['2p', '3p']);
    expect(options[0].calledTile).toBe('4p');
  });

  it('finds every run the called tile completes when the offer omits its tiles', () => {
    const offer = state({
      decision: { kind: 'react_to_discard', from: 3, tile: '4p' },
      call_offer: { action: 'Chi', label: 'Chi on 4p', tile: '4p' },
    });
    const hand = player({
      hand: ['2p', '3p', '5p', '6p', '9m', '1z', '1z'],
    });

    const options = callOptionsFor(offer, hand, BOOK, 'chi');

    // The hand holds 2p, 3p, 5p and 6p: the 4p completes three runs.
    expect(options.map((option) => option.handTiles.map((c) => c.code))).toEqual([
      ['2p', '3p'],
      ['3p', '5p'],
      ['5p', '6p'],
    ]);
  });

  it('separates a red five from a plain five in the picked pair', () => {
    const offer = state({
      decision: { kind: 'react_to_discard', from: 3, tile: '4p' },
      call_offer: { action: 'Chi', label: 'Chi on 4p', tile: '4p', tiles: ['5p', '6p'] },
    });
    const hand = player({
      hand: ['5p', '5p', '6p', '9m', '1z', '1z', '1z'],
      red_fives: ['5p'],
    });

    const options = callOptionsFor(offer, hand, BOOK, 'chi');

    expect(options).toHaveLength(2);
    expect(options.map((option) => option.handTiles[0].isRed).sort()).toEqual([
      false,
      true,
    ]);
  });

  it('lists runs by rank relative to the called tile', () => {
    expect(runPairs('4p', [{ code: '2p' }, { code: '3p' }])).toEqual([
      ['2p', '3p'],
    ]);
    expect(runPairs('1p', [{ code: '2p' }, { code: '3p' }])).toEqual([
      ['2p', '3p'],
    ]);
    expect(runPairs('7z', [])).toEqual([]);
  });
});

describe('pon and kan options', () => {
  it('treats identical copies as one choice, so the press completes it', () => {
    const offer = state({
      call_offer: { action: 'Pon', label: 'Pon 5z', tile: '5z' },
    });
    const hand = player({ hand: ['5z', '5z', '1m', '2m', '3m', '4m', '6m'] });

    expect(callOptionsFor(offer, hand, BOOK, 'pon')).toHaveLength(1);
  });

  it('asks which five to pon when the hand holds a red and a plain copy', () => {
    const offer = state({
      decision: { kind: 'react_to_discard', from: 3, tile: '5m' },
      call_offer: { action: 'Pon', label: 'Pon 5m', tile: '5m' },
    });
    const hand = player({ hand: ['5m', '5m', '1m', '2m', '3m', '4m', '6m'], red_fives: ['5m'] });

    const options = callOptionsFor(offer, hand, BOOK, 'pon');

    expect(options).toHaveLength(2);
    expect(options.map((option) => option.handTiles[0].isRed).sort()).toEqual([
      false,
      true,
    ]);
  });

  it('offers one Kan option for four identical concealed copies', () => {
    const kan = state({
      target_action: 'Kan',
      decision: { kind: 'self_turn' },
      correct_action: { type: 'kan', tile: '1m' },
    });
    const hand = player({ hand: ['1m', '1m', '1m', '1m', '2p', '3p', '4p'] });

    expect(callOptionsFor(kan, hand, BOOK, 'kan')).toHaveLength(1);
  });
});

describe('picking tiles', () => {
  const offer = state({
    decision: { kind: 'react_to_discard', from: 3, tile: '4p' },
    call_offer: { action: 'Chi', label: 'Chi 2p 3p on 4p', tile: '4p', tiles: ['2p', '3p'] },
  });
  const playerHand = player({ hand: ['2p', '3p', '9m', '9m', '9m', '1z', '1z'] });
  const pending = {
    kind: 'chi' as const,
    need: 2,
    picks: [],
    options: callOptionsFor(offer, playerHand, BOOK, 'chi'),
    anyTile: false,
  };

  it('allows only tiles a remaining option still needs', () => {
    expect(canPickCopy(pending, { code: '2p', isRed: false })).toBe(true);
    expect(canPickCopy(pending, { code: '3p', isRed: false })).toBe(true);
    expect(canPickCopy(pending, { code: '9m', isRed: false })).toBe(false);
  });

  it('resolves a completed pair to its option', () => {
    const picks = [
      { code: '2p', isRed: false, index: 0, isDraw: false },
      { code: '3p', isRed: false, index: 1, isDraw: false },
    ];
    expect(callOptionForPicks(pending, picks)?.calledTile).toBe('4p');
    expect(
      callOptionForPicks(pending, [
        { code: '2p', isRed: false, index: 0, isDraw: false },
        { code: '9m', isRed: false, index: 2, isDraw: false },
      ]),
    ).toBeNull();
  });

  it('words the prompt with the tiles still needed', () => {
    expect(callPickPrompt(pending)).toBe('Select 2 tiles for Chi');
    expect(
      callPickPrompt({
        ...pending,
        picks: [{ code: '2p', isRed: false, index: 0, isDraw: false }],
      }),
    ).toBe('Select 1 more tile for Chi');
    expect(callPickPrompt({ ...pending, kind: 'pon', need: 1 })).toBe(
      'Select a tile for Pon',
    );
    expect(
      callPickPrompt({ ...pending, kind: 'riichi', need: 1, anyTile: true }),
    ).toBe('Select a tile to discard for Riichi');
  });

  it('describes each state once, from its engine facts', () => {
    expect(callContextFor(state()).isDrill).toBe(false);
    const drill = state({
      correct_action: { type: 'best', action: 'Pon', label: 'Pon' },
      ai_decision: {
        model: 'test',
        expected_value: 0,
        recommended_action: 'Pon',
        evaluations: [],
        actions: [
          { action: 'Pon', label: 'Pon', type: 'pon', tile: '5z' },
        ],
      } as GameState['ai_decision'],
    });
    expect(callContextFor(drill)).toMatchObject({
      isDrill: true,
      availableActions: [{ action: 'Pon' }],
    });
  });
});
