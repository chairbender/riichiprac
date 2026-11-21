/**
 * The whole board as one instanced draw call (3D-07).
 *
 * 3D-06 publishes exact world poses for every tile; this module packs them into
 * the attribute layout 3D-05's carved shader expects and owns the single
 * `InstancedMesh` the scene draws. The board is *one* mesh regardless of state:
 * wall, ponds, hands, melds and dora indicators all share 3D-04's geometry,
 * 3D-05's material and one `instanceMatrix`, so the tile cost does not grow with
 * the number of tiles (§2.8).
 *
 * Per-instance attributes, and why each is where it is:
 *
 * - `instanceMatrix` (three's own): the packed column-major `poseMatrix`. Rigid
 *   by construction, so the shader can rotate the tangent basis with it.
 * - `aAtlasRect` (vec4 `u0, v0, u1, v1`): the face's cell in the committed
 *   albedo/normal/AO atlases (3D-03). A face-down tile gets the neutral rect
 *   because it never samples the atlas; it draws the blue back instead.
 * - `aFlags` (float bitfield, see {@link INSTANCE_FLAG}): face-up, highlighted
 *   and dimmed. One float rather than three attributes because the fragment
 *   stage only ever tests bits, and one float keeps the per-vertex footprint
 *   minimal at 320 instances.
 *
 * A per-instance atlas *page* is not needed in v1: the three atlases hold all 37
 * cells, so a tile only needs its rect. If a future bake ever splits the face
 * set across pages, this is where an `aAtlasPage` attribute would go.
 *
 * Nothing here reads `GameState` or the DOM, and no function in this module
 * needs a GPU context: `buildBoardInstances`/`packBoardInstances` are pure, so
 * the buffer invariants (finite matrices, inside the mat, exact multiset) are
 * asserted in Node by `boardMesh.test.ts`.
 */

import {
  BufferAttribute,
  BufferGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
} from 'three';
import type { TileFaceId } from '../contract';
import { TABLE } from '../layoutConstants';
import { poseMatrix } from './boardLayout';
import type { BoardLayout, BoardTile } from './boardLayout';
import { buildTileGeometry } from './tileGeometry';
import type { TileMaterialHandle } from './tileMaterial';

/**
 * The tile instance capacity (plan §6, 3D-07). Every legal snapshot is far
 * below it: a real game has 136 tiles, of which at most ~122 are outside the
 * wall, and the drawn wall is at most 70 live tiles plus the 14-tile dead wall
 * minus the dora indicators it covers, so ~300 is the honest ceiling. A snapshot
 * above the capacity is structurally illegal and fails loudly in
 * {@link packBoardInstances} rather than silently dropping tiles.
 */
export const BOARD_TILE_CAPACITY = 320;

/**
 * `aFlags` bits. `faceUp` selects the carved plate versus the blue back;
 * `highlighted` is the newest discard of a seat a call/ron offer names, and
 * `dimmed` is a tsumogiri discard. The two latter are *shading* flags the
 * fragment shader applies (see `TILE_HIGHLIGHT` in `tileMaterial.ts`).
 */
export const INSTANCE_FLAG = {
  faceUp: 1,
  highlighted: 2,
  dimmed: 4,
} as const;

/** A normalized atlas rect `[u0, v0, u1, v1]`. */
export type AtlasRect = readonly [number, number, number, number];

/** The rect a face with no baked art (or a face-down tile) declares. */
export const NEUTRAL_ATLAS_RECT: AtlasRect = [0, 0, 1, 1];

/** One tile instance, independent of three's classes. */
export interface BoardInstance {
  /** The layout tile's stable id, for tests and diffs. */
  readonly id: string;
  /** The physical tile's identity across snapshots (261121-1206). */
  readonly uid: string;
  /** Column-major 4 x 4, as {@link poseMatrix} publishes it. */
  readonly matrix: readonly number[];
  readonly atlasRect: AtlasRect;
  readonly flags: number;
  /** The face the instance shows, kept for the highlight/atlas probes. */
  readonly face: TileFaceId;
}

/** The packed buffers one draw reads; every array has `count` entries. */
export interface BoardBuffers {
  readonly count: number;
  /** `count * 16` floats, column-major. */
  readonly matrices: Float32Array;
  /** `count * 4` floats. */
  readonly atlasRects: Float32Array;
  /** `count` floats. */
  readonly flags: Float32Array;
}

/** The `aFlags` word for one layout tile. */
export function instanceFlags(tile: {
  readonly faceUp: boolean;
  readonly highlighted: boolean;
  readonly dimmed: boolean;
}): number {
  return (
    (tile.faceUp ? INSTANCE_FLAG.faceUp : 0) |
    (tile.highlighted ? INSTANCE_FLAG.highlighted : 0) |
    (tile.dimmed ? INSTANCE_FLAG.dimmed : 0)
  );
}

/**
 * Build one instance per layout tile, resolving each face-up tile's atlas cell.
 *
 * The order is the layout's own authoring order, which is stable for a snapshot
 * (wall, dora, then each seat's hand, draw, melds and river), so a re-sync of the
 * same snapshot produces identical buffers and no visible change.
 */
export function buildBoardInstances(
  layout: BoardLayout,
  cellForFace: (face: TileFaceId) => { readonly rect: AtlasRect } | null,
): readonly BoardInstance[] {
  return layout.tiles.map((tile) => instanceFor(tile, cellForFace));
}

