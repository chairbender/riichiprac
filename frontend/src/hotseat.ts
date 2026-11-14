/**
 * AI Hotseat generation options.
 *
 * The Rust generator owns the rules; this module only names the card's choices
 * and turns them into the JSON the WASM evaluator expects. `null` means the
 * player left that option random.
 */

export const HOTSEAT_SCENARIO_ID = 'ai_hotseat';

export type HotseatRound =
  | 'east_1'
  | 'east_2'
  | 'east_3'
  | 'east_4'
  | 'south_1'
  | 'south_2'
  | 'south_3'
  | 'south_4';

export type HotseatDisparity =
  | 'losing_badly_alone'
  | 'losing_badly_with_third'
  | 'about_equal_with_two'
  | 'one_big_gap_to_first'
  | 'about_equal_all'
  | 'about_equal_between_two'
  | 'large_gap_to_fourth'
  | 'about_equal_with_first_and_second'
  | 'in_first_by_large_gap';

export type HotseatSeat = 'east' | 'south' | 'west' | 'north';

/** One complete card choice; a null field is drawn by the engine. */
export interface HotseatOptions {
  round: HotseatRound | null;
  disparity: HotseatDisparity | null;
  seat: HotseatSeat | null;
}

export const DEFAULT_HOTSEAT_OPTIONS: HotseatOptions = {
  round: null,
  disparity: null,
  seat: null,
};

export const HOTSEAT_ROUNDS: ReadonlyArray<{
  value: HotseatRound;
  label: string;
}> = [
  { value: 'east_1', label: 'East 1' },
  { value: 'east_2', label: 'East 2' },
  { value: 'east_3', label: 'East 3' },
  { value: 'east_4', label: 'East 4' },
  { value: 'south_1', label: 'South 1' },
  { value: 'south_2', label: 'South 2' },
  { value: 'south_3', label: 'South 3' },
  { value: 'south_4', label: 'South 4' },
];

export const HOTSEAT_DISPARITIES: ReadonlyArray<{
  value: HotseatDisparity;
  label: string;
  hint: string;
}> = [
  {
    value: 'losing_badly_alone',
    label: 'Losing badly alone',
    hint: 'Last, with a big gap to third place.',
  },
  {
    value: 'losing_badly_with_third',
    label: 'Losing badly with third',
    hint: 'Fourth and third are both far behind first and second.',
  },
  {
    value: 'about_equal_with_two',
    label: 'Level with two others',
    hint: 'A close top three, with fourth behind.',
  },
  {
    value: 'one_big_gap_to_first',
    label: 'One big gap to first',
    hint: 'Second, well behind the leader.',
  },
  {
    value: 'about_equal_all',
    label: 'Level with all four',
    hint: 'Every seat within a thousand points.',
  },
  {
    value: 'about_equal_between_two',
    label: 'Level with one other',
    hint: 'Neck and neck with one seat, clear of the other two.',
  },
  {
    value: 'large_gap_to_fourth',
    label: 'Large gap to fourth',
    hint: 'Third, well ahead of last place.',
  },
  {
    value: 'about_equal_with_first_and_second',
    label: 'Level with first and second',
    hint: 'A close top three, with fourth well behind.',
  },
  {
    value: 'in_first_by_large_gap',
    label: 'First by a large gap',
    hint: 'Leading, with a big cushion to second.',
  },
];

export const HOTSEAT_SEATS: ReadonlyArray<{
  value: HotseatSeat;
  label: string;
}> = [
  { value: 'east', label: 'East' },
  { value: 'south', label: 'South' },
  { value: 'west', label: 'West' },
  { value: 'north', label: 'North' },
];

/** The JSON the worker sends to `generate_hotseat_puzzle`. */
export function hotseatOptionsJson(options: HotseatOptions): string {
  return JSON.stringify({
    round: options.round,
    disparity: options.disparity,
    seat: options.seat,
  });
}

/** True when the committed pool is exactly the hotseat scenario. */
export function isHotseatOnly(selection: {
  kind: string;
  ids?: readonly string[];
}): boolean {
  return (
    selection.kind === 'selected' &&
    selection.ids?.length === 1 &&
    selection.ids[0] === HOTSEAT_SCENARIO_ID
  );
}

/** One row's card state: the choice and whether it is left random. */
export interface HotseatChoice<T> {
  random: boolean;
  value: T;
}

/** The card's editable state, one entry per option. */
export interface HotseatDraft {
  round: HotseatChoice<HotseatRound>;
  disparity: HotseatChoice<HotseatDisparity>;
  seat: HotseatChoice<HotseatSeat>;
}

/** Build the card's initial draft from a previous choice (all random by default). */
export function hotseatDraft(options: HotseatOptions): HotseatDraft {
  return {
    round: {
      random: options.round === null,
      value: options.round ?? HOTSEAT_ROUNDS[0].value,
    },
    disparity: {
      random: options.disparity === null,
      value: options.disparity ?? HOTSEAT_DISPARITIES[0].value,
    },
    seat: {
      random: options.seat === null,
      value: options.seat ?? HOTSEAT_SEATS[0].value,
    },
  };
}

/** Turn the card's draft back into the options JSON uses. */
export function hotseatOptionsFromDraft(draft: HotseatDraft): HotseatOptions {
  return {
    round: draft.round.random ? null : draft.round.value,
    disparity: draft.disparity.random ? null : draft.disparity.value,
    seat: draft.seat.random ? null : draft.seat.value,
  };
}

/** A short summary of what is pinned, for the deal button. */
export function hotseatDraftSummary(draft: HotseatDraft): string {
  const pinned: string[] = [];
  if (!draft.round.random) {
    pinned.push(
      HOTSEAT_ROUNDS.find((round) => round.value === draft.round.value)?.label ??
        'round',
    );
  }
  if (!draft.disparity.random) {
    pinned.push(
      HOTSEAT_DISPARITIES.find(
        (disparity) => disparity.value === draft.disparity.value,
      )?.label ?? 'points',
    );
  }
  if (!draft.seat.random) {
    pinned.push(
      HOTSEAT_SEATS.find((seat) => seat.value === draft.seat.value)?.label ??
        'seat',
    );
  }
  if (pinned.length === 0) return 'Everything random';
  if (pinned.length === 3) return 'All pinned';
  return `${pinned.length} pinned · ${pinned.join(' · ')}`;
}
