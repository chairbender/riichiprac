/**
 * The store's call flow: press a call, pick its tiles, or cancel.
 *
 * These tests exercise the interaction the two shells drive, without React:
 * exactly one legal option submits on the press, a real choice opens a pick
 * step whose picks are validated, and Cancel leaves the hand unanswered. The
 * wasm module is doubled so grading is just a stub; the Riichi discard list is
 * the one engine helper the UI asks for.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const wasmMock = vi.hoisted(() => ({ riichiDiscards: [] as string[] }));

vi.mock('riichiprac', () => ({
  grade_answer_json: vi.fn(() =>
    JSON.stringify({
      mode: 'book_only',
      book: null,
      mortal: null,
      outcome: 'ungraded',
    }),
  ),
}));

vi.mock('../wasm', () => ({
  ensureWasmReady: async () => undefined,
  riichiDiscardTiles: () => wasmMock.riichiDiscards,
}));

import { CALL_DEMO_CASES } from '../callDemo';
import { useGameStore } from './useGameStore';
import type { CorrectAction, GameState, PlayerState } from '../types/game';

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

function seat(overrides: Partial<PlayerState> = {}, human = false): PlayerState {
  return {
    ...player(overrides),
    seat: 1,
    name: 'Shimocha',
    is_human: human,
  };
}

function state(human: PlayerState, overrides: Partial<GameState> = {}): GameState {
  return {
    category: 'test',
    target_action: 'Call',
    correct_action: { type: 'pass' },
    decision: { kind: 'react_to_discard', from: 3, tile: '4p' },
    riichi_triggers: [],
    dama_reasons: [],
    shouminkan_triggers: [],
    hand_string: human.hand.join(''),
    tiles: [...human.hand, ...(human.draw ? [human.draw] : [])],
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
    current_turn: 1,
    can_riichi: false,
    players: [
      human,
      seat({ wind: 'South' }),
      seat({ wind: 'West' }),
      seat({ wind: 'North' }),
    ],
    ...overrides,
  };
}

function load(game: GameState): void {
  useGameStore.getState().loadFromJson(JSON.stringify(game));
}

function correctAction(action: CorrectAction): CorrectAction {
  return action;
}

beforeEach(() => {
  useGameStore.getState().reset();
  wasmMock.riichiDiscards = [];
});

describe('calls: one legal option submits on the press', () => {
  it('completes a Pon whose hand holds the pair', () => {
    const human = player({ hand: ['5z', '5z', '1m', '2m', '3m', '4m', '6m'] });
    load(
      state(human, {
        call_offer: { action: 'Pon', label: 'Pon Wh', tile: '5z' },
      }),
    );

    useGameStore.getState().beginCall('pon');

    expect(useGameStore.getState().pendingCall).toBeNull();
    expect(useGameStore.getState().submittedAnswer).toMatchObject({
      action: 'call',
      action_name: 'Pon',
    });
  });

  it('completes a Chi whose two tiles are the only run', () => {
    const human = player({ hand: ['2p', '3p', '9m', '9m', '9m', '1z', '1z'] });
    load(
      state(human, {
        decision: { kind: 'react_to_discard', from: 3, tile: '4p' },
        call_offer: {
          action: 'Chi',
          label: 'Chi 2p 3p on 4p',
          tile: '4p',
          tiles: ['2p', '3p'],
        },
      }),
    );

    useGameStore.getState().beginCall('chi');

    expect(useGameStore.getState().pendingCall).toBeNull();
    expect(useGameStore.getState().submittedAnswer).toMatchObject({
      action: 'call',
      action_name: 'Chi',
    });
  });

  it('completes a self-turn Kan on four identical copies', () => {
    const human = player({ hand: ['1m', '1m', '1m', '1m', '2p', '3p', '4p'] });
    load(
      state(human, {
        target_action: 'Kan',
        decision: { kind: 'self_turn' },
        correct_action: correctAction({ type: 'kan', tile: '1m' }),
      }),
    );

    useGameStore.getState().beginCall('kan');

    expect(useGameStore.getState().pendingCall).toBeNull();
    expect(useGameStore.getState().submittedAnswer).toMatchObject({
      action: 'kan',
      tile: '1m',
    });
  });

  it('completes Riichi when Rust lists exactly one legal discard', () => {
    const human = player({ hand: ['1m', '2m', '3m', '4p', '5p', '6p', '7s'], draw: '3p' });
    wasmMock.riichiDiscards = ['3p'];
    load(
      state(human, {
        target_action: 'Riichi',
        decision: { kind: 'self_turn' },
        correct_action: correctAction({ type: 'riichi', discard: '3p' }),
        can_riichi: true,
      }),
    );

    useGameStore.getState().beginCall('riichi');

    expect(useGameStore.getState().pendingCall).toBeNull();
    expect(useGameStore.getState().submittedAnswer).toMatchObject({
      action: 'riichi',
      tile: '3p',
    });
  });
});

describe('calls: a real choice opens a pick step', () => {
  it('asks which five to pon, then submits the picked copy', () => {
    const human = player({
      hand: ['5m', '5m', '1m', '2m', '3m', '4m', '6m'],
      red_fives: ['5m'],
    });
    load(
      state(human, {
        decision: { kind: 'react_to_discard', from: 3, tile: '5m' },
        call_offer: { action: 'Pon', label: 'Pon 5m', tile: '5m' },
      }),
    );

    useGameStore.getState().beginCall('pon');
    expect(useGameStore.getState().pendingCall?.kind).toBe('pon');
    expect(useGameStore.getState().pendingCall?.options).toHaveLength(2);

    // Sorted hand: 1m 2m 3m 4m 5m 5m 6m; index 4 is the red copy.
    useGameStore.getState().pickCallTile('5m', 4);

    expect(useGameStore.getState().pendingCall).toBeNull();
    expect(useGameStore.getState().submittedAnswer).toMatchObject({
      action: 'call',
      action_name: 'Pon',
    });
  });

  it('collects Riichi’s discard when there is more than one legal tile', () => {
    const human = player({ hand: ['1m', '2m', '3m', '4p', '5p', '6p', '7s'], draw: '3p' });
    wasmMock.riichiDiscards = ['3p', '7s'];
    load(
      state(human, {
        target_action: 'Riichi',
        decision: { kind: 'self_turn' },
        correct_action: correctAction({ type: 'riichi', discard: '3p' }),
        can_riichi: true,
      }),
    );

    useGameStore.getState().beginCall('riichi');
    expect(useGameStore.getState().pendingCall).toMatchObject({
      kind: 'riichi',
      need: 1,
      // The engine's list is known, so only those tiles are pickable.
      anyTile: false,
      options: [
        { handTiles: [{ code: '3p', isRed: false }] },
        { handTiles: [{ code: '7s', isRed: false }] },
      ],
    });

    useGameStore.getState().pickCallTile('7s', 7);

    expect(useGameStore.getState().submittedAnswer).toMatchObject({
      action: 'riichi',
      tile: '7s',
      tile_index: 7,
    });
  });

  it('collects both tiles of a drill Chi and names the matching action', () => {
    const human = player({ hand: ['2p', '3p', '5p', '6p', '9m', '9m', '1z'] });
    load(
      state(human, {
        decision: { kind: 'react_to_discard', from: 3, tile: '4p' },
        correct_action: correctAction({ type: 'best', action: 'Chi_Low', label: 'Chi' }),
        ai_decision: {
          model: 'test',
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
              label: 'Chi 5p 6p on 4p',
              type: 'chi',
              tile: '4p',
              tiles: ['5p', '6p'],
            },
            { action: 'Pass', label: 'Pass', type: 'pass' },
          ],
        },
      }),
    );

    useGameStore.getState().beginCall('chi');
    expect(useGameStore.getState().pendingCall?.options).toHaveLength(2);

    // First tile of the 5p/6p run, then its partner.
    // Sorted hand: 9m 9m 2p 3p 5p 6p 1z; index 4 is the 5p.
    useGameStore.getState().pickCallTile('5p', 4);
    expect(useGameStore.getState().pendingCall?.picks).toHaveLength(1);
    useGameStore.getState().pickCallTile('6p', 5);

    expect(useGameStore.getState().submittedAnswer).toMatchObject({
      action: 'best',
      action_name: 'Chi_Mid',
      tile: '4p',
    });
  });
});

describe('calls: the ?preview=calls review set', () => {
  function demo(id: string) {
    const entry = CALL_DEMO_CASES.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`no demo case ${id}`);
    return entry.state;
  }

  it('walks the shortcuts and the pick steps the set is built for', () => {
    load(demo('pon-single'));
    useGameStore.getState().beginCall('pon');
    expect(useGameStore.getState().pendingCall).toBeNull();
    expect(useGameStore.getState().submittedAnswer).toMatchObject({
      action: 'call',
      action_name: 'Pon',
    });

    load(demo('pon-red'));
    useGameStore.getState().beginCall('pon');
    expect(useGameStore.getState().pendingCall?.options).toHaveLength(2);

    load(demo('chi-single'));
    useGameStore.getState().beginCall('chi');
    expect(useGameStore.getState().pendingCall).toBeNull();
    expect(useGameStore.getState().submittedAnswer).toMatchObject({
      action: 'call',
      action_name: 'Chi',
    });

    load(demo('chi-multi'));
    useGameStore.getState().beginCall('chi');
    expect(useGameStore.getState().pendingCall).toMatchObject({ need: 2 });
    expect(useGameStore.getState().pendingCall?.options).toHaveLength(3);

    load(demo('kan-single'));
    useGameStore.getState().beginCall('kan');
    expect(useGameStore.getState().pendingCall).toBeNull();
    expect(useGameStore.getState().submittedAnswer).toMatchObject({
      action: 'kan',
      tile: '1m',
    });
  });

  it('the two Riichi cases are the one-discard shortcut and the choice', () => {
    wasmMock.riichiDiscards = ['9s'];
    load(demo('riichi-one'));
    useGameStore.getState().beginCall('riichi');
    expect(useGameStore.getState().pendingCall).toBeNull();
    expect(useGameStore.getState().submittedAnswer).toMatchObject({
      action: 'riichi',
      tile: '9s',
    });

    wasmMock.riichiDiscards = ['3p', '1p', '2p'];
    load(demo('riichi-many'));
    useGameStore.getState().beginCall('riichi');
    expect(useGameStore.getState().pendingCall).toMatchObject({ kind: 'riichi' });
    expect(useGameStore.getState().pendingCall?.options).toHaveLength(3);
  });
});

describe('calls: hover preview and selection', () => {
  function drillChi() {
    return state(
      player({ hand: ['2p', '3p', '5p', '6p', '9m', '9m', '1z'] }),
      {
        decision: { kind: 'react_to_discard', from: 3, tile: '4p' },
        correct_action: correctAction({ type: 'best', action: 'Chi_Low', label: 'Chi' }),
        ai_decision: {
          model: 'test',
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
              label: 'Chi 5p 6p on 4p',
              type: 'chi',
              tile: '4p',
              tiles: ['5p', '6p'],
            },
            { action: 'Pass', label: 'Pass', type: 'pass' },
          ],
        },
      },
    );
  }

  it('previews every tile any option would use, and clears on leave', () => {
    load(drillChi());

    useGameStore.getState().previewCall('chi');
    expect(
      (useGameStore.getState().callPreview ?? []).map((copy) => copy.code),
    ).toEqual(['2p', '3p', '5p', '6p']);

    useGameStore.getState().previewCall(null);
    expect(useGameStore.getState().callPreview).toBeNull();
  });

  it('previews the legal Riichi discards the engine lists', () => {
    const human = player({ hand: ['1m', '2m', '3m', '4p', '5p', '6p', '7s'], draw: '3p' });
    wasmMock.riichiDiscards = ['3p', '7s'];
    load(
      state(human, {
        target_action: 'Riichi',
        decision: { kind: 'self_turn' },
        correct_action: correctAction({ type: 'riichi', discard: '3p' }),
        can_riichi: true,
      }),
    );

    useGameStore.getState().previewCall('riichi');

    expect(
      (useGameStore.getState().callPreview ?? []).map((copy) => copy.code),
    ).toEqual(['3p', '7s']);
  });

  it('lowers the preview when the call opens', () => {
    load(drillChi());
    useGameStore.getState().previewCall('chi');
    expect(useGameStore.getState().callPreview).not.toBeNull();

    useGameStore.getState().beginCall('chi');
    expect(useGameStore.getState().callPreview).toBeNull();
    expect(useGameStore.getState().pendingCall?.kind).toBe('chi');
  });

  it('toggles a picked tile off when it is clicked again', () => {
    load(drillChi());
    useGameStore.getState().beginCall('chi');

    useGameStore.getState().pickCallTile('5p', 4);
    expect(useGameStore.getState().pendingCall?.picks.map((p) => p.code)).toEqual([
      '5p',
    ]);

    useGameStore.getState().pickCallTile('5p', 4);
    expect(useGameStore.getState().pendingCall?.picks).toEqual([]);
    expect(useGameStore.getState().submittedAnswer).toBeNull();
  });

  it('keeps only the most recent two tiles raised when a third is picked', () => {
    load(drillChi());
    useGameStore.getState().beginCall('chi');

    // 2p and 5p are each selectable, but together they are not a Chi.
    useGameStore.getState().pickCallTile('2p', 2);
    useGameStore.getState().pickCallTile('5p', 4);
    expect(useGameStore.getState().pendingCall?.picks.map((p) => p.code)).toEqual([
      '2p',
      '5p',
    ]);
    expect(useGameStore.getState().callError).toBe(
      'Those tiles do not make a Chi.',
    );

    // A third tile drops the oldest, leaving 5p + 6p, which is Chi_Mid.
    useGameStore.getState().pickCallTile('6p', 5);
    expect(useGameStore.getState().submittedAnswer).toMatchObject({
      action: 'best',
      action_name: 'Chi_Mid',
    });
  });
});

describe('calls: rejections, cancel and pass', () => {
  it('rejects a pick outside the call with a clear message', () => {
    // A red and a plain five make the 5p/6p run two separate options, so the
    // pick step opens instead of submitting on the press.
    load(
      state(
        player({
          hand: ['5p', '5p', '6p', '9m', '1z', '1z', '1z'],
          red_fives: ['5p'],
        }),
        {
          decision: { kind: 'react_to_discard', from: 3, tile: '4p' },
          call_offer: {
            action: 'Chi',
            label: 'Chi 5p 6p on 4p',
            tile: '4p',
            tiles: ['5p', '6p'],
          },
        },
      ),
    );

    useGameStore.getState().beginCall('chi');
    expect(useGameStore.getState().pendingCall).not.toBeNull();

    // Sorted hand: 9m 5p 5p 6p 1z 1z 1z; index 0 is the 9m outside the run.
    useGameStore.getState().pickCallTile('9m', 0);

    expect(useGameStore.getState().submittedAnswer).toBeNull();
    expect(useGameStore.getState().callError).toBe(
      'That tile cannot be used for this Chi.',
    );
    if (useGameStore.getState().pendingCall === null) {
      throw new Error('the pick must stay open after a rejected tile');
    }
  });

  it('rejects a Riichi discard the engine did not list', () => {
    const human = player({ hand: ['1m', '2m', '3m', '4p', '5p', '6p', '7s'], draw: '3p' });
    wasmMock.riichiDiscards = ['3p', '7s'];
    load(
      state(human, {
        target_action: 'Riichi',
        decision: { kind: 'self_turn' },
        correct_action: correctAction({ type: 'riichi', discard: '3p' }),
        can_riichi: true,
      }),
    );

    useGameStore.getState().beginCall('riichi');
    // 1m is in the hand but breaks tenpai, so Rust did not list it.
    useGameStore.getState().pickCallTile('1m', 0);

    expect(useGameStore.getState().pendingCall).not.toBeNull();
    expect(useGameStore.getState().submittedAnswer).toBeNull();
    expect(useGameStore.getState().callError).toBe(
      'That tile cannot be discarded for Riichi.',
    );
  });

  it('cancels without touching the answer', () => {
    const human = player({
      hand: ['5p', '5p', '6p', '9m', '1z', '1z', '1z'],
      red_fives: ['5p'],
    });
    load(
      state(human, {
        decision: { kind: 'react_to_discard', from: 3, tile: '4p' },
        call_offer: {
          action: 'Chi',
          label: 'Chi 5p 6p on 4p',
          tile: '4p',
          tiles: ['5p', '6p'],
        },
      }),
    );

    useGameStore.getState().beginCall('chi');
    expect(useGameStore.getState().pendingCall?.kind).toBe('chi');
    useGameStore.getState().cancelCall();

    expect(useGameStore.getState().pendingCall).toBeNull();
    expect(useGameStore.getState().callError).toBeNull();
    expect(useGameStore.getState().submittedAnswer).toBeNull();
  });

  it('submits Pass as the decline answer', () => {
    const human = player({ hand: ['5z', '5z', '1m', '2m', '3m', '4m', '6m'] });
    load(
      state(human, {
        call_offer: { action: 'Pon', label: 'Pon Wh', tile: '5z' },
      }),
    );

    useGameStore.getState().submitAction({ action: 'Pass' });

    expect(useGameStore.getState().submittedAnswer).toMatchObject({
      action: 'pass',
    });
  });
});
