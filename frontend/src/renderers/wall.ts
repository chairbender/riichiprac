/**
 * The wall's physical slot model (task 261120-2112).
 *
 * This is the one place that turns a live-wall **count** into **positions**, so
 * the snapshot adapter, the board fixture and the 3D layout cannot disagree
 * about which tiles are still on the table.
 *
 * The model is the real table's, not a per-run decoration:
 *
 * - The physical wall is 136 tiles in a closed 68-stack ring (4 runs x 17
 *   stacks x 2 tiers). The **dead wall** is the far run's 7 draw-end stacks
 *   (stacks 10..16), 14 tiles, and it is never drawn from except for kan
 *   replacements, so it is always intact.
 * - The **live wall** is the other 61 stacks (122 tiles). It is one contiguous
 *   arc: the break is at the dead wall's own draw end, and the live arc leaves
 *   the break in the opposite direction, so it starts on the run to the human's
 *   left, crosses the human's own run, the right run, and ends on the far run
 *   just past the dead wall.
 * - Draws consume the arc from its break end, **top tier first, then bottom**.
 *   So the tiles still in the wall are the arc's *suffix*: if the count is odd,
 *   the one partially drawn stack sits at the live wall's draw edge and keeps
 *   only its **bottom** tile (the top has been taken).
 * - Every decision state is after the 52-tile deal (and the dealer's draw), so
 *   the live count never exceeds {@link WALL.maxDecisionLiveTiles} = 70. That is
 *   why the dealt positions are never drawn; the ring's far side is simply
 *   empty. A larger count cannot describe a legal table (known tiles + 14 dead +
 *   live must equal 136), so {@link liveWallSlots} clamps it and the snapshot
 *   never emits a tile where the deal came from.
 *
 * Pure data: no three.js, no DOM, no game rules beyond the published draw
 * order. The snapshot's `GameState.tiles_remaining` is the only input that
 * varies.
 */

import type { Seat } from './contract';
import { WALL } from './layoutConstants';

/** One stack position: a run and a stack index on it. */
export interface WallStack {
  readonly run: Seat;
  readonly stack: number;
}

/** One tile position in the wall ring. Tier 0 is the bottom, 1 the top. */
export interface WallSlot extends WallStack {
  readonly tier: number;
}

/** The absolute seat whose run holds the dead wall: across from the human. */
export function farSeatOf(humanSeat: Seat): Seat {
  return ((humanSeat + 2) % 4) as Seat;
}

/** The ring slot id the snapshot and layout share. */
export function wallSlotId(run: Seat, stack: number, tier: number): number {
  return run * WALL.slotsPerRun + stack * WALL.tiers + tier;
}

/**
 * Decode a slot id, or null when it is not an integer ring position.
 *
 * The caller treats null as a structurally illegal snapshot; the layout already
 * throws on an out-of-range slot, and this keeps the derivation single-sourced
 * instead of re-deriving `run/stack/tier` in three places.
 */
export function decodeWallSlot(slot: number): WallSlot | null {
  if (
    !Number.isInteger(slot) ||
    slot < 0 ||
    slot >= WALL.runs * WALL.slotsPerRun
  ) {
    return null;
  }
  const run = Math.floor(slot / WALL.slotsPerRun) as Seat;
  const withinRun = slot % WALL.slotsPerRun;
  return {
    run,
    stack: Math.floor(withinRun / WALL.tiers),
    tier: withinRun % WALL.tiers,
  };
}

/**
 * The dead wall's 7 stacks on the far run, in draw-end order (stack 16 first,
 * the way the dora indicators count in). Fixed: it never depletes.
 */
export function deadWallStacks(humanSeat: Seat): readonly WallStack[] {
  const run = farSeatOf(humanSeat);
  const stacks: WallStack[] = [];
  for (let index = 0; index < WALL.deadWallStacks; index += 1) {
    stacks.push({ run, stack: WALL.drawEndSlot - index });
  }
  return stacks;
}

/** The dead wall's 14 slots, bottom then top per stack, in draw-end order. */
export function deadWallSlots(humanSeat: Seat): readonly WallSlot[] {
  const slots: WallSlot[] = [];
  for (const stack of deadWallStacks(humanSeat)) {
    for (let tier = 0; tier < WALL.tiers; tier += 1) {
      slots.push({ ...stack, tier });
    }
  }
  return slots;
}

