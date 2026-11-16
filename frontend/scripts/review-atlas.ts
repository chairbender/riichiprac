/**
 * Review sheets for the startup tile atlas.
 *
 *   cd frontend && npm run atlas:review
 *
 * Builds the real `TileAtlasBuilder` with a Node Canvas 2D backend and writes,
 * under `tools/render/build/review/` (gitignored):
 *
 *   atlas-variants-1x.png    the three Phase 2 face variants, every face, at
 *                            discard size (hand slot 06, flat upright, sideways)
 *   atlas-all-faces-1x.png   every face on all 16 face-up shells, one section
 *                            per shell at @1x
 *   atlas-<shell>-1x.png     one sheet per shell at @1x
 *   atlas-hand-06-2x.png     the centre hand slot at @2x (the glyph crispness
 *                            check; the 2x atlas is opt-in at runtime)
 *   atlas-numbers.json       pages, pixels, RGBA bytes, glyph bytes, build time
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
import type { AtlasCanvas, AtlasImage, BakedTileSprite } from '../src/table/TileAtlasBuilder';
import { FACE_UP_SHELL_IDS, FACE_VARIANT_BY_SHELL, TILE_FACE_IDS, tileRenderKey } from '../src/table/tiles';
import type { FaceUpShellId } from '../src/table/tiles';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const tableDir = resolve(scriptDir, '../public/table');
const outDir = resolve(scriptDir, '../../tools/render/build/review');

const shells = parseShellsManifest(JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')));
const faces = parseFacesManifest(JSON.parse(readFileSync(join(tableDir, 'faces.json'), 'utf8')));

const makeBuilder = (pixelRatio: 1 | 2) =>
  new TileAtlasBuilder({
    shells,
    faces,
    resolveUrl: (relativePath) => join(tableDir, relativePath),
    loadImage: async (url) => (await loadImage(readFileSync(url))) as unknown as AtlasImage,
    createCanvas: (width, height) => createCanvas(width, height) as unknown as AtlasCanvas,
    pixelRatio,
  });

const atlas = await makeBuilder(1).buildAll();
mkdirSync(outDir, { recursive: true });

const FELT = '#1a5038';
const INK = '#f3ead7';
const MUTED = '#b9c9b6';

type SheetContext = ReturnType<ReturnType<typeof createCanvas>['getContext']>;

function drawSprite(
  context: SheetContext,
  page: AtlasCanvas,
  sprite: BakedTileSprite,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  context.drawImage(page as never, sprite.uv.x, sprite.uv.y, sprite.uv.width, sprite.uv.height, x, y, width, height);
}

interface Sheet {
  file: string;
  width: number;
  height: number;
}

function facesFor(shell: FaceUpShellId): BakedTileSprite[] {
  return TILE_FACE_IDS.map((face) => atlas.sprites.get(tileRenderKey(shell, face))!);
}

/** One shell, every face, at the page's native pixel ratio. */
function shellSheet(shell: FaceUpShellId, pixelRatio: 1 | 2): Sheet {
  const source = pixelRatio === 1 ? atlas : twoXAtlas;
  const page = source.pages.find((entry) => entry.shell === shell)!;
  const sprites = TILE_FACE_IDS.map((face) => source.sprites.get(tileRenderKey(shell, face))!);
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
    `${shell} — variant ${FACE_VARIANT_BY_SHELL[shell]} — 38 faces at @${pixelRatio}x ` +
      `(${page.width}x${page.height} px page, ${page.bytes} B)`,
    margin,
    24,
  );
  context.font = '11px sans-serif';
  sprites.forEach((sprite, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = margin + column * cellW;
    const y = titleH + margin + row * cellH;
    drawSprite(context, page.canvas, sprite, x + 4, y + 2, sprite.uv.width, sprite.uv.height);
    context.fillStyle = sprite.hasGlyph ? MUTED : '#7f8f7d';
    context.textAlign = 'center';
    context.fillText(
      `${sprite.face}${sprite.hasGlyph ? '' : ' · bare'}`,
      x + cellW / 2,
      y + sprite.uv.height + 14,
    );
  });
  context.textAlign = 'left';
  const file = join(outDir, `atlas-${shell}-${pixelRatio}x.png`);
  writeFileSync(file, canvas.toBuffer('image/png'));
  return { file, width, height };
}

