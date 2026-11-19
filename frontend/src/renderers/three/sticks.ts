/**
 * The riichi sticks (3D-07): one instanced draw for the point sticks on the felt.
 *
 * A stick is table furniture, not a tile, so it is not part of the board's tile
 * `InstancedMesh` (3D-06 keeps them in `layout.sticks` and the collision gate
 * skips them). It is still a single draw: one unit box, one instanced mesh, one
 * procedural texture — a 1000-point stick is an ivory bar with one red dot, and
 * that dot is the only detail worth drawing at this size.
 *
 * The texture is generated in code (`stickTexturePixels`) for the same reasons
 * as the felt and the contact shadow: no new committed asset, deterministic
 * bytes, and a Node test can assert the dot's colour and position without a GPU.
 */

import {
  BoxGeometry,
  DataTexture,
  InstancedMesh,
  MeshStandardMaterial,
  Matrix4,
  Quaternion,
  RGBAFormat,
  SRGBColorSpace,
  Vector3,
} from 'three';
import type { BoardStick } from './boardLayout';

/** The stick layer's committed numbers. */
export const STICK = {
  /** The visible point sticks; a hand rarely has more than a few on the table. */
  capacity: 32,
  /** Procedural face texture, in texels. A 3:1-ish bar reads the dot at any size. */
  textureWidth: 64,
  textureHeight: 16,
  /** The dot's radius, as a fraction of the texture height. */
  dotFraction: 0.28,
  /** Ivory bar (`#f6f1e8`) and the point stick's red dot (`#c0392b`). */
  ivoryRgb: [246, 241, 232] as const,
  dotRgb: [192, 57, 43] as const,
  /** Solid plastic, not lacquer: a matte body with a hint of sheen. */
  roughness: 0.42,
  metalness: 0,
} as const;

/**
 * The stick's face texture: an ivory bar with one red disc in the middle.
 *
 * Pure and deterministic, so `sticks.test.ts` can assert the dot (red at the
 * centre) and the bar (ivory at the ends) as numbers.
 */
export function stickTexturePixels(
  width: number = STICK.textureWidth,
  height: number = STICK.textureHeight,
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  const centreX = width / 2;
  const centreY = height / 2;
  const radius = height * STICK.dotFraction;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x + 0.5 - centreX;
      const dy = y + 0.5 - centreY;
      const inDot = Math.hypot(dx, dy) <= radius;
      const rgb = inDot ? STICK.dotRgb : STICK.ivoryRgb;
      const index = (y * width + x) * 4;
      pixels[index] = rgb[0];
      pixels[index + 1] = rgb[1];
      pixels[index + 2] = rgb[2];
      pixels[index + 3] = 255;
    }
  }
  return pixels;
}

/** The live stick layer. */
export interface StickMesh {
  readonly mesh: InstancedMesh;
  /** Live stick count. */
  readonly count: number;
  sync(sticks: readonly BoardStick[]): void;
  dispose(): void;
}

const IDENTITY_QUATERNION = new Quaternion();

/** Build the one instanced stick draw for a list of placed sticks. */
export function createStickMesh(
  sticks: readonly BoardStick[],
  capacity: number = STICK.capacity,
): StickMesh {
  const geometry = new BoxGeometry(1, 1, 1);
  const texture = new DataTexture(
    stickTexturePixels(),
    STICK.textureWidth,
    STICK.textureHeight,
    RGBAFormat,
  );
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  const material = new MeshStandardMaterial({
    name: 'riichi-stick',
    map: texture,
    roughness: STICK.roughness,
    metalness: STICK.metalness,
  });
  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.name = 'riichi-sticks';
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;

  const matrix = new Matrix4();
  const write = (next: readonly BoardStick[]): void => {
    if (next.length > capacity) {
      throw new Error(
        `3D sticks: ${next.length} sticks exceed the ${capacity}-stick capacity`,
      );
    }
    next.forEach((stick, index) => {
      matrix.compose(
        new Vector3(stick.position[0], stick.position[1], stick.position[2]),
        IDENTITY_QUATERNION,
        new Vector3(stick.sizeUnits[0], stick.sizeUnits[1], stick.sizeUnits[2]),
      );
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.count = next.length;
  };
  write(sticks);

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
