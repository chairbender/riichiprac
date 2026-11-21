import { describe, expect, it } from 'vitest';
import { handHint } from './handHint';
import type { HandHintInput } from './handHint';
import type { PendingCall } from './callChoices';

const neutral: HandHintInput = {
  isAnswered: false,
  canDiscard: true,
  pendingCall: null,
  hasKanCall: false,
};

const riichiPick: PendingCall = {
  kind: 'riichi',
  need: 1,
  picks: [],
  options: [],
  anyTile: true,
};

const chiPick: PendingCall = {
  kind: 'chi',
  need: 2,
  picks: [],
  options: [],
  anyTile: false,
};

describe('hand dock hint', () => {
  it('gives the same neutral instruction before any answer', () => {
    // The push/fold lesson's target action is Push or Fold straight from the
    // correct answer, so the pre-answer line must not name either: it is the
    // judgement being tested.
    expect(handHint(neutral)).toBe('Tap a tile to discard');
  });

  it('never names push, fold or the safest tile before answering', () => {
    const preAnswer: HandHintInput[] = [
      neutral,
      { ...neutral, hasKanCall: true },
      { ...neutral, canDiscard: false },
      { ...neutral, pendingCall: riichiPick },
      { ...neutral, pendingCall: chiPick },
    ];

    for (const hint of preAnswer) {
      const text = handHint(hint).toLowerCase();
      expect(text).not.toContain('fold');
      expect(text).not.toContain('push');
      expect(text).not.toContain('safest');
    }
  });

  it('asks for the tiles an open call pick needs', () => {
    expect(handHint({ ...neutral, pendingCall: riichiPick })).toBe(
      'Select a tile to discard for Riichi',
    );
    expect(handHint({ ...neutral, pendingCall: chiPick })).toBe(
      'Select 2 tiles for Chi',
    );
    expect(
      handHint({
        ...neutral,
        pendingCall: {
          ...chiPick,
          picks: [
            { code: '2p', isRed: false, index: 0, isDraw: false },
          ],
        },
      }),
    ).toBe('Select 1 more tile for Chi');
    expect(
      handHint({
        ...neutral,
        pendingCall: { ...chiPick, kind: 'pon', need: 1 },
      }),
    ).toBe('Select a tile for Pon');
  });

  it('asks for a button answer when no discard is legal', () => {
    expect(handHint({ ...neutral, canDiscard: false })).toBe(
      'Choose a call or Pass',
    );
  });

  it('mentions the visible Kan button on a Kan lesson', () => {
    expect(handHint({ ...neutral, hasKanCall: true })).toBe(
      'Tap a tile to discard, or call Kan',
    );
  });

  it('replaces the instruction once the answer is in', () => {
    expect(
      handHint({ ...neutral, isAnswered: true, pendingCall: chiPick }),
    ).toBe('Answer submitted');
  });
});
