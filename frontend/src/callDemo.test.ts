/**
 * The `?preview=calls` review set (2026-11-21).
 *
 * Each case is a complete `GameState`, so these tests assert the same facts the
 * app will: the payload validates, the engine-derived call buttons exist, and
 * the pick step's option count matches the situation the case is meant to show.
 */

import { describe, expect, it } from 'vitest';
import {
  callButtonsFor,
  callContextFor,
  callOptionsFor,
} from './callChoices';
import {
  CALL_DEMO_CASES,
  callDemoStartIndex,
  nextCallDemoIndex,
} from './callDemo';
import { isCorrectAction } from './actions';
import { snapshotFromGameState } from './renderers/snapshot';

function demo(id: string) {
  const entry = CALL_DEMO_CASES.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`no demo case ${id}`);
  return entry.state;
}

describe('call demo: the review cases', () => {
  it('every case is a complete, valid table payload', () => {
    expect(CALL_DEMO_CASES).toHaveLength(8);
    for (const entry of CALL_DEMO_CASES) {
      expect(isCorrectAction(entry.state.correct_action), entry.id).toBe(true);
      expect(entry.state.players, entry.id).toHaveLength(4);
      expect(entry.state.players[0].is_human, entry.id).toBe(true);
      expect(entry.title.length, entry.id).toBeGreaterThan(0);
      // A hand the board can draw: 13 concealed tiles plus an optional draw.
      const human = entry.state.players[0];
      expect([13, 14], entry.id).toContain(
        human.hand.length + (human.draw ? 1 : 0),
      );
      expect(JSON.parse(JSON.stringify(entry.state)), entry.id).toBeTruthy();
    }
  });

  it('each case converts to a 3D table snapshot', () => {
    for (const entry of CALL_DEMO_CASES) {
      // The 3D mount refuses a state the adapter cannot describe; every review
      // case must reach the real board, not the 2D fallback.
      expect(
        () => snapshotFromGameState(entry.state, 1, false),
        entry.id,
      ).not.toThrow();
    }
  });

  it('offers the call each case is named for, with its option count', () => {
    const expected: Array<{
      id: string;
      kind: 'chi' | 'pon' | 'kan' | 'riichi';
      options?: number;
    }> = [
      { id: 'pon-single', kind: 'pon', options: 1 },
      { id: 'pon-red', kind: 'pon', options: 2 },
      { id: 'chi-single', kind: 'chi', options: 1 },
      { id: 'chi-multi', kind: 'chi', options: 3 },
      { id: 'kan-single', kind: 'kan', options: 1 },
      { id: 'riichi-one', kind: 'riichi' },
      { id: 'riichi-many', kind: 'riichi' },
      { id: 'drill-chi', kind: 'chi', options: 3 },
    ];

    for (const want of expected) {
      const state = demo(want.id);
      const player = state.players[0];
      const context = callContextFor(state);
      const buttons = callButtonsFor(state, player, context);
      expect(
        buttons.calls.some((call) => call.kind === want.kind),
        want.id,
      ).toBe(true);
      if (want.options !== undefined) {
        expect(callOptionsFor(state, player, context, want.kind), want.id).toHaveLength(
          want.options,
        );
      }
    }
  });

  it('the drill case also offers Pass and is a model-answer payload', () => {
    const state = demo('drill-chi');
    expect(state.correct_action.type).toBe('best');
    const buttons = callButtonsFor(state, state.players[0], callContextFor(state));
    expect(buttons.pass).toBe(true);
  });

  it('starts at the requested case, or the first one', () => {
    expect(callDemoStartIndex('?preview=calls')).toBe(0);
    expect(callDemoStartIndex('?preview=calls&case=chi-multi')).toBe(3);
    expect(callDemoStartIndex('?preview=calls&case=nope')).toBe(0);
    expect(callDemoStartIndex('?renderer=3d')).toBeNull();
    expect(callDemoStartIndex('?preview=sticks')).toBeNull();
  });

  it('cycles back to the first case after the last', () => {
    expect(nextCallDemoIndex(CALL_DEMO_CASES.length - 1)).toBe(0);
    expect(nextCallDemoIndex(0)).toBe(1);
  });
});
