/**
 * Parser and geometry helpers for `frontend/public/table/table_layout.json`
 * (the Task 3 / 3A export).
 *
 * The compositor only needs a small part of the published layout:
 *
 *  - the top-level `lighting` block (`keyLightDir`, `keyLightColor`,
 *    `ambientColor`, `cameraPos`), which is the rig the blank shells were baked
 *    under;
 *  - the scene `camera` block, used to reconstruct each slot's world position
 *    from its published normalized anchor and `depth`;
 *  - each slot's `bucket` and `basis` (`tangent`, `bitangent`, `normal`), the
 *    world-space frame that makes carved relief lighting orientation-aware.
 *
 * The layout does not publish a 3D position per slot, only a normalized screen
 * anchor and a view-axis depth. Both were produced by projecting the anchor
 * through the rig camera (`tools/render/table_layout.py`), so the exact world
 * position is recovered with the inverse of that pinhole, not approximated.
 *
 * `basisConvention` in the file is authoritative: `tangent` is glyph left to
 * right, `bitangent` glyph top to bottom, and `normal = bitangent x tangent`
 * (T x B points into the tile body for the published TL/TR/BR/BL order, which
 * is exactly what a tangent normal map authored x-right/y-down/z-out expects).
 */
import type { FaceUpShellId } from './tiles';

export type Vec3 = readonly [number, number, number];

export interface SlotBasis {
  readonly tangent: Vec3;
  readonly bitangent: Vec3;
  readonly normal: Vec3;
}

export interface FaceQuadPoint {
  readonly x: number;
  readonly y: number;
}

export interface TableSlot {
  readonly id: string;
  readonly zone: string;
  readonly seat: string;
  readonly row: number;
  readonly col: number;
  /** Normalized top-left screen anchor in [0, 1]. */
  readonly anchor: { readonly x: number; readonly y: number };
  /** View-axis depth from the rig camera, in rig world units. */
  readonly depth: number;
  readonly scale: number;
  readonly bucket: string;
  /** Normalized screen offsets of the face quad, TL/TR/BR/BL. */
  readonly faceQuad: readonly [
    FaceQuadPoint,
    FaceQuadPoint,
    FaceQuadPoint,
    FaceQuadPoint,
  ];
  readonly basis: SlotBasis;
}

export interface TableLighting {
  readonly keyLightDir: Vec3;
  readonly keyLightColor: Vec3;
  readonly ambientColor: Vec3;
  readonly cameraPos: Vec3;
  readonly keyLightEnergyW?: number;
  readonly ambientStrength?: number;
}

export interface TableCamera {
  readonly eye: Vec3;
  readonly target: Vec3;
  readonly focalPixels: number;
  readonly shiftX: number;
  readonly shiftY: number;
  readonly resolution: readonly [number, number];
}

export interface TableLayoutManifest {
  readonly version: number;
  readonly generatedBy: string;
  readonly referenceResolution: { readonly width: number; readonly height: number };
  readonly camera: TableCamera;
  readonly lighting: TableLighting;
  readonly slots: readonly TableSlot[];
}

function fail(message: string): never {
  throw new Error(`table_layout.json: ${message}`);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function finite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${field} must be a finite number`);
  }
  return value;
}

function positive(value: unknown, field: string): number {
  const number = finite(value, field);
  if (number <= 0) fail(`${field} must be positive`);
  return number;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${field} must be a string`);
  return value;
}

function vec3(value: unknown, field: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) fail(`${field} must be [x, y, z]`);
  return [
    finite(value[0], `${field}[0]`),
    finite(value[1], `${field}[1]`),
    finite(value[2], `${field}[2]`),
  ] as const;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a: Vec3): number => Math.sqrt(dot(a, a));
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
] as const;

export function normalizeVec3(value: Vec3): Vec3 {
  const size = length(value);
  if (size === 0) throw new Error('cannot normalize a zero vector');
  return [value[0] / size, value[1] / size, value[2] / size] as const;
}

export function subVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]] as const;
}

function unit(value: unknown, field: string, tolerance = 5e-3): Vec3 {
  const vector = vec3(value, field);
  const size = length(vector);
  if (Math.abs(size - 1) > tolerance) {
    fail(`${field} must be unit length (got ${size.toFixed(6)})`);
  }
  return vector;
}

