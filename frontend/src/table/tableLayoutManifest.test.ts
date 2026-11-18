import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  basisKey,
  groupSlotsByOrientation,
  parseTableLayoutManifest,
  projectWorldPoint,
  reliefGroupForShell,
  shellRepresentativeSlotId,
  worldPositionOfSlot,
} from './tableLayoutManifest';

const tableDir = fileURLToPath(new URL('../../public/table/', import.meta.url));
const raw = JSON.parse(readFileSync(join(tableDir, 'table_layout.json'), 'utf8'));
const layout = parseTableLayoutManifest(raw);

describe('table_layout.json contract', () => {
  it('parses the committed slot catalogue, light rig and camera', () => {
    expect(layout.version).toBeGreaterThanOrEqual(1);
    expect(layout.slots).toHaveLength(293);
    expect(layout.camera.resolution).toEqual([1920, 1080]);
    expect(layout.lighting.keyLightDir[2]).toBeGreaterThan(0.9);
    expect(layout.lighting.keyLightColor).toHaveLength(3);
    const ids = new Set(layout.slots.map((slot) => slot.id));
    expect(ids.size).toBe(layout.slots.length);
    for (const slot of layout.slots) {
      expect(Math.hypot(...slot.basis.tangent)).toBeCloseTo(1, 5);
      expect(Math.hypot(...slot.basis.bitangent)).toBeCloseTo(1, 5);
      expect(Math.hypot(...slot.basis.normal)).toBeCloseTo(1, 5);
    }
  });

  it('recovers each slot world position and projects it back to the anchor', () => {
    for (const slot of layout.slots) {
      const world = worldPositionOfSlot(layout, slot);
      expect(world.every(Number.isFinite)).toBe(true);
      const projected = projectWorldPoint(layout, world);
      expect(projected.x).toBeCloseTo(slot.anchor.x, 4);
      expect(projected.y).toBeCloseTo(slot.anchor.y, 4);
      expect(projected.depth).toBeCloseTo(slot.depth, 2);
    }
  });

  it('reconstructs plausible table positions for the four ponds and the hand', () => {
    const find = (id: string) => {
      const slot = layout.slots.find((entry) => entry.id === id);
      if (!slot) throw new Error(`missing ${id}`);
      return worldPositionOfSlot(layout, slot);
    };
    const south = find('river_south_0_3');
    const east = find('river_east_0_3');
    const north = find('river_north_0_3');
    const west = find('river_west_0_3');
    const hand = find('hand_south_06');
    // The mat is 700 mm square, so the pond centre is about 4.8 rig units from
    // the table centre and the human hand sits behind the south edge.
    expect(south[1]).toBeLessThan(-4);
    expect(east[0]).toBeGreaterThan(4);
    expect(north[1]).toBeGreaterThan(4);
    expect(west[0]).toBeLessThan(-4);
    for (const pond of [south, east, north, west]) expect(pond[2]).toBeCloseTo(0.29, 1);
    expect(hand[1]).toBeLessThan(-8);
    expect(hand[2]).toBeGreaterThan(0.4);
  });

  it('groups all 293 slots by bucket and rounded basis', () => {
    const groups = groupSlotsByOrientation(layout);
    expect(groups).toHaveLength(31);
    expect(groups.reduce((total, group) => total + group.slots.length, 0)).toBe(293);
    // Every group is keyed by its own rounded basis, and the represented slots
    // all share that exact basis.
    for (const group of groups) {
      expect(group.key).toBe(`${group.bucket}|${basisKey(group.basis)}`);
      for (const slot of group.slots) expect(slot.bucket).toBe(group.bucket);
    }
  });

  it('resolves each face-up shell to a real layout group', () => {
    expect(shellRepresentativeSlotId('shell_hand_slot_00')).toBe('hand_south_00');
    expect(shellRepresentativeSlotId('shell_hand_slot_draw')).toBe('hand_south_13');
    expect(shellRepresentativeSlotId('shell_flat_upright')).toBe('river_south_0_3');
    expect(shellRepresentativeSlotId('shell_flat_sideways')).toBe('river_east_0_3');
    expect(shellRepresentativeSlotId('shell_flat_upright_180')).toBe('river_north_0_3');
    expect(shellRepresentativeSlotId('shell_flat_sideways_270')).toBe('river_west_0_3');

    const upright = reliefGroupForShell(layout, 'shell_flat_upright');
    const sideways = reliefGroupForShell(layout, 'shell_flat_sideways');
    const north = reliefGroupForShell(layout, 'shell_flat_upright_180');
    const west = reliefGroupForShell(layout, 'shell_flat_sideways_270');
    for (const group of [upright, sideways, north, west]) expect(group).not.toBeNull();
    // Four rotations, four cache keys: the basis is part of the key.
    expect(
      new Set([upright!.key, sideways!.key, north!.key, west!.key]).size,
    ).toBe(4);
    expect(upright!.basis.normal[2]).toBeCloseTo(1, 6);
    expect(north!.basis.tangent[0]).toBeCloseTo(-1, 6);
  });

  it('rejects a non-unit or wrongly handed basis, and duplicate slots', () => {
    const clone = () => JSON.parse(JSON.stringify(raw));
    const badUnit = clone();
    badUnit.slots[0].basis.tangent = [0, 0, 2];
    expect(() => parseTableLayoutManifest(badUnit)).toThrow(/unit length/);

    const badSign = clone();
    badSign.slots[0].basis.normal = badSign.slots[0].basis.normal.map((v: number) => -v);
    expect(() => parseTableLayoutManifest(badSign)).toThrow(/bitangent x tangent/);

    const duplicate = clone();
    duplicate.slots[1].id = duplicate.slots[0].id;
    expect(() => parseTableLayoutManifest(duplicate)).toThrow(/duplicate slot id/);

    const noLight = clone();
    delete noLight.lighting.keyLightDir;
    expect(() => parseTableLayoutManifest(noLight)).toThrow(/keyLightDir/);
  });
});
