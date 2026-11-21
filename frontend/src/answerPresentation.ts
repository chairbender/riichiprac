/**
 * Turn a submitted answer into the presentation delta the answered board shows
 * (261121-1206).
 *
 * The engine grades an answer; it does not return the position after it. This
 * module reads the table the player was looking at plus the answer they gave
 * and names, in copies, what leaves the hand and what the call claims. It is
 * deliberately **not** a rules transition: it never decides legality, never
 * scores, and never advances the wall. The renderer's
 * `renderers/answeredBoard.ts` applies the delta and the store's `gameState`
 * stays untouched, so Reset returns the pre-answer board and the next deal is a
 * new revision.
 *
 * The consumed copies come from the answer's own click when the store has it
 * (`picks`), and otherwise from the same `callChoices` derivation the call bar
 * used, so a red-five pick and a two-tile Chi resolve to the physical copies
 * the player saw.
 */

import { findKanCandidateTile } from './actions';
import {
  callContextFor,
  callOptionsFor,
  displayCopies,
} from './callChoices';
import type { CallKind } from './callChoices';
import type { DisplayTile } from './display';
import type { AnsweredAction, AnswerTile } from './renderers/answeredBoard';
import type { GameState, PlayerState } from './types/game';

/** A seat index narrowed for the answered action (0–3). */
type AnswerFamilySeat = 0 | 1 | 2 | 3;

/** The answer as the store records it (`store/useGameStore.ts` mirrors Rust). */
export interface SubmittedAnswerLike {
  readonly action: 'riichi' | 'dama' | 'fold' | 'kan' | 'discard' | 'pass' | 'call' | 'best';
  readonly tile: string;
  readonly tile_index?: number;
  readonly action_name?: string;
  readonly is_tsumogiri?: boolean;
}

/** One hand copy the player picked, with the draw flag the dock supplied. */
export interface PickedCopyLike {
  readonly code: string;
  readonly isRed: boolean;
  readonly isDraw?: boolean;
}

const SEAT_COUNT = 4;

function humanOf(state: GameState): PlayerState | null {
  return state.players.find((player) => player.is_human) ?? null;
}

function seatOf(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < SEAT_COUNT
    ? value
    : null;
}

function copyOf(tile: Pick<DisplayTile, 'code' | 'isRed'>): AnswerTile {
  return { code: tile.code, isRed: tile.isRed };
}

/** The call family a book offer names. */
function offeredKind(action: string | undefined): CallKind | null {
  switch (action) {
    case 'Chi':
      return 'chi';
    case 'Kan':
      return 'kan';
    case 'Riichi':
      return 'riichi';
    case 'Pon':
      return 'pon';
    default:
      return null;
  }
}

/** The call family the answer itself names, if any. */
function answeredCallKind(
  state: GameState,
  answer: SubmittedAnswerLike,
): CallKind | null {
  const name = answer.action_name ?? '';
  if (name.startsWith('Chi')) return 'chi';
  if (name.startsWith('Pon')) return 'pon';
  if (name.startsWith('Ankan') || name === 'Kan') {
    // A Kan offered by a discard is an open kan; otherwise it is the player's
    // own declared kan, decided by the board in `selfKan`.
    const offer = state.call_offer;
    return offer && offeredKind(offer.action) === 'kan' ? 'kan' : null;
  }

  if (answer.action === 'call') {
    const offer = state.call_offer;
    const kind = offer ? offeredKind(offer.action) : null;
    return kind === 'chi' || kind === 'pon' || kind === 'kan' ? kind : null;
  }
  if (answer.action === 'kan' && state.call_offer) {
    return offeredKind(state.call_offer.action) === 'kan' ? 'kan' : null;
  }
  return null;
}

/** Hand copies of one code, in display order, with their red-five flags. */
function copiesOf(
  human: PlayerState,
  code: string,
  count: number,
  includeDraw = true,
): AnswerTile[] {
  const display = displayCopies(human).filter(
    (tile) => tile.code === code && (includeDraw || !tile.isDraw),
  );
  return display.slice(0, count).map(copyOf);
}

/** The hand copies a Chi consumes, from the same options the pick step used. */
function chiCopies(
  state: GameState,
  human: PlayerState,
  calledCode: string,
  actionName: string | undefined,
): AnswerTile[] {
  const options = callOptionsFor(state, human, callContextFor(state), 'chi');
  const option =
    options.find((candidate) => candidate.action === actionName) ??
    options.find((candidate) => candidate.calledTile === calledCode) ??
    options[0];
  return option ? option.handTiles.map(copyOf) : [];
}

/** What a call consumes, aside from the claimed discard. */
function consumedFor(
  state: GameState,
  human: PlayerState,
  kind: CallKind,
  calledCode: string,
  actionName: string | undefined,
  picks: readonly PickedCopyLike[],
): AnswerTile[] {
  if (picks.length > 0) return picks.map(copyOf);
  if (kind === 'chi') return chiCopies(state, human, calledCode, actionName);
  const count = kind === 'kan' ? 3 : 2;
  return copiesOf(human, calledCode, count);
}