// The 2x page for the centre hand slot is the crispness review, not the
// runtime default (an all-@2x atlas is ~93 MiB RGBA).
const twoXAtlas = await makeBuilder(2).build(['shell_hand_slot_06']);

/** All 16 shells, every face, @1x: one section per shell. */
function allFacesSheet(): Sheet {
  const columns = 10;
  const margin = 16;
  const sectionTitle = 28;
  const allSprites = FACE_UP_SHELL_IDS.flatMap((shell) => facesFor(shell));
  const cellW = Math.max(...allSprites.map((sprite) => sprite.uv.width)) + 8;
  const cellH = Math.max(...allSprites.map((sprite) => sprite.uv.height)) + 22;
  const rowsPerShell = Math.ceil(TILE_FACE_IDS.length / columns);
  const sectionH = sectionTitle + rowsPerShell * cellH + 12;
  const width = margin * 2 + columns * cellW;
  const height = margin * 2 + FACE_UP_SHELL_IDS.length * sectionH;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = FELT;
  context.fillRect(0, 0, width, height);

  FACE_UP_SHELL_IDS.forEach((shell, shellIndex) => {
    const page = atlas.pages.find((entry) => entry.shell === shell)!;
    const top = margin + shellIndex * sectionH;
    context.fillStyle = INK;
    context.font = 'bold 13px sans-serif';
    context.textAlign = 'left';
    context.fillText(`${shell} (${FACE_VARIANT_BY_SHELL[shell]}) @1x`, margin, top + 18);
    TILE_FACE_IDS.forEach((face, index) => {
      const sprite = atlas.sprites.get(tileRenderKey(shell, face))!;
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = margin + column * cellW;
      const y = top + sectionTitle + row * cellH;
      drawSprite(context, page.canvas, sprite, x + 4, y + 2, sprite.uv.width, sprite.uv.height);
      context.fillStyle = sprite.hasGlyph ? MUTED : '#7f8f7d';
      context.font = '9px sans-serif';
      context.textAlign = 'center';
      context.fillText(sprite.face, x + cellW / 2, y + sprite.uv.height + 12);
    });
  });

  const file = join(outDir, 'atlas-all-faces-1x.png');
  writeFileSync(file, canvas.toBuffer('image/png'));
  return { file, width, height };
}

/** The three face variants side by side at discard size: the visual question. */
function variantsSheet(): Sheet {
  const variants: FaceUpShellId[] = [
    'shell_hand_slot_06',
    'shell_flat_upright',
    'shell_flat_sideways',
  ];
  const columns = 10;
  const margin = 16;
  const sectionTitle = 34;
  const variantSprites = variants.flatMap((shell) => facesFor(shell));
  const cellW = Math.max(...variantSprites.map((sprite) => sprite.uv.width)) + 8;
  const cellH = Math.max(...variantSprites.map((sprite) => sprite.uv.height)) + 22;
  const rowsPerShell = Math.ceil(TILE_FACE_IDS.length / columns);
  const sectionH = sectionTitle + rowsPerShell * cellH + 14;
  const width = margin * 2 + columns * cellW;
  const height = margin * 2 + variants.length * sectionH;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = FELT;
  context.fillRect(0, 0, width, height);

  variants.forEach((shell, variantIndex) => {
    const page = atlas.pages.find((entry) => entry.shell === shell)!;
    const top = margin + variantIndex * sectionH;
    context.fillStyle = INK;
    context.font = 'bold 13px sans-serif';
    context.textAlign = 'left';
    context.fillText(
      `${FACE_VARIANT_BY_SHELL[shell]} — ${shell} — every face at @1x discard size`,
      margin,
      top + 18,
    );
    TILE_FACE_IDS.forEach((face, index) => {
      const sprite = atlas.sprites.get(tileRenderKey(shell, face))!;
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = margin + column * cellW;
      const y = top + sectionTitle + row * cellH;
      // Draw at native 1x size: this is the actual discard read.
      drawSprite(context, page.canvas, sprite, x + 4, y + 2, sprite.uv.width, sprite.uv.height);
      context.fillStyle = sprite.hasGlyph ? MUTED : '#7f8f7d';
      context.font = '9px sans-serif';
      context.textAlign = 'center';
      context.fillText(sprite.face, x + cellW / 2, y + sprite.uv.height + 12);
    });
  });

  const file = join(outDir, 'atlas-variants-1x.png');
  writeFileSync(file, canvas.toBuffer('image/png'));
  return { file, width, height };
}

