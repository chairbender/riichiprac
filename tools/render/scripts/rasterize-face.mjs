#!/usr/bin/env node
/**
 * Rasterise the spike tile symbol SVG to a PNG texture for the Blender scene.
 *
 * The upstream "regular" variant is the symbol alone (no face plate) on a
 * transparent 300 x 400 canvas. One raster serves two jobs:
 *   - its alpha is the carve mask (blurred into the groove profile)
 *   - its colour is the engraving paint (red/black)
 * The face itself is the melamine material colour, so no full-face raster is
 * needed: the symbol-only SVG aligns with the upstream full-face variant.
 *
 * Uses @resvg/resvg-js (the pinned offline SVG rasteriser). No headless browser,
 * no sharp, no system rsvg.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const specPath = resolve(process.argv[2] ?? join(renderDir, 'scene-spec.json'));
const spec = JSON.parse(readFileSync(specPath, 'utf8'));

const [cssWidth, cssHeight] = spec.decals.cssFace;
const scale = spec.decals.renderScale;
const width = Math.round(cssWidth * scale);
const height = Math.round(cssHeight * scale);

const decal = spec.spike.decal;
const sourcePath = resolve(dirname(specPath), decal.symbolSvg);
const outPath = join(renderDir, 'build', 'faces', `${decal.code}-symbol-${width}x${height}.png`);

const hexToRgb = (hex) => {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
};
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const toHex = (rgb) =>
  '#' +
  rgb
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
    .join('');

/**
 * Recolour the symbol's red fills to `targetHex` while preserving their
 * relative brightness, so the paint's internal shading survives the change.
 * Black fills (the manzu bar) are untouched because they are not red.
 */
function recolourReds(svg, baseHex, targetHex) {
  if (!baseHex || !targetHex) return svg;
  const baseLuma = luma(hexToRgb(baseHex));
  if (!baseLuma) return svg;
  const target = hexToRgb(targetHex);
  let count = 0;
  const replaced = svg.replace(/#([0-9a-fA-F]{6})\b/g, (match, hex) => {
    const rgb = hexToRgb(hex);
    if (!(rgb[0] > rgb[1] + 24 && rgb[0] > rgb[2] + 24)) return match;
    count += 1;
    const factor = luma(rgb) / baseLuma;
    return toHex(target.map((v) => v * factor));
  });
  if (count === 0) {
    console.warn(`[render] no red fills found in ${sourcePath}; paint colour unchanged`);
  }
  return replaced;
}


const svg = readFileSync(sourcePath, 'utf8');
const paint = spec.tile?.materials?.paint ?? {};
const recoloured = recolourReds(svg, paint.redBase, paint.red);
const rendered = new Resvg(recoloured, {
  fitTo: { mode: 'width', value: width },
  background: 'rgba(0, 0, 0, 0)',
  shapeRendering: 2,
  imageRendering: 0,
}).render();
if (rendered.width !== width || rendered.height !== height) {
  throw new Error(
    `symbol rasterised at ${rendered.width}x${rendered.height}, expected ${width}x${height}`,
  );
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, rendered.asPng());
console.log(
  `[render] symbol/paint ${decal.code}: ${sourcePath} -> ${outPath} (${width}x${height})`,
);
