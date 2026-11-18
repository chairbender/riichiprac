/**
 * The procedural felt surface (3D-02).
 *
 * There is no modelled table and no new committed texture: the play surface is
 * one square felt plane under a deterministic value-noise texture, drawn much
 * larger than the 25-unit play mat so it reaches every edge of a full-window
 * frame (user guidance 2026-11-18: no background may show above or beside the
 * scene). The vignette is supplied in screen space by CSS (the 2.5D felt raster
 * has a vignette baked into screen space and must not be wrapped onto a 3D
 * plane).
 *
 * The noise is generated in code rather than read from `felt.png` so the plane
 * tiles seamlessly and the 3D view keeps D11's "no new committed runtime
 * assets". It is a pure function of pixel and seed, so a unit test can compare
 * two runs byte for byte; {@link createFelt} is the only part that needs a
 * canvas, and it runs in the lazy three.js chunk.
 */

import {
  CanvasTexture,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three';
import { TABLE } from '../layoutConstants';

/** Felt texture parameters. The base colour is the committed 2.5D felt's. */
export const FELT = {
  /** 512 x 512: low-frequency cloth, not a per-pixel pattern. */
  textureSize: 512,
  /** Times the 512 texture repeats across the 25-unit mat. */
  repeat: 2,
  /**
   * The drawn felt's side length, in tile units. It stays a square — the cloth
   * is never stretched to the viewport — but it is much larger than the 25-unit
   * play mat, because a full-window frame reaches past the mat: the frame
   * corners need a half-size of 25.0 units at 21:9, 46.6 at 9:16, 60.8 on a
   * 9:19.5 phone and 67.5 at 9:21 (see `groundHit`). 160 units covers all of
   * those with margin, so no background shows above, below or beside the felt;
   * the extra area is off-screen and costs nothing to draw.
   */
  sizeUnits: 160,
  /** `felt-spec.json`'s base colour (#1a5038). */
  baseRgb: [26, 80, 56] as const,
  seed: 20261118,
  /** Octave cells in texture pixels; the committed bake's 2048-wide cells / 4. */
  octaves: [
    { cell: 80, amplitude: 2.8 },
    { cell: 30, amplitude: 1.8 },
    { cell: 10, amplitude: 1.8 },
  ],
  /** Per-pixel grain, so the plane does not band on a large display. */
  grainAmplitude: 0.8,
} as const;

/** Smoothstep interpolation weight for value noise. */
function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/** A deterministic 32-bit integer hash of a lattice point and the noise seed. */
function hashLattice(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

/**
 * One octave of seamless value noise at a pixel.
 *
 * The lattice wraps at the octave's cell count, so the texture repeats without
 * a seam when the plane tiles it.
 */
function valueNoise(x: number, y: number, size: number, cell: number, seed: number): number {
  const cells = Math.max(1, Math.round(size / cell));
  const scale = cells / size;
  const latticeX = x * scale;
  const latticeY = y * scale;
  const x0 = Math.floor(latticeX);
  const y0 = Math.floor(latticeY);
  const wrap = (value: number) => ((value % cells) + cells) % cells;
  const tx = fade(latticeX - x0);
  const ty = fade(latticeY - y0);

  const a = hashLattice(wrap(x0), wrap(y0), seed);
  const b = hashLattice(wrap(x0 + 1), wrap(y0), seed);
  const c = hashLattice(wrap(x0), wrap(y0 + 1), seed);
  const d = hashLattice(wrap(x0 + 1), wrap(y0 + 1), seed);

  const top = a + (b - a) * tx;
  const bottom = c + (d - c) * tx;
  return top + (bottom - top) * ty;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * Generate the felt as RGBA bytes (`size * size * 4`), deterministic for a
 * given size and seed.
 */
export function generateFeltPixels(
  size: number = FELT.textureSize,
  seed: number = FELT.seed,
): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  const [baseR, baseG, baseB] = FELT.baseRgb;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let noise = 0;
      for (const octave of FELT.octaves) {
        noise += (valueNoise(x, y, size, octave.cell, seed) * 2 - 1) * octave.amplitude;
      }
      const grain =
        (hashLattice(x, y, seed ^ 0x5f356495) * 2 - 1) * FELT.grainAmplitude;
      const offset = noise + grain;
      const index = (y * size + x) * 4;
      pixels[index] = clampByte(baseR + offset);
      pixels[index + 1] = clampByte(baseG + offset);
      pixels[index + 2] = clampByte(baseB + offset);
      pixels[index + 3] = 255;
    }
  }

  return pixels;
}

/** A felt plane and the GPU resources it owns. */
export interface FeltSurface {
  readonly mesh: Mesh;
  dispose(): void;
}

/**
 * Build the felt plane: a 25 x 25-unit quad at the world origin, lying in the
 * XZ plane, textured with {@link generateFeltPixels}.
 *
 * Only called inside the lazy three.js chunk; the unit tests cover the pure
 * generator and the plane's declared size instead.
 */
export function createFelt(): FeltSurface {
  const size = FELT.textureSize;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('3D felt: a 2D canvas context is required to build the texture');
  }
  const image = context.createImageData(size, size);
  image.data.set(generateFeltPixels(size));
  context.putImageData(image, 0, 0);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  // Keep the cloth's texel size constant now that the drawn square is larger
  // than the mat: the same 12.5 units per repeat as `FELT.repeat` gives over
  // the 25-unit mat.
  const repeats = (FELT.sizeUnits / TABLE.matSizeUnits) * FELT.repeat;
  texture.repeat.set(repeats, repeats);
  texture.needsUpdate = true;

  const geometry = new PlaneGeometry(FELT.sizeUnits, FELT.sizeUnits, 1, 1);
  const material = new MeshStandardMaterial({
    map: texture,
    roughness: 0.94,
    metalness: 0,
  });
  const mesh = new Mesh(geometry, material);
  // A plane faces +Z by default; turn it to face +Y so it lies on the table.
  mesh.rotation.x = -Math.PI / 2;
  mesh.name = 'felt';

  return {
    mesh,
    dispose() {
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}
