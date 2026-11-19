import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAoSeamsManifest, parseShadowsManifest, matShadowBucketFor, wallSeatOf } from './shadowManifest';
import { parseShellsManifest } from './shellManifest';
import type { ShellsManifest, ShellStats } from './shellManifest';
import {
  layoutHand,
  layoutMeld,
  layoutPond,
  layoutSideHand,
  layoutSideWall,
  layoutTopHand,
  layoutWall,
} from './zoneLayout';
import type { LayoutZone } from './zoneLayout';

const tableDir = fileURLToPath(new URL('../../public/table/', import.meta.url));
const shells: ShellsManifest = parseShellsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')),
);
const shadows = parseShadowsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shadows.json'), 'utf8')),
);
const seams = parseAoSeamsManifest(
  JSON.parse(readFileSync(join(tableDir, 'ao_seams.json'), 'utf8')),
);

const shellOf = (id: string): ShellStats => {
  const shell = shells.shells[id];
  if (!shell) throw new Error(`no shell ${id}`);
  return shell;
};

/** The bucket every body of a zone resolves to, in painter order. */
function bucketsOf(zone: LayoutZone): string[] {
  return zone.bodies.map((tile) => matShadowBucketFor(zone, tile, shellOf(tile.shell)));
}

describe('shadows.json', () => {
  it('parses the committed manifest and covers all 16 blank buckets', () => {
    expect(shadows.version).toBe(1);
    expect(shadows.task).toBe('4A');
    expect(shadows.composite.model).toBe('multiply');
    expect(Object.keys(shadows.matShadows)).toHaveLength(16);
    expect(shadows.totals.matShadows).toBe(16);
    for (const record of Object.values(shadows.matShadows)) {
      expect(record.pixelRatio).toBe(2);
      expect(record.textureFile).toBe(`shadows/shadow_mat_${record.bucket}.png`);
      if (!record.grounded) {
        // A tile resting on the mat shares its blank's pivot's anchor, so one
        // draw position places both.
        expect(record.blank.anchor).toEqual(record.anchor);
      }
    }
  });

  it('publishes the grounded wall buckets at the bottom-tier anchor', () => {
    for (const bucket of ['wall_horiz_center', 'wall_horiz_left', 'wall_horiz_right']) {
      const record = shadows.matShadows[bucket];
      expect(record.grounded).toBe(true);
      expect(record.groundDropUnits).toBeGreaterThan(0);
      // The blank is the top-tier body, so its own anchor is the raised one.
      expect(record.anchor).not.toEqual(record.blank.anchor);
      expect(record.anchor.y).toBeGreaterThan(record.blank.anchor.y);
    }
  });

  it('ships four seat-specific stack decals', () => {
    expect(shadows.wallStack.perSeat).toBe(true);
    expect(shadows.wallStack.seatAgreement.worst).toBe(1);
    for (const seat of ['north', 'south', 'east', 'west'] as const) {
      const record = shadows.wallStack.seats[seat];
      expect(record).toBeDefined();
      expect(record.textureFile).toBe(`shadows/shadow_wall_stack_${seat}.png`);
    }
  });

  it('rejects a malformed document', () => {
    expect(() => parseShadowsManifest({})).toThrow(/version must be 1/);
    expect(() => parseShadowsManifest({ ...JSON.parse(JSON.stringify(shadows)), matShadows: {} })).toThrow(
      /matShadows must not be empty/,
    );
    const broken = JSON.parse(JSON.stringify(shadows));
    delete broken.wallStack.seats.east;
    expect(() => parseShadowsManifest(broken)).toThrow(/wallStack\.seats/);
  });
});

describe('ao_seams.json', () => {
  it('parses the four masks and their authored axes', () => {
    expect(seams.seams.left.axis).toBe('u');
    expect(seams.seams.left.side).toBe('low');
    expect(seams.seams.right.side).toBe('high');
    expect(seams.seams.top.axis).toBe('v');
    expect(seams.seams.top.side).toBe('low');
    expect(seams.seams.bottom.side).toBe('high');
    expect(seams.peakAlpha).toBeCloseTo(0.35, 3);
    // The measured fade is per axis, so the physical band matches the bevel.
    expect(seams.seams.left.measured.fadeAxisFraction).toBeGreaterThan(
      seams.seams.top.measured.fadeAxisFraction,
    );
  });

  it('rejects a missing mask', () => {
    const broken = JSON.parse(JSON.stringify(seams));
    delete broken.seams.bottom;
    expect(() => parseAoSeamsManifest(broken)).toThrow(/seams\.bottom/);
  });
});

