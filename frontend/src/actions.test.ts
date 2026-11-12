import { describe, expect, it } from 'vitest';
import {
  callOfferActions,
  correctActionTile,
  findKanCandidateTile,
  isCallDecision,
  isCorrectAction,
} from './actions';
import type { GameState, PlayerState } from './types/game';

const callState = {
  correct_action: { type: 'pass' },
  call_offer: {
    action: 'Pon',
    label: 'Pon Wh',
    tile: '5z',
    tiles: [],
  },
} as unknown as GameState;

describe('call-or-pass lesson wiring', () => {
  it('accepts the pass answer and names no tile', () => {
    expect(isCorrectAction({ type: 'pass' })).toBe(true);
    expect(isCallDecision({ type: 'pass' })).toBe(true);
    expect(correctActionTile({ type: 'pass' })).toBeNull();
  });

  it('rejects an unknown answer family', () => {
    // The Rust payload for a declined call is `{"type":"pass"}`.
    expect(isCorrectAction({ type: 'pass' })).toBe(true);
    expect(isCorrectAction({ type: 'unknown' })).toBe(false);
  });

  it('renders the offered call and Pass from the Rust offer', () => {
    const actions = callOfferActions(callState);

    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({
      action: 'Pon',
      label: 'Pon Wh',
      type: 'pon',
      tile: '5z',
    });
    expect(actions[1]).toMatchObject({ action: 'Pass', type: 'pass' });
  });

  it('renders nothing when the state offers no call', () => {
    expect(callOfferActions({} as GameState)).toEqual([]);
  });
});

describe('Kan candidate detection', () => {
  function player(overrides: Partial<PlayerState>): PlayerState {
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
    } as unknown as PlayerState;
  }

  it('finds the fourth tile of an open Pon', () => {
    const human = player({
      hand: ['1m', '2m', '3m', '5p', '5z', '5z', '6s', '7s', '8s', '9s'],
      draw: '5z',
      melds: [
        { meld_type: 'Pon', tiles: ['5z', '5z', '5z'], called_from: 1 },
      ],
    });
    expect(findKanCandidateTile(human)).toBe('5z');
  });

  it('finds a concealed quad from four copies in hand plus the draw', () => {
    const human = player({
      hand: ['4m', '4m', '4m', '5p', '6p', '7p', '2s', '3s', '8s', '9s'],
      draw: '4m',
    });
    expect(findKanCandidateTile(human)).toBe('4m');
  });

  it('finds a concealed quad held entirely in hand', () => {
    const human = player({
      hand: ['4m', '4m', '4m', '4m', '5p', '6p', '7p', '2s', '3s', '8s'],
      draw: '9s',
    });
    // Four copies already in hand are still a legal concealed quad this turn.
    expect(findKanCandidateTile(human)).toBe('4m');
  });

  it('does not treat three copies as a quad', () => {
    const human = player({
      hand: ['4m', '4m', '4m', '5p', '6p', '7p', '2s', '3s', '8s', '9s'],
      draw: '1z',
    });
    expect(findKanCandidateTile(human)).toBeNull();
  });
});
