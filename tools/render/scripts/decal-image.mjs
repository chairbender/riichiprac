/**
 * Decode and measure a carved decal image (PNG build or committed AVIF/WebP).
 *
 * Uses `@napi-rs/canvas`, the same native Canvas 2D backend the frontend
 * tests use. The decal pipeline now ships AVIF (lossy q60 with alpha), so the
 * dependency-free PNG decoder is not enough; the shell/face checks remain
 * dependency-free.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';

export async function loadRgba(path) {
  const image = await loadImage(readFileSync(path));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, image.width, image.height).data;
  return { width: image.width, height: image.height, channels: 4, data };
}

export function pixel(image, x, y) {
  const index = (y * image.width + x) * 4;
  return [image.data[index], image.data[index + 1], image.data[index + 2], image.data[index + 3]];
}

export function measureDecal(image) {
  let alphaPixels = 0;
  let inkPixels = 0;
  let redPixels = 0;
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  let inkMinX = image.width;
  let inkMinY = image.height;
  let inkMaxX = -1;
  let inkMaxY = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const [r, g, b, a] = pixel(image, x, y);
      if (a <= 8) continue;
      alphaPixels += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const saturation = Math.max(r, g, b) - Math.min(r, g, b);
      if (a > 127 && (saturation > 24 || luma < 150)) {
        inkPixels += 1;
        if (x < inkMinX) inkMinX = x;
        if (x > inkMaxX) inkMaxX = x;
        if (y < inkMinY) inkMinY = y;
        if (y > inkMaxY) inkMaxY = y;
      }
      if (r > g + 40 && r > b + 40) redPixels += 1;
    }
  }
  return {
    width: image.width,
    height: image.height,
    alphaPixels,
    inkPixels,
    inkBBox:
      inkMaxX < 0
        ? null
        : { left: inkMinX, top: inkMinY, right: inkMaxX, bottom: inkMaxY },
    redPixels,
    alphaBBox: maxX < 0 ? null : { left: minX, top: minY, right: maxX, bottom: maxY },
    transparentFraction: Number((1 - alphaPixels / (image.width * image.height)).toFixed(5)),
    cornerAlpha: [pixel(image, 0, 0)[3], pixel(image, image.width - 1, 0)[3], pixel(image, 0, image.height - 1)[3], pixel(image, image.width - 1, image.height - 1)[3]],
  };
}

export function sha256Rgba(image) {
  return createHash('sha256').update(Buffer.from(image.data)).digest('hex');
}
