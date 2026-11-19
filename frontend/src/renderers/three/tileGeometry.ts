/**
 * The deterministic beveled tile mesh (3D-04).
 *
 * One procedural, indexed mesh shared by every tile instance: a rounded beveled
 * slab with the committed tile proportions (21 x 28 x 16.5 mm at 1 unit = 28 mm,
 * `layoutConstants.ts`), the committed 0.055-unit / 6-segment front bevel, a
 * carved face plateau, per-vertex tangents for the POM shader and a `faceZone`
 * attribute that is exactly 1 on the plateau and 0 everywhere else.
 *
 * The local frame matches the world frame: **+X is tile width, +Y is tile
 * height, +Z is the face normal** (toward the viewer). The body is centred on
 * the origin, so the bounds are symmetric and the face plane is `+thickness/2`.
 * A layout transform (`boardLayout.ts`, 3D-06) stands the tile up, lies it flat
 * or reclines the human hand; the mesh itself never changes.
 *
 * Construction: one closed loop around the body silhouette (a rounded rectangle
 * in the X-Y plane, counter-clockwise seen from +Z) is swept through a profile
 * of rings in Z: the front bevel, the flat side wall and the back bevel. Each
 * ring is the body outline offset inward by that ring's inset, so the plateau
 * lands exactly one bevel inside the body (0.64 x 0.89 units) and the profile
 * normals are analytic (a quarter circle from the face tangent to the side
 * tangent). That keeps the mesh watertight, its winding uniformly outward and
 * its normals exact without a normal-accumulation pass.
 *
 * What this module deliberately is not: it imports no `three` (3D-02 owns the
 * dependency and the `BufferGeometry` wrapper), reads no asset, and contains no
 * randomness or clock. Two builds produce byte-identical buffers, which the
 * tests pin. The committed relief atlases are 3D-03's read-only input; this
 * mesh only publishes the plate rectangle they map onto.
 */

import { TILE } from '../layoutConstants';

/** Half the 21 mm tile width, in world units. */
const HALF_WIDTH = TILE.widthUnits / 2;
/** Half the 28 mm tile height, in world units. */
const HALF_HEIGHT = TILE.heightUnits / 2;
/** Half the 16.5 mm tile thickness, in world units. */
const HALF_THICKNESS = TILE.thicknessUnits / 2;
/** The committed 0.055-unit shell bevel. */
const BEVEL = TILE.bevelUnits;
/** Half the 0.64-unit carved face plate (the body inset by one bevel). */
const PLATE_HALF_WIDTH = HALF_WIDTH - BEVEL;
/** Half the 0.89-unit carved face plate. */
const PLATE_HALF_HEIGHT = HALF_HEIGHT - BEVEL;

/**
 * The silhouette's rounded-corner radius in the face plane.
 *
 * This is the shell baker's own number, not a guess: `bake_shells.py` builds the
 * tile as a cube bevelled 0.055 units with 6 segments on **every** edge, so the
 * vertical corners are rounded by exactly one bevel (1.54 mm), and the reference
 * table (`bake_table_reference.py`) imports that same `build_tile`. The plateau,
 * inset one bevel, therefore lands on a *sharp* rectangle: offsetting a rounded
 * rectangle inward by its own radius leaves square corners. That is what the
 * shipped shells show.
 *
 * The sweep below needs a non-zero radius on the inset ring, so the body keeps
 * 0.17 mm more than one bevel: the plateau corner comes out at 0.006 units
 * (0.17 mm) instead of exactly sharp — well inside the shell's own edge
 * softness, and the visible silhouette is the reference's 1.54 mm corner
 * within 0.6 % of the tile width.
 */
const CORNER_RADIUS = BEVEL + 0.006;

/**
 * Arc segments per silhouette corner. The shell's bevel uses 6; this keeps 4 so
 * the whole tile stays inside the 600-triangle budget (28 outline vertices
 * would push the flat-back body to 672). At 1.54 mm the difference is a
 * sub-pixel chamfer.
 */
const LOOP_SEGMENTS_PER_CORNER = 4;

/** The committed 6-segment bevel (: the shell spec's `bevel.segments`). */
const FRONT_BEVEL_SEGMENTS = 6;

/**
 * Profile segments across the back bevel. The blue back reads in silhouette
 * only, so it spends less of the 600-triangle budget than the carved face.
 */
const BACK_BEVEL_SEGMENTS = 4;

