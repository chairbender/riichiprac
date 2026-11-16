#!/usr/bin/env node
/**
 * Encode the baked PNG decals into the committed AVIF/WebP set.
 *
 *   node tools/render/scripts/encode-decals.mjs [--format avif|webp] [--quality 60]
 *
 * Reads the full PNG bake manifest at `build/decals.json`, encodes each image,
 * writes `frontend/public/table/decals/`, re-decodes every encoded file to
 * measure it and hash its RGBA, and writes the committed `decals.json`.
 *
 * The decal checker (`check-decals.mjs`) validates the encoded files; the
 * shell/face checks stay dependency-free.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { loadRgba, measureDecal, sha256Rgba } from './decal-image.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = resolve(renderDir, '../..');
const specPath = join(renderDir, 'decal-spec.json');
const sourceManifestPath = join(renderDir, 'build/decals.json');

const args = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const format = valueOf('--format', 'avif');
const quality = Number(valueOf('--quality', '60'));
if (format !== 'avif' && format !== 'webp') {
  console.error('[decals] --format must be avif or webp');
  process.exit(2);
}
if (!Number.isFinite(quality) || quality < 1 || quality > 100) {
  console.error('[decals] --quality must be 1..100');
  process.exit(2);
}
if (!existsSync(sourceManifestPath)) {
  console.error('[decals] build/decals.json is missing; run bake-decals.sh --build first');
  process.exit(1);
}

const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const source = JSON.parse(readFileSync(sourceManifestPath, 'utf8'));
const outDir = resolve(renderDir, spec.output.dir);
const manifestPath = resolve(renderDir, spec.output.manifest);
const extension = format;
mkdirSync(outDir, { recursive: true });

// Remove only previously encoded decals; leave the build/ and review outputs.
for (const file of readdirSync(outDir)) {
  if (file.endsWith('.avif') || file.endsWith('.webp') || file.endsWith('.png')) {
    unlinkSync(join(outDir, file));
  }
}

const mime = format === 'avif' ? 'image/avif' : 'image/webp';
const records = {};
let totalBytes = 0;
let index = 0;
const count = Object.keys(source.decals).length;

for (const [key, record] of Object.entries(source.decals)) {
  const sourcePath = join(renderDir, 'build/decals', basename(record.textureFile));
  const image = await loadImage(readFileSync(sourcePath));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0);
  const encoded = canvas.toBuffer(mime, quality);
  const fileName = basename(record.textureFile).replace(/\.png$/, `.${extension}`);
  const outputPath = join(outDir, fileName);
  writeFileSync(outputPath, encoded);
  const decoded = await loadRgba(outputPath);
  const measured = measureDecal(decoded);
  const bytes = encoded.length;
  records[key] = {
    ...record,
    textureFile: `decals/${fileName}`,
    width: decoded.width,
    height: decoded.height,
    bytes,
    sha256: { decodedRgba: sha256Rgba(decoded) },
    measured,
  };
  totalBytes += bytes;
  index += 1;
  if (index % 20 === 0 || index === count) {
    console.log(`[decals] encoded ${index}/${count} (${totalBytes} B)`);
  }
}

const manifest = {
  ...source,
  generatedBy: 'tools/render/scripts/encode-decals.mjs',
  raster: {
    ...source.raster,
    format: `${format.toUpperCase()} (lossy q${quality}, alpha)`,
  },
  encodedBy: {
    script: 'tools/render/scripts/encode-decals.mjs',
    format,
    quality,
  },
  totals: {
    ...source.totals,
    bytes: totalBytes,
  },
  budget: { bytes: spec.output.bytesBudget },
  decals: records,
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `[decals] wrote ${count} ${format} decals (${totalBytes} B, budget ${spec.output.bytesBudget} B)`,
);
console.log(`[decals] ${outDir}`);
console.log(`[decals] ${manifestPath}`);
