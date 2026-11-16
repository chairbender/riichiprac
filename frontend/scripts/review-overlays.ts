/**
 * Phase 3.5 review sheets: the four ponds, every zone family, and the decals.
 *
 *   cd frontend && npm run overlays:review
 *
 * Writes, under `tools/render/build/review/` (gitignored):
 *
 *   pond-layouts-1x.png     four seats, group shadow + bodies + contact decals,
 *                           1:1 plus a 2x crop with and without the decals;
 *   overlay-zones-1x.png    hand / draw / top / side hands / melds / walls;
 *   overlay-decals-1x.png   every 3D catch with its target/caster pair;
 *   overlay-sheet-numbers.json  the per-panel counts and darkening numbers.
 *
 * AGENTS.md §6: this file is evidence for the user. The script prints the
 * facts; it does not judge the look, and the agent does not sign it off.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { parseCatchesManifest } from '../src/table/catchManifest';
import type { CatchesManifest } from '../src/table/catchManifest';
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
import {
  layoutHand,
  layoutMeld,
  layoutPond,
  layoutSideHand,
  layoutSideWall,
  layoutTopHand,
  layoutWall,
} from '../src/table/zoneLayout';
import type { LayoutZone, PondDiscard } from '../src/table/zoneLayout';
import { deriveShadowShape, shadowAlpha } from '../../tools/render/scripts/shadow-group.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const tableDir = resolve(scriptDir, '../public/table');
const renderDir = resolve(scriptDir, '../../tools/render');
const outDir = join(renderDir, 'build/review');

const manifest: ShellsManifest = parseShellsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')),
);
const overlays: OverlayManifest = parseOverlayManifest(
  JSON.parse(readFileSync(join(tableDir, 'overlays.json'), 'utf8')),
);
const catches: CatchesManifest = parseCatchesManifest(
  JSON.parse(readFileSync(join(tableDir, 'catches.json'), 'utf8')),
);
const spec = JSON.parse(readFileSync(join(renderDir, 'shell-spec.json'), 'utf8'));
const feltSpec = JSON.parse(readFileSync(join(renderDir, 'felt-spec.json'), 'utf8'));
const FELT = `rgb(${feltSpec.baseColor[0]}, ${feltSpec.baseColor[1]}, ${feltSpec.baseColor[2]})`;
const INK = '#f3ead7';
const MUTED = '#b9c9b6';

let overlayNumbers = null;
try {
  overlayNumbers = JSON.parse(readFileSync(join(outDir, 'overlay-numbers.json'), 'utf8'));
} catch {
  overlayNumbers = null;
}
const numbersById = new Map(
  (overlayNumbers?.zones ?? []).map((entry: { id: string }) => [entry.id, entry]),
);

const WARM_SHELLS: FaceUpShellId[] = [
  ...Array.from({ length: 13 }, (_, index) => `shell_hand_slot_${String(index).padStart(2, '0')}` as FaceUpShellId),
  'shell_hand_slot_draw',
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
const imageFor = async (file: string): Promise<AtlasImage> => {
  if (!imageCache.has(file)) {
    imageCache.set(file, (await loadImage(readFileSync(join(tableDir, file)))) as unknown as AtlasImage);
  }
  return imageCache.get(file)!;
};

const decalImageCache = new Map<string, AtlasImage>();
const decalImageFor = async (file: string): Promise<AtlasImage> => {
  if (!decalImageCache.has(file)) {
    decalImageCache.set(file, (await loadImage(readFileSync(join(tableDir, file)))) as unknown as AtlasImage);
  }
  return decalImageCache.get(file)!;
};

type Context = ReturnType<ReturnType<typeof createCanvas>['getContext']>;

const POND_FACES: TileFaceId[] = [
  '1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m',
  '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p',
  '1s', '2s', '3s', '4s', '5s', '6s',
];
const POND_DISCARDS: PondDiscard[] = POND_FACES.map((face, index) => ({
  face,
  riichi: index === 16,
}));
const POND_SEATS = ['bottom', 'right', 'top', 'left'] as const;
const POND_LABEL = {
  bottom: 'bottom · human',
  right: 'right · shimocha',
  top: 'top · toimen',
  left: 'left · kamicha',
} as const;

const pondZones = POND_SEATS.map((side) =>
  layoutPond(manifest, { discards: POND_DISCARDS, side }),
);
const FACES: TileFaceId[] = POND_FACES.slice(0, 13);
const zones: Array<{ zone: LayoutZone; label: string; note: string }> = [
  { zone: layoutHand(manifest, { faces: FACES }), label: 'Human hand · 13', note: 'inner covers outer, per-slot decals' },
  { zone: layoutHand(manifest, { faces: FACES, draw: '5p', id: 'hand-bottom-draw' }), label: 'Human hand · 13 + draw', note: 'the drawn tile does not touch the row' },
  { zone: layoutTopHand(manifest, { faces: FACES }), label: 'Top hand · 13', note: 'blue backs darken the same way' },
  { zone: layoutSideHand(manifest, { side: 'left' }), label: 'Left side hand', note: 'L-shaped sliver: up + right bands' },
  { zone: layoutSideHand(manifest, { side: 'right' }), label: 'Right side hand', note: 'L-shaped sliver: up + left bands' },
  { zone: layoutMeld(manifest, { faces: FACES.slice(0, 3), side: 'bottom', calledIndex: 1 }), label: 'Meld · called tile sideways', note: 'same flat family as the pond' },
  { zone: layoutMeld(manifest, { faces: FACES.slice(0, 4), side: 'right', calledIndex: 2 }), label: 'Right-seat meld · 4 tiles', note: 'vertical row, called tile sideways' },
  { zone: layoutPond(manifest, { discards: POND_DISCARDS.slice(0, 6) }), label: 'Pond · one row', note: 'the shallow column seam is included' },
  { zone: layoutWall(manifest, { wall: 'front', doraIndex: 12 }), label: 'Front wall · 17 stacks', note: 'upper tier down onto the lower' },
  { zone: layoutWall(manifest, { wall: 'back', doraIndex: 12 }), label: 'Back wall · 17 stacks', note: 'far-side camera' },
  { zone: layoutSideWall(manifest, { side: 'left', doraIndex: 5 }), label: 'Left side wall', note: 'stack column + upper tier' },
  { zone: layoutSideWall(manifest, { side: 'right', doraIndex: 5 }), label: 'Right side wall', note: 'stack column + upper tier' },
];

const overlaysOf = (zone: LayoutZone): ContactOverlay[] =>
  resolveContactOverlays(manifest, overlays, zone, catches);

async function drawTile(
  context: Context,
  shellId: string,
  face: TileFaceId | null,
  drawX: number,
  drawY: number,
): Promise<void> {
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
  const image = await imageFor(shell.textureFile);
  context.drawImage(image as never, drawX, drawY, shell.texWidth, shell.texHeight);
}

/**
 * The composed zone on its own canvas: group shadow (one merged blur), then
 * bodies in painter order with each decal drawn after its neighbour body, all
 * inside the zone's single group transform.
 */
