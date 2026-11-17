import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseShellsManifest } from './shellManifest';
import type { ShellsManifest } from './shellManifest';
import {
  BOARD_MARGIN,
  buildBoard,
  faceLabel,
  wallStacksFor,
  wallStartIndex,
} from './boardLayout';
import type { Board, BoardZone } from './boardLayout';
import { boardOverlay } from './boardOverlay';
import { boardImagePaths } from './boardAssets';
import { boardGameState } from './boardFixture';
import { SIDE_POND_LEAN_DEG, ZONE_LAYER } from './zoneLayout';

const tableDir = fileURLToPath(new URL('../../public/table/', import.meta.url));
const manifest: ShellsManifest = parseShellsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')),
);

const board = (): Board => buildBoard(manifest, boardGameState());
const zone = (result: Board, id: string): BoardZone => {
  const found = result.zones.find((entry) => entry.id === id);
  if (!found) throw new Error(`board has no ${id}`);
  return found;
};

describe('wall run', () => {
  it('draws the full 17-stack ring for the whole hand', () => {
    expect(wallStacksFor(0)).toBe(17);
    expect(wallStacksFor(1)).toBe(17);
    expect(wallStacksFor(70)).toBe(17);
    expect(wallStacksFor(136)).toBe(17);
    expect(wallStacksFor(Number.NaN)).toBe(0);
  });

  it('centres a shrinking run on the full 17-slot fan', () => {
    expect(wallStartIndex(17)).toBe(0);
    expect(wallStartIndex(9)).toBe(4);
    expect(wallStartIndex(1)).toBe(8);
    expect(wallStartIndex(0)).toBe(8);
  });
});

describe('Task 4.1 global painter order', () => {
  it('draws the zones in the architecture layer order', () => {
    const result = board();
    expect(result.zones.map((entry) => entry.id)).toEqual([
      'wall-back',
      'hand-top',
      'wall-side-left',
      'wall-side-right',
      'pond-bottom',
      'pond-right',
      'pond-top',
      'pond-left',
      'wall-front',
      'hand-left',
      'melds-right-0',
      'hand-right',
      'melds-bottom-0',
      'hand-bottom',
    ]);
    expect(result.zones.map((entry) => entry.layer)).toEqual([
      ZONE_LAYER.topWallAndHand,
      ZONE_LAYER.topWallAndHand,
      ZONE_LAYER.sideWalls,
      ZONE_LAYER.sideWalls,
      ZONE_LAYER.centreAndPonds,
      ZONE_LAYER.centreAndPonds,
      ZONE_LAYER.centreAndPonds,
      ZONE_LAYER.centreAndPonds,
      ZONE_LAYER.bottomWall,
      ZONE_LAYER.sideHandsAndMelds,
      ZONE_LAYER.sideHandsAndMelds,
      ZONE_LAYER.sideHandsAndMelds,
      ZONE_LAYER.bottomHandAndMelds,
      ZONE_LAYER.bottomHandAndMelds,
    ]);
  });

  it('keeps layers non-decreasing so no later zone can slip behind', () => {
    const layers = board().zones.map((entry) => entry.layer);
    expect(layers).toEqual([...layers].sort((left, right) => left - right));
  });

  it('draws the top player’s melds with its hand on layer 1', () => {
    const state = boardGameState();
    state.players[2].melds = [
      { meld_type: 'Pon', tiles: ['2z', '2z', '2z'], called_from: 0 },
    ];
    const result = buildBoard(manifest, state);
    const ids = result.zones.map((entry) => entry.id);
    expect(ids.slice(0, 3)).toEqual(['wall-back', 'melds-top-0', 'hand-top']);
    expect(result.zones[1].layer).toBe(ZONE_LAYER.topWallAndHand);
  });

  it('draws the bottom hand last, after its melds', () => {
    const result = board();
    const tail = result.zones.slice(-2).map((entry) => entry.id);
    expect(tail).toEqual(['melds-bottom-0', 'hand-bottom']);
    expect(result.zones.at(-1)?.id).toBe('hand-bottom');
  });

  it('drops empty ponds but keeps the full wall ring', () => {
    const state = boardGameState();
    state.players = state.players.map((player) => ({ ...player, discards: [] }));
    state.tiles_remaining = 0;
    const result = buildBoard(manifest, state);
    expect(result.zones.some((entry) => entry.zone.kind === 'pond')).toBe(false);
    const walls = result.zones.filter((entry) => entry.zone.kind === 'wall');
    expect(walls).toHaveLength(4);
    expect(walls.every((entry) => entry.zone.bodies.length === 34)).toBe(true);
  });
});

