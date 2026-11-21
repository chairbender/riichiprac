/**
 * `GameState` -> `TableSnapshot` (3D-01).
 *
 * The adapter is the **only** producer of a snapshot (decision D3): the
 * renderer never reads `GameState` and never calls WASM per frame. It is a pure
 * function of the serialized state plus the host's revision/locked flags, so it
 * is unit-testable in Node and cannot depend on a canvas, a clock or three.js.
 *
 * It mirrors the game semantics the 2.5D views already encode:
 *
 * - the hand is in **display order**, not the engine's: manzu, pinzu, souzu,
 *   then honors, each by rank — the same order `sortHandForDisplay` gives the
 *   dock. The 3D canvas and the projected buttons must show the same hand, so
 *   the sort happens here, once, rather than in one of the two views;
 * - red fives are resolved in the engine's hand order and then the draw, and
 *   the flag travels with its copy through the sort, exactly like
 *   `sortHandForDisplay` (`src/display.ts`);
 * - the called tile of a meld is the sideways one, exactly like `src/meld.ts`
 *   and the plan view's `MeldList`;
 * - a riichi declaration tile is sideways both when the discard says so and
 *   when `riichi_discard_index` names it, as `River` does; and
 * - the claimed discard is the seat's newest one, which is what the call/ron
 *   offer (`decision.kind === 'react_to_discard'`) names.
 */

import { calledTile } from '../meld';
import { tileSortValue } from '../display';
import type { GameState, PlayerState } from '../types/game';
import { faceIdForTile } from './contract';
import type {
  HighlightDiscard,
  Seat,
  SnapshotMeld,
  SnapshotSeat,
  SnapshotTile,
  TableSnapshot,
  Zone,
} from './contract';
import { wallSlotId, wallSlots } from './wall';

/** Narrow an engine seat number to a {@link Seat}, or null when out of range. */
function seatIndex(value: unknown): Seat | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 3
    ? (value as Seat)
    : null;
}

/**
 * A per-call red-five allocator. `GameState.red_fives` lists *codes*, not
 * copies, so the first matching hand tile (then the draw) consumes each flag,
 * which is the same rule `sortHandForDisplay` uses.
 */
function redFiveAllocator(codes: readonly string[]): (code: string) => boolean {
  const remaining = new Map<string, number>();
  for (const code of codes) {
    remaining.set(code, (remaining.get(code) ?? 0) + 1);
  }
  return (code) => {
    const count = remaining.get(code) ?? 0;
    if (count === 0) return false;
    remaining.set(code, count - 1);
    return true;
  };
}

interface TileSpec {
  readonly face: SnapshotTile['face'];
  readonly zone: Zone;
  readonly slot: number;
  /** Stable identity for the answered transition (see `SnapshotTile.uid`). */
  readonly uid: string;
  readonly faceUp: boolean;
  readonly sideways?: boolean;
  readonly highlighted?: boolean;
  readonly dimmed?: boolean;
}

function tile(spec: TileSpec): SnapshotTile {
  return {
    face: spec.face,
    uid: spec.uid,
    zone: spec.zone,
    slot: spec.slot,
    faceUp: spec.faceUp,
    sideways: spec.sideways === true,
    ...(spec.highlighted ? { highlighted: true } : {}),
    ...(spec.dimmed ? { dimmed: true } : {}),
  };
}

/** First player per seat wins, matching the plan view's placement rule. */
function indexPlayers(players: readonly PlayerState[]): Map<Seat, PlayerState> {
  const bySeat = new Map<Seat, PlayerState>();
  for (const player of players) {
    const seat = seatIndex(player.seat);
    if (seat === null) {
      throw new Error(`3D table snapshot: invalid seat ${String(player.seat)}`);
    }
    if (!bySeat.has(seat)) bySeat.set(seat, player);
  }
  return bySeat;
}

/** A valid river index, or null. */
function riverIndex(value: number | null, length: number): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < length
    ? value
    : null;
}

/**
 * The newest discard a call/ron offer names, or null.
 *
 * Only `react_to_discard` names a tile in a river: a ron on an added kan
 * (`react_to_kan`) names a tile that is not there, so nothing is highlighted.
 * The offer must also agree with the seat's newest discard, so a stale or
 * hand-edited payload cannot point the marker at the wrong tile.
 */
