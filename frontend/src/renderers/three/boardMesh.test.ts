/**
 * The instanced board (3D-07 acceptance): one draw for every tile, exact
 * buffers, honest flags and the 320-instance capacity.
 *
 * Everything here runs in Node. `boardMesh.ts` keeps the packing pure, so the
 * properties that matter are numbers over the packed typed arrays rather than
 * pixels:
 *
 * - one instance per layout tile, in the layout's stable authoring order;
 * - every matrix finite, every tile inside the mat, every translation equal to
 *   the pose the layout published;
 * - the face-up / highlighted / dimmed bits are the layout's own flags, and a
 *   face-down tile declares the neutral atlas rect (it never samples the atlas);
 * - a board above 320 instances fails loudly instead of dropping tiles.
 *
 * The same module builds the real `InstancedMesh` used by `Scene`, so the
 * buffer-shape assertions are about the object that actually draws.
 */

import { InstancedBufferAttribute, Texture } from 'three';
import { describe, expect, it } from 'vitest';
import { TILE } from '../layoutConstants';
import { boardFixture } from './boardFixture';
import { layoutBoard } from './boardLayout';
import {
  BOARD_TILE_CAPACITY,
  INSTANCE_FLAG,
  MAT_BOUNDS_UNITS,
  NEUTRAL_ATLAS_RECT,
  buildBoardInstances,
  createBoardMesh,
  instanceFlags,
  instanceShade,
  packBoardInstances,
} from './boardMesh';
import { TILE_SHADE } from './lighting';
import { createTileMaterial } from './tileMaterial';
import type { TileMaterialHandle } from './tileMaterial';
import type { TileFaceId } from '../contract';

const layout = layoutBoard(boardFixture());

/** A deterministic stand-in for the relief atlas's cell lookup. */
function cellForFace(face: TileFaceId): { readonly rect: readonly [number, number, number, number] } | null {
  if (face === 'blank') return null;
  const index = [...'123456789mpzs'].indexOf(face[0]);
  return { rect: [0.1, 0.2 + index * 0.01, 0.3, 0.4] };
}

function material(): TileMaterialHandle {
  return createTileMaterial({
    tier: 'high',
    debug: null,
    albedo: new Texture(),
    normalDepth: new Texture(),
    aoRoughness: new Texture(),
  });
}

const instances = buildBoardInstances(layout, cellForFace);