function instanceFor(
  tile: BoardTile,
  cellForFace: (face: TileFaceId) => { readonly rect: AtlasRect } | null,
): BoardInstance {
  return {
    id: tile.id,
    uid: tile.uid,
    matrix: poseMatrix(tile.pose),
    // A face-down tile never samples the atlas; the neutral rect keeps the
    // attribute buffer uniform without inventing art.
    atlasRect: tile.faceUp
      ? (cellForFace(tile.face)?.rect ?? NEUTRAL_ATLAS_RECT)
      : NEUTRAL_ATLAS_RECT,
    flags: instanceFlags(tile),
    face: tile.face,
  };
}

/**
 * Pack instances into the three attribute arrays.
 *
 * @throws when there are more instances than {@link BOARD_TILE_CAPACITY}, or
 *   when any matrix/rect entry is not finite. Both are structural faults (an
 *   overlapping or NaN tile cannot be drawn honestly), so they fail here rather
 *   than reaching the GPU as a silently broken board.
 */
export function packBoardInstances(
  instances: readonly BoardInstance[],
  capacity: number = BOARD_TILE_CAPACITY,
): BoardBuffers {
  if (instances.length > capacity) {
    throw new Error(
      `3D board mesh: ${instances.length} tiles exceeds the ${capacity}-instance capacity`,
    );
  }
  const count = instances.length;
  const matrices = new Float32Array(count * 16);
  const atlasRects = new Float32Array(count * 4);
  const flags = new Float32Array(count);
  instances.forEach((instance, index) => {
    if (instance.matrix.length !== 16) {
      throw new Error(
        `3D board mesh: instance ${instance.id} has a ${instance.matrix.length}-element matrix`,
      );
    }
    for (const value of instance.matrix) {
      if (!Number.isFinite(value)) {
        throw new Error(`3D board mesh: instance ${instance.id} has a non-finite matrix`);
      }
    }
    matrices.set(instance.matrix, index * 16);
    atlasRects.set(instance.atlasRect, index * 4);
    flags[index] = instance.flags;
  });
  return { count, matrices, atlasRects, flags };
}

/** The live board mesh and the buffers it re-uploads on a snapshot change. */
export interface BoardMeshHandle {
  readonly mesh: InstancedMesh;
  readonly geometry: BufferGeometry;
  /** Live instance count (what `measure()` reports). */
  readonly count: number;
  /** Replace every instance; O(tiles), no reallocation. */
  sync(instances: readonly BoardInstance[]): void;
  dispose(): void;
}

/**
 * Build the board's geometry from 3D-04's data, with the attributes the shader
 * declares. One geometry per mesh: the instanced attributes live on it.
 */
export function createTileGeometry(): BufferGeometry {
  const data = buildTileGeometry();
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(data.normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(data.uvs, 2));
  geometry.setAttribute('tangent', new BufferAttribute(data.tangents, 4));
  geometry.setAttribute('faceZone', new BufferAttribute(data.faceZone, 1));
  geometry.setIndex(new BufferAttribute(data.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Opaque tiles draw before the transparent shadow layer (see `shadows.ts`). */
export const BOARD_TILES_RENDER_ORDER = 0;

/**
 * Build the single board draw. The mesh is allocated at the capacity once, so a
 * new snapshot only rewrites buffers (`sync`); nothing is reallocated per deal.
 */
export function createBoardMesh(
  instances: readonly BoardInstance[],
  material: TileMaterialHandle,
  capacity: number = BOARD_TILE_CAPACITY,
): BoardMeshHandle {
  const geometry = createTileGeometry();
  const buffers = packBoardInstances(instances, capacity);
  const mesh = new InstancedMesh(geometry, material.material, capacity);
  mesh.name = 'board-tiles';
  mesh.renderOrder = BOARD_TILES_RENDER_ORDER;
  // Every instance has its own transform; the geometry's bounding sphere says
  // nothing about where they are, so culling would drop visible tiles.
  mesh.frustumCulled = false;

  const atlasRects = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  const flags = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  (atlasRects.array as Float32Array).set(buffers.atlasRects);
  (flags.array as Float32Array).set(buffers.flags);
  geometry.setAttribute('aAtlasRect', atlasRects);
  geometry.setAttribute('aFlags', flags);

  const matrix = new Matrix4();
  for (let index = 0; index < buffers.count; index += 1) {
    matrix.fromArray(buffers.matrices, index * 16);
    mesh.setMatrixAt(index, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.count = buffers.count;

  const handle: BoardMeshHandle = {
    mesh,
    geometry,
    get count() {
      return mesh.count;
    },
    sync(next: readonly BoardInstance[]) {
      const packed = packBoardInstances(next, capacity);
      const target = mesh.instanceMatrix.array as Float32Array;
      target.set(packed.matrices);
      (atlasRects.array as Float32Array).set(packed.atlasRects);
      (flags.array as Float32Array).set(packed.flags);
      mesh.instanceMatrix.needsUpdate = true;
      atlasRects.needsUpdate = true;
      flags.needsUpdate = true;
      mesh.count = packed.count;
    },
    dispose() {
      geometry.dispose();
    },
  };
  return handle;
}

/** The mat's world bounds, as the instance assertion uses them. */
export const MAT_BOUNDS_UNITS = TABLE.matSizeUnits / 2;
