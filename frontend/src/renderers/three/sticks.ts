/**
 * The riichi sticks (3D-07, remodelled in 3D-09): one instanced draw for the
 * point sticks standing on the compass plate.
 *
 * **The model.** A 1000-point stick is a rounded, injection-moulded bar: a
 * stadium (semicircular ends), a softly rounded top edge, a white body, a grey
 * band near each end and a red dot in the middle. The sprites next to every
 * score (`components/RiichiStick.tsx`) are the reference this mesh reproduces:
 * the same 100:24 proportions for the end bands (8–15 % and 85–92 % of the
 * length) and the same colours (`#f8f9fa` body, `#adb5bd` bands, `#e03131` dot).
 * A 3D box with a texture on it is not that shape, which is why this is a
 * capsule extruded from a `Shape` in core three (no addons) rather than a
 * `BoxGeometry`.
 *
 * The texture is generated in code (`stickTexturePixels`) for the same reasons
 * as the felt and the contact shadow: no new committed asset, deterministic
 * bytes, and a Node test can assert the dot, the bands and the colours without
 * a GPU. Only the top face samples it; the rounded side wall is plain ivory.
 *
 * A stick is table furniture, not a tile, so it is not part of the board's tile
 * `InstancedMesh` (3D-06 keeps them in `layout.sticks` and the collision gate
 * skips them). It is still a single draw: one shared capsule geometry, one
 * instanced mesh, one procedural texture.
 */