async function composeZone(
  zone: LayoutZone,
  options: { overlays: boolean; overlayAlphaScale?: number; radialScale?: number },
): Promise<ReturnType<typeof createCanvas>> {
  const withOverlays = options.overlays;
  const overlayAlphaScale = options.overlayAlphaScale ?? 1;
  const radialScale = options.radialScale ?? 1;
  const pad = zone.blurPad;
  const width = zone.width + pad * 2;
  const height = zone.height + pad * 2;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = FELT;
  context.fillRect(0, 0, width, height);

  // Group shadow layer (§10.12): one union, one blur.
  const shapes = zone.shadows.map((shadow) => {
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
  const shadowImage = shadowContext.createImageData(width, height);
  for (let i = 0; i < field.length; i += 1) {
    shadowImage.data[i * 4] = ink[0];
    shadowImage.data[i * 4 + 1] = ink[1];
    shadowImage.data[i * 4 + 2] = ink[2];
    shadowImage.data[i * 4 + 3] = Math.round(field[i] * 255);
  }
  shadowContext.putImageData(shadowImage, 0, 0);

  context.save();
  if (zone.rotationDeg !== 0) {
    const pivotX = pad + zone.pivotX;
    const pivotY = pad + zone.pivotY;
    context.translate(pivotX, pivotY);
    context.rotate((zone.rotationDeg * Math.PI) / 180);
    context.translate(-pivotX, -pivotY);
  }
  context.drawImage(shadowCanvas as never, 0, 0);

  const resolved = withOverlays ? overlaysOf(zone) : [];
  const grouped = Array.from({ length: zone.bodies.length }, () => [] as ContactOverlay[]);
  for (const overlay of resolved) grouped[overlay.bodyIndex].push(overlay);

  for (let index = 0; index < zone.bodies.length; index += 1) {
    const body = zone.bodies[index];
    await drawTile(context, body.shell, body.face, body.drawX + pad, body.drawY + pad);
    for (const overlay of grouped[index]) {
      const image = await decalImageFor(overlay.textureFile);
      context.save();
      context.beginPath();
      overlay.clip.points.forEach(([x, y], pointIndex) => {
        if (pointIndex === 0) context.moveTo(x + pad, y + pad);
        else context.lineTo(x + pad, y + pad);
      });
      context.closePath();
      context.clip();
      if (overlayAlphaScale !== 1) context.globalAlpha = overlayAlphaScale;
      const width = (image as { width: number }).width;
      const height = (image as { height: number }).height;
      let dx = overlay.drawX + pad;
      let dy = overlay.drawY + pad;
      let dw = width;
      let dh = height;
      if (radialScale !== 1) {
        if (overlay.contact === 'right') {
          dw = width * radialScale;
        } else if (overlay.contact === 'left') {
          dx += width * (1 - radialScale);
          dw = width * radialScale;
        } else if (overlay.contact === 'down') {
          dh = height * radialScale;
        } else if (overlay.contact === 'up') {
          dy += height * (1 - radialScale);
          dh = height * radialScale;
        }
      }
      context.drawImage(image as never, dx, dy, dw, dh);
      context.restore();
    }
  }
  context.restore();
  return canvas;
}

const labelFor = (zone: LayoutZone): string => {
  const numbers = numbersById.get(zone.id) as
    | { overlays?: number; meanDeltaLuma?: number; maxStackedAlpha?: number; rotationDeg?: number }
    | undefined;
  return (
    `${zone.width}×${zone.height} · ${zone.bodies.length} bodies` +
    (numbers ? ` · ${numbers.overlays} decals · mean Δluma ${numbers.meanDeltaLuma}` : '') +
    (zone.rotationDeg === 0 ? '' : ` · lean ${zone.rotationDeg}°`)
  );
};

// --------------------------------------------------------------------------- //
// Zone sheet
// --------------------------------------------------------------------------- //

const ZONE_MARGIN = 24;
const ZONE_LABEL_H = 44;
const zonePanels = [];
for (const entry of zones) {
  const canvas = await composeZone(entry.zone, { overlays: true });
  const pad = entry.zone.blurPad;
  zonePanels.push({
    ...entry,
    canvas,
    width: entry.zone.width,
    height: entry.zone.height,
    originX: pad,
    originY: pad,
  });
}
const zoneSheetWidth = ZONE_MARGIN * 2 + Math.max(...zonePanels.map((panel) => panel.width));
const zoneSheetHeight =
  ZONE_MARGIN * 2 +
  52 +
  zonePanels.reduce((sum, panel) => sum + ZONE_LABEL_H + panel.height + ZONE_MARGIN, 0);
const zoneSheet = createCanvas(zoneSheetWidth, zoneSheetHeight);
const zoneContext = zoneSheet.getContext('2d');
zoneContext.fillStyle = FELT;
zoneContext.fillRect(0, 0, zoneSheetWidth, zoneSheetHeight);
zoneContext.fillStyle = INK;
zoneContext.font = 'bold 18px sans-serif';
zoneContext.fillText(
  'Contact shadows by zone family — 3D catches on the human hand only',
  ZONE_MARGIN,
  ZONE_MARGIN + 6,
);
zoneContext.font = '12px sans-serif';
zoneContext.fillStyle = MUTED;
zoneContext.fillText(
  'Each decal is drawn after the neighbour it lands on and before the caster body. ' +
    'The group blur is unchanged. The lying face-up ponds/melds, top hand and walls are ' +
    'deliberately unshadowed for now.',
  ZONE_MARGIN,
  ZONE_MARGIN + 26,
);
let zoneY = ZONE_MARGIN + 52;
for (const panel of zonePanels) {
  zoneContext.fillStyle = INK;
  zoneContext.font = 'bold 13px sans-serif';
  zoneContext.fillText(`${panel.label} · ${labelFor(panel.zone)}`, ZONE_MARGIN, zoneY + 12);
  zoneContext.font = '11px sans-serif';
  zoneContext.fillStyle = MUTED;
  zoneContext.fillText(panel.note, ZONE_MARGIN, zoneY + 28);
  zoneContext.drawImage(
    panel.canvas as never,
    panel.originX,
    panel.originY,
    panel.width,
    panel.height,
    ZONE_MARGIN,
    zoneY + ZONE_LABEL_H - 6,
    panel.width,
    panel.height,
  );
  zoneY += ZONE_LABEL_H + panel.height + ZONE_MARGIN;
}

// --------------------------------------------------------------------------- //
// Four-pond sheet: full pond + 2x crop with and without the decals
// --------------------------------------------------------------------------- //

const pondComposed = [];
for (const zone of pondZones) {
  const withOverlays = await composeZone(zone, { overlays: true });
  const withoutOverlays = await composeZone(zone, { overlays: false });
  pondComposed.push({ zone, withOverlays, withoutOverlays });
}

const POND_GAP = 26;
const POND_LABEL_H = 48;
const POND_CROP_W = 230;
const POND_CROP_H = 160;
const POND_CROP_SCALE = 2;
const pondCellW = Math.max(...pondZones.map((zone) => zone.width)) + POND_GAP;
const pondCellH =
  Math.max(...pondZones.map((zone) => zone.height)) + POND_LABEL_H + POND_CROP_H * POND_CROP_SCALE + POND_GAP * 2;
const pondSheetWidth = ZONE_MARGIN * 2 + pondCellW * 2;
const pondSheetHeight = ZONE_MARGIN * 2 + 56 + pondCellH * 2;
const pondSheet = createCanvas(pondSheetWidth, pondSheetHeight);
const pondContext = pondSheet.getContext('2d');
pondContext.fillStyle = FELT;
pondContext.fillRect(0, 0, pondSheetWidth, pondSheetHeight);
pondContext.fillStyle = INK;
pondContext.font = 'bold 18px sans-serif';
pondContext.fillText(
  'Four ponds — contact shadows disabled for face-up lying tiles (baseline)',
  ZONE_MARGIN,
  ZONE_MARGIN + 6,
);
pondContext.font = '12px sans-serif';
pondContext.fillStyle = MUTED;
pondContext.fillText(
  'Phase 3.5 follow-up: the face-up lying family is intentionally unshadowed because the bands read ' +
    'as smudges. Each panel shows the composed pond and the same 2× crop; the side ponds keep their ' +
    '1° whole-zone lean. The human hand sheet is the active review.',
  ZONE_MARGIN,
  ZONE_MARGIN + 26,
);

for (let index = 0; index < pondComposed.length; index += 1) {
  const side = POND_SEATS[index];
  const { zone, withOverlays, withoutOverlays } = pondComposed[index];
  const column = index % 2;
  const row = Math.floor(index / 2);
  const originX = ZONE_MARGIN + column * pondCellW;
  const originY = ZONE_MARGIN + 56 + row * pondCellH;
  const pad = zone.blurPad;
  const numbers = numbersById.get(zone.id) as
    | { overlays?: number; changedBodyPx?: number; meanDeltaLuma?: number; maxStackedAlpha?: number }
    | undefined;

  pondContext.fillStyle = INK;
  pondContext.font = 'bold 13px sans-serif';
  pondContext.fillText(
    `${POND_LABEL[side]} · ${zone.width}×${zone.height} · ${zone.bodies.length} bodies` +
      numbers && numbers.overlays > 0 ? ` · ${numbers.overlays} decals` : ' · contact shadows disabled',
    originX,
    originY + 14,
  );
  pondContext.font = '11px sans-serif';
  pondContext.fillStyle = MUTED;
  pondContext.fillText(
    (numbers
      ? `${numbers.changedBodyPx} body px darkened · mean Δluma ${numbers.meanDeltaLuma} · ` +
        `max stacked α ${numbers.maxStackedAlpha} · `
      : '') + (zone.rotationDeg === 0 ? 'no lean' : `lean ${zone.rotationDeg}°`),
    originX,
    originY + 30,
  );

  // Full pond.
  pondContext.drawImage(
    withOverlays as never,
    pad,
    pad,
    zone.width,
    zone.height,
    originX,
    originY + POND_LABEL_H - 8,
    zone.width,
    zone.height,
  );

  // A contact crop: the first row seam on the left of the pond.
  const cropX = Math.max(0, pad + Math.min(140, Math.floor(zone.width / 3)));
  const cropY = Math.max(0, pad + Math.min(20, Math.floor(zone.height / 5)));
  const cropW = Math.min(POND_CROP_W, zone.width - Math.min(140, Math.floor(zone.width / 3)));
  const cropH = Math.min(POND_CROP_H, zone.height - Math.min(20, Math.floor(zone.height / 5)));
  const cropYStart = originY + POND_LABEL_H + zone.height + 8;
  pondContext.font = 'bold 11px sans-serif';
  pondContext.fillStyle = INK;
  pondContext.fillText('2× crop · with decals', originX, cropYStart + 10);
  pondContext.fillText('2× crop · without decals', originX + POND_CROP_W * POND_CROP_SCALE + 12, cropYStart + 10);
  pondContext.imageSmoothingEnabled = false;
  pondContext.drawImage(
    withOverlays as never,
    cropX,
    cropY,
    cropW,
    cropH,
    originX,
    cropYStart + 14,
    cropW * POND_CROP_SCALE,
    cropH * POND_CROP_SCALE,
  );
  pondContext.drawImage(
    withoutOverlays as never,
    cropX,
    cropY,
    cropW,
    cropH,
    originX + POND_CROP_W * POND_CROP_SCALE + 12,
    cropYStart + 14,
    cropW * POND_CROP_SCALE,
    cropH * POND_CROP_SCALE,
  );
  pondContext.imageSmoothingEnabled = true;
}

// --------------------------------------------------------------------------- //
// Decal gallery
// --------------------------------------------------------------------------- //

const catchEntries = Object.entries(catches.catches).sort(([a], [b]) => a.localeCompare(b));
const GALLERY_CELL_W = 150;
const GALLERY_CELL_H = 150;
const GALLERY_COLUMNS = 8;
const galleryRows = Math.ceil(catchEntries.length / GALLERY_COLUMNS);
const galleryWidth = ZONE_MARGIN * 2 + GALLERY_COLUMNS * GALLERY_CELL_W;
const galleryHeight = ZONE_MARGIN * 2 + 54 + galleryRows * GALLERY_CELL_H;
const gallery = createCanvas(galleryWidth, galleryHeight);
const galleryContext = gallery.getContext('2d');
galleryContext.fillStyle = FELT;
galleryContext.fillRect(0, 0, galleryWidth, galleryHeight);
galleryContext.fillStyle = INK;
galleryContext.font = 'bold 18px sans-serif';
galleryContext.fillText(
  `3D contact catches — ${catchEntries.length} target-space overlays`,
  ZONE_MARGIN,
  ZONE_MARGIN + 6,
);
galleryContext.font = '12px sans-serif';
galleryContext.fillStyle = MUTED;
galleryContext.fillText(
  'Each swatch is the target-space catch at 2×, its target ← caster and peak/mean alpha. ' +
    'The compositor draws it after the target body and clips it to the target body polygon.',
  ZONE_MARGIN,
  ZONE_MARGIN + 26,
);
galleryContext.imageSmoothingEnabled = false;
for (let index = 0; index < catchEntries.length; index += 1) {
  const [, catchRecord] = catchEntries[index];
  const column = index % GALLERY_COLUMNS;
  const row = Math.floor(index / GALLERY_COLUMNS);
  const x = ZONE_MARGIN + column * GALLERY_CELL_W;
  const y = ZONE_MARGIN + 54 + row * GALLERY_CELL_H;
  galleryContext.strokeStyle = '#2d6a4a';
  galleryContext.strokeRect(x + 0.5, y + 0.5, GALLERY_CELL_W - 8, GALLERY_CELL_H - 8);
  const image = await decalImageFor(catchRecord.textureFile);
  const scale = Math.min(
    2,
    (GALLERY_CELL_W - 24) / catchRecord.texWidth,
    (GALLERY_CELL_H - 52) / catchRecord.texHeight,
  );
  galleryContext.drawImage(
    image as never,
    x + 8,
    y + 8,
    catchRecord.texWidth * scale,
    catchRecord.texHeight * scale,
  );
  galleryContext.fillStyle = INK;
  galleryContext.font = 'bold 10px sans-serif';
  galleryContext.fillText(
    `${catchRecord.target.replace('shell_hand_slot_', '')} ← ${catchRecord.caster.replace('shell_hand_slot_', '')}`,
    x + 8,
    y + GALLERY_CELL_H - 26,
  );
  galleryContext.font = '10px sans-serif';
  galleryContext.fillStyle = MUTED;
  galleryContext.fillText(
    `${catchRecord.texWidth}×${catchRecord.texHeight} · peak ${catchRecord.peakAlpha} · mean ${catchRecord.meanAlpha}`,
    x + 8,
    y + GALLERY_CELL_H - 13,
  );
}

// --------------------------------------------------------------------------- //
// The human hand fan: 1:1 plus left / centre / right seam crops
// --------------------------------------------------------------------------- //

const handZone = layoutHand(manifest, {
  faces: POND_FACES.slice(0, 13),
  draw: '5p',
  id: 'hand-bottom-draw',
});
const handPad = handZone.blurPad;
const handWith = await composeZone(handZone, { overlays: true });
const handWithout = await composeZone(handZone, { overlays: false });
const HAND_CROP_W = 130;
const HAND_CROP_H = Math.min(150, handZone.height);
const HAND_CROP_SCALE = 3;
const handCropSeams = [
  { fraction: 0.16, label: 'left half · inner over outer' },
  { fraction: 0.52, label: 'centre · slot 06 over 05 and 07' },
  { fraction: 0.8, label: 'right half · thinner/darker cast' },
];
const handSheetWidth =
  ZONE_MARGIN * 2 + Math.max(handZone.width, 2 * HAND_CROP_W * HAND_CROP_SCALE + 24) + 8;
const handSheetHeight =
  ZONE_MARGIN * 2 + 54 + handZone.height + 20 + handCropSeams.length * (HAND_CROP_H * HAND_CROP_SCALE + 42);
const handSheet = createCanvas(handSheetWidth, handSheetHeight);
const handContext = handSheet.getContext('2d');
handContext.fillStyle = FELT;
handContext.fillRect(0, 0, handSheetWidth, handSheetHeight);
handContext.fillStyle = INK;
handContext.font = 'bold 18px sans-serif';
handContext.fillText(
  'Human hand fan — 3D target-space catches; left / centre / right seams at 3×',
  ZONE_MARGIN,
  ZONE_MARGIN + 6,
);
handContext.font = '12px sans-serif';
handContext.fillStyle = MUTED;
handContext.fillText(
  'Top: the composed hand at 1:1. Each row: the same seam with the 3D catches (left) and without ' +
    '(right). Each target tile has its own caught shadow; no stamp is reused.',
  ZONE_MARGIN,
  ZONE_MARGIN + 26,
);
handContext.drawImage(
  handWith as never,
  handPad,
  handPad,
  handZone.width,
  handZone.height,
  ZONE_MARGIN,
  ZONE_MARGIN + 48,
  handZone.width,
  handZone.height,
);
handContext.imageSmoothingEnabled = false;
let handRowY = ZONE_MARGIN + 48 + handZone.height + 24;
handContext.font = 'bold 11px sans-serif';
for (const seam of handCropSeams) {
  const sourceCenterX = handPad + Math.round(handZone.width * seam.fraction);
  const cropX = Math.max(0, Math.min(handWith.width - HAND_CROP_W, sourceCenterX - Math.round(HAND_CROP_W / 2)));
  const cropY = handPad;
  handContext.fillStyle = INK;
  handContext.fillText(`${seam.label} · with decals`, ZONE_MARGIN, handRowY + 10);
  handContext.fillText(
    'without decals',
    ZONE_MARGIN + HAND_CROP_W * HAND_CROP_SCALE + 20,
    handRowY + 10,
  );
  handContext.drawImage(
    handWith as never,
    cropX,
    cropY,
    HAND_CROP_W,
    HAND_CROP_H,
    ZONE_MARGIN,
    handRowY + 16,
    HAND_CROP_W * HAND_CROP_SCALE,
    HAND_CROP_H * HAND_CROP_SCALE,
  );
  handContext.drawImage(
    handWithout as never,
    cropX,
    cropY,
    HAND_CROP_W,
    HAND_CROP_H,
    ZONE_MARGIN + HAND_CROP_W * HAND_CROP_SCALE + 20,
    handRowY + 16,
    HAND_CROP_W * HAND_CROP_SCALE,
    HAND_CROP_H * HAND_CROP_SCALE,
  );
  handRowY += HAND_CROP_H * HAND_CROP_SCALE + 42;
}
handContext.imageSmoothingEnabled = true;

// --------------------------------------------------------------------------- //

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'pond-layouts-1x.png'), pondSheet.toBuffer('image/png'));
writeFileSync(join(outDir, 'hand-layouts-1x.png'), handSheet.toBuffer('image/png'));
writeFileSync(join(outDir, 'overlay-zones-1x.png'), zoneSheet.toBuffer('image/png'));
writeFileSync(join(outDir, 'overlay-decals-1x.png'), gallery.toBuffer('image/png'));
writeFileSync(
  join(outDir, 'overlay-sheet-numbers.json'),
  `${JSON.stringify(
    {
      generatedBy: 'frontend/scripts/review-overlays.ts',
      coordinateSpace: '@1x CSS px on a flat felt swatch; each zone normalised to (0, 0) plus blurPad',
      ponds: pondComposed.map(({ zone }) => ({
        id: zone.id,
        side: zone.side,
        width: zone.width,
        height: zone.height,
        contacts: overlaysOf(zone).length,
        rotationDeg: zone.rotationDeg,
        numbers: numbersById.get(zone.id) ?? null,
      })),
      zones: zones.map(({ zone }) => ({
        id: zone.id,
        width: zone.width,
        height: zone.height,
        bodies: zone.bodies.length,
        contacts: overlaysOf(zone).length,
        rotationDeg: zone.rotationDeg,
        numbers: numbersById.get(zone.id) ?? null,
      })),
      catches: catchEntries.length,
      policy: overlays.enabled,
      sideOverrides: overlays.model.sideOverrides,
      hand: {
        id: handZone.id,
        contacts: overlaysOf(handZone).length,
        numbers: numbersById.get(handZone.id) ?? null,
      },
    },
    null,
    2,
  )}\n`,
);

console.log(`hand sheet:      ${join(outDir, 'hand-layouts-1x.png')}`);
console.log(`pond sheet:      ${join(outDir, 'pond-layouts-1x.png')}`);
console.log(`zone sheet:      ${join(outDir, 'overlay-zones-1x.png')}`);
console.log(`decal gallery:   ${join(outDir, 'overlay-decals-1x.png')}`);
console.log(`numbers:         ${join(outDir, 'overlay-sheet-numbers.json')}`);
console.log(
  `four ponds: ${pondZones
    .map((zone) => `${zone.side} ${overlaysOf(zone).length} decals`)
    .join(', ')}`,
);