function parseBasis(raw: unknown, field: string): SlotBasis {
  const value = object(raw, field);
  const tangent = unit(value.tangent, `${field}.tangent`);
  const bitangent = unit(value.bitangent, `${field}.bitangent`);
  const normal = unit(value.normal, `${field}.normal`);
  if (Math.abs(dot(tangent, bitangent)) > 5e-3) fail(`${field} tangent/bitangent are not orthogonal`);
  if (Math.abs(dot(tangent, normal)) > 5e-3) fail(`${field} tangent/normal are not orthogonal`);
  if (Math.abs(dot(bitangent, normal)) > 5e-3) fail(`${field} bitangent/normal are not orthogonal`);
  // The published convention is normal = bitangent x tangent (body-inward
  // T x B), not tangent x bitangent: the sign is what tells a shader which
  // side of the plate is visible.
  const published = cross(bitangent, tangent);
  if (dot(published, normal) < 0.999) {
    fail(`${field}.normal must be bitangent x tangent (the visible face's outward direction)`);
  }
  return { tangent, bitangent, normal };
}

function parseFaceQuad(raw: unknown, field: string): TableSlot['faceQuad'] {
  if (!Array.isArray(raw) || raw.length !== 4) fail(`${field} must have four corners`);
  const corners = raw.map((entry, index) => {
    const point = object(entry, `${field}[${index}]`);
    return {
      x: finite(point.x, `${field}[${index}].x`),
      y: finite(point.y, `${field}[${index}].y`),
    };
  });
  return corners as unknown as TableSlot['faceQuad'];
}

export function parseTableLayoutManifest(raw: unknown): TableLayoutManifest {
  const root = object(raw, 'root');
  const reference = object(root.referenceResolution, 'referenceResolution');
  const cameraRaw = object(root.camera, 'camera');
  const resolution = cameraRaw.resolution;
  if (!Array.isArray(resolution) || resolution.length !== 2) {
    fail('camera.resolution must be [width, height]');
  }
  const lightingRaw = object(root.lighting, 'lighting');
  const slotsRaw = root.slots;
  if (!Array.isArray(slotsRaw) || slotsRaw.length === 0) fail('slots must be a non-empty array');

  const slots = slotsRaw.map((entry, index): TableSlot => {
    const slot = object(entry, `slots[${index}]`);
    const anchor = object(slot.anchor, `slots[${index}].anchor`);
    return {
      id: text(slot.id, `slots[${index}].id`),
      zone: text(slot.zone, `slots[${index}].zone`),
      seat: text(slot.seat, `slots[${index}].seat`),
      row: finite(slot.row, `slots[${index}].row`),
      col: finite(slot.col, `slots[${index}].col`),
      anchor: {
        x: finite(anchor.x, `slots[${index}].anchor.x`),
        y: finite(anchor.y, `slots[${index}].anchor.y`),
      },
      depth: positive(slot.depth, `slots[${index}].depth`),
      scale: positive(slot.scale, `slots[${index}].scale`),
      bucket: text(slot.bucket, `slots[${index}].bucket`),
      faceQuad: parseFaceQuad(slot.faceQuad, `slots[${index}].faceQuad`),
      basis: parseBasis(slot.basis, `slots[${index}].basis`),
    };
  });

  const ids = new Set<string>();
  for (const slot of slots) {
    if (ids.has(slot.id)) fail(`duplicate slot id ${slot.id}`);
    ids.add(slot.id);
  }

  const lighting: TableLighting = {
    keyLightDir: unit(lightingRaw.keyLightDir, 'lighting.keyLightDir'),
    keyLightColor: vec3(lightingRaw.keyLightColor, 'lighting.keyLightColor'),
    ambientColor: vec3(lightingRaw.ambientColor, 'lighting.ambientColor'),
    cameraPos: vec3(lightingRaw.cameraPos, 'lighting.cameraPos'),
    ...(lightingRaw.keyLightEnergyW === undefined
      ? {}
      : { keyLightEnergyW: finite(lightingRaw.keyLightEnergyW, 'lighting.keyLightEnergyW') }),
    ...(lightingRaw.ambientStrength === undefined
      ? {}
      : { ambientStrength: finite(lightingRaw.ambientStrength, 'lighting.ambientStrength') }),
  };

  return {
    version: finite(root.version, 'version'),
    generatedBy: text(root.generatedBy, 'generatedBy'),
    referenceResolution: {
      width: positive(reference.width, 'referenceResolution.width'),
      height: positive(reference.height, 'referenceResolution.height'),
    },
    camera: {
      eye: vec3(cameraRaw.eye, 'camera.eye'),
      target: vec3(cameraRaw.target, 'camera.target'),
      focalPixels: positive(cameraRaw.focalPixels, 'camera.focalPixels'),
      shiftX: finite(cameraRaw.shiftX, 'camera.shiftX'),
      shiftY: finite(cameraRaw.shiftY, 'camera.shiftY'),
      resolution: [
        positive(resolution[0], 'camera.resolution[0]'),
        positive(resolution[1], 'camera.resolution[1]'),
      ] as const,
    },
    lighting,
    slots,
  };
}

