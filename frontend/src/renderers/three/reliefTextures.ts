/**
 * The three.js half of the relief bridge (3D-05).
 *
 * 3D-03 owns the asset contract: it fetches the committed manifest and atlases,
 * verifies the pins and hands over a {@link ReliefTextureRequest} per atlas.
 * This module is the `ReliefTextureFactory` 3D-03's doc comment asks 3D-05 to
 * supply — decode the PNG at the tier's upload size (which is how `compat`
 * halves the atlas) or upload a procedural cell, set the sampling the carved
 * face shader needs, and return the disposable texture.
 *
 * Sampling choices, and why:
 *
 * - `flipY = false`. The manifest's cells are y-down and 3D-04's plate UV is
 *   V-down, so a flip would invert every glyph.
 * - `ClampToEdge` on both axes: a mip level of an atlas must never bleed a
 *   neighbouring cell in through a wrap.
 * - Trilinear mips plus the tier's anisotropy. A grazing pond tile is where the
 *   committed 256 x 340 cell is most undersampled on screen; mips without
 *   anisotropy blur the glyph away there, so both are on.
 * - The albedo is sRGB (hardware-decoded in WebGL2); the normal/height and
 *   AO/roughness atlases are linear data and must not be decoded.
 *
 * No committed asset is read twice or written: this module only decodes and
 * uploads what 3D-03 fetched.
 */

import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RGBAFormat,
  SRGBColorSpace,
  Texture as ThreeTexture,
  UnsignedByteType,
} from 'three';
import type { Texture } from 'three';
import type { ReliefTextureFactory, ReliefTextureRequest } from './reliefAssets';

/** A texture for a decoded PNG or a procedural pixel block. */
export type ReliefGpuTexture = Texture;

/**
 * Build the factory the relief bridge needs. `maxAnisotropy` is the renderer's
 * reported maximum (`renderer.capabilities.getMaxAnisotropy()`); the tier value
 * has already been clamped to it by 3D-03, so this only guards against a
 * driver reporting a value above the hardware limit.
 */
export function createReliefTextureFactory(
  maxAnisotropy?: number,
): ReliefTextureFactory<ReliefGpuTexture> {
  return {
    async create(request: ReliefTextureRequest): Promise<ReliefGpuTexture> {
      if (request.pixels) {
        return createDataTexture(request);
      }
      if (!request.bytes) {
        throw new Error(`relief texture ${request.name} has neither bytes nor pixels`);
      }
      return createDecodedTexture(request, request.bytes, maxAnisotropy);
    },
  };
}

function applySampling(
  texture: Texture,
  request: ReliefTextureRequest,
  maxAnisotropy: number | undefined,
): void {
  texture.name = request.name;
  texture.colorSpace = request.colorSpace === 'srgb' ? SRGBColorSpace : texture.colorSpace;
  texture.flipY = request.flipY;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = request.generateMipmaps ? LinearMipmapLinearFilter : LinearFilter;
  texture.generateMipmaps = request.generateMipmaps;
  if (maxAnisotropy !== undefined && Number.isFinite(maxAnisotropy)) {
    texture.anisotropy = Math.max(1, Math.min(request.anisotropy, Math.floor(maxAnisotropy)));
  } else {
    texture.anisotropy = Math.max(1, request.anisotropy);
  }
  texture.needsUpdate = true;
}

/** Upload a procedural cell (3D-03's neutral fallback) as a data texture. */
function createDataTexture(request: ReliefTextureRequest): ReliefGpuTexture {
  const pixels = request.pixels;
  if (!pixels) throw new Error('createDataTexture requires pixels');
  const data = new Uint8Array(pixels.data.length);
  data.set(pixels.data);
  const texture = new DataTexture(
    data,
    pixels.width,
    pixels.height,
    RGBAFormat,
    UnsignedByteType,
  );
  applySampling(texture, request, undefined);
  return texture;
}

/**
 * Decode a PNG and upload it at the requested size.
 *
 * Decoding goes straight to an `ImageBitmap` and the texture is built from that
 * bitmap, **never through a canvas**: a 2D canvas surface premultiplies alpha,
 * and this chain's height channel is 0 (alpha 0) wherever the engraving is at
 * its floor, so a canvas round-trip multiplied those texels' normal RGB away.
 * `premultiplyAlpha: 'none'` plus a direct upload keeps every channel exact;
 * the resize is done by the decoder (which is also what implements the
 * `compat` tier's half-size atlas) and `flipY` stays false because the image
 * arrives unflipped.
 */
async function createDecodedTexture(
  request: ReliefTextureRequest,
  bytes: Uint8Array,
  maxAnisotropy: number | undefined,
): Promise<ReliefGpuTexture> {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('relief textures: createImageBitmap is unavailable');
  }
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), {
    premultiplyAlpha: 'none',
    resizeWidth: request.width,
    resizeHeight: request.height,
    resizeQuality: 'high',
  });
  const texture = new ThreeTexture(bitmap);
  applySampling(texture, request, maxAnisotropy);
  // three uploads an ImageBitmap as-is; the bitmap is owned by the texture and
  // released when the texture is disposed.
  return texture;
}
