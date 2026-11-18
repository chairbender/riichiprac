/**
 * The committed whole-table camera rig, plus its aspect fit (3D-02).
 *
 * Decision D7 and user decision 2 (2026-11-18) adopt the already-signed-off
 * whole-table rig from `layoutConstants.ts`: a 75 mm lens on a 36 mm horizontal
 * gauge, pitched 50 deg down, centred on X = 0, with the negative Shift Y from
 * the reference reproduced as a projection offset. Nothing here invents a
 * second framing.
 *
 * Two things this module owns that the 2.5D reference cannot answer:
 *
 * - **The aspect fit.** The reference is one 1920 x 1080 frame. At every other
 *   aspect the eye is solved back to the smallest distance that keeps the mat
 *   corners and the human hand inside the frame with the reference's own inset
 *   (see {@link FIT_MARGIN}). At 16:9 that solution is the committed distance,
 *   so the reference frame is reproduced exactly; the solver only ever moves
 *   the camera *back*, never in past the committed rig.
 * - **The portrait preset.** A portrait frame keeps the committed horizontal
 *   field of view and would leave the table as a postage stamp, so portrait
 *   uses the steeper committed portrait pitch ({@link CAMERA.portraitPitchDeg}).
 *
 * Pure math: no DOM and no three.js (the three `PerspectiveCamera` is applied
 * from {@link applyPoseToCamera}). That keeps the framing numbers printable and
 * testable in Node without a GPU.
 */

import type { PerspectiveCamera } from 'three';
import { CAMERA, HAND, TABLE } from '../layoutConstants';

const DEG = Math.PI / 180;

/** A point or direction in 3D world space: +X right, +Y up, +Z toward the human. */
export type Vec3 = readonly [number, number, number];

/** A column-major 4 x 4 matrix, the layout three.js uses. */
export type Mat4 = readonly number[];

/**
 * The fraction of the frame kept clear of the framing subject when the eye has
 * to move back.
 *
 * The committed 16:9 frame is the reference: at 76 units the mat's near corners
 * sit 0.36 % of the frame height above the bottom edge, and the reference note
 * only claims a width margin. 0.4 % therefore keeps the committed inset (the
 * 16:9 solution lands within half a pixel of the reference) while still giving
 * the other aspects a non-zero edge clearance. A larger margin would move the
 * 16:9 camera back and stop reproducing the signed-off reference.
 */
export const FIT_MARGIN = 0.004;

/**
 * The warm-up points every aspect is fitted to: the four mat corners plus the
 * human hand's front/bottom and front/top corners at its committed back radius,
 * so the near edge and the top of the reclined hand both stay in frame.
 */
export const FRAMING_SUBJECT = {
  /** Half of the 700 mm mat. */
  matHalfUnits: TABLE.matSizeUnits / 2,
  /** Half the 13-tile hand plus the 0.2625-unit draw gap, in units. */
  handHalfWidthUnits: (HAND.concealedCount * HAND.pitchUnits) / 2 + 0.3,
  /** The hand's front edge, at its committed back radius from the table centre. */
  handFrontUnits: HAND.backRadiusUnits,
  /** How far the reclined hand stands above the felt. */
  handTopUnits: 0.95,
} as const;

/** Every point the framing solver must keep inside the frame. */
export function framingSubjectPoints(): readonly Vec3[] {
  const half = FRAMING_SUBJECT.matHalfUnits;
  const handX = FRAMING_SUBJECT.handHalfWidthUnits;
  const front = FRAMING_SUBJECT.handFrontUnits;
  const top = FRAMING_SUBJECT.handTopUnits;
  return [
    [-half, 0, -half],
    [-half, 0, half],
    [half, 0, -half],
    [half, 0, half],
    [-handX, 0, front],
    [-handX, top, front],
    [handX, 0, front],
    [handX, top, front],
  ];
}

/** The horizontal field of view of the committed lens, in degrees. */
export function horizontalFieldOfViewDeg(): number {
  return 2 * Math.atan((CAMERA.sensorWidthMm / 2) / CAMERA.lensMm) / DEG;
}

/**
 * The vertical field of view for an aspect ratio: a horizontal sensor fit, so
 * the horizontal field is fixed and the vertical one follows from the aspect.
 */
