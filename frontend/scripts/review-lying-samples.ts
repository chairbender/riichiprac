/**
 * Build-only review sheet for the two lying-family catch samples.
 *
 *   cd frontend && npm run lying:review
 *
 * Composes the real pond / front-wall art with each sample's target-space
 * overlays at the target draw position, 3x on the target + casters. Writes
 * tools/render/build/lying-samples/lying-samples-sheet.png and numbers.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { parseShellsManifest } from '../src/table/shellManifest';
import type { ShellsManifest } from '../src/table/shellManifest';
import { TileAtlas } from '../src/table/TileAtlas';
import type { AtlasCanvas, AtlasImage } from '../src/table/TileAtlasBuilder';
import { isFaceUpShellId, tileRenderKey } from '../src/table/tiles';
import type { FaceUpShellId, TileFaceId } from '../src/table/tiles';
import { layoutPond, layoutWall } from '../src/table/zoneLayout';
import type { LayoutZone, PondDiscard } from '../src/table/zoneLayout';
import { deriveShadowShape, shadowAlpha } from '../../tools/render/scripts/shadow-group.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const tableDir = resolve(scriptDir, '../public/table');
const renderDir = resolve(scriptDir, '../../tools/render');
const sampleDir = join(renderDir, 'build/lying-samples');
const manifest: ShellsManifest = parseShellsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')),
);
const spec = JSON.parse(readFileSync(join(renderDir, 'shell-spec.json'), 'utf8'));
const feltSpec = JSON.parse(readFileSync(join(renderDir, 'felt-spec.json'), 'utf8'));
const FELT = `rgb(${feltSpec.baseColor[0]}, ${feltSpec.baseColor[1]}, ${feltSpec.baseColor[2]})`;
const INK = '#f3ead7';
const MUTED = '#b9c9b6';

const sampleDefs = JSON.parse(readFileSync(join(renderDir, 'build/lying-samples.json'), 'utf8')).samples;
const report = JSON.parse(readFileSync(join(sampleDir, 'lying-samples-report.json'), 'utf8'));
const reportById = new Map(report.samples.map((s: { id: string }) => [s.id, s]));

const FACES: TileFaceId[] = [
  '1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m',
  '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p',
  '1s', '2s', '3s', '4s', '5s', '6s',
];
const POND_DISCARDS: PondDiscard[] = FACES.map((face, index) => ({ face, riichi: index === 16 }));
const zones = new Map<string, LayoutZone>([
  ['pond-bottom', layoutPond(manifest, { discards: POND_DISCARDS, side: 'bottom' })],
  ['wall-front', layoutWall(manifest, { wall: 'front', doraIndex: 12 })],
]);

const WARM_SHELLS: FaceUpShellId[] = [
  'shell_flat_upright',
  'shell_flat_sideways',
  'shell_flat_upright_180',
  'shell_flat_sideways_270',
];
const atlas = await TileAtlas.load({
  baseUrl: tableDir,
  fetchJson: async (url) => JSON.parse(readFileSync(url, 'utf8')),
  loadImage: async (url) => (await loadImage(readFileSync(url))) as unknown as AtlasImage,
  createCanvas: (width, height) => createCanvas(width, height) as unknown as AtlasCanvas,
  pixelRatio: 1,
  decalsUrl: null,
  warmShells: WARM_SHELLS,
});
const imageCache = new Map<string, AtlasImage>();
const imageFor = async (path: string): Promise<AtlasImage> => {
  if (!imageCache.has(path)) imageCache.set(path, (await loadImage(readFileSync(path))) as unknown as AtlasImage);
  return imageCache.get(path)!;
};
type Context = ReturnType<ReturnType<typeof createCanvas>['getContext']>;

async function drawTile(context: Context, shellId: string, face: TileFaceId | null, x: number, y: number): Promise<void> {
  const shell = manifest.shells[shellId];
  if (face && isFaceUpShellId(shellId)) {
    const sprite = atlas.getSprite(tileRenderKey(shellId, face));
    const page = atlas.getPage(sprite);
    context.drawImage(page.canvas as never, sprite.uv.x, sprite.uv.y, sprite.uv.width, sprite.uv.height, x, y, sprite.texWidth, sprite.texHeight);
    return;
  }
  const image = await imageFor(join(tableDir, shell.textureFile));
  context.drawImage(image as never, x, y, shell.texWidth, shell.texHeight);
}

async function compose(zone: LayoutZone, targetDraw: [number, number], overlayFile: string | null) {
  const pad = zone.blurPad;
  const width = zone.width + pad * 2;
  const height = zone.height + pad * 2;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = FELT;
  context.fillRect(0, 0, width, height);
  const shapes = zone.shadows.map((shadow) => {
    const shape = deriveShadowShape(manifest.shells[shadow.shell], spec);
    if (!shape) throw new Error(`no shadow shape for ${shadow.shell}`);
    return { ...shape, centre: [shadow.gridX + pad + shape.centre[0], shadow.gridY + pad + shape.centre[1]] };
  });
  const field = shadowAlpha(width, height, shapes, 'merged');
  const ink = shapes[0]?.colour ?? [11, 20, 24];
  const shadowCanvas = createCanvas(width, height);
  const shadowContext = shadowCanvas.getContext('2d');
  const imageData = shadowContext.createImageData(width, height);
  for (let i = 0; i < field.length; i += 1) {
    imageData.data[i * 4] = ink[0];
    imageData.data[i * 4 + 1] = ink[1];
    imageData.data[i * 4 + 2] = ink[2];
    imageData.data[i * 4 + 3] = Math.round(field[i] * 255);
  }
  shadowContext.putImageData(imageData, 0, 0);
  context.drawImage(shadowCanvas as never, 0, 0);

  const targetIndex = zone.bodies.findIndex(
    (body) => body.drawX === targetDraw[0] && body.drawY === targetDraw[1],
  );
  if (targetIndex < 0) throw new Error(`no target body at ${targetDraw.join(',')}`);
  let overlayImage: AtlasImage | null = null;
  if (overlayFile) overlayImage = await imageFor(overlayFile);
  for (let index = 0; index < zone.bodies.length; index += 1) {
    const body = zone.bodies[index];
    await drawTile(context, body.shell, body.face, body.drawX + pad, body.drawY + pad);
    if (index !== targetIndex || !overlayImage) continue;
    const shell = manifest.shells[body.shell];
    const left = body.drawX + shell.padding.left;
    const top = body.drawY + shell.padding.top;
    context.save();
    context.beginPath();
    context.rect(left + pad, top + pad, shell.advanceWidth, shell.advanceHeight);
    context.clip();
    context.drawImage(overlayImage as never, body.drawX + pad, body.drawY + pad);
    context.restore();
  }
  return canvas;
}

const MARGIN = 22;
const LABEL_H = 30;
const GAP = 14;
const SCALE = 3;
const variants = [
  { key: 'none', label: 'no overlay' },
  { key: 'physical', label: 'physical' },
  { key: 'combined', label: 'physical + contact AO' },
] as const;
const cells = [];
for (const def of sampleDefs) {
  const zone = zones.get(def.zone);
  if (!zone) throw new Error(`unknown sample zone ${def.zone}`);
  const entry = reportById.get(def.id);
  const targetDraw = def.target.draw as [number, number];
  const cropW = def.kind === 'pond' ? 230 : 250;
  const cropH = def.kind === 'pond' ? 175 : 130;
  const cropX = Math.max(0, targetDraw[0] - 80);
  const cropY = Math.max(0, targetDraw[1] - 20);
  const variantsComposed = [];
  for (const variant of variants) {
    const file = variant.key === 'none'
      ? null
      : join(renderDir, entry.overlays[`${variant.key}_1x`]);
    const image = await compose(zone, targetDraw, file);
    const pad = zone.blurPad;
    variantsComposed.push({ variant, image, pad, cropX: pad + cropX, cropY: pad + cropY, cropW, cropH });
  }
  cells.push({ def, entry, variants: variantsComposed });
}

const cellW = 250 * SCALE;
const cellH = 175 * SCALE;
const sheetW = MARGIN * 2 + 3 * cellW + 2 * GAP;
const sheetH = MARGIN * 2 + 54 + cells.reduce((sum) => sum + LABEL_H + cellH + 38, 0);
const sheet = createCanvas(sheetW, sheetH);
const context = sheet.getContext('2d');
context.fillStyle = FELT;
context.fillRect(0, 0, sheetW, sheetH);
context.fillStyle = INK;
context.font = 'bold 18px sans-serif';
context.fillText('Lying-family catch samples — pond target 6p and front-wall lower slot 08', MARGIN, MARGIN + 6);
context.font = '12px sans-serif';
context.fillStyle = MUTED;
context.fillText('Target-space physical, contact AO, and combined catches at 3× on the target + casters. Build-only.', MARGIN, MARGIN + 26);
context.imageSmoothingEnabled = false;
let y = MARGIN + 54;
for (const cell of cells) {
  context.fillStyle = INK;
  context.font = 'bold 13px sans-serif';
  context.fillText(`${cell.def.id} · ${cell.def.description}`, MARGIN, y + 12);
  context.font = '11px sans-serif';
  context.fillStyle = MUTED;
  context.fillText(
    `peak ${cell.entry.stats['1x'].peak} · mean ${cell.entry.stats['1x'].mean} · ` +
      `${cell.entry.stats['1x'].supportPx} px · target reference Δ ${cell.entry.reference.meanDelta}`,
    MARGIN,
    y + 27,
  );
  for (let column = 0; column < cell.variants.length; column += 1) {
    const item = cell.variants[column];
    const x = MARGIN + column * (cellW + GAP);
    const iy = y + LABEL_H;
    context.save();
    context.beginPath();
    context.rect(x, iy, cellW, cellH);
    context.clip();
    context.drawImage(
      item.image as never,
      item.cropX,
      item.cropY,
      item.cropW,
      item.cropH,
      x,
      iy,
      item.cropW * SCALE,
      item.cropH * SCALE,
    );
    context.restore();
    context.strokeStyle = '#2d6a4a';
    context.strokeRect(x + 0.5, iy + 0.5, item.cropW * SCALE, item.cropH * SCALE);
    context.fillStyle = INK;
    context.font = 'bold 11px sans-serif';
    context.fillText(item.variant.label, x + 2, iy + cellH + 16);
  }
  y += LABEL_H + cellH + 38;
}
mkdirSync(sampleDir, { recursive: true });
writeFileSync(join(sampleDir, 'lying-samples-sheet.png'), sheet.toBuffer('image/png'));
console.log(join(sampleDir, 'lying-samples-sheet.png'));
