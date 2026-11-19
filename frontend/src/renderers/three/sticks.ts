/**
 * The riichi sticks (3D-07, remodelled in 3D-09): one instanced draw for the
 * point sticks standing on the compass plate.
 *
 * **The model.** A 1000-point stick is a polystyrene bar: 65 mm long, 7 mm wide
 * and 3.5 mm thick, with a painted red pip in the middle and a soft sheen. On
 * the compass it is drawn at 72 % of that (`STICK.modelScale`) so it fits
 * between the score row and the centre group. The
 * user's last two shape notes (2026-11-19) decide the form: "looking at the
 * stick from the long end, the cross-sectional profile of the stick should be
 * an ellipse", and "looking down on the stick like we do on the table, the
 * profile should be a rectangle (with only very very slightly rounded corners),
 * so the ends should terminate abruptly rather than being semi-ovals." The bar
 * is therefore a **swept ellipse** (every cross-section is a 7 × 3.5 mm
 * ellipse) with **flat ends** and a 0.4 mm round on the end rim. The top view
 * is a 65 × 7 mm rectangle; only its four corners are eased, and the long edges
 * are continuously round because the cross-section is an ellipse.
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
  /** Rings around the elliptical cross-section (smooth shading). */
  aroundSegments: 40,
  /** Rings along the straight length of the bar. */
  straightSegments: 28,
  /** Rings across the tiny end-rim round. */
  rimSegments: 4,
  /**
   * The very slight round on the plan corners: 0.4 mm of the real bar, scaled
   * with the model. The top view is otherwise a hard rectangle with abrupt,
   * flat ends (2026-11-19: "the profile should be a rectangle (with only very
   * very slightly rounded corners), so the ends should terminate abruptly
   * rather than being semi-ovals").
   */
  endRoundUnits: (0.4 / UNIT_MM) * STICK_LAYOUT.modelScale,
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
 * with flat ends and a very slight round on the end rim.
 *
 * Every cross-section is the same 7 x 3.5 mm ellipse (the user's "looking at the
 * stick from the long end, the cross-sectional profile … should be an ellipse"),
 * so the long edges are continuously round. Looking down, the silhouette is a
 * **rectangle**: the sides stay at full width for the whole straight length and
 * the 65 mm ends are flat cuts, with only a 0.4 mm round easing the four corners
 * (the user's "very very slightly rounded corners … ends should terminate
 * abruptly rather than being semi-ovals").
 *
 * UVs are the plan projection — `u` along the bar, `v` across it — so the pip
 * sits at the top centre and the end faces, which are tiny, sample the plain
 * ivory edge of the atlas.
 */
export function createStickGeometry(): BufferGeometry {
  const length = STICK_SIZE.lengthUnits;
  const width = STICK_SIZE.widthUnits;
  const height = STICK_SIZE.heightUnits;
  const semiWidth = width / 2;
  const semiHeight = height / 2;
  const endRound = STICK.endRoundUnits;
  const half = length / 2;

  // Rings from the left end to the right end. The body's sides are full width
  // until `endRound` from each tip; over that last sliver the ellipse is scaled
  // down to `endScale`, which rounds the plan corner without turning the end
  // into a dome.
  const rings: { x: number; scale: number }[] = [];
  for (let i = STICK.rimSegments; i >= 0; i -= 1) {
    const phi = (i / STICK.rimSegments) * (Math.PI / 2);
    rings.push({
      x: -(half - endRound + endRound * Math.sin(phi)),
      scale: 1 - (endRound / semiWidth) * (1 - Math.cos(phi)),
    });
  }
  for (let i = 1; i <= STICK.straightSegments; i += 1) {
    rings.push({
      x:
        -half +
        endRound +
        (i * (length - 2 * endRound)) / STICK.straightSegments,
      scale: 1,
    });
  }
  for (let i = 1; i <= STICK.rimSegments; i += 1) {
    const phi = (i / STICK.rimSegments) * (Math.PI / 2);
    rings.push({
      x: half - endRound + endRound * Math.sin(phi),
      scale: 1 - (endRound / semiWidth) * (1 - Math.cos(phi)),
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
      uvs.push((ring.x + half) / length, 0.5 + z / width);
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

  // The ends are flat elliptical caps (abrupt), each with its outward normal.
  const leftPole = positions.length / 3;
  positions.push(-half, 0, 0);
  uvs.push(0, 0.5);
  const firstRing = ringStart[0];
  for (let j = 0; j < around; j += 1) {
    indices.push(leftPole, firstRing + j, firstRing + ((j + 1) % around));
  }
  const rightPole = positions.length / 3;
  positions.push(half, 0, 0);
  uvs.push(1, 0.5);
  const lastRing = ringStart[rings.length - 1];
  for (let j = 0; j < around; j += 1) {
    indices.push(rightPole, lastRing + ((j + 1) % around), lastRing + j);
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
