/**
 * The answered board (261121-1206): the picture the 3D table shows after the
 * player answers, rather than the frozen decision position behind the verdict.
 *
 * **Decision: presentation-only.** The engine has no post-action `GameState`
 * and the 3D plan forbids changing the Rust/WASM engine, so this module applies
 * a bounded, purely visual delta to the *snapshot* the table is already
 * showing. Nothing here is graded, persisted, exported or fed to the rules
 * engine: the store's `gameState` is untouched, Reset returns the base
 * snapshot, and the next deal is a new revision. It also never invents a rule
 * the engine does not support — a Riichi declaration shows its discard and
 * stick, a Kan shows its meld but does not flip a new dora or draw from the dead
 * wall, and no score or pot is settled.
 *
 * Every family the trainer can answer is covered:
 *
 * - **discard / dama / fold / riichi**: the chosen copy leaves the hand (or the
 *   draw) and lands as the seat's newest river tile, sideways when it is the
 *   Riichi declaration; the remaining draw folds back into the hand, the hand
 *   re-flows in display order, and play passes to the next seat.
 * - **chi / pon / open kan**: the claimed discard leaves the discarder's river,
 *   the consumed hand copies and the claimed tile form the caller's new meld
 *   (the called tile sideways at its committed slot), the human hand re-flows,
 *   and the caller is next to discard.
 * - **added kan / concealed kan**: the meld grows or appears, the hand loses its
 *   copies, and the caller acts next.
 * - **pass**: no tile moves; the call marker clears and play passes the
 *   discarder.
 *
 * Every tile keeps the snapshot's `uid`, including the ones that move, so the
 * renderer can pair the old and new poses and animate between them
 * (`three/motion.ts`). The answered snapshot is the same `revision` with
 * `transition: 'answered'`; that is the one exception to the cut rule.
 */

import { tileSortValue } from '../display';
import { calledTile } from '../meld';
import type { CalledMeld, MeldType } from '../types/game';
import { faceIdForTile } from './contract';
import type {
  Seat,
  SnapshotMeld,
  SnapshotSeat,
  SnapshotTile,
  TableSnapshot,
} from './contract';

/** How an answer changes the board, in trainer vocabulary. */
export type AnswerFamily =
  | 'discard'
  | 'riichi'
  | 'chi'
  | 'pon'
  | 'kan'
  | 'ankan'
  | 'pass'
  | 'none';

/** One hand copy an answer names, with the red-five flag that copy carries. */
export interface AnswerTile {
  readonly code: string;
  readonly isRed: boolean;
}

/**
 * The presentation delta of one answer.
 *
 * Derived once per answer from the state and the submitted answer
 * (`answerPresentation.ts`), then applied to the snapshot by
 * {@link answeredBoard}. It names copies, never rules: {@link consumed} is the
 * list of hand copies that leave the hand, {@link called} is the discard an
 * open call claims, and the rest is what the table shows.
 */
export interface AnsweredAction {
  readonly family: AnswerFamily;
  /** The copy that leaves the hand or draw for a discard/declaration. */
  readonly discard?: AnswerTile & { readonly fromDraw: boolean };
  /** Hand copies a call or kan consumes, not counting a claimed discard. */
  readonly consumed?: readonly AnswerTile[];
  /** The claimed discard of an open call or open kan. */
  readonly called?: { readonly code: string; readonly from: Seat };
  /** The tile a self-turn kan is made from (`5m`, `5z`, ...). */
  readonly kanTile?: string;
}

const SEAT_COUNT = 4;

function nextSeat(seat: Seat): Seat {
  return ((seat + 1) % SEAT_COUNT) as Seat;
}

function seatAt(snapshot: TableSnapshot, seat: Seat): SnapshotSeat | undefined {
  return snapshot.seats.find((candidate) => candidate.seat === seat);
}

function cloneSeat(seat: SnapshotSeat): SnapshotSeat {
  return {
    ...seat,
    concealed: [...seat.concealed],
    melds: [...seat.melds],
    river: [...seat.river],
  };
}

/**
 * Fill in a hand-authored fixture's missing `uid`s from its positions.
 *
 * The adapter always supplies uids; a preview fixture may not. Stamping them
 * here means the motion pairing works for either source, and a tile that moves
 * still leaves the slide with one identity.
 */
