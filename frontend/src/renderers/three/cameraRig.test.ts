/**
 * The camera rig's numbers (3D-02 acceptance).
 *
 * These are exact assertions, not a look: the 16:9 pose must reproduce the
 * committed whole-table rig, the lens shift must be the reference's 38.4 px,
 * and every supported aspect must keep the mat and the human hand in frame.
 */

import { describe, expect, it } from 'vitest';
import { CAMERA, HAND, TABLE } from '../layoutConstants';
import {
  FIT_MARGIN,
  FRAMING_SUBJECT,
  framingReport,
  framingSubjectPoints,
  horizontalFieldOfViewDeg,
  pitchForAspect,
  rigPoseForAspect,
  shiftNdcY,
  verticalFieldOfViewDeg,
} from './cameraRig';

/**
 * The committed 16:9 reference, read from the signed-off rig rather than
 * measured in this unit: the eye is the reference's Blender
 * `(0, -48.85, 58.57)` mapped to three space as `(x, z, -y)`, and the mat
 * corners are where the 76-unit rig puts them in a 1920 x 1080 frame.
 */
const REFERENCE_16_9 = {
  eye: [0, 58.57, 48.85] as const,
  cornerPixels: [
    { label: 'mat far left', x: 366.9, y: 57.9 },
    { label: 'mat near left', x: 227.2, y: 1076.1 },
    { label: 'mat far right', x: 1553.1, y: 57.9 },
    { label: 'mat near right', x: 1692.8, y: 1076.1 },
  ] as const,
};

