/**
 * Review sheets for the carved face decals.
 *
 *   cd frontend && npm run atlas:review:carved
 *   cd frontend && npm run atlas:review:carved -- --committed
 *
 * The default reads the gitignored spike manifest at
 * `tools/render/build/decals.json`; `--committed` reads the shipped
 * `frontend/public/table/decals.json`. It builds the real `TileAtlasBuilder`
 * twice (flat glyphs vs carved decals) on the review shells and writes:
 *
 *   carved-compare-4x.png       spike faces, flat vs carved, 4x per row
 *   carved-variants-1x.png      all faces on the hand centre, upright, sideways
 *   carved-numbers.json         stats, decal bytes, page/timing numbers
 *
 * AGENTS.md §6: these are evidence for the user, not for the agent to sign off.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { parseDecalsManifest } from '../src/table/decalManifest';
import type { DecalsManifest } from '../src/table/decalManifest';
import { parseFacesManifest } from '../src/table/faceManifest';
import { parseShellsManifest } from '../src/table/shellManifest';
import { TileAtlasBuilder } from '../src/table/TileAtlasBuilder';
import type { AtlasCanvas, AtlasImage, BakedTileSprite } from '../src/table/TileAtlasBuilder';
import { TILE_FACE_IDS, tileRenderKey } from '../src/table/tiles';
import type { FaceUpShellId } from '../src/table/tiles';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const tableDir = resolve(scriptDir, '../public/table');
const repoDir = resolve(scriptDir, '../..');
const committed = process.argv.includes('--committed');
const decalRoot = committed
  ? tableDir
  : resolve(repoDir, 'tools/render/build');
const decalManifestPath = committed
  ? join(tableDir, 'decals.json')
  : resolve(repoDir, 'tools/render/build/decals.json');
const outDir = resolve(repoDir, 'tools/render/build/review');

const shells = parseShellsManifest(JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')));
const faces = parseFacesManifest(JSON.parse(readFileSync(join(tableDir, 'faces.json'), 'utf8')));
const decals = parseDecalsManifest(JSON.parse(readFileSync(decalManifestPath, 'utf8')));

const REVIEW_SHELLS: FaceUpShellId[] = [
  'shell_hand_slot_06',
  'shell_flat_upright',
  'shell_flat_sideways',
];

async function loadNapi(url: string): Promise<AtlasImage> {
  return (await loadImage(readFileSync(url))) as unknown as AtlasImage;
}

function makeBuilder(decalSet: DecalsManifest | null) {
  return new TileAtlasBuilder({
    shells,
    faces,
    decals: decalSet ?? undefined,
    resolveUrl: (relativePath) => {
      if (relativePath.startsWith('decals/')) {
        return committed
          ? join(tableDir, relativePath)
          : join(decalRoot, relativePath);
      }
      return join(tableDir, relativePath);
    },
    loadImage: loadNapi,
    createCanvas: (width, height) => createCanvas(width, height) as unknown as AtlasCanvas,
    pixelRatio: 1,
  });
}

const flatAtlas = await makeBuilder(null).build(REVIEW_SHELLS);
const carvedAtlas = await makeBuilder(decals).build(REVIEW_SHELLS);
const handAtlas = await makeBuilder(decals).build([
  'shell_hand_slot_00',
  'shell_hand_slot_01',
  'shell_hand_slot_02',
  'shell_hand_slot_03',
  'shell_hand_slot_04',
  'shell_hand_slot_05',
  'shell_hand_slot_06',
  'shell_hand_slot_07',
  'shell_hand_slot_08',
  'shell_hand_slot_09',
  'shell_hand_slot_10',
  'shell_hand_slot_11',
  'shell_hand_slot_12',
  'shell_hand_slot_draw',
]);
mkdirSync(outDir, { recursive: true });

const FELT = '#1a5038';
const INK = '#f3ead7';
const MUTED = '#b9c9b6';
const FLAT_LABEL = '#9fb6a6';

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>;

function drawSprite(
  ctx: Ctx,
  page: AtlasCanvas,
  sprite: BakedTileSprite,
  x: number,
  y: number,
  width: number,
  height: number,
  smooth: boolean,
) {
  ctx.imageSmoothingEnabled = smooth;
  ctx.drawImage(
    page as never,
    sprite.uv.x,
    sprite.uv.y,
    sprite.uv.width,
    sprite.uv.height,
    x,
    y,
    width,
    height,
  );
}

function sheetFile(name: string, canvas: ReturnType<typeof createCanvas>) {
  const file = join(outDir, name);
  writeFileSync(file, canvas.toBuffer('image/png'));
  return { file, width: canvas.width, height: canvas.height, bytes: statSync(file).size };
}

function spriteFor(
  atlas: { sprites: ReadonlyMap<string, BakedTileSprite>; pages: readonly { shell: string; canvas: AtlasCanvas }[] },
  shell: FaceUpShellId,
  face: string,
) {
  const sprite = atlas.sprites.get(tileRenderKey(shell, face as never))!;
  const page = atlas.pages[sprite.pageIndex];
  return { sprite, page };
}

/** Spike faces, flat vs carved, 4x. */
function compareSheet() {
  const spikeFaces = TILE_FACE_IDS.filter((face) =>
    Object.values(decals.decals).some((record) => record.face === face),
  );
  const zoom = 4;
  const margin = 18;
  const labelW = 130;
  const cellW = Math.max(
    ...REVIEW_SHELLS.map((shell) => shells.shells[shell].texWidth),
  ) * zoom + 12;
  const cellH = Math.max(
    ...REVIEW_SHELLS.map((shell) => shells.shells[shell].texHeight),
  ) * zoom + 24;
  const rowH = cellH + 12;
  const width = margin * 2 + labelW + cellW * 2;
  const height = margin * 2 + 34 + spikeFaces.length * REVIEW_SHELLS.length * rowH;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = FELT;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = INK;
  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(
    'carved decals: flat glyph (left) vs carved (right), 4x nearest-neighbour',
    margin,
    24,
  );
  let y = 34 + margin;
  for (const face of spikeFaces) {
    for (const shell of REVIEW_SHELLS) {
      ctx.fillStyle = INK;
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText(`${face} · ${shell}`, margin, y + 14);
      const flat = spriteFor(flatAtlas, shell, face);
      const carved = spriteFor(carvedAtlas, shell, face);
      const draw = (
        entry: { sprite: BakedTileSprite; page: { canvas: AtlasCanvas } },
        x: number,
        label: string,
        labelColor: string,
      ) => {
        drawSprite(
          ctx,
          entry.page.canvas,
          entry.sprite,
          x,
          y + 18,
          entry.sprite.uv.width * zoom,
          entry.sprite.uv.height * zoom,
          false,
        );
        ctx.fillStyle = labelColor;
        ctx.font = '10px sans-serif';
        ctx.fillText(label, x + 4, y + 12);
      };
      draw(flat, margin + labelW, 'flat glyph', FLAT_LABEL);
      draw(carved, margin + labelW + cellW, 'carved', MUTED);
      y += rowH;
    }
  }
  return sheetFile('carved-compare-4x.png', canvas);
}

