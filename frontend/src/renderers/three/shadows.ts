/**
 * The board's contact-shadow layer (3D-07): one instanced quad draw.
 *
 * Every grounded tile gets a single soft quad on the felt, scaled to that tile's
 * own footprint and padded by a fixed amount so the shadow bleeds out from under
 * the body as a contact rim. 3D-04/3D-05 bake a tile's *shape* shadow into the
 * shell for the 2.5D pipeline; true 3D needs the opposite: a flat, procedural
 * blob whose darkness is a property of the table, not of the tile atlas.
 *
 * Four rules, each of which a test asserts numerically:
 *
 * 1. **One draw.** All quads share one `PlaneGeometry`, one material and one
 *    alpha texture, so the layer is a single `InstancedMesh`.
 * 2. **Depth-tested, depth-write off.** The quads are transparent black; three
 *    draws them in the transparent pass, after every opaque tile, and the depth
 *    test rejects a fragment wherever a tile body is nearer to the camera. A
 *    shadow therefore never overdraws a tile body — its own tile or a
 *    neighbour's — while still darkening the felt and the 0.3 mm grooves.
 *    `depthWrite: false` keeps it from occluding anything behind it.
 * 3. **Under the body, on the felt.** The quad plane sits at
 *    {@link SHADOW.liftUnits} above the felt (a fraction of a millimetre), i.e.
 *    below every tile's top surface, and it is only emitted for tiles whose
 *    lowest body point is on the felt. Wall top-tier tiles (whose contact is the
 *    tile beneath them, not the cloth) are excluded.
 * 4. **Procedural, no asset.** The alpha is a rounded rectangle with a smooth
 *    feather, generated in code from a pure function ({@link shadowAlphaPixels})
 *    into a `DataTexture`, so it is deterministic, testable in Node and adds no
 *    committed texture.
 *
 * The shadow's footprint is the tile's oriented box projected onto the ground:
 * every layout yaw is a multiple of 90°, so that projection is axis-aligned and
 * equals the rotated footprint exactly.
 */

import {
  DataTexture,
  DoubleSide,
  InstancedMesh,
  MeshBasicMaterial,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  RGBAFormat,
  Vector3,
} from 'three';
import { BOARD_TILE_CAPACITY } from './boardMesh';
import { orientedBox } from './boardLayout';
import type { BoardLayout, BoardTile, Vec3 } from './boardLayout';

/** The contact-shadow layer's committed numbers. */
export const SHADOW = {
  /** Quad plane height above the felt, in tile units (0.42 mm). */
  liftUnits: 0.015,
  /** Extra footprint per side, in tile units (3.4 mm), so a contact rim shows. */
  paddingUnits: 0.12,
  /** A tile counts as grounded when its lowest point is within this of the felt. */
  groundToleranceUnits: 0.02,
  /** Corner radius, as a fraction of the quad's half-extent. */
  cornerFraction: 0.35,
  /** Layer opacity at the centre of the blob. */
  opacity: 0.55,
  /** The alpha texture's edge, in texels. */
  textureSize: 64,
  /** One quad per grounded tile; the tile capacity is the honest ceiling. */
  capacity: BOARD_TILE_CAPACITY,
} as const;

/** One contact quad, in world space. */
export interface ShadowInstance {
  /** The tile it belongs to. */
  readonly id: string;
  /** Quad centre: on the felt, at {@link SHADOW.liftUnits}. */
  readonly centre: Vec3;
  /** Full extents along world X and Z. */
  readonly sizeUnits: readonly [number, number];
  /** Column-major 4 x 4, ready for `InstancedMesh.setMatrixAt`. */
  readonly matrix: readonly number[];
}

/** The lowest point of a tile's oriented box, in world Y units. */
export function tileLowestY(tile: BoardTile): number {
  const box = orientedBox(tile.pose);
  const [ax, ay, az] = box.axes;
  const [hx, hy, hz] = box.halfExtents;
  return (
    box.centre[1] -
    (Math.abs(ax[1]) * hx + Math.abs(ay[1]) * hy + Math.abs(az[1]) * hz)
  );
}

/** The tile's footprint on the ground: full world-X and world-Z extents. */
export function tileFootprint(tile: BoardTile): readonly [number, number] {
  const box = orientedBox(tile.pose);
  const [ax, ay, az] = box.axes;
  const [hx, hy, hz] = box.halfExtents;
  const extentX = Math.abs(ax[0]) * hx + Math.abs(ay[0]) * hy + Math.abs(az[0]) * hz;
  const extentZ = Math.abs(ax[2]) * hx + Math.abs(ay[2]) * hy + Math.abs(az[2]) * hz;
  return [extentX * 2, extentZ * 2];
}

/** Is the tile resting on the felt (rather than on another tile)? */
export function isGrounded(tile: BoardTile): boolean {
  return tileLowestY(tile) <= SHADOW.groundToleranceUnits;
}