export function verticalFieldOfViewDeg(aspect: number): number {
  const fovX = horizontalFieldOfViewDeg() * DEG;
  return (2 * Math.atan(Math.tan(fovX / 2) / normaliseAspect(aspect))) / DEG;
}

/** The committed pitch for an aspect: 50 deg landscape, 62 deg portrait. */
export function pitchForAspect(aspect: number): number {
  return normaliseAspect(aspect) < 1 ? CAMERA.portraitPitchDeg : CAMERA.pitchDeg;
}

/**
 * The projection lift, in NDC y, that reproduces the reference's negative Shift
 * Y. Blender measures the shift against the sensor **width** and its positive
 * direction moves the image down, so a -0.02 shift lifts the image by
 * `2 * 0.02 * aspect` NDC (38.4 px at 1920 x 1080, as the reference records).
 */
export function shiftNdcY(aspect: number): number {
  return -2 * CAMERA.shiftY * normaliseAspect(aspect);
}

/** Fall back to the reference aspect for a nonsensical or absent one. */
function normaliseAspect(aspect: number): number {
  return Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
}

/** Column-major perspective projection with the rig's lens shift. */
export function perspectiveMatrix(
  fovYDeg: number,
  aspect: number,
  near: number,
  far: number,
  projectionShiftNdcY: number,
): number[] {
  const f = 1 / Math.tan((fovYDeg * DEG) / 2);
  const m = new Array<number>(16).fill(0);
  m[0] = f / aspect; // x / (-z)
  m[5] = f; // y / (-z)
  m[8] = 0;
  /*
   * A point's NDC y is `(m[5] * y + m[9] * z) / -z`, so `m[9] = -lift` adds
   * `+lift` to every projected y. That is the lens shift: the content rises,
   * the frustum stays symmetric in z.
   */
  m[9] = -projectionShiftNdcY;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

/** Column-major look-at view matrix (`eye` looking at `target`, +Y up). */
export function lookAtMatrix(eye: Vec3, target: Vec3): number[] {
  const z = normalise([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = normalise(cross([0, 1, 0], z));
  const y = cross(z, x);
  return [
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ];
}

/** Column-major 4 x 4 product `a * b`. */
export function multiplyMat4(a: Mat4, b: Mat4): number[] {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += a[k * 4 + row] * b[column * 4 + k];
      }
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/** The projected NDC position of a world point. */
export interface ProjectedPoint {
  readonly ndcX: number;
  readonly ndcY: number;
  readonly ndcZ: number;
  /** True when the point is in front of the camera (clip w > 0). */
  readonly inFront: boolean;
}

/** Project a world point through a view-projection matrix. */
export function projectPoint(viewProjection: Mat4, point: Vec3): ProjectedPoint {
  const x = viewProjection[0] * point[0] + viewProjection[4] * point[1] + viewProjection[8] * point[2] + viewProjection[12];
  const y = viewProjection[1] * point[0] + viewProjection[5] * point[1] + viewProjection[9] * point[2] + viewProjection[13];
  const z = viewProjection[2] * point[0] + viewProjection[6] * point[1] + viewProjection[10] * point[2] + viewProjection[14];
  const w = viewProjection[3] * point[0] + viewProjection[7] * point[1] + viewProjection[11] * point[2] + viewProjection[15];
  const inFront = w > 0;
  const safeW = w === 0 ? Number.EPSILON : w;
  return { ndcX: x / safeW, ndcY: y / safeW, ndcZ: z / safeW, inFront };
}

/** One resolved camera pose for a viewport aspect. */
export interface RigPose {
  readonly aspect: number;
  readonly portrait: boolean;
  readonly pitchDeg: number;
  /** Eye-to-target distance along the view axis, in tile units. */
  readonly distanceUnits: number;
  readonly eyeUnits: Vec3;
  readonly targetUnits: Vec3;
  readonly fovXDeg: number;
  readonly fovYDeg: number;
  /** The lens lift in NDC y (positive raises the projected content). */
  readonly shiftNdcY: number;
  readonly view: Mat4;
  readonly projection: Mat4;
  readonly viewProjection: Mat4;
}

/** The committed aim point in 3D world space. */
export const RIG_TARGET_UNITS: Vec3 = [
  CAMERA.targetUnits[0],
  CAMERA.targetUnits[1],
  CAMERA.targetUnits[2],
];

/** The eye for a pitch and distance: above and toward +Z of the target. */
export function eyeFor(pitchDeg: number, distanceUnits: number): Vec3 {
  const pitch = pitchDeg * DEG;
  return [
    RIG_TARGET_UNITS[0],
    RIG_TARGET_UNITS[1] + distanceUnits * Math.sin(pitch),
    RIG_TARGET_UNITS[2] + distanceUnits * Math.cos(pitch),
  ];
}

function poseAt(aspect: number, distanceUnits: number): RigPose {
  const pitchDeg = pitchForAspect(aspect);
  const eye = eyeFor(pitchDeg, distanceUnits);
  const fovYDeg = verticalFieldOfViewDeg(aspect);
  const lift = shiftNdcY(aspect);
  const view = lookAtMatrix(eye, RIG_TARGET_UNITS);
  const projection = perspectiveMatrix(
    fovYDeg,
    aspect,
    CAMERA.clipStartUnits,
    CAMERA.clipEndUnits,
    lift,
  );
  return {
    aspect,
    portrait: aspect < 1,
    pitchDeg,
    distanceUnits,
    eyeUnits: eye,
    targetUnits: RIG_TARGET_UNITS,
    fovXDeg: horizontalFieldOfViewDeg(),
    fovYDeg,
    shiftNdcY: lift,
    view,
    projection,
    viewProjection: multiplyMat4(projection, view),
  };
}

/** True when every framing point projects inside the frame with the fit margin. */
export function framesSubject(pose: RigPose, margin = FIT_MARGIN): boolean {
  const limit = 1 - 2 * margin;
  for (const point of framingSubjectPoints()) {
    const projected = projectPoint(pose.viewProjection, point);
    if (!projected.inFront || projected.ndcZ < -1 || projected.ndcZ > 1) return false;
    if (Math.abs(projected.ndcX) > limit || Math.abs(projected.ndcY) > limit) {
      return false;
    }
  }
  return true;
}

/** The farthest distance the solver will consider (the clip end is 600). */
const MAX_FIT_DISTANCE_UNITS = 4 * CAMERA.distanceUnits;
const FIT_ITERATIONS = 48;

/**
 * The eye distance for an aspect: the committed distance, moved back only as
 * far as the fit needs. Monotone in distance, so a fixed-iteration bisection is
 * deterministic and exact enough for framing assertions (~1e-12 units).
 */
export function fitDistanceUnits(aspect: number): number {
  const committed = CAMERA.distanceUnits;
  if (framesSubject(poseAt(aspect, committed))) return committed;

  let near: number = committed;
  let far: number = MAX_FIT_DISTANCE_UNITS;
  for (let step = 0; step < FIT_ITERATIONS; step += 1) {
    const middle = (near + far) / 2;
    if (framesSubject(poseAt(aspect, middle))) {
      far = middle;
    } else {
      near = middle;
    }
  }
  return far;
}

/** Resolve the full rig pose for a viewport aspect. */
export function rigPoseForAspect(aspect: number): RigPose {
  const resolved = normaliseAspect(aspect);
  return poseAt(resolved, fitDistanceUnits(resolved));
}

/** One mat corner or hand corner, projected to CSS pixels. */
export interface FramedPoint {
  readonly label: string;
  readonly x: number;
  readonly y: number;
}

/** The numbers this unit prints (and 3D-06 gates from the real layout). */
export interface FramingReport {
  readonly aspect: number;
  readonly width: number;
  readonly height: number;
  readonly pitchDeg: number;
  readonly distanceUnits: number;
  readonly fovXDeg: number;
  readonly fovYDeg: number;
  readonly shiftNdcY: number;
  /** Smallest distance from a projected point to a frame edge, as a fraction of that edge. */
  readonly marginX: number;
  readonly marginY: number;
  readonly points: readonly FramedPoint[];
}

/**
 * Project the framing subject into a `width x height` frame and report the
 * numbers. `height` defaults to the frame implied by the aspect.
 */
export function framingReport(
  aspect: number,
  width = 1920,
  height = width / normaliseAspect(aspect),
): FramingReport {
  const pose = rigPoseForAspect(aspect);
  const labels = [
    'mat far left',
    'mat near left',
    'mat far right',
    'mat near right',
    'hand near left',
    'hand far left',
    'hand near right',
    'hand far right',
  ];
  let marginX = Number.POSITIVE_INFINITY;
  let marginY = Number.POSITIVE_INFINITY;
  const points = framingSubjectPoints().map((point, index) => {
    const projected = projectPoint(pose.viewProjection, point);
    marginX = Math.min(marginX, (1 - Math.abs(projected.ndcX)) / 2);
    marginY = Math.min(marginY, (1 - Math.abs(projected.ndcY)) / 2);
    return {
      label: labels[index] ?? `point ${index}`,
      x: (projected.ndcX * 0.5 + 0.5) * width,
      y: (0.5 - projected.ndcY * 0.5) * height,
    };
  });
  return {
    aspect: pose.aspect,
    width,
    height,
    pitchDeg: pose.pitchDeg,
    distanceUnits: pose.distanceUnits,
    fovXDeg: pose.fovXDeg,
    fovYDeg: pose.fovYDeg,
    shiftNdcY: pose.shiftNdcY,
    marginX,
    marginY,
    points,
  };
}

/**
 * Apply a resolved pose to a three.js `PerspectiveCamera`.
 *
 * The projection matrix is patched after `updateProjectionMatrix` because
 * three's `PerspectiveCamera` has no lens-shift field; `projectionMatrixInverse`
 * is refreshed so any later ray cast or unprojection stays exact.
 */
export function applyPoseToCamera(camera: PerspectiveCamera, pose: RigPose): void {
  camera.fov = pose.fovYDeg;
  camera.aspect = pose.aspect;
  camera.near = CAMERA.clipStartUnits;
  camera.far = CAMERA.clipEndUnits;
  camera.position.set(pose.eyeUnits[0], pose.eyeUnits[1], pose.eyeUnits[2]);
  camera.up.set(0, 1, 0);
  camera.lookAt(pose.targetUnits[0], pose.targetUnits[1], pose.targetUnits[2]);
  camera.updateProjectionMatrix();
  camera.projectionMatrix.elements[9] = -pose.shiftNdcY;
  camera.projectionMatrixInverse.copy(camera.projectionMatrix);
  camera.projectionMatrixInverse.invert();
}

/** One point where a view ray meets the felt plane, in world X/Z units. */
export type GroundPoint = readonly [number, number];

/**
 * Where the ray through an NDC point meets the felt plane (`y = 0`), or null
 * when the ray points at or above the horizon and never reaches it.
 *
 * The frame corners of a full-window view land outside the 25-unit mat, so the
 * felt has to be larger than the play area to reach the screen edges (§2.4).
 * This is the pure geometry that decides how large, and the felt test asserts
 * coverage at every supported aspect.
 */
export function groundHit(
  pose: RigPose,
  ndcX: number,
  ndcY: number,
): GroundPoint | null {
  const forward = normalise([
    pose.targetUnits[0] - pose.eyeUnits[0],
    pose.targetUnits[1] - pose.eyeUnits[1],
    pose.targetUnits[2] - pose.eyeUnits[2],
  ]);
  const right = normalise(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);

  const tanHalfY = Math.tan((pose.fovYDeg * DEG) / 2);
  const tanHalfX = tanHalfY * pose.aspect;
  // The NDC y already includes the lens lift, so remove it before rebuilding
  // the camera-space direction.
  const sx = ndcX * tanHalfX;
  const sy = (ndcY - pose.shiftNdcY) * tanHalfY;

  const direction = normalise([
    forward[0] + sx * right[0] + sy * up[0],
    forward[1] + sx * right[1] + sy * up[1],
    forward[2] + sx * right[2] + sy * up[2],
  ]);
  if (direction[1] >= -1e-9) return null;

  const distance = -pose.eyeUnits[1] / direction[1];
  return [
    pose.eyeUnits[0] + distance * direction[0],
    pose.eyeUnits[2] + distance * direction[2],
  ];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalise(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (length === 0) return [0, 0, 0];
  return [v[0] / length, v[1] / length, v[2] / length];
}