describe('Task 4.2 intra-zone order', () => {
  it('draws the hand fan outermost to innermost, centre then drawn tile', () => {
    const hand = zone(board(), 'hand-bottom');
    const shells = hand.zone.bodies.map((tile) => tile.shell);
    expect(shells).toEqual([
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
      'shell_hand_slot_draw',
    ]);
  });

  it('draws pond rows top to bottom and each row right to left', () => {
    const pond = zone(board(), 'pond-bottom');
    expect(pond.zone.bodies.map((tile) => [tile.cell?.row, tile.cell?.column])).toEqual([
      [0, 5],
      [0, 4],
      [0, 3],
      [0, 2],
      [0, 1],
      [0, 0],
      [1, 1],
      [1, 0],
    ]);
  });

  it('treats a 14-tile hand with no separate draw as 13 plus the drawn tile', () => {
    const state = boardGameState();
    const human = state.players[0];
    human.draw = null;
    human.hand = [...human.hand, '9s'];
    const hand = zone(buildBoard(manifest, state), 'hand-bottom');
    expect(hand.zone.bodies).toHaveLength(14);
    expect(hand.zone.bodies.at(-1)?.shell).toBe('shell_hand_slot_draw');
  });

  it('draws every wall bottom tier before its top tier', () => {    const result = board();
    const slots = [0, 16, 1, 15, 2, 14, 3, 13, 4, 12, 5, 11, 6, 10, 7, 9, 8];
    for (const id of ['wall-front', 'wall-back']) {
      const wall = zone(result, id);
      expect(wall.zone.bodies.map((tile) => tile.cell?.slot)).toEqual([...slots, ...slots]);
      expect(wall.zone.bodies.map((tile) => tile.cell?.tier)).toEqual([
        ...Array(17).fill(0),
        ...Array(17).fill(1),
      ]);
    }
  });

  it('draws the side wall columns back to front with all lowers first', () => {
    const wall = zone(board(), 'wall-side-left');
    expect(wall.zone.bodies.map((tile) => tile.cell?.tier)).toEqual([
      ...Array(17).fill(0),
      ...Array(17).fill(1),
    ]);
    expect(wall.zone.bodies.slice(0, 17).map((tile) => tile.cell?.slot)).toEqual(
      Array.from({ length: 17 }, (_, index) => index),
    );
  });
});

