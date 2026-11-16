#!/usr/bin/env node
/**
 * Validate the baked hand catches and publish `frontend/public/table/catches.json`.
 *
 *   node tools/render/scripts/commit-catches.mjs
 *
 * Reads the fragment from `tools/render/build/hand-catches/hand-catches.json`
 * (written by `bake_hand_catches.py`), decodes every 1x/2x overlay, checks the
 * target texture size, byte count and decoded-RGBA hash, and writes the
 * committed manifest. Build-only experiment outputs are not touched.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng } from './png.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tableDir = resolve(renderDir, '../../frontend/public/table');
const fragmentPath = resolve(renderDir, 'build/hand-catches/hand-catches.json');
const manifestPath = resolve(tableDir, 'catches.json');

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const fragment = JSON.parse(readFileSync(fragmentPath, 'utf8'));
const shells = JSON.parse(readFileSync(resolve(tableDir, 'shells.json'), 'utf8')).shells;

const expectedTargets = [
  'shell_hand_slot_00',
  'shell_hand_slot_01',
  'shell_hand_slot_02',
  'shell_hand_slot_03',
  'shell_hand_slot_04',
  'shell_hand_slot_05',
  'shell_hand_slot_07',
  'shell_hand_slot_08',
  'shell_hand_slot_09',
  'shell_hand_slot_10',
  'shell_hand_slot_11',
  'shell_hand_slot_12',
];
const pairs = Object.values(fragment.catches);
if (pairs.length !== expectedTargets.length) {
  throw new Error(`expected ${expectedTargets.length} catches, got ${pairs.length}`);
}
for (const target of expectedTargets) {
  if (!pairs.some((pair) => pair.target === target)) {
    throw new Error(`missing catch for target ${target}`);
  }
}

let total1x = 0;
let total2x = 0;
for (const pair of pairs) {
  const targetShell = shells[pair.target];
  const casterShell = shells[pair.caster];
  if (!targetShell || !casterShell) throw new Error(`unknown shell in ${pair.target}/${pair.caster}`);
  if (pair.texWidth !== targetShell.texWidth || pair.texHeight !== targetShell.texHeight) {
    throw new Error(
      `${pair.target}: catch ${pair.texWidth}x${pair.texHeight} is not the target texture ` +
        `${targetShell.texWidth}x${targetShell.texHeight}`,
    );
  }
  for (const [file, bytes, hash, width, height] of [
    [pair.textureFile, pair.bytes1x, pair.sha256.decodedRgba1x, pair.texWidth, pair.texHeight],
    [pair.textureFile2x, pair.bytes2x, pair.sha256.decodedRgba2x, pair.texWidth * 2, pair.texHeight * 2],
  ]) {
    const path = resolve(tableDir, file);
    if (!existsSync(path)) throw new Error(`missing ${path}`);
    const image = readPng(path);
    if (image.width !== width || image.height !== height) {
      throw new Error(`${file}: ${image.width}x${image.height}, expected ${width}x${height}`);
    }
    if (image.bytes !== bytes) throw new Error(`${file}: ${image.bytes} B, expected ${bytes}`);
    if (sha256(image.data) !== hash) throw new Error(`${file}: decoded-RGBA hash differs`);
    if (file === pair.textureFile) total1x += image.bytes;
    else total2x += image.bytes;
  }
}

const manifest = {
  version: 1,
  generatedBy: 'tools/render/bake_hand_catches.py',
  publishedBy: 'tools/render/scripts/commit-catches.mjs',
  model: 'target-space-3d-catch',
  combination: 'physical+ao',
  coordinateSpace:
    'The texture is the target shell texture in @1x px: draw it at the target drawX/drawY, ' +
    'after the target body and before the caster body. Alpha is zero outside the target body.',
  catches: Object.fromEntries(
    Object.entries(fragment.catches)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, pair]) => [key, pair]),
  ),
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `catches: ${pairs.length} targets, ${total1x} B @1x + ${total2x} B @2x = ${total1x + total2x} B`,
);
for (const pair of pairs) {
  console.log(
    `  ${pair.target.padEnd(24)} ← ${pair.caster.padEnd(24)} ` +
      `${pair.texWidth}x${pair.texHeight} peak ${pair.peakAlpha} mean ${pair.meanAlpha}`,
  );
}
console.log(`wrote ${manifestPath}`);