/** The copy a discard names, resolved against the hand the player saw. */
function discardCopy(
  human: PlayerState,
  answer: SubmittedAnswerLike,
  picks: readonly PickedCopyLike[],
): { copy: AnswerTile; fromDraw: boolean } | null {
  const display = displayCopies(human);

  const picked = picks[0];
  if (picked) {
    return {
      copy: copyOf(picked),
      fromDraw: answer.is_tsumogiri ?? picked.isDraw ?? false,
    };
  }

  const indexed =
    typeof answer.tile_index === 'number' ? display[answer.tile_index] : undefined;
  if (indexed && (answer.tile === '' || indexed.code === answer.tile)) {
    return {
      copy: copyOf(indexed),
      fromDraw: answer.is_tsumogiri ?? indexed.isDraw,
    };
  }

  if (answer.is_tsumogiri && human.draw === answer.tile) {
    const draw = display.find((tile) => tile.isDraw);
    return draw
      ? { copy: copyOf(draw), fromDraw: true }
      : null;
  }

  const match =
    display.find((tile) => !tile.isDraw && tile.code === answer.tile) ??
    display.find((tile) => tile.code === answer.tile);
  if (!match) return null;
  return {
    copy: copyOf(match),
    fromDraw: answer.is_tsumogiri ?? match.isDraw,
  };
}

/**
 * The player's own kan: an added kan on an open Pon, or a closed kan from four
 * concealed copies. The board decides which shape is legal; this only names it.
 */
function selfKan(
  human: PlayerState,
  answer: SubmittedAnswerLike,
  picks: readonly PickedCopyLike[],
): AnsweredAction {
  const named =
    answer.tile.length > 0 && answer.tile !== 'kan' ? answer.tile : null;
  const picked = picks[0]?.code ?? null;
  const tile = named ?? picked ?? findKanCandidateTile(human);
  if (!tile) return { family: 'none' };

  const pon = human.melds.find(
    (meld) => meld.meld_type === 'Pon' && meld.tiles[0] === tile,
  );
  if (pon) {
    const [added] = copiesOf(human, tile, 1);
    return added
      ? { family: 'kan', kanTile: tile, consumed: [added] }
      : { family: 'none' };
  }

  const four = copiesOf(human, tile, 4);
  if (four.length < 4) return { family: 'none' };
  return { family: 'ankan', kanTile: tile, consumed: four };
}

/**
 * The presentation delta for one answer, or a no-op family when the answer does
 * not change the table (a pass on a non-discard decision, an AI win).
 */
export function answerPresentationFor(
  state: GameState,
  answer: SubmittedAnswerLike,
  picks: readonly PickedCopyLike[] = [],
): AnsweredAction {
  const human = humanOf(state);
  if (!human) return { family: 'none' };

  const name = answer.action_name ?? '';
  const decision = state.decision;
  const fromSeat =
    decision?.kind === 'react_to_discard' ? seatOf(decision.from) : null;

  if (answer.action === 'pass' || name === 'Pass') {
    return fromSeat !== null && decision?.kind === 'react_to_discard'
      ? { family: 'pass', called: { code: decision.tile, from: fromSeat as AnswerFamilySeat } }
      : { family: 'pass' };
  }

  const kind = answeredCallKind(state, answer);
  if (kind === 'kan') {
    const offer = state.call_offer;
    if (!offer) return selfKan(human, answer, picks);
    const calledCode = offer.tile;
    if (fromSeat === null) return { family: 'none' };
    return {
      family: 'kan',
      called: { code: calledCode, from: fromSeat as AnswerFamilySeat },
      consumed: consumedFor(state, human, 'kan', calledCode, name, picks),
    };
  }
  if (kind === 'chi' || kind === 'pon') {
    const offer = state.call_offer;
    const calledCode =
      offer?.tile ??
      (decision?.kind === 'react_to_discard' ? decision.tile : answer.tile);
    if (!calledCode || fromSeat === null) return { family: 'none' };
    return {
      family: kind,
      called: { code: calledCode, from: fromSeat as AnswerFamilySeat },
      consumed: consumedFor(state, human, kind, calledCode, name, picks),
    };
  }

  // A drill's Daiminkan is an open kan on the discard it reacts to, even though
  // only a book lesson carries a `call_offer`.
  if (name.startsWith('Daiminkan')) {
    const calledCode =
      decision?.kind === 'react_to_discard' ? decision.tile : answer.tile;
    if (!calledCode || fromSeat === null) return { family: 'none' };
    return {
      family: 'kan',
      called: { code: calledCode, from: fromSeat as AnswerFamilySeat },
      consumed: consumedFor(state, human, 'kan', calledCode, name, picks),
    };
  }

  // An AI drill names every kan `Kan`; a reaction to a discard is the open
  // (daiminkan) shape, and the state's own decision says so.
  if (
    (answer.action === 'kan' || name === 'Kan') &&
    decision?.kind === 'react_to_discard'
  ) {
    const calledCode = decision.tile;
    if (fromSeat !== null) {
      return {
        family: 'kan',
        called: { code: calledCode, from: fromSeat as AnswerFamilySeat },
        consumed: consumedFor(state, human, 'kan', calledCode, name, picks),
      };
    }
  }

  if (answer.action === 'kan' || name === 'Kan' || name.startsWith('Ankan')) {
    return selfKan(human, answer, picks);
  }

  const isDiscard =
    answer.action === 'riichi' ||
    answer.action === 'dama' ||
    answer.action === 'fold' ||
    answer.action === 'discard' ||
    (answer.action === 'best' &&
      (name === 'Riichi' || name.startsWith('Discard')));
  if (!isDiscard) return { family: 'none' };

  const resolved = discardCopy(human, answer, picks);
  if (!resolved) return { family: 'none' };
  return {
    family: answer.action === 'riichi' || name === 'Riichi' ? 'riichi' : 'discard',
    discard: { ...resolved.copy, fromDraw: resolved.fromDraw },
  };
}
