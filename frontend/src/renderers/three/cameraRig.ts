/**
 * The three.js `PerspectiveCamera` adapter for the solved board frame (3D-07).
 *
 * There is exactly **one** framing source in the 3D chain:
 * `boardLayout.frameForAspect` (plan §2.4, reconciliation of 2026-11-18). It
 * solves the committed rig's eye distance, pitch, field of view and projection
 * shift against the real `layoutBoard` extents and owns the numeric gate in
 * `frontend/scripts/check-3d-layout.mjs`. 3D-02's parallel solver lived here and
 * is deleted: this module no longer decides where the camera goes, it only
 * applies a {@link CameraFrame} to a three camera and answers the pure
 * projection questions the rest of the scene asks (where a view ray meets the
 * felt, what the view-projection matrix is).
 *
 * Two consequences the later units depend on:
 *
 * - 3D-08's hit rects must project through this same frame — a second camera
 *   would put the DOM buttons off the tiles (plan §9 R7);
 * - the felt is sized from the frame with {@link groundHit}, so it still reaches
 *   the top and bottom of the window at every supported aspect.
 *
 * Pure math apart from the one adapter call, which takes a three camera as an
 * argument. No DOM, no GPU, no clock.
 */

import type { PerspectiveCamera } from 'three';
import { CAMERA } from '../layoutConstants';
import type { CameraFrame, Vec3 } from './boardLayout';

const DEG = Math.PI / 180;

/** A column-major 4 x 4 matrix, the layout three.js uses. */
export type Mat4 = readonly number[];

/** The camera's right, up and forward axes at a frame (unit vectors). */
export interface CameraAxes {
  readonly right: Vec3;
  readonly up: Vec3;
  readonly forward: Vec3;
}

/** The camera's own axes for a frame: +X right, pithed down by `pitchDeg`. */
export function frameAxes(frame: CameraFrame): CameraAxes {
  const pitch = frame.pitchDeg * DEG;
  const forward: Vec3 = [0, -Math.sin(pitch), -Math.cos(pitch)];
  const right: Vec3 = [1, 0, 0];
  return { right, up: cross(right, forward), forward };
}

/** The vertical field of view a frame resolves to, in degrees. */
export function frameVerticalFieldOfViewDeg(frame: CameraFrame): number {
  return (2 * Math.atan(frame.tanHalfVertical)) / DEG;
}

/** The horizontal field of view a frame resolves to, in degrees (informational). */
export function frameHorizontalFieldOfViewDeg(frame: CameraFrame): number {
  return (2 * Math.atan(frame.tanHalfHorizontal)) / DEG;
}

/** Column-major perspective projection with the frame's lens shift. */
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
   * the frustum stays symmetric in z. It is exactly `CameraFrame.shiftNdcY`
   * (the reference's negative Shift Y plus the solver's safe-area nudge).
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

/** The frame's projection matrix at the committed clip planes. */
export function projectionMatrixForFrame(
  frame: CameraFrame,
  near: number = CAMERA.clipStartUnits,
  far: number = CAMERA.clipEndUnits,
): number[] {
  return perspectiveMatrix(
    frameVerticalFieldOfViewDeg(frame),
    frame.aspect,
    near,
    far,
    frame.shiftNdcY,
  );
}

/** The frame's view matrix (`frame.eye` looking at `frame.target`). */
export function viewMatrixForFrame(frame: CameraFrame): number[] {
  return lookAtMatrix(frame.eye, frame.target);
}

/** The frame's combined view-projection matrix. */
export function viewProjectionForFrame(
  frame: CameraFrame,
  near: number = CAMERA.clipStartUnits,
  far: number = CAMERA.clipEndUnits,
): number[] {
  return multiplyMat4(
    projectionMatrixForFrame(frame, near, far),
    viewMatrixForFrame(frame),
  );
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

/**
 * Apply a solved frame to a three.js `PerspectiveCamera`.
 *
 * The projection matrix is patched after `updateProjectionMatrix` because
 * three's `PerspectiveCamera` has no lens-shift field; `projectionMatrixInverse`
 * is refreshed so any later ray cast or unprojection stays exact. This is the
 * whole camera: there is no distance solve, no second pitch preset and no
 * margin here — those live in `boardLayout.frameForAspect` and nowhere else.
 */
export function applyFrameToCamera(camera: PerspectiveCamera, frame: CameraFrame): void {
  camera.fov = frameVerticalFieldOfViewDeg(frame);
  camera.aspect = frame.aspect;
  camera.near = CAMERA.clipStartUnits;
  camera.far = CAMERA.clipEndUnits;
  camera.position.set(frame.eye[0], frame.eye[1], frame.eye[2]);
  camera.up.set(0, 1, 0);
  camera.lookAt(frame.target[0], frame.target[1], frame.target[2]);
  camera.updateProjectionMatrix();
  camera.projectionMatrix.elements[9] = -frame.shiftNdcY;
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
  frame: CameraFrame,
  ndcX: number,
  ndcY: number,
): GroundPoint | null {
  const { right, up, forward } = frameAxes(frame);
  // The NDC y already includes the lens lift, so remove it before rebuilding
  // the camera-space direction.
  const sx = ndcX * frame.tanHalfHorizontal;
  const sy = (ndcY - frame.shiftNdcY) * frame.tanHalfVertical;

  const direction = normalise([
    forward[0] + sx * right[0] + sy * up[0],
    forward[1] + sx * right[1] + sy * up[1],
    forward[2] + sx * right[2] + sy * up[2],
  ]);
  if (direction[1] >= -1e-9) return null;

  const distance = -frame.eye[1] / direction[1];
  return [frame.eye[0] + distance * direction[0], frame.eye[2] + distance * direction[2]];
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
