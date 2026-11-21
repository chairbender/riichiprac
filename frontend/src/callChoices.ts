/**
 * The call decisions a state offers, and the tile-pick step each one asks for.
 *
 * Calls are not an "armed" mode: a call is a plain button, and pressing it
 * either completes the call (exactly one way to make it) or opens a pick step
 * that collects the hand tiles the call consumes. This module is the pure data
 * behind both shells: which buttons exist, what the legal picks are, and which
 * option a finished pick set answers.
 *
 * The engine stays the authority. `call_offer` names the offered call, the AI
 * action list carries every legal call in a drill, and `kanToggleTile` /
 * `findKanCandidateTile` decide whether a self-turn quad is callable. Nothing
 * here re-derives a mahjong rule: it expands those facts onto the actual hand
 * copies so the UI can ask for the right number of tiles.
 */

import { canDeclareRiichi, kanToggleTile } from './actions';
import { formatTileForDisplay, sortHandForDisplay } from './display';
import type { DisplayTile } from './display';
import type { AiActionInfo } from './types/ai';
import type { GameState, PlayerState, TargetAction } from './types/game';

/** The call families the controls can offer. */
export type CallKind = 'chi' | 'pon' | 'kan' | 'riichi';

/** The order the controls render in: chi, pon, kan, then the declaration. */
export const CALL_ORDER: readonly CallKind[] = ['chi', 'pon', 'kan', 'riichi'];

/** One hand copy a call can consume, with the red-five flag that copy carries. */
export interface CallCopy {
  readonly code: string;
  readonly isRed: boolean;
}

/** A hand copy the player actually picked, with its display position. */
export interface PickedCopy extends CallCopy {
  /** Index in the sorted hand the two views share, for tsumogiri. */
  readonly index: number;
  /** True when this copy is the drawn tile. */
  readonly isDraw: boolean;
}

/** One legal way to make a call: the hand copies it takes. */
export interface CallOption {
  readonly kind: CallKind;
  /** The tile the call claims (the discard, quad or fourth tile), if any. */
  readonly calledTile: string | null;
  /** Hand copies the call consumes. A Pon/Kan pick names one tile. */
  readonly handTiles: readonly CallCopy[];
  /** The AI action this option answers (`Chi_Low`, `Pon`, ...) in a drill. */
  readonly action?: string;
}

/** One control on the call bar. */
export interface CallButtonSpec {
  readonly kind: CallKind;
  /** Visible word: `Chi`, `Pon`, `Kan`, `Riichi`. */
  readonly label: string;
  /** Screen-reader name, with the called tile when there is one. */
  readonly ariaLabel: string;
  /** Mortal action name, for the probability chip when it may be shown. */
  readonly action?: string;
}

/** Everything the shared call bar draws. */
export interface CallButtons {
  readonly calls: readonly CallButtonSpec[];
  /** A Pass/decline control for the offered call. */
  readonly pass: boolean;
}

export const NO_CALL_BUTTONS: CallButtons = { calls: [], pass: false };

/** The state facts the call derivation needs, computed once per render. */
export interface CallContext {
  /** True when the answer is the model's top action (`correct_action.best`). */
  readonly isDrill: boolean;
  /** The lesson kind, used only to decide whether a self-turn Kan exists. */
  readonly targetAction?: TargetAction;
  /** The drill's legal actions; empty for a book lesson. */
  readonly availableActions: readonly AiActionInfo[];
}

/** The call context of one payload, from the fields the engine already sends. */
export function callContextFor(state: GameState): CallContext {
  return {
    isDrill: state.correct_action.type === 'best',
    targetAction: state.target_action,
    availableActions: state.ai_decision?.actions ?? [],
  };
}

/** True when no call or Pass control would render. */
export function noCallButtons(buttons: CallButtons): boolean {
  return buttons.calls.length === 0 && !buttons.pass;
}

/**
 * Whether an AI action belongs to the call bar rather than the ActionBar.
 *
 * Calls moved out of `ActionBar` when they became click-then-pick controls, so
 * the drill's list is split here: these are the action families `CallControls`
 * owns, and everything else (Tsumo, nine terminals) stays in the ActionBar.
 */
export function isCallActionType(type: AiActionInfo['type']): boolean {
  return (
    type === 'chi' ||
    type === 'pon' ||
    type === 'kan' ||
    type === 'riichi' ||
    type === 'pass'
  );
}

