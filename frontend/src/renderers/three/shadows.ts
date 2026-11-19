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
 *    the drawn tile unioned into a single footprint, in the signed-off
 *    "resting on the table" form ({@link SHADOW.hand}). This is the one the user
 *    asked to leave alone.
 * 3. **One radial cast band for every other standing thing** (3D-19) — the three
 *    opponent hands (row + draw unioned) and each of the four wall runs. Each
 *    band starts under the object's base and reaches
 *    {@link SHADOW.cast.lengthUnits} **directly away from the table centre**, as
 *    if a lamp hung above the compass: down-screen for the near wall, up-screen
 *    for the far one, sideways for the side runs and hands. That is what makes
 *    the hands read as standing behind the wall rather than merely darker.
 *
 * The hand group is the **2.5D recipe, copied rather than reinvented**. The
 * user-approved whole-table rig (variant `v13-shadow-darker`, chosen
 * 2026-11-17; the retired spec is in git history) has
 *
 *     handShadow: { mode: 'blurredFootprint', sigmaUnits: 0.26,
 *                   sigmaXUnits: 0.1, maxAlpha: 1.0, spreadUnits: 0.18,
 *                   offsetYUnits: 0.18, unionGroups: true }
 *
 * which that chain derived from the retired UI group layer (`shadowShape`: a
 * hard rounded rect, σ 5 px standing / 12 px lying, core alpha 0.6, `#0b1418`)
 * and from the retired 2.5D architecture doc's §10.12 ("draw every placed
 * shape at alpha 1, blur the union
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
import { TILE, WALL } from '../layoutConstants';
import { BOARD_TILE_CAPACITY } from './boardMesh';
import { orientedBox, orientedBoxCorners, seatBasis, wallRunRadius } from './boardLayout';
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
  /** One quad per grounded non-hand tile plus one per hand group and wall run. */
  capacity: BOARD_TILE_CAPACITY,
  /**
   * The quad's margin outside a band's blurred rectangle, in multiples of that
   * axis's sigma.
   *
   * The analytic profile is 0.5 alpha on the rect's edge and reaches 0 a sigma
   * outside it, so a quad that stopped at the rect would be cut off at half
   * opacity — a hard-edged "solid rectangle". Every band quad is therefore drawn
   * `marginSigmas` wider than its rect on each axis, where the profile has
   * already fallen to 0.
   */
  marginSigmas: 1.5,
  /**
   * The radial cast shadow (3D-19): every **standing** thing throws a fairly
   * diffuse shadow directly away from the table centre, as if a lamp hung above
   * the compass. The wall ring casts one band per run; the three opponent hands
   * cast one band per seat. The human's hand keeps its own band
   * ({@link SHADOW.hand}) — the user asked for it to stay as it is.
   *
   * `lengthUnits` is the **visible** reach past the object's base (where the
   * profile reaches 0, not where the rect ends); `overlapUnits` tucks the band
   * back under the body so the foot stays dark; the sigmas are the blur across
   * the cast direction and along the object's row.
   */
  cast: {
    lengthUnits: 1.2,
    overlapUnits: 0.2,
    spreadUnits: 0.24,
    sigmaAcrossUnits: 0.6,
    sigmaAlongUnits: 0.35,
  },
  /**
   * The human hand's band, from the v13 rig and then widened to read like it.
   *
   * v13's `handShadow` is depth 0.5 / offset 0.18 / σ 0.26 across / 0.10 along
   * at the 2.5D rig's 76-unit camera. On the 3D board's closer solve (53 units)
   * that read as a thin crisp line, so the handoffs (2026-11-18) lowered and
   * widened it: the numbers below put the shadow's solid edge 0.65 units past
   * the contact line (it was 0.35), with a σ 0.5 / 0.3 blur. The band is 1.1
   * deep so 0.45 of it stays under the hand — that keeps the foot of the hand
   * at full darkness while the mass sits lower.
   *
   * `depthUnits` is the band's depth across the row, anchored on the hand's
   * contact edge; `offsetUnits` moves it that far toward the viewer (+Z);
   * `spreadUnits` is added at both row ends; the sigmas are the blur across and
   * along the band. A reclined hand's body overhangs its contact edge, so the
   * band is built from the tile's **contact** corners, not its whole oriented
   * box — using the box would make it twice as deep again.
   *
   * The quad's fade margin is {@link SHADOW.marginSigmas}.
   */
  hand: {
    depthUnits: 1.1,
    offsetUnits: 0.65,
    spreadUnits: 0.24,
    sigmaAcrossUnits: 0.5,
    sigmaAlongUnits: 0.3,
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
  /**
   * The band's hard rectangle half-extents (the quad is this plus its fade
   * margin). Zero for blob quads, which use their texture.
   */
  readonly innerHalfUnits: readonly [number, number];
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

/** A band's hard rectangle, in world row/depth coordinates. */
interface BandRect {
  readonly id: string;
  /** Whether the row (the object's long axis) runs along world X or world Z. */
  readonly rowIsX: boolean;
  readonly rowMin: number;
  readonly rowMax: number;
  readonly depthMin: number;
  readonly depthMax: number;
  /** Blur per world axis: `[x, z]`, in units. */
  readonly sigmaUnits: readonly [number, number];
  /** A slide along world +Z (the human band's "south" offset). */
  readonly depthShift?: number;
}

/**
 * Turn a blurred rectangle into one band quad, with the fade margin the analytic
 * profile needs so its alpha reaches 0 inside the geometry.
 */
function bandQuad(rect: BandRect): ShadowInstance {
  const margin = SHADOW.marginSigmas;
  const rowHalf = (rect.rowMax - rect.rowMin) / 2;
  const depthHalf = (rect.depthMax - rect.depthMin) / 2;
  const innerHalfUnits: readonly [number, number] = rect.rowIsX
    ? [rowHalf, depthHalf]
    : [depthHalf, rowHalf];
  const halfUnits: readonly [number, number] = [
    innerHalfUnits[0] + rect.sigmaUnits[0] * margin,
    innerHalfUnits[1] + rect.sigmaUnits[1] * margin,
  ];
  const rowCentre = (rect.rowMin + rect.rowMax) / 2;
  const depthCentre = (rect.depthMin + rect.depthMax) / 2;
  const shift = rect.depthShift ?? 0;
  // The row is X or Z; the depth is the other one. `depthShift` always slides
  // along world +Z, which is the row axis for a side seat.
  const centre: Vec3 = rect.rowIsX
    ? [rowCentre, SHADOW.liftUnits, depthCentre + shift]
    : [depthCentre, SHADOW.liftUnits, rowCentre + shift];
  const sizeUnits: readonly [number, number] = [halfUnits[0] * 2, halfUnits[1] * 2];
  return {
    id: rect.id,
    centre,
    sizeUnits,
    matrix: shadowMatrix(centre, sizeUnits),
    kind: SHADOW_KIND.band,
    sigmaUnits: rect.sigmaUnits,
    innerHalfUnits,
  };
}

/** The sigmas for a band whose row runs along X (`rowIsX`) or Z. */
function bandSigmas(
  rowIsX: boolean,
  along: number,
  across: number,
): readonly [number, number] {
  return rowIsX ? [along, across] : [across, along];
}

/** The sign of a seat's outward direction along its band's depth axis. */
function outwardSign(seat: Seat, rowIsX: boolean): number {
  const { outward } = seatBasis(seat);
  return rowIsX ? Math.sign(outward[2]) || 1 : Math.sign(outward[0]) || 1;
}

/**
 * The human's hand band: the union of the concealed row and the drawn tile.
 *
 * A fixed {@link SHADOW.hand.depthUnits} deep, anchored on the contact edge that
 * faces the camera and pushed {@link SHADOW.hand.offsetUnits} toward the viewer
 * — the signed-off "hand resting on the table" fake, which the cast shadows
 * deliberately leave alone.
 */
function humanHandQuad(seat: Seat, span: GroupSpan): ShadowInstance {
  const { depthUnits, offsetUnits, spreadUnits, sigmaAcrossUnits, sigmaAlongUnits } =
    SHADOW.hand;
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
  return bandQuad({
    id: `hand-group-${seat}`,
    rowIsX: span.rowIsX,
    rowMin,
    rowMax,
    depthMin,
    depthMax,
    sigmaUnits: bandSigmas(span.rowIsX, sigmaAlongUnits, sigmaAcrossUnits),
    depthShift,
  });
}

/**
 * One standing object's radial cast: the band starts under the object's base and
 * reaches {@link SHADOW.cast.lengthUnits} directly away from the table centre.
 */
function castQuad(id: string, span: GroupSpan, seat: Seat): ShadowInstance {
  const { lengthUnits, overlapUnits, spreadUnits, sigmaAcrossUnits, sigmaAlongUnits } =
    SHADOW.cast;
  const sign = outwardSign(seat, span.rowIsX);
  const base = sign >= 0 ? span.maxDepth : span.minDepth;
  // The rect's outer edge sits one sigma short of the visible reach, so the
  // profile's 0 lands exactly at `base + length`, and its inner edge tucks back
  // under the body so the object's foot stays dark.
  const inner = base - sign * overlapUnits;
  const outer = base + sign * (lengthUnits - sigmaAcrossUnits);
  return bandQuad({
    id,
    rowIsX: span.rowIsX,
    rowMin: span.minRow - spreadUnits,
    rowMax: span.maxRow + spreadUnits,
    depthMin: Math.min(inner, outer),
    depthMax: Math.max(inner, outer),
    sigmaUnits: bandSigmas(span.rowIsX, sigmaAlongUnits, sigmaAcrossUnits),
  });
}

/**
 * The wall ring's cast: one band per run, thrown outward from the wall's outer
 * face, plus — for the two side runs — one band off the **player-facing end**.
 *
 * The wall is the tallest thing on the table (two tiers, 1.18 units), so its
 * shadow is what makes the hands read as *behind* it rather than merely darker.
 * The side runs' outward bands go sideways, which leaves the 1-unit-wide strip of
 * felt in front of each end face unshadowed — a notch in the ring's shadow right
 * where the near wall's band stops. Those two ends face the human, so they get
 * the same outward cast as the near run's long face.
 */
function wallCastQuads(layout: BoardLayout): ShadowInstance[] {
  const { lengthUnits, overlapUnits, sigmaAcrossUnits, sigmaAlongUnits } = SHADOW.cast;
  const bands: ShadowInstance[] = [];
  for (let run = 0; run < WALL.runs; run += 1) {
    const seat = run as Seat;
    const { outward, right } = seatBasis(seat);
    const rowIsX = Math.abs(right[0]) > Math.abs(right[2]);
    const sign = rowIsX ? Math.sign(outward[2]) : Math.sign(outward[0]);
    const outerFace =
      sign * (wallRunRadius(seat, layout.humanSeat) + TILE.heightUnits / 2);
    const inner = outerFace - sign * overlapUnits;
    const outer = outerFace + sign * (lengthUnits - sigmaAcrossUnits);
    bands.push(
      bandQuad({
        id: `wall-cast-${run}`,
        rowIsX,
        rowMin: -WALL.runHalfLengthUnits,
        rowMax: WALL.runHalfLengthUnits,
        depthMin: Math.min(inner, outer),
        depthMax: Math.max(inner, outer),
        sigmaUnits: bandSigmas(rowIsX, sigmaAlongUnits, sigmaAcrossUnits),
      }),
    );
    if (rowIsX) continue;
    // A side run's player-facing end: its end face points at the human (+Z), and
    // the band spans the run's own radial footprint so it meets the near wall's
    // band instead of leaving a gap at the corner.
    const endFace = WALL.runHalfLengthUnits;
    const radialInner = sign * (wallRunRadius(seat, layout.humanSeat) - TILE.heightUnits / 2);
    const radialOuter = sign * (wallRunRadius(seat, layout.humanSeat) + TILE.heightUnits / 2);
    const endInner = endFace - overlapUnits;
    const endOuter = endFace + (lengthUnits - sigmaAcrossUnits);
    bands.push(
      bandQuad({
        id: `wall-end-cast-${run}`,
        rowIsX: true,
        rowMin: Math.min(radialInner, radialOuter),
        rowMax: Math.max(radialInner, radialOuter),
        depthMin: endInner,
        depthMax: endOuter,
        sigmaUnits: bandSigmas(true, sigmaAlongUnits, sigmaAcrossUnits),
      }),
    );
  }
  return bands;
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
    innerHalfUnits: [0, 0],
  };
}