/**
 * The live wall's 61 stacks in **draw order**, from the break to the dead wall.
 *
 * The break is at the dead wall's draw end, and the live wall leaves it the
 * other way around the ring, so the order is: the run to the human's left
 * (ascending stack), the human's own run, the run to the human's right, then the
 * far run up to the dead wall. On the far run the dead stacks (10..16) are
 * excluded.
 */
export function liveWallStacks(humanSeat: Seat): readonly WallStack[] {
  const far = farSeatOf(humanSeat);
  const runOrder: Seat[] = [
    ((far + 1) % 4) as Seat,
    ((far + 2) % 4) as Seat,
    ((far + 3) % 4) as Seat,
    far,
  ];
  const stacks: WallStack[] = [];
  for (const run of runOrder) {
    const lastStack =
      run === far ? WALL.deadWallStartStack - 1 : WALL.stacksPerRun - 1;
    for (let stack = 0; stack <= lastStack; stack += 1) {
      stacks.push({ run, stack });
    }
  }
  return stacks;
}

/**
 * The live wall's occupied slots for a published `tiles_remaining` count.
 *
 * The count is clamped to `[0, WALL.maxDecisionLiveTiles]`: the live wall at a
 * decision cannot hold more than 70 tiles (the deal is already gone), and a
 * larger number could not come from a table whose tiles add up to 136.
 *
 * The remaining tiles are the arc's suffix. An odd count leaves the first stack
 * of that suffix bottom-only, because the draw order takes a stack's top tile
 * first; that lone bottom is what makes the draw edge read as "one tile left in
 * this stack". The list is stack-major (the stacks in draw order, each stack's
 * bottom then top); {@link nextLiveWallSlot} applies the within-stack rule.
 */
export function liveWallSlots(
  tilesRemaining: number,
  humanSeat: Seat,
): readonly WallSlot[] {
  const count = Math.max(
    0,
    Math.min(
      Number.isFinite(tilesRemaining) ? Math.round(tilesRemaining) : 0,
      WALL.maxDecisionLiveTiles,
    ),
  );
  if (count === 0) return [];

  const stacks = liveWallStacks(humanSeat);
  const occupiedStacks = Math.ceil(count / 2);
  const odd = count % 2 === 1;
  const slots: WallSlot[] = [];
  for (let index = stacks.length - occupiedStacks; index < stacks.length; index += 1) {
    const stack = stacks[index];
    const bottomOnly = odd && index === stacks.length - occupiedStacks;
    for (let tier = 0; tier < WALL.tiers; tier += 1) {
      if (bottomOnly && tier > 0) continue;
      slots.push({ ...stack, tier });
    }
  }
  return slots;
}

/**
 * Everything the snapshot's `wall` list carries: the fixed 14-tile dead wall
 * (bottom then top, in draw-end order) followed by the live wall's remaining
 * slots in draw order.
 */
export function wallSlots(
  tilesRemaining: number,
  humanSeat: Seat,
): readonly WallSlot[] {
  return [...deadWallSlots(humanSeat), ...liveWallSlots(tilesRemaining, humanSeat)];
}

/** Is this slot on the dead wall? */
export function isDeadWallSlot(slot: number, humanSeat: Seat): boolean {
  const decoded = decodeWallSlot(slot);
  if (!decoded) return false;
  return (
    decoded.run === farSeatOf(humanSeat) &&
    decoded.stack >= WALL.deadWallStartStack
  );
}

/**
 * The slot the live wall draws next, or null when it is empty.
 *
 * That is the first slot still in the wall: the lone bottom tile when the count
 * is odd, otherwise the next stack's top. A future replay/draw animation starts
 * here instead of at a per-run draw end (which no longer exists).
 */
export function nextLiveWallSlot(
  tilesRemaining: number,
  humanSeat: Seat,
): WallSlot | null {
  const count = Math.max(
    0,
    Math.min(
      Number.isFinite(tilesRemaining) ? Math.round(tilesRemaining) : 0,
      WALL.maxDecisionLiveTiles,
    ),
  );
  const first = liveWallSlots(count, humanSeat)[0];
  if (!first) return null;
  // A partial stack (odd count) has already lost its top, so its bottom is next;
  // a full stack gives up its top tile first.
  return count % 2 === 1
    ? first
    : { ...first, tier: WALL.tiers - 1 };
}
