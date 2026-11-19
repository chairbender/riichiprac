#!/usr/bin/env node
/**
 * Bake the Task 4A bevel-crevice masks (no Blender).
 *
 *   node tools/render/scripts/bake-shadow-seams.mjs
 *
 * Four soft gradient edge masks in normalized face UV, plus the manifest the
 * runtime reads. Each mask is the narrow ambient occlusion that forms inside
 * the beveled valley when another tile sits flush against that edge of a tile,
 * authored in a 0..1 square so one mask maps onto any bucket's `faceQuad`:
 *
 *   ao_seam_left.png    peaks on the tile's -u edge (its local -X edge)
 *   ao_seam_right.png   peaks on the +u edge
 *   ao_seam_top.png     peaks on the -v edge (its local +Y edge)
 *   ao_seam_bottom.png  peaks on the +v edge
 *
 * The profile is a raised cosine from `peakAlpha` at the outer edge to 0 at the
 * fade width, so there is no hard cut: darkening at the valley, nothing by the
 * flat of the face, and the runtime can scale the whole thing by the 50-70 %
 * opacity Task 6A's pass 3 asks for. Every mask is black ink with the AO in
 * alpha (grayscale), matching the mat shadows' multiply composite.
 *
 * The fade is authored per axis so the *physical* band is the bevel's own
 * width on all four edges: 0.10 of the tile's 21 mm width along u, and 0.075 of
 * its 28 mm height along v (the same 0.10 of tile width). The acceptance range
 * is 8 %-12 % of the tile width, measured below in those terms and printed.
 */
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './png.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tableDir = resolve(renderDir, '..', '..', 'frontend', 'public', 'table');
const spec = JSON.parse(readFileSync(resolve(renderDir, 'board-assets-spec.json'), 'utf8'));
const shell = JSON.parse(readFileSync(resolve(renderDir, 'shell-spec.json'), 'utf8'));
const shadows = spec.shadows;
const crevices = shadows.crevices;

const tileWidth = shell.tile.proportionsMm.width;
const tileHeight = shell.tile.proportionsMm.height;

/** Raised cosine: full peak at t = 0, exactly 0 at t = 1, flat at both ends. */
function profile(t) {
  if (t <= 0) return 1;
  if (t >= 1) return 0;
  return 0.5 * (1 + Math.cos(Math.PI * t));
}

/**
 * One edge mask. `axis` is 'u' or 'v'; `side` is the edge the AO grows from
 * ('low' = the 0 end of the axis). Alpha is uniform along the edge: the AO band
 * runs the whole length of a flush neighbour, which is the flat approximation
 * Task 4A's acceptance defines.
 */
function mask(axis, side, size, peak, fade) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const t = axis === 'u' ? (x + 0.5) / size : (y + 0.5) / size;
      const along = side === 'low' ? t : 1 - t;
      const value = along >= fade ? 0 : peak * profile(along / fade);
      const i = (y * size + x) * 4;
      // Black ink, occlusion in alpha: source-over black == multiply by (1-a).
      rgba[i] = 0;
      rgba[i + 1] = 0;
      rgba[i + 2] = 0;
      rgba[i + 3] = Math.round(value * 255);
    }
  }
  return rgba;
}

function alphaOf(rgba) {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < out.length; i += 1) out[i] = rgba[i * 4 + 3];
  return out;
}

