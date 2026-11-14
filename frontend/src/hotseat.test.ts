import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOTSEAT_OPTIONS,
  HOTSEAT_DISPARITIES,
  HOTSEAT_ROUNDS,
  HOTSEAT_SCENARIO_ID,
  HOTSEAT_SEATS,
  hotseatDraft,
  hotseatDraftSummary,
  hotseatOptionsFromDraft,
  hotseatOptionsJson,
  hotseatProgressLabel,
  hotseatTurnFromNote,
  isHotseatOnly,
} from './hotseat';

describe('AI Hotseat options', () => {
  it('serializes every unpinned option as null', () => {
    expect(JSON.parse(hotseatOptionsJson(DEFAULT_HOTSEAT_OPTIONS))).toEqual({
      round: null,
      disparity: null,
      seat: null,
    });
  });

  it('serializes pinned options and leaves the rest null', () => {
    const json = JSON.parse(
      hotseatOptionsJson({
        round: 'south_3',
        disparity: null,
        seat: 'west',
      }),
    );
    expect(json).toEqual({ round: 'south_3', disparity: null, seat: 'west' });
  });

  it('offers every round, disparity, and seat the Rust card accepts', () => {
    expect(HOTSEAT_ROUNDS.map((round) => round.value)).toEqual([
      'east_1',
      'east_2',
      'east_3',
      'east_4',
      'south_1',
      'south_2',
      'south_3',
      'south_4',
    ]);
    expect(HOTSEAT_DISPARITIES).toHaveLength(9);
    expect(HOTSEAT_SEATS.map((seat) => seat.value)).toEqual([
      'east',
      'south',
      'west',
      'north',
    ]);
  });

  it('starts every row random and round-trips a pinned draft', () => {
    const draft = hotseatDraft(DEFAULT_HOTSEAT_OPTIONS);
    expect(draft.round.random).toBe(true);
    expect(hotseatOptionsFromDraft(draft)).toEqual(DEFAULT_HOTSEAT_OPTIONS);

    const pinned = hotseatDraft({
      round: 'east_2',
      disparity: 'in_first_by_large_gap',
      seat: 'north',
    });
    expect(pinned.round.random).toBe(false);
    expect(hotseatOptionsFromDraft(pinned)).toEqual({
      round: 'east_2',
      disparity: 'in_first_by_large_gap',
      seat: 'north',
    });
  });

  it('ticking Random clears a pinned value', () => {
    const draft = hotseatDraft({
      round: 'east_2',
      disparity: 'about_equal_all',
      seat: 'north',
    });
    const cleared = {
      ...draft,
      disparity: { ...draft.disparity, random: true },
    };
    expect(hotseatOptionsFromDraft(cleared).disparity).toBeNull();
    expect(hotseatOptionsFromDraft(cleared).round).toBe('east_2');
  });

  it('summarises what is pinned', () => {
    expect(hotseatDraftSummary(hotseatDraft(DEFAULT_HOTSEAT_OPTIONS))).toBe(
      'Everything random',
    );
    expect(
      hotseatDraftSummary(
        hotseatDraft({
          round: 'east_1',
          disparity: null,
          seat: 'south',
        }),
      ),
    ).toContain('2 pinned');
  });

  it('labels play progress with the current turn and draw count', () => {
    expect(hotseatProgressLabel(null)).toBe(
      'Playing a Mortal self-play round…',
    );
    expect(
      hotseatProgressLabel({
        attempt: 1,
        turn: 7,
        drawn: 25,
        wall_left: 44,
      }),
    ).toBe('Playing a Mortal self-play round… turn 7 · 25 draws played');
    expect(
      hotseatProgressLabel({
        attempt: 1,
        turn: 1,
        drawn: 1,
        wall_left: 68,
      }),
    ).toBe('Playing a Mortal self-play round… turn 1 · 1 draw played');
    expect(
      hotseatProgressLabel({
        attempt: 3,
        turn: 12,
        drawn: 45,
        wall_left: 24,
      }),
    ).toContain('attempt 3');
  });

  it('reads the inserted turn from the scenario note', () => {
    expect(hotseatTurnFromNote('Mortal self-play. Inserted on turn 12.')).toBe(
      12,
    );
    expect(hotseatTurnFromNote('no turn here')).toBeNull();
    expect(hotseatTurnFromNote(null)).toBeNull();
  });

  it('recognises the hotseat-only pool', () => {
    expect(isHotseatOnly({ kind: 'selected', ids: [HOTSEAT_SCENARIO_ID] })).toBe(
      true,
    );
    expect(
      isHotseatOnly({
        kind: 'selected',
        ids: [HOTSEAT_SCENARIO_ID, 'ryanmen_protorun'],
      }),
    ).toBe(false);
    expect(isHotseatOnly({ kind: 'all' })).toBe(false);
  });
});