/**
 * The call controls this state offers.
 *
 * - A drill answers through its own legal-action list, so the calls come from
 *   there (and a reaction's `Pass` is one of them).
 * - A book call lesson renders the engine's `call_offer` plus Pass.
 * - Otherwise the only calls are the player's own declarations: Riichi when
 *   Rust allows it, Kan when the lesson holds a callable quad.
 */
export function callButtonsFor(
  state: GameState,
  player: PlayerState,
  context: CallContext,
): CallButtons {
  const calls: CallButtonSpec[] = [];
  let pass = false;

  if (context.isDrill) {
    const seen = new Set<CallKind>();
    for (const action of context.availableActions) {
      switch (action.type) {
        case 'chi':
          if (!seen.has('chi')) {
            seen.add('chi');
            calls.push({
              kind: 'chi',
              label: 'Chi',
              ariaLabel: action.tile
                ? `Call Chi on ${formatTileForDisplay(action.tile)}`
                : 'Call Chi',
              action: action.action,
            });
          }
          break;
        case 'pon':
          if (!seen.has('pon')) {
            seen.add('pon');
            calls.push({
              kind: 'pon',
              label: 'Pon',
              ariaLabel: action.tile
                ? `Call Pon on ${formatTileForDisplay(action.tile)}`
                : 'Call Pon',
              action: action.action,
            });
          }
          break;
        case 'kan':
          if (!seen.has('kan')) {
            seen.add('kan');
            calls.push({
              kind: 'kan',
              label: 'Kan',
              ariaLabel: action.tile
                ? `Call Kan on ${formatTileForDisplay(action.tile)}`
                : 'Call Kan',
              action: action.action,
            });
          }
          break;
        case 'riichi':
          if (!seen.has('riichi')) {
            seen.add('riichi');
            calls.push({
              kind: 'riichi',
              label: 'Riichi',
              ariaLabel: 'Call Riichi',
              action: action.action,
            });
          }
          break;
        case 'pass':
          pass = true;
          break;
        default:
          break;
      }
    }
    return { calls: sortCalls(calls), pass };
  }

  const offer = state.call_offer;
  if (offer) {
    const kind = offerKind(offer.action);
    calls.push({
      kind,
      label: callName(kind),
      // The engine's own label names the call and its tile, e.g. `Pon 5z`.
      ariaLabel: `Call ${offer.label}`,
      action: offer.action,
    });
    return { calls, pass: true };
  }

  if (canDeclareRiichi(state)) {
    calls.push({
      kind: 'riichi',
      label: 'Riichi',
      ariaLabel: 'Call Riichi',
      action: 'Riichi',
    });
  }
  const kanTile = kanToggleTile(player, {
    targetAction: context.targetAction ?? state.target_action,
  });
  if (kanTile) {
    calls.push({
      kind: 'kan',
      label: 'Kan',
      ariaLabel: `Call Kan on ${formatTileForDisplay(kanTile)}`,
      action: 'Kan',
    });
  }
  return { calls: sortCalls(calls), pass: false };
}

/** The visible word for a call family, e.g. `Chi`. */
export function callName(kind: CallKind): string {
  switch (kind) {
    case 'chi':
      return 'Chi';
    case 'pon':
      return 'Pon';
    case 'kan':
      return 'Kan';
    case 'riichi':
      return 'Riichi';
  }
}

function sortCalls(calls: CallButtonSpec[]): CallButtonSpec[] {
  return [...calls].sort(
    (left, right) =>
      CALL_ORDER.indexOf(left.kind) - CALL_ORDER.indexOf(right.kind),
  );
}

function offerKind(action: string): CallKind {
  switch (action) {
    case 'Chi':
      return 'chi';
    case 'Kan':
      return 'kan';
    case 'Riichi':
      return 'riichi';
    default:
      return 'pon';
  }
}

/** The hand copies of the human, in the display order both views share. */
export function displayCopies(player: PlayerState): DisplayTile[] {
  return sortHandForDisplay(player.hand, player.draw, player.red_fives);
}

/**
 * The legal pick options for one call, in hand terms.
 *
 * Chi collects two hand tiles, so each option is a pair of copies (red/plain
 * five variants included). Pon and Kan collect one tile, so each option is one
 * copy: when the hand holds a red and a plain five of the called tile, the two
 * are separate options and the player must choose. A Riichi declaration's
 * discard options come from Rust, not from here.
 */