/**
 * Every contact quad.
 *
 * - One blob per grounded tile, except hand/draw tiles.
 * - Each seat's hand row and drawn tile are unioned into one band: the human's
 *   keeps the signed-off "resting on the table" fake, the three opponents cast
 *   a radial shadow away from the centre.
 * - One radial cast band per wall run (the ring is the tallest thing on the
 *   table, and its shadow is what grounds the hands behind it).
 */
export function shadowInstances(layout: BoardLayout): readonly ShadowInstance[] {
  const instances: ShadowInstance[] = [...wallCastQuads(layout)];
  const groups = new Map<Seat, GroupSpan>();
  for (const tile of layout.tiles) {
    if (!isGrounded(tile)) continue;
    if (isHandGroupTile(tile)) {
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
    instances.push(
      seat === layout.humanSeat
        ? humanHandQuad(seat, span)
        : castQuad(`hand-cast-${seat}`, span, seat),
    );
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
attribute vec2 aInnerHalf;
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
  // The band's *hard* rectangle, which is smaller than the quad by its fade
  // margin; the profile reaches 0 before the quad's own edge.
  vHalf = aInnerHalf;
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
  const innerHalf = new InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
  const sigmas = new InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
  const kinds = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  geometry.setAttribute('aHalfExtents', halfExtents);
  geometry.setAttribute('aInnerHalf', innerHalf);
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
    const inner = innerHalf.array as Float32Array;
    const sigma = sigmas.array as Float32Array;
    const kind = kinds.array as Float32Array;
    next.forEach((instance, index) => {
      matrix.fromArray(instance.matrix as number[]);
      mesh.setMatrixAt(index, matrix);
      half[index * 2] = instance.sizeUnits[0] / 2;
      half[index * 2 + 1] = instance.sizeUnits[1] / 2;
      inner[index * 2] = instance.innerHalfUnits[0];
      inner[index * 2 + 1] = instance.innerHalfUnits[1];
      sigma[index * 2] = instance.sigmaUnits[0];
      sigma[index * 2 + 1] = instance.sigmaUnits[1];
      kind[index] = instance.kind;
    });
    mesh.instanceMatrix.needsUpdate = true;
    halfExtents.needsUpdate = true;
    innerHalf.needsUpdate = true;
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