/** The rig camera's world axes: forward, right and up, unit length. */
export function cameraAxes(camera: TableCamera): {
  readonly forward: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
} {
  const forward = normalizeVec3(subVec3(camera.target, camera.eye));
  const right = normalizeVec3(cross(forward, [0, 0, 1]));
  const up = cross(right, forward);
  return { forward, right, up };
}

/**
 * Recover a slot's world position from its published normalized anchor and
 * view-axis depth by inverting `pinhole_point_px` in
 * `tools/render/table_layout.py`:
 *
 *   px = W/2 + shiftX*W + focal * (P-eye).right / depth
 *   py = H/2 + shiftY*W - focal * (P-eye).up / depth
 */
export function worldPositionOfSlot(layout: TableLayoutManifest, slot: TableSlot): Vec3 {
  const { eye, forward, right, up } = {
    eye: layout.camera.eye,
    ...cameraAxes(layout.camera),
  };
  const [width, height] = layout.camera.resolution;
  const focal = layout.camera.focalPixels;
  const px = slot.anchor.x * width;
  const py = slot.anchor.y * height;
  const dx = (px - width / 2 - layout.camera.shiftX * width) / focal;
  const dy = -(py - height / 2 - layout.camera.shiftY * width) / focal;
  const alongRight = dx * slot.depth;
  const alongUp = dy * slot.depth;
  return [
    eye[0] + forward[0] * slot.depth + right[0] * alongRight + up[0] * alongUp,
    eye[1] + forward[1] * slot.depth + right[1] * alongRight + up[1] * alongUp,
    eye[2] + forward[2] * slot.depth + right[2] * alongRight + up[2] * alongUp,
  ] as const;
}

/** Project a world point back to the layout's normalized anchor space. */
export function projectWorldPoint(
  layout: TableLayoutManifest,
  point: Vec3,
): { readonly x: number; readonly y: number; readonly depth: number } {
  const { eye, forward, right, up } = {
    eye: layout.camera.eye,
    ...cameraAxes(layout.camera),
  };
  const [width, height] = layout.camera.resolution;
  const focal = layout.camera.focalPixels;
  const relative = subVec3(point, eye);
  const depth = dot(relative, forward);
  if (depth <= 0) throw new Error('world point is behind the rig camera');
  const x =
    (width / 2 + layout.camera.shiftX * width + (focal * dot(relative, right)) / depth) / width;
  const y =
    (height / 2 + layout.camera.shiftY * width - (focal * dot(relative, up)) / depth) / height;
  return { x, y, depth };
}

/** One `(bucket, rounded basis)` group: the unit of the relief decal cache. */
export interface OrientationGroup {
  /** `bucket|t…|b…|n…`; the basis is rounded to `digits` decimals. */
  readonly key: string;
  readonly bucket: string;
  readonly basis: SlotBasis;
  readonly slots: readonly TableSlot[];
  readonly representative: TableSlot;
  /** The representative slot's world position. */
  readonly position: Vec3;
}

