#!/usr/bin/env node
/** Validate the baked lying catches and publish frontend/public/table/lying-catches.json. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng } from './png.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tableDir = resolve(renderDir, '../../frontend/public/table');
const fragment = JSON.parse(readFileSync(resolve(renderDir, 'build/lying-catches/lying-catches.json'), 'utf8'));
const shells = JSON.parse(readFileSync(resolve(tableDir, 'shells.json'), 'utf8')).shells;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const records = fragment.catches;
const keys = Object.keys(records);
if (keys.length === 0) throw new Error('no lying catches');
let total1x = 0;
let total2x = 0;
for (const [signature, record] of Object.entries(records)) {
  if (signature !== record.signature) throw new Error(`key/signature mismatch: ${signature}`);
  const target = shells[record.target];
  if (!target) throw new Error(`unknown target ${record.target}`);
  if (record.texWidth !== target.texWidth || record.texHeight !== target.texHeight) {
    throw new Error(`${record.id}: not the target texture size`);
  }
  for (const [file, bytes, hash, w, h] of [
    [record.textureFile, record.bytes1x, record.sha256.decodedRgba1x, record.texWidth, record.texHeight],
    [record.textureFile2x, record.bytes2x, record.sha256.decodedRgba2x, record.texWidth * 2, record.texHeight * 2],
  ]) {
    const path = resolve(tableDir, file);
    if (!existsSync(path)) throw new Error(`missing ${path}`);
    const image = readPng(path);
    if (image.width !== w || image.height !== h) throw new Error(`${file}: size`);
    if (image.bytes !== bytes) throw new Error(`${file}: bytes`);
    if (sha256(image.data) !== hash) throw new Error(`${file}: hash`);
    if (file === record.textureFile) total1x += bytes;
    else total2x += bytes;
  }
}
// Remove textures from a previous, larger signature set.
for (const [directory, catchRecords] of [
  [resolve(tableDir, 'overlays/lying'), records],
  [resolve(tableDir, 'overlays/lying/2x'), records],
]) {
  const expected = new Set(
    Object.values(catchRecords).map((record) =>
      (directory.endsWith('/2x') ? record.textureFile2x : record.textureFile).split('/').pop(),
    ),
  );
  for (const file of readdirSync(directory)) {
    if (file.endsWith('.png') && !expected.has(file)) unlinkSync(resolve(directory, file));
  }
}

const manifest = {
  version: 1,
  generatedBy: 'tools/render/bake_lying_catches.py',
  publishedBy: 'tools/render/scripts/commit-lying-catches.mjs',
  model: 'target-space-3d-catch',
  combination: 'physical+ao',
  coordinateSpace:
    'The texture is the target shell texture in @1x px: draw it at the target drawX/drawY, ' +
    'after the target body and before its casters, clipped to the full target advance box.',
  catches: Object.fromEntries(Object.entries(records).sort(([a], [b]) => a.localeCompare(b))),
};
writeFileSync(resolve(tableDir, 'lying-catches.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`lying catches: ${keys.length}, ${total1x} B @1x + ${total2x} B @2x = ${total1x + total2x} B`);
console.log(`wrote ${resolve(tableDir, 'lying-catches.json')}`);
