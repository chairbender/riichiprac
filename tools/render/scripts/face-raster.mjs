/**
 * Shared face-SVG → transparent PNG rasterisation.
 *
 * Both the single-file CLI (`rasterize-face.mjs`) and the 38-code baker
 * (`bake-faces.mjs`) go through this module so the glyph assets have exactly
 * one rasteriser configuration. It never runs in the browser: the runtime
 * composites the committed PNGs with Canvas 2D.
 */
import { Resvg } from '@resvg/resvg-js';

const hexToRgb = (hex) => {
  const value = String(hex).replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(`invalid hex colour ${hex}`);
  }
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
};

const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const toHex = (rgb) =>
  '#' +
  rgb
    .map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0'))
    .join('');

/**
 * Recolour the symbol's red fills while preserving each fill's relative
 * brightness, so internal paint shading survives. Black fills (the manzu bar,
 * pin/sou outlines) are untouched.
 *
 * Returns `{ svg, replaced }`; `replaced` counts the fills changed, which the
 * baker records so a face with no red is not silently assumed to have one.
 */
export function recolourReds(svg, baseHex, targetHex) {
  if (!baseHex || !targetHex || baseHex === targetHex) return { svg, replaced: 0 };
  const baseLuma = luma(hexToRgb(baseHex));
  if (!baseLuma) return { svg, replaced: 0 };
  const target = hexToRgb(targetHex);
  let replaced = 0;
  const recoloured = svg.replace(/#([0-9a-fA-F]{6})\b/g, (match, hex) => {
    const rgb = hexToRgb(hex);
    if (!(rgb[0] > rgb[1] + 24 && rgb[0] > rgb[2] + 24)) return match;
    replaced += 1;
    const factor = luma(rgb) / baseLuma;
    return toHex(target.map((value) => value * factor));
  });
  return { svg: recoloured, replaced };
}

/**
 * Rasterise one SVG at `width` px, keeping its aspect ratio, on a transparent
 * background. `shapeRendering: 'geometricPrecision'` is resvg's geometric
 * precision mode; hinting/aliasing is deterministic for a fixed input.
 */
export function rasterizeSvg(svg, { width, shapeRendering = 2 } = {}) {
  if (!Number.isFinite(width) || width <= 0) {
    throw new Error('rasterizeSvg needs a positive width');
  }
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: Math.round(width) },
    background: 'rgba(0, 0, 0, 0)',
    shapeRendering,
    imageRendering: 0,
  }).render();
}
