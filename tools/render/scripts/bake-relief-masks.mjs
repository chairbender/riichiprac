#!/usr/bin/env node
/**
 * Rasterise the carve artwork for the Task 4B relief bake.
 *
 *   node tools/render/scripts/bake-relief-masks.mjs
 *
 * This is the Node half of the relief pipeline: it reads `relief-spec.json`,
 * re-rasterises the vendored public-domain symbol SVGs at the bake's artwork
 * resolution (1200 x 1600 by default, ~57 px/mm on the face plate) with the
 * pinned `@resvg/resvg-js`, and writes them plus an exact signed-distance field
 * to the gitignored mask directory that `tools/render/bake_relief.py` reads
 * inside Blender. The recolour is the same `recolourReds` the committed flat
 * glyphs use, so the relief pigment is the exact flat-glyph pigment.
 *
 * The 1200 x 1600 mask PNG is the pigment + paint-mask artwork. The companion
 * `<face>.f32` is a little-endian float32 grid of the same size holding the
 * signed distance to the glyph outline in millimetres (positive inside the
 * glyph). It is the high-resolution displacement field the Blender half uses to
 * build the carved mesh: a 0.55 mm engraving and its 0.655 mm V-carve run are
 * 31 and 37 px at this resolution, so the bevel is resolved, not guessed.
 *
 * Both are build artifacts, not committed assets.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recolourReds, rasterizeSvg } from './face-raster.mjs';
import { decodePng } from './png.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(readFileSync(join(renderDir, 'relief-spec.json'), 'utf8'));
const facesSpec = JSON.parse(readFileSync(join(renderDir, spec.source.facesSpec), 'utf8'));
const shellSpec = JSON.parse(readFileSync(join(renderDir, spec.source.shellSpec), 'utf8'));
const maskDir = resolve(renderDir, spec.source.maskDir);
const width = Number(spec.source.maskWidth);
const paint = facesSpec.raster.paint ?? {};
const shapeRendering = facesSpec.raster.shapeRendering ?? 2;
const height = Math.round((width * 400) / 300);

// The relief plate is the same inset face plate the flat glyphs and carved
// decals use: the tile's width and height minus the 0.055-unit faceInset on
// every side, i.e. 0.64 x 0.89 tile units = 17.92 x 24.92 mm. The bake cell is
// 256 x 340 px, so the texel is 14.286 px/mm across and 13.643 px/mm down; that
// 4.7% anisotropy is recorded in the manifest rather than hidden, and the
// distance field is computed with a per-axis weight so its millimetres are real.
const tile = shellSpec.tile;
const mmPerUnit = tile.proportionsMm.height / tile.heightUnits;
const tileWidthUnits = (tile.heightUnits * tile.proportionsMm.width) / tile.proportionsMm.height;
const plateWidthMm = (tileWidthUnits - 2 * tile.faceInset) * mmPerUnit;
const plateHeightMm = (tile.heightUnits - 2 * tile.faceInset) * mmPerUnit;
const mmPerPixelX = plateWidthMm / width;
const mmPerPixelY = plateHeightMm / height;

mkdirSync(maskDir, { recursive: true });

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function measure(image) {
  let ink = 0;
  let opaque = 0;
  for (let i = 3; i < image.data.length; i += 4) {
    if (image.data[i] > 8) ink += 1;
    if (image.data[i] > 250) opaque += 1;
  }
  return {
    pixels: image.width * image.height,
    inkPixels: ink,
    inkFraction: Number((ink / (image.width * image.height)).toFixed(6)),
    opaqueFraction: Number((opaque / (image.width * image.height)).toFixed(6)),
  };
}

/**
 * Felzenszwalb & Huttenlocher's exact 1D squared distance transform, with an
 * axis weight: for each sample q, min over p of weight*(q - p)^2 + f[p]. The
 * lower envelope of the parabolas is built in one pass and read back in a
 * second. The weight lets the millimetre grid be anisotropic (the 256 x 340
 * cell is 14.286 px/mm across and 13.643 px/mm down) without faking the
 * distances with a mean scale.
 */
function squaredDistance1d(f, n, weight, out, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q += 1) {
    const qf = f[q] + weight * q * q;
    let s = (qf - (f[v[k]] + weight * v[k] * v[k])) / (2 * weight * (q - v[k]));
    while (s <= z[k]) {
      k -= 1;
      s = (qf - (f[v[k]] + weight * v[k] * v[k])) / (2 * weight * (q - v[k]));
    }
    k += 1;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q += 1) {
    while (z[k + 1] < q) k += 1;
    const d = q - v[k];
    out[q] = weight * d * d + f[v[k]];
  }
}

/**
 * 2D squared distance to the nearest sample where mask === true, in square
 * millimetres for a grid whose x and y spacing differ.
 */
function squaredDistance2d(mask, w, h, mmPerPixelX, mmPerPixelY) {
  const INF = 1e20;
  const wx = mmPerPixelX * mmPerPixelX;
  const wy = mmPerPixelY * mmPerPixelY;
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i += 1) grid[i] = mask[i] ? 0 : INF;
  const rowOut = new Float64Array(w);
  const rowF = new Float64Array(w);
  const v = new Int32Array(Math.max(w, h) + 1);
  const z = new Float64Array(Math.max(w, h) + 2);
  for (let y = 0; y < h; y += 1) {
    const base = y * w;
    rowF.set(grid.subarray(base, base + w));
    squaredDistance1d(rowF, w, wx, rowOut, v, z);
    grid.set(rowOut, base);
  }
  const colF = new Float64Array(h);
  const colOut = new Float64Array(h);
  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) colF[y] = grid[y * w + x];
    squaredDistance1d(colF, h, wy, colOut, v, z);
    for (let y = 0; y < h; y += 1) grid[y * w + x] = colOut[y];
  }
  return grid;
}

