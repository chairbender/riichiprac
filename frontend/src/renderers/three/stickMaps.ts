/**
 * The riichi stick's carved face (3D-09): the small red pip is a painted
 * engraving, not a decal.
 *
 * The tiles get their carved look from albedo-plus-paint, a tangent-space
 * normal and a cavity term (3D-05's `tile.frag`), and the user asked for the
 * same treatment here: "the center pip is actually 'carved out' and then
 * painted on … use the same approach we used with the tiles". The stick's face
 * is therefore a shallow circular recess — a painted floor, a short ivory wall
 * — described as three procedural maps: albedo with the paint mixed in, the
 * tangent normal of the recess wall, and a roughness map (the lacquer pip is
 * glossier than the moulded body). A baked cavity darkening stands in for the
 * tiles' AO channel because the recess is only 0.3 mm deep.
 *
 * The maps are generated in code, like the felt and the contact shadow: no new
 * committed asset, deterministic bytes, and a Node test can assert the pip, the
 * wall slope and the paint as numbers.
 *
 * **Atlas layout.** The bar's UVs are a plan projection: `u` runs along the
 * length and `v` across the elliptical cross-section, so the pip sits on the
 * top centre of the bar and the sides sample the plain ivory border of the
 * map. One material therefore covers the whole bar without wrapping the pip
 * around its curved side.
 *
 * **No parallax march.** The pip is 0.4 mm deep on a 3.5 mm bar. At the
 * reference camera's ~40° the displacement of a surface point is
 * 0.4 × tan(40°) ≈ 0.34 mm, under half a pixel on the finished stick, so the
 * normal map carries the carve and POM would only add cost. The tiles' 0.55 mm
 * glyph wall is a different scale; this is the "shading only" end of the tile
 * carve, which the 2.5D decals already ship.
 */

import { UNIT_MM } from '../layoutConstants';

/** The pip's committed numbers. */
export const STICK_CARVE = {
  /** A 3 mm pip on a 7 mm bar: the sprite's own proportion (42 % of the width). */
  pipDiameterMm: 3,
  pipRadiusUnits: 3 / 2 / UNIT_MM,
  /**
   * The bevelled wall between the painted floor and the face. 0.5 mm is
   * generous for a moulded pip but keeps the recess visible at the stick's
   * on-screen width (~19 px); at 0.25 mm the whole wall is sub-pixel.
   */
  wallMm: 0.5,
  wallUnits: 0.5 / UNIT_MM,
  /** The engraving's depth: 0.4 mm (the tile carve is 0.55 mm). */
  depthMm: 0.4,
  depthUnits: 0.4 / UNIT_MM,
  /** The sprite's palette. */
  bodyRgb: [248, 249, 250] as const,
  paintRgb: [224, 49, 49] as const,
  /** Moulded polystyrene, and the lacquer that fills the pip. */
  bodyRoughness: 0.24,
  wallRoughness: 0.32,
  paintRoughness: 0.1,
  /** The cavity darkening baked into the albedo: 18 % at the deepest point. */
  cavityStrength: 0.22,
  /** The procedural atlas, in texels (power of two for mipmaps). */
  textureWidth: 256,
  textureHeight: 256,
  /** The stick's dims, in units, for the analytic circle in UV space. */
  lengthUnits: 65 / UNIT_MM,
  widthUnits: 7 / UNIT_MM,
} as const;

/** The profile's slope, `dh/dd`, nonzero only on the wall. */
function recessSlope(distanceUnits: number): number {
  const floor = STICK_CARVE.pipRadiusUnits;
  const rim = floor + STICK_CARVE.wallUnits;
  if (!(distanceUnits > floor) || distanceUnits >= rim) return 0;
  const t = (distanceUnits - floor) / STICK_CARVE.wallUnits;
  return (6 * t * (1 - t)) / STICK_CARVE.wallUnits;
}

/** Where an atlas texel sits on the bar's plan-projected face. */
function facePoint(
  x: number,
  y: number,
): { readonly u: number; readonly v: number } {
  return {
    u: (x + 0.5) / STICK_CARVE.textureWidth,
    v: (y + 0.5) / STICK_CARVE.textureHeight,
  };
}

