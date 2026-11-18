#!/usr/bin/env node
/**
 * Sample measurement for the 2.5D rig reference. Pure image maths, no Blender.
 *
 * The rig proves its lighting with pixel facts (AGENTS.md 6): a point probe
 * averages a small window (a blank ivory face, a blue back, the felt), and a
 * polygon probe averages every pixel centre inside a projected face. The side
 * walls' inner vertical faces are only ~3.5 px wide at 1920, so a window probe
 * would spill onto the felt and lie.
 */
import { meanAround, meanInsidePolygon } from './png.mjs';

export const lumaOf = (rgb) => rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;

/** Measured RGBA, luma and pixel count for every rig sample. */
export function measureRigSamples(image, samples) {
  const measured = {};
  for (const [name, sample] of Object.entries(samples)) {
    const result = sample.kind === 'polygon'
      ? meanInsidePolygon(image, sample.polygon)
      : meanAround(image, sample.pixel[0], sample.pixel[1], sample.radiusPx ?? 0);
    if (!result) {
      measured[name] = null;
      continue;
    }
    const rgb = result.rgba.slice(0, 3);
    measured[name] = {
      rgb: rgb.map((value) => Number(value.toFixed(1))),
      alpha: Number((result.rgba[3] ?? 255).toFixed(1)),
      luma: Number(lumaOf(rgb).toFixed(1)),
      pixels: result.pixels,
    };
  }
  return measured;
}

/** How much of the frame the transparent film actually leaves transparent. */
export function alphaCoverage(image) {
  const total = image.width * image.height;
  let transparent = 0;
  let opaque = 0;
  let partial = 0;
  if (image.channels !== 4) {
    return { transparentPct: 0, opaquePct: 100, partialPct: 0, channels: image.channels };
  }
  for (let index = 3; index < image.data.length; index += image.channels) {
    const alpha = image.data[index];
    if (alpha === 0) transparent += 1;
    else if (alpha === 255) opaque += 1;
    else partial += 1;
  }
  const pct = (value) => Number(((value / total) * 100).toFixed(2));
  return {
    transparentPct: pct(transparent),
    opaquePct: pct(opaque),
    partialPct: pct(partial),
    channels: image.channels,
  };
}

/** Alpha at the four frame corners and at a pixel. */
export function alphaAt(image, pixel) {
  if (image.channels !== 4) return null;
  const [x, y] = pixel;
  const px = Math.min(image.width - 1, Math.max(0, Math.round(x)));
  const py = Math.min(image.height - 1, Math.max(0, Math.round(y)));
  return image.data[(py * image.width + px) * image.channels + 3];
}