const sheets = FACE_UP_SHELL_IDS.map((shell) => shellSheet(shell, 1));
const twoXSheet = shellSheet('shell_hand_slot_06', 2);
const allFaces = allFacesSheet();
const variants = variantsSheet();

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

function tableBytes(): number {
  const raw = JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')).shells as Record<
    string,
    Record<string, unknown>
  >;
  let total =
    statSync(join(tableDir, 'shells.json')).size +
    statSync(join(tableDir, 'faces.json')).size +
    statSync(join(tableDir, 'felt.png')).size;
  for (const record of Object.values(raw)) {
    for (const path of [
      record.textureFile,
      record.textureFile2x,
      record.shadowTextureFile,
      record.shadowTextureFile2x,
    ]) {
      total += statSync(join(tableDir, String(path))).size;
    }
  }
  total += glyphBytes;
  return total;
}

const numbers = {
  generatedBy: 'frontend/scripts/review-atlas.ts',
  pixelRatio: atlas.stats.pixelRatio,
  decodedRgbaSha256: digest.digest('hex'),
  totals: atlas.stats,
  twoXHandPage: {
    shell: 'shell_hand_slot_06',
    stats: twoXAtlas.stats,
  },
  glyphAssets: { files: TILE_FACE_IDS.length - 1, bytes: glyphBytes, faces: TILE_FACE_IDS.length },
  committedTableBytes: tableBytes(),
  committedTableBudgetBytes: 8 * 1024 * 1024,
  perSlotDoraNotBuilt: {
    shells: 34,
    spritesAt1x: 34 * 37,
    note: 'The 34 per-slot dora shells are the next face-variant family (§10.5); Phase 2 builds the 16 face-up shells in the task deliverable.',
  },
  pages: atlas.pages.map((page) => ({
    shell: page.shell,
    variant: FACE_VARIANT_BY_SHELL[page.shell],
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
  sheets: [...sheets, twoXSheet, allFaces, variants].map((sheet) => ({
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
    `${atlas.stats.atlasPixels} px, ${atlas.stats.rgbaBytes} B RGBA ` +
    `(${(atlas.stats.rgbaBytes / 1024 / 1024).toFixed(2)} MiB), ` +
    `${Math.round(atlas.stats.buildMs)} ms`,
);
for (const page of numbers.pages) {
  console.log(
    `[atlas] ${page.shell.padEnd(24)} ${page.variant.padEnd(20)} ` +
      `${String(page.width).padStart(4)}x${String(page.height).padEnd(4)} ` +
      `${String(page.pixels).padStart(8)} px ${String(page.rgbaBytes).padStart(9)} B ` +
      `${page.slots} slots, ${page.glyphKeys} glyph keys`,
  );
}
console.log(
  `[atlas] glyph assets ${glyphBytes} B across ${TILE_FACE_IDS.length - 1} PNGs; ` +
    `committed table ${tableBytes()} B of ${numbers.committedTableBudgetBytes} B`,
);
for (const sheet of numbers.sheets) {
  console.log(`[atlas] ${sheet.file} (${sheet.width}x${sheet.height}, ${sheet.bytes} B)`);
}
console.log(`[atlas] ${numbersFile}`);