describe('board instances', () => {
  it('has one instance per layout tile, with unique ids', () => {
    expect(instances).toHaveLength(layout.tiles.length);
    const ids = new Set(instances.map((instance) => instance.id));
    expect(ids.size).toBe(instances.length);
    // A wall tile, a pond tile, the human hand and the dora are all present.
    const sampled = [
      layout.wall[0],
      layout.foreground.find((entry) => entry.zone === 'river'),
      layout.foreground.find((entry) => entry.zone === 'hand'),
      layout.foreground.find((entry) => entry.zone === 'dora'),
    ].filter((tile): tile is NonNullable<typeof tile> => tile !== undefined);
    expect(sampled).toHaveLength(4);
    for (const tile of sampled) {
      expect(ids.has(tile.id), tile.id).toBe(true);
    }
  });

  it('fits the committed 320-instance capacity with room to spare', () => {
    expect(BOARD_TILE_CAPACITY).toBe(320);
    expect(instances.length).toBeLessThan(BOARD_TILE_CAPACITY);
    // A game has 136 tiles in total, so a legal board can never approach the
    // capacity: this is a guard against a malformed snapshot, not a budget.
    expect(instances.length + 136).toBeLessThan(BOARD_TILE_CAPACITY + 136);
  });

  it('packs finite matrices whose translations are the layout poses', () => {
    const packed = packBoardInstances(instances);
    expect(packed.count).toBe(instances.length);
    expect(packed.matrices).toHaveLength(instances.length * 16);
    expect(packed.atlasRects).toHaveLength(instances.length * 4);
    expect(packed.flags).toHaveLength(instances.length);

    instances.forEach((instance, index) => {
      const matrix = packed.matrices.subarray(index * 16, index * 16 + 16);
      expect(matrix.every((value) => Number.isFinite(value)), instance.id).toBe(true);
      // Column-major: elements 12..14 are the translation.
      const tile = layout.tiles[index];
      expect(matrix[12], `${instance.id} x`).toBeCloseTo(tile.pose.position[0], 6);
      expect(matrix[13], `${instance.id} y`).toBeCloseTo(tile.pose.position[1], 6);
      expect(matrix[14], `${instance.id} z`).toBeCloseTo(tile.pose.position[2], 6);
      // A rigid transform: the upper 3x3 has unit-length axes.
      for (const axis of [0, 1, 2]) {
        const length = Math.hypot(
          matrix[axis * 4],
          matrix[axis * 4 + 1],
          matrix[axis * 4 + 2],
        );
        expect(length, `${instance.id} axis ${axis}`).toBeCloseTo(1, 6);
      }
    });
  });

  it('keeps every tile inside the mat, half an extent included', () => {
    const half = Math.max(TILE.widthUnits, TILE.heightUnits, TILE.thicknessUnits) / 2;
    for (const tile of layout.tiles) {
      const [x, , z] = tile.pose.position;
      expect(Math.abs(x) + half, `${tile.id} x`).toBeLessThanOrEqual(MAT_BOUNDS_UNITS + 1e-9);
      expect(Math.abs(z) + half, `${tile.id} z`).toBeLessThanOrEqual(MAT_BOUNDS_UNITS + 1e-9);
    }
  });

  it('carries face-up, highlighted and dimmed as separate bits', () => {
    const highlighted = instances.filter(
      (instance) => (instance.flags & INSTANCE_FLAG.highlighted) !== 0,
    );
    const dimmed = instances.filter(
      (instance) => (instance.flags & INSTANCE_FLAG.dimmed) !== 0,
    );
    expect(highlighted.length).toBeGreaterThan(0);
    expect(dimmed.length).toBeGreaterThan(0);
    // The fixture's call marker names seat 0's newest discard.
    const marker = layout.foreground.find(
      (tile) => tile.seat === 0 && tile.zone === 'river' && tile.highlighted,
    );
    expect(marker).toBeDefined();
    const instance = instances.find((entry) => entry.id === marker?.id);
    expect(instance).toBeDefined();
    expect((instance?.flags ?? 0) & INSTANCE_FLAG.highlighted).toBe(INSTANCE_FLAG.highlighted);
    expect((instance?.flags ?? 0) & INSTANCE_FLAG.dimmed).toBe(0);
    // The tsumogiri discard is dimmed and not highlighted.
    const tsumogiri = instances.find(
      (entry) => (entry.flags & INSTANCE_FLAG.dimmed) === INSTANCE_FLAG.dimmed,
    );
    expect(tsumogiri?.flags).toBe(INSTANCE_FLAG.faceUp | INSTANCE_FLAG.dimmed);

    // Wall tiles are face-down and unflagged; the human hand is face-up.
    for (const tile of layout.wall) {
      const wallInstance = instances.find((entry) => entry.id === tile.id);
      expect(wallInstance?.flags, tile.id).toBe(0);
    }
    expect(instanceFlags({ faceUp: true, highlighted: false, dimmed: false })).toBe(1);
    expect(instanceFlags({ faceUp: true, highlighted: true, dimmed: true })).toBe(7);
  });

  it('resolves the atlas rect for faces and the neutral rect for backs', () => {
    const faceUp = instances.filter((instance) => (instance.flags & INSTANCE_FLAG.faceUp) !== 0);
    expect(faceUp.length).toBeGreaterThan(0);
    for (const instance of faceUp) {
      // The stand-in lookup's cell: u0/v1 fixed, v0 keyed by the face.
      expect(instance.atlasRect[0], instance.id).toBe(0.1);
      expect(instance.atlasRect[2], instance.id).toBe(0.3);
      expect(instance.atlasRect[3], instance.id).toBe(0.4);
      expect(instance.atlasRect[1], instance.id).toBeGreaterThanOrEqual(0.2);
    }
    for (const instance of instances) {
      if ((instance.flags & INSTANCE_FLAG.faceUp) !== 0) continue;
      expect(instance.atlasRect, instance.id).toEqual(NEUTRAL_ATLAS_RECT);
    }
  });

  it('draws opponent hands face-down and the human hand face-up', () => {
    const handInstance = (seat: number) => {
      const tile = layout.foreground.find(
        (entry) => entry.zone === 'hand' && entry.seat === seat && entry.slot === 0,
      );
      expect(tile, `seat ${seat} hand`).toBeDefined();
      const instance = instances.find((entry) => entry.id === tile?.id);
      expect(instance, `seat ${seat} instance`).toBeDefined();
      return instance;
    };
    expect((handInstance(0)?.flags ?? 0) & INSTANCE_FLAG.faceUp).toBe(INSTANCE_FLAG.faceUp);
    for (const seat of [1, 2, 3]) {
      expect((handInstance(seat)?.flags ?? 0) & INSTANCE_FLAG.faceUp).toBe(0);
    }
    // The dora indicators are the face-up wall tiles.
    const dora = layout.foreground.find((entry) => entry.zone === 'dora');
    const doraInstance = instances.find((entry) => entry.id === dora?.id);
    expect((doraInstance?.flags ?? 0) & INSTANCE_FLAG.faceUp).toBe(INSTANCE_FLAG.faceUp);
  });

  it('keeps a turned discard upright in its own body (roll, not a glyph hack)', () => {
    // The riichi discard is the river's slot 5 in the fixture: the same body and
    // face as its neighbour, turned 90° in its own plane. The glyph-up axis is
    // therefore the seat's right (+X for seat 0) rather than the tile's
    // forward -Z, and no separate glyph rotation exists anywhere.
    const river = (slot: number) =>
      layout.foreground.find(
        (entry) => entry.seat === 0 && entry.zone === 'river' && entry.slot === slot,
      );
    const upright = river(4);
    const turned = river(5);
    expect(upright?.pose.rollDeg).toBe(0);
    expect(turned?.pose.rollDeg).toBe(-90);
    expect(turned?.sideways).toBe(true);

    const axis = (tileId: string | undefined): readonly [number, number, number] => {
      const instance = instances.find((entry) => entry.id === tileId);
      if (!instance) throw new Error(`missing instance ${String(tileId)}`);
      return [instance.matrix[4], instance.matrix[5], instance.matrix[6]];
    };
    const [ux, uy, uz] = axis(upright?.id);
    const [tx, ty, tz] = axis(turned?.id);
    // Upright: the glyph-up axis lies along the tile's own long axis (world -Z).
    expect(Math.abs(uz)).toBeCloseTo(1, 9);
    expect(Math.abs(ux)).toBeCloseTo(0, 9);
    // Turned: the same axis now points along the seat's right (world +X), still
    // in the felt plane, so the face reads sideways to the player.
    expect(Math.abs(tx)).toBeCloseTo(1, 9);
    expect(Math.abs(tz)).toBeCloseTo(0, 9);
    expect(Math.abs(uy)).toBeCloseTo(0, 9);
    expect(Math.abs(ty)).toBeCloseTo(0, 9);
  });

  it('shades only the hands: the player lighter, the three opponents equally (3D-18)', () => {
    const humanSeat = layout.humanSeat;
    const byId = new Map(instances.map((instance) => [instance.id, instance]));
    // Every hand and draw tile is shaded; the human's less than the others.
    for (const tile of layout.foreground) {
      const instance = byId.get(tile.id);
      expect(instance, tile.id).toBeDefined();
      if (!instance) continue;
      const expected = instanceShade(tile, humanSeat);
      expect(instance.shade, tile.id).toBe(expected);
      if (tile.zone === 'hand' || tile.zone === 'draw') {
        expect(expected).toBe(
          tile.seat === humanSeat ? TILE_SHADE.humanHand : TILE_SHADE.opponentHand,
        );
        expect(expected).toBeGreaterThan(0);
      } else {
        // Ponds, melds, dora, the wall: public and up-facing, fully lit.
        expect(expected, tile.id).toBe(0);
      }
    }
    // The three opponents take the same amount.
    const opponentAmounts = new Set(
      layout.foreground
        .filter((tile) => (tile.zone === 'hand' || tile.zone === 'draw') && tile.seat !== humanSeat)
        .map((tile) => instanceShade(tile, humanSeat)),
    );
    expect([...opponentAmounts]).toEqual([TILE_SHADE.opponentHand]);
    expect(TILE_SHADE.opponentHand).toBeGreaterThan(TILE_SHADE.humanHand);
  });

  it('packs the shade buffer and re-uploads it', () => {
    const packed = packBoardInstances(instances);
    expect(packed.shades).toHaveLength(instances.length);
    instances.forEach((instance, index) => {
      // Float32 storage, so compare with the precision it keeps.
      expect(packed.shades[index]).toBeCloseTo(instance.shade, 6);
    });
    expect(packed.shades.some((value) => value > 0)).toBe(true);

    const handle = createBoardMesh(instances, material());
    const attribute = handle.geometry.getAttribute('aShade') as InstancedBufferAttribute;
    expect(attribute.itemSize).toBe(1);
    const version = attribute.version;
    handle.sync(instances.slice(0, 5));
    expect(attribute.version).toBeGreaterThan(version);
    handle.dispose();
  });

  it('fails loudly on an over-capacity board or a bad matrix', () => {
    expect(() =>
      packBoardInstances(
        Array.from({ length: 3 }, (_, index) => instances[index]),
        2,
      ),
    ).toThrow(/exceeds the 2-instance capacity/);
    expect(() =>
      packBoardInstances([
        {
          ...instances[0],
          matrix: [Number.NaN, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        },
      ]),
    ).toThrow(/non-finite matrix/);
  });
});

describe('the board mesh', () => {
  it('is one instanced draw with the capacity reserved and the count live', () => {
    const handle = createBoardMesh(instances, material());
    expect(handle.mesh.isInstancedMesh).toBe(true);
    expect(handle.mesh.count).toBe(instances.length);
    expect(handle.mesh.instanceMatrix.count).toBe(BOARD_TILE_CAPACITY);
    expect(handle.mesh.name).toBe('board-tiles');
    expect(handle.mesh.frustumCulled).toBe(false);

    // Every attribute the carved shader declares exists on the geometry.
    for (const attribute of ['position', 'normal', 'uv', 'tangent', 'faceZone', 'aAtlasRect', 'aFlags']) {
      expect(handle.geometry.getAttribute(attribute), attribute).toBeDefined();
    }
    expect(handle.geometry.getIndex()).not.toBeNull();
    expect(handle.count).toBe(instances.length);
    handle.dispose();
  });

  it('re-uploads a snapshot in place, with no reallocation', () => {
    const handle = createBoardMesh(instances, material());
    const buffer = (handle.mesh.instanceMatrix.array as Float32Array).buffer;
    const flags = handle.geometry.getAttribute('aFlags') as InstancedBufferAttribute;
    const version = flags.version;

    // Drop the last ten tiles (a shorter river) and sync.
    const next = instances.slice(0, instances.length - 10);
    handle.sync(next);
    expect(handle.mesh.count).toBe(next.length);
    expect((handle.mesh.instanceMatrix.array as Float32Array).buffer).toBe(buffer);
    // Setting `needsUpdate` bumps the attribute's version; that is the signal
    // three uses to re-upload the instance buffer.
    expect(flags.version).toBeGreaterThan(version);
    expect(flags.count).toBe(BOARD_TILE_CAPACITY);
    handle.dispose();
  });
});
