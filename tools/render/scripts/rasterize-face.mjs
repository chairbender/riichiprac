#!/usr/bin/env node
/**
 * Rasterise a vendored tile-face SVG to a PNG glyph.
 *
 *   node tools/render/scripts/rasterize-face.mjs <input.svg> <output.png> [options]
 *
 *   --width N        raster width in pixels (default 300)
 *   --red HEX        recolour the symbol's red fills to this hex
 *   --red-base HEX   the SVG's current red, used to preserve relative shading
 *
 * Uses @resvg/resvg-js, the pinned offline SVG rasteriser: no headless browser,
 * no sharp, no system rsvg. The 38-code set is baked in one pass by
 * `bake-faces.mjs`; this single-file form exists for inspecting one glyph.
 * Never rasterise tile art in the browser.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recolourReds, rasterizeSvg } from './face-raster.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage(message) {
  if (message) console.error(`[faces] ${message}`);
  console.error(
    'usage: node tools/render/scripts/rasterize-face.mjs <input.svg> <output.png> [--width N] [--red HEX] [--red-base HEX]',
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const positional = [];
const options = {};
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--width' || arg === '--red' || arg === '--red-base') {
    if (i + 1 >= args.length) usage(`${arg} needs a value`);
    options[arg.slice(2)] = args[i + 1];
    i += 1;
  } else if (arg.startsWith('--')) {
    usage(`unknown option ${arg}`);
  } else {
    positional.push(arg);
  }
}
if (positional.length !== 2) usage('expected an input SVG and an output PNG');

const inputPath = resolve(positional[0]);
const outputPath = resolve(positional[1]);
const width = Number(options.width ?? 300);
if (!Number.isFinite(width) || width <= 0) usage('--width must be a positive number');

let svg;
try {
  svg = readFileSync(inputPath, 'utf8');
} catch (error) {
  console.error(`[faces] cannot read ${inputPath}: ${error.message}`);
  process.exit(1);
}

let paint = {};
try {
  paint = JSON.parse(readFileSync(join(renderDir, 'faces-spec.json'), 'utf8')).raster?.paint ?? {};
} catch {
  // Paint defaults are optional; explicit flags still work without the spec.
}
const redBase = options['red-base'] ?? paint.redBase;
const red = options.red ?? paint.red;
const recoloured = recolourReds(svg, redBase, red);
if (redBase !== red && recoloured.replaced === 0) {
  console.warn(`[faces] no red fills found in ${inputPath}; paint colour unchanged`);
}

const rendered = rasterizeSvg(recoloured.svg, { width });
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, rendered.asPng());
console.log(`[faces] ${inputPath} -> ${outputPath} (${rendered.width}x${rendered.height})`);