import {
  DataTexture,
  ExtrudeGeometry,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  RGBAFormat,
  Shape,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { STICK as STICK_LAYOUT } from '../layoutConstants';
import type { BoardStick } from './boardLayout';

/** The stick layer's committed numbers (the size itself is the layout's). */
export const STICK = {
  /** The visible point sticks; a hand rarely has more than a few on the table. */
  capacity: 32,
  /** Procedural face texture, in texels. */
  textureWidth: 256,
  textureHeight: 64,
  /**
   * The red dot's radius: 21 % of the bar's width, the sprite's own proportion
   * (`r = 5` on a 24-high viewBox).
   */
  dotRadiusUnits: STICK_LAYOUT.widthUnits * 0.21,
  /** The grey end bands, as fractions of the length (the sprite's 8..15 %). */
  bandStartFraction: 0.08,
  bandEndFraction: 0.15,
  /** White body, grey bands, red dot: the sprite's own palette. */
  ivoryRgb: [248, 249, 250] as const,
  bandRgb: [173, 181, 189] as const,
  dotRgb: [224, 49, 49] as const,
  /** Soft moulded plastic: a matte body with a gentle sheen. */
  roughness: 0.38,
  metalness: 0,
  /**
   * The round-over of the top and bottom edges, in units. The bevel grows the
   * outline by the same amount, so the shape is authored inset by it and the
   * finished bar is exactly the layout's width/length/height.
   */
  bevelUnits: 0.02,
  bevelSegments: 3,
  curveSegments: 12,
} as const;

/** The bar's dimensions, from the layout so the gate and the mesh agree. */
export const STICK_SIZE = {
  lengthUnits: STICK_LAYOUT.lengthUnits,
  widthUnits: STICK_LAYOUT.widthUnits,
  heightUnits: STICK_LAYOUT.heightUnits,
} as const;

/**
 * A stadium outline: the side profile of a point stick, with semicircular ends.
 *
 * Authored inset by the bevel, because `ExtrudeGeometry` grows an outline by
 * `bevelSize` on every side; the finished bar therefore measures exactly
 * {@link STICK_SIZE}.
 */
export function stickShape(
  lengthUnits: number = STICK_SIZE.lengthUnits - 2 * STICK.bevelUnits,
  widthUnits: number = STICK_SIZE.widthUnits - 2 * STICK.bevelUnits,
): Shape {
  const halfLength = lengthUnits / 2;
  const halfWidth = widthUnits / 2;
  const radius = Math.min(halfWidth, halfLength);
  const shape = new Shape();
  shape.moveTo(-halfLength + radius, -halfWidth);
  shape.lineTo(halfLength - radius, -halfWidth);
  shape.quadraticCurveTo(halfLength, -halfWidth, halfLength, -halfWidth + radius);
  shape.lineTo(halfLength, halfWidth - radius);
  shape.quadraticCurveTo(halfLength, halfWidth, halfLength - radius, halfWidth);
  shape.lineTo(-halfLength + radius, halfWidth);
  shape.quadraticCurveTo(-halfLength, halfWidth, -halfLength, halfWidth - radius);
  shape.lineTo(-halfLength, -halfWidth + radius);
  shape.quadraticCurveTo(-halfLength, -halfWidth, -halfLength + radius, -halfWidth);
  return shape;
}

/**
 * The stick's face texture: a white bar with a grey band near each end and a
 * red disc in the middle, exactly the sprite's layout.
 *
 * Pure and deterministic, so `sticks.test.ts` can assert the dot (red at the
 * centre), the bands (grey at 8–15 % and 85–92 %) and the body (white between
 * them) as numbers. The dot's texel radii differ per axis so that its footprint
 * is a **circle in world space** on a bar that is much longer than it is wide.
 */
export function stickTexturePixels(
  width: number = STICK.textureWidth,
  height: number = STICK.textureHeight,
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  const centreX = width / 2;
  const centreY = height / 2;
  const dotRadiusX = (STICK.dotRadiusUnits / STICK_SIZE.lengthUnits) * width;
  const dotRadiusY = (STICK.dotRadiusUnits / STICK_SIZE.widthUnits) * height;
  const bandStart = STICK.bandStartFraction * width;
  const bandEnd = STICK.bandEndFraction * width;
  const bandEndStart = (1 - STICK.bandEndFraction) * width;
  const bandEndFinish = (1 - STICK.bandStartFraction) * width;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = (x + 0.5 - centreX) / dotRadiusX;
      const dy = (y + 0.5 - centreY) / dotRadiusY;
      const inDot = dx * dx + dy * dy <= 1;
      const centre = x + 0.5;
      const inBand =
        (centre >= bandStart && centre < bandEnd) ||
        (centre >= bandEndStart && centre < bandEndFinish);
      const rgb = inDot
        ? STICK.dotRgb
        : inBand
          ? STICK.bandRgb
          : STICK.ivoryRgb;
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

const UP_AXIS = new Vector3(0, 1, 0);
const ONE = new Vector3(1, 1, 1);
const DEG = Math.PI / 180;

/**
 * The shared capsule geometry: a stadium extruded to the bar's height, turned
 * flat, with its centre at the origin and its long axis along +X.
 *
 * The top/bottom faces sample the full face texture; the rounded side wall
 * samples a plain ivory texel, because the sprite's decoration is printed on
 * the face, not wrapped around the edge.
 */
export function createStickGeometry(): ExtrudeGeometry {
  const geometry = new ExtrudeGeometry(stickShape(), {
    depth: STICK_SIZE.heightUnits - 2 * STICK.bevelUnits,
    bevelEnabled: true,
    bevelThickness: STICK.bevelUnits,
    bevelSize: STICK.bevelUnits,
    bevelSegments: STICK.bevelSegments,
    curveSegments: STICK.curveSegments,
  });
  // The shape is authored in XY and extruded along +Z: lay it on the table.
  geometry.rotateX(-Math.PI / 2);
  geometry.computeBoundingBox();

  // Centre the body on the origin, so an instance's position is its centre.
  const box = geometry.boundingBox;
  if (box) {
    geometry.translate(
      -(box.min.x + box.max.x) / 2,
      -(box.min.y + box.max.y) / 2,
      -(box.min.z + box.max.z) / 2,
    );
  }

  // Rewrite the UVs: the caps map the face texture along the bar, the side
  // wall samples one ivory texel.
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const uv = geometry.getAttribute('uv');
  const halfLength = STICK_SIZE.lengthUnits / 2;
  const halfWidth = STICK_SIZE.widthUnits / 2;
  for (let index = 0; index < uv.count; index += 1) {
    const isCap = Math.abs(normal.getY(index)) > 0.9;
    if (isCap) {
      uv.setXY(
        index,
        (position.getX(index) + halfLength) / STICK_SIZE.lengthUnits,
        (position.getZ(index) + halfWidth) / STICK_SIZE.widthUnits,
      );
    } else {
      // A plain ivory texel: u between the band and the dot, mid-bar.
      uv.setXY(index, 0.3, 0.5);
    }
  }
  uv.needsUpdate = true;

  return geometry;
}

/** Build the one instanced stick draw for a list of placed sticks. */
export function createStickMesh(
  sticks: readonly BoardStick[],
  capacity: number = STICK.capacity,
): StickMesh {
  const geometry = createStickGeometry();
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
  const quaternion = new Quaternion();
  const write = (next: readonly BoardStick[]): void => {
    if (next.length > capacity) {
      throw new Error(
        `3D sticks: ${next.length} sticks exceed the ${capacity}-stick capacity`,
      );
    }
    next.forEach((stick, index) => {
      // The geometry is authored at full size along +X; its seat's yaw turns it
      // lengthways along that player's own edge of the compass (3D-09).
      quaternion.setFromAxisAngle(UP_AXIS, stick.yawDeg * DEG);
      matrix.compose(
        new Vector3(stick.position[0], stick.position[1], stick.position[2]),
        quaternion,
        ONE,
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
