/**
 * The wall's physical slot model (task 261120-2112).
 *
 * These are the facts the layout and the gate rely on, checked without a
 * renderer: the fixed 14-tile dead wall, the 122-tile live arc, the draw order
 * that makes the remaining tiles a suffix, the bottom-only stack an odd count
 * leaves at the draw edge, and the seat rotation.
 */

import { describe, expect, it } from 'vitest';
import type { Seat } from './contract';
import { WALL } from './layoutConstants';
import {
  deadWallSlots,
  decodeWallSlot,
  farSeatOf,
  isDeadWallSlot,
  liveWallSlots,
  liveWallStacks,
  nextLiveWallSlot,
  wallSlotId,
  wallSlots,
} from './wall';

const HUMAN = 0 as Seat;
const slotIds = (slots: readonly { run: Seat; stack: number; tier: number }[]) =>
  slots.map((slot) => wallSlotId(slot.run, slot.stack, slot.tier));

describe('the wall model: counts', () => {
  it('is 122 live tiles plus the 14-tile dead wall, 136 in all', () => {
    expect(WALL.liveWallTiles).toBe(122);
    expect(WALL.deadWallTiles).toBe(14);
    expect(WALL.liveWallTiles + WALL.deadWallTiles).toBe(136);
    expect(WALL.maxDecisionLiveTiles).toBe(70);
  });

  it('gives the far run the seven draw-end stacks and nothing else', () => {
    const dead = deadWallSlots(HUMAN);
    expect(dead).toHaveLength(14);
    expect(farSeatOf(HUMAN)).toBe(2);
    expect(new Set(dead.map((slot) => slot.run))).toEqual(new Set([2]));
    expect(new Set(dead.map((slot) => slot.stack))).toEqual(
      new Set([10, 11, 12, 13, 14, 15, 16]),
    );
    for (const slot of dead) {
      expect(slot.tier).toBeGreaterThanOrEqual(0);
      expect(slot.tier).toBeLessThan(WALL.tiers);
      expect(isDeadWallSlot(wallSlotId(slot.run, slot.stack, slot.tier), HUMAN)).toBe(
        true,
      );
    }
    // Every slot the dead wall does not own is a live position.
    for (let slot = 0; slot < WALL.runs * WALL.slotsPerRun; slot += 1) {
      const decoded = decodeWallSlot(slot);
      if (!decoded) continue;
      const deadHere =
        decoded.run === 2 && decoded.stack >= WALL.deadWallStartStack;
      expect(isDeadWallSlot(slot, HUMAN)).toBe(deadHere);
    }
  });
});