/** The distance from the pip's centre, in stick units. */
function pipDistance(u: number, v: number): number {
  return Math.hypot(
    (u - 0.5) * STICK_CARVE.lengthUnits,
    (v - 0.5) * STICK_CARVE.widthUnits,
  );
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function mix(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/**
 * The face's albedo: ivory body, red paint in the pip's floor, and a baked
 * cavity darkening up the wall. The side-wall region of the atlas is plain
 * ivory.
 */
export function stickAlbedoPixels(
  width: number = STICK_CARVE.textureWidth,
  height: number = STICK_CARVE.textureHeight,
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  const floor = STICK_CARVE.pipRadiusUnits;
  const rim = floor + STICK_CARVE.wallUnits;
  const edge = STICK_CARVE.wallUnits * 0.12;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const { u, v } = facePoint(x, y);
      let rgb: readonly [number, number, number] = STICK_CARVE.bodyRgb;
      const d = pipDistance(u, v);
      // Paint fills the recess's floor (a crisp, 0.12-wall anti-aliased edge).
      const paint = 1 - Math.min(1, Math.max(0, (d - floor + edge) / (2 * edge)));
      if (paint > 0) rgb = mix(STICK_CARVE.bodyRgb, STICK_CARVE.paintRgb, paint);
      // Baked cavity: the wall's middle is 22 % darker than the open face.
      // The plan projection puts the pip on the underside too; that half is
      // hidden by the bar itself, so the same map can serve both.
      const wallT = Math.min(1, Math.max(0, (d - floor) / STICK_CARVE.wallUnits));
      const cavity =
        1 -
        STICK_CARVE.cavityStrength *
          Math.sin(Math.PI * wallT) *
          (d >= floor && d < rim ? 1 : 0);
      if (cavity !== 1) rgb = [rgb[0] * cavity, rgb[1] * cavity, rgb[2] * cavity];
      const index = (y * width + x) * 4;
      pixels[index] = clampByte(rgb[0]);
      pixels[index + 1] = clampByte(rgb[1]);
      pixels[index + 2] = clampByte(rgb[2]);
      pixels[index + 3] = 255;
    }
  }
  return pixels;
}

/**
 * The face's tangent-space normal: flat everywhere except the recess wall,
 * where it tilts inward toward the pip's centre. Encoded the way three's
 * `normalMap` expects (RGB = tangent x, bitangent, normal, each 0..1), with
 * the bitangent along the bar's width.
 */
export function stickNormalPixels(
  width: number = STICK_CARVE.textureWidth,
  height: number = STICK_CARVE.textureHeight,
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  const floor = STICK_CARVE.pipRadiusUnits;
  const rim = floor + STICK_CARVE.wallUnits;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const { u, v } = facePoint(x, y);
      const dx = (u - 0.5) * STICK_CARVE.lengthUnits;
      const dz = (v - 0.5) * STICK_CARVE.widthUnits;
      const d = Math.hypot(dx, dz);
      let nx = 0;
      let nz = 0;
      if (d > floor && d < rim) {
        // y(x,z) = -depth * (1 - h(d)); the normal is (-dy/dx, 1, -dy/dz).
        const slope = STICK_CARVE.depthUnits * recessSlope(d);
        nx = (-slope * dx) / d;
        nz = (-slope * dz) / d;
      }
      const length = Math.hypot(nx, 1, nz);
      const index = (y * width + x) * 4;
      // Tangent x, bitangent (width) z, surface normal y.
      pixels[index] = clampByte((nx / length) * 127.5 + 127.5);
      pixels[index + 1] = clampByte((nz / length) * 127.5 + 127.5);
      pixels[index + 2] = clampByte((1 / length) * 127.5 + 127.5);
      pixels[index + 3] = 255;
    }
  }
  return pixels;
}

/**
 * The face's roughness (in the green channel, which is what three's
 * `roughnessMap` reads): the moulded body is satin, the wall a touch rougher,
 * and the lacquered pip glossier.
 */
export function stickRoughnessPixels(
  width: number = STICK_CARVE.textureWidth,
  height: number = STICK_CARVE.textureHeight,
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  const floor = STICK_CARVE.pipRadiusUnits;
  const rim = floor + STICK_CARVE.wallUnits;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const { u, v } = facePoint(x, y);
      const d = pipDistance(u, v);
      let roughness: number = STICK_CARVE.bodyRoughness;
      if (d < floor) roughness = STICK_CARVE.paintRoughness;
      else if (d < rim) roughness = STICK_CARVE.wallRoughness;
      const value = clampByte(roughness * 255);
      const index = (y * width + x) * 4;
      pixels[index] = value;
      pixels[index + 1] = value;
      pixels[index + 2] = value;
      pixels[index + 3] = 255;
    }
  }
  return pixels;
}