export function callOptionsFor(
  state: GameState,
  player: PlayerState,
  context: CallContext,
  kind: CallKind,
): CallOption[] {
  if (kind === 'riichi') return [];

  const display = displayCopies(player);
  const hand = display.filter((tile) => !tile.isDraw);

  if (kind === 'chi') return chiOptions(state, context, hand);

  const pool = kind === 'kan' ? display : hand;
  const options: CallOption[] = [];
  for (const source of singleCallSources(state, player, context, kind)) {
    for (const copy of uniqueCopies(pool.filter((tile) => tile.code === source.calledTile))) {
      options.push({
        kind,
        calledTile: source.calledTile,
        handTiles: [copy],
        action: source.action,
      });
    }
  }
  return dedupeOptions(options);
}

interface CallSource {
  readonly calledTile: string;
  readonly action?: string;
}

function singleCallSources(
  state: GameState,
  player: PlayerState,
  context: CallContext,
  kind: 'pon' | 'kan',
): CallSource[] {
  if (context.isDrill) {
    return context.availableActions
      .filter((action) => action.type === kind && Boolean(action.tile))
      .map((action) => ({ calledTile: action.tile as string, action: action.action }));
  }

  const offer = state.call_offer;
  if (offer && offerKind(offer.action) === kind) {
    return [{ calledTile: offer.tile, action: offer.action }];
  }

  if (kind === 'kan') {
    const tile = kanToggleTile(player, {
      targetAction: context.targetAction ?? state.target_action,
    });
    return tile ? [{ calledTile: tile, action: 'Kan' }] : [];
  }
  return [];
}

function chiOptions(
  state: GameState,
  context: CallContext,
  hand: readonly DisplayTile[],
): CallOption[] {
  const options: CallOption[] = [];

  if (context.isDrill) {
    for (const action of context.availableActions) {
      if (action.type !== 'chi' || !action.tile) continue;
      const pairs =
        action.tiles && action.tiles.length === 2
          ? [action.tiles]
          : runPairs(action.tile, hand);
      for (const pair of pairs) {
        for (const expanded of expandPair(pair, hand)) {
          options.push({
            kind: 'chi',
            calledTile: action.tile,
            handTiles: expanded,
            action: action.action,
          });
        }
      }
    }
    return dedupeOptions(options);
  }

  const offer = state.call_offer;
  if (offer && offerKind(offer.action) === 'chi') {
    const pairs =
      offer.tiles && offer.tiles.length === 2
        ? [offer.tiles]
        : runPairs(offer.tile, hand);
    for (const pair of pairs) {
      for (const expanded of expandPair(pair, hand)) {
        options.push({
          kind: 'chi',
          calledTile: offer.tile,
          handTiles: expanded,
          action: offer.action,
        });
      }
    }
  }
  return dedupeOptions(options);
}

/**
 * The two hand tiles of every run that the called tile completes.
 *
 * Only used when a payload names a Chi offer without its `tiles` (older or
 * hand-built states): the engine normally supplies them.
 */
export function runPairs(
  calledTile: string,
  hand: readonly Pick<DisplayTile, 'code'>[],
): string[][] {
  const value = Number(calledTile[0]);
  const suit = calledTile[1];
  if (!Number.isInteger(value) || !suit || !'mps'.includes(suit)) return [];

  const held = new Set(hand.map((tile) => tile.code));
  const pairs: string[][] = [];
  const add = (low: number, high: number) => {
    if (low < 1 || high > 9) return;
    const found = [`${low}${suit}`, `${high}${suit}`];
    if (found.every((code) => held.has(code))) pairs.push(found);
  };
  add(value - 2, value - 1);
  add(value - 1, value + 1);
  add(value + 1, value + 2);
  return pairs;
}

/** Every red/plain combination of a pair of tile codes in the hand. */
function expandPair(
  pair: readonly string[],
  hand: readonly DisplayTile[],
): CallCopy[][] {
  const groups = pair.map((code) => uniqueCopies(hand.filter((tile) => tile.code === code)));
  if (groups.some((group) => group.length === 0)) return [];

  return groups.reduce<CallCopy[][]>(
    (prefixes, group) =>
      prefixes.flatMap((prefix) => group.map((copy) => [...prefix, copy])),
    [[]],
  );
}

/** One copy per distinct (tile, red) pair, in hand order. */
export function uniqueCopies(tiles: readonly DisplayTile[]): CallCopy[] {
  const seen = new Set<string>();
  const out: CallCopy[] = [];
  for (const tile of tiles) {
    const key = `${tile.code}|${tile.isRed}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ code: tile.code, isRed: tile.isRed });
  }
  return out;
}

function dedupeOptions(options: readonly CallOption[]): CallOption[] {
  const seen = new Set<string>();
  const out: CallOption[] = [];
  for (const option of options) {
    const key = `${option.kind}|${option.calledTile ?? ''}|${option.action ?? ''}|${copyKey(
      option.handTiles,
    )}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(option);
  }
  return out;
}