describe('3D camera rig', () => {
  it('puts the 16:9 eye where the committed rig puts it', () => {
    const pose = rigPoseForAspect(16 / 9);
    expect(pose.pitchDeg).toBe(50);
    expect(pose.portrait).toBe(false);
    // The fit may move back by a fraction of a unit (FIT_MARGIN); the reference
    // distance is the floor.
    expect(pose.distanceUnits).toBeGreaterThanOrEqual(CAMERA.distanceUnits);
    expect(pose.distanceUnits).toBeLessThan(CAMERA.distanceUnits + 0.5);
    expect(pose.eyeUnits[0]).toBeCloseTo(REFERENCE_16_9.eye[0], 6);
    expect(pose.eyeUnits[1]).toBeCloseTo(REFERENCE_16_9.eye[1], 0);
    expect(pose.eyeUnits[2]).toBeCloseTo(REFERENCE_16_9.eye[2], 0);
  });

  it('matches the reference 16:9 mat corners within 1 px', () => {
    const report = framingReport(16 / 9, 1920, 1080);
    for (const expected of REFERENCE_16_9.cornerPixels) {
      const actual = report.points.find((point) => point.label === expected.label);
      expect(actual, expected.label).toBeDefined();
      expect(Math.abs((actual?.x ?? NaN) - expected.x), `${expected.label} x`).toBeLessThan(1);
      expect(Math.abs((actual?.y ?? NaN) - expected.y), `${expected.label} y`).toBeLessThan(1);
    }
    // The X = 0 rig is horizontally symmetric about the frame centre.
    const farLeft = report.points[0];
    const farRight = report.points[2];
    expect(farLeft.x + farRight.x).toBeCloseTo(1920, 6);
  });

  it('reproduces the reference lens and Shift Y as a projection lift', () => {
    expect(horizontalFieldOfViewDeg()).toBeCloseTo(26.9915, 3);
    // Blender measures the -0.02 shift against the sensor width; that is a
    // 38.4 px lift at 1920 x 1080, as the reference note records.
    const pixels = (shiftNdcY(16 / 9) / 2) * 1080;
    expect(pixels).toBeCloseTo(38.4, 6);
    expect(rigPoseForAspect(16 / 9).projection[9]).toBeCloseTo(-shiftNdcY(16 / 9), 12);
  });

  it('uses the steeper committed pitch for a portrait frame', () => {
    expect(pitchForAspect(16 / 9)).toBe(CAMERA.pitchDeg);
    expect(pitchForAspect(1)).toBe(CAMERA.pitchDeg);
    expect(pitchForAspect(3 / 4)).toBe(CAMERA.portraitPitchDeg);
    expect(pitchForAspect(9 / 16)).toBe(CAMERA.portraitPitchDeg);
    const portrait = rigPoseForAspect(9 / 16);
    expect(portrait.pitchDeg).toBe(62);
    expect(portrait.fovYDeg).toBeGreaterThan(45);
    expect(verticalFieldOfViewDeg(16 / 9)).toBeCloseTo(15.3769, 3);
  });

  it('keeps the mat and the human hand in frame at every supported aspect', () => {
    for (const aspect of CAMERA.supportedAspects) {
      const pose = rigPoseForAspect(aspect);
      expect(pose.distanceUnits, `distance at ${aspect}`).toBeGreaterThanOrEqual(
        CAMERA.distanceUnits,
      );

      const report = framingReport(aspect, 1920, 1920 / aspect);
      expect(report.marginX, `marginX at ${aspect}`).toBeGreaterThanOrEqual(
        FIT_MARGIN - 1e-9,
      );
      expect(report.marginY, `marginY at ${aspect}`).toBeGreaterThanOrEqual(
        FIT_MARGIN - 1e-9,
      );
      for (const point of report.points) {
        expect(point.x, `${point.label} x at ${aspect}`).toBeGreaterThanOrEqual(0);
        expect(point.x, `${point.label} x at ${aspect}`).toBeLessThanOrEqual(report.width);
        expect(point.y, `${point.label} y at ${aspect}`).toBeGreaterThanOrEqual(0);
        expect(point.y, `${point.label} y at ${aspect}`).toBeLessThanOrEqual(report.height);
      }
    }
  });

  it('moves the eye back only when a shorter frame needs it', () => {
    // 21:9 is the shortest frame the solver must handle, so it is the one
    // aspect that has to back off; 16:9 and the tall frames keep the rig.
    const wide = rigPoseForAspect(21 / 9);
    expect(wide.distanceUnits).toBeGreaterThan(CAMERA.distanceUnits + 10);
    for (const aspect of [16 / 9, 3 / 2, 4 / 3, 1, 3 / 4, 9 / 16]) {
      expect(rigPoseForAspect(aspect).distanceUnits, `distance at ${aspect}`).toBeLessThan(
        CAMERA.distanceUnits + 0.5,
      );
    }
  });

  it('fits the mat plus the hand, not an invented subject', () => {
    const points = framingSubjectPoints();
    expect(points).toHaveLength(8);
    expect(FRAMING_SUBJECT.matHalfUnits).toBe(TABLE.matSizeUnits / 2);
    expect(FRAMING_SUBJECT.handFrontUnits).toBe(HAND.backRadiusUnits);
    // Two mat corners are at each of the four felt corners, and the hand box
    // sits in front of the human at the committed back radius.
    for (const point of points.slice(0, 4)) {
      expect(Math.abs(point[0])).toBe(12.5);
      expect(Math.abs(point[2])).toBe(12.5);
    }
    for (const point of points.slice(4)) {
      expect(point[2]).toBe(10.6);
    }
  });

  it('prints the framing matrix', () => {
    const frames: ReadonlyArray<readonly [string, number, number, number]> = [
      ['21:9', 21 / 9, 2560, 1080],
      ['16:9', 16 / 9, 1920, 1080],
      ['3:2', 3 / 2, 1920, 1280],
      ['4:3', 4 / 3, 1440, 1080],
      ['1:1', 1, 1080, 1080],
      ['3:4', 3 / 4, 1080, 1440],
      ['9:16', 9 / 16, 1080, 1920],
    ];
    const lines = frames.map(([name, aspect, width, height]) => {
      const report = framingReport(aspect, width, height);
      return `${name.padEnd(5)} ${width}x${height} pitch=${report.pitchDeg.toFixed(0)}deg ` +
        `d=${report.distanceUnits.toFixed(3)} fovy=${report.fovYDeg.toFixed(3)}deg ` +
        `margin=${(Math.min(report.marginX, report.marginY) * 100).toFixed(2)}%`;
    });
    console.log(`3D camera framing (rig v13):\n${lines.join('\n')}`);
    expect(lines).toHaveLength(frames.length);
  });
});
