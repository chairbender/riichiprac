#!/usr/bin/env node
/**
 * Rasterise the spike tile face SVGs to PNG textures for the Blender scene.
 *
 * Two rasters come from the same 300 x 400 viewBox, so they align exactly:
 *   <code>-<w>x<h>.png        the full face (white plate + symbol) = albedo
 *   <code>-symbol-<w>x<h>.png the symbol alone on transparent = carve mask
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
const faceDir = join(renderDir, 'build', 'faces');

function rasterise(sourcePath, outPath, label) {
  const svg = readFileSync(sourcePath, 'utf8');
  const rendered = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    background: 'rgba(0, 0, 0, 0)',
    shapeRendering: 2,
    imageRendering: 0,
  }).render();
  if (rendered.width !== width || rendered.height !== height) {
    throw new Error(
      `${label} rasterised at ${rendered.width}x${rendered.height}, expected ${width}x${height}`,
    );
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, rendered.asPng());
  console.log(`[render] ${label} ${decal.code}: ${sourcePath} -> ${outPath} (${width}x${height})`);
}

rasterise(
  resolve(dirname(specPath), decal.svg),
  join(faceDir, `${decal.code}-${width}x${height}.png`),
  'face',
);
rasterise(
  resolve(dirname(specPath), decal.symbolSvg),
  join(faceDir, `${decal.code}-symbol-${width}x${height}.png`),
  'carve mask',
);
