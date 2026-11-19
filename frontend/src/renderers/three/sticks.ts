/**
 * The riichi sticks (3D-07, remodelled in 3D-09): one instanced draw for the
 * point sticks standing on the compass plate.
 *
 * **The model.** A 1000-point stick is a polystyrene bar: 65 mm long, 7 mm wide
 * and 3.5 mm thick, with a painted red pip in the middle and a soft sheen. The
 * user's last shape note (2026-11-19) is the one that decides the form: "looking
 * at the stick from the long end, the cross-sectional profile of the stick
 * should be an ellipse." The bar is therefore a **swept ellipse** — every
 * cross-section is a 7 × 3.5 mm ellipse (uniformly scaled toward the rounded
 * plan ends, which follow the score sprite's semicircles) — not an extrusion
 * with a bevel, which has flat faces and a sharp-ish edge. That ellipse is what
 * gives the continuous round on the long edges.
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
  BufferGeometry,
  DataTexture,
  Float32BufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshPhysicalMaterial,
  Quaternion,
  RGBAFormat,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { STICK as STICK_LAYOUT } from '../layoutConstants';
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
  /** Rings around the elliptical cross-section (smooth shading). */
  aroundSegments: 40,
  /** Rings along the straight middle of the bar. */
  straightSegments: 24,
  /** Rings in each rounded plan end. */
  capSegments: 12,
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
 * The shared bar geometry: an elliptical cross-section swept along the length,
 * with semicircular *plan* ends (the sprite's outline).
 *
 * Every cross-section is the same 7 x 3.5 mm ellipse (the end caps scale it
 * uniformly to a point), which is the user's "looking at the stick from the
 * long end, the cross-sectional profile … should be an ellipse". No bevel is
 * involved: the ellipse is the edge.
 *
 * UVs are the plan projection — `u` along the bar, `v` across it — so the pip
 * sits at the top's centre (both ends of the ellipse map to the plain ivory
 * border of the atlas).
 */
export function createStickGeometry(): BufferGeometry {
  const length = STICK_SIZE.lengthUnits;
  const width = STICK_SIZE.widthUnits;
  const height = STICK_SIZE.heightUnits;
  const semiWidth = width / 2;
  const semiHeight = height / 2;
  const endRadius = semiWidth;
  const straightHalf = length / 2 - endRadius;

  // Rings along the bar: two rounded plan ends and the straight middle. Each
  // carries its longitudinal position and a uniform scale of the cross-section
  // (1 in the middle, 0 at the tips). The s = 0 rings are replaced by poles.
  const rings: { x: number; scale: number }[] = [];
  for (let i = STICK.capSegments - 1; i >= 1; i -= 1) {
    const phi = (i / STICK.capSegments) * (Math.PI / 2);
    rings.push({
      x: -(straightHalf + endRadius * Math.sin(phi)),
      scale: Math.cos(phi),
    });
  }
  for (let i = 0; i <= STICK.straightSegments; i += 1) {
    rings.push({
      x: -straightHalf + (2 * straightHalf * i) / STICK.straightSegments,
      scale: 1,
    });
  }
  for (let i = 1; i <= STICK.capSegments - 1; i += 1) {
    const phi = (i / STICK.capSegments) * (Math.PI / 2);
    rings.push({
      x: straightHalf + endRadius * Math.sin(phi),
      scale: Math.cos(phi),
    });
  }

  const around = STICK.aroundSegments;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const ringStart: number[] = [];

  for (const ring of rings) {
    ringStart.push(positions.length / 3);
    for (let j = 0; j < around; j += 1) {
      const theta = (j / around) * Math.PI * 2;
      const y = semiHeight * ring.scale * Math.sin(theta);
      const z = semiWidth * ring.scale * Math.cos(theta);
      positions.push(ring.x, y, z);
      uvs.push((ring.x + length / 2) / length, 0.5 + z / width);
    }
  }

  // Quads between consecutive rings, wrapping around the seam.
  for (let r = 0; r + 1 < rings.length; r += 1) {
    const first = ringStart[r];
    const next = ringStart[r + 1];
    for (let j = 0; j < around; j += 1) {
      const j2 = (j + 1) % around;
      const a = first + j;
      const b = first + j2;
      const c = next + j2;
      const d = next + j;
      indices.push(a, c, b, a, d, c);
    }
  }

  // The two tips: a pole at each end, fanned to its nearest ring.
  const tipUv = (x: number): [number, number] => [
    (x + length / 2) / length,
    0.5,
  ];
  const leftPole = positions.length / 3;
  positions.push(-length / 2, 0, 0);
  uvs.push(...tipUv(-length / 2));
  const firstRing = ringStart[0];
  for (let j = 0; j < around; j += 1) {
    indices.push(leftPole, firstRing + j, firstRing + ((j + 1) % around));
  }
  const rightPole = positions.length / 3;
  positions.push(length / 2, 0, 0);
  uvs.push(...tipUv(length / 2));
  const lastRing = ringStart[rings.length - 1];
  for (let j = 0; j < around; j += 1) {
    indices.push(
      rightPole,
      lastRing + ((j + 1) % around),
      lastRing + j,
    );
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
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