function withUids(seat: SnapshotSeat): SnapshotSeat {
  const prefix = `s${seat.seat}`;
  const uid = (tile: SnapshotTile, fallback: string): SnapshotTile =>
    tile.uid ? tile : { ...tile, uid: fallback };
  return {
    ...seat,
    concealed: seat.concealed.map((tile, slot) =>
      uid(tile, `${prefix}-hand-${slot}`),
    ),
    draw: seat.draw
      ? uid(seat.draw, `${prefix}-draw-${seat.concealed.length}`)
      : null,
    river: seat.river.map((tile, slot) => uid(tile, `${prefix}-river-${slot}`)),
    melds: seat.melds.map((meld, meldIndex) => ({
      ...meld,
      tiles: meld.tiles.map((tile, slot) =>
        uid(tile, `${prefix}-meld-${meldIndex * 4 + slot}`),
      ),
    })),
  };
}

function normalizeUids(base: TableSnapshot): TableSnapshot {
  return { ...base, seats: base.seats.map(withUids) as unknown as TableSnapshot['seats'] };
}

/** The tile a copy paints, red five included. */
function faceOf(copy: AnswerTile): SnapshotTile['face'] {
  return faceIdForTile(copy.code, copy.isRed);
}

function faceOfCode(code: string): SnapshotTile['face'] {
  return faceIdForTile(code);
}

/** Re-slot a zone's list after an insert or removal, keeping every uid. */
function reindex(
  tiles: readonly SnapshotTile[],
  zone: SnapshotTile['zone'],
): SnapshotTile[] {
  return tiles.map((tile, slot) =>
    tile.zone === zone && tile.slot === slot
      ? tile
      : { ...tile, zone, slot },
  );
}

/**
 * Fold the active draw back into the concealed hand, in display order.
 *
 * After any answer the draw is no longer "the tile just drawn": it is part of
 * the hand the next decision reads, exactly as the next `GameState` would show
 * it. Sorting here is the same manzu/pinzu/souzu/honors order the snapshot uses,
 * so a re-flowed hand matches what the next deal's adapter would produce.
 */
function foldDrawIntoHand(
  concealed: readonly SnapshotTile[],
  draw: SnapshotTile | null,
): SnapshotTile[] {
  const all = draw ? [...concealed, draw] : [...concealed];
  all.sort((left, right) => tileSortValue(left.face) - tileSortValue(right.face));
  return all.map((tile, slot) => ({ ...tile, zone: 'hand', slot }));
}

interface HandState {
  concealed: SnapshotTile[];
  draw: SnapshotTile | null;
}

/**
 * Remove one copy from the hand: the first matching concealed tile, else the
 * draw. Returns null when the board does not hold the copy at all, so a stale
 * or hand-edited answer cannot delete an unrelated tile.
 */
function takeCopy(hand: HandState, copy: AnswerTile): SnapshotTile | null {
  const face = faceOf(copy);
  const index = hand.concealed.findIndex((tile) => tile.face === face);
  if (index >= 0) {
    return hand.concealed[index];
  }
  if (hand.draw?.face === face) return hand.draw;
  return null;
}

interface Consumption {
  /** The very tiles the copies named, in the copies' order (uids preserved). */
  readonly entries: SnapshotTile[];
  readonly concealed: SnapshotTile[];
  readonly draw: SnapshotTile | null;
}

/**
 * Take the named copies out of the hand, draw included when the copy names it.
 *
 * The entries are the original tile objects, not look-alikes, so a hand tile
 * that becomes a meld tile keeps its `uid` and the renderer can fly it there.
 * A copy the hand does not hold is skipped rather than stealing another tile.
 */
function consume(hand: HandState, copies: readonly AnswerTile[]): Consumption {
  const concealed = [...hand.concealed];
  let draw = hand.draw;
  const entries: SnapshotTile[] = [];
  for (const copy of copies) {
    const face = faceOf(copy);
    const index = concealed.findIndex((tile) => tile.face === face);
    if (index >= 0) {
      entries.push(concealed[index]);
      concealed.splice(index, 1);
      continue;
    }
    if (draw?.face === face) {
      entries.push(draw);
      draw = null;
    }
  }
  return { entries, concealed, draw };
}

/** A seat's river with one tile removed and the rest re-slotted. */
function removeRiverTile(seat: SnapshotSeat, index: number): SnapshotSeat {
  return {
    ...seat,
    river: reindex(
      seat.river.filter((_, position) => position !== index),
      'river',
    ),
  };
}

/** The committed sideways slot of a call's called tile, or null. */
function calledSlot(
  kind: MeldType,
  size: number,
  calledFrom: Seat | null,
  caller: Seat,
): number | null {
  const meld: CalledMeld = {
    meld_type: kind,
    tiles: Array.from({ length: size }, () => '1m'),
    called_from: calledFrom,
  };
  return calledTile(meld, caller)?.index ?? null;
}