/** Bands in the optional back crown. Two plus an apex fan fits the budget. */
const DOME_RINGS = 2;

/**
 * The deepest back crown that keeps the tile inside its committed envelope:
 * the side wall must still have room for both bevels.
 */
const MAX_BACK_DOME_UNITS = 2 * (HALF_THICKNESS - BEVEL);

/** The triangle ceiling this unit promises the board's budget (3D-07). */
export const TILE_TRIANGLE_BUDGET = 600;

/** The per-vertex face-plate flag, named as the plan's `faceZone` attribute. */
export const FACE_ZONE_ATTRIBUTE = 'faceZone';

/**
 * The derived mesh specification, for tests, the budget gate and the units
 * that build the GPU buffers. All lengths are world units.
 */
export const TILE_MESH = {
  widthUnits: TILE.widthUnits,
  heightUnits: TILE.heightUnits,
  thicknessUnits: TILE.thicknessUnits,
  halfWidthUnits: HALF_WIDTH,
  halfHeightUnits: HALF_HEIGHT,
  halfThicknessUnits: HALF_THICKNESS,
  bevelUnits: BEVEL,
  bevelSegments: FRONT_BEVEL_SEGMENTS,
  backBevelSegments: BACK_BEVEL_SEGMENTS,
  cornerRadiusUnits: CORNER_RADIUS,
  loopSegmentsPerCorner: LOOP_SEGMENTS_PER_CORNER,
  loopVertexCount: 4 * (LOOP_SEGMENTS_PER_CORNER + 1),
  facePlateHalfWidthUnits: PLATE_HALF_WIDTH,
  facePlateHalfHeightUnits: PLATE_HALF_HEIGHT,
  facePlateWidthUnits: 2 * PLATE_HALF_WIDTH,
  facePlateHeightUnits: 2 * PLATE_HALF_HEIGHT,
  /** The plateau's own rounded corner (the body's radius minus the bevel). */
  facePlateCornerRadiusUnits: CORNER_RADIUS - BEVEL,
  /** The plateau's plane; the front of the body. */
  facePlaneZUnits: HALF_THICKNESS,
  triangleBudget: TILE_TRIANGLE_BUDGET,
} as const;

/** One entry per interleaved-free vertex attribute the mesh publishes. */
export interface TileGeometryAttributeSpec {
  readonly key: 'positions' | 'normals' | 'uvs' | 'tangents' | 'faceZone';
  readonly name: string;
  readonly itemSize: number;
}

/**
 * The attribute table, in the order a `BufferGeometry` wants them. `tangent` is
 * four components (`xyz` plus the bitangent handedness in `w`), matching
 * three's convention; `faceZone` is a one-component float the shader branches
 * on (1 = carved face plateau, 0 = bevel, side and back).
 */
export const TILE_GEOMETRY_ATTRIBUTES: readonly TileGeometryAttributeSpec[] =
  [
    { key: 'positions', name: 'position', itemSize: 3 },
    { key: 'normals', name: 'normal', itemSize: 3 },
    { key: 'uvs', name: 'uv', itemSize: 2 },
    { key: 'tangents', name: 'tangent', itemSize: 4 },
    { key: 'faceZone', name: FACE_ZONE_ATTRIBUTE, itemSize: 1 },
  ];

/** Options for {@link buildTileGeometry}. */
export interface TileGeometryOptions {
  /**
   * Depth of the optional shallow crown on the blue back, in world units:
   * 0 (the default) keeps the committed shell's flat backing. A positive value
   * recesses the back bevel by that much and domes the plate out to the exact
   * back plane, so the 0.58929-unit envelope never grows.
   */
  readonly backDomeUnits?: number;
}

/** The buffers one tile geometry build produces. */
export interface TileGeometryData {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  /**
   * `xyzw`: `xyz` is the unit tangent along +U (Gram-Schmidt against the
   * normal); `w` is ±1 so `bitangent = w * cross(normal, tangent)` points along
   * +V.
   */
  readonly tangents: Float32Array;
  /** 1 on every face-plateau vertex; 0 on bevels, sides and back. */
  readonly faceZone: Float32Array;
  readonly indices: Uint16Array;
  readonly vertexCount: number;
  readonly triangleCount: number;
  /** World-unit extents measured from the built positions. */
  readonly boundsUnits: {
    readonly width: number;
    readonly height: number;
    readonly thickness: number;
  };
}

type Vec3 = readonly [number, number, number];