function copyKey(copies: readonly CallCopy[]): string {
  return copies
    .map((copy) => `${copy.code}|${copy.isRed}`)
    .sort()
    .join(',');
}

/**
 * True when this copy is part of any legal option (or every tile, when Riichi's
 * list is unknown). This is the set the pick step leaves bright; every other
 * hand tile is darkened and inert.
 */
export function isSelectableCopy(pending: PendingCall, copy: CallCopy): boolean {
  if (pending.anyTile) return true;
  return pending.options.some(
    (option) => countCopy(option.handTiles, copy) > 0,
  );
}

/** True when this copy is already one of the pick's selections. */
export function isPickedCopy(pending: PendingCall, copy: CallCopy): boolean {
  return countCopy(pending.picks, copy) > 0;
}

/** True when this copy may be the next pick of the pending call. */
export function canPickCopy(pending: PendingCall, copy: CallCopy): boolean {
  if (pending.anyTile) return true;
  return pending.options.some(
    (option) =>
      containsAll(option.handTiles, pending.picks) &&
      countCopy(option.handTiles, copy) > countCopy(pending.picks, copy),
  );
}

/** The option a completed pick set answers, or null when it answers none. */
export function callOptionForPicks(
  pending: PendingCall,
  picks: readonly PickedCopy[],
): CallOption | null {
  if (pending.anyTile) {
    return { kind: 'riichi', calledTile: null, handTiles: picks };
  }
  return (
    pending.options.find((option) => sameCopies(option.handTiles, picks)) ?? null
  );
}

/** The visible prompt for a pending call. */
export function callPickPrompt(pending: PendingCall): string {
  const left = pending.need - pending.picks.length;
  switch (pending.kind) {
    case 'chi':
      if (pending.picks.length >= pending.need) {
        // A full pair that is not a run stays selected; the next tile replaces
        // the oldest one.
        return 'Select another tile for Chi';
      }
      return left > 1 ? 'Select 2 tiles for Chi' : 'Select 1 more tile for Chi';
    case 'pon':
      return 'Select a tile for Pon';
    case 'kan':
      return 'Select a tile for Kan';
    case 'riichi':
      return 'Select a tile to discard for Riichi';
  }
}

function countCopy(copies: readonly CallCopy[], copy: CallCopy): number {
  return copies.filter(
    (candidate) => candidate.code === copy.code && candidate.isRed === copy.isRed,
  ).length;
}

function containsAll(
  available: readonly CallCopy[],
  picks: readonly CallCopy[],
): boolean {
  const used = new Map<string, number>();
  for (const pick of picks) {
    const key = `${pick.code}|${pick.isRed}`;
    used.set(key, (used.get(key) ?? 0) + 1);
    if ((used.get(key) ?? 0) > countCopy(available, pick)) return false;
  }
  return true;
}

function sameCopies(
  left: readonly CallCopy[],
  right: readonly CallCopy[],
): boolean {
  if (left.length !== right.length) return false;
  return (
    containsAll(left, right) &&
    containsAll(right, left)
  );
}

/**
 * Every hand copy a call preview should raise: the union of all its legal
 * options. A Riichi preview is not built here because its discard list comes
 * from Rust; the store asks the engine for it.
 */
export function previewCopiesFor(
  options: readonly CallOption[],
): CallCopy[] {
  const seen = new Set<string>();
  const copies: CallCopy[] = [];
  for (const option of options) {
    for (const copy of option.handTiles) {
      const key = `${copy.code}|${copy.isRed}`;
      if (seen.has(key)) continue;
      seen.add(key);
      copies.push(copy);
    }
  }
  return copies;
}

/**
 * The state of an open pick step.
 *
 * It is a mode only for as long as the tile choice takes: pressing a call
 * starts it, Cancel (or Escape) ends it, and a completed pick submits the
 * answer and closes it. There is no armed flag the next click can carry.
 */
export interface PendingCall {
  readonly kind: CallKind;
  /** How many hand tiles the call consumes. */
  readonly need: number;
  readonly picks: readonly PickedCopy[];
  /** Legal options, frozen when the step opened. */
  readonly options: readonly CallOption[];
  /**
   * Riichi only: the engine could not list the legal declaration discards, so
   * every hand tile is pickable and the engine grades the choice. When the list
   * is known the step carries it in `options` instead, and `anyTile` is false.
   */
  readonly anyTile: boolean;
}
