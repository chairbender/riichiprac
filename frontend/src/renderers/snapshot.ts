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
 * - red fives are resolved in hand order and then the draw, exactly like the
 *   dock's sorted display (`src/display.ts`);
 * - the called tile of a meld is the sideways one, exactly like `src/meld.ts`
 *   and the plan view's `MeldList`;
 * - a riichi declaration tile is sideways both when the discard says so and
 *   when `riichi_discard_index` names it, as `River` does; and
 * - the claimed discard is the seat's newest one, which is what the call/ron
 *   offer (`decision.kind === 'react_to_discard'`) names.
 */

import { calledTile } from '../meld';
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
import { WALL } from './layoutConstants';

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
  readonly faceUp: boolean;
  readonly sideways?: boolean;
  readonly highlighted?: boolean;
  readonly dimmed?: boolean;
}

function tile(spec: TileSpec): SnapshotTile {
  return {
    face: spec.face,
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

  const concealed = player.hand.map((code, index) =>
    tile({
      face: faceIdForTile(code, red(code)),
      zone: 'hand',
      slot: index,
      faceUp: true,
    }),
  );

  const draw = player.draw
    ? tile({
        face: faceIdForTile(player.draw, red(player.draw)),
        zone: 'draw',
        slot: player.hand.length,
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
      faceUp: true,
      sideways: discard.is_riichi || riichiDiscardIndex === index,
      highlighted: highlight?.seat === seat && highlight.index === index,
      dimmed: discard.is_tsumogiri,
    }),
  );

  const melds: SnapshotMeld[] = player.melds.map((meld) => {
    const called = calledTile(meld, player.seat);
    return {
      kind: meld.meld_type,
      tiles: meld.tiles.map((code, index) =>
        tile({
          face: faceIdForTile(code),
          zone: 'meld',
          slot: index,
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
 * The fixed decorative wall: four runs of two tiers, minus every run's
 * draw-end top tile. Face ids stay `blank` because the tiles are face-down.
 */
function buildWall(): SnapshotTile[] {
  const wall: SnapshotTile[] = [];
  for (let run = 0; run < WALL.runs; run += 1) {
    for (let stack = 0; stack < WALL.stacksPerRun; stack += 1) {
      for (let tier = 0; tier < WALL.tiers; tier += 1) {
        if (stack === WALL.drawEndSlot && tier >= WALL.drawEndTiers) continue;
        wall.push(
          tile({
            face: 'blank',
            zone: 'wall',
            slot: run * WALL.slotsPerRun + stack * WALL.tiers + tier,
            faceUp: false,
          }),
        );
      }
    }
  }
  return wall;
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
    wall: buildWall(),
    dora: state.dora_indicators.map((code, index) =>
      tile({
        face: faceIdForTile(code),
        zone: 'dora',
        slot: index,
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
    highlightDiscard: highlight,
    locked,
  };

  return import.meta.env.DEV ? deepFreeze(snapshot) : snapshot;
}