interface OutlineVertex {
  /** Body silhouette position at inset 0. */
  readonly x: number;
  readonly y: number;
  /** Outward unit normal in the face plane. */
  readonly nx: number;
  /** Outward unit normal in the face plane. */
  readonly ny: number;
  /** Normalised arc length around the loop, for the cylindrical side UVs. */
  readonly u: number;
}

interface ProfileRing {
  /** Distance inward from the body silhouette. */
  readonly inset: number;
  readonly z: number;
  /** Outward normal's component along the loop normal. */
  readonly normalOut: number;
  /** Outward normal's Z component. */
  readonly normalZ: number;
}

interface MeshBuffers {
  readonly positions: number[];
  readonly normals: number[];
  readonly uvs: number[];
  readonly tangents: number[];
  readonly faceZone: number[];
  readonly indices: number[];
}

/**
 * The body silhouette: a rounded rectangle traversed counter-clockwise seen
 * from +Z, starting at the bottom-right corner's bottom end. Straight edges are
 * one segment each; corners carry `LOOP_SEGMENTS_PER_CORNER` arc steps, so the
 * joint between a corner and an edge has an exact edge-direction tangent.
 */
function buildOutline(): readonly OutlineVertex[] {
  const centreX = HALF_WIDTH - CORNER_RADIUS;
  const centreY = HALF_HEIGHT - CORNER_RADIUS;
  const corners = [
    { sx: 1, sy: -1, from: -Math.PI / 2, to: 0 },
    { sx: 1, sy: 1, from: 0, to: Math.PI / 2 },
    { sx: -1, sy: 1, from: Math.PI / 2, to: Math.PI },
    { sx: -1, sy: -1, from: Math.PI, to: (3 * Math.PI) / 2 },
  ] as const;

  const points: { x: number; y: number; nx: number; ny: number }[] = [];
  for (const corner of corners) {
    for (let step = 0; step <= LOOP_SEGMENTS_PER_CORNER; step++) {
      const angle =
        corner.from +
        ((corner.to - corner.from) * step) / LOOP_SEGMENTS_PER_CORNER;
      const nx = Math.cos(angle);
      const ny = Math.sin(angle);
      points.push({
        x: corner.sx * centreX + CORNER_RADIUS * nx,
        y: corner.sy * centreY + CORNER_RADIUS * ny,
        nx,
        ny,
      });
    }
  }

  const cumulative: number[] = [];
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    cumulative.push(total);
    const a = points[i];
    const b = points[(i + 1) % points.length];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return points.map((point, i) => ({
    ...point,
    u: cumulative[i] / total,
  }));
}

const OUTLINE = buildOutline();

/**
 * Discrete loop tangents (the direction of increasing `u` at each silhouette
 * vertex). At arc points the chord is perpendicular to the radial normal, so
 * these are already orthogonal; at the edge joints the chord is the edge
 * itself. Degenerate polygons cannot occur with the fixed constants.
 */
const LOOP_TANGENTS: readonly (readonly [number, number])[] = OUTLINE.map(
  (_, i) => {
    const previous = OUTLINE[(i - 1 + OUTLINE.length) % OUTLINE.length];
    const next = OUTLINE[(i + 1) % OUTLINE.length];
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const length = Math.hypot(dx, dy);
    return [dx / length, dy / length] as const;
  },
);

/**
 * The swept profile, from the face plateau edge to the back plate edge.
 *
 * Front bevel: a quarter circle of radius `BEVEL` tangent to the face at
 * `z = +halfThickness` and to the side wall one bevel lower. Back bevel: the
 * mirrored quarter circle from the side wall into the back plate, ending at
 * `backRimZ` (the committed back plane unless a crown recesses it).
 */
function buildProfile(backRimZ: number): readonly ProfileRing[] {
  const rings: ProfileRing[] = [];

  for (let step = 0; step <= FRONT_BEVEL_SEGMENTS; step++) {
    const theta = (step / FRONT_BEVEL_SEGMENTS) * (Math.PI / 2);
    rings.push({
      inset: BEVEL * (1 - Math.sin(theta)),
      z: HALF_THICKNESS - BEVEL * (1 - Math.cos(theta)),
      normalOut: Math.sin(theta),
      normalZ: Math.cos(theta),
    });
  }

  // The flat side wall: one band from the front bevel's end to the back
  // bevel's start, both at inset 0.
  rings.push({ inset: 0, z: backRimZ + BEVEL, normalOut: 1, normalZ: 0 });

  // The back bevel. Step 0 is the side-wall ring just pushed (inset 0), so the
  // sweep starts at step 1 and ends with the normal (0, 0, -1) back plate rim.
  for (let step = 1; step <= BACK_BEVEL_SEGMENTS; step++) {
    const psi = (step / BACK_BEVEL_SEGMENTS) * (Math.PI / 2);
    rings.push({
      inset: BEVEL * Math.sin(psi),
      z: backRimZ + BEVEL * Math.cos(psi),
      normalOut: Math.cos(psi),
      normalZ: -Math.sin(psi),
    });
  }

  return rings;
}

