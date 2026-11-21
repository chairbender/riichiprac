/**
 * The hover lift math (3D-08, user decision 2026-11-19).
 *
 * The lift is a pure, fixed translation: the hovered hand/draw tile moves up by
 * half a tile height and nothing else changes. These are numeric checks on the
 * instance matrices, so "raised up by half a tile height" is a number in the
 * test rather than an eyeball call.
 */

import { describe, expect, it } from 'vitest';
import { TILE } from '../layoutConstants';
import { boardFixture } from './boardFixture';
import { layoutBoard, poseMatrix } from './boardLayout';
import type { BoardLayout } from './boardLayout';
import { buildBoardInstances, NEUTRAL_ATLAS_RECT } from './boardMesh';
import type { BoardInstance } from './boardMesh';
import {
  HOVER_LIFT_UNITS,
  hoveredInstanceIndex,
  liftedInstanceIndexes,
  withHoverLift,
  withLiftedTiles,
} from './hover';
import { withVerticalLift } from './motion';

const layout = layoutBoard(boardFixture());
const instances = buildBoardInstances(layout, () => ({
  rect: NEUTRAL_ATLAS_RECT,
}));

/** The layout's human hand/draw tiles, in instance order. */
function humanHand(layoutBoardValue: BoardLayout): number[] {
  const indices: number[] = [];
  layoutBoardValue.tiles.forEach((tile, index) => {
    if (
      tile.seat === layoutBoardValue.humanSeat &&
      (tile.zone === 'hand' || tile.zone === 'draw')
    ) {
      indices.push(index);
    }
  });
  return indices;
}

describe('3D hover lift', () => {
  it('raises the tile by exactly half a tile height, straight up', () => {
    expect(HOVER_LIFT_UNITS).toBe(TILE.heightUnits / 2);
    expect(HOVER_LIFT_UNITS).toBe(0.5);
    const tile = layout.tiles[humanHand(layout)[3]];
    if (!tile || tile.seat === null) throw new Error('the fixture has no human hand');
    const ref = { seat: tile.seat, zone: tile.zone as 'hand' | 'draw', slot: tile.slot };

    const lifted = withHoverLift(instances, layout, ref);
    const index = hoveredInstanceIndex(layout, ref);
    expect(index).toBeGreaterThanOrEqual(0);

    const base = poseMatrix(tile.pose);
    // Column-major translation: [12] X, [13] Y, [14] Z.
    expect(lifted[index].matrix[12]).toBeCloseTo(base[12], 9);
    expect(lifted[index].matrix[13]).toBeCloseTo(base[13] + HOVER_LIFT_UNITS, 9);
    expect(lifted[index].matrix[14]).toBeCloseTo(base[14], 9);
  });

  it('leaves every other instance untouched', () => {
    const ref = { seat: 0 as const, zone: 'hand' as const, slot: 2 };
    const lifted = withHoverLift(instances, layout, ref);
    const index = hoveredInstanceIndex(layout, ref);
    lifted.forEach((instance, current) => {
      if (current === index) return;
      expect(instance.matrix).toBe(instances[current].matrix);
      expect(instance).toBe(instances[current]);
    });
  });

  it('does not lift the draw when a hand slot is hovered, and vice versa', () => {
    const handRef = { seat: 0 as const, zone: 'hand' as const, slot: 0 };
    const draw = layout.tiles.find(
      (tile) => tile.seat === 0 && tile.zone === 'draw',
    );
    expect(draw).toBeDefined();
    const handIndex = hoveredInstanceIndex(layout, handRef);
    const drawIndex = hoveredInstanceIndex(layout, {
      seat: 0,
      zone: 'draw',
      slot: draw!.slot,
    });
    expect(handIndex).not.toBe(drawIndex);
    const lifted = withHoverLift(instances, layout, handRef);
    expect(lifted[drawIndex].matrix).toBe(instances[drawIndex].matrix);
  });

  it('raises every named tile at once for a call preview or a multi-pick', () => {
    const hand = humanHand(layout);
    const refs = [hand[0], hand[2], hand[4]].map((index) => {
      const tile = layout.tiles[index];
      return {
        seat: tile.seat as 0,
        zone: tile.zone as 'hand' | 'draw',
        slot: tile.slot,
      };
    });

    expect(liftedInstanceIndexes(layout, refs)).toEqual([hand[0], hand[2], hand[4]]);
    const lifted = withLiftedTiles(instances, layout, refs);
    for (const index of [hand[0], hand[2], hand[4]]) {
      const base = poseMatrix(layout.tiles[index].pose);
      expect(lifted[index].matrix[13]).toBeCloseTo(
        base[13] + HOVER_LIFT_UNITS,
        9,
      );
    }
    // A tile that was not named stays exactly where it was.
    expect(lifted[hand[1]]).toBe(instances[hand[1]]);
  });

  it('applies the full lift with the deal-in lift at zero (reduced motion)', () => {
    // User decision 2026-11-21: the hover lift is a discrete pose change, not
    // an animation, so reduced motion does not remove it. The scene's
    // reduced-motion frame is exactly this composition: the hover lift applied
    // with the deal-in's time-based lift at zero.
    const ref = { seat: 0 as const, zone: 'hand' as const, slot: 3 };
    const index = hoveredInstanceIndex(layout, ref);
    const lifted = withVerticalLift(withHoverLift(instances, layout, ref), 0);
    expect(lifted[index].matrix[13]).toBeCloseTo(
      instances[index].matrix[13] + HOVER_LIFT_UNITS,
      9,
    );
    lifted.forEach((instance, current) => {
      if (current === index) return;
      expect(instance.matrix).toBe(instances[current].matrix);
    });
  });

  it('is a no-op with no hover, or a hover that is not on this board', () => {
    expect(withHoverLift(instances, layout, null)).toBe(instances);
    expect(
      withHoverLift(instances, layout, { seat: 3, zone: 'hand', slot: 99 }),
    ).toBe(instances);
  });

  it('keeps the instance’s face, atlas rect and flags', () => {
    const ref = { seat: 0 as const, zone: 'hand' as const, slot: 1 };
    const index = hoveredInstanceIndex(layout, ref);
    const before: BoardInstance = instances[index];
    const after = withHoverLift(instances, layout, ref)[index];
    expect(after.face).toBe(before.face);
    expect(after.atlasRect).toBe(before.atlasRect);
    expect(after.flags).toBe(before.flags);
    expect(after.id).toBe(before.id);
  });
});