function deriveHighlightDiscard(
  state: GameState,
  bySeat: ReadonlyMap<Seat, PlayerState>,
): HighlightDiscard | null {
  const decision = state.decision;
  if (decision?.kind !== 'react_to_discard') return null;

  const seat = seatIndex(decision.from);
  if (seat === null) return null;
  const player = bySeat.get(seat);
  if (!player || player.discards.length === 0) return null;

  const index = player.discards.length - 1;
  if (player.discards[index].tile !== decision.tile) return null;
  return { seat, index };
}

/** Validate a host-supplied highlight against the actual rivers. */
function normalizeHighlight(
  value: HighlightDiscard | null,
  bySeat: ReadonlyMap<Seat, PlayerState>,
): HighlightDiscard | null {
  if (!value) return null;
  const seat = seatIndex(value.seat);
  if (seat === null) return null;
  const player = bySeat.get(seat);
  if (!player) return null;
  return riverIndex(value.index, player.discards.length) === null
    ? null
    : { seat, index: value.index };
}

function buildSeat(
  player: PlayerState,
  seat: Seat,
  highlight: HighlightDiscard | null,
): SnapshotSeat {
  const red = redFiveAllocator(player.red_fives);
  /** A tile identity unique within this seat's snapshot. */
  const uid = (zone: Zone, slot: number): string =>
    `s${seat}-${zone}-${slot}`;

  /*
   * The hand in display order (user request 2026-11-20): the 3D canvas and
   * 3D-08's projected buttons must show the same hand, and the dock has always
   * sorted its tiles. The allocation of red fives happens in the engine's hand
   * order and then the draw — the rule `sortHandForDisplay` uses — so the flag
   * is attached before the sort and travels with its copy. `sort` is stable, so
   * equal tiles keep the engine's relative order, exactly like the dock's
   * `sourceIndex` tie-break.
   */
  const handEntries = player.hand.map((code) => ({
    code,
    isRed: red(code),
  }));
  const drawEntry = player.draw
    ? { code: player.draw, isRed: red(player.draw) }
    : null;
  handEntries.sort(
    (left, right) => tileSortValue(left.code) - tileSortValue(right.code),
  );

  const concealed = handEntries.map((entry, slot) =>
    tile({
      face: faceIdForTile(entry.code, entry.isRed),
      zone: 'hand',
      slot,
      uid: uid('hand', slot),
      faceUp: true,
    }),
  );

  const draw = drawEntry
    ? tile({
        face: faceIdForTile(drawEntry.code, drawEntry.isRed),
        zone: 'draw',
        slot: handEntries.length,
        uid: uid('draw', handEntries.length),
        faceUp: true,
      })
    : null;

  const riichiDiscardIndex = riverIndex(
    player.riichi_discard_index,
    player.discards.length,
  );

  const river = player.discards.map((discard, index) =>
    tile({
      face: faceIdForTile(discard.tile, discard.is_red === true),
      zone: 'river',
      slot: index,
      uid: uid('river', index),
      faceUp: true,
      sideways: discard.is_riichi || riichiDiscardIndex === index,
      highlighted: highlight?.seat === seat && highlight.index === index,
      dimmed: discard.is_tsumogiri,
    }),
  );

  const melds: SnapshotMeld[] = player.melds.map((meld, meldIndex) => {
    const called = calledTile(meld, player.seat);
    return {
      kind: meld.meld_type,
      tiles: meld.tiles.map((code, index) =>
        tile({
          face: faceIdForTile(code),
          zone: 'meld',
          slot: index,
          uid: uid('meld', meldIndex * 4 + index),
          faceUp: true,
          sideways: called?.index === index,
        }),
      ),
      calledFrom: seatIndex(meld.called_from),
    };
  });

  return {
    seat,
    wind: player.wind,
    score: player.score,
    concealed,
    draw,
    melds,
    river,
    riichi: player.is_riichi,
    riichiDiscardIndex,
  };
}

/**
 * The wall at a decision: the fixed 14-tile dead wall plus the live wall's
 * remaining tiles, from the published live count.
 *
 * Face ids stay `blank` because the tiles are face-down. `renderers/wall.ts`
 * owns which slots exist; this adapter only maps them to snapshot tiles, so the
 * 3D layout can never disagree with the count the compass shows.
 */
