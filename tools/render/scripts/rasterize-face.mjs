#!/usr/bin/env node
/**
 * Rasterise a vendored tile-face SVG to a PNG glyph.
 *
 *   node tools/render/scripts/rasterize-face.mjs <input.svg> <output.png> [options]
 *
 *   --width N        raster width in pixels (default 300, the SVG's own width)
 *   --red HEX        recolour the symbol's red fills to this hex
 *   --red-base HEX   the SVG's current red, used to preserve relative shading
 *
 * Uses @resvg/resvg-js, the pinned offline SVG rasteriser: no headless browser,
 * no sharp, no system rsvg. The 2.5D runtime composites these 2D glyphs into
 * each shell's `faceQuad` in a startup atlas; the shells themselves are baked
 * by `bake_shells.py`. Keeping the rasteriser here means Phase 1/2 can produce
 * display-sized face textures without rasterising tile art in the browser.
 *
 * The red defaults come from `shell-spec.json` (`tile.materials.paint`). The
 * recolour preserves each red fill's relative brightness, so internal paint
 * shading survives; black fills (the manzu bar) are untouched.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

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

const hexToRgb = (hex) => {
  const value = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(value)) usage(`invalid hex colour ${hex}`);
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
};
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const toHex = (rgb) =>
  '#' +
  rgb
    .map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0'))
    .join('');

function recolourReds(svg, baseHex, targetHex) {
  if (!baseHex || !targetHex || baseHex === targetHex) return svg;
  const baseLuma = luma(hexToRgb(baseHex));
  if (!baseLuma) return svg;
  const target = hexToRgb(targetHex);
  let count = 0;
  const replaced = svg.replace(/#([0-9a-fA-F]{6})\b/g, (match, hex) => {
    const rgb = hexToRgb(hex);
    if (!(rgb[0] > rgb[1] + 24 && rgb[0] > rgb[2] + 24)) return match;
    count += 1;
    const factor = luma(rgb) / baseLuma;
    return toHex(target.map((value) => value * factor));
  });
  if (count === 0) {
    console.warn(`[faces] no red fills found in ${inputPath}; paint colour unchanged`);
  }
  return replaced;
}

let svg;
try {
  svg = readFileSync(inputPath, 'utf8');
} catch (error) {
  console.error(`[faces] cannot read ${inputPath}: ${error.message}`);
  process.exit(1);
}

let paint = {};
try {
  paint = JSON.parse(readFileSync(join(renderDir, 'shell-spec.json'), 'utf8')).tile?.materials?.paint ?? {};
} catch {
  // The paint defaults are optional; explicit flags still work without the spec.
}
const redBase = options['red-base'] ?? paint.redBase;
const red = options.red ?? paint.red;

const rendered = new Resvg(recolourReds(svg, redBase, red), {
  fitTo: { mode: 'width', value: Math.round(width) },
  background: 'rgba(0, 0, 0, 0)',
  shapeRendering: 2,
  imageRendering: 0,
}).render();

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, rendered.asPng());
console.log(`[faces] ${inputPath} -> ${outputPath} (${rendered.width}x${rendered.height})`);