/** All faces on the three review shells at 1x discard size. */
function variantsSheet() {
  const columns = 10;
  const margin = 16;
  const sectionTitle = 34;
  const allSprites = REVIEW_SHELLS.flatMap((shell) =>
    TILE_FACE_IDS.map((face) => spriteFor(carvedAtlas, shell, face).sprite),
  );
  const cellW = Math.max(...allSprites.map((sprite) => sprite.uv.width)) + 8;
  const cellH = Math.max(...allSprites.map((sprite) => sprite.uv.height)) + 22;
  const rowsPerShell = Math.ceil(TILE_FACE_IDS.length / columns);
  const sectionH = sectionTitle + rowsPerShell * cellH + 14;
  const width = margin * 2 + columns * cellW;
  const height = margin * 2 + REVIEW_SHELLS.length * sectionH;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = FELT;
  ctx.fillRect(0, 0, width, height);
  REVIEW_SHELLS.forEach((shell, shellIndex) => {
    const top = margin + shellIndex * sectionH;
    ctx.fillStyle = INK;
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${shell} — every face at @1x discard size`, margin, top + 18);
    TILE_FACE_IDS.forEach((face, index) => {
      const entry = spriteFor(carvedAtlas, shell, face);
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = margin + column * cellW;
      const y = top + sectionTitle + row * cellH;
      drawSprite(
        ctx,
        entry.page.canvas,
        entry.sprite,
        x + 4,
        y + 2,
        entry.sprite.uv.width,
        entry.sprite.uv.height,
        true,
      );
      const carved = Boolean(entry.sprite.decalFile);
      ctx.fillStyle = carved ? MUTED : FLAT_LABEL;
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${face}${carved ? ' · carved' : ' · flat'}`, x + cellW / 2, y + entry.sprite.uv.height + 12);
    });
  });
  return sheetFile('carved-variants-1x.png', canvas);
}

