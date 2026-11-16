import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseShellsManifest } from './shellManifest';
import type { ShellsManifest } from './shellManifest';
import {
  HAND_ROW_SLOTS,
  POND_COLUMNS,
  WALL_CENTRE_INDEX,
  WALL_STACKS,
  ZONE_LAYER,
  centredSlotIndices,
  faceCentreOf,
  fanOrder,
  flatShellsForSeat,
  layoutHand,
  layoutMeld,
  layoutPond,
  layoutSideWall,
  layoutTopHand,
  layoutWall,
  representativeZones,
  zoneLayer,
  zoneShadowGroup,
} from './zoneLayout';
import type { LayoutZone, PlacedTile } from './zoneLayout';
import type { TileFaceId } from './tiles';

const tableDir = fileURLToPath(new URL('../../public/table/', import.meta.url));
const rawManifest = JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8'));
const manifest: ShellsManifest = parseShellsManifest(rawManifest);

const FACES: TileFaceId[] = [
  '1m',
  '2m',
  '3m',
  '4m',
  '5m',
  '6m',
  '7m',
  '8m',
  '9m',
  '1p',
  '2p',
  '3p',
  '4p',
];

const byShell = (zone: LayoutZone, shell: string): PlacedTile => {
  const tile = zone.bodies.find((body) => body.shell === shell);
  if (!tile) throw new Error(`no ${shell} in ${zone.id}`);
  return tile;
};