describe('board geometry', () => {
  it('rounds every draw position and keeps the advance box as the hit box', () => {
    const result = board();
    let tiles = 0;
    for (const placement of result.zones) {
      for (const tile of placement.zone.bodies) {
        tiles += 1;
        const shell = manifest.shells[tile.shell];
        expect(Number.isInteger(tile.drawX)).toBe(true);
        expect(Number.isInteger(tile.drawY)).toBe(true);
        expect(tile.hitBox.x).toBeCloseTo(tile.gridX, 10);
        expect(tile.hitBox.y).toBeCloseTo(tile.gridY, 10);
        expect(tile.hitBox.width).toBe(shell.advanceWidth);
        expect(tile.hitBox.height).toBe(shell.advanceHeight);
      }
    }
    expect(tiles).toBeGreaterThan(140);
  });

  it('keeps every body and shadow group inside the board', () => {
    const result = board();
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    for (const placement of result.zones) {
      expect(placement.bounds.x).toBeGreaterThanOrEqual(BOARD_MARGIN - 0.01);
      expect(placement.bounds.y).toBeGreaterThanOrEqual(BOARD_MARGIN - 0.01);
      expect(placement.bounds.x + placement.bounds.width).toBeLessThanOrEqual(
        result.width - BOARD_MARGIN + 0.01,
      );
      expect(placement.bounds.y + placement.bounds.height).toBeLessThanOrEqual(
        result.height - BOARD_MARGIN + 0.01,
      );
      for (const tile of placement.zone.bodies) {
        expect(placement.x + tile.hitBox.x).toBeGreaterThanOrEqual(0);
        expect(placement.y + tile.hitBox.y).toBeGreaterThanOrEqual(0);
        expect(placement.x + tile.hitBox.x + tile.hitBox.width).toBeLessThanOrEqual(
          result.width,
        );
        expect(placement.y + tile.hitBox.y + tile.hitBox.height).toBeLessThanOrEqual(
          result.height,
        );
      }
    }
    for (const group of result.groups) {
      expect(group.x - group.pad).toBeGreaterThanOrEqual(0);
      expect(group.y - group.pad).toBeGreaterThanOrEqual(0);
      expect(group.x + group.width + group.pad).toBeLessThanOrEqual(result.width);
      expect(group.y + group.height + group.pad).toBeLessThanOrEqual(result.height);
    }
  });

  it('reserves a centre compass square between the four ponds', () => {
    const result = board();
    expect(result.compass.width).toBe(180);
    expect(result.compass.height).toBe(180);
    expect(result.compass.x).toBeGreaterThan(0);
    expect(result.compass.y).toBeGreaterThan(0);
    expect(result.compass.x + result.compass.width).toBeLessThan(result.width);
    expect(result.compass.y + result.compass.height).toBeLessThan(result.height);
  });

  it('publishes the pond lean on the side ponds only', () => {
    const result = board();
    expect(zone(result, 'pond-left').zone.rotationDeg).toBe(SIDE_POND_LEAN_DEG);
    expect(zone(result, 'pond-right').zone.rotationDeg).toBe(-SIDE_POND_LEAN_DEG);
    expect(zone(result, 'pond-bottom').zone.rotationDeg).toBe(0);
    expect(zone(result, 'pond-top').zone.rotationDeg).toBe(0);
    expect(zone(result, 'pond-left').rotationPad).toBeGreaterThan(0);
  });

  it('places every layer at a whole @1x px', () => {
    const result = board();
    for (const placement of result.zones) {
      expect(Number.isInteger(placement.x)).toBe(true);
      expect(Number.isInteger(placement.y)).toBe(true);
      expect(Number.isInteger(placement.rotationPad)).toBe(true);
    }
    for (const group of result.groups) {
      expect(Number.isInteger(group.x)).toBe(true);
      expect(Number.isInteger(group.y)).toBe(true);
      expect(Number.isInteger(group.width)).toBe(true);
      expect(Number.isInteger(group.height)).toBe(true);
    }
  });

  it('leaves the separate shadow groups without overlapping bodies', () => {
    const result = board();
    // Each pond and each seat group blurs on its own. Their padded shadow
    // boxes may meet where a later body covers the tail (a hand over a wall
    // shadow), but two body layers must not share screen space.
    const bodyBounds = (placement: BoardZone): { x: number; y: number; right: number; bottom: number } => {
      let left = Infinity;
      let top = Infinity;
      let right = -Infinity;
      let bottom = -Infinity;
      for (const tile of placement.zone.bodies) {
        left = Math.min(left, placement.x + tile.hitBox.x);
        top = Math.min(top, placement.y + tile.hitBox.y);
        right = Math.max(right, placement.x + tile.hitBox.x + tile.hitBox.width);
        bottom = Math.max(bottom, placement.y + tile.hitBox.y + tile.hitBox.height);
      }
      return { x: left, y: top, right, bottom };
    };
    const overlaps: string[] = [];
    for (let left = 0; left < result.zones.length; left += 1) {
      for (let right = left + 1; right < result.zones.length; right += 1) {
        const a = result.zones[left];
        const b = result.zones[right];
        if (a.zone.shadowGroup === b.zone.shadowGroup) continue;
        const boxA = bodyBounds(a);
        const boxB = bodyBounds(b);
        const width = Math.min(boxA.right, boxB.right) - Math.max(boxA.x, boxB.x);
        const height = Math.min(boxA.bottom, boxB.bottom) - Math.max(boxA.y, boxB.y);
        if (width > 1 && height > 1) overlaps.push(`${a.id}/${b.id}`);
      }
    }
    expect(overlaps).toEqual([]);
  });
});