/** Cumulative profile distance per ring, normalised to [0, 1]. */
function profileDistances(rings: readonly ProfileRing[]): number[] {
  const distances: number[] = [];
  let total = 0;
  for (let i = 0; i < rings.length; i++) {
    if (i > 0) {
      const dInset = rings[i].inset - rings[i - 1].inset;
      const dZ = rings[i].z - rings[i - 1].z;
      total += Math.hypot(dInset, dZ);
    }
    distances.push(total);
  }
  return distances.map((distance) => distance / total);
}

/** The optional back crown: smoothstep, flat at the rim and flat at the apex. */
function domeHeightAt(t: number): number {
  return t * t * (3 - 2 * t);
}

/** `d/dt` of {@link domeHeightAt}. */
function domeSlopeAt(t: number): number {
  return 6 * t * (1 - t);
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(value: Vec3): Vec3 {
  const length = Math.hypot(value[0], value[1], value[2]);
  return [value[0] / length, value[1] / length, value[2] / length];
}

/**
 * Project `tangent` onto the plane perpendicular to `normal`, then normalise.
 * The swept tangents are already almost orthogonal; this makes "orthogonal"
 * exact at the four edge/corner joints and keeps the acceptance criterion
 * provable instead of approximate.
 */
function orthonormalTangent(normal: Vec3, tangent: Vec3): Vec3 {
  const dot =
    normal[0] * tangent[0] +
    normal[1] * tangent[1] +
    normal[2] * tangent[2];
  const projected: Vec3 = [
    tangent[0] - normal[0] * dot,
    tangent[1] - normal[1] * dot,
    tangent[2] - normal[2] * dot,
  ];
  const length = Math.hypot(projected[0], projected[1], projected[2]);
  if (length > 1e-9) {
    return [projected[0] / length, projected[1] / length, projected[2] / length];
  }
  // A tangent parallel to the normal cannot occur on this mesh (every normal
  // has an in-plane component or the tangent is in-plane); keep a deterministic
  // fallback rather than emitting NaN.
  const axis: Vec3 =
    Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return normalize(cross(normal, axis));
}

/** `w = +1` when `bitangent = cross(normal, tangent)` runs along +V. */
function handedness(normal: Vec3, tangent: Vec3, towardsV: Vec3): 1 | -1 {
  const bitangent = cross(normal, tangent);
  const dot =
    bitangent[0] * towardsV[0] +
    bitangent[1] * towardsV[1] +
    bitangent[2] * towardsV[2];
  return dot < 0 ? -1 : 1;
}

/**
 * The face plate's UV: the plate rectangle maps to [0, 1]² with (0, 0) at the
 * plate's top-left and V running **down** the glyph.
 *
 * The committed relief cells publish their glyph top-left at the cell's
 * top-left with y down, so the face shader samples with `flipY = false` and no
 * row flip (`3d_renderer_implementation_plan.md` §2.5). `x`/`y` are local tile
 * coordinates; points outside the plate extrapolate.
 */
export function facePlateUv(
  x: number,
  y: number,
): { readonly u: number; readonly v: number } {
  return {
    u: (x + PLATE_HALF_WIDTH) / (2 * PLATE_HALF_WIDTH),
    v: (PLATE_HALF_HEIGHT - y) / (2 * PLATE_HALF_HEIGHT),
  };
}

function createBuffers(): MeshBuffers {
  return {
    positions: [],
    normals: [],
    uvs: [],
    tangents: [],
    faceZone: [],
    indices: [],
  };
}

function addVertex(
  buffers: MeshBuffers,
  position: Vec3,
  normal: Vec3,
  uv: readonly [number, number],
  tangent: Vec3,
  w: 1 | -1,
  faceZone: 0 | 1,
): number {
  const index = buffers.positions.length / 3;
  buffers.positions.push(position[0], position[1], position[2]);
  buffers.normals.push(normal[0], normal[1], normal[2]);
  buffers.uvs.push(uv[0], uv[1]);
  buffers.tangents.push(tangent[0], tangent[1], tangent[2], w);
  buffers.faceZone.push(faceZone);
  return index;
}

/**
 * The two triangles of one swept band quad, wound outward.
 *
 * With `i` running counter-clockwise around the loop and `j` running from the
 * face toward the back, the surface's outward normal is `dP/dj x dP/di`, so the
 * triangle `(i, j) -> (i, j+1) -> (i+1, j)` faces out. Every band in this mesh
 * uses that one convention; the caps reverse the fan.
 */
function addBandQuad(
  buffers: MeshBuffers,
  ringStarts: readonly number[],
  j: number,
  i: number,
): void {
  const count = OUTLINE.length;
  const next = (i + 1) % count;
  const a = ringStarts[j] + i;
  const b = ringStarts[j + 1] + i;
  const c = ringStarts[j] + next;
  const d = ringStarts[j + 1] + next;
  buffers.indices.push(a, b, c, c, b, d);
}

/**
 * Build the tile mesh.
 *
 * Deterministic: the same options always produce byte-identical buffers, with
 * no randomness, clock or asset input. Output size is 480 triangles for the
 * committed flat back and 520 with the optional crown, both inside
 * {@link TILE_TRIANGLE_BUDGET}.
 */
export function buildTileGeometry(
  options: TileGeometryOptions = {},
): TileGeometryData {
  const backDomeUnits = options.backDomeUnits ?? 0;
  if (
    !Number.isFinite(backDomeUnits) ||
    backDomeUnits < 0 ||
    backDomeUnits >= MAX_BACK_DOME_UNITS
  ) {
    throw new RangeError(
      `backDomeUnits must be in [0, ${MAX_BACK_DOME_UNITS}) but was ${backDomeUnits}`,
    );
  }

  const backRimZ = -HALF_THICKNESS + backDomeUnits;
  const profile = buildProfile(backRimZ);
  const profileV = profileDistances(profile);
  const buffers = createBuffers();

  // Every ring's vertex positions, so each vertex's +V direction (needed for
  // the tangent handedness) can use its neighbours.
  const ringPositions: Vec3[][] = profile.map((ring) =>
    OUTLINE.map(
      (point): Vec3 => [
        point.x - ring.inset * point.nx,
        point.y - ring.inset * point.ny,
        ring.z,
      ],
    ),
  );

  const ringStarts: number[] = [];
  for (let j = 0; j < profile.length; j++) {
    const ring = profile[j];
    const previous = ringPositions[Math.max(0, j - 1)];
    const next = ringPositions[Math.min(ringPositions.length - 1, j + 1)];
    ringStarts.push(buffers.positions.length / 3);
    for (let i = 0; i < OUTLINE.length; i++) {
      const point = OUTLINE[i];
      const loopTangent = LOOP_TANGENTS[i];
      const normal: Vec3 = [
        ring.normalOut * point.nx,
        ring.normalOut * point.ny,
        ring.normalZ,
      ];
      const tangent = orthonormalTangent(normal, [
        loopTangent[0],
        loopTangent[1],
        0,
      ]);
      const towardsV = normalize(subtract(next[i], previous[i]));
      addVertex(
        buffers,
        ringPositions[j][i],
        normal,
        [point.u, profileV[j]],
        tangent,
        handedness(normal, tangent, towardsV),
        0,
      );
    }
  }

  for (let j = 0; j + 1 < profile.length; j++) {
    for (let i = 0; i < OUTLINE.length; i++) {
      addBandQuad(buffers, ringStarts, j, i);
    }
  }

  // The carved face plateau: its own ring (plate UVs, faceZone 1, normal +Z)
  // and a fan to the plate centre. The ring is geometrically identical to the
  // front bevel's first ring, but carries the plate mapping.
  const plateRing = ringPositions[0];
  const plateNormal: Vec3 = [0, 0, 1];
  const plateTangent: Vec3 = [1, 0, 0];
  const plateStart = buffers.positions.length / 3;
  for (let i = 0; i < OUTLINE.length; i++) {
    const position = plateRing[i];
    const uv = facePlateUv(position[0], position[1]);
    addVertex(
      buffers,
      position,
      plateNormal,
      [uv.u, uv.v],
      plateTangent,
      -1,
      1,
    );
  }
  const plateCentre = addVertex(
    buffers,
    [0, 0, HALF_THICKNESS],
    plateNormal,
    [0.5, 0.5],
    plateTangent,
    -1,
    1,
  );
  for (let i = 0; i < OUTLINE.length; i++) {
    buffers.indices.push(
      plateCentre,
      plateStart + i,
      plateStart + ((i + 1) % OUTLINE.length),
    );
  }

  const lastRing = ringPositions[ringPositions.length - 1];
  const backNormal: Vec3 = [0, 0, -1];

  if (backDomeUnits === 0) {
    // Flat blue backing, inset by the back bevel like the committed shell.
    const backStart = buffers.positions.length / 3;
    for (let i = 0; i < OUTLINE.length; i++) {
      const position = lastRing[i];
      const uv = facePlateUv(position[0], position[1]);
      addVertex(
        buffers,
        position,
        backNormal,
        [uv.u, uv.v],
        plateTangent,
        1,
        0,
      );
    }
    const backCentre = addVertex(
      buffers,
      [0, 0, backRimZ],
      backNormal,
      [0.5, 0.5],
      plateTangent,
      1,
      0,
    );
    for (let i = 0; i < OUTLINE.length; i++) {
      buffers.indices.push(
        backCentre,
        backStart + ((i + 1) % OUTLINE.length),
        backStart + i,
      );
    }
  } else {
    // Optional shallow crown: each ring is the plate outline scaled toward the
    // centre, with the rim tangent to the back plane and the apex exactly on
    // it, so the envelope never changes.
    const domeStarts: number[] = [];
    let previousW: 1 | -1 = 1;
    for (let ring = 0; ring < DOME_RINGS; ring++) {
      const t = ring / DOME_RINGS;
      const height = backDomeUnits * domeHeightAt(t);
      const slope = backDomeUnits * domeSlopeAt(t);
      const positions = OUTLINE.map((point): Vec3 => {
        const qx = point.x - BEVEL * point.nx;
        const qy = point.y - BEVEL * point.ny;
        return [qx * (1 - t), qy * (1 - t), backRimZ - height];
      });
      domeStarts.push(buffers.positions.length / 3);
      for (let i = 0; i < OUTLINE.length; i++) {
        const point = OUTLINE[i];
        const loopTangent = LOOP_TANGENTS[i];
        const qx = point.x - BEVEL * point.nx;
        const qy = point.y - BEVEL * point.ny;
        // dP/dt (the +V direction) and dP/di (the +U direction); the outward
        // normal is their cross product, exactly like the swept bands.
        const towardsV = normalize([-qx, -qy, -slope]);
        const towardsU: Vec3 = [
          (1 - t) * loopTangent[0],
          (1 - t) * loopTangent[1],
          0,
        ];
        const normal = normalize(cross(towardsV, towardsU));
        const tangent = orthonormalTangent(normal, [
          loopTangent[0],
          loopTangent[1],
          0,
        ]);
        const w = handedness(normal, tangent, towardsV);
        previousW = w;
        addVertex(buffers, positions[i], normal, [point.u, t], tangent, w, 0);
      }
    }

    for (let ring = 0; ring + 1 < DOME_RINGS; ring++) {
      for (let i = 0; i < OUTLINE.length; i++) {
        addBandQuad(buffers, domeStarts, ring, i);
      }
    }

    const apex = addVertex(
      buffers,
      [0, 0, backRimZ - backDomeUnits],
      backNormal,
      [0.5, 1],
      plateTangent,
      previousW,
      0,
    );
    const lastDomeStart = domeStarts[domeStarts.length - 1];
    for (let i = 0; i < OUTLINE.length; i++) {
      buffers.indices.push(
        lastDomeStart + i,
        apex,
        lastDomeStart + ((i + 1) % OUTLINE.length),
      );
    }
  }

  const positions = Float32Array.from(buffers.positions);
  const indices = Uint16Array.from(buffers.indices);

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  return {
    positions,
    normals: Float32Array.from(buffers.normals),
    uvs: Float32Array.from(buffers.uvs),
    tangents: Float32Array.from(buffers.tangents),
    faceZone: Float32Array.from(buffers.faceZone),
    indices,
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
    boundsUnits: {
      width: maxX - minX,
      height: maxY - minY,
      thickness: maxZ - minZ,
    },
  };
}