/** The 14 hand slots with carved decals, at 1x, to check the per-slot mapping. */
function handFanSheet() {
  const slots = [
    'shell_hand_slot_00',
    'shell_hand_slot_01',
    'shell_hand_slot_02',
    'shell_hand_slot_03',
    'shell_hand_slot_04',
    'shell_hand_slot_05',
    'shell_hand_slot_06',
    'shell_hand_slot_07',
    'shell_hand_slot_08',
    'shell_hand_slot_09',
    'shell_hand_slot_10',
    'shell_hand_slot_11',
    'shell_hand_slot_12',
    'shell_hand_slot_draw',
  ] as const;
  const facesCycle = ['1m', '5p', '7z', '5mr'] as const;
  const columns = 7;
  const margin = 16;
  const titleH = 34;
  const allSprites = slots.flatMap((shell) =>
    TILE_FACE_IDS.map((face) => spriteFor(handAtlas, shell, face).sprite),
  );
  const cellW = Math.max(...allSprites.map((sprite) => sprite.uv.width)) + 10;
  const cellH = Math.max(...allSprites.map((sprite) => sprite.uv.height)) + 24;
  const rows = Math.ceil(slots.length / columns);
  const width = margin * 2 + columns * cellW;
  const height = titleH + margin + rows * cellH;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = FELT;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = INK;
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('carved decals on the 14 hand slots at @1x (shared light-0 decal, per-slot faceQuad)', margin, 22);
  slots.forEach((shell, index) => {
    const face = facesCycle[index % facesCycle.length];
    const entry = spriteFor(handAtlas, shell, face);
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = margin + column * cellW;
    const y = titleH + margin + row * cellH;
    drawSprite(
      ctx,
      entry.page.canvas,
      entry.sprite,
      x + 5,
      y + 2,
      entry.sprite.uv.width,
      entry.sprite.uv.height,
      true,
    );
    ctx.fillStyle = MUTED;
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      `${shell.replace('shell_hand_slot_', 'slot ')} · ${face}`,
      x + cellW / 2,
      y + entry.sprite.uv.height + 13,
    );
  });
  return sheetFile('carved-hand-fan-1x.png', canvas);
}

const compare = compareSheet();
const variants = variantsSheet();
const handFan = handFanSheet();
const decalBytes = Object.values(decals.decals).reduce((total, record) => total + record.bytes, 0);

const numbers = {
  generatedBy: 'frontend/scripts/review-carved.ts',
  committed,
  decalManifest: decalManifestPath.replace(repoDir, '<repo>'),
  decalSpikeFaces: [...new Set(Object.values(decals.decals).map((record) => record.face))],
  decalRecords: Object.keys(decals.decals).length,
  decalBytes,
  flatTotals: flatAtlas.stats,
  carvedTotals: carvedAtlas.stats,
  handTotals: handAtlas.stats,
  sheets: [compare, variants, handFan].map((sheet) => ({
    file: sheet.file.replace(repoDir, '<repo>'),
    width: sheet.width,
    height: sheet.height,
    bytes: sheet.bytes,
  })),
};
const numbersFile = join(outDir, 'carved-numbers.json');
writeFileSync(numbersFile, `${JSON.stringify(numbers, null, 2)}\n`);

console.log(`[carved] decals ${Object.keys(decals.decals).length} records, ${decalBytes} B`);
console.log(
  `[carved] atlas flat ${flatAtlas.stats.glyphSprites} glyph keys; carved ` +
    `${carvedAtlas.stats.decalSprites} decal keys, ${carvedAtlas.stats.flatGlyphSprites} flat fallbacks`,
);
for (const sheet of numbers.sheets) {
  console.log(`[carved] ${sheet.file} (${sheet.width}x${sheet.height}, ${sheet.bytes} B)`);
}
console.log(`[carved] ${numbersFile}`);
