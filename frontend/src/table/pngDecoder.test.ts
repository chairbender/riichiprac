import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodePng } from './pngDecoder';
import { parseReliefManifest } from './reliefManifest';

const tableDir = fileURLToPath(new URL('../../public/table/', import.meta.url));
const relief = parseReliefManifest(JSON.parse(readFileSync(join(tableDir, 'relief.json'), 'utf8')));
const bytes = new Uint8Array(readFileSync(join(tableDir, relief.atlases.normalDepth.file)));

describe('raw PNG decode of the relief atlases', () => {
  it('keeps normal RGB independent of the height alpha', async () => {
    const png = await decodePng(bytes, 'face_normal_depth.png');
    expect(png.width).toBe(relief.atlases.normalDepth.width);
    expect(png.height).toBe(relief.atlases.normalDepth.height);

    // A deep 7z junction floor: raw normal RGB is a flat (128,128,255) while
    // the height alpha is 0. A Canvas would premultiply this to (0,0,0,0), and
    // the shader would decode (0,0,0) as an inward normal and render black.
    const cell = relief.cells['7z'];
    const index = ((cell.y + 22) * png.width + (cell.x + 98)) * 4;
    expect(png.data[index]).toBeGreaterThan(120);
    expect(png.data[index + 1]).toBeGreaterThan(120);
    expect(png.data[index + 2]).toBe(255);
    expect(png.data[index + 3]).toBeLessThan(10);

    let lost = 0;
    let negativeZ = 0;
    for (let pixel = 0; pixel < png.width * png.height; pixel += 1) {
      const offset = pixel * 4;
      const alpha = png.data[offset + 3];
      const r = png.data[offset];
      const g = png.data[offset + 1];
      const b = png.data[offset + 2];
      if (alpha < 10 && r + g + b < 30) lost += 1;
      if ((b / 255) * 2 - 1 < -0.02) negativeZ += 1;
    }
    // The committed atlas never stores a visible surface with an inward
    // normal; and the deep-carve pixels retain their colour.
    expect(negativeZ).toBe(0);
    expect(lost).toBe(0);
  });
});