describe('group shadows', () => {
  it('unions all four walls into one group and keeps ponds/seats separate', () => {
    const result = board();
    expect(result.groups.map((group) => group.id)).toEqual([
      'walls',
      'seat-top-hand',
      'pond-bottom',
      'pond-right',
      'pond-top',
      'pond-left',
      'seat-left-hand',
      'seat-right-melds',
      'seat-right-hand',
      'seat-bottom-melds',
      'seat-bottom-hand',
    ]);
    const walls = result.groups.find((group) => group.id === 'walls');
    expect(walls?.zoneIds).toEqual([
      'wall-back',
      'wall-side-left',
      'wall-side-right',
      'wall-front',
    ]);
    expect(walls?.shapes).toHaveLength(4 * 17);
  });

  it('publishes one hard shape per placed shadow with the group sigma', () => {
    const result = board();
    const byId = new Map(result.zones.map((entry) => [entry.id, entry]));
    for (const group of result.groups) {
      const members = group.zoneIds.map((id) => {
        const placement = byId.get(id);
        if (!placement) throw new Error(`group ${group.id} names missing ${id}`);
        return placement;
      });
      const expected = members.reduce(
        (total, placement) => total + placement.zone.shadows.length,
        0,
      );
      expect(group.shapes).toHaveLength(expected);
      const first = members[0].zone.shadows[0];
      if (group.id === 'walls') {
        // The long wall run uses a wider visual blur than the published shell.
        expect(group.sigmaPx1x).toBeGreaterThanOrEqual(20);
      } else if (group.id === 'seat-left-hand' || group.id === 'seat-right-hand') {
        expect(group.sigmaPx1x).toBeGreaterThanOrEqual(20);
      } else {
        expect(group.sigmaPx1x).toBe(manifest.shells[first.shell].shadowShape.sigmaPx1x);
      }
      expect(group.coreAlpha).toBe(manifest.shells[first.shell].shadowShape.coreAlpha);
      expect(group.colorHex).toBe(manifest.shells[first.shell].shadowShape.colorHex);
      expect(group.pad).toBe(Math.ceil(3 * group.sigmaPx1x) + 2);
    }
  });

  it('uses the standing sigma for hand groups and the lying sigma for melds', () => {
    const result = board();
    const group = (id: string) => result.groups.find((entry) => entry.id === id);
    expect(group('seat-bottom-hand')?.sigmaPx1x).toBe(5);
    expect(group('seat-bottom-melds')?.sigmaPx1x).toBe(12);
    expect(group('pond-bottom')?.sigmaPx1x).toBe(12);
    expect(group('walls')?.sigmaPx1x).toBe(20);
  });

  it('rotates side-wall and side-hand shadow shapes with their rows', () => {
    const result = board();
    const walls = result.groups.find((group) => group.id === 'walls');
    // The group follows zone order: back wall, left wall, right wall, front wall.
    const back = zone(result, 'wall-back');
    const left = zone(result, 'wall-side-left');
    const right = zone(result, 'wall-side-right');
    const leftShapes = walls?.shapes.slice(
      back.zone.shadows.length,
      back.zone.shadows.length + left.zone.shadows.length,
    );
    const rightShapes = walls?.shapes.slice(
      back.zone.shadows.length + left.zone.shadows.length,
      back.zone.shadows.length + left.zone.shadows.length + right.zone.shadows.length,
    );
    expect(leftShapes?.every((shape) => Math.abs(shape.angleDeg - 8.55) < 0.1)).toBe(true);
    expect(rightShapes?.every((shape) => Math.abs(shape.angleDeg + 8.55) < 0.1)).toBe(true);
    expect(
      result.groups
        .filter((group) => group.id === 'seat-left-hand' || group.id === 'seat-right-hand')
        .every((group) => group.shapes.every((shape) => Math.abs(shape.angleDeg) > 5)),
    ).toBe(true);
  });

  it('rotates a leaning pond’s shapes, not its body placements', () => {
    const result = board();
    const right = result.groups.find((group) => group.id === 'pond-right');
    const first = right?.shapes[0];
    const tile = zone(result, 'pond-right').zone.shadows[0];
    const base = manifest.shells[tile.shell].shadowShape;
    expect(first?.angleDeg).toBeCloseTo(base.angleDeg - SIDE_POND_LEAN_DEG, 10);
  });
});

