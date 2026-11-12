import { describe, expect, it } from 'vitest';
import { handHint } from './handHint';
import type { HandHintInput } from './handHint';

const unarmed: HandHintInput = {
  isAnswered: false,
  canDiscard: true,
  callKan: false,
  callRiichi: false,
  kanTileLabel: null,
};

describe('hand dock hint', () => {
  it('gives the same neutral instruction before any answer', () => {
    // The push/fold lesson's target action is Push or Fold straight from the
    // correct answer, so the pre-answer line must not name either: it is the
    // judgement being tested.
    expect(handHint(unarmed)).toBe('Tap a tile to discard');
  });

  it('never names push, fold or the safest tile before answering', () => {
    const preAnswer: HandHintInput[] = [
      unarmed,
      { ...unarmed, callRiichi: true },
      { ...unarmed, callKan: true, kanTileLabel: '5z' },
      { ...unarmed, canDiscard: false },
      { ...unarmed, kanTileLabel: '5z' },
    ];

    for (const hint of preAnswer) {
      const text = handHint(hint).toLowerCase();
      expect(text).not.toContain('fold');
      expect(text).not.toContain('push');
      expect(text).not.toContain('safest');
    }
  });

  it('describes the declaration the player armed', () => {
    expect(handHint({ ...unarmed, callRiichi: true })).toBe(
      'Riichi selected - tap a tile to discard',
    );
    expect(handHint({ ...unarmed, callKan: true, kanTileLabel: '5z' })).toBe(
      'Kan armed - tap 5z to declare Kan',
    );
  });

  it('asks for a button answer when no discard is legal', () => {
    expect(handHint({ ...unarmed, canDiscard: false })).toBe(
      'Choose a call or Pass',
    );
  });

  it('mentions the visible Kan toggle on a Kan lesson', () => {
    expect(handHint({ ...unarmed, kanTileLabel: '5z' })).toBe(
      'Tap a tile to discard, or arm Call Kan',
    );
  });

  it('replaces the instruction once the answer is in', () => {
    expect(
      handHint({ ...unarmed, isAnswered: true, callRiichi: true }),
    ).toBe('Answer submitted');
  });
});
