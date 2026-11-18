/**
 * Minimal PNG reader for the relief atlases.
 *
 * Why not use a Canvas? The Task 4B atlases are **data**, not pictures:
 * `face_normal_depth.png` stores a tangent-space normal in RGB and the carve
 * height in alpha. A Canvas premultiplies colour by alpha, so wherever the
 * height is low (the deep part of a glyph) it destroys the normal RGB; at
 * height 0 the normal comes back as (0, 0, 0) and decodes to an inward normal,
 * which lights as a black self-shadow. Reading the IDAT bytes directly keeps
 * all four channels independent, which is what the bake wrote.
 *
 * Exactly the repository's committed format: 8-bit, non-interlaced, colour
 * type 6 (RGBA) or 2 (RGB, promoted to RGBA with opaque alpha). All five PNG
 * filters are supported. Inflation uses the platform `DecompressionStream`
 * (browsers and Node 18+); there is no npm dependency.
 */

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  /** Straight-alpha RGBA, `width * height * 4` bytes. */
  readonly data: Uint8ClampedArray;
  readonly bytes: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function fail(label: string, message: string): never {
  throw new Error(`${label}: ${message}`);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Inflate a zlib stream (the PNG IDAT payload). */
async function inflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('no DecompressionStream available to inflate the PNG');
  }
  const stream = new Blob([bytes as unknown as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decode an 8-bit, non-interlaced PNG into straight-alpha RGBA. */
export async function decodePng(bytes: Uint8Array, label = 'PNG'): Promise<DecodedPng> {
  if (bytes.length < 8 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
    fail(label, 'is not a PNG');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let compression = -1;
  let filterMethod = -1;
  let interlace = -1;
  const idat: Uint8Array[] = [];
  let idatBytes = 0;

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const kind =
      String.fromCharCode(bytes[offset + 4]) +
      String.fromCharCode(bytes[offset + 5]) +
      String.fromCharCode(bytes[offset + 6]) +
      String.fromCharCode(bytes[offset + 7]);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (kind === 'IHDR') {
      if (length !== 13) fail(label, 'IHDR has the wrong length');
      const header = new DataView(body.buffer, body.byteOffset, body.byteLength);
      width = header.getUint32(0);
      height = header.getUint32(4);
      bitDepth = body[8];
      colorType = body[9];
      compression = body[10];
      filterMethod = body[11];
      interlace = body[12];
    } else if (kind === 'IDAT') {
      idat.push(body);
      idatBytes += body.length;
    } else if (kind === 'IEND') {
      break;
    }
  }
  if (width <= 0 || height <= 0) fail(label, 'has no IHDR');
  if (bitDepth !== 8) fail(label, `bit depth ${bitDepth} is unsupported (need 8)`);
  if (compression !== 0) fail(label, `compression ${compression} is unsupported`);
  if (filterMethod !== 0) fail(label, `filter method ${filterMethod} is unsupported`);
  if (interlace !== 0) fail(label, 'interlaced PNGs are unsupported');
  if (colorType !== 6 && colorType !== 2) {
    fail(label, `colour type ${colorType} is unsupported (need 6 or 2)`);
  }
  if (idat.length === 0) fail(label, 'has no IDAT');

  const zlib = new Uint8Array(idatBytes);
  let cursor = 0;
  for (const chunk of idat) {
    zlib.set(chunk, cursor);
    cursor += chunk.length;
  }
  const raw = await inflateZlib(zlib);

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const expected = (stride + 1) * height;
  if (raw.length < expected) {
    fail(label, `IDAT inflates to ${raw.length} bytes, expected ${expected}`);
  }

  const pixels = new Uint8Array(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const row = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[pos + x];
      const left = x >= channels ? pixels[row + x - channels] : 0;
      const up = y > 0 ? pixels[row - stride + x] : 0;
      const upLeft = x >= channels && y > 0 ? pixels[row - stride + x - channels] : 0;
      let predictor: number;
      switch (filter) {
        case 0:
          predictor = 0;
          break;
        case 1:
          predictor = left;
          break;
        case 2:
          predictor = up;
          break;
        case 3:
          predictor = (left + up) >> 1;
          break;
        case 4:
          predictor = paeth(left, up, upLeft);
          break;
        default:
          fail(label, `uses unsupported PNG filter ${filter}`);
      }
      pixels[row + x] = (value + predictor) & 0xff;
    }
    pos += stride;
  }

  const data = new Uint8ClampedArray(width * height * 4);
  if (channels === 4) {
    data.set(pixels);
  } else {
    for (let index = 0, target = 0; index < pixels.length; index += 3, target += 4) {
      data[target] = pixels[index];
      data[target + 1] = pixels[index + 1];
      data[target + 2] = pixels[index + 2];
      data[target + 3] = 255;
    }
  }
  return { width, height, data, bytes: bytes.length };
}
