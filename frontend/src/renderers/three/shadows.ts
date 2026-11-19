/**
 * The board's contact-shadow layer (3D-07; the hand group re-cut to the 2.5D
 * recipe in 3D-07's second handoff).
 *
 * Every grounded tile gets one soft quad on the felt. Two profiles exist, one
 * material, one instanced draw:
 *
 * 1. **A per-tile blob** for lying tiles (ponds, melds, dora, the wall's bottom
 *    tier): the tile's oriented-box footprint plus a fixed rim, shaded with the
 *    procedural rounded-rect alpha in {@link shadowAlphaPixels}.
 * 2. **One blurred band for the human's hand group** — the concealed row *and*
 *    the drawn tile unioned into a single footprint. Only that hand is reclined
 *    (40° back on its far bottom edge) and overhangs its contact line, so
 *    per-tile quads read as a thin scalloped line rather than a hand resting on
 *    the table. The other three hands stand on the table, where per-tile blobs
 *    are correct and stay as they are.
 *
 * The hand group is the **2.5D recipe, copied rather than reinvented**. The
 * user-approved whole-table rig (`tools/render/table-reference-spec.json`, rig
 * variant `v13-shadow-darker`, chosen 2026-11-17) has
 *
 *     handShadow: { mode: 'blurredFootprint', sigmaUnits: 0.26,
 *                   sigmaXUnits: 0.1, maxAlpha: 1.0, spreadUnits: 0.18,
 *                   offsetYUnits: 0.18, unionGroups: true }
 *
 * which that chain derived from the shipped UI group layer
 * (`shells.json` `shadowShape`: a hard rounded rect, σ 5 px standing / 12 px
 * lying, core alpha 0.6, `#0b1418`) and from `2_5d_mahjong_tile_rendering_
 * architecture.md` §10.12 ("draw every placed shape at alpha 1, blur the union
 * once, then fill it" — so there is no double-darkening where the row and the
 * drawn tile meet, and the tsumogiri gap gets shadow like the rest of the
 * group). The 3D numbers are that variant's, in tile units:
 *
 *     spread 0.18 on every end · the whole footprint 0.18 south (toward the
 *     viewer) · Gaussian σ 0.26 across the band and 0.10 along it
 *
 * so the band is dark under the hand and fades out ~0.6 units in front of the
 * base line, which is what makes a 40°-reclined hand read as touching the felt.
 *
 * Rules every quad obeys, each a numeric test:
 *
 * - **One draw.** One plane geometry, one material, one instanced mesh.
 * - **Depth-tested, depth-write off.** Transparent black, drawn in the
 *   transparent pass after the opaque tiles; the depth test rejects a fragment
 *   wherever a tile body is nearer to the camera, so a shadow never overdraws a
 *   tile body — its own or a neighbour's — while still darkening the felt and
 *   the 0.3 mm grooves.
 * - **Under the body, on the felt.** Quads sit at {@link SHADOW.liftUnits}
 *   above the felt, below every tile's top surface, and are only emitted for
 *   tiles whose lowest body point is on the felt (a wall top tier rests on the
 *   tile beneath it).
 * - **Procedural, no asset.** Both the tile blob's texture and the hand band's
 *   alpha are generated in code, so they are deterministic, testable in Node
 *   and add no committed texture.
 */

