/**
 * Review sheets for the startup tile atlas.
 *
 *   cd frontend && npx vite-node scripts/review-atlas.ts
 *
 * Builds the real `TileAtlasBuilder` at 2x with a Node Canvas 2D backend and
 * writes, under `tools/render/build/review/` (gitignored):
 *
 *   atlas-<shell>-2x.png   every face on one shell, 10 per row, at @2x
 *   atlas-all-faces-1x.png every face on all six shells, one section per shell
 *   atlas-numbers.json     pages, pixels, RGBA bytes, glyph bytes, build time
 *
 * The atlas code under review is the same code the browser runs; only the
 * canvas backend and image loader are swapped. AGENTS.md §6: these PNGs are
 * evidence for the user to inspect, not for the agent to sign off.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { parseFacesManifest } from '../src/table/faceManifest';
import { parseShellsManifest } from '../src/table/shellManifest';
import { TileAtlasBuilder } from '../src/table/TileAtlasBuilder';
import type { AtlasCanvas, AtlasImage } from '../src/table/TileAtlasBuilder';
import { SHELL_IDS, TILE_FACE_IDS, tileRenderKey } from '../src/table/tiles';
import type { ShellId } from '../src/table/tiles';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const tableDir = resolve(scriptDir, '../public/table');
const outDir = resolve(scriptDir, '../../tools/render/build/review');

const shells = parseShellsManifest(JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')));
const faces = parseFacesManifest(JSON.parse(readFileSync(join(tableDir, 'faces.json'), 'utf8')));

const builder = new TileAtlasBuilder({
  shells,
  faces,
  resolveUrl: (relativePath) => join(tableDir, relativePath),
  loadImage: async (url) => (await loadImage(readFileSync(url))) as unknown as AtlasImage,
  createCanvas: (width, height) => createCanvas(width, height) as unknown as AtlasCanvas,
  pixelRatio: 2,
});

const atlas = await builder.buildAll();
mkdirSync(outDir, { recursive: true });

const FELT = '#1a5038';
const INK = '#f3ead7';
const MUTED = '#b9c9b6';

function drawSprite(
  context: ReturnType<typeof createCanvas>['getContext'],
  page: AtlasCanvas,
  uv: { x: number; y: number; width: number; height: number },
  x: number,
  y: number,
  width: number,
  height: number,
) {
  context.drawImage(
    page as never,
    uv.x,
    uv.y,
    uv.width,
    uv.height,
    x,
    y,
    width,
    height,
  );
}

/** One shell, all faces, @2x. */
function shellSheet(shell: ShellId): { file: string; width: number; height: number } {
  const page = atlas.pages.find((entry) => entry.shell === shell)!;
  const sprites = TILE_FACE_IDS.map((face) => atlas.sprites.get(tileRenderKey(shell, face))!);
  const columns = 10;
  const rows = Math.ceil(sprites.length / columns);
  const cellW = Math.max(...sprites.map((sprite) => sprite.uv.width)) + 8;
  const cellH = Math.max(...sprites.map((sprite) => sprite.uv.height)) + 22;
  const margin = 18;
  const titleH = 34;
  const width = margin * 2 + columns * cellW;
  const height = titleH + margin + rows * cellH;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = FELT;
  context.fillRect(0, 0, width, height);
  context.fillStyle = INK;
  context.font = 'bold 16px sans-serif';
  context.fillText(
    `${shell} — 38 faces at @2x (${page.width}x${page.height} px page, ${page.bytes} B)`,
    margin,
    24,
  );
  context.font = '11px sans-serif';
  sprites.forEach((sprite, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = margin + column * cellW;
    const y = titleH + margin + row * cellH;
    drawSprite(context, page.canvas, sprite.uv, x + 4, y + 2, sprite.uv.width, sprite.uv.height);
    context.fillStyle = sprite.hasGlyph ? MUTED : '#7f8f7d';
    context.textAlign = 'center';
    context.fillText(
      `${sprite.face}${sprite.hasGlyph ? '' : ' · bare'}`,
      x + cellW / 2,
      y + sprite.uv.height + 14,
    );
  });
  const file = join(outDir, `atlas-${shell}-2x.png`);
  writeFileSync(file, canvas.toBuffer('image/png'));
  return { file, width, height };
}