/**
 * Signed distance to the glyph outline in millimetres, positive inside.
 * Alpha >= 0.5 is the etched area; the field is exact (not a blur estimate).
 */
function signedDistanceField(image) {
  const { width: w, height: h, data } = image;
  const inside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) inside[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
  const outside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) outside[i] = inside[i] ? 0 : 1;
  const toInside = squaredDistance2d(inside, w, h, mmPerPixelX, mmPerPixelY);
  const toOutside = squaredDistance2d(outside, w, h, mmPerPixelX, mmPerPixelY);
  const field = new Float32Array(w * h);
  let min = Infinity;
  let max = -Infinity;
  let insidePixels = 0;
  for (let i = 0; i < w * h; i += 1) {
    // Clamp to a couple of bevel runs: the carve ramp saturates well inside
    // this, and a bare face (haku, no glyph at all) has an unbounded distance
    // to the nearest ink, which must read as "flat plate", not infinity.
    const value = Math.max(-2, Math.min(2, inside[i] ? Math.sqrt(toOutside[i]) : -Math.sqrt(toInside[i])));
    field[i] = value;
    if (inside[i]) insidePixels += 1;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { field, min, max, insidePixels };
}

const masks = {};
let totalBytes = 0;
let totalFieldBytes = 0;
for (const face of facesSpec.faces) {
  const sourcePath = resolve(renderDir, face.source);
  const svg = readFileSync(sourcePath, 'utf8');
  const recoloured = recolourReds(svg, paint.redBase, paint.red);
  const rendered = rasterizeSvg(recoloured.svg, { width, shapeRendering });
  const png = rendered.asPng();
  const decoded = decodePng(png, `${face.id} mask`);
  if (decoded.width !== width || decoded.height !== height) {
    throw new Error(`${face.id} mask is ${decoded.width}x${decoded.height}, expected ${width}x${height}`);
  }
  const path = join(maskDir, `${face.id}.png`);
  writeFileSync(path, png);

  const distance = signedDistanceField(decoded);
  const fieldPath = join(maskDir, `${face.id}.f32`);
  const fieldBytes = Buffer.from(distance.field.buffer, distance.field.byteOffset, distance.field.byteLength);
  writeFileSync(fieldPath, fieldBytes);

  totalBytes += png.length;
  totalFieldBytes += fieldBytes.length;
  masks[face.id] = {
    file: `${face.id}.png`,
    fieldFile: `${face.id}.f32`,
    sourceSvg: face.source,
    redFillsRecoloured: recoloured.replaced,
    bytes: png.length,
    fieldBytes: fieldBytes.length,
    sha256: {
      png: sha256(png),
      field: sha256(fieldBytes),
      decodedRgba: sha256(Buffer.from(decoded.data)),
    },
    field: {
      encoding: 'float32-le',
      width,
      height,
      mmPerPixel: {
        x: Number(mmPerPixelX.toFixed(9)),
        y: Number(mmPerPixelY.toFixed(9)),
      },
      signedDistanceMm: {
        min: Number(distance.min.toFixed(6)),
        max: Number(distance.max.toFixed(6)),
      },
      insidePixels: distance.insidePixels,
    },
    ...measure(decoded),
  };
  console.log(
    `[relief-masks] ${face.id}: ${decoded.width}x${decoded.height}, ` +
      `ink ${masks[face.id].inkPixels} px (${(masks[face.id].inkFraction * 100).toFixed(2)}%), ` +
      `field ${distance.min.toFixed(2)}..${distance.max.toFixed(2)} mm, ` +
      `${png.length} B + ${fieldBytes.length} B`,
  );
}

const info = {
  version: 1,
  generatedBy: 'tools/render/scripts/bake-relief-masks.mjs',
  purpose:
    'High-resolution carve artwork and the exact signed-distance displacement field for bake_relief.py: the same symbol SVGs as the committed flat glyphs, rasterised and distance-transformed at the relief bake artwork scale. Build artifact, not committed.',
  raster: {
    width,
    height,
    format: '8-bit RGBA PNG',
    shapeRendering,
    paint,
  },
  plate: {
    widthMm: Number(plateWidthMm.toFixed(6)),
    heightMm: Number(plateHeightMm.toFixed(6)),
    mmPerPixel: {
      x: Number(mmPerPixelX.toFixed(9)),
      y: Number(mmPerPixelY.toFixed(9)),
    },
    notes:
      'The relief plate is the same inset face plate the flat glyphs and carved decals map into: tile width and height minus the 0.055-unit faceInset on every side (17.92 x 24.92 mm). The glyph 300 x 400 canvas maps 1:1 onto this plate, so the paint silhouette matches the flat glyph. The fixed 256 x 340 bake cell samples it at 14.286 px/mm across and 13.643 px/mm down, which is why the distance transform is weighted per axis.',
  },
  field: {
    encoding: 'float32-le',
    size: [width, height],
    bytesPerFace: width * height * 4,
    convention: 'Signed distance to the glyph outline in mm, positive inside the glyph.',
  },
  source: {
    facesSpec: spec.source.facesSpec,
    shellSpec: spec.source.shellSpec,
    upstream: facesSpec.source,
  },
  totals: {
    masks: Object.keys(masks).length,
    bytes: totalBytes,
    fieldBytes: totalFieldBytes,
  },
  masks,
};
writeFileSync(join(maskDir, 'masks.json'), JSON.stringify(info, null, 2) + '\n');
console.log(
  `[relief-masks] wrote ${Object.keys(masks).length} masks (${totalBytes} B PNG + ` +
    `${totalFieldBytes} B field) to ${maskDir}`,
);
