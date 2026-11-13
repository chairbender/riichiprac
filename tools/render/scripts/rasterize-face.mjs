#!/usr/bin/env node
/**
 * Rasterise the spike tile face SVG to a PNG texture for the Blender scene.
 *
 * The face source is a full-face SVG (300 x 400 viewBox, ivory plate + symbol)
 * vendored under tools/render/faces. The output is the full face at
 * `cssFace * renderScale` pixels, i.e. the resolution the decal plane samples
 * 1:1 across the inset face.
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
const svgPath = resolve(dirname(specPath), decal.svg);
const outPath = join(renderDir, 'build', 'faces', `${decal.code}-${width}x${height}.png`);

const svg = readFileSync(svgPath, 'utf8');
const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: width },
  background: 'rgba(0, 0, 0, 0)',
  shapeRendering: 2,
  imageRendering: 0,
});

const rendered = resvg.render();
if (rendered.width !== width || rendered.height !== height) {
  throw new Error(
    `face rasterised at ${rendered.width}x${rendered.height}, expected ${width}x${height}`,
  );
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, rendered.asPng());
console.log(`[render] face ${decal.code}: ${svgPath} -> ${outPath} (${width}x${height})`);
