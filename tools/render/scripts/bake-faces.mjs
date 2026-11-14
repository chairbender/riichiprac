#!/usr/bin/env node
/**
 * Bake all 38 tile face glyphs for the 2.5D rendered view.
 *
 *   node tools/render/scripts/bake-faces.mjs [--verify-determinism]
 *
 * Reads `faces-spec.json`, rasterises the vendored symbol-only SVGs with the
 * pinned `@resvg/resvg-js` (no Blender, no browser), writes
 * `frontend/public/table/faces/<id>.png` and `frontend/public/table/faces.json`.
 *
 * The blank face has no asset: an empty tile face is the bare shell, so the
 * manifest records `textureFile: null` and the atlas draws no glyph. The
 * upstream `Regular-Blank.svg` is a red question mark, not a blank tile.
 *
 * Every PNG's *decoded RGBA* sha256 is recorded, not the PNG container bytes:
 * resvg is deterministic for a fixed SVG and width, but re-encoding can change
 * the zlib stream. A hand-edited PNG fails the integrity check.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recolourReds, rasterizeSvg } from './face-raster.mjs';
import { decodePng } from './png.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const specPath = join(renderDir, 'faces-spec.json');
const verifyDeterminism = process.argv.includes('--verify-determinism');

const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const outputDir = resolve(renderDir, spec.output.dir);
const manifestPath = resolve(renderDir, spec.output.manifest);
const { width, shapeRendering } = spec.raster;
const paint = spec.raster.paint ?? {};

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function measure(image) {
  const { width: w, height: h, data } = image;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  let inkPixels = 0;
  let opaquePixels = 0;
  let redPixels = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a > 8) {
        inkPixels += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (a > 250) opaquePixels += 1;
        if (r > g + 40 && r > b + 40) redPixels += 1;
      }
    }
  }
  return {
    width: w,
    height: h,
    inkPixels,
    inkFraction: Number((inkPixels / (w * h)).toFixed(4)),
    opaquePixels,
    redPixels,
    inkBBox: maxX < 0 ? null : { left: minX, top: minY, right: maxX, bottom: maxY },
  };
}

function rgbaBuffer(image) {
  // decodePng returns RGB for colour type 2 and RGBA for colour type 6. resvg
  // always emits RGBA, but normalise anyway so the hash is channel-stable.
  if (image.channels === 4 || image.data.length === image.width * image.height * 4) {
    return image.data;
  }
  const out = Buffer.alloc(image.width * image.height * 4);
  for (let i = 0, j = 0; i < image.data.length; i += 3, j += 4) {
    out[j] = image.data[i];
    out[j + 1] = image.data[i + 1];
    out[j + 2] = image.data[i + 2];
    out[j + 3] = 255;
  }
  return out;
}

mkdirSync(outputDir, { recursive: true });

const faces = {};
let totalBytes = 0;
let glyphCount = 0;

for (const face of spec.faces) {
  if (!face.source) {
    faces[face.id] = {
      textureFile: null,
      sourceSvg: null,
      upstreamPath: null,
      ...pickFaceMeta(face),
      measured: null,
      sha256: null,
    };
    continue;
  }

  const sourcePath = resolve(renderDir, face.source);
  const svg = readFileSync(sourcePath, 'utf8');
  const recoloured = recolourReds(svg, paint.redBase, paint.red);
  const rendered = rasterizeSvg(recoloured.svg, { width, shapeRendering });
  const png = rendered.asPng();
  const decoded = decodePng(png, `faces/${face.id}.png`);
  const measured = measure(decoded);
  if (verifyDeterminism) {
    const second = rasterizeSvg(recoloured.svg, { width, shapeRendering }).asPng();
    const secondDecoded = decodePng(second, `faces/${face.id}.png (second)`);
    if (!rgbaBuffer(decoded).equals(rgbaBuffer(secondDecoded))) {
      throw new Error(`faces/${face.id}.png is not deterministic`);
    }
  }

  const fileName = `${face.id}.png`;
  writeFileSync(join(outputDir, fileName), png);
  totalBytes += png.length;
  glyphCount += 1;
  faces[face.id] = {
    textureFile: `faces/${fileName}`,
    sourceSvg: face.source,
    upstreamPath: `${spec.source.path}/${basename(face.source)}`,
    ...pickFaceMeta(face),
    redFillsRecoloured: recoloured.replaced,
    bytes: png.length,
    measured,
    sha256: { decodedRgba: sha256(rgbaBuffer(decoded)) },
  };
  console.log(
    `[faces] ${face.id.padEnd(6)} ${rendered.width}x${rendered.height} ` +
      `${png.length} B ink ${measured.inkPixels}`,
  );
}

function pickFaceMeta(face) {
  const meta = { kind: face.kind };
  if (face.suit) meta.suit = face.suit;
  if (face.rank) meta.rank = face.rank;
  if (face.red) meta.red = face.red;
  if (face.honour) meta.honour = face.honour;
  return meta;
}

const manifest = {
  version: 1,
  generatedBy: 'tools/render/scripts/bake-faces.mjs',
  coordinateSpace:
    'Each textureFile is an RGBA PNG of the glyph on a transparent background. The atlas maps its full [0,0,width,height] rect onto the shell faceQuad in faceQuadOrder (face-local top-left, top-right, bottom-right, bottom-left), which applies faceRotationDeg. Width/height here are source pixels; the atlas draws them at shell-texture scale, not at these dimensions.',
  source: spec.source,
  raster: {
    width,
    height: spec.raster.height,
    format: spec.raster.format,
    shapeRendering: spec.raster.shapeRendering,
    paint,
  },
  blank: {
    face: 'blank',
    reason: 'An empty tile face is the bare shell; no glyph is composited.',
  },
  budget: { bytes: spec.output.bytesBudget },
  totals: { faces: Object.keys(faces).length, glyphAssets: glyphCount, bytes: totalBytes },
  faces,
};

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `[faces] wrote ${glyphCount} glyphs + 1 assetless blank (${totalBytes} B, budget ${spec.output.bytesBudget} B)`,
);
console.log(`[faces] ${manifestPath}`);