/** Compose a meld from already-ordered tiles, marking the sideways slot. */
function composeMeld(
  kind: MeldType,
  ordered: readonly SnapshotTile[],
  calledFrom: Seat | null,
  caller: Seat,
): SnapshotMeld {
  const sideways = calledSlot(kind, ordered.length, calledFrom, caller);
  return {
    kind,
    tiles: ordered.map((tile, slot) => ({
      ...tile,
      zone: 'meld',
      slot,
      sideways: sideways === slot,
      highlighted: false,
      dimmed: false,
    })),
    calledFrom,
  };
}

/**
 * Place a called tile at its committed slot and fill the other slots in order.
 *
 * Pon and open-kan tiles are identical, so only the sideways slot distinguishes
 * which came from the discard. Chi tiles are not identical, so the caller passes
 * them already sorted and the committed convention marks the run's leftmost
 * tile sideways (the engine does not record which tile of the run was claimed).
 */
function orderedForCall(
  kind: 'Pon' | 'Kan',
  handTiles: readonly SnapshotTile[],
  called: SnapshotTile | null,
  calledFrom: Seat | null,
  caller: Seat,
): SnapshotTile[] {
  const size = kind === 'Pon' ? 3 : 4;
  const rest = [...handTiles];
  const slot = calledSlot(kind, size, calledFrom, caller);
  const out: SnapshotTile[] = [];
  for (let index = 0; index < size; index += 1) {
    if (called && index === slot) out.push(called);
    else {
      const next = rest.shift();
      if (next) out.push(next);
    }
  }
  return out;
}

/**
 * Apply one answer to the base snapshot and return the answered board.
 *
 * The input snapshot must be the *unaanswered* position (or the same position
 * with only its `locked` flag set): the delta is relative to what the player is
 * looking at. Reset discards the result rather than reversing it.
 */
