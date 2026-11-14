/**
 * Dependency-free PNG reader/writer for the shell pipeline's review tooling.
 *
 * It handles exactly what this repository commits: 8-bit, non-interlaced,
 * RGB (colour type 2) or RGBA (colour type 6) PNGs. Enough for the felt, the
 * shell textures and the review composites, with no npm dependency, so CI can
 * decode the assets without Blender or `sharp`.
 */
import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = '89504e470d0a1a0a';

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(bytes, label = 'PNG') {
  if (bytes.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) {
    throw new Error(`${label} is not a PNG`);
  }
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (kind === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        compression: body[10],
        filter: body[11],
        interlace: body[12],
      };
    } else if (kind === 'IDAT') {
      idat.push(body);
    } else if (kind === 'IEND') {
      break;
    }
  }
  if (!header) throw new Error(`${label} has no IHDR`);
  if (header.bitDepth !== 8 || header.compression !== 0 || header.filter !== 0 || header.interlace !== 0) {
    throw new Error(
      `${label} is not an 8-bit non-interlaced PNG ` +
        `(bitDepth ${header.bitDepth}, interlace ${header.interlace})`,
    );
  }
  const channels = header.colorType === 2 ? 3 : header.colorType === 6 ? 4 : 0;
  if (!channels) throw new Error(`${label} has unsupported colour type ${header.colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = header.width * channels;
  const data = Buffer.alloc(stride * header.height);
  let previous = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const row = data.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const value = raw[pos + x];
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let predictor;
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
          throw new Error(`${label} uses unsupported PNG filter ${filter}`);
      }
      row[x] = (value + predictor) & 0xff;
    }
    pos += stride;
    previous = row;
  }
  return { ...header, channels, data, stride, bytes: bytes.length };
}

export function readPng(path) {
  return decodePng(readFileSync(path), path);
}

export function encodePng(width, height, channels, data) {
  const chunk = (kind, payload) => {
    const body = Buffer.concat([Buffer.from(kind, 'ascii'), payload]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(payload.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([length, body, crc]);
  };

  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE, 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

/** Straight-alpha "over" of one RGBA sprite onto another RGBA canvas. */
export function drawSprite(canvas, sprite, dx, dy) {
  for (let y = 0; y < sprite.height; y += 1) {
    const targetY = dy + y;
    if (targetY < 0 || targetY >= canvas.height) continue;
    for (let x = 0; x < sprite.width; x += 1) {
      const targetX = dx + x;
      if (targetX < 0 || targetX >= canvas.width) continue;
      const source = (y * sprite.width + x) * 4;
      const alpha = sprite.data[source + 3] / 255;
      if (alpha === 0) continue;
      const target = (targetY * canvas.width + targetX) * 4;
      const targetAlpha = canvas.data[target + 3] / 255;
      const outAlpha = alpha + targetAlpha * (1 - alpha);
      for (let channel = 0; channel < 3; channel += 1) {
        canvas.data[target + channel] = Math.round(
          (sprite.data[source + channel] * alpha +
            canvas.data[target + channel] * targetAlpha * (1 - alpha)) /
            Math.max(1e-6, outAlpha),
        );
      }
      canvas.data[target + 3] = Math.round(outAlpha * 255);
    }
  }
}

/** Nearest-neighbour zoom, so a review sheet shows real pixels, not a blur. */
export function zoomNearest(rgba, x, y, width, height, factor) {
  const out = Buffer.alloc(width * factor * height * factor * 4);
  for (let ty = 0; ty < height * factor; ty += 1) {
    for (let tx = 0; tx < width * factor; tx += 1) {
      const source = ((y + Math.floor(ty / factor)) * rgba.width + (x + Math.floor(tx / factor))) * 4;
      const target = (ty * width * factor + tx) * 4;
      rgba.data.copy(out, target, source, source + 4);
    }
  }
  return {
    width: width * factor,
    height: height * factor,
    data: out,
    channels: 4,
    stride: width * factor * 4,
  };
}
