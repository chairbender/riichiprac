/**
 * The carve calibration's worst-case numbers (3D-10).
 *
 * Two dependent texture offsets are bounded by the same arithmetic: the POM
 * parallax (the view ray through the carve) and the self-shadow march (the key
 * ray through the carve). Both are `depth · tan(angle)` converted to atlas
 * texels, so both must be checked against the 8-texel parallax gate — a
 * calibration that widened either would fail it.
 *
 * This module is pure: it takes the face-up surfaces' world normals and centres,
 * the committed eye and the committed key, and returns the worst reading over
 * them. It never inspects a render and never decides whether a carve "looks
 * right"; it prints the two reaches the shader's clamps bound. `Scene.ts` feeds
 * it the live board (or the four hero slots), and the debug HUD prints the
 * result.
 */

import type { CarveReachNumber } from '../contract';
import { LIGHT } from '../layoutConstants';
import { shadowReachTexels, parallaxTexels } from './tileMaterial';
import type { CarveOffsetOptions, ParallaxReading } from './tileMaterial';

/** One face-up carved surface: its plate normal and body centre, in world units. */
export interface CarveSurface {
  readonly id: string;
  readonly label: string;
  readonly normal: readonly [number, number, number];
  readonly centre: readonly [number, number, number];
}

/** A normalised dot product, clamped against floating-point drift. */
function dot(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function angleBetweenDeg(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const cosine = Math.min(1, Math.max(-1, dot(a, b)));
  return (Math.acos(cosine) * 180) / Math.PI;
}

/** The angle between the view ray and a plate normal, in degrees. */
export function viewAngleDeg(
  surface: CarveSurface,
  eye: readonly [number, number, number],
): number {
  const toEye: [number, number, number] = [
    eye[0] - surface.centre[0],
    eye[1] - surface.centre[1],
    eye[2] - surface.centre[2],
  ];
  const length = Math.hypot(toEye[0], toEye[1], toEye[2]) || 1;
  const unit: [number, number, number] = [
    toEye[0] / length,
    toEye[1] / length,
    toEye[2] / length,
  ];
  return angleBetweenDeg(surface.normal, unit);
}

/** The angle between the key and a plate normal, in degrees. */
export function keyAngleDeg(surface: CarveSurface): number {
  return angleBetweenDeg(surface.normal, LIGHT.keyDirection);
}

/** A reach reading plus the surface that produced it. */
export interface WorstReach {
  readonly id: string;
  readonly label: string;
  readonly angleDeg: number;
  readonly texels: number;
  readonly clamped: boolean;
}

/**
 * The worst view angle over the given surfaces: the one the parallax clamp
 * bounds. A surface facing away from the eye is still a visible face in
 * principle (a grazing hand), so it is included; the shader's own bound is what
 * keeps the result finite.
 */
export function worstViewAngle(
  surfaces: readonly CarveSurface[],
  eye: readonly [number, number, number],
): { readonly reading: WorstReach; readonly count: number } {
  let worst: WorstReach = { id: 'none', label: 'no face-up surfaces', angleDeg: -1, texels: 0, clamped: false };
  let count = 0;
  for (const surface of surfaces) {
    count += 1;
    const angle = viewAngleDeg(surface, eye);
    if (angle > worst.angleDeg) {
      const reading = parallaxTexels(angle);
      worst = {
        id: surface.id,
        label: surface.label,
        angleDeg: reading.angleDeg,
        texels: reading.texels,
        clamped: reading.clamped,
      };
    }
  }
  if (worst.angleDeg < 0) worst = { ...worst, angleDeg: 0 };
  return { reading: worst, count };
}

/**
 * The worst self-shadow reach over the given surfaces.
 *
 * A plate whose normal points away from the key is skipped: the shader's march
 * only runs when the key is above the plate (`lightTangent.z > 0.05`), and a
 * surface the key cannot reach is not a shadow case. A face nearly edge-on to
 * the key still counts and is clamped, which is exactly the bound being checked.
 */
export function worstShadowReach(
  surfaces: readonly CarveSurface[],
  options: CarveOffsetOptions = {},
): { readonly reading: WorstReach; readonly count: number } {
  let worst: WorstReach = {
    id: 'none',
    label: 'no key-lit surfaces',
    angleDeg: -1,
    texels: 0,
    clamped: false,
  };
  let count = 0;
  for (const surface of surfaces) {
    const angle = keyAngleDeg(surface);
    if (dot(surface.normal, LIGHT.keyDirection) <= 0.05) continue;
    count += 1;
    if (angle > worst.angleDeg) {
      const reading: ParallaxReading = shadowReachTexels(angle, options);
      worst = {
        id: surface.id,
        label: surface.label,
        angleDeg: reading.angleDeg,
        texels: reading.texels,
        clamped: reading.clamped,
      };
    }
  }
  if (worst.angleDeg < 0) worst = { ...worst, angleDeg: 0 };
  return { reading: worst, count };
}

/** Both bounds in the shape the debug HUD prints. */
export interface CarveBoundsReport {
  readonly parallax: CarveReachNumber;
  readonly shadow: CarveReachNumber;
}

/**
 * Measure both bounds over a surface set. The id/label name the surface that
 * produced the worst reading, so a number in the HUD is attributable.
 */
export function carveBounds(
  surfaces: readonly CarveSurface[],
  eye: readonly [number, number, number],
): CarveBoundsReport {
  const view = worstViewAngle(surfaces, eye).reading;
  const shadow = worstShadowReach(surfaces).reading;
  return {
    parallax: {
      id: `parallax:${view.id}`,
      label: view.label,
      angleDeg: view.angleDeg,
      texels: view.texels,
      clamped: view.clamped,
    },
    shadow: {
      id: `shadow:${shadow.id}`,
      label: shadow.label,
      angleDeg: shadow.angleDeg,
      texels: shadow.texels,
      clamped: shadow.clamped,
    },
  };
}
