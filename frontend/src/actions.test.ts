import { describe, expect, it } from 'vitest';
import {
  callOfferActions,
  correctActionTile,
  isCallDecision,
  isCorrectAction,
} from './actions';
import type { GameState } from './types/game';

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
