/**
 * The camera adapter's numbers (3D-07 acceptance): the rendered camera *is*
 * 3D-06's solved frame, and no second solver remains.
 *
 * These are exact assertions, not a look. The old 3D-02 rig had its own
 * distance/shift solve and reproduced the reference 16:9 frame; this unit
 * deletes that solver, so the tests that matter change shape:
 *
 * - a real three `PerspectiveCamera` fed a frame has the frame's eye, pitch,
 *   field of view and projection lift;
 * - projecting a world point through the camera's own matrices equals the pure
 *   `boardLayout.projectPoint` at the same frame (the two projections are one);
 * - the felt's size comes from the same frame, so the 16:9 lift moves it too;
 * - `groundHit` round-trips: the world point it returns projects back to the NDC
 *   point it was asked about.
 *
 * The 16:9 reference corner pixels are printed by `check-3d-layout.mjs` from
 * `frameForAspect`, which is now the only framing source (§2.4); nothing here
 * reproduces a solver that no longer exists.
 */

import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CAMERA } from '../layoutConstants';
import { boardFixture } from './boardFixture';
import {
  frameForAspect,
  layoutBoard,
  pitchForAspect,
  projectPoint as projectBoardPoint,
  referenceFrame,
} from './boardLayout';
import {
  applyFrameToCamera,
  frameHorizontalFieldOfViewDeg,
  frameVerticalFieldOfViewDeg,
  groundHit,
  projectionMatrixForFrame,
  projectPoint,
} from './cameraRig';

const layout = layoutBoard(boardFixture());

/** A point in front of the camera, on the felt near the given world X/Z. */
function feltPoint(x: number, z: number): readonly [number, number, number] {
  return [x, 0, z];
}