const GROUND_QUATERNION = new Quaternion().setFromAxisAngle(
  new Vector3(1, 0, 0),
  -Math.PI / 2,
);

/** The quad's model matrix: a flat plane, scaled to the footprint. */
export function shadowMatrix(
  centre: Vec3,
  sizeUnits: readonly [number, number],
): readonly number[] {
  const matrix = new Matrix4().compose(
    new Vector3(centre[0], centre[1], centre[2]),
    GROUND_QUATERNION,
    new Vector3(sizeUnits[0], sizeUnits[1], 1),
  );
  return matrix.toArray();
}

/**
 * One quad per grounded tile, anchored under the body and padded by
 * {@link SHADOW.paddingUnits} per side.
 */
export function shadowInstances(layout: BoardLayout): readonly ShadowInstance[] {
  const instances: ShadowInstance[] = [];
  for (const tile of layout.tiles) {
    if (!isGrounded(tile)) continue;
    const footprint = tileFootprint(tile);
    const sizeUnits: readonly [number, number] = [
      footprint[0] + SHADOW.paddingUnits * 2,
      footprint[1] + SHADOW.paddingUnits * 2,
    ];
    const centre: Vec3 = [
      tile.pose.position[0],
      SHADOW.liftUnits,
      tile.pose.position[2],
    ];
    instances.push({
      id: tile.id,
      centre,
      sizeUnits,
      matrix: shadowMatrix(centre, sizeUnits),
    });
  }
  if (instances.length > SHADOW.capacity) {
    throw new Error(
      `3D shadows: ${instances.length} grounded tiles exceed the ${SHADOW.capacity}-quad capacity`,
    );
  }
  return instances;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * One texel's alpha: a rounded rectangle with a smooth feather.
 *
 * Coordinates are normalized to `[-1, 1]` across the quad. The rect's straight
 * edges sit at `1 - cornerFraction` and the corners round from there, so the
 * alpha is 1 across the middle, eases to 0 over the corner radius and is exactly
 * 0 at every edge. Pure: same size, same bytes.
 */
export function shadowAlphaAt(u: number, v: number): number {
  const nx = Math.abs(u * 2 - 1);
  const ny = Math.abs(v * 2 - 1);
  const radius = SHADOW.cornerFraction;
  const dx = Math.max(nx - (1 - radius), 0);
  const dy = Math.max(ny - (1 - radius), 0);
  const distance = Math.hypot(dx, dy);
  const t = clamp01(1 - distance / radius);
  return t * t * (3 - 2 * t);
}

/** The whole RGBA alpha texture, top row first. */
export function shadowAlphaPixels(size: number = SHADOW.textureSize): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const alpha = Math.round(shadowAlphaAt((x + 0.5) / size, (y + 0.5) / size) * 255);
      const index = (y * size + x) * 4;
      // Black, with the blob in alpha: the material supplies the tint and the
      // opacity, so the same texture serves any future contact-darkness change.
      pixels[index] = 0;
      pixels[index + 1] = 0;
      pixels[index + 2] = 0;
      pixels[index + 3] = alpha;
    }
  }
  return pixels;
}

/** The live contact layer. */
export interface ShadowLayer {
  readonly mesh: InstancedMesh;
  /** Live quad count. */
  readonly count: number;
  sync(instances: readonly ShadowInstance[]): void;
  dispose(): void;
}

/** Build the layer's one instanced draw. */
export function createShadowLayer(
  instances: readonly ShadowInstance[],
  capacity: number = SHADOW.capacity,
): ShadowLayer {
  const geometry = new PlaneGeometry(1, 1, 1, 1);
  const texture = new DataTexture(
    shadowAlphaPixels(),
    SHADOW.textureSize,
    SHADOW.textureSize,
    RGBAFormat,
  );
  texture.needsUpdate = true;
  const material = new MeshBasicMaterial({
    name: 'contact-shadow',
    color: 0x000000,
    map: texture,
    transparent: true,
    opacity: SHADOW.opacity,
    // Rule 2: depth-tested, never depth-writing, and drawn after the opaque
    // tiles (transparent pass) so a tile body always wins the depth test.
    depthTest: true,
    depthWrite: false,
    // The plane faces +Y; a double-sided material keeps the blob correct if a
    // future camera ever drops below the felt plane.
    side: DoubleSide,
  });
  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.name = 'contact-shadows';
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;

  const matrix = new Matrix4();
  const write = (next: readonly ShadowInstance[]): void => {
    if (next.length > capacity) {
      throw new Error(
        `3D shadows: ${next.length} quads exceed the ${capacity}-quad capacity`,
      );
    }
    next.forEach((instance, index) => {
      matrix.fromArray(instance.matrix as number[]);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.count = next.length;
  };
  write(instances);

  return {
    mesh,
    get count() {
      return mesh.count;
    },
    sync: write,
    dispose() {
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}