describe('labels', () => {
  it('names red fives and bare faces for the hit layer', () => {
    expect(faceLabel('5pr')).toBe('R5p');
    expect(faceLabel('7z')).toBe('R');
    expect(faceLabel('blank')).toBe('blank tile');
    expect(faceLabel(null)).toBe('face-down tile');
  });

  it('preloads bare shells but not face-up atlas shells', () => {
    const result = board();
    const paths = boardImagePaths(result, manifest, new Map());
    expect(paths).toContain(manifest.shells.shell_wall_front_slot_04.textureFile);
    expect(paths).toContain(manifest.shells.shell_hand_side_left.textureFile);
    expect(paths).not.toContain(manifest.shells.shell_hand_slot_00.textureFile);
    expect(paths).not.toContain(manifest.shells.shell_flat_upright.textureFile);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('accessible hit map', () => {
  it('covers every body exactly once', () => {
    const result = board();
    const overlay = boardOverlay(result, boardGameState());
    const hits = overlay.sections.flatMap((section) =>
      section.zones.flatMap((entry) => entry.tiles),
    );
    const bodies = result.zones.reduce(
      (total, placement) => total + placement.zone.bodies.length,
      0,
    );
    expect(hits).toHaveLength(bodies);
  });

  it('uses the top-down seat names and keeps the shared walls separate', () => {
    const state = boardGameState();
    const overlay = boardOverlay(board(), state);
    expect(overlay.sections.map((section) => section.label)).toEqual([
      'your seat, at the bottom, You',
      'right side, shimocha, Shimocha',
      'across, toimen, Toimen',
      'left side, kamicha, Kamicha',
      'Walls, 70 tiles remaining',
    ]);
    const wall = overlay.sections.find((section) => section.key === 'walls');
    expect(wall?.seat).toBeNull();
    expect(wall?.zones.every((entry) => entry.kind === 'wall')).toBe(true);
  });

  it('publishes the advance box for every tile, in board space', () => {
    const result = board();
    const state = boardGameState();
    const overlay = boardOverlay(result, state);
    for (const section of overlay.sections) {
      for (const hitZone of section.zones) {
        const placement = zone(result, hitZone.id);
        for (const tile of hitZone.tiles) {
          const body = placement.zone.bodies[tile.bodyIndex];
          expect(tile.width).toBe(body.hitBox.width);
          expect(tile.height).toBe(body.hitBox.height);
          expect(tile.x).toBeCloseTo(placement.x + body.hitBox.x, 10);
          expect(tile.y).toBeCloseTo(placement.y + body.hitBox.y, 10);
        }
      }
    }
  });

  it('labels pond tiles with riichi and tsumogiri notes', () => {
    const overlay = boardOverlay(board(), boardGameState());
    const pond = overlay.sections
      .flatMap((section) => section.zones)
      .find((entry) => entry.id === 'pond-bottom');
    const riichi = pond?.tiles.find((tile) => tile.riichi);
    expect(riichi?.label).toBe('1s');
    expect(riichi?.note).toContain('riichi discard');
    expect(pond?.tiles.some((tile) => tile.note?.includes('tsumogiri'))).toBe(true);
  });

  it('marks only the newest discard of the called seat', () => {
    const result = board();
    const state = boardGameState();
    const overlay = boardOverlay(result, state, 0);
    const bottom = overlay.sections.find((section) => section.key === 'seat-bottom');
    const highlighted = bottom?.zones
      .flatMap((entry) => entry.tiles)
      .filter((tile) => tile.highlight);
    expect(highlighted).toHaveLength(1);
    expect(highlighted?.[0].label).toBe('R5s');
    const others = overlay.sections
      .filter((section) => section.key !== 'seat-bottom')
      .flatMap((section) => section.zones.flatMap((entry) => entry.tiles))
      .filter((tile) => tile.highlight);
    expect(others).toHaveLength(0);
  });

  it('keeps the top-down compass information', () => {
    const state = boardGameState();
    const overlay = boardOverlay(board(), state);
    expect(overlay.compass.seats.map((seat) => seat.label)).toEqual([
      'East wind, 25000 points, riichi',
      'South wind, 25000 points',
      'West wind, 25000 points',
      'North wind, 25000 points',
    ]);
    expect(overlay.compass.roundLabel).toBe('Round East 1, 70 tiles remaining');
  });
});