function rounded(value: number, digits: number): string {
  const text = value.toFixed(digits);
  return text === `-${(0).toFixed(digits)}` ? (0).toFixed(digits) : text;
}

export function basisKey(basis: SlotBasis, digits = 3): string {
  const vec = (vector: Vec3) => vector.map((value) => rounded(value, digits)).join(',');
  return `t${vec(basis.tangent)}|b${vec(basis.bitangent)}|n${vec(basis.normal)}`;
}

export function orientationGroupKey(bucket: string, basis: SlotBasis, digits = 3): string {
  return `${bucket}|${basisKey(basis, digits)}`;
}

/**
 * Group every published slot by `(bucket, rounded T/B/N)`.
 *
 * The plan's estimate was about 24 pairs for the whole table; the committed
 * layout has more because the four seats have distinct world orientations. The
 * face-up shell catalogue only reaches the south hand and the four ponds (the
 * other zones are face-down: their backs are drawn from bare shell PNGs and
 * never get a lit face), so `reliefGroupForShell` resolves a subset of these.
 *
 * `representative` is the lexicographically first slot id in the group: a
 * deterministic choice, so the baked decal and the numbers in the report never
 * depend on JSON order.
 */
export function groupSlotsByOrientation(
  layout: TableLayoutManifest,
  digits = 3,
): readonly OrientationGroup[] {
  const groups = new Map<
    string,
    { bucket: string; basis: SlotBasis; slots: TableSlot[] }
  >();
  for (const slot of layout.slots) {
    const key = orientationGroupKey(slot.bucket, slot.basis, digits);
    let group = groups.get(key);
    if (!group) {
      group = { bucket: slot.bucket, basis: slot.basis, slots: [] };
      groups.set(key, group);
    }
    group.slots.push(slot);
  }
  return [...groups.entries()]
    .map(([key, group]): OrientationGroup => {
      const slots = [...group.slots].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const representative = slots[0];
      return {
        key,
        bucket: group.bucket,
        basis: group.basis,
        slots,
        representative,
        position: worldPositionOfSlot(layout, representative),
      };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Which published slot stands in for a face-up shell. The shell is a bucket
 * sprite, not a slot, so the representative is the slot whose world basis the
 * shell's own screen rotation implies:
 *
 *  - `shell_hand_slot_NN` is the human hand's slot NN (the drawn tile is the
 *    reserved `hand_south_13`);
 *  - each flat shell's screen rotation (0/90/180/270) is the same on every
 *    pond, because a flat tile's in-plane world orientation is fixed by how it
 *    lies on the mat, not by who discarded it. `shell_flat_sideways` is the
 *    east pond's normal discard and the south pond's turned (riichi/called)
 *    discard; both publish the same world basis (T north, B east). So using
 *    the pond whose normal rotation matches the shell is correct for every
 *    use of that shell.
 *
 * A shell that resolves to no slot gets no relief decal and keeps the Task 5
 * path (carved decal, then flat glyph).
 */
export function shellRepresentativeSlotId(shell: FaceUpShellId): string {
  if (shell === 'shell_flat_upright') return 'river_south_0_3';
  if (shell === 'shell_flat_sideways') return 'river_east_0_3';
  if (shell === 'shell_flat_upright_180') return 'river_north_0_3';
  if (shell === 'shell_flat_sideways_270') return 'river_west_0_3';
  const match = /^shell_hand_slot_(.+)$/.exec(shell);
  if (!match) throw new Error(`${shell} is not a face-up shell`);
  const suffix = match[1] === 'draw' ? '13' : match[1];
  return `hand_south_${suffix}`;
}

/** Resolve a face-up shell to its orientation group, or null if unavailable. */
export function reliefGroupForShell(
  layout: TableLayoutManifest,
  shell: FaceUpShellId,
  groups: readonly OrientationGroup[] = groupSlotsByOrientation(layout),
): OrientationGroup | null {
  let slotId: string;
  try {
    slotId = shellRepresentativeSlotId(shell);
  } catch {
    return null;
  }
  const slot = layout.slots.find((entry) => entry.id === slotId);
  if (!slot) return null;
  return groups.find((group) => group.slots.some((entry) => entry.id === slot.id)) ?? null;
}