describe('fan helpers', () => {
  it('centres a short hand on the 13-slot fan', () => {
    expect(centredSlotIndices(13)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(centredSlotIndices(10)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(centredSlotIndices(0)).toEqual([]);
    expect(() => centredSlotIndices(HAND_ROW_SLOTS + 1)).toThrow();
  });

  it('orders a fan outermost-to-innermost with the centre last', () => {
    expect(fanOrder([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).toEqual([
      0, 12, 1, 11, 2, 10, 3, 9, 4, 8, 5, 7, 6,
    ]);
    expect(fanOrder([0, 1, 2, 3])).toEqual([0, 3, 1, 2]);
    expect(fanOrder([7])).toEqual([7]);
  });
});

describe('hand zone', () => {
  it('places the 13-slot fan by face centre and draws the view in fan order', () => {
    const zone = layoutHand(manifest, { faces: FACES });

    expect(zone.id).toBe('hand-bottom');
    expect(zone.layer).toBe(ZONE_LAYER.bottomHandAndMelds);
    expect(zone.shadowGroup).toBe('seat-bottom-hand');
    expect(zone.sigmaPx1x).toBe(5);
    expect(zone.blurPad).toBe(15);
    expect(zone.bodies).toHaveLength(13);
    expect(zone.shadows).toHaveLength(13);

    expect(zone.bodies.map((body) => body.shell)).toEqual([
      'shell_hand_slot_00',
      'shell_hand_slot_12',
      'shell_hand_slot_01',
      'shell_hand_slot_11',
      'shell_hand_slot_02',
      'shell_hand_slot_10',
      'shell_hand_slot_03',
      'shell_hand_slot_09',
      'shell_hand_slot_04',
      'shell_hand_slot_08',
      'shell_hand_slot_05',
      'shell_hand_slot_07',
      'shell_hand_slot_06',
    ]);

    const centre = byShell(zone, 'shell_hand_slot_06');
    const left = byShell(zone, 'shell_hand_slot_00');
    const right = byShell(zone, 'shell_hand_slot_12');
    expect(right.faceX - centre.faceX).toBeCloseTo(6 * 67.96, 9);
    expect(centre.faceX - left.faceX).toBeCloseTo(6 * 67.96, 9);
    expect(right.faceX - left.faceX).toBeCloseTo(12 * 67.96, 9);

    for (const body of zone.bodies) {
      const shell = manifest.shells[body.shell];
      const centrePx = faceCentreOf(shell);
      expect(body.gridX).toBeCloseTo(body.faceX - (centrePx[0] - shell.anchorX), 9);
      expect(body.gridY).toBeCloseTo(body.faceY - (centrePx[1] - shell.anchorY), 9);
      expect(body.drawX).toBe(Math.round(body.gridX - shell.anchorX));
      expect(body.drawY).toBe(Math.round(body.gridY - shell.anchorY));
      expect(Number.isInteger(body.drawX)).toBe(true);
      expect(Number.isInteger(body.drawY)).toBe(true);
      expect(body.hitBox.width).toBe(shell.advanceWidth);
      expect(body.hitBox.height).toBe(shell.advanceHeight);
      expect(body.hitBox.x).toBe(body.gridX);
      expect(body.hitBox.y).toBe(body.gridY);
      expect(body.face).not.toBeNull();
    }

    // Body-box placement would place the face centre at the body centre; the
    // outer slot's visible side reveal moves it away from that, which is why
    // the fan is anchored on the face.
    expect(
      Math.abs(right.faceX - (right.hitBox.x + right.hitBox.width / 2)),
    ).toBeGreaterThan(1);
  });

  it('places the drawn tile 1.35 row steps after the last row slot', () => {
    const zone = layoutHand(manifest, { faces: FACES, draw: '5p' });
    const drawn = zone.bodies[zone.bodies.length - 1];
    const lastRow = byShell(zone, 'shell_hand_slot_12');

    expect(zone.bodies).toHaveLength(14);
    expect(zone.shadows).toHaveLength(14);
    expect(drawn.shell).toBe('shell_hand_slot_draw');
    expect(drawn.face).toBe('5p');
    expect(drawn.faceX - lastRow.faceX).toBeCloseTo(1.35 * 67.96, 9);
    expect(drawn.faceY).toBeCloseTo(lastRow.faceY, 9);
    expect(zone.bodies.slice(0, 13).map((body) => body.shell)).toEqual(
      layoutHand(manifest, { faces: FACES }).bodies.map((body) => body.shell),
    );
  });

  it('centres a shorter hand on the same fan', () => {
    const zone = layoutHand(manifest, { faces: FACES.slice(0, 10) });
    expect(zone.bodies.map((body) => body.shell)).toEqual([
      'shell_hand_slot_02',
      'shell_hand_slot_11',
      'shell_hand_slot_03',
      'shell_hand_slot_10',
      'shell_hand_slot_04',
      'shell_hand_slot_09',
      'shell_hand_slot_05',
      'shell_hand_slot_08',
      'shell_hand_slot_06',
      'shell_hand_slot_07',
    ]);
  });

  it('rejects a hand that does not fit the 13-slot row', () => {
    expect(() =>
      layoutHand(manifest, {
        faces: Array.from({ length: HAND_ROW_SLOTS + 1 }, () => '1m') as TileFaceId[],
      }),
    ).toThrow(/13/);
  });
});

describe('top hand zone', () => {
  it('uses the bare blue-back fan and its own 67.55 px step', () => {
    const zone = layoutTopHand(manifest, { faces: FACES });
    expect(zone.layer).toBe(ZONE_LAYER.topWallAndHand);
    expect(zone.shadowGroup).toBe('seat-top-hand');
    expect(zone.sigmaPx1x).toBe(5);
    expect(zone.bodies).toHaveLength(13);
    expect(zone.bodies.every((body) => body.face === null)).toBe(true);
    expect(zone.bodies.map((body) => body.shell)).toEqual([
      'shell_hand_top_slot_00',
      'shell_hand_top_slot_12',
      'shell_hand_top_slot_01',
      'shell_hand_top_slot_11',
      'shell_hand_top_slot_02',
      'shell_hand_top_slot_10',
      'shell_hand_top_slot_03',
      'shell_hand_top_slot_09',
      'shell_hand_top_slot_04',
      'shell_hand_top_slot_08',
      'shell_hand_top_slot_05',
      'shell_hand_top_slot_07',
      'shell_hand_top_slot_06',
    ]);

    const left = byShell(zone, 'shell_hand_top_slot_00');
    const right = byShell(zone, 'shell_hand_top_slot_12');
    expect(right.faceX - left.faceX).toBeCloseTo(12 * 67.55, 9);
  });
});

describe('meld zone', () => {
  it('draws a straight meld right-to-left and keeps the advance hit box', () => {
    const zone = layoutMeld(manifest, { faces: ['1m', '2m', '3m'] });
    expect(zone.layer).toBe(ZONE_LAYER.bottomHandAndMelds);
    expect(zone.shadowGroup).toBe('seat-bottom-melds');
    expect(zone.sigmaPx1x).toBe(12);
    expect(zone.blurPad).toBe(36);
    expect(zone.bodies.map((body) => body.shell)).toEqual([
      'shell_flat_upright',
      'shell_flat_upright',
      'shell_flat_upright',
    ]);
    expect(zone.bodies[0].faceX).toBeGreaterThan(zone.bodies[2].faceX);
    expect(zone.shadows[1].faceX - zone.shadows[0].faceX).toBeCloseTo(69.41, 9);
    expect(zone.bodies[0].hitBox.width).toBe(72);
    expect(zone.bodies[0].hitBox.height).toBe(102);
  });

  it('turns the called tile sideways and offsets it by the published row rule', () => {
    const zone = layoutMeld(manifest, { faces: ['1m', '2m', '3m'], calledIndex: 1 });
    const called = zone.shadows[1];
    expect(called.shell).toBe('shell_flat_sideways');
    expect(called.face).toBe('2m');
    expect(called.faceY - zone.shadows[0].faceY).toBeCloseTo(7, 9);
    expect(called.hitBox.width).toBe(106);
    expect(called.hitBox.height).toBe(95);
    // The next tile advances by the turned shell's long axis.
    expect(zone.shadows[2].faceX - called.faceX).toBeCloseTo(104, 9);
  });

  it('uses the right seat’s sideways family and its frame', () => {
    const zone = layoutMeld(manifest, {
      faces: ['1m', '2m', '3m'],
      side: 'right',
      calledIndex: 1,
    });
    const normal = zone.shadows[0];
    const called = zone.shadows[1];
    expect(normal.shell).toBe('shell_flat_sideways');
    expect(called.shell).toBe('shell_flat_upright_180');
    // The right player's columns step up the screen; the normal short axis is
    // 55.15 px and a turned long axis is 65.44 px.
    expect(zone.shadows[1].faceY - zone.shadows[0].faceY).toBeCloseTo(-55.15, 9);
    expect(zone.shadows[2].faceY - called.faceY).toBeCloseTo(-65.44, 9);
    // The turned tile is shorter along the row axis, so it shifts toward the
    // player by the body-extent difference (106 - 72 = 34 px on screen x).
    expect(called.faceX - normal.faceX).toBeCloseTo(34, 9);
  });
});

describe('pond zone', () => {
  const discards = Array.from({ length: 24 }, (_, index) => ({
    face: FACES[index % FACES.length],
    riichi: index === 16,
  }));

  it('lays 6 columns and rows by the normal shell’s long axis', () => {
    const zone = layoutPond(manifest, { discards });
    expect(zone.layer).toBe(ZONE_LAYER.centreAndPonds);
    expect(zone.shadowGroup).toBe('pond-bottom');
    expect(zone.sigmaPx1x).toBe(12);
    expect(zone.bodies).toHaveLength(24);
    expect(zone.shadows).toHaveLength(24);

    expect(zone.shadows[1].faceX - zone.shadows[0].faceX).toBeCloseTo(69.41, 9);
    expect(zone.shadows[6].faceY - zone.shadows[0].faceY).toBeCloseTo(65.44, 9);
    expect(zone.shadows[6].faceX).toBeCloseTo(zone.shadows[0].faceX, 9);
    expect(zone.shadows[0].hitBox.width).toBe(72);
    expect(zone.shadows[0].hitBox.height).toBe(102);
  });

  it('turns a Riichi tile and advances the row by its long axis', () => {
    const zone = layoutPond(manifest, { discards });
    const riichi = zone.shadows[16];
    expect(riichi.shell).toBe('shell_flat_sideways');
    expect(riichi.riichi).toBe(true);
    expect(riichi.face).toBe(discards[16].face);
    expect(riichi.hitBox.width).toBe(106);
    expect(riichi.hitBox.height).toBe(95);
    expect(riichi.faceY - zone.shadows[12].faceY).toBeCloseTo(7, 9);
    expect(zone.shadows[17].faceX - riichi.faceX).toBeCloseTo(104, 9);
  });

  it('draws rows top-to-bottom and each row right-to-left', () => {
    const zone = layoutPond(manifest, { discards });
    const rows = Array.from({ length: 4 }, (_, row) =>
      zone.bodies.slice(row * POND_COLUMNS, (row + 1) * POND_COLUMNS),
    );
    for (const row of rows) {
      for (let index = 1; index < row.length; index += 1) {
        expect(row[index - 1].faceX).toBeGreaterThan(row[index].faceX);
      }
    }
    expect(rows[0][0].faceY).toBeLessThan(rows[1][0].faceY);
    expect(rows[1][0].faceY).toBeLessThan(rows[2][0].faceY);
    expect(rows[2][0].faceY).toBeLessThan(rows[3][0].faceY);
  });

  it('accepts an empty pond without inventing a tile', () => {
    const zone = layoutPond(manifest, { discards: [] });
    expect(zone.bodies).toHaveLength(0);
    expect(zone.shadows).toHaveLength(0);
    expect(zone.width).toBe(0);
    expect(zone.height).toBe(0);
    expect(zone.sigmaPx1x).toBe(12);
    expect(zone.blurPad).toBe(36);
  });

  it('rotates the pond frame for each seat', () => {
    const six = Array.from({ length: 12 }, (_, index) => ({
      face: FACES[index % FACES.length],
      riichi: index === 4,
    }));

    const right = layoutPond(manifest, { discards: six, side: 'right' });
    expect(flatShellsForSeat(manifest, 'right').normalId).toBe('shell_flat_sideways');
    expect(right.shadows[0].shell).toBe('shell_flat_sideways');
    expect(right.shadows[4].shell).toBe('shell_flat_upright_180');
    // The right player's columns run up the screen and the rows toward them.
    expect(right.shadows[1].faceY - right.shadows[0].faceY).toBeCloseTo(-55.15, 9);
    expect(right.shadows[6].faceX - right.shadows[0].faceX).toBeCloseTo(104, 9);
    // The turned tile shifts toward the player by 106 - 72 = 34 px.
    expect(right.shadows[4].faceX - right.shadows[0].faceX).toBeCloseTo(34, 9);
    expect(right.shadows[5].faceY - right.shadows[4].faceY).toBeCloseTo(-65.44, 9);

    const top = layoutPond(manifest, { discards: six, side: 'top' });
    expect(top.shadows[0].shell).toBe('shell_flat_upright_180');
    expect(top.shadows[4].shell).toBe('shell_flat_sideways_270');
    expect(top.shadows[1].faceX - top.shadows[0].faceX).toBeCloseTo(-69.41, 9);
    expect(top.shadows[6].faceY - top.shadows[0].faceY).toBeCloseTo(-65.44, 9);
    expect(top.shadows[5].faceX - top.shadows[4].faceX).toBeCloseTo(-104, 9);

    const left = layoutPond(manifest, { discards: six, side: 'left' });
    expect(left.shadows[0].shell).toBe('shell_flat_sideways_270');
    expect(left.shadows[4].shell).toBe('shell_flat_upright');
    expect(left.shadows[1].faceY - left.shadows[0].faceY).toBeCloseTo(55.15, 9);
    expect(left.shadows[6].faceX - left.shadows[0].faceX).toBeCloseTo(-104, 9);
    expect(left.shadows[5].faceY - left.shadows[4].faceY).toBeCloseTo(65.44, 9);
  });
});

describe('front/back wall zone', () => {
  it('places 17 stacks at the centre slot step, lower tier first', () => {
    const zone = layoutWall(manifest, { wall: 'front', doraIndex: 12 });
    expect(zone.layer).toBe(ZONE_LAYER.bottomWall);
    expect(zone.shadowGroup).toBe('walls');
    expect(zone.sigmaPx1x).toBe(12);
    expect(zone.bodies).toHaveLength(WALL_STACKS * 2);
    expect(zone.shadows).toHaveLength(WALL_STACKS);

    const lowerIds = [
      0, 16, 1, 15, 2, 14, 3, 13, 4, 12, 5, 11, 6, 10, 7, 9, 8,
    ].map((index) => `shell_wall_front_slot_${String(index).padStart(2, '0')}`);
    expect(zone.bodies.slice(0, WALL_STACKS).map((body) => body.shell)).toEqual(lowerIds);
    expect(zone.shadows.map((body) => body.shell)).toEqual(lowerIds);
    expect(zone.bodies.slice(WALL_STACKS).length).toBe(WALL_STACKS);

    const centre = byShell(zone, 'shell_wall_front_slot_08');
    const first = byShell(zone, 'shell_wall_front_slot_00');
    const last = byShell(zone, 'shell_wall_front_slot_16');
    expect(byShell(zone, 'shell_wall_front_slot_01').faceX - first.faceX).toBeCloseTo(
      69.72,
      9,
    );
    expect(last.faceX - first.faceX).toBeCloseTo(16 * 69.72, 9);
    expect(centre.hitBox.width).toBe(73);
    expect(centre.hitBox.height).toBe(102);
    expect(first.hitBox.width).toBe(81);
    expect(first.face).toBeNull();
  });

  it('puts the upper tier at the lower tier + stackStep and marks the dora', () => {
    const zone = layoutWall(manifest, { wall: 'front', doraIndex: 12 });
    const lowerOrder = [
      0, 16, 1, 15, 2, 14, 3, 13, 4, 12, 5, 11, 6, 10, 7, 9, 8,
    ];
    const dora = zone.bodies.find((body) => body.dora);
    expect(dora).toBeDefined();
    expect(dora!.shell).toBe('shell_wall_front_slot_12_faceup');
    expect(dora!.face).toBeNull();
    expect(zone.shadows.every((tile) => tile.dora === false)).toBe(true);

    for (let index = 0; index < WALL_STACKS; index += 1) {
      const slot = lowerOrder[index];
      const lower = zone.bodies[index];
      const upper = zone.bodies[WALL_STACKS + index];
      const baseShell = manifest.shells[lower.shell];
      expect(upper.gridX).toBeCloseTo(lower.gridX + baseShell.stackStepPx![0], 9);
      expect(upper.gridY).toBeCloseTo(lower.gridY + baseShell.stackStepPx![1], 9);
      const expected = `shell_wall_front_slot_${String(slot).padStart(2, '0')}${
        slot === 12 ? '_faceup' : ''
      }`;
      expect(upper.shell).toBe(expected);
    }
  });

  it('keeps the fan origin fixed when the wall is a remaining run', () => {
    const zone = layoutWall(manifest, { wall: 'back', count: 5, startIndex: 3 });
    expect(zone.bodies).toHaveLength(10);
    expect(zone.shadows.map((tile) => tile.shell)).toEqual([
      'shell_wall_back_slot_03',
      'shell_wall_back_slot_07',
      'shell_wall_back_slot_04',
      'shell_wall_back_slot_06',
      'shell_wall_back_slot_05',
    ]);
    const first = byShell(zone, 'shell_wall_back_slot_03');
    const next = byShell(zone, 'shell_wall_back_slot_04');
    expect(next.faceX - first.faceX).toBeCloseTo(69.64, 9);
    expect(zone.layer).toBe(ZONE_LAYER.topWallAndHand);
  });

  it('rejects a run that leaves the 17-slot fan', () => {
    expect(() => layoutWall(manifest, { wall: 'front', count: 18 })).toThrow();
    expect(() => layoutWall(manifest, { wall: 'front', startIndex: 16, count: 2 })).toThrow();
  });
});

describe('side wall zone', () => {
  it('steps down the axis whose vector points down', () => {
    const left = layoutSideWall(manifest, { side: 'left', doraIndex: 5 });
    expect(left.layer).toBe(ZONE_LAYER.sideWalls);
    expect(left.shadowGroup).toBe('walls');
    expect(left.sigmaPx1x).toBe(12);
    expect(left.bodies).toHaveLength(34);
    expect(left.shadows).toHaveLength(17);

    const leftFirst = left.shadows[0];
    const leftSecond = left.shadows[1];
    expect(leftSecond.faceX - leftFirst.faceX).toBeCloseTo(-6.91, 9);
    expect(leftSecond.faceY - leftFirst.faceY).toBeCloseTo(45.96, 9);
    expect(leftSecond.faceY).toBeGreaterThan(leftFirst.faceY);

    const right = layoutSideWall(manifest, { side: 'right' });
    const rightFirst = right.shadows[0];
    const rightSecond = right.shadows[1];
    expect(rightSecond.faceX - rightFirst.faceX).toBeCloseTo(6.91, 9);
    expect(rightSecond.faceY - rightFirst.faceY).toBeCloseTo(45.96, 9);
  });

  it('draws all lower tiers before the upper tiers and marks the dora', () => {
    const zone = layoutSideWall(manifest, { side: 'left', doraIndex: 5 });
    for (let index = 0; index < 17; index += 1) {
      expect(zone.bodies[index].dora).toBe(false);
    }
    for (let index = 17; index < 34; index += 1) {
      const upper = zone.bodies[index];
      const lower = zone.bodies[index - 17];
      const base = manifest.shells['shell_wall_side_left'];
      expect(upper.gridX).toBeCloseTo(lower.gridX + base.stackStepPx![0], 9);
      expect(upper.gridY).toBeCloseTo(lower.gridY + base.stackStepPx![1], 9);
      expect(upper.shell).toBe(
        index - 17 === 5 ? 'shell_wall_side_left_faceup' : 'shell_wall_side_left',
      );
    }
    expect(zone.bodies.find((body) => body.dora)?.face).toBeNull();
  });

  it('accepts a remaining run and rejects one past 17 stacks', () => {
    const zone = layoutSideWall(manifest, { side: 'right', count: 4, startIndex: 9 });
    expect(zone.shadows).toHaveLength(4);
    expect(zone.bodies).toHaveLength(8);
    expect(zone.shadows.map((tile) => tile.shell)).toEqual([
      'shell_wall_side_right',
      'shell_wall_side_right',
      'shell_wall_side_right',
      'shell_wall_side_right',
    ]);
    expect(() => layoutSideWall(manifest, { side: 'right', startIndex: 15, count: 3 })).toThrow();
  });
});

describe('zone order and groups', () => {
  it('maps every zone to Task 4.1’s layer', () => {
    expect(zoneLayer('wall', null, 'back')).toBe(1);
    expect(zoneLayer('wall', null, 'front')).toBe(4);
    expect(zoneLayer('wall', 'left')).toBe(2);
    expect(zoneLayer('wall', 'right')).toBe(2);
    expect(zoneLayer('hand', 'top')).toBe(1);
    expect(zoneLayer('melds', 'top')).toBe(1);
    expect(zoneLayer('hand', 'bottom')).toBe(6);
    expect(zoneLayer('hand', 'left')).toBe(5);
    expect(zoneLayer('hand', 'right')).toBe(5);
    expect(zoneLayer('melds', 'left')).toBe(5);
    expect(zoneLayer('pond', 'top')).toBe(3);
  });

  it('shares one shadow group across all four walls only', () => {
    expect(zoneShadowGroup('wall', null)).toBe('walls');
    expect(zoneShadowGroup('pond', 'bottom')).toBe('pond-bottom');
    expect(zoneShadowGroup('hand', 'bottom')).toBe('seat-bottom-hand');
    expect(zoneShadowGroup('melds', 'bottom')).toBe('seat-bottom-melds');
  });

  it('keeps hand and meld shadows separate because their sigmas differ', () => {
    const hand = layoutHand(manifest, { faces: FACES });
    const meld = layoutMeld(manifest, { faces: ['1m', '2m', '3m'] });
    expect(hand.shadowGroup).not.toBe(meld.shadowGroup);
    expect(hand.sigmaPx1x).toBe(5);
    expect(meld.sigmaPx1x).toBe(12);
  });
});

describe('flat shell families', () => {
  it('picks four river orientations and the turned counterpart', () => {
    const bottom = flatShellsForSeat(manifest, 'bottom');
    expect([bottom.normalId, bottom.turnedId]).toEqual([
      'shell_flat_upright',
      'shell_flat_sideways',
    ]);
    const right = flatShellsForSeat(manifest, 'right');
    expect([right.normalId, right.turnedId]).toEqual([
      'shell_flat_sideways',
      'shell_flat_upright_180',
    ]);
    const top = flatShellsForSeat(manifest, 'top');
    expect([top.normalId, top.turnedId]).toEqual([
      'shell_flat_upright_180',
      'shell_flat_sideways_270',
    ]);
    const left = flatShellsForSeat(manifest, 'left');
    expect([left.normalId, left.turnedId]).toEqual([
      'shell_flat_sideways_270',
      'shell_flat_upright',
    ]);
  });
});

interface ReferenceTile {
  readonly id: string;
  readonly gridX: number;
  readonly gridY: number;
}
interface ReferenceZone {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly sigma: number;
  readonly blurPad: number;
  readonly tiles: readonly ReferenceTile[];
  readonly bodies: readonly ReferenceTile[];
}

/** Compare every body's id + normalised grid position, order included. */
function expectSameBodies(
  reference: ReferenceZone,
  zone: LayoutZone,
  ordered = true,
): void {
  expect(zone.bodies).toHaveLength(reference.bodies.length);
  if (ordered) {
    reference.bodies.forEach((body, index) => {
      expect(zone.bodies[index].shell).toBe(body.id);
      expect(zone.bodies[index].gridX).toBeCloseTo(body.gridX, 9);
      expect(zone.bodies[index].gridY).toBeCloseTo(body.gridY, 9);
    });
    return;
  }
  const seen = new Set<number>();
  for (const body of reference.bodies) {
    const match = zone.bodies.findIndex(
      (tile, index) =>
        !seen.has(index) &&
        tile.shell === body.id &&
        Math.abs(tile.gridX - body.gridX) < 1e-9 &&
        Math.abs(tile.gridY - body.gridY) < 1e-9,
    );
    expect(match, `${body.id} at ${body.gridX},${body.gridY}`).toBeGreaterThanOrEqual(0);
    seen.add(match);
  }
}

describe('reference layout parity', () => {
  it('matches group-layouts.mjs for every representative zone', async () => {
    const spec = JSON.parse(
      readFileSync(join(tableDir, '../../../tools/render/shell-spec.json'), 'utf8'),
    );
    const referenceUrl = new URL(
      '../../../tools/render/scripts/group-layouts.mjs',
      import.meta.url,
    ).href;
    const reference = (await import(
      /* @vite-ignore */ referenceUrl
    )) as {
      buildZones: (
        manifest: unknown,
        spec: unknown,
      ) => ReferenceZone[];
    };
    const expected = new Map(
      reference
        .buildZones(rawManifest, spec)
        .map((zone) => [zone.id, zone]),
    );
    const zones = representativeZones(manifest);
    const cases: { reference: string; zone: LayoutZone; ordered?: boolean }[] = [
      { reference: 'hand-13', zone: zones[0] },
      { reference: 'hand-14', zone: zones[1] },
      { reference: 'top-hand-13', zone: zones[2] },
      { reference: 'meld-3', zone: zones[3] },
      { reference: 'pond-row-6', zone: zones[4] },
      { reference: 'pond-4x6-riichi', zone: zones[5] },
      { reference: 'wall-front-17', zone: zones[6] },
      // The side wall's reference interleaves tiers; Task 4.2 draws all bottom
      // tiers first, so positions are compared as a set.
      { reference: 'wall-side-left-17', zone: zones[7], ordered: false },
    ];

    for (const entry of cases) {
      const source = expected.get(entry.reference);
      expect(source, entry.reference).toBeDefined();
      expect(entry.zone.width, entry.reference).toBe(source!.width);
      expect(entry.zone.height, entry.reference).toBe(source!.height);
      expect(entry.zone.sigmaPx1x, entry.reference).toBe(source!.sigma);
      expect(entry.zone.blurPad, entry.reference).toBe(source!.blurPad);
      expectSameBodies(source!, entry.zone, entry.ordered ?? true);
      expect(entry.zone.shadows).toHaveLength(source!.tiles.length);
      source!.tiles.forEach((tile, index) => {
        expect(entry.zone.shadows[index].shell).toBe(tile.id);
        expect(entry.zone.shadows[index].gridX).toBeCloseTo(tile.gridX, 9);
        expect(entry.zone.shadows[index].gridY).toBeCloseTo(tile.gridY, 9);
      });
    }
  });
});

describe('draw positions', () => {
  it('are whole @1x px for every representative zone', () => {
    for (const zone of representativeZones(manifest)) {
      for (const tile of [...zone.bodies, ...zone.shadows]) {
        expect(Number.isInteger(tile.drawX)).toBe(true);
        expect(Number.isInteger(tile.drawY)).toBe(true);
        const shell = manifest.shells[tile.shell];
        expect(tile.drawX).toBe(Math.round(tile.gridX - shell.anchorX));
        expect(tile.drawY).toBe(Math.round(tile.gridY - shell.anchorY));
      }
    }
  });

  it('keeps the logical hit box on the published advance box, not the texture', () => {
    for (const zone of representativeZones(manifest)) {
      for (const tile of zone.bodies) {
        const shell = manifest.shells[tile.shell];
        expect(tile.hitBox).toEqual({
          x: tile.gridX,
          y: tile.gridY,
          width: shell.advanceWidth,
          height: shell.advanceHeight,
        });
      }
    }
  });
});

describe('wall stack metadata', () => {
  it('reads the published stack step and count from the manifest', () => {
    expect(WALL_CENTRE_INDEX).toBe(8);
    const front = manifest.shells['shell_wall_front_slot_08'];
    expect(front.stackCount).toBe(2);
    expect(front.stackStepPx).toEqual([0, -39.02]);
    const left = manifest.shells['shell_wall_side_left'];
    expect(left.stackCount).toBe(2);
    expect(left.stackStepPx).toEqual([-5.64, -39.87]);
  });
});

describe('hand slot metadata', () => {
  it('derives the draw gap from handSlot.offsetUnits', () => {
    expect(manifest.shells['shell_hand_slot_draw'].handSlot?.offsetUnits).toBe(5.5125);
    expect(manifest.shells['shell_hand_slot_06'].handSlot?.offsetUnits).toBe(0);
    expect(manifest.shells['shell_hand_slot_00'].handSlot?.offsetUnits).toBe(-4.5);
  });
});

describe('plate sanity', () => {
  it('places every body inside its zone bounds', () => {
    for (const zone of representativeZones(manifest)) {
      for (const tile of zone.bodies) {
        const shell = manifest.shells[tile.shell];
        const left = tile.gridX - shell.anchorX;
        const top = tile.gridY - shell.anchorY;
        expect(left).toBeGreaterThanOrEqual(-0.5);
        expect(top).toBeGreaterThanOrEqual(-0.5);
        expect(left + shell.texWidth).toBeLessThanOrEqual(zone.width + 0.5);
        expect(top + shell.texHeight).toBeLessThanOrEqual(zone.height + 0.5);
      }
    }
  });
});

describe('surface invariants', () => {
  it('never returns a fractional draw position or a texture-sized hit box', () => {
    for (const zone of representativeZones(manifest)) {
      for (const tile of zone.bodies) {
        const shell = manifest.shells[tile.shell];
        expect(tile.hitBox.width).not.toBe(shell.texWidth);
        expect(tile.hitBox.height).not.toBe(shell.texHeight);
      }
    }
  });
});
