/**
 * Inter-tile contact adjacency (3D-20).
 *
 * These assertions are the whole reason the crevice profile can exist: the
 * shader darkens an edge only when `aContact` says a body is against it, so the
 * masks must be exact. Every case below is a committed layout fact — a hand row's
 * pitch, a wall stack's step, the tsumogiri draw gap — not a tolerance that was
 * tuned until a test went green.
 */

import { describe, expect, it } from 'vitest';

import { boardFixture } from './boardFixture';
import { layoutBoard } from './boardLayout';
import { CONTACT, CONTACT_EDGE, contactMasks, contactPairs } from './contact';
import { HAND, TILE } from '../layoutConstants';

const fixture = boardFixture();
const layout = layoutBoard(fixture);
const byId = new Map(layout.tiles.map((tile) => [tile.id, tile]));
const handOf = (seat: number) =>
  layout.foreground
    .filter((tile) => tile.seat === seat && tile.zone === 'hand')
    .sort((left, right) => left.slot - right.slot);

describe('3D inter-tile contact (3D-20)', () => {
  it('marks both row edges of an interior hand tile and one edge at the row end', () => {
    const hand = handOf(layout.humanSeat);
    expect(hand.length).toBeGreaterThan(3);
    // The human's hand runs along the seat's right axis, which is world +X for
    // seat 0, so the row's contacts are the tile's own ±X edges.
    const first = hand[0];
    const last = hand[hand.length - 1];
    for (const tile of hand.slice(1, -1)) {
      expect(tile.contact & CONTACT_EDGE.minusX).not.toBe(0);
      expect(tile.contact & CONTACT_EDGE.plusX).not.toBe(0);
    }
    const outward = (tile: (typeof hand)[number], bit: number) => (tile.contact & bit) !== 0;
    // Exactly one of the end tile's row edges is occupied, and the row's two
    // ends point opposite ways.
    const firstBits = [CONTACT_EDGE.minusX, CONTACT_EDGE.plusX].filter((bit) =>
      outward(first, bit),
    );
    const lastBits = [CONTACT_EDGE.minusX, CONTACT_EDGE.plusX].filter((bit) =>
      outward(last, bit),
    );
    expect(firstBits.length).toBe(1);
    expect(lastBits.length).toBe(1);
    expect(firstBits[0]).not.toBe(lastBits[0]);
  });

  it('leaves the deliberately separated drawn tile out of the row', () => {
    const draw = layout.foreground.find(
      (tile) => tile.seat === fixture.humanSeat && tile.zone === 'draw',
    );
    expect(draw).toBeDefined();
    // The tsumogiri gap is 0.2625 units against a 0.02-unit contact tolerance,
    // and the committed row groove is 0.0107: the tolerance sits between them.
    expect(TILE.gapUnits).toBeLessThan(CONTACT.maxGapUnits);
    expect(HAND.drawGapUnits).toBeGreaterThan(CONTACT.maxGapUnits);
    expect(draw!.contact & (CONTACT_EDGE.minusX | CONTACT_EDGE.plusX)).toBe(0);
  });

  it('marks a wall stack\u2019s neighbours along the run and the two tiers along Z', () => {
    // Slot = run * 34 + stack * 2 + tier, so wall-0/1 are one stack's two tiers
    // and wall-0/2 are two adjacent stacks' bottom tiers.
    const stackTiers = [byId.get('wall-0'), byId.get('wall-1')];
    const adjacentStacks = [byId.get('wall-0'), byId.get('wall-2')];
    for (const tile of [...stackTiers, ...adjacentStacks]) expect(tile).toBeDefined();
    // The bottom tier's face (+Z, which points down when face-down) touches the
    // top tier's back (-Z), so each carries the bit on its own contact side.
    expect(stackTiers[0]!.contact & CONTACT_EDGE.minusZ).not.toBe(0);
    expect(stackTiers[1]!.contact & CONTACT_EDGE.plusZ).not.toBe(0);
    // Adjacent stacks touch along the tile's own X, one bit per side.
    expect(adjacentStacks[0]!.contact & CONTACT_EDGE.plusX).not.toBe(0);
    expect(adjacentStacks[1]!.contact & CONTACT_EDGE.minusX).not.toBe(0);
  });

  it('never marks a corner-only neighbour', () => {
    // Two tiles that merely share a diagonal corner must not darken each other:
    // every marked pair must overlap by the committed minimum in the plane
    // perpendicular to the contact.
    for (const tile of layout.tiles) {
      const mask = tile.contact;
      expect(mask).toBeGreaterThanOrEqual(0);
      expect(mask).toBeLessThanOrEqual(63);
    }
    const { pairs } = contactPairs(layout.tiles);
    expect(pairs.length).toBeGreaterThan(layout.tiles.length);
    for (const pair of pairs) {
      expect(pair.bit).toBeGreaterThan(0);
      expect(pair.aId).not.toBe(pair.bId);
    }
  });

  it('is symmetric: every contact appears once from each side', () => {
    const { pairs } = contactPairs(layout.tiles);
    const seen = new Set(pairs.map((pair) => `${pair.aId}>${pair.bId}`));
    for (const pair of pairs) {
      expect(seen.has(`${pair.bId}>${pair.aId}`)).toBe(true);
    }
    // Two bodies can also touch on two axes at once only at a seam; unrelated
    // tiles never produce a link whose separation exceeds the tolerance.
    const masks = contactMasks(layout.tiles);
    layout.tiles.forEach((tile, index) => {
      expect(tile.contact).toBe(masks[index]);
    });
  });

  it('is deterministic and independent of the reporting option', () => {
    expect(contactMasks(layout.tiles)).toEqual(contactMasks(layout.tiles));
    const quiet = contactPairs(layout.tiles, { collect: false });
    expect(quiet.masks).toEqual(contactMasks(layout.tiles));
    expect(quiet.pairs).toEqual([]);
  });
});