function buildWall(tilesRemaining: number, humanSeat: Seat): SnapshotTile[] {
  return wallSlots(tilesRemaining, humanSeat).map(({ run, stack, tier }) =>
    tile({
      face: 'blank',
      zone: 'wall',
      slot: wallSlotId(run, stack, tier),
      uid: `wall-${wallSlotId(run, stack, tier)}`,
      faceUp: false,
    }),
  );
}

/** Recursively freeze a snapshot in development, so no view can mutate it. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/**
 * Debug preview only (`?preview=sticks`, 3D-09): the same table with every seat
 * marked riichi.
 *
 * A real hand often has no declaration, which makes the per-seat felt sticks
 * and the compass's riichi markers invisible to a reviewer. This copy lets the
 * 3D view show all four without touching the game state, the snapshot adapter
 * or the answer: the store never sees it, and it is applied only to the 3D
 * view's snapshot. Every other field, including each seat's recorded
 * `riichiDiscardIndex`, is left exactly as the real state had it.
 */
export function withPreviewRiichi(snapshot: TableSnapshot): TableSnapshot {
  return {
    ...snapshot,
    seats: snapshot.seats.map((seat) => ({
      ...seat,
      riichi: true,
    })) as unknown as TableSnapshot['seats'],
  };
}

/**
 * Build the immutable snapshot for one table.
 *
 * @param state   The serialized Rust state. Read only.
 * @param revision The host's revision, incremented on every new `GameState`.
 *   A new revision is a cut; the renderer never animates a diff across it.
 * @param locked  True once the app has an answer for this hand (the plan calls
 *   this `answered`). The snapshot only carries the flag; the host owns it.
 * @param highlightDiscard Overrides the derived call/ron highlight. Omit it to
 *   derive from `state.decision`; pass null to force no highlight.
 *
 * @throws when the state has no human, a missing/invalid seat, or a face code
 *   outside the committed vocabulary. A table that cannot be drawn honestly
 *   must fail loudly at the snapshot boundary.
 */
export function snapshotFromGameState(
  state: GameState,
  revision: number,
  locked: boolean,
  highlightDiscard?: HighlightDiscard | null,
): TableSnapshot {
  if (!Number.isInteger(revision) || revision < 0) {
    throw new Error(
      `3D table snapshot: revision must be a non-negative integer, got ${String(revision)}`,
    );
  }

  const bySeat = indexPlayers(state.players);
  const human = state.players.find((player) => player.is_human);
  if (!human) {
    throw new Error('3D table snapshot: state has no human player');
  }
  const humanSeat = seatIndex(human.seat);
  if (humanSeat === null) {
    throw new Error(`3D table snapshot: invalid human seat ${String(human.seat)}`);
  }
  const currentTurn = seatIndex(state.current_turn);
  if (currentTurn === null) {
    throw new Error(
      `3D table snapshot: invalid current turn ${String(state.current_turn)}`,
    );
  }

  const highlight =
    highlightDiscard === undefined
      ? deriveHighlightDiscard(state, bySeat)
      : normalizeHighlight(highlightDiscard, bySeat);

  const build = (seat: Seat): SnapshotSeat => {
    const player = bySeat.get(seat);
    if (!player) {
      throw new Error(`3D table snapshot: no player at seat ${seat}`);
    }
    return buildSeat(player, seat, highlight);
  };
  const seats = [build(0), build(1), build(2), build(3)] as const;

  const snapshot: TableSnapshot = {
    revision,
    humanSeat,
    seats,
    wall: buildWall(state.tiles_remaining, humanSeat),
    dora: state.dora_indicators.map((code, index) =>
      tile({
        face: faceIdForTile(code),
        zone: 'dora',
        slot: index,
        uid: `dora-${index}`,
        faceUp: true,
      }),
    ),
    compass: {
      roundWind: state.round_wind,
      handNumber: state.hand_number,
      honba: state.honba,
      riichiSticks: state.riichi_sticks,
      tilesRemaining: state.tiles_remaining,
    },
    currentTurn,
    highlightDiscard: highlight,
    locked,
  };

  return import.meta.env.DEV ? deepFreeze(snapshot) : snapshot;
}
