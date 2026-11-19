/**
 * The riichi sticks (3D-07, remodelled in 3D-09): one instanced draw for the
 * point sticks standing on the compass plate.
 *
 * **The model.** A 1000-point stick is a polystyrene bar: 65 mm long, 7 mm wide
 * and 3.5 mm thick, with 0.4 mm round-overs along its long edges, a painted red
 * pip in the middle, and a soft sheen. That is the user's spec (2026-11-19) and
 * the shape the score sprite shows (`components/RiichiStick.tsx`): a stadium
 * (semicircular ends), a rounded top edge, one red dot, no end bands. A 3D box
 * with a texture on it is not that shape, which is why this is a capsule
 * extruded from a `Shape` in core three (no addons) with a bevel on both faces.
 *
 * **The pip is carved, not printed.** The red centre is a painted recess: the
 * albedo, tangent normal, cavity and roughness come from
 * `stickMaps.ts`, the same albedo + paint + normal + cavity model the tiles use
 * for their engraving (3D-05). The atlas puts the face on the top half and a
 * plain ivory wall on the bottom half, so one material and one instanced draw
 * cover the whole bar.
 *
 * A stick is table furniture, not a tile, so it is not part of the board's tile
 * `InstancedMesh` (3D-06 keeps them in `layout.sticks` and the collision gate
 * skips them).
 */

import {
  DataTexture,
  ExtrudeGeometry,
  InstancedMesh,
  Matrix4,
  MeshPhysicalMaterial,
  Quaternion,
  RGBAFormat,
  Shape,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { STICK as STICK_LAYOUT, UNIT_MM } from '../layoutConstants';
import type { BoardStick } from './boardLayout';
import {
  STICK_CARVE,
  stickAlbedoPixels,
  stickNormalPixels,
  stickRoughnessPixels,
} from './stickMaps';

/** The stick layer's committed numbers. */
export const STICK = {
  /** The visible point sticks; a hand rarely has more than a few on the table. */
  capacity: 32,
  /**
   * The round-over on every long edge: the user's 0.4 mm. `ExtrudeGeometry`
   * grows the outline by the bevel, so the shape is authored inset and the
   * finished bar measures the layout's exact 65 x 3.5 x 7 mm.
   */
  bevelUnits: 0.4 / UNIT_MM,
  bevelSegments: 5,
  curveSegments: 16,
  /** Polystyrene under the key light: a satin body with a lacquered clear coat. */
  roughness: 0.24,
  metalness: 0,
  clearcoat: 0.5,
  clearcoatRoughness: 0.07,
  /** Polystyrene's index of refraction (the model is a solid resin bar). */
  ior: 1.59,
} as const;

/** The bar's dimensions, from the layout so the gate and the mesh agree. */
export const STICK_SIZE = {
  lengthUnits: STICK_LAYOUT.lengthUnits,
  widthUnits: STICK_LAYOUT.widthUnits,
  heightUnits: STICK_LAYOUT.heightUnits,
} as const;

/**
 * A stadium outline: the plan view of a point stick, with semicircular ends.
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
 * The cap is UV-mapped onto the top half of the carve atlas (u along the bar,
 * v across it) so the pip sits in the middle; the rounded side wall maps onto
 * the atlas's plain-ivory bottom half. Both UVs vary across each surface, which
 * keeps the tangent-space normal map well-conditioned everywhere.
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

  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const uv = geometry.getAttribute('uv');
  const halfLength = STICK_SIZE.lengthUnits / 2;
  const halfWidth = STICK_SIZE.widthUnits / 2;
  for (let index = 0; index < uv.count; index += 1) {
    const u = (position.getX(index) + halfLength) / STICK_SIZE.lengthUnits;
    const v = (position.getZ(index) + halfWidth) / STICK_SIZE.widthUnits;
    if (Math.abs(normal.getY(index)) > 0.9) {
      // The printed face: the atlas's top half, u along the bar.
      uv.setXY(index, u, v * STICK_CARVE.capUvMaxV);
    } else {
      // The rounded wall: a varying u keeps the normal-map tangent defined,
      // while v stays inside the plain-ivory half of the atlas.
      uv.setXY(index, (u + v) / 2, STICK_CARVE.sideUv);
    }
  }
  uv.needsUpdate = true;

  return geometry;
}

/** Make a data texture with the right colour space and filtering. */
function makeTexture(
  pixels: Uint8Array,
  colorSpace: typeof SRGBColorSpace | '',
): DataTexture {
  const texture = new DataTexture(
    pixels,
    STICK_CARVE.textureWidth,
    STICK_CARVE.textureHeight,
    RGBAFormat,
  );
  if (colorSpace !== '') texture.colorSpace = colorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Build the one instanced stick draw for a list of placed sticks. */
export function createStickMesh(
  sticks: readonly BoardStick[],
  capacity: number = STICK.capacity,
): StickMesh {
  const geometry = createStickGeometry();
  const albedo = makeTexture(stickAlbedoPixels(), SRGBColorSpace);
  const normalMap = makeTexture(stickNormalPixels(), '');
  const roughnessMap = makeTexture(stickRoughnessPixels(), '');
  const material = new MeshPhysicalMaterial({
    name: 'riichi-stick',
    map: albedo,
    normalMap,
    roughnessMap,
    // The maps carry the values; the material's scalar is the multiplier.
    roughness: 1,
    metalness: STICK.metalness,
    clearcoat: STICK.clearcoat,
    clearcoatRoughness: STICK.clearcoatRoughness,
    ior: STICK.ior,
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
      albedo.dispose();
      normalMap.dispose();
      roughnessMap.dispose();
    },
  };
}