describe('the three camera is the solved frame', () => {
  it('applies the frame eye, pitch, field of view and lens lift', () => {
    for (const aspect of CAMERA.supportedAspects) {
      const frame = frameForAspect(aspect, layout);
      const camera = new PerspectiveCamera();
      applyFrameToCamera(camera, frame);

      expect(camera.position.x, `eye x at ${aspect}`).toBeCloseTo(frame.eye[0], 12);
      expect(camera.position.y, `eye y at ${aspect}`).toBeCloseTo(frame.eye[1], 12);
      expect(camera.position.z, `eye z at ${aspect}`).toBeCloseTo(frame.eye[2], 12);
      expect(camera.aspect).toBeCloseTo(frame.aspect, 12);
      expect(camera.fov).toBeCloseTo(frameVerticalFieldOfViewDeg(frame), 12);
      expect(camera.projectionMatrix.elements[9]).toBeCloseTo(-frame.shiftNdcY, 12);

      // The view direction's pitch below horizontal is the frame's pitch.
      const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const pitch = (Math.atan2(-forward.y, -forward.z) * 180) / Math.PI;
      expect(pitch, `pitch at ${aspect}`).toBeCloseTo(frame.pitchDeg, 9);
    }
  });

  it('projects every point exactly as the pure frame does', () => {
    for (const aspect of CAMERA.supportedAspects) {
      const frame = frameForAspect(aspect, layout);
      const camera = new PerspectiveCamera();
      applyFrameToCamera(camera, frame);
      camera.updateMatrixWorld(true);

      for (const point of [
        feltPoint(0, 0),
        feltPoint(-12.5, 12.5),
        feltPoint(12.5, -12.5),
        feltPoint(-6, -7),
        [0, 6, 0] as const,
      ]) {
        const viaCamera = new Vector3(point[0], point[1], point[2]).project(camera);
        const pure = projectBoardPoint(point, frame);
        expect(viaCamera.x, `x at ${aspect}`).toBeCloseTo(pure.x, 10);
        expect(viaCamera.y, `y at ${aspect}`).toBeCloseTo(pure.y, 10);
      }
    }
  });

  it('builds the same projection matrix the adapter patches', () => {
    const frame = frameForAspect(16 / 9, layout);
    const camera = new PerspectiveCamera();
    applyFrameToCamera(camera, frame);
    const expected = projectionMatrixForFrame(frame);
    camera.projectionMatrix.elements.forEach((value, index) => {
      expect(value, `element ${index}`).toBeCloseTo(expected[index], 12);
    });
  });

  it('has one framing source: the 16:9 frame is the committed rig', () => {
    // `frameForAspect` keeps the signed-off reference distance at 16:9; the
    // adapter adds nothing, so the rendered eye is the reference's.
    const frame = frameForAspect(16 / 9, layout);
    expect(frame.pitchDeg).toBe(CAMERA.pitchDeg);
    expect(frame.distanceUnits).toBeCloseTo(CAMERA.distanceUnits, 6);
    const camera = new PerspectiveCamera();
    applyFrameToCamera(camera, frame);
    // The reference's Blender (0, -48.85, 58.57) is three's (0, 58.57, 48.85).
    expect(camera.position.y).toBeCloseTo(58.57, 1);
    expect(camera.position.z).toBeCloseTo(48.85, 1);
    // The lens is the committed 75 mm on 36 mm: 26.99° horizontal.
    expect(frameHorizontalFieldOfViewDeg(frame)).toBeCloseTo(26.9915, 3);
  });

  it('uses the steeper portrait preset, still from the one solver', () => {
    expect(pitchForAspect(16 / 9)).toBe(CAMERA.pitchDeg);
    expect(pitchForAspect(9 / 16)).toBe(CAMERA.portraitPitchDeg);
    const portrait = frameForAspect(9 / 16, layout);
    expect(portrait.pitchDeg).toBe(CAMERA.portraitPitchDeg);
    expect(frameVerticalFieldOfViewDeg(portrait)).toBeGreaterThan(45);
    // Taller frames get closer than the reference distance (§2.4).
    expect(portrait.distanceUnits).toBeLessThan(CAMERA.distanceUnits);
  });

  it('keeps the shipped frame inside the safe area, and the reference loose', () => {
    for (const aspect of CAMERA.supportedAspects) {
      const frame = frameForAspect(aspect, layout);
      expect(frame.distanceUnits, `distance at ${aspect}`).toBeGreaterThan(0);
      // Every tile corner is inside the frame with the committed margin; the
      // layout gate asserts the exact numbers, this only proves the adapter's
      // frame is the one that passed it.
      let margin = Number.POSITIVE_INFINITY;
      for (const tile of layout.tiles) {
        for (const corner of [
          [-tile.pose.sizeUnits[0] / 2, 0, 0],
          [tile.pose.sizeUnits[0] / 2, 0, 0],
        ] as const) {
          const world: readonly [number, number, number] = [
            tile.pose.position[0] + corner[0],
            tile.pose.position[1] + corner[1],
            tile.pose.position[2] + corner[2],
          ];
          const ndc = projectBoardPoint(world, frame);
          margin = Math.min(margin, (1 - Math.abs(ndc.x)) / 2, (1 - Math.abs(ndc.y)) / 2);
        }
      }
      expect(margin, `tile margin at ${aspect}`).toBeGreaterThanOrEqual(
        CAMERA.safeAreaMargin - 1e-9,
      );
    }
    // The unsolved reference pose is still exposed for the gate's comparison.
    expect(referenceFrame(16 / 9).distanceUnits).toBe(CAMERA.distanceUnits);
  });

  it('projects the felt hit back to the NDC point it was asked about', () => {
    for (const aspect of CAMERA.supportedAspects) {
      const frame = frameForAspect(aspect, layout);
      for (const [ndcX, ndcY] of [
        [0, 1],
        [0, -1],
        [-1, -0.5],
        [1, 0.25],
      ] as const) {
        const hit = groundHit(frame, ndcX, ndcY);
        expect(hit, `hit at ${aspect}`).not.toBeNull();
        if (!hit) continue;
        const back = projectBoardPoint([hit[0], 0, hit[1]], frame);
        expect(back.x, `ndc x at ${aspect}`).toBeCloseTo(ndcX, 9);
        expect(back.y, `ndc y at ${aspect}`).toBeCloseTo(ndcY, 9);
      }
      // A ray at or above the horizon never meets the felt. The frame's
      // vertical half-FOV is narrow and the pitch steep, so the horizon is
      // several frame heights above the top edge.
      expect(groundHit(frame, 0, 40)).toBeNull();
    }
  });

  it('matches the projection matrix geometry three derives', () => {
    // The adapter patches only the lens shift; x/y scale and the clip range
    // come from three's own updateProjectionMatrix, so f = 1 / tan(fovY / 2).
    const frame = frameForAspect(3 / 2, layout);
    const matrix = projectionMatrixForFrame(frame, 1, 600);
    const f = 1 / Math.tan((frameVerticalFieldOfViewDeg(frame) * Math.PI) / 360);
    expect(matrix[0]).toBeCloseTo(f / frame.aspect, 12);
    expect(matrix[5]).toBeCloseTo(f, 12);
    expect(matrix[10]).toBeCloseTo((600 + 1) / (1 - 600), 12);
    expect(matrix[11]).toBe(-1);
  });

  it('round-trips a view-projection like three\'s matrices do', () => {
    // `projectPoint` in cameraRig is three's own clip-space rule; the board's
    // `projectPoint` is the hand-rolled one. They already agree above through
    // the camera; this pins the matrix-level helper too.
    const frame = frameForAspect(4 / 3, layout);
    const projected = projectPoint(
      [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ],
      [1, 2, 3],
    );
    expect(projected.inFront).toBe(true);
    expect(projected.ndcX).toBeCloseTo(1, 12);
    expect(projected.ndcY).toBeCloseTo(2, 12);
    expect(projected.ndcZ).toBeCloseTo(3, 12);
    // w = 0 is behind / on the eye plane: three's clip rule says not in front,
    // and the helper must not divide by it.
    const fallback = projectPoint(
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
      [1, 1, 1],
    );
    expect(fallback.inFront).toBe(false);
    expect(Number.isFinite(fallback.ndcX)).toBe(true);
    expect(frame.distanceUnits).toBeGreaterThan(0);
  });
});