/** Measurements the gate re-checks, so the numbers are in the manifest. */
function measure(rgba, axis, side, size, peak, fade) {
  const alpha = alphaOf(rgba);
  const mid = Math.floor(size / 2);
  const line = [];
  for (let i = 0; i < size; i += 1) {
    const x = axis === 'u' ? i : mid;
    const y = axis === 'u' ? mid : i;
    line.push(alpha[y * size + x]);
  }
  // Normalize so index 0 is the outer edge.
  const samples = side === 'low' ? line : line.slice().reverse();
  const firstNonZero = samples.findIndex((value) => value > 0);
  const lastNonZero = samples.length - 1 - samples.slice().reverse().findIndex((value) => value > 0);
  const edgeAlpha = Math.max(...samples.slice(0, 2)) / 255;
  let fadeIndex = -1;
  for (let i = 0; i < samples.length; i += 1) {
    if (samples[i] === 0) {
      fadeIndex = i;
      break;
    }
  }
  let monotonic = true;
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i] > samples[i - 1]) monotonic = false;
  }
  // Constancy along the edge (the middle 80 %, clear of the corners).
  const strip = { min: 1, max: 0 };
  for (let along = Math.floor(size * 0.1); along < Math.floor(size * 0.9); along += 1) {
    const x = axis === 'u' ? Math.floor(size * 0.5) : along;
    const y = axis === 'u' ? along : Math.floor(size * 0.5);
    const value = alpha[y * size + x] / 255;
    strip.min = Math.min(strip.min, value);
    strip.max = Math.max(strip.max, value);
  }
  return {
    edgeAlpha: Number(edgeAlpha.toFixed(4)),
    peakAlpha: Number(peak.toFixed(4)),
    fadeAxisFraction: Number((fadeIndex / size).toFixed(4)),
    fadeFractionOfTileWidth: Number(
      ((fadeIndex / size) * (axis === 'u' ? 1 : tileHeight / tileWidth)).toFixed(4),
    ),
    firstNonZero,
    lastNonZero,
    monotonic,
    edgeConstancy: Number((strip.max - strip.min).toFixed(4)),
  };
}

const dir = resolve(renderDir, crevices.dir);
mkdirSync(dir, { recursive: true });
const size = Number(crevices.size);
const peak = Number(crevices.peakAlpha);
const records = {};
const summary = [];

for (const edge of crevices.edges) {
  const axis = edge === 'left' || edge === 'right' ? 'u' : 'v';
  const side = edge === 'left' || edge === 'top' ? 'low' : 'high';
  const fade = Number(crevices.fadeFractionOfAxis[edge]);
  if (!fade) throw new Error(`no fade fraction for ao_seam_${edge}`);
  const rgba = mask(axis, side, size, peak, fade);
  const name = `ao_seam_${edge}.png`;
  const path = resolve(dir, name);
  const bytes = encodePng(size, size, 4, rgba);
  writeFileSync(path, bytes);
  const measured = measure(rgba, axis, side, size, peak, fade);
  records[edge] = {
    edge,
    axis,
    side,
    textureFile: `shadows/${name}`,
    width: size,
    height: size,
    channels: 'RGBA',
    ink: 'black',
    alphaChannel: 'occlusion',
    profile: crevices.profile,
    fadeFractionOfAxis: fade,
    source: {
      widthMm: tileWidth,
      heightMm: tileHeight,
      note: 'The fade is authored per axis so the physical band matches the 1.54 mm bevel on both axes.',
    },
    measured,
    bytes: statSync(path).size,
    sha256: {
      decodedRgba: createHash('sha256').update(rgba).digest('hex'),
    },
  };
  summary.push(
    `[seam] ${edge.padEnd(7)} ${size}x${size} ${records[edge].bytes} B ` +
      `edge ${measured.edgeAlpha.toFixed(3)} fade ${measured.fadeAxisFraction.toFixed(3)} (u/v) ` +
      `= ${measured.fadeFractionOfTileWidth.toFixed(3)} of tile width, ` +
      `monotonic ${measured.monotonic}`,
  );
}

const manifest = {
  version: 1,
  generatedBy: 'tools/render/scripts/bake-shadow-seams.mjs',
  task: '4A',
  tile: { widthMm: tileWidth, heightMm: tileHeight, bevelWidthUnits: shell.tile.bevel.width },
  profile: crevices.profile,
  peakAlpha: peak,
  resolution: { width: size, height: size },
  coordinateSpace:
    'Normalized face UV: (0,0) is the face quad\'s top-left corner and (1,1) its ' +
    'bottom-right, exactly like the face atlas cell mapped onto a blank\'s faceQuad. ' +
    'Each mask is a full square with the gradient along one edge, so the runtime maps ' +
    'the whole image onto faceQuad and never needs a per-bucket variant.',
  runtime:
    'Draw for each occupied orthogonal neighbour (hasLeft/hasRight/hasTop/hasBottom) at 50-70 % of the mask\'s own alpha; open edges draw nothing so the lit bevel stays bright (Task 6A pass 3).',
  seams: records,
  totals: { masks: Object.keys(records).length, bytes: Object.values(records).reduce((sum, r) => sum + r.bytes, 0) },
};
const manifestPath = resolve(renderDir, crevices.manifest);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
for (const line of summary) console.log(line);
console.log(`\n${Object.keys(records).length} seam masks -> ${dir}`);
console.log(`${manifestPath}`);