/** All six shells, all faces, @1x: the "every face on every shell" sheet. */
function allFacesSheet(): { file: string; width: number; height: number } {
  const columns = 10;
  const margin = 16;
  const sectionTitle = 28;
  const cellW = 58;
  const cellH = 78;
  const rowsPerShell = Math.ceil(TILE_FACE_IDS.length / columns);
  const sectionH = sectionTitle + rowsPerShell * cellH + 12;
  const width = margin * 2 + columns * cellW;
  const height = margin * 2 + SHELL_IDS.length * sectionH;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = FELT;
  context.fillRect(0, 0, width, height);

  SHELL_IDS.forEach((shell, shellIndex) => {
    const page = atlas.pages.find((entry) => entry.shell === shell)!;
    const top = margin + shellIndex * sectionH;
    context.fillStyle = INK;
    context.font = 'bold 13px sans-serif';
    context.textAlign = 'left';
    context.fillText(`${shell} (@2x page ${page.width}x${page.height})`, margin, top + 18);
    TILE_FACE_IDS.forEach((face, index) => {
      const sprite = atlas.sprites.get(tileRenderKey(shell, face))!;
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = margin + column * cellW;
      const y = top + sectionTitle + row * cellH;
      const drawW = sprite.uv.width / 2;
      const drawH = sprite.uv.height / 2;
      drawSprite(context, page.canvas, sprite.uv, x + 4, y + 2, drawW, drawH);
      context.fillStyle = sprite.hasGlyph ? MUTED : '#7f8f7d';
      context.font = '9px sans-serif';
      context.textAlign = 'center';
      context.fillText(sprite.face, x + cellW / 2, y + drawH + 12);
    });
  });

  const file = join(outDir, 'atlas-all-faces-1x.png');
  writeFileSync(file, canvas.toBuffer('image/png'));
  return { file, width, height };
}

const sheets = SHELL_IDS.map(shellSheet);
const allFaces = allFacesSheet();

const glyphBytes = TILE_FACE_IDS.reduce((total, face) => {
  const stats = faces.faces[face];
  if (!stats.textureFile) return total;
  return total + statSync(join(tableDir, stats.textureFile)).size;
}, 0);

const digest = createHash('sha256');
for (const page of atlas.pages) {
  const context = page.canvas.getContext('2d');
  if (!context) throw new Error(`${page.shell} page has no 2D context`);
  digest.update(Buffer.from(context.getImageData(0, 0, page.width, page.height).data));
}

const numbers = {
  generatedBy: 'frontend/scripts/review-atlas.ts',
  pixelRatio: atlas.stats.pixelRatio,
  decodedRgbaSha256: digest.digest('hex'),
  totals: atlas.stats,
  glyphAssets: { files: 37, bytes: glyphBytes, faces: TILE_FACE_IDS.length },
  pages: atlas.pages.map((page) => ({
    shell: page.shell,
    width: page.width,
    height: page.height,
    slots: page.slots,
    pixels: page.width * page.height,
    rgbaBytes: page.bytes,
    keys: TILE_FACE_IDS.length,
    glyphKeys: TILE_FACE_IDS.filter(
      (face) => atlas.sprites.get(tileRenderKey(page.shell, face))!.hasGlyph,
    ).length,
  })),
  sheets: [...sheets, allFaces].map((sheet) => ({
    file: sheet.file.replace(resolve(scriptDir, '../..'), '<repo>'),
    width: sheet.width,
    height: sheet.height,
    bytes: statSync(sheet.file).size,
  })),
};
const numbersFile = join(outDir, 'atlas-numbers.json');
writeFileSync(numbersFile, `${JSON.stringify(numbers, null, 2)}\n`);

console.log(`[atlas] decoded RGBA sha256 ${numbers.decodedRgbaSha256}`);
console.log(
  `[atlas] ${atlas.stats.pages} pages, ${atlas.stats.sprites} keys ` +
    `(${atlas.stats.glyphSprites} glyph, ${atlas.stats.bareSprites} bare), ` +
    `${atlas.stats.atlasPixels} px, ${atlas.stats.rgbaBytes} B RGBA, ` +
    `${Math.round(atlas.stats.buildMs)} ms`,
);
for (const page of numbers.pages) {
  console.log(
    `[atlas] ${page.shell.padEnd(24)} ${String(page.width).padStart(4)}x${String(page.height).padEnd(4)} ` +
      `${String(page.pixels).padStart(8)} px ${String(page.rgbaBytes).padStart(9)} B ` +
      `${page.slots} slots, ${page.glyphKeys} glyph keys`,
  );
}
console.log(`[atlas] glyph assets ${glyphBytes} B across 37 PNGs`);
for (const sheet of numbers.sheets) {
  console.log(`[atlas] ${sheet.file} (${sheet.width}x${sheet.height}, ${sheet.bytes} B)`);
}
console.log(`[atlas] ${numbersFile}`);