describe('the wall model: the live arc', () => {
  it('is 61 stacks in draw order, from the break to the dead wall', () => {
    const stacks = liveWallStacks(HUMAN);
    expect(stacks).toHaveLength(61);
    expect(
      new Set(stacks.map((stack) => `${stack.run}:${stack.stack}`)).size,
    ).toBe(61);
    // The arc starts at the human's left run, far corner (adjacent to the dead
    // wall's outer end), and ends on the far run one stack short of it.
    expect(stacks[0]).toEqual({ run: 3, stack: 0 });
    expect(stacks[stacks.length - 1]).toEqual({ run: 2, stack: 9 });
    expect(stacks.every((stack) => !isDeadWallSlot(wallSlotId(stack.run, stack.stack, 0), HUMAN))).toBe(
      true,
    );
    // The run order is the human's left, the human's, the right, then the far.
    expect([...new Set(stacks.map((stack) => stack.run))]).toEqual([3, 0, 1, 2]);
  });

  it('turns with the human seat', () => {
    for (const humanSeat of [0, 1, 2, 3] as const) {
      const stacks = liveWallStacks(humanSeat);
      const far = farSeatOf(humanSeat);
      expect(stacks[0]).toEqual({ run: (far + 1) % 4, stack: 0 });
      expect(stacks[stacks.length - 1]).toEqual({
        run: far,
        stack: WALL.deadWallStartStack - 1,
      });
      expect(stacks).toHaveLength(WALL.liveWallStacks);
      expect(
        stacks.some(
          (stack) =>
            stack.run === far && stack.stack >= WALL.deadWallStartStack,
        ),
      ).toBe(false);
    }
  });

  it('takes the arc\u2019s suffix as the tiles left, in draw order', () => {
    expect(liveWallSlots(0, HUMAN)).toEqual([]);
    expect(slotIds(liveWallSlots(1, HUMAN))).toEqual([wallSlotId(2, 9, 0)]);
    expect(slotIds(liveWallSlots(2, HUMAN))).toEqual([
      wallSlotId(2, 9, 0),
      wallSlotId(2, 9, 1),
    ]);
    // The last three tiles of the arc: the partial stack keeps its bottom, then
    // the far stack's top and bottom.
    expect(slotIds(liveWallSlots(3, HUMAN))).toEqual([
      wallSlotId(2, 8, 0),
      wallSlotId(2, 9, 0),
      wallSlotId(2, 9, 1),
    ]);

    const full = liveWallSlots(WALL.maxDecisionLiveTiles, HUMAN);
    expect(full).toHaveLength(WALL.maxDecisionLiveTiles);
    expect(new Set(slotIds(full)).size).toBe(WALL.maxDecisionLiveTiles);
    // A decision cannot publish more than the post-deal maximum.
    expect(liveWallSlots(WALL.liveWallTiles, HUMAN)).toHaveLength(
      WALL.maxDecisionLiveTiles,
    );
    // An even count has no partial stack; an odd count leaves exactly one, and
    // it keeps the bottom tile (the top is drawn first).
    for (const count of [68, 69, 70]) {
      const slots = liveWallSlots(count, HUMAN);
      expect(slots).toHaveLength(count);
      const perStack = new Map<string, number[]>();
      for (const slot of slots) {
        const key = `${slot.run}:${slot.stack}`;
        perStack.set(key, [...(perStack.get(key) ?? []), slot.tier]);
      }
      const partial = [...perStack.values()].filter(
        (tiers) => tiers.length === 1,
      );
      expect(partial, `count ${count}`).toHaveLength(count % 2);
      if (partial.length) expect(partial[0]).toEqual([0]);
    }
  });

  it('clamps a count no legal decision can publish', () => {
    // A decision is after the deal, so 70 is the ceiling; a larger number would
    // mean the hands and wall do not add up to 136 and must not draw the dealt
    // positions back onto the ring.
    expect(liveWallSlots(90, HUMAN)).toHaveLength(WALL.maxDecisionLiveTiles);
    expect(liveWallSlots(Number.NaN, HUMAN)).toEqual([]);
    expect(liveWallSlots(-5, HUMAN)).toEqual([]);
  });

  it('names the next draw at the draw edge', () => {
    expect(nextLiveWallSlot(0, HUMAN)).toBeNull();
    // Odd: the draw edge is a lone bottom tile. Even: the next full stack gives
    // up its top tile first.
    expect(nextLiveWallSlot(69, HUMAN)).toEqual({ run: 0, stack: 9, tier: 0 });
    expect(nextLiveWallSlot(68, HUMAN)).toEqual({ run: 0, stack: 10, tier: 1 });
  });
});

describe('the wall model: the snapshot list', () => {
  it('is the dead wall first, then the live suffix, without duplicates', () => {
    const slots = wallSlots(69, HUMAN);
    expect(slots).toHaveLength(WALL.deadWallTiles + 69);
    const ids = slotIds(slots);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      slots.slice(0, WALL.deadWallTiles).every((slot) =>
        isDeadWallSlot(wallSlotId(slot.run, slot.stack, slot.tier), HUMAN),
      ),
    ).toBe(true);
    expect(
      slots
        .slice(WALL.deadWallTiles)
        .every((slot) => !isDeadWallSlot(wallSlotId(slot.run, slot.stack, slot.tier), HUMAN)),
    ).toBe(true);
  });

  it('decodes every ring slot and rejects an out-of-range one', () => {
    for (let slot = 0; slot < WALL.runs * WALL.slotsPerRun; slot += 1) {
      const decoded = decodeWallSlot(slot);
      expect(decoded).not.toBeNull();
      if (!decoded) continue;
      expect(
        wallSlotId(decoded.run, decoded.stack, decoded.tier),
      ).toBe(slot);
    }
    expect(decodeWallSlot(-1)).toBeNull();
    expect(decodeWallSlot(WALL.runs * WALL.slotsPerRun)).toBeNull();
    expect(decodeWallSlot(1.5)).toBeNull();
  });
});
