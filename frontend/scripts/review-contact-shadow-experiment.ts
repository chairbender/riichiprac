/**
 * Review sheet for the 3D contact-shadow experiment (build-only).
 *
 *   cd frontend && npm run experiment:review
 *
 * Reads the pair renders written by `tools/render/contact_shadow_experiment.py`
 * (slot 11 from 10 and slot 2 from 3), composes the real human-hand atlas art,
 * and writes under `tools/render/build/contact-shadow-experiment/`:
 *
 *   contact-shadow-experiment-sheet.png   2 pairs x 4 variants at 3x
 *   contact-shadow-experiment-numbers.json
 *
 * Variants: no overlay, the committed synthetic decal, the physical catch, and
 * physical + contact AO. The sheet is evidence for the user (AGENTS.md §6); the
 * agent does not sign off the look.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { parseOverlayManifest } from '../src/table/overlayManifest';
import type { OverlayManifest } from '../src/table/overlayManifest';
import { parseShellsManifest } from '../src/table/shellManifest';
import type { ShellsManifest } from '../src/table/shellManifest';
import { resolveContactOverlays } from '../src/table/contactOverlays';
import type { ContactOverlay } from '../src/table/contactOverlays';
import { TileAtlas } from '../src/table/TileAtlas';
import type { AtlasCanvas, AtlasImage } from '../src/table/TileAtlasBuilder';
import { isFaceUpShellId, tileRenderKey } from '../src/table/tiles';
import type { FaceUpShellId, TileFaceId } from '../src/table/tiles';
import { layoutHand } from '../src/table/zoneLayout';
import { deriveShadowShape, shadowAlpha } from '../../tools/render/scripts/shadow-group.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const tableDir = resolve(scriptDir, '../public/table');
const renderDir = resolve(scriptDir, '../../tools/render');
const experimentDir = join(renderDir, 'build/contact-shadow-experiment');

const manifest: ShellsManifest = parseShellsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')),
);
const overlays: OverlayManifest = parseOverlayManifest(
  JSON.parse(readFileSync(join(tableDir, 'overlays.json'), 'utf8')),
);
const spec = JSON.parse(readFileSync(join(renderDir, 'shell-spec.json'), 'utf8'));
const feltSpec = JSON.parse(readFileSync(join(renderDir, 'felt-spec.json'), 'utf8'));
const FELT = `rgb(${feltSpec.baseColor[0]}, ${feltSpec.baseColor[1]}, ${feltSpec.baseColor[2]})`;
const INK = '#f3ead7';
const MUTED = '#b9c9b6';

const WARM_SHELLS: FaceUpShellId[] = [
  ...Array.from({ length: 13 }, (_, index) => `shell_hand_slot_${String(index).padStart(2, '0')}` as FaceUpShellId),
  'shell_hand_slot_draw',
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

const FACES: TileFaceId[] = [
  '1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m',
  '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p',
  '1s', '2s', '3s', '4s', '5s', '6s',
];
const hand = layoutHand(manifest, { faces: FACES.slice(0, 13) });
const pad = hand.blurPad;

const imageCache = new Map<string, AtlasImage>();
const imageFor = async (path: string): Promise<AtlasImage> => {
  if (!imageCache.has(path)) {
    imageCache.set(path, (await loadImage(readFileSync(path))) as unknown as AtlasImage);
  }
  return imageCache.get(path)!;
};

type Context = ReturnType<ReturnType<typeof createCanvas>['getContext']>;

async function drawTile(context: Context, shellId: string, face: TileFaceId | null, drawX: number, drawY: number): Promise<void> {
  const shell = manifest.shells[shellId];
  if (face && isFaceUpShellId(shellId)) {
    const sprite = atlas.getSprite(tileRenderKey(shellId, face));
    const page = atlas.getPage(sprite);
    context.drawImage(
      page.canvas as never,
      sprite.uv.x,
      sprite.uv.y,
      sprite.uv.width,
      sprite.uv.height,
      drawX,
      drawY,
      sprite.texWidth,
      sprite.texHeight,
    );
    return;
  }
  const image = await imageFor(join(tableDir, shell.textureFile));
  context.drawImage(image as never, drawX, drawY, shell.texWidth, shell.texHeight);
}

const pairs = Object.values(
  JSON.parse(readFileSync(join(experimentDir, 'contact-shadow-experiment.json'), 'utf8')).pairs as Record<string, string>,
).map((file) => JSON.parse(readFileSync(join(renderDir, file), 'utf8')) as ExperimentPair);

interface ExperimentPair {
  pair: string;
  target: string;
  caster: string;
  crop1x: { x: number; y: number; width: number; height: number };
  overlays: Record<string, string>;
  stats: Record<string, Record<string, { peak: number; mean: number; supportPx: number; maxRowStep: number }>>;
  check: { referenceMatchesCommitted?: { meanDelta?: number; maxDelta?: number; alphaMeanDelta?: number } };
  renderSeconds: number;
}

const bodyIndex = (shell: string): number => {
  const index = hand.bodies.findIndex((body) => body.shell === shell);
  if (index < 0) throw new Error(`hand has no ${shell}`);
  return index;
};

const targetBox = (shell: string): { x: number; y: number; width: number; height: number } => {
  const body = hand.bodies[bodyIndex(shell)];
  const stats = manifest.shells[shell];
  return {
    x: body.drawX + stats.padding.left,
    y: body.drawY + stats.padding.top,
    width: stats.advanceWidth,
    height: stats.advanceHeight,
  };
};

const clipPoints = (shell: string): Array<readonly [number, number]> => {
  const box = targetBox(shell);
  const quad = overlays.bodyQuads[shell];
  return quad.map(([x, y]) => [box.x + x, box.y + y] as const);
};

const syntheticOverlayFor = (targetShell: string): ContactOverlay | null => {
  const index = bodyIndex(targetShell);
  return resolveContactOverlays(manifest, overlays, hand).find((overlay) => overlay.bodyIndex === index) ?? null;
};

/** Compose the hand with the group shadow and one optional contact overlay. */
async function compose(
  variant: 'none' | 'synthetic' | 'physical' | 'combined',
  pair: ExperimentPair,
): Promise<ReturnType<typeof createCanvas>> {
  const width = hand.width + pad * 2;
  const height = hand.height + pad * 2;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = FELT;
  context.fillRect(0, 0, width, height);

  // One group shadow union, as in the real compositor.
  const shapes = hand.shadows.map((shadow) => {
    const shape = deriveShadowShape(manifest.shells[shadow.shell], spec);
    if (!shape) throw new Error(`no shadow shape for ${shadow.shell}`);
    return {
      ...shape,
      centre: [shadow.gridX + pad + shape.centre[0], shadow.gridY + pad + shape.centre[1]],
    };
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

  const targetIndex = bodyIndex(pair.target);
  const synthetic = syntheticOverlayFor(pair.target);
  let overlayImage: AtlasImage | null = null;
  let overlayX = 0;
  let overlayY = 0;
  if (variant === 'physical' || variant === 'combined') {
    const file = variant === 'physical' ? pair.overlays.physical_1x : pair.overlays.combined_1x;
    overlayImage = await imageFor(join(renderDir, file));
    const target = hand.bodies[targetIndex];
    overlayX = target.drawX + pad;
    overlayY = target.drawY + pad;
  }

  for (let index = 0; index < hand.bodies.length; index += 1) {
    const body = hand.bodies[index];
    await drawTile(context, body.shell, body.face, body.drawX + pad, body.drawY + pad);
    if (index !== targetIndex) continue;
    if (variant === 'synthetic' && synthetic) {
      const image = await imageFor(join(tableDir, synthetic.textureFile));
      context.save();
      context.beginPath();
      synthetic.clip.points.forEach(([x, y], pointIndex) => {
        if (pointIndex === 0) context.moveTo(x + pad, y + pad);
        else context.lineTo(x + pad, y + pad);
      });
      context.closePath();
      context.clip();
      context.drawImage(image as never, synthetic.drawX + pad, synthetic.drawY + pad);
      context.restore();
    }
    if (variant === 'physical' || variant === 'combined') {
      if (!overlayImage) continue;
      const points = clipPoints(pair.target);
      context.save();
      context.beginPath();
      points.forEach(([x, y], pointIndex) => {
        if (pointIndex === 0) context.moveTo(x + pad, y + pad);
        else context.lineTo(x + pad, y + pad);
      });
      context.closePath();
      context.clip();
      context.drawImage(overlayImage as never, overlayX, overlayY);
      context.restore();
    }
  }
  return canvas;
}

function visibleDelta(
  composed: ReturnType<typeof createCanvas>,
  baseline: ReturnType<typeof createCanvas>,
  crop: { x: number; y: number; width: number; height: number },
): { changedPx: number; meanDeltaLuma: number; maxDeltaLuma: number } {
  const context = composed.getContext('2d');
  const baseContext = baseline.getContext('2d');
  const a = context.getImageData(crop.x, crop.y, crop.width, crop.height).data;
  const b = baseContext.getImageData(crop.x, crop.y, crop.width, crop.height).data;
  let changedPx = 0;
  let sum = 0;
  let max = 0;
  const luma = (r: number, g: number, blue: number): number =>
    0.2126 * r + 0.7152 * g + 0.0722 * blue;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.abs(
      luma(a[i], a[i + 1], a[i + 2]) - luma(b[i], b[i + 1], b[i + 2]),
    );
    if (d < 0.01) continue;
    changedPx += 1;
    sum += d;
    max = Math.max(max, d);
  }
  return {
    changedPx,
    meanDeltaLuma: changedPx > 0 ? Number((sum / changedPx).toFixed(2)) : 0,
    maxDeltaLuma: Number(max.toFixed(2)),
  };
}

function seamCrop(pair: ExperimentPair): { x: number; y: number; width: number; height: number } {
  const target = hand.bodies[bodyIndex(pair.target)];
  const caster = hand.bodies[bodyIndex(pair.caster)];
  const targetShell = manifest.shells[pair.target];
  const casterShell = manifest.shells[pair.caster];
  const targetLeft = target.drawX + targetShell.padding.left;
  const targetRight = targetLeft + targetShell.advanceWidth;
  const casterLeft = caster.drawX + casterShell.padding.left;
  const casterRight = casterLeft + casterShell.advanceWidth;
  const overlapLeft = Math.max(targetLeft, casterLeft);
  const overlapRight = Math.min(targetRight, casterRight);
  const seam = (overlapLeft + overlapRight) / 2;
  const width = 130;
  const height = Math.min(120, hand.height);
  const x = Math.max(pad, Math.min(pad + hand.width - width, pad + seam - width / 2));
  const y = pad + Math.max(0, Math.min(hand.height - height, Math.min(target.drawY, caster.drawY) - 6));
  return { x, y, width, height };
}

const MARGIN = 22;
const CELL_GAP = 14;
const LABEL_H = 30;
const SCALE = 3;
const variants = [
  { key: 'none', label: 'no contact overlay' },
  { key: 'synthetic', label: 'committed synthetic decal' },
  { key: 'physical', label: '3D physical catch' },
  { key: 'combined', label: '3D physical + contact AO' },
] as const;

const crops = new Map<string, { x: number; y: number; width: number; height: number }>();
for (const pair of pairs) crops.set(pair.pair, seamCrop(pair));
const cellW = (crops.values().next().value?.width ?? 130) * SCALE;
const cellH = (crops.values().next().value?.height ?? 120) * SCALE;
const rowH = LABEL_H + cellH + 20;
const sheetW = MARGIN * 2 + 4 * cellW + 3 * CELL_GAP;
const sheetH = MARGIN * 2 + 54 + pairs.length * rowH;
const sheet = createCanvas(sheetW, sheetH);
const sheetContext = sheet.getContext('2d');
sheetContext.fillStyle = FELT;
sheetContext.fillRect(0, 0, sheetW, sheetH);
sheetContext.fillStyle = INK;
sheetContext.font = 'bold 18px sans-serif';
sheetContext.fillText(
  '3D contact-shadow catch experiment — target tile + adjacent caster at the published camera',
  MARGIN,
  MARGIN + 6,
);
sheetContext.font = '12px sans-serif';
sheetContext.fillStyle = MUTED;
sheetContext.fillText(
  'The reference crop is byte-identical to the committed target body; the overlays are target-space. ' +
    'Rows: right pair (11 from 10) and left pair (2 from 3). Columns are the same seam at 3×.',
  MARGIN,
  MARGIN + 26,
);
sheetContext.imageSmoothingEnabled = false;

interface ExperimentSummary {
  pair: string;
  target: string;
  caster: string;
  crop: { x: number; y: number; width: number; height: number };
  syntheticDecal: {
    shell: string;
    contact: string;
    peakAlpha: number;
    texWidth: number;
    texHeight: number;
  } | null;
  physical: { peak: number; mean: number; supportPx: number; maxRowStep: number };
  ao: { peak: number; mean: number; supportPx: number; maxRowStep: number };
  combined: { peak: number; mean: number; supportPx: number; maxRowStep: number };
  visible: Record<string, { changedPx: number; meanDeltaLuma: number; maxDeltaLuma: number }>;
  reference: { meanDelta?: number; maxDelta?: number; alphaMeanDelta?: number } | undefined;
  renderSeconds: number;
}

const numbers: ExperimentSummary[] = [];
for (let row = 0; row < pairs.length; row += 1) {
  const pair = pairs[row];
  const crop = crops.get(pair.pair)!;
  const rowY = MARGIN + 54 + row * rowH;
  const synthetic = syntheticOverlayFor(pair.target);
  const syntheticDecal = synthetic
    ? overlays.decals[`${overlays.aliases[synthetic.shell] ?? synthetic.shell}:${synthetic.contact}`]
    : null;
  sheetContext.fillStyle = INK;
  sheetContext.font = 'bold 13px sans-serif';
  sheetContext.fillText(`${pair.target} ← ${pair.caster}`, MARGIN, rowY + 12);
  sheetContext.font = '11px sans-serif';
  sheetContext.fillStyle = MUTED;
  sheetContext.fillText(
    `synthetic peak ${syntheticDecal?.peakAlpha ?? 0} · ` +
      `physical peak ${pair.stats['1x'].physical.peak} / mean ${pair.stats['1x'].physical.mean} · ` +
      `AO peak ${pair.stats['1x'].ao.peak} / mean ${pair.stats['1x'].ao.mean} · ` +
      `combined peak ${pair.stats['1x'].combined.peak} · ` +
      `target reference Δ ${pair.check.referenceMatchesCommitted?.meanDelta ?? 'n/a'}`,
    MARGIN,
    rowY + 27,
  );
  const composedByVariant = new Map<string, ReturnType<typeof createCanvas>>();
  for (const variant of variants) {
    composedByVariant.set(variant.key, await compose(variant.key, pair));
  }
  const baseline = composedByVariant.get('none')!;
  const visible: Record<string, { changedPx: number; meanDeltaLuma: number; maxDeltaLuma: number }> = {};
  for (const variant of variants) {
    const composed = composedByVariant.get(variant.key)!;
    visible[variant.key] = visibleDelta(composed, baseline, crop);
  }
  for (let column = 0; column < variants.length; column += 1) {
    const variant = variants[column];
    const composed = composedByVariant.get(variant.key)!;
    const x = MARGIN + column * (cellW + CELL_GAP);
    const y = rowY + LABEL_H;
    const context = sheetContext;
    context.save();
    context.beginPath();
    context.rect(x, y, cellW, cellH);
    context.clip();
    context.drawImage(
      composed as never,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      x,
      y,
      cellW,
      cellH,
    );
    context.restore();
    context.strokeStyle = '#2d6a4a';
    context.lineWidth = 1;
    context.strokeRect(x + 0.5, y + 0.5, cellW, cellH);
    context.fillStyle = INK;
    context.font = 'bold 11px sans-serif';
    context.fillText(variant.label, x + 2, y + cellH + 16);
    const delta = visible[variant.key];
    context.font = '10px sans-serif';
    context.fillStyle = MUTED;
    context.fillText(
      `visible Δ mean ${delta.meanDeltaLuma.toFixed(1)} / max ${delta.maxDeltaLuma.toFixed(1)} luma · ${delta.changedPx} px`,
      x + 2,
      y + cellH + 28,
    );
  }
  numbers.push({
    pair: pair.pair,
    target: pair.target,
    caster: pair.caster,
    crop: pair.crop1x,
    syntheticDecal: syntheticDecal
      ? { shell: synthetic!.shell, contact: synthetic!.contact, peakAlpha: syntheticDecal.peakAlpha, texWidth: syntheticDecal.texWidth, texHeight: syntheticDecal.texHeight }
      : null,
    physical: pair.stats['1x'].physical,
    ao: pair.stats['1x'].ao,
    combined: pair.stats['1x'].combined,
    visible,
    reference: pair.check.referenceMatchesCommitted,
    renderSeconds: pair.renderSeconds,
  });
}

mkdirSync(experimentDir, { recursive: true });
writeFileSync(join(experimentDir, 'contact-shadow-experiment-sheet.png'), sheet.toBuffer('image/png'));
writeFileSync(
  join(experimentDir, 'contact-shadow-experiment-numbers.json'),
  `${JSON.stringify({ generatedBy: 'frontend/scripts/review-contact-shadow-experiment.ts', pairs: numbers }, null, 2)}\n`,
);
console.log(`sheet: ${join(experimentDir, 'contact-shadow-experiment-sheet.png')}`);
console.log(`numbers: ${join(experimentDir, 'contact-shadow-experiment-numbers.json')}`);
for (const entry of numbers) {
  console.log(
    `${String(entry.pair).padEnd(48)} synthetic ${entry.syntheticDecal ? entry.syntheticDecal.peakAlpha : 0} ` +
      `physical peak ${entry.physical.peak}/mean ${entry.physical.mean} ` +
      `AO peak ${entry.ao.peak}/mean ${entry.ao.mean} ` +
      `visible Δ synthetic ${entry.visible.synthetic?.meanDeltaLuma} ` +
      `/ physical ${entry.visible.physical?.meanDeltaLuma} / AO ${entry.visible.combined?.meanDeltaLuma} ` +
      `alignment Δ ${entry.reference?.meanDelta}`,
  );
}