describe('mat shadow buckets', () => {
  it('maps each pond to its vote family and keeps the rotation class', () => {
    const south = layoutPond(shells, {
      side: 'bottom',
      discards: [
        { face: '1m' },
        { face: '2m' },
        { face: '3m', riichi: true },
        { face: '4m' },
      ],
    });
    expect(bucketsOf(south)).toEqual([
      'flat_center',
      'flat_center_rotated',
      'flat_center',
      'flat_center',
    ]);

    const west = layoutPond(shells, { side: 'left', discards: [{ face: '1m' }] });
    expect(bucketsOf(west)).toEqual(['flat_left_rotated']);
    const east = layoutPond(shells, { side: 'right', discards: [{ face: '1m' }] });
    expect(bucketsOf(east)).toEqual(['flat_right_rotated']);
    const north = layoutPond(shells, { side: 'top', discards: [{ face: '1m' }] });
    expect(bucketsOf(north)).toEqual(['flat_center']);
  });

  it('maps a meld by the seat it lies on', () => {
    const south = layoutMeld(shells, { faces: ['1m', '2m', '3m'], calledIndex: 2 });
    expect(bucketsOf(south).sort()).toEqual(['flat_right', 'flat_right', 'flat_right_rotated']);
    const north = layoutMeld(shells, { faces: ['1m', '2m', '3m'], side: 'top', calledIndex: 2 });
    expect(bucketsOf(north).sort()).toEqual(['flat_left', 'flat_left', 'flat_left_rotated']);
  });

  it('maps the hand fan centre-out, and the drawn slot to the far right', () => {
    const hand = layoutHand(shells, {
      faces: ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '3p', '4p'],
      draw: '5p',
    });
    const byShell = new Map<string, string>();
    hand.bodies.forEach((tile) => {
      byShell.set(tile.shell, matShadowBucketFor(hand, tile, shellOf(tile.shell)));
    });
    expect(byShell.get('shell_hand_slot_00')).toBe('hand_far_left');
    expect(byShell.get('shell_hand_slot_02')).toBe('hand_far_left');
    expect(byShell.get('shell_hand_slot_03')).toBe('hand_mid_left');
    expect(byShell.get('shell_hand_slot_06')).toBe('hand_center');
    expect(byShell.get('shell_hand_slot_07')).toBe('hand_center');
    expect(byShell.get('shell_hand_slot_08')).toBe('hand_mid_right');
    expect(byShell.get('shell_hand_slot_10')).toBe('hand_far_right');
    expect(byShell.get('shell_hand_slot_12')).toBe('hand_far_right');
    expect(byShell.get('shell_hand_slot_draw')).toBe('hand_far_right');
    expect(hand.bodies).toHaveLength(14);
    // Every body of a 13-tile fan resolves; none falls through to a throw.
    expect(bucketsOf(hand)).toHaveLength(14);
  });

  it('mirrors the far hand and keeps the side hands on one bucket', () => {
    const top = layoutTopHand(shells, {
      faces: ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '3p', '4p'],
    });
    const bySlot = new Map<string, string>();
    top.bodies.forEach((tile) => {
      bySlot.set(tile.shell, matShadowBucketFor(top, tile, shellOf(tile.shell)));
    });
    expect(bySlot.get('shell_hand_top_slot_00')).toBe('hand_far_right');
    expect(bySlot.get('shell_hand_top_slot_06')).toBe('hand_center');
    expect(bySlot.get('shell_hand_top_slot_12')).toBe('hand_far_left');

    const left = layoutSideHand(shells, { side: 'left', count: 13 });
    expect(new Set(bucketsOf(left))).toEqual(new Set(['hand_far_left']));
    const right = layoutSideHand(shells, { side: 'right', count: 13 });
    expect(new Set(bucketsOf(right))).toEqual(new Set(['hand_far_right']));
  });

  it('maps a wall run by stack index and a side wall by its column', () => {
    const front = layoutWall(shells, { wall: 'front', count: 17 });
    const back = layoutWall(shells, { wall: 'back', count: 17 });
    const bucketAt = (zone: LayoutZone, slot: number): string => {
      const tile = zone.bodies.find((body) => body.cell?.slot === slot && body.cell.tier === 0);
      if (!tile) throw new Error(`no slot ${slot}`);
      return matShadowBucketFor(zone, tile, shellOf(tile.shell));
    };
    // Only the bottom tier carries a mat shadow.
    expect(front.shadows).toHaveLength(17);
    expect(front.shadows.every((tile) => tile.cell?.tier === 0)).toBe(true);
    for (const slot of [0, 1, 5]) expect(bucketAt(front, slot)).toBe('wall_horiz_left');
    for (const slot of [6, 8, 10]) expect(bucketAt(front, slot)).toBe('wall_horiz_center');
    for (const slot of [11, 16]) expect(bucketAt(front, slot)).toBe('wall_horiz_right');
    // The far wall is seen from the other side: its left reveal is at 11-16.
    for (const slot of [0, 5]) expect(bucketAt(back, slot)).toBe('wall_horiz_right');
    for (const slot of [11, 16]) expect(bucketAt(back, slot)).toBe('wall_horiz_left');

    expect(new Set(bucketsOf(layoutSideWall(shells, { side: 'left', count: 17 })))).toEqual(
      new Set(['wall_left_side']),
    );
    expect(new Set(bucketsOf(layoutSideWall(shells, { side: 'right', count: 17 })))).toEqual(
      new Set(['wall_right_side']),
    );
  });

  it('resolves every bucket the layouts can ask for', () => {
    const zones: LayoutZone[] = [
      ...(['bottom', 'top', 'left', 'right'] as const).map((side) =>
        layoutPond(shells, {
          side,
          discards: Array.from({ length: 18 }, (_, index) => ({
            face: '1m' as const,
            riichi: index === 6,
          })),
        }),
      ),
      layoutHand(shells, { faces: Array.from({ length: 13 }, () => '1m' as const), draw: '2m' }),
      layoutTopHand(shells, { faces: Array.from({ length: 13 }, () => '1m' as const) }),
      layoutSideHand(shells, { side: 'left' }),
      layoutSideHand(shells, { side: 'right' }),
      layoutWall(shells, { wall: 'front', count: 17 }),
      layoutWall(shells, { wall: 'back', count: 17 }),
      layoutSideWall(shells, { side: 'left', count: 17 }),
      layoutSideWall(shells, { side: 'right', count: 17 }),
      layoutMeld(shells, { faces: ['1m', '2m', '3m'], calledIndex: 0 }),
      layoutMeld(shells, { faces: ['1m', '2m', '3m'], side: 'top', calledIndex: 1 }),
      layoutMeld(shells, { faces: ['1m', '2m', '3m'], side: 'left', calledIndex: 2 }),
      layoutMeld(shells, { faces: ['1m', '2m', '3m'], side: 'right', calledIndex: 0 }),
    ];
    for (const zone of zones) {
      for (const bucket of bucketsOf(zone)) {
        expect(shadows.matShadows[bucket], `${zone.id} wants ${bucket}`).toBeDefined();
      }
    }
  });

  it('names the seat of every wall zone', () => {
    expect(wallSeatOf(layoutWall(shells, { wall: 'front' }))).toBe('south');
    expect(wallSeatOf(layoutWall(shells, { wall: 'back' }))).toBe('north');
    expect(wallSeatOf(layoutSideWall(shells, { side: 'left' }))).toBe('west');
    expect(wallSeatOf(layoutSideWall(shells, { side: 'right' }))).toBe('east');
    expect(wallSeatOf(layoutHand(shells, { faces: ['1m'] }))).toBeNull();
  });

  it('exposes the wall run on a front/back zone and nothing on a side wall', () => {
    expect(layoutWall(shells, { wall: 'front' }).wall).toBe('front');
    expect(layoutWall(shells, { wall: 'back' }).wall).toBe('back');
    expect(layoutSideWall(shells, { side: 'left' }).wall).toBeUndefined();
  });
});