export function answeredBoard(
  base: TableSnapshot,
  action: AnsweredAction,
): TableSnapshot {
  if (action.family === 'none') return base;
  base = normalizeUids(base);

  const humanSeat = base.humanSeat;
  const seats: SnapshotSeat[] = base.seats.map(cloneSeat);
  const human = seats[humanSeat];
  const highlightDiscard = null;
  let currentTurn: Seat = base.currentTurn;

  if (action.family === 'pass') {
    if (action.called) currentTurn = nextSeat(action.called.from);
    return {
      ...base,
      seats: seats as unknown as TableSnapshot['seats'],
      currentTurn,
      highlightDiscard,
      transition: 'answered',
      locked: true,
    };
  }

  if (action.family === 'discard' || action.family === 'riichi') {
    const discard = action.discard;
    if (!discard) return { ...base, transition: 'answered', locked: true };

    const hand: HandState = { concealed: [...human.concealed], draw: human.draw };
    const face = faceOf(discard);
    let taken: SnapshotTile | null = null;
    if (discard.fromDraw && hand.draw?.face === face) {
      taken = hand.draw;
      hand.draw = null;
    } else {
      taken = takeCopy(hand, discard);
    }
    if (!taken) return { ...base, transition: 'answered', locked: true };

    const concealed = hand.concealed.filter((tile) => tile !== taken);
    const draw = hand.draw === taken ? null : hand.draw;
    const riichi = action.family === 'riichi';
    const riverIndex = human.river.length;
    const river = [
      ...human.river,
      {
        ...taken,
        zone: 'river' as const,
        slot: riverIndex,
        faceUp: true,
        sideways: riichi,
        highlighted: false,
        dimmed: discard.fromDraw,
      },
    ];

    seats[humanSeat] = {
      ...human,
      concealed: foldDrawIntoHand(concealed, draw),
      draw: null,
      river: reindex(river, 'river'),
      riichi: riichi || human.riichi,
      riichiDiscardIndex: riichi ? riverIndex : human.riichiDiscardIndex,
    };
    currentTurn = nextSeat(humanSeat);
  } else if (
    action.family === 'chi' ||
    action.family === 'pon' ||
    action.family === 'kan' ||
    action.family === 'ankan'
  ) {
    const called = action.called ?? null;
    const claim = called ? findClaim(base, called) : null;
    const hand: HandState = { concealed: [...human.concealed], draw: human.draw };

    if (action.family === 'ankan') {
      const consumed = consume(hand, action.consumed ?? []);
      if (consumed.entries.length !== 4) {
        return { ...base, transition: 'answered', locked: true };
      }
      seats[humanSeat] = {
        ...human,
        concealed: foldDrawIntoHand(consumed.concealed, consumed.draw),
        draw: null,
        melds: [
          ...human.melds,
          composeMeld('Ankan', consumed.entries, null, humanSeat),
        ],
      };
      currentTurn = humanSeat;
    } else if (action.family === 'kan' && !called) {
      // A self-turn kan: the fourth copy of an open Pon makes an added kan.
      // Four concealed copies are the `ankan` family above, so a missing Pon
      // target changes nothing on the table.
      const tile = action.kanTile;
      const ponIndex = tile
        ? human.melds.findIndex(
            (meld) =>
              meld.kind === 'Pon' && meld.tiles[0]?.face === faceOfCode(tile),
          )
        : -1;
      if (ponIndex >= 0) {
        const pon = human.melds[ponIndex];
        const consumed = consume(hand, [
          { code: tile as string, isRed: false },
        ]);
        if (consumed.entries.length === 0) {
          return { ...base, transition: 'answered', locked: true };
        }
        // The Pon's called tile is already sideways at its committed slot; find
        // it from the recorded source and carry it to the four-tile kan slot.
        const oldCalledIndex = calledSlot(
          'Pon',
          pon.tiles.length,
          pon.calledFrom,
          humanSeat,
        );
        const calledEntry = oldCalledIndex === null ? null : pon.tiles[oldCalledIndex];
        const rest = pon.tiles.filter((candidate) => candidate !== calledEntry);
        const orderedAdded = orderedForCall(
          'Kan',
          [...rest, ...consumed.entries],
          calledEntry,
          pon.calledFrom,
          humanSeat,
        );
        if (orderedAdded.length !== 4) {
          return { ...base, transition: 'answered', locked: true };
        }
        const melds = [...human.melds];
        melds[ponIndex] = composeMeld(
          'Kan',
          orderedAdded,
          pon.calledFrom,
          humanSeat,
        );
        seats[humanSeat] = {
          ...human,
          concealed: foldDrawIntoHand(consumed.concealed, consumed.draw),
          draw: null,
          melds,
        };
        currentTurn = humanSeat;
      }
    } else {
      if (called && !claim) {
        // The claim names a discard this board does not show: draw nothing
        // rather than fabricate the called tile.
        return { ...base, transition: 'answered', locked: true };
      }
      const consumed = consume(hand, action.consumed ?? []);
      if (!called && consumed.entries.length === 0) {
        return { ...base, transition: 'answered', locked: true };
      }
      const claimed: SnapshotTile = claim?.tile ?? {
        face: faceOfCode(called?.code ?? ''),
        zone: 'meld',
        slot: 0,
        faceUp: true,
        sideways: false,
      };
      const kind: MeldType =
        action.family === 'chi' ? 'Chi' : action.family === 'pon' ? 'Pon' : 'Kan';
      const calledFrom = called?.from ?? null;
      const ordered =
        kind === 'Chi'
          ? [...consumed.entries, claimed].sort(
              (left, right) =>
                tileSortValue(left.face) - tileSortValue(right.face),
            )
          : orderedForCall(
              kind === 'Kan' ? 'Kan' : 'Pon',
              consumed.entries,
              claimed,
              calledFrom,
              humanSeat,
            );
      const expected = kind === 'Chi' ? 3 : kind === 'Pon' ? 3 : 4;
      if (ordered.length !== expected) {
        // The answer named copies the hand does not hold: draw nothing rather
        // than inventing a short meld.
        return { ...base, transition: 'answered', locked: true };
      }
      // The claimed discard leaves its owner's river first, so the caller's own
      // state is read after that seat has been updated.
      if (claim && claim.seat.seat !== humanSeat) {
        seats[claim.seat.seat] = removeRiverTile(
          seats[claim.seat.seat],
          claim.index,
        );
      }
      const caller = seats[humanSeat];
      seats[humanSeat] = {
        ...caller,
        concealed: foldDrawIntoHand(consumed.concealed, consumed.draw),
        draw: null,
        melds: [
          ...caller.melds,
          composeMeld(kind, ordered, calledFrom, humanSeat),
        ],
      };
      currentTurn = humanSeat;
    }
  }

  return {
    ...base,
    seats: seats as unknown as TableSnapshot['seats'],
    currentTurn,
    highlightDiscard,
    transition: 'answered',
    locked: true,
  };
}

interface Claim {
  readonly seat: SnapshotSeat;
  readonly index: number;
  readonly tile: SnapshotTile;
}

/**
 * The discard an open call claims: the snapshot's own call marker when it names
 * that seat, else the seat's newest tile of the claimed face.
 */
function findClaim(
  base: TableSnapshot,
  called: { readonly code: string; readonly from: Seat },
): Claim | null {
  const seat = seatAt(base, called.from);
  if (!seat || seat.river.length === 0) return null;
  if (base.highlightDiscard?.seat === called.from) {
    const index = base.highlightDiscard.index;
    const tile = seat.river[index];
    if (tile) return { seat, index, tile };
  }
  const face = faceOfCode(called.code);
  for (let index = seat.river.length - 1; index >= 0; index -= 1) {
    if (seat.river[index].face === face) {
      return { seat, index, tile: seat.river[index] };
    }
  }
  return null;
}