import {
  DataTexture,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  RGBAFormat,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { Seat } from '../contract';
import { BOARD_TILE_CAPACITY } from './boardMesh';
import { orientedBox, orientedBoxCorners, seatBasis } from './boardLayout';
import type { BoardLayout, BoardTile, Vec3 } from './boardLayout';

/** The contact-shadow layer's committed numbers. */
export const SHADOW = {
  /** Quad plane height above the felt, in tile units (0.42 mm). */
  liftUnits: 0.015,
  /** Extra footprint per side for a lying tile, in tile units (3.4 mm). */
  paddingUnits: 0.12,
  /** A tile counts as grounded when its lowest point is within this of the felt. */
  groundToleranceUnits: 0.02,
  /** Corner radius, as a fraction of the tile blob's half-extent. */
  cornerFraction: 0.35,
  /** Layer opacity at the centre of the blob. */
  opacity: 0.55,
  /** The tile blob's alpha texture edge, in texels. */
  textureSize: 64,
  /** One quad per grounded non-hand tile plus one per seat's hand group. */
  capacity: BOARD_TILE_CAPACITY,
  /**
   * The human hand's band, from the v13 rig and then widened to read like it.
   *
   * v13's `handShadow` is depth 0.5 / offset 0.18 / σ 0.26 across / 0.10 along
   * at the 2.5D rig's 76-unit camera. On the 3D board's closer solve (53 units)
   * that band showed only ~31 px of gradient under the hand and read as a thin
   * line, so the handoff (2026-11-18, second shadow round) asked for it further
   * down and blurrier: the numbers below double the offset, deepen the band and
   * widen the blur, which puts ~49 px of gradient in front of the contact line
   * — the reference view's own ~46 px at its scale.
   *
   * `depthUnits` is the band's depth across the row, anchored on the hand's
   * contact edge; `offsetUnits` moves it that far toward the viewer (+Z);
   * `spreadUnits` is added at both row ends; the sigmas are the blur across and
   * along the band. A reclined hand's body overhangs its contact edge, so the
   * band is built from the tile's **contact** corners, not its whole oriented
   * box — using the box would make it twice as deep again.
   */
  hand: {
    depthUnits: 0.7,
    offsetUnits: 0.35,
    spreadUnits: 0.24,
    sigmaAcrossUnits: 0.45,
    sigmaAlongUnits: 0.22,
  },
} as const;

/** Which alpha profile a quad uses. */
export const SHADOW_KIND = {
  /** The procedural rounded-rect texture (lying tiles). */
  blob: 0,
  /** The analytic blurred band (a seat's hand + draw union). */
  band: 1,
} as const;

/** One contact quad, in world space. */
export interface ShadowInstance {
  /** The tile it belongs to, or `hand-group-<seat>` for a hand group. */
  readonly id: string;
  /** Quad centre: on the felt, at {@link SHADOW.liftUnits}. */
  readonly centre: Vec3;
  /** Full extents along world X and Z. */
  readonly sizeUnits: readonly [number, number];
  /** Column-major 4 x 4, ready for `InstancedMesh.setMatrixAt`. */
  readonly matrix: readonly number[];
  /** Which alpha profile: {@link SHADOW_KIND}. */
  readonly kind: number;
  /** Analytic ring width per world axis, in units (the band profile only). */
  readonly sigmaUnits: readonly [number, number];
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

/** Is this tile part of a seat's hand group (row or drawn tile)? */
function isHandGroupTile(tile: BoardTile): tile is BoardTile & { readonly seat: Seat } {
  return tile.seat !== null && (tile.zone === 'hand' || tile.zone === 'draw');
}

/** The camera-near and lateral extents of a hand group's contact footprint. */
interface GroupSpan {
  /** Along the row (the seat's right axis, in world X or Z). */
  minRow: number;
  maxRow: number;
  /** Across the row (the seat's outward axis, in world X or Z). */
  minDepth: number;
  maxDepth: number;
  /** Whether the row runs along world X (an end seat) or world Z (a side seat). */
  rowIsX: boolean;
}

/** Expand a span to include one tile's **contact** footprint (corners at y = 0). */
function includeContact(span: GroupSpan, tile: BoardTile): void {
  for (const corner of orientedBoxCorners(orientedBox(tile.pose))) {
    if (corner[1] > SHADOW.groundToleranceUnits) continue;
    const row = span.rowIsX ? corner[0] : corner[2];
    const depth = span.rowIsX ? corner[2] : corner[0];
    span.minRow = Math.min(span.minRow, row);
    span.maxRow = Math.max(span.maxRow, row);
    span.minDepth = Math.min(span.minDepth, depth);
    span.maxDepth = Math.max(span.maxDepth, depth);
  }
}

/**
 * The union quad for one seat's hand and drawn tile: v13's recipe.
 *
 * The band is a fixed {@link SHADOW.hand.depthUnits} deep, anchored on the
 * contact edge that faces the camera and pushed {@link SHADOW.hand.offsetUnits}
 * toward it, with {@link SHADOW.hand.spreadUnits} at both row ends — so it reads
 * as the hand resting on the felt rather than as the shadow of a tilted plate.
 * The sigmas are assigned to the world axes so they stay across and along the
 * band whichever way the seat's row runs.
 */
function handGroupQuad(seat: Seat, span: GroupSpan): ShadowInstance {
  const { depthUnits, offsetUnits, spreadUnits } = SHADOW.hand;
  const rowMin = span.minRow - spreadUnits;
  const rowMax = span.maxRow + spreadUnits;
  let depthMin: number;
  let depthMax: number;
  let depthShift = 0;
  if (span.rowIsX) {
    // End seats: the depth axis is world Z, so the camera-near edge is maxZ.
    const near = span.maxDepth;
    depthMin = near - (depthUnits - offsetUnits);
    depthMax = near + offsetUnits;
  } else {
    // Side seats: their row runs along Z, so the band is centred on the contact
    // footprint's own depth and only slides south with the rest of the layer.
    depthMin = span.minDepth - spreadUnits;
    depthMax = span.maxDepth + spreadUnits + offsetUnits;
    depthShift = offsetUnits;
  }
  const xRange: [number, number] = span.rowIsX ? [rowMin, rowMax] : [depthMin, depthMax];
  const zRange: [number, number] = span.rowIsX
    ? [depthMin, depthMax]
    : [rowMin + depthShift, rowMax + depthShift];
  const sizeUnits: readonly [number, number] = [xRange[1] - xRange[0], zRange[1] - zRange[0]];
  const centre: Vec3 = [
    (xRange[0] + xRange[1]) / 2,
    SHADOW.liftUnits,
    (zRange[0] + zRange[1]) / 2,
  ];
  const along = SHADOW.hand.sigmaAlongUnits;
  const across = SHADOW.hand.sigmaAcrossUnits;
  return {
    id: `hand-group-${seat}`,
    centre,
    sizeUnits,
    matrix: shadowMatrix(centre, sizeUnits),
    kind: SHADOW_KIND.band,
    sigmaUnits: span.rowIsX ? [along, across] : [across, along],
  };
}

/** The per-tile blob quad for a lying (or standing non-hand) grounded tile. */
function tileQuad(tile: BoardTile): ShadowInstance {
  const footprint = tileFootprint(tile);
  const sizeUnits: readonly [number, number] = [
    footprint[0] + SHADOW.paddingUnits * 2,
    footprint[1] + SHADOW.paddingUnits * 2,
  ];
  const centre: Vec3 = [tile.pose.position[0], SHADOW.liftUnits, tile.pose.position[2]];
  return {
    id: tile.id,
    centre,
    sizeUnits,
    matrix: shadowMatrix(centre, sizeUnits),
    kind: SHADOW_KIND.blob,
    sigmaUnits: [0, 0],
  };
}

/**
 * Every contact quad: one per grounded tile, except the human's hand and drawn
 * tile, which are unioned into a single band.
 *
 * Only the human's hand is reclined and overhangs its contact line; the other
 * three hands stand on the table, so their per-tile blobs are already right.
 */
export function shadowInstances(layout: BoardLayout): readonly ShadowInstance[] {
  const instances: ShadowInstance[] = [];
  const groups = new Map<Seat, GroupSpan>();
  for (const tile of layout.tiles) {
    if (!isGrounded(tile)) continue;
    if (isHandGroupTile(tile) && tile.seat === layout.humanSeat) {
      const { right } = seatBasis(tile.seat);
      const rowIsX = Math.abs(right[0]) > Math.abs(right[2]);
      const span = groups.get(tile.seat) ?? {
        minRow: Number.POSITIVE_INFINITY,
        maxRow: Number.NEGATIVE_INFINITY,
        minDepth: Number.POSITIVE_INFINITY,
        maxDepth: Number.NEGATIVE_INFINITY,
        rowIsX,
      };
      includeContact(span, tile);
      groups.set(tile.seat, span);
      continue;
    }
    instances.push(tileQuad(tile));
  }
  for (const [seat, span] of groups) {
    if (!Number.isFinite(span.minRow)) continue;
    instances.push(handGroupQuad(seat, span));
  }
  if (instances.length > SHADOW.capacity) {
    throw new Error(
      `3D shadows: ${instances.length} quads exceed the ${SHADOW.capacity}-quad capacity`,
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

/** The whole RGBA alpha texture (the per-tile blob), top row first. */
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

/**
 * The hand band's alpha at one world point, as the fragment shader computes it.
 *
 * A separable blurred rectangle: each axis is a smoothstep across the edge
 * width `sigma`, so the alpha is 0.5 exactly on the edge, 1 a ring-width
 * inside, and 0 a ring-width outside. Pure, so the shader's profile is a
 * number the tests can assert (`band` in the fragment shader mirrors it).
 */
export function bandAlphaAt(
  offsetUnits: readonly [number, number],
  halfUnits: readonly [number, number],
  sigmaUnits: readonly [number, number],
): number {
  const axis = (offset: number, half: number, sigma: number): number => {
    if (!(sigma > 0)) return Math.abs(offset) <= half ? 1 : 0;
    const t = clamp01((half - Math.abs(offset) + sigma) / (2 * sigma));
    return t * t * (3 - 2 * t);
  };
  return (
    axis(offsetUnits[0], halfUnits[0], sigmaUnits[0]) *
    axis(offsetUnits[1], halfUnits[1], sigmaUnits[1])
  );
}

/**
 * The shadow layer's shaders. The blob path samples the procedural texture; the
 * band path evaluates {@link bandAlphaAt} from per-instance extents and sigmas,
 * which is what keeps the hand's blur in world units however long the row is.
 */
const SHADOW_VERTEX_SHADER = /* glsl */ `
attribute vec2 aHalfExtents;
attribute vec2 aSigma;
attribute float aKind;

varying vec2 vUv;
varying vec2 vLocal;
varying vec2 vHalf;
varying vec2 vSigma;
varying float vKind;

void main() {
  vUv = uv;
  vLocal = (uv - 0.5) * 2.0 * aHalfExtents;
  vHalf = aHalfExtents;
  vSigma = aSigma;
  vKind = aKind;
  mat4 toWorld = modelMatrix;
#ifdef USE_INSTANCING
  toWorld = modelMatrix * instanceMatrix;
#endif
  gl_Position = projectionMatrix * viewMatrix * toWorld * vec4(position, 1.0);
}
`;

const SHADOW_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uBlob;
uniform float uOpacity;

varying vec2 vUv;
varying vec2 vLocal;
varying vec2 vHalf;
varying vec2 vSigma;
varying float vKind;

/** One axis of the band profile: 0.5 on the edge, 0 a ring width outside. */
float bandAxis(float offset, float halfExtent, float sigma) {
  if (sigma <= 0.0) {
    return abs(offset) <= halfExtent ? 1.0 : 0.0;
  }
  return smoothstep(-sigma, sigma, halfExtent - abs(offset));
}

void main() {
  float alpha;
  if (vKind < 0.5) {
    alpha = texture2D(uBlob, vUv).a;
  } else {
    alpha = bandAxis(vLocal.x, vHalf.x, vSigma.x) *
      bandAxis(vLocal.y, vHalf.y, vSigma.y);
  }
  if (alpha <= 0.002) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, alpha * uOpacity);
}
`;

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
  const material = new ShaderMaterial({
    name: 'contact-shadow',
    uniforms: {
      uBlob: { value: texture },
      uOpacity: { value: SHADOW.opacity },
    },
    vertexShader: SHADOW_VERTEX_SHADER,
    fragmentShader: SHADOW_FRAGMENT_SHADER,
    transparent: true,
    // Rule 2: depth-tested, never depth-writing, and drawn after the opaque
    // tiles (transparent pass) so a tile body always wins the depth test.
    depthTest: true,
    depthWrite: false,
    // The plane faces +Y; a double-sided material keeps the blob correct if a
    // future camera ever drops below the felt plane.
    side: DoubleSide,
  });
  const halfExtents = new InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
  const sigmas = new InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
  const kinds = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  geometry.setAttribute('aHalfExtents', halfExtents);
  geometry.setAttribute('aSigma', sigmas);
  geometry.setAttribute('aKind', kinds);

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
    const half = halfExtents.array as Float32Array;
    const sigma = sigmas.array as Float32Array;
    const kind = kinds.array as Float32Array;
    next.forEach((instance, index) => {
      matrix.fromArray(instance.matrix as number[]);
      mesh.setMatrixAt(index, matrix);
      half[index * 2] = instance.sizeUnits[0] / 2;
      half[index * 2 + 1] = instance.sizeUnits[1] / 2;
      sigma[index * 2] = instance.sigmaUnits[0];
      sigma[index * 2 + 1] = instance.sigmaUnits[1];
      kind[index] = instance.kind;
    });
    mesh.instanceMatrix.needsUpdate = true;
    halfExtents.needsUpdate = true;
    sigmas.needsUpdate = true;
    kinds.needsUpdate = true;
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
